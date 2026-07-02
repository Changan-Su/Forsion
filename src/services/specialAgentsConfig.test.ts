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
    expect(d.historian.everyRounds).toBe(3); // 周期合一:标题+LOG/memory 同一节奏
  });
  it('clamps out-of-range numbers', () => {
    const c = normalizeConfig({
      historian: { everyRounds: 0 },
      muse: { maxIterationsPerCycle: 100000, restartWindowHours: 99, compactAtRatio: 5, supervisorPollMinutes: 0 },
    });
    expect(c.historian.everyRounds).toBe(1); // min 1
    expect(normalizeConfig({ historian: { everyRounds: 9999 } }).historian.everyRounds).toBe(100); // max 100
    expect(c.muse.maxIterationsPerCycle).toBe(500); // max 500
    expect(c.muse.restartWindowHours).toBe(24); // max 24
    expect(c.muse.supervisorPollMinutes).toBe(1); // min 1
  });
  it('旧双周期兼容:无 everyRounds 时沿用 everyTitleRounds;两者都有则 everyRounds 优先', () => {
    expect(normalizeConfig({ historian: { everyTitleRounds: 5, everyMemoryRounds: 9 } }).historian.everyRounds).toBe(5);
    expect(normalizeConfig({ historian: { everyRounds: 4, everyTitleRounds: 5 } }).historian.everyRounds).toBe(4);
    expect((normalizeConfig({ historian: { everyTitleRounds: 5 } }).historian as any).everyTitleRounds).toBeUndefined();
  });
  it('旧字段(muse.prompt / compactAtRatio)被静默丢弃(人格已迁入 agents/muse/ 文件夹)', () => {
    const c = normalizeConfig({ muse: { prompt: 'custom', compactAtRatio: 0.5, enabled: true, modelId: 'm' } });
    expect((c.muse as any).prompt).toBeUndefined();
    expect((c.muse as any).compactAtRatio).toBeUndefined();
    expect(c.muse.enabled).toBe(true); // 其余字段照常
  });
  it('historian.mode:缺省/非法 → independent,assist 保留', () => {
    expect(normalizeConfig(undefined).historian.mode).toBe('independent');
    expect(normalizeConfig({ historian: { mode: 'assist' } }).historian.mode).toBe('assist');
    expect(normalizeConfig({ historian: { mode: 'weird' } }).historian.mode).toBe('independent');
    expect(normalizeConfig({ historian: { mode: 42 } }).historian.mode).toBe('independent');
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
    expect(h).toMatch(/do not resubmit/);
    expect(h).toContain('重构 X');
    expect(h).toContain('写发布说明');
    expect(h).toMatch(/dismissed/);
  });
  it('忽略空白标题，单项不产生分隔符', () => {
    const h = buildTodoDedupHint([
      { title: '真待办', status: 'pending' },
      { title: '   ', status: 'pending' },
    ]);
    expect(h).toContain('真待办');
    expect(h.match(/; /g) || []).toHaveLength(0);
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
