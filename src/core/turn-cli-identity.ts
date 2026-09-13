/**
 * Per-turn publication of the acting CLI identity.
 *
 * This is where the three pieces meet: the bot's {@link TriggerUserAuthConfig}
 * policy, the per-person token store, and the session identity file a wrapper
 * sources. It runs once per turn, just before the turn reaches the CLI.
 *
 * The single rule it enforces: **the credentials published for a turn belong to
 * the person who sent that turn, or nothing is published.** There is no path
 * here that reads another person's token — the sender's open_id is the only key
 * ever used, and when it yields nothing the previous file is DELETED rather than
 * left in place. A stale file would mean the next command silently runs as the
 * previous person, which is the exact failure the feature exists to remove.
 */
import { logger } from '../utils/logger.js';
import { resolveUserToken, lookupAuthorizedUserName } from '../utils/user-token.js';
import { t } from '../i18n/index.js';
import type { Locale } from '../i18n/index.js';
import { normalizeBrand } from '../im/lark/lark-hosts.js';
import { mintBytedcliJwts, beginBytedcliLogin } from '../services/bytedcli-auth.js';
import { larkCliHomeForTurn, beginLarkCliLogin } from '../services/lark-cli-auth.js';
import type { BotConfig } from '../bot-registry.js';
import {
  triggerUserAuthApplies,
  unauthorizedOutcomeFor,
  TRIGGER_USER_AUTH_TOOLS,
  type TriggerUserAuthTool,
} from '../services/trigger-user-auth.js';
import {
  writeSessionIdentity,
  clearSessionIdentity,
  type CliIdentity,
} from './cli-identity.js';

/** What was published for one tool this turn — drives the user-visible notice. */
export interface ToolIdentityOutcome {
  tool: TriggerUserAuthTool;
  /**
   * - `user`: the sender's own credentials are in force.
   * - `bot-identity`: nothing published; the tool runs as the bot where it can.
   * - `needs-authorization`: nothing published AND the tool cannot degrade —
   *   the sender must authorize before it will work.
   * - `off`: the policy does not govern this tool; nothing was touched.
   */
  state: 'user' | 'bot-identity' | 'needs-authorization' | 'off';
}

export interface PublishTurnIdentityArgs {
  botConfig: BotConfig;
  sessionDataDir: string;
  sessionId: string;
  /** The person who sent THIS turn. Absent for turns with no human sender. */
  senderOpenId: string | undefined;
  /** For the stderr text the wrapper prints when a command is refused. */
  locale?: Locale;
  /**
   * The turn these credentials are for. Stamped into the file so the wrapper can
   * refuse to use them during a different turn — the CLI runs its own queue, so
   * a newer message's credentials can land while an older turn is still going.
   */
  turnId?: string;
}

/**
 * Publish (or withhold) each governed tool's identity for the current turn.
 *
 * Never throws: a credential-publication failure must not take down the turn.
 * The worst case is a withheld identity, which the tool reports as an auth error
 * and the agent can act on.
 */
export async function publishTurnCliIdentity(
  args: PublishTurnIdentityArgs,
): Promise<ToolIdentityOutcome[]> {
  const { botConfig, sessionDataDir, sessionId, senderOpenId, locale, turnId } = args;
  const policy = botConfig.triggerUserAuth;
  const outcomes: ToolIdentityOutcome[] = [];

  for (const tool of TRIGGER_USER_AUTH_TOOLS) {
    if (!triggerUserAuthApplies(policy, tool)) {
      outcomes.push({ tool, state: 'off' });
      continue;
    }
    try {
      outcomes.push(await publishOne(tool, botConfig, sessionDataDir, sessionId, senderOpenId, locale, turnId));
    } catch (e) {
      // Fail closed through the SAME policy as an ordinary missing token, so a
      // credential-store outage and "this person never authorized" cannot end
      // up with different identities in force. Overwriting matters as much as
      // the policy: leaving the previous person's file would keep running as
      // them with no signal at all.
      logger.warn(
        `[trigger-user-auth] withheld ${tool} identity for session ${sessionId}: `
        + `${e instanceof Error ? e.message : String(e)}`,
      );
      outcomes.push(await withholdIdentity(tool, botConfig, sessionDataDir, sessionId, senderOpenId, locale, turnId));
    }
  }
  return outcomes;
}

