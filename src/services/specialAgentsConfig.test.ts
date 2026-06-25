import { describe, it, expect } from 'vitest';
import {
  normalizeConfig, isWithinActiveHours, buildTodoDedupHint, SPECIAL_AGENTS_DEFAULTS, type MuseConfig,
} from './specialAgentsConfig.js';
import { isRoundDue } from './localHistorian.js';

describe('normalizeConfig', () => {
  it('returns defaults for empty/garbage input', () => {
    expect(normalizeConfig(undefined)).toEqual(SPECIAL_AGENTS_DEFAULTS);
    expect(normalizeConfig({})).toEqual(SPECIAL_AGENTS_DEFAULTS);
    expect(normalizeConfig('nope' as any)).toEqual(SPECIAL_AGENTS_DEFAULTS);
  });
  it('defaults: both disabled, z=10(找 1-3 条 TODO 不必更多迭代), t=5', () => {
    const d = SPECIAL_AGENTS_DEFAULTS;
    expect(d.historian.enabled).toBe(false);
    expect(d.muse.enabled).toBe(false);
    expect(d.muse.maxIterationsPerCycle).toBe(10);
    expect(d.muse.maxTodosPerWindow).toBe(5);
    expect(d.historian.everyTitleRounds).toBe(3); // 标题/LOG 跟手
    expect(d.historian.everyMemoryRounds).toBe(9); // memory 整文重写稀疏化,抗侵蚀
  });
  it('clamps out-of-range numbers', () => {
    const c = normalizeConfig({
      historian: { everyTitleRounds: 0, everyMemoryRounds: 9999 },
      muse: { maxIterationsPerCycle: 100000, restartWindowHours: 99, compactAtRatio: 5, supervisorPollMinutes: 0 },
    });
    expect(c.historian.everyTitleRounds).toBe(1); // min 1
    expect(c.historian.everyMemoryRounds).toBe(100); // max 100
    expect(c.muse.maxIterationsPerCycle).toBe(500); // max 500
    expect(c.muse.restartWindowHours).toBe(24); // max 24
    expect(c.muse.compactAtRatio).toBe(0.8); // invalid ratio → default
    expect(c.muse.supervisorPollMinutes).toBe(1); // min 1
  });
  it('preserves valid values + allowedFolders filter', () => {
    const c = normalizeConfig({
      muse: { enabled: true, modelId: 'm', allowedFolders: ['/a', '', 123, '/b'] },
    });
    expect(c.muse.enabled).toBe(true);
    expect(c.muse.modelId).toBe('m');
    expect(c.muse.allowedFolders).toEqual(['/a', '/b']);
  });
});

describe('isWithinActiveHours', () => {
  const base = SPECIAL_AGENTS_DEFAULTS.muse;
  const withHours = (start: number, end: number): MuseConfig => ({ ...base, activeHours: { start, end } });
  it('null → always active', () => {
    expect(isWithinActiveHours(base, 3)).toBe(true);
  });
  it('normal range', () => {
    const c = withHours(9, 18);
    expect(isWithinActiveHours(c, 8)).toBe(false);
    expect(isWithinActiveHours(c, 9)).toBe(true);
    expect(isWithinActiveHours(c, 17)).toBe(true);
    expect(isWithinActiveHours(c, 18)).toBe(false);
  });
  it('overnight range (22→6)', () => {
    const c = withHours(22, 6);
    expect(isWithinActiveHours(c, 23)).toBe(true);
    expect(isWithinActiveHours(c, 2)).toBe(true);
    expect(isWithinActiveHours(c, 6)).toBe(false);
    expect(isWithinActiveHours(c, 12)).toBe(false);
  });
  it('start===end → all day', () => {
    expect(isWithinActiveHours(withHours(5, 5), 5)).toBe(true);
    expect(isWithinActiveHours(withHours(5, 5), 20)).toBe(true);
  });
});

describe('buildTodoDedupHint (Muse 去重提示)', () => {
  it('空清单 / 全空白标题 → 空串(不注入噪声)', () => {
    expect(buildTodoDedupHint([])).toBe('');
    expect(buildTodoDedupHint([{ title: '  ', status: 'pending' }])).toBe('');
  });
  it('pending 列入「请勿重复」, done/dismissed 列入「不要再提」', () => {
    const h = buildTodoDedupHint([
      { title: '给 muse 加单测', status: 'pending' },
      { title: '重构 X', status: 'dismissed' },
      { title: '写发布说明', status: 'done' },
    ]);
    expect(h).toContain('给 muse 加单测');
    expect(h).toMatch(/请勿重复/);
    expect(h).toContain('重构 X');
    expect(h).toContain('写发布说明');
    expect(h).toMatch(/驳回/);
  });
  it('忽略空白标题，单项不产生分隔符', () => {
    const h = buildTodoDedupHint([
      { title: '真待办', status: 'pending' },
      { title: '   ', status: 'pending' },
    ]);
    expect(h).toContain('真待办');
    expect(h.match(/；/g) || []).toHaveLength(0);
  });
});

describe('isRoundDue (Historian)', () => {
  it('first round honors firstRoundTrigger', () => {
    expect(isRoundDue(1, 3, true)).toBe(true);
    expect(isRoundDue(1, 3, false)).toBe(false);
  });
  it('every-N triggering', () => {
    expect(isRoundDue(3, 3, false)).toBe(true);
    expect(isRoundDue(6, 3, false)).toBe(true);
    expect(isRoundDue(4, 3, false)).toBe(false);
  });
  it('roundN < 1 never triggers', () => {
    expect(isRoundDue(0, 3, true)).toBe(false);
  });
});
