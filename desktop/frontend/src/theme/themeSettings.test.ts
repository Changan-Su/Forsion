/**
 * 主题可调参数的信任边界:theme.json 是不可信用户文件,而值最终 setProperty 进 CSS。
 * 这里钉住「什么能流进 CSS」——四种类型的值域收敛 + key 白名单。
 */
import { describe, it, expect } from 'vitest';
import { toCssValue, usableSettings, lsKeyFor } from './themeSettings';
import type { ThemeEntry, ThemeSetting } from './manifest';

const num = (over: Partial<Extract<ThemeSetting, { type: 'number' }>> = {}): ThemeSetting => ({
  key: '--gl-pct', label: 'pct', type: 'number', default: 46, min: 20, max: 90, unit: '%', ...over,
} as ThemeSetting);

const entry = (settings: unknown): ThemeEntry =>
  ({ manifest: { id: 't', settings } } as unknown as ThemeEntry);

describe('toCssValue — 值域收敛', () => {
  it('number 未设时取 default 并带单位', () => {
    expect(toCssValue(num(), null)).toBe('46%');
  });

  it('number 钳到 min/max —— 越界值不会流进 CSS', () => {
    expect(toCssValue(num(), '999')).toBe('90%');
    expect(toCssValue(num(), '-5')).toBe('20%');
  });

  it('number 收到非数字回落 default(而不是产出 "NaN%" 让整条声明失效)', () => {
    expect(toCssValue(num(), 'red; background: url(x)')).toBe('46%');
    expect(toCssValue(num(), '')).toBe('46%');
  });

  it('number 无 unit 时不拼后缀', () => {
    expect(toCssValue(num({ unit: undefined }), '30')).toBe('30');
  });

  it('select 只认自带选项,别的一律 default', () => {
    const s = {
      key: '--gl-sat', label: 's', type: 'select', default: '190%',
      options: [{ value: '150%', label: '轻' }, { value: '190%', label: '标准' }],
    } as ThemeSetting;
    expect(toCssValue(s, '150%')).toBe('150%');
    expect(toCssValue(s, '240%')).toBe('190%');
    expect(toCssValue(s, 'blur(9px)')).toBe('190%');
  });

  it('boolean 只在自带的 on/off 之间二选一', () => {
    const s = { key: '--gl-hair', label: 'h', type: 'boolean', default: true, on: '1px', off: '0px' } as ThemeSetting;
    expect(toCssValue(s, null)).toBe('1px');
    expect(toCssValue(s, 'false')).toBe('0px');
    expect(toCssValue(s, '2px solid red')).toBe('0px'); // 非 'true' 即 off,不会原样透传
  });

  it('color 必须是 #hex,否则 default', () => {
    const s = { key: '--gl-sheen', label: 'c', type: 'color', default: '#ffffff' } as ThemeSetting;
    expect(toCssValue(s, '#1c1c1c')).toBe('#1c1c1c');
    expect(toCssValue(s, 'red')).toBe('#ffffff');
    expect(toCssValue(s, 'url(http://evil/x)')).toBe('#ffffff');
  });
});

describe('usableSettings — 坏项丢弃而非拖垮整个主题', () => {
  it('key 必须是 --kebab', () => {
    expect(usableSettings(entry([num({ key: 'gl-pct' })]))).toHaveLength(0);
    expect(usableSettings(entry([num({ key: '--gl;x:1' })]))).toHaveLength(0);
    expect(usableSettings(entry([num()]))).toHaveLength(1);
  });

  it('动效 token 不许做成就地调参(动效收口:动效归宿主管)', () => {
    expect(usableSettings(entry([num({ key: '--droplet-duration', min: 0, max: 5000, default: 420, unit: 'ms' })]))).toHaveLength(0);
    expect(usableSettings(entry([num({ key: '--menu-enter-duration' })]))).toHaveLength(0);
    // 液滴的影子是样子不是动效,照留
    expect(usableSettings(entry([{ key: '--droplet-shadow', label: 's', type: 'select', default: 'none', options: [{ value: 'none', label: 'none' }] }]))).toHaveLength(1);
  });

  it('未知类型 / 缺字段丢弃,合法项照留', () => {
    expect(usableSettings(entry([
      { key: '--a', label: 'a', type: 'range', default: 1 },   // 未知类型
      { key: '--b', label: 'b', type: 'number', default: 1, min: 5, max: 2 }, // min>max
      { key: '--c', label: 'c', type: 'select', default: 'x', options: [] },  // 空选项
      { key: '--d', label: 'd', type: 'color', default: 'rebeccapurple' },    // 非 hex
      num(),
    ]))).toHaveLength(1);
  });

  it('settings 缺失 / 非数组 → 空表(老主题零改照常工作)', () => {
    expect(usableSettings(entry(undefined))).toEqual([]);
    expect(usableSettings(entry('nope'))).toEqual([]);
    expect(usableSettings(null)).toEqual([]);
  });
});

describe('lsKeyFor', () => {
  it('与插件 plugin.<id>.<key> 同构', () => {
    expect(lsKeyFor('genesis-glass', '--gl-chrome-pct')).toBe('theme.genesis-glass.--gl-chrome-pct');
  });
});