async function publishOne(
  tool: TriggerUserAuthTool,
  botConfig: BotConfig,
  sessionDataDir: string,
  sessionId: string,
  senderOpenId: string | undefined,
  locale: Locale | undefined,
  turnId: string | undefined,
): Promise<ToolIdentityOutcome> {
  const withheld = () =>
    withholdIdentity(tool, botConfig, sessionDataDir, sessionId, senderOpenId, locale, turnId);

  // No human sender (scheduled run, hook, meeting event, bot-to-bot handoff):
  // there is no "trigger user" to act as. Withhold — never reach for the session
  // creator's or the owner's credentials to fill the gap. No link either (nobody
  // to scan it).
  if (!senderOpenId) return withheld();

  const identity = await resolveIdentityFor(tool, botConfig, senderOpenId);
  if (!identity) return withheld();

  writeSessionIdentity(sessionDataDir, sessionId, { ...identity, ...(turnId ? { turnId } : {}) });
  return { tool, state: 'user' };
}

/**
 * What "no usable credentials for this turn's sender" resolves to.
 *
 * The one place that decision is made, so every route into it — no sender, no
 * token, a store outage — lands on the same identity.
 *
 * Neither outcome can be expressed by deleting the file. The wrapper reads an
 * absent file as a refusal, so running as the bot has to be published
 * explicitly (with app id + secret; lark-cli given nothing picks up the
 * operator's on-disk login instead). And a refusal is published too, because it
 * carries the text the refused person reads.
 */
