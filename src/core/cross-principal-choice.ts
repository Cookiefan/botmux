/**
 * Shared classification vocabulary for a message that arrived while another
 * principal already owns the active turn.
 *
 * Humans pick on a two-button Feishu card. Agents declare the same choice
 * through `botmux send --as independent|suggestion`. The token, flag aliases,
 * and free-text keywords must stay interchangeable so a bot follow-up can
 * settle a human card and vice versa.
 */
import { t, type Locale } from '../i18n/index.js';

export const CROSS_PRINCIPAL_AS_CHOICES = ['independent', 'suggestion'] as const;
export type CrossPrincipalAsChoice = (typeof CROSS_PRINCIPAL_AS_CHOICES)[number];

export type CrossPrincipalChoice =
  | CrossPrincipalAsChoice
  | 'accept'
  | 'reject'
  | 'continue_waiting';

export type CrossPrincipalChoiceKind = 'classification' | 'wait' | 'owner';

const AS_TOKEN_RE = /(?:^|\n)\s*<!--botmux-as:(independent|suggestion)-->\s*$/;

const INDEPENDENT_TEXT = /^(?:独立任务|另开任务)(?:[\s，。,.!！]|$)/i;
const SUGGESTION_TEXT = /^(?:对\s*A\s*的建议|留给当前任务|建议)(?:[\s，。,.!！]|$)/i;
const ACCEPT_TEXT = /^(?:确认|同意|采纳并重新执行|采纳|执行|是|yes|y|ok|accept)(?:[\s，。,.!！]|$)/i;
const REJECT_TEXT = /^(?:拒绝|不采纳|否|no|n|reject)(?:[\s，。,.!！]|$)/i;
const CONTINUE_WAITING_TEXT = /^(?:继续等待|继续等)(?:[\s，。,.!！]|$)/i;

export function isCrossPrincipalAsChoice(value: string): value is CrossPrincipalAsChoice {
  return value === 'independent' || value === 'suggestion';
}

/** Parse `botmux send --as <value>`. Unknown values stay undefined. */
export function parseCrossPrincipalAsFlag(raw: string | undefined): CrossPrincipalAsChoice | undefined {
  if (!raw) return undefined;
  const value = raw.trim().toLowerCase();
  if (
    value === 'independent'
    || value === 'new'
    || value === '另开任务'
    || value === '独立任务'
  ) return 'independent';
  if (
    value === 'suggestion'
    || value === 'advice'
    || value === '留给当前任务'
    || value === '建议'
  ) return 'suggestion';
  return undefined;
}

export function embedCrossPrincipalAsToken(
  text: string,
  choice: CrossPrincipalAsChoice,
): string {
  const stripped = stripCrossPrincipalAsToken(text).text.replace(/\s+$/u, '');
  const token = `<!--botmux-as:${choice}-->`;
  return stripped ? `${stripped}\n${token}` : token;
}

export function stripCrossPrincipalAsToken(text: string): {
  text: string;
  choice?: CrossPrincipalAsChoice;
} {
  const match = text.match(AS_TOKEN_RE);
  if (!match || match.index === undefined) return { text };
  return {
    text: text.slice(0, match.index).replace(/\s+$/u, ''),
    choice: match[1] as CrossPrincipalAsChoice,
  };
}

export function parseCrossPrincipalChoiceText(
  text: string,
  kind: CrossPrincipalChoiceKind | 'any' = 'any',
): CrossPrincipalChoice | undefined {
  const stripped = stripCrossPrincipalAsToken(text);
  if (stripped.choice && (kind === 'classification' || kind === 'wait' || kind === 'any')) {
    return stripped.choice;
  }
  const body = stripped.text.trim();
  if (!body) return undefined;
  if (kind === 'classification' || kind === 'any') {
    if (INDEPENDENT_TEXT.test(body)) return 'independent';
    if (SUGGESTION_TEXT.test(body)) return 'suggestion';
  }
  if (kind === 'wait' || kind === 'any') {
    if (CONTINUE_WAITING_TEXT.test(body)) return 'continue_waiting';
    if (INDEPENDENT_TEXT.test(body)) return 'independent';
  }
  if (kind === 'owner' || kind === 'any') {
    if (ACCEPT_TEXT.test(body)) return 'accept';
    if (REJECT_TEXT.test(body)) return 'reject';
  }
  return undefined;
}

/** True when the inbound body is only a classification/wait/owner choice. */
export function isCrossPrincipalChoiceOnlyText(
  text: string,
  kind: CrossPrincipalChoiceKind,
): boolean {
  const stripped = stripCrossPrincipalAsToken(text);
  const choice = parseCrossPrincipalChoiceText(text, kind);
  if (!choice) return false;
  if (!stripped.text.trim()) return true;
  return parseCrossPrincipalChoiceText(stripped.text, kind) === choice;
}

export function crossPrincipalAsKeyword(
  choice: CrossPrincipalAsChoice,
  locale?: Locale,
): string {
  return choice === 'independent'
    ? t('xpi.choice.independent', undefined, locale)
    : t('xpi.choice.suggestion', undefined, locale);
}

export function crossPrincipalClassificationPrompt(
  proposerOpenId: string,
  locale?: Locale,
): string {
  return t('xpi.card.classify.prompt', { at: `<at id=${proposerOpenId}></at>` }, locale);
}

export function crossPrincipalClassificationOptions(locale?: Locale): Array<{
  key: CrossPrincipalAsChoice;
  label: string;
}> {
  return [
    { key: 'independent', label: t('xpi.card.classify.independent', undefined, locale) },
    { key: 'suggestion', label: t('xpi.card.classify.suggestion', undefined, locale) },
  ];
}

export function crossPrincipalWaitPrompt(
  proposerOpenId: string,
  locale?: Locale,
): string {
  return t('xpi.card.wait.prompt', { at: `<at id=${proposerOpenId}></at>` }, locale);
}

export function crossPrincipalWaitOptions(locale?: Locale): Array<{
  key: 'continue_waiting' | 'independent';
  label: string;
}> {
  return [
    { key: 'continue_waiting', label: t('xpi.card.wait.continue', undefined, locale) },
    { key: 'independent', label: t('xpi.card.wait.independent', undefined, locale) },
  ];
}

export function crossPrincipalStagedNotice(
  proposerOpenId: string | undefined,
  locale?: Locale,
): string {
  const at = proposerOpenId ? `<at id=${proposerOpenId}></at> ` : '';
  return `${at}${t('xpi.notice.staged', undefined, locale)}`;
}

export function crossPrincipalAgentHint(locale?: Locale): string {
  return t('xpi.agent.hint', undefined, locale);
}

export function crossPrincipalBotClassifyNotice(
  proposerOpenId: string,
  locale?: Locale,
): string {
  return `${t('xpi.bot.classify.notice', { at: `<at id=${proposerOpenId}></at>` }, locale)}\n${crossPrincipalAgentHint(locale)}`;
}

export function crossPrincipalBotWaitNotice(
  proposerOpenId: string,
  locale?: Locale,
): string {
  return `${t('xpi.bot.wait.notice', { at: `<at id=${proposerOpenId}></at>` }, locale)}\n${crossPrincipalAgentHint(locale)}`;
}
