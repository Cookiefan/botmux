/**
 * 命令路由器 —— 斜杠命令的**分类层**（设计 docs/design/2026-09-11-command-router.md R1 / §5）。
 *
 * 输入是命令车道文本（今天 daemon 里剥掉前导 @ 之后的 `cmdContent`）加四样上下文：入口
 * （新话题 / thread）、会话相位（session-phase.ts）、按 bot/CLI 算好的透传集、发送方是不是
 * bot。输出是一条**决策**：这条消息归谁认领、以什么会话政策处理。执行仍在 daemon 两条入口
 * 里，路由器只回答"是什么"，不做效果。
 *
 * PR-2 的约定：**决策与今天逐字一致**（零语义变化），差分由 test/legacy-oracle 的冻结 oracle
 * 穷举验证。今天两条入口的不一致（thread 里 `/card` `/cot` 没有前置特判、`/term` 在透传闸
 * 之后）通过 schema 的 `special.newTopic / special.thread` 两个字段如实保留；收敛它们是 §9
 * 里 PR-2 的一条有意变化，改的是那两个数据值，不是这里的代码。
 *
 * 纯函数：不读配置、不碰会话表。透传集由调用方按入口口径求值（新话题按 live bot 配置；
 * thread 按冻结的 `cliLaunchSnapshot.cliId`，见 R2）后传入。
 */
import {
  DAEMON_COMMANDS,
  EXISTING_SESSION_ONLY_DAEMON_COMMANDS,
  MULTILINE_COMMANDS,
  ROUTE_SPECIAL_COMMANDS,
  SESSIONLESS_DAEMON_COMMANDS,
  type CommandSpecialHandler,
} from './command-schema.js';
import { docWatchCommandNeedsSession } from './doc-watch-command.js';
import { phaseHasLiveWorker, phaseHasSession, type SessionPhase } from './session-phase.js';

export interface SlashCommandInvocation {
  cmd: string;
  content: string;
}

/** Parse a user-authored slash command after leading @mentions have already
 *  been stripped. Messages that look like command examples or command lists
 *  are intentionally left for the CLI instead of being intercepted by the
 *  daemon; otherwise discussion text such as `/adopt <pane>` can accidentally
 *  trigger real daemon actions. */
export function parseSlashCommandInvocation(content: string): SlashCommandInvocation | null {
  // trim BOTH ends: a trailing newline/space rides into the returned `content`
  // and, for a passthrough command relayed verbatim to the CLI (raw_input), gets
  // typed as a literal trailing newline — which breaks the CLI's slash-command
  // detection (it sees a multi-line message, not a `/cmd`). Internal newlines for
  // MULTILINE_COMMANDS are preserved (trim only touches the ends).
  const trimmed = content.trim();
  if (!trimmed.startsWith('/')) return null;

  const lines = trimmed.split(/\r?\n/);
  const firstLine = (lines[0] ?? '').trimEnd();
  const [cmdRaw] = firstLine.split(/\s+/);
  const cmd = cmdRaw?.toLowerCase();
  if (!cmd) return null;

  // Treat angle-bracket placeholders as documentation, not an invocation.
  if (/<[^>\r\n]+>/.test(firstLine)) return null;

  const restNonBlank = lines.slice(1).map(l => l.trim()).filter(Boolean);
  if (restNonBlank.length > 0) {
    // A list of slash commands is almost certainly discussion / planning text.
    if (restNonBlank.some(l => l.startsWith('/'))) return null;
    if (!MULTILINE_COMMANDS.has(cmd)) return null;
  }

  return { cmd, content: trimmed };
}

/**
 * `/watch-comment <doc>` 是会话型操作：即使命令族的 list/off/pending 可以无会话
 * 运行，真正开始监听时也要创建/复用当前话题 session 并立即预热 CLI。
 */
export function isSessionlessCommandInvocation(cmd: string, content: string): boolean {
  if (!SESSIONLESS_DAEMON_COMMANDS.has(cmd)) return false;
  if (cmd !== '/watch-comment') return true;
  return !docWatchCommandNeedsSession(content);
}

export type RouteContext = 'new-topic' | 'thread';

