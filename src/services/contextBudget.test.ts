import { describe, it, expect } from 'vitest';
import {
  CONTEXT_WINDOW_TOKENS,
  INPUT_HARD_RATIO,
  INPUT_WARN_RATIO,
  COMPACT_TRIGGER_RATIO,
  FORCE_COMPACT_RATIO,
  modelContextWindow,
  estimateTokensRough,
  estimateMessageTokens,
  estimateMessagesTokens,
  compactContext,
  capToolResult,
  capHistoryContent,
} from './contextBudget.js';

describe('modelContextWindow + FORCE_COMPACT_RATIO', () => {
  it('FORCE_COMPACT_RATIO is 0.95 and above COMPACT_TRIGGER_RATIO', () => {
    expect(FORCE_COMPACT_RATIO).toBe(0.95);
    expect(FORCE_COMPACT_RATIO).toBeGreaterThan(COMPACT_TRIGGER_RATIO);
  });
  it('falls back to global default with no override/obj', () => {
    expect(modelContextWindow(undefined)).toBe(CONTEXT_WINDOW_TOKENS);
    expect(modelContextWindow('whatever')).toBe(CONTEXT_WINDOW_TOKENS);
  });
  it('reads context_window / contextWindow from the model object', () => {
    expect(modelContextWindow('m', { context_window: 200000 })).toBe(200000);
    expect(modelContextWindow('m', { contextWindow: 32000 })).toBe(32000);
  });
  it('ignores sub-4k garbage windows', () => {
    expect(modelContextWindow('m', { context_window: 100 })).toBe(CONTEXT_WINDOW_TOKENS);
  });
});

describe('contextBudget constants', () => {
  it('hold the audited ratios', () => {
    expect(INPUT_HARD_RATIO).toBe(0.5);
    expect(INPUT_WARN_RATIO).toBe(0.25);
    expect(COMPACT_TRIGGER_RATIO).toBe(0.5);
  });
  it('default context window is 128k when env unset', () => {
    // CI 不设 TANGU_CONTEXT_WINDOW_TOKENS
    if (!process.env.TANGU_CONTEXT_WINDOW_TOKENS) {
      expect(CONTEXT_WINDOW_TOKENS).toBe(128_000);
    }
    expect(CONTEXT_WINDOW_TOKENS).toBeGreaterThanOrEqual(4_000);
  });
});

describe('estimateTokensRough (CJK-aware)', () => {
  it('returns 0 for empty', () => {
    expect(estimateTokensRough('')).toBe(0);
  });
  it('counts ascii ~4 chars/token', () => {
    expect(estimateTokensRough('abcd')).toBe(1); // ceil(4/4)
    expect(estimateTokensRough('a')).toBe(1); // ceil(1/4)
  });
  it('counts non-ascii ~1 token/char', () => {
    expect(estimateTokensRough('中文')).toBe(2); // ceil(0/4)+2
    expect(estimateTokensRough('ab中')).toBe(2); // ceil(2/4)=1 + 1
  });
});

describe('estimateMessageTokens / estimateMessagesTokens', () => {
  it('adds 8 role overhead + content estimate (string)', () => {
    expect(estimateMessageTokens({ role: 'user', content: 'abcd' })).toBe(9); // 8 + 1
  });
  it('handles text parts and image_url length/8', () => {
    expect(estimateMessageTokens({ role: 'user', content: [{ type: 'text', text: 'abcd' }] })).toBe(9);
    const url = 'x'.repeat(80);
    expect(estimateMessageTokens({ role: 'user', content: [{ type: 'image_url', image_url: { url } }] })).toBe(18); // 8 + ceil(80/8)
  });
  it('includes tool_calls arguments', () => {
    expect(estimateMessageTokens({ role: 'assistant', tool_calls: [{ function: { arguments: 'abcd' } }] })).toBe(9);
  });
  it('sums across messages', () => {
    const msgs = [
      { role: 'user', content: 'abcd' },
      { role: 'assistant', content: 'abcd' },
    ] as any;
    expect(estimateMessagesTokens(msgs)).toBe(18);
  });
});

describe('compactContext', () => {
  function buildMsgs() {
    const msgs: any[] = [{ role: 'system', content: 'sys' }];
    for (let i = 1; i < 50; i++) msgs.push({ role: 'user', content: 'm' + i });
    // protected: index 2 (< startProtectEnd=4) and index 45 (>= lastProtectStart=30)
    msgs[2] = { role: 'tool', content: 'a'.repeat(1000) };
    msgs[45] = { role: 'tool', content: 'b'.repeat(1000) };
    // foldable middle (4 <= i < 30)
    msgs[10] = { role: 'tool', content: 'x'.repeat(1000) };
    msgs[15] = { role: 'user', content: 'y'.repeat(9000) };
    return msgs;
  }

  it('folds middle tool + truncates middle long msgs, protecting head/tail', () => {
    const msgs = buildMsgs();
    const r = compactContext(msgs);
    expect(r.changed).toBe(true);
    expect(r.savedChars).toBeGreaterThan(0);
    expect(Array.isArray(r.breakdown)).toBe(true);
    expect(r.breakdown.length).toBe(3);
    // protected boundaries untouched
    expect(msgs[2].content.length).toBe(1000);
    expect(msgs[45].content.length).toBe(1000);
    // middle folded/truncated
    expect(msgs[10].content).toContain('工具输出已折叠');
    expect(msgs[15].content).toContain('上下文压缩:省略');
  });

  it('is idempotent (second pass is a no-op)', () => {
    const msgs = buildMsgs();
    compactContext(msgs);
    const second = compactContext(msgs);
    expect(second.changed).toBe(false);
    expect(second.savedChars).toBe(0);
  });
});

describe('capToolResult / capHistoryContent', () => {
  it('leaves sub-limit text unchanged', () => {
    const s = 'a'.repeat(50);
    expect(capToolResult(s)).toBe(s);
    expect(capHistoryContent(s)).toBe(s);
  });
  it('caps oversize tool result keeping head+tail', () => {
    const s = 'a'.repeat(200_000);
    const out = capToolResult(s);
    expect(out.length).toBeLessThan(s.length);
    expect(out).toContain('单条工具输出超限');
    expect(out.startsWith('a'.repeat(4_000))).toBe(true);
    expect(out.endsWith('a'.repeat(1_500))).toBe(true);
  });
  it('caps oversize history content keeping head+tail', () => {
    const s = 'a'.repeat(200_000);
    const out = capHistoryContent(s);
    expect(out.length).toBeLessThan(s.length);
    expect(out).toContain('历史消息超限');
    expect(out.startsWith('a'.repeat(2_000))).toBe(true);
    expect(out.endsWith('a'.repeat(500))).toBe(true);
  });
});

describe('770k-token incident gate math', () => {
  it('flags input above 50% window as too large', () => {
    const big = '中'.repeat(CONTEXT_WINDOW_TOKENS * INPUT_HARD_RATIO + 1); // each CJK ≈ 1 token
    expect(estimateTokensRough(big)).toBeGreaterThan(CONTEXT_WINDOW_TOKENS * INPUT_HARD_RATIO);
  });
  it('lets a normal small input pass the gate', () => {
    const small = 'hello world '.repeat(50);
    expect(estimateTokensRough(small)).toBeLessThan(CONTEXT_WINDOW_TOKENS * INPUT_WARN_RATIO);
  });
});
