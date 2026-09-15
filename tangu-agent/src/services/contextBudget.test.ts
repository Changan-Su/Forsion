import { describe, it, expect, beforeEach } from 'vitest';
import {
  CONTEXT_WINDOW_TOKENS,
  INPUT_HARD_RATIO,
  INPUT_WARN_RATIO,
  COMPACT_TRIGGER_RATIO,
  FORCE_COMPACT_RATIO,
  modelContextWindow,
  modelContextWindowInfo,
  estimateTokensRough,
  estimateMessageTokens,
  estimateMessagesTokens,
  compactContext,
  capToolResult,
  capHistoryContent,
} from './contextBudget.js';
import { resetModelOverridesForTest } from './modelOverrides.js';

// 用户覆盖层默认读真家目录的 config.json —— 整个套件钉成内存表,开发机上有没有 modelOverrides 段都不影响断言。
beforeEach(() => resetModelOverridesForTest());

describe('modelContextWindowInfo 来源标注', () => {
  it('model 元数据 / family 族表 / default 兜底 三档来源正确', () => {
    expect(modelContextWindowInfo('m', { context_window: 200000 })).toEqual({ tokens: 200000, source: 'model' })
    expect(modelContextWindowInfo('claude-opus-5')).toEqual({ tokens: 1_000_000, source: 'family' })
    expect(modelContextWindowInfo('whatever')).toEqual({ tokens: CONTEXT_WINDOW_TOKENS, source: 'default' })
    // 无效元数据(<4k)不算 model 档,落到后续档位
    expect(modelContextWindowInfo('whatever', { context_window: 100 }).source).toBe('default')
  })
  it('族表同时按模型对象的 apiModelId 匹配:目录导入的 pr-<hash> id 不再一律落默认档(2026-09-11 生产实报)', () => {
    const hashId = 'pr-4cbcb1891e630b889b329a3dd0a77df84c2406e0babae76e'
    expect(modelContextWindowInfo(hashId, { contextWindow: null, apiModelId: 'gpt-6-astra' })).toEqual({ tokens: 272_000, source: 'family' })
    expect(modelContextWindowInfo('Auto', { apiModelId: 'claude-opus-5' })).toEqual({ tokens: 1_000_000, source: 'family' })
    // admin 把 272K 填成 272:模型自报值无效 → 仍靠 apiModelId 走族表,而不是默认档
    expect(modelContextWindowInfo(hashId, { contextWindow: 272, apiModelId: 'gpt-6-astra' })).toEqual({ tokens: 272_000, source: 'family' })
    // 有效的自报值压过族表
    expect(modelContextWindowInfo(hashId, { contextWindow: 272_000, apiModelId: 'gpt-6-astra' }).source).toBe('model')
    // id 命中优先于 apiModelId(数组顺序)
    expect(modelContextWindowInfo('kimi/kimi-k3', { apiModelId: 'gpt-5' })).toEqual({ tokens: 1_000_000, source: 'family' })
  })
  it('用户本机 modelOverrides 压过模型自报 / 族表,但低于 4k 的脏值被滤掉', () => {
    resetModelOverridesForTest({ 'pr-x': { contextWindow: 500_000 }, 'codex/gpt-5.6-sol': { contextWindow: 1_050_000 }, dirty: { contextWindow: 272 } })
    expect(modelContextWindowInfo('pr-x', { contextWindow: 272_000, apiModelId: 'gpt-6-astra' })).toEqual({ tokens: 500_000, source: 'override' })
    expect(modelContextWindowInfo('codex/gpt-5.6-sol')).toEqual({ tokens: 1_050_000, source: 'override' })
    expect(modelContextWindowInfo('dirty')).toEqual({ tokens: CONTEXT_WINDOW_TOKENS, source: 'default' })
    expect(modelContextWindowInfo('untouched', { contextWindow: 200_000 })).toEqual({ tokens: 200_000, source: 'model' })
  })
})

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
  it('falls back to family window when the model object has none (WB-Bench 64k premature-compaction fix)', () => {
    expect(modelContextWindow('codex/gpt-5.6-terra')).toBe(272_000);
    expect(modelContextWindow('gpt-5')).toBe(272_000);
    expect(modelContextWindow('gpt-6-astra')).toBe(272_000);
    expect(modelContextWindow('codex/gpt-6-astra')).toBe(272_000);
    expect(modelContextWindow('openai/gpt-6-astra')).toBe(272_000);
    expect(modelContextWindow('gpt-6-astra', { context_window: 922_000 })).toBe(922_000);
    expect(modelContextWindow('codex-mini-latest')).toBe(200_000); // o4-mini 底,272k 会溢出
    expect(modelContextWindow('claude-sonnet-4-5')).toBe(200_000);
    // Claude 5 家族 / Opus 4.7 起是 1M;4.6 及更早、Haiku 4.5 仍 200k(族表首命中,顺序即契约)
    expect(modelContextWindow('claude-sonnet-5')).toBe(1_000_000);
    expect(modelContextWindow('claude-fable-5')).toBe(1_000_000);
    expect(modelContextWindow('claude-opus-4-7')).toBe(1_000_000);
    expect(modelContextWindow('claude-opus-4-6')).toBe(200_000);
    expect(modelContextWindow('claude-haiku-4-5-20251001')).toBe(200_000);
    expect(modelContextWindow('kimi-k3')).toBe(1_000_000);
    expect(modelContextWindow('kimi-k2-thinking')).toBe(CONTEXT_WINDOW_TOKENS);
    expect(modelContextWindow('gemini-2.5-pro')).toBe(1_000_000);
    expect(modelContextWindow('gemini-embedding-001')).toBe(CONTEXT_WINDOW_TOKENS); // 非主线 gemini 变体保守
    expect(modelContextWindow('deepseek-chat')).toBe(CONTEXT_WINDOW_TOKENS); // 未收录族维持默认
    expect(modelContextWindow('deepseek-v4-flash')).toBe(1_000_000);
    // 网关转售的 V4 也该拿 1M —— 这条族规则**刻意不锚 ^**(与能力表的 host 限定规则不同口径)
    expect(modelContextWindow('deepseek-ai/DeepSeek-V4-Pro')).toBe(1_000_000);
    expect(modelContextWindow('myv4legacy')).toBe(CONTEXT_WINDOW_TOKENS); // 只认 deepseek-v4 字面,不认裸 v4
    // 2026-08 新族:同样不锚 ^,网关转售名也要拿到 1M
    expect(modelContextWindow('glm-5.3')).toBe(1_000_000);
    expect(modelContextWindow('zai-org/GLM-5.3-Flash')).toBe(1_000_000);
    expect(modelContextWindow('glm-5.2')).toBe(CONTEXT_WINDOW_TOKENS); // 5.2 是 200k 级,不该被 5.3 规则吞
    expect(modelContextWindow('Qwen/Qwen3.8-Max')).toBe(1_000_000);
    expect(modelContextWindow('qwen3.8-27b')).toBe(CONTEXT_WINDOW_TOKENS); // 小尺寸变体窗口未核实 → 保守默认
    // 模型对象自带值仍然优先于族兜底
    expect(modelContextWindow('gpt-5', { context_window: 64_000 })).toBe(64_000);
  });
});