export interface SlashRouteInput {
  /** 命令车道文本：已剥前导 @（今天的 `cmdContent`）。 */
  text: string;
  context: RouteContext;
  /** 新话题入口恒为 `none`（那条路径不查 activeSessions）；thread 入口按 `deriveSessionPhase(existingDs)`。 */
  phase: SessionPhase;
  /** `resolvePassthroughCommands(...)` 的结果，按入口口径求值（R2）。 */
  passthrough: ReadonlySet<string>;
  /** adapter `defaultPassthroughCommands`——无会话时允许冷启动的透传命令（`/goal`）。 */
  coldStartPassthrough: ReadonlySet<string>;
  senderIsBot: boolean;
  acceptSlashFromBots: boolean;
}

export type SlashRouteDecision =
  /** 交给 CLI 当普通消息：没有命令 token / 讨论文本 / bot 发送方被门掉 / 认不出的 `/xxx`。 */
  | { kind: 'forward'; reason: 'no_slash' | 'discussion' | 'bot_gated' | 'unknown_slash' }
  /** 路由入口的前置特判处理器，不进 handleCommand、不建会话。 */
  | { kind: 'special'; cmd: string; content: string; handler: CommandSpecialHandler }
  /** 透传给 CLI：冷启动拉起会话 / 送进已有 worker / 两种拒绝（文案不同，如实保留）。 */
  | { kind: 'passthrough'; cmd: string; content: string; delivery: 'cold_start' | 'existing' | 'reject_needs_session' | 'reject_needs_active_cli' }
  /** botmux 自己的命令，带无会话时的会话政策。 */
  | { kind: 'daemon'; cmd: string; content: string; sessionPolicy: 'sessionless' | 'existing_only' | 'precreate' | 'existing' };

export function classifySlash(input: SlashRouteInput): SlashRouteDecision {
  // ① bot 门：在 parse 之前——被门掉的 bot 消息连"是不是命令"都不判。
  if (input.senderIsBot && !input.acceptSlashFromBots) {
    return { kind: 'forward', reason: 'bot_gated' };
  }

  // ② parse：不以 `/` 开头是"没有命令"；占位符/多行是"讨论文本"。
  const invocation = parseSlashCommandInvocation(input.text);
  if (!invocation) {
    return { kind: 'forward', reason: input.text.trim().startsWith('/') ? 'discussion' : 'no_slash' };
  }
  const { cmd, content } = invocation;
  const special = ROUTE_SPECIAL_COMMANDS.get(cmd);
  const entry = input.context === 'new-topic' ? special?.newTopic : special?.thread;

  // ③ 透传闸之前的前置特判。
  if (special && entry === 'before-passthrough') {
    return { kind: 'special', cmd, content, handler: special.handler };
  }

  // ④ 透传闸（先于 DAEMON_COMMANDS；两集合恒不相交，顺序因此不可观测）。
  if (input.passthrough.has(cmd)) {
    const hasSession = input.context === 'thread' && phaseHasSession(input.phase);
    if (!hasSession && input.coldStartPassthrough.has(cmd)) {
      return { kind: 'passthrough', cmd, content, delivery: 'cold_start' };
    }
    if (hasSession) {
      return {
        kind: 'passthrough', cmd, content,
        delivery: phaseHasLiveWorker(input.phase) ? 'existing' : 'reject_needs_active_cli',
      };
    }
    // 无会话且不能冷启动：两条入口今天的文案不同，如实区分。
    return {
      kind: 'passthrough', cmd, content,
      delivery: input.context === 'new-topic' ? 'reject_needs_session' : 'reject_needs_active_cli',
    };
  }

  // ⑤ DAEMON_COMMANDS。
  if (DAEMON_COMMANDS.has(cmd)) {
    if (special && entry === 'in-daemon-block') {
      return { kind: 'special', cmd, content, handler: special.handler };
    }
    if (isSessionlessCommandInvocation(cmd, content)) {
      return { kind: 'daemon', cmd, content, sessionPolicy: 'sessionless' };
    }
    if (EXISTING_SESSION_ONLY_DAEMON_COMMANDS.has(cmd)) {
      return { kind: 'daemon', cmd, content, sessionPolicy: 'existing_only' };
    }
    const hasSession = input.context === 'thread' && phaseHasSession(input.phase);
    return { kind: 'daemon', cmd, content, sessionPolicy: hasSession ? 'existing' : 'precreate' };
  }

  // ⑥ 认出是 `/xxx` 但不属于任何集合 → 当普通消息转发。
  return { kind: 'forward', reason: 'unknown_slash' };
}
