/**
 * 窗口自动识别层的三条不变量。**只调小**那条是核心:允许调大就等于把厂商目录里的
 * 「总窗口」当成输入预算(gpt-5 族总窗 400k、输入上限 272k),把族表刻意存的保守值顶回去。
 */
import { describe, it, expect, beforeEach } from 'vitest';
import {
  parseContextLimit,
  learnFromUpstreamError,
  learnedWindow,
  resetContextWindowStoreForTest,
} from './contextWindowStore.js';
import { modelContextWindowInfo } from './contextBudget.js';

beforeEach(() => resetContextWindowStoreForTest());

describe('parseContextLimit — 只认真实见过的措辞', () => {
  it('OpenAI:maximum context length is N tokens', () => {
    expect(
      parseContextLimit(
        "This model's maximum context length is 128000 tokens. However, your messages resulted in 130512 tokens.",
      ),
    ).toBe(128000);
  });

  it('Anthropic:N tokens > M maximum(取上限那个数,不是用量)', () => {
    expect(parseContextLimit('prompt is too long: 210000 tokens > 200000 maximum')).toBe(200000);
  });

  it('认不出就认不出(乱认才危险)', () => {
    for (const s of ['', undefined, 'rate limit exceeded', 'invalid api key', '502 Bad Gateway']) {
      expect(parseContextLimit(s as any)).toBeUndefined();
    }
  });

  it('区间外的数字不当窗口(4k–10M 之外一律不收)', () => {
    expect(parseContextLimit('maximum context length is 512 tokens')).toBeUndefined();
    expect(parseContextLimit('maximum context length is 99999999999 tokens')).toBeUndefined();
  });
});

describe('learnFromUpstreamError — 三条不变量', () => {
  const OVERFLOW = "This model's maximum context length is 200000 tokens. However, your messages resulted in 260000 tokens.";

  it('只有 400/413 才可能是「超长被拒」,别的状态里的数字不信', () => {
    expect(learnFromUpstreamError('m', 500, OVERFLOW)).toBeUndefined();
    expect(learnFromUpstreamError('m', 429, OVERFLOW)).toBeUndefined();
    expect(learnedWindow('m')).toBeUndefined();
    expect(learnFromUpstreamError('m', 400, OVERFLOW)).toBe(200000);
    expect(learnedWindow('m')).toBe(200000);
    expect(learnFromUpstreamError('m2', 413, OVERFLOW)).toBe(200000);
  });

  it('⚠️只调小不调大:后来学到更大的值不许覆盖已学到的更小值', () => {
    learnFromUpstreamError('m', 400, 'prompt is too long: 9 tokens > 32000 maximum');
    expect(learnedWindow('m')).toBe(32000);
    // 同一模型换个 key/部署报了更大的上限 —— 保留更严的那个(限得更死的那次是真撞过的)
    expect(learnFromUpstreamError('m', 400, OVERFLOW)).toBe(32000);
    expect(learnedWindow('m')).toBe(32000);
  });

  it('没有模型 id / 认不出文案 → 什么都不学', () => {
    expect(learnFromUpstreamError('', 400, OVERFLOW)).toBeUndefined();
    expect(learnFromUpstreamError('m', 400, 'something else entirely')).toBeUndefined();
    expect(learnedWindow('m')).toBeUndefined();
  });
});

describe('优先级:人说的 > 上游说的 > 我们猜的', () => {
  it('学到的值压过手写族表(族表是猜的,上游是实测的)', () => {
    expect(modelContextWindowInfo('claude-sonnet-5')).toEqual({ tokens: 1_000_000, source: 'family' });
    resetContextWindowStoreForTest({ 'claude-sonnet-5': 200_000 });
    expect(modelContextWindowInfo('claude-sonnet-5')).toEqual({ tokens: 200_000, source: 'learned' });
  });

  it('⚠️人明确填过的窗口不被学到的值推翻(admin 填的 / provider 自报的)', () => {
    resetContextWindowStoreForTest({ 'claude-sonnet-5': 200_000 });
    expect(modelContextWindowInfo('claude-sonnet-5', { context_window: 500_000 })).toEqual({
      tokens: 500_000,
      source: 'model',
    });
  });

  it('学到的值也能救族表没收录的模型(否则一直吃 128k 兜底)', () => {
    expect(modelContextWindowInfo('some-self-hosted-model').source).toBe('default');
    resetContextWindowStoreForTest({ 'some-self-hosted-model': 32_000 });
    expect(modelContextWindowInfo('some-self-hosted-model')).toEqual({ tokens: 32_000, source: 'learned' });
  });
});