async function withholdIdentity(
  tool: TriggerUserAuthTool,
  botConfig: BotConfig,
  sessionDataDir: string,
  sessionId: string,
  senderOpenId: string | undefined,
  locale: Locale | undefined,
  turnId: string | undefined,
): Promise<ToolIdentityOutcome> {
  if (
    unauthorizedOutcomeFor(botConfig.triggerUserAuth, tool) !== 'fail'
    && tool === 'lark-cli'
    && botConfig.larkAppId
    && botConfig.larkAppSecret
  ) {
    try {
      writeSessionIdentity(sessionDataDir, sessionId, {
        tool: 'lark-cli',
        mode: 'bot',
        appId: botConfig.larkAppId,
        appSecret: botConfig.larkAppSecret,
        ...(turnId ? { turnId } : {}),
      });
      return { tool, state: 'bot-identity' };
    } catch {
      // Fall through to the refusal: no file at all is refused by the wrapper,
      // which is the safe end of this failure.
    }
  }
  // Blocking refusal. Fetch a fresh authorization link NOW (at acceptance, before
  // the agent picks a tool) and bake it into the message the wrapper prints — so
  // the moment the command actually needs this CLI, the agent has a ready,
  // correct link to relay instead of asking the person to type /login. Beginning
  // the device flow does not message anyone; the link is only surfaced if the
  // tool is really invoked and refused.
  let authUrl: string | undefined;
  if (senderOpenId) {
    try {
      authUrl = tool === 'bytedcli'
        ? (await beginBytedcliLogin(senderOpenId))?.authUrl
        : (await beginLarkCliLogin(senderOpenId))?.authUrl;
    } catch (e) {
      logger.debug(`[trigger-user-auth] could not pre-fetch ${tool} auth link: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  writeDenial(sessionDataDir, sessionId, tool, senderOpenId, botConfig, locale, turnId, authUrl);
  return { tool, state: 'needs-authorization' };
}

/**
 * Publish a refusal the wrapper prints verbatim on stderr.
 *
 * Names the person whose authorization is missing when we know it, and always
 * says how to supply it. Without the "how", someone whose command just failed
 * has no way to discover that /login is the answer — they retry, fail again,
 * and conclude the bot is broken.
 *
 * Best-effort by construction: if this write fails the file stays absent, which
 * the wrapper also reads as a denial. Safety does not depend on it landing —
 * only the quality of the message does.
 */
function writeDenial(
  sessionDataDir: string,
  sessionId: string,
  tool: TriggerUserAuthTool,
  senderOpenId: string | undefined,
  botConfig: BotConfig,
  locale: Locale | undefined,
  turnId: string | undefined,
  authUrl?: string,
): void {
  try {
    // Provider name is always relevant: bytedcli authenticates against ByteCloud,
    // so the link/refusal must not read as a Feishu authorization.
    const provider = tool === 'bytedcli'
      ? 'ByteCloud'
      : t('trigger_user_auth.provider_lark', undefined, locale);
    // Optional: name the person when we genuinely know it. Uncommon on a refusal
    // (they usually have no stored token), so most renders address the reader
    // directly rather than print a raw open_id.
    const knownName = senderOpenId && botConfig.larkAppId
      ? lookupAuthorizedUserName(botConfig.larkAppId, senderOpenId, normalizeBrand(botConfig.brand))
      : undefined;

    // With a live device-code link, lead with the direct, self-serve instruction
    // — the person does not type anything; they open the link and authorize, then
    // tell the agent to retry. Without one (link fetch failed, or no human
    // sender), fall back to the /login instructions.
    const parts: string[] = [];
    if (authUrl) {
      parts.push(knownName
        ? t('trigger_user_auth.denied_named_link', { tool, provider, name: knownName }, locale)
        : t('trigger_user_auth.denied_you_link', { tool, provider }, locale));
      parts.push(authUrl);
      parts.push(t('trigger_user_auth.denied_link_footer', undefined, locale));
    } else {
      // With no name, address the reader directly rather than printing a raw
      // open_id at them. The name comes from a stored Lark token, which someone
      // being refused for lack of authorization usually does not have — so the
      // nameless case is the COMMON one here, not an edge case, and `「ou_5f3a…」
      // 本人` reads as a machine talking to itself.
      parts.push(!senderOpenId
        ? t('trigger_user_auth.denied_anonymous', { tool, provider }, locale)
        : knownName
          ? t('trigger_user_auth.denied_known_user', { name: knownName, tool, provider }, locale)
          : t('trigger_user_auth.denied_you', { tool, provider }, locale));
      // Name the right command: ByteCloud and Feishu are separate providers, so
      // telling a refused bytedcli user to send `/login` would send them to
      // authorize the wrong thing and fail again.
      parts.push(t(
        'trigger_user_auth.denied_howto',
        { command: tool === 'bytedcli' ? '/login bytedcli' : '/login' },
        locale,
      ));
      parts.push(t('trigger_user_auth.denied_howto_status', undefined, locale));
    }
    writeSessionIdentity(sessionDataDir, sessionId, {
      tool,
      mode: 'denied',
      ...(turnId ? { turnId } : {}),
      message: parts.join('\n'),
    });
  } catch (e) {
    clearSessionIdentity(sessionDataDir, sessionId, tool);
    logger.debug(
      `[trigger-user-auth] could not publish the ${tool} denial (absent file denies too): `
      + `${e instanceof Error ? e.message : String(e)}`,
    );
  }
}

async function resolveIdentityFor(
  tool: TriggerUserAuthTool,
  botConfig: BotConfig,
  senderOpenId: string,
): Promise<CliIdentity | null> {
  if (tool === 'lark-cli') {
    // Preferred path: the per-person HOME created by the device-code (`/login`)
    // flow. lark-cli then acts as that person using its OWN app's credentials —
    // no token is injected, and this does not require the person to be inside the
    // bot app's availability scope. The wrapper only exports HOME.
    const home = larkCliHomeForTurn(senderOpenId);
    if (home) return { tool: 'lark-cli', mode: 'user-home', home };

    // Back-compat: a person who authorized through the bot app before the
    // device-code path existed still gets their injected token. New logins go to
    // the HOME above; this branch only fires for a legacy token with no HOME.
    if (!botConfig.larkAppId || !botConfig.larkAppSecret) return null;
    const token = await resolveUserToken(
      botConfig.larkAppId,
      botConfig.larkAppSecret,
      normalizeBrand(botConfig.brand),
      senderOpenId,
    );
    if (!token) return null;
    // The app id travels with the token: lark-cli refuses a token without it
    // ("blocked by env: …USER_ACCESS_TOKEN is set but …APP_ID is missing").
    return { tool: 'lark-cli', appId: botConfig.larkAppId, userAccessToken: token };
  }

  // bytedcli authenticates against ByteCloud SSO, a different provider from
  // Lark OAuth — a Lark user token is not convertible into a ByteCloud JWT. So
  // this person's credentials come from their own bytedcli login, minted fresh
  // per turn: the ByteCloud JWT lives ~2 hours while the login behind it lives
  // ~3 weeks, and bytedcli refreshes it internally, so asking each time is what
  // keeps people from being sent back to a QR code every couple of hours.
  //
  // Null when they have not authorized (or their login has ended), which the
  // caller turns into the ordinary "authorize, then retry" refusal rather than
  // falling back to the machine's own SSO session.
  const jwts = await mintBytedcliJwts(senderOpenId);
  if (!jwts) return null;
  return { tool: 'bytedcli', cloudJwt: jwts.cloudJwt, ...(jwts.codeJwt ? { codeJwt: jwts.codeJwt } : {}) };
}
