import { describe, it, expect } from 'vitest';
import { DEFAULT_COMPACTION_SETTINGS, normalizeCompactionLayer, resolveCompactionSettings } from './compactionSettings.js';

describe('compactionSettings — 三层取值 + 逐字段归一化', () => {
  it('缺省值与 pi 对齐(reserve 16384 / keepRecent 20000),thinking 缺省 off 保持改前 wire', () => {
    expect(DEFAULT_COMPACTION_SETTINGS).toEqual({ enabled: true, reserveTokens: 16_384, keepRecentTokens: 20_000, summaryMaxTokens: 6_144, thinking: 'off' });
    expect(resolveCompactionSettings()).toEqual(DEFAULT_COMPACTION_SETTINGS);
  });
  it('非法字段各自丢弃而不是整层作废;数值钳区间;文本裁长', () => {
    expect(normalizeCompactionLayer({ enabled: 'yes', reserveTokens: '1', keepRecentTokens: -5, summaryMaxTokens: 1e9, thinking: 'ultra', model: '  x  ', prompt: 'p'.repeat(5000) }))
      .toEqual({ reserveTokens: 2_048, keepRecentTokens: 0, summaryMaxTokens: 32_000, model: 'x', prompt: 'p'.repeat(4000) });
    expect(normalizeCompactionLayer(null)).toEqual({});
    expect(normalizeCompactionLayer('nope')).toEqual({});
    expect(normalizeCompactionLayer({ thinking: 'inherit', enabled: false })).toEqual({ thinking: 'inherit', enabled: false });
  });
  it('前一层压过后一层,缺的字段透传下一层', () => {
    const s = resolveCompactionSettings({ reserveTokens: 30_000 }, { reserveTokens: 8_000, instructions: 'global focus', enabled: false });
    expect(s.reserveTokens).toBe(30_000);
    expect(s.instructions).toBe('global focus');
    expect(s.enabled).toBe(false);
    expect(s.keepRecentTokens).toBe(20_000);
  });
});
