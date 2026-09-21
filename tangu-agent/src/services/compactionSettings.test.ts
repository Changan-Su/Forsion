import { describe, it, expect, beforeEach } from 'vitest';
import { DEFAULT_COMPACTION_SETTINGS, normalizeCompactionLayer, resolveCompactionSettings, globalCompactionLayer, updateGlobalCompaction, resetGlobalCompactionForTest } from './compactionSettings.js';

describe('compactionSettings — 三层取值 + 逐字段归一化', () => {
  it('缺省值与 pi 对齐(reserve 16384 / keepRecent 20000),thinking 缺省 off 保持改前 wire', () => {
    expect(DEFAULT_COMPACTION_SETTINGS).toEqual({ enabled: true, reserveTokens: 16_384, thresholdPercent: 95, keepRecentTokens: 20_000, summaryMaxTokens: 6_144, thinking: 'off' });
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
  it('thresholdPercent 钳在 10–95、取整;非数丢弃', () => {
    expect(normalizeCompactionLayer({ thresholdPercent: 3 })).toEqual({ thresholdPercent: 10 });
    expect(normalizeCompactionLayer({ thresholdPercent: '30.7' })).toEqual({ thresholdPercent: 30 });
    expect(normalizeCompactionLayer({ thresholdPercent: 100 })).toEqual({ thresholdPercent: 95 });
    expect(normalizeCompactionLayer({ thresholdPercent: 'half' })).toEqual({});
  });
});

describe('updateGlobalCompaction — 设置页写口(内存接缝,不碰真 config.json)', () => {
  beforeEach(() => resetGlobalCompactionForTest({ instructions: 'keep ticket ids', handwritten: 1 }));

  it('逐键合并:设值经 normalize、null 删键、段里别的键原样保留', () => {
    expect(updateGlobalCompaction({ thresholdPercent: 30 })).toEqual({ instructions: 'keep ticket ids', thresholdPercent: 30 });
    expect(globalCompactionLayer()).toEqual({ instructions: 'keep ticket ids', handwritten: 1, thresholdPercent: 30 });
    expect(resolveCompactionSettings(undefined, globalCompactionLayer()).thresholdPercent).toBe(30);
    expect(updateGlobalCompaction({ thresholdPercent: null })).toEqual({ instructions: 'keep ticket ids' });
    expect(resolveCompactionSettings(undefined, globalCompactionLayer()).thresholdPercent).toBe(95);
  });
  it('不认识的键 / 类型不对 → 抛错且什么都不写', () => {
    expect(() => updateGlobalCompaction({ thresholdPercent: 40, nope: 1 })).toThrow(/compaction\.nope/);
    expect(() => updateGlobalCompaction({ thresholdPercent: 'half' })).toThrow(/thresholdPercent/);
    expect(globalCompactionLayer()).toEqual({ instructions: 'keep ticket ids', handwritten: 1 });
  });
});
