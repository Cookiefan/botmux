import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  crossPrincipalAgentHint,
  crossPrincipalBotClassifyNotice,
  crossPrincipalClassificationOptions,
  embedCrossPrincipalAsToken,
  isCrossPrincipalChoiceOnlyText,
  parseCrossPrincipalAsFlag,
  parseCrossPrincipalChoiceText,
  stripCrossPrincipalAsToken,
} from '../src/core/cross-principal-choice.js';
import { messages as enMessages } from '../src/i18n/en.js';
import { messages as zhMessages } from '../src/i18n/zh.js';

const daemonSource = readFileSync(new URL('../src/daemon.ts', import.meta.url), 'utf8');
const cliSource = readFileSync(new URL('../src/cli.ts', import.meta.url), 'utf8');

describe('cross-principal choice vocabulary', () => {
  it('parses --as aliases for the two agent options', () => {
    expect(parseCrossPrincipalAsFlag('independent')).toBe('independent');
    expect(parseCrossPrincipalAsFlag('另开任务')).toBe('independent');
    expect(parseCrossPrincipalAsFlag('独立任务')).toBe('independent');
    expect(parseCrossPrincipalAsFlag('suggestion')).toBe('suggestion');
    expect(parseCrossPrincipalAsFlag('留给当前任务')).toBe('suggestion');
    expect(parseCrossPrincipalAsFlag('建议')).toBe('suggestion');
    expect(parseCrossPrincipalAsFlag('maybe')).toBeUndefined();
  });

  it('round-trips a hidden token without changing the visible body', () => {
    const embedded = embedCrossPrincipalAsToken('请帮我看一下这段 diff', 'independent');
    expect(embedded).toContain('请帮我看一下这段 diff');
    expect(embedded).toContain('<!--botmux-as:independent-->');

    const stripped = stripCrossPrincipalAsToken(embedded);
    expect(stripped.text).toBe('请帮我看一下这段 diff');
    expect(stripped.choice).toBe('independent');
  });

  it('treats a token-only body as a follow-up choice', () => {
    const embedded = embedCrossPrincipalAsToken('', 'suggestion');
    expect(isCrossPrincipalChoiceOnlyText(embedded, 'classification')).toBe(true);
    expect(parseCrossPrincipalChoiceText(embedded, 'classification')).toBe('suggestion');
  });

  it('accepts the human card labels as free-text answers', () => {
    expect(parseCrossPrincipalChoiceText('另开任务', 'classification')).toBe('independent');
    expect(parseCrossPrincipalChoiceText('留给当前任务', 'classification')).toBe('suggestion');
    expect(parseCrossPrincipalChoiceText('独立任务', 'classification')).toBe('independent');
    expect(parseCrossPrincipalChoiceText('建议', 'classification')).toBe('suggestion');
    expect(isCrossPrincipalChoiceOnlyText('请帮我看一下这段 diff', 'classification')).toBe(false);
  });

  it('does not treat arbitrary business text as a host-ask answer', () => {
    expect(parseCrossPrincipalChoiceText('建议先把测试补上再合', 'classification')).toBeUndefined();
    expect(isCrossPrincipalChoiceOnlyText('建议先把测试补上再合', 'classification')).toBe(false);
  });
});

describe('cross-principal choice wiring', () => {
  it('shows humans a two-option Feishu card and tells agents to use botmux send --as', () => {
    expect(daemonSource).toContain('crossPrincipalClassificationOptions');
    expect(daemonSource).toContain('crossPrincipalBotClassifyNotice');
    expect(daemonSource).toContain("record.proposer.senderType === 'bot'");
    expect(cliSource).toContain("argValue(rest, '--as')");
    expect(cliSource).toContain('embedCrossPrincipalAsToken');
    expect(cliSource).toContain('xpi.send.as_needed_hint');
  });
});

describe('cross-principal choice copy', () => {
  it('keeps the human card to exactly two short options', () => {
    const zh = crossPrincipalClassificationOptions('zh');
    expect(zh).toEqual([
      { key: 'independent', label: '另开任务' },
      { key: 'suggestion', label: '留给当前任务' },
    ]);

    const en = crossPrincipalClassificationOptions('en');
    expect(en).toEqual([
      { key: 'independent', label: 'Start a new task' },
      { key: 'suggestion', label: 'Leave it for the current task' },
    ]);
  });

  it('tells agents to choose with botmux send --as, not a card', () => {
    const zhHint = crossPrincipalAgentHint('zh');
    expect(zhHint).toContain('botmux send --as independent');
    expect(zhHint).toContain('botmux send --as suggestion');
    expect(zhHint).toContain('另开任务');
    expect(zhHint).toContain('留给当前任务');

    const notice = crossPrincipalBotClassifyNotice('ou_bot', 'zh');
    expect(notice).toContain('<at id=ou_bot></at>');
    expect(notice).toContain(zhHint);
    expect(notice).not.toContain('请选一种处理方式');
  });

  it('keeps zh/en send-hint keys aligned', () => {
    for (const key of [
      'xpi.card.classify.independent',
      'xpi.card.classify.suggestion',
      'xpi.agent.hint',
      'xpi.send.as_needed_hint',
      'ai.routing.xpi_as_hint',
      'ai.shell.xpi_as_hint',
    ] as const) {
      expect(zhMessages[key]).toBeTruthy();
      expect(enMessages[key]).toBeTruthy();
    }
    expect(zhMessages['xpi.send.as_needed_hint']).toContain('--as independent');
    expect(zhMessages['xpi.send.as_needed_hint']).toContain('--as suggestion');
    expect(enMessages['xpi.send.as_needed_hint']).toContain('--as independent');
    expect(enMessages['xpi.send.as_needed_hint']).toContain('--as suggestion');
  });
});