describe('contextBudget constants', () => {
  it('hold the audited ratios', () => {
    expect(INPUT_HARD_RATIO).toBe(0.5);
    expect(INPUT_WARN_RATIO).toBe(0.25);
    expect(COMPACT_TRIGGER_RATIO).toBe(0.5);
  });
  it('default context window is 272k when env unset (2026-09-11 起;原 128k 让未收录模型 64k 就折叠)', () => {
    // CI 不设 TANGU_CONTEXT_WINDOW_TOKENS
    if (!process.env.TANGU_CONTEXT_WINDOW_TOKENS) {
      expect(CONTEXT_WINDOW_TOKENS).toBe(272_000);
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
  it('handles text parts and budgets images independently of URL length', () => {
    expect(estimateMessageTokens({ role: 'user', content: [{ type: 'text', text: 'abcd' }] })).toBe(9);
    const url = 'x'.repeat(80);
    expect(estimateMessageTokens({ role: 'user', content: [{ type: 'image_url', image_url: { url } }] })).toBe(4104); // role overhead + image heuristic
    expect(estimateMessageTokens({ role: 'user', content: [{ type: 'image_url', image_url: { url: url.repeat(1000) } }] })).toBe(4104);
  });
  it('includes tool_calls arguments', () => {
    expect(estimateMessageTokens({ role: 'assistant', tool_calls: [{ function: { arguments: 'abcd' } }] })).toBe(9);
  });
  it('counts providerItems replay state(encrypted reasoning 不计会低估预算→小窗口撞 overflow)', () => {
    const bare = estimateMessageTokens({ role: 'assistant', content: 'abcd' });
    const withItems = estimateMessageTokens({
      role: 'assistant', content: 'abcd',
      providerItems: [{ type: 'reasoning', encrypted_content: 'E'.repeat(400) }],
    });
    expect(withItems).toBeGreaterThan(bare + 90); // ≥ 序列化长度/4 量级
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
    expect(msgs[10].content).toContain('tool output folded');
    expect(msgs[15].content).toContain('context compacted: omitted');
  });

  it('tool fold keeps the tail(错误/测试汇总几乎都在结尾)且 assistant 折叠丢弃 providerItems', () => {
    const msgs = buildMsgs();
    const toolBody = 'H'.repeat(500) + 'MIDDLE'.repeat(100) + 'TAIL_ERROR_SUMMARY';
    (msgs[10] as any).content = toolBody;
    (msgs[15] as any).providerItems = [{ type: 'reasoning', id: 'rs', encrypted_content: 'E' }];
    compactContext(msgs);
    expect(msgs[10].content.endsWith('TAIL_ERROR_SUMMARY')).toBe(true); // 尾部保留
    expect(msgs[10].content.length).toBeLessThan(toolBody.length);
    expect((msgs[15] as any).providerItems).toBeUndefined(); // 折叠改写正文 → 原始 items 一并作废
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
    expect(out).toContain('single tool output too large');
    expect(out.startsWith('a'.repeat(4_000))).toBe(true);
    expect(out.endsWith('a'.repeat(1_500))).toBe(true);
  });
  it('caps oversize history content keeping head+tail', () => {
    const s = 'a'.repeat(200_000);
    const out = capHistoryContent(s);
    expect(out.length).toBeLessThan(s.length);
    expect(out).toContain('history message too large');
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
