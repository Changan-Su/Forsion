import { describe, it, expect } from 'vitest';
// 桌面端自动更新的纯逻辑(无 electron 依赖,故可在 node 下单测;updater.ts 本体是事件接线,靠手测)。
import { notesToString, isNewer } from '../desktop/electron/updaterUtil.js';

describe('notesToString', () => {
  it('null/undefined → undefined', () => {
    expect(notesToString(undefined)).toBeUndefined();
    expect(notesToString(null)).toBeUndefined();
    expect(notesToString('')).toBeUndefined();
  });
  it('string passthrough', () => {
    expect(notesToString('hi')).toBe('hi');
  });
  it('array of {note} joined by blank line', () => {
    expect(notesToString([{ note: 'a' }, { note: 'b' }])).toBe('a\n\nb');
    expect(notesToString([])).toBeUndefined();
  });
});

describe('isNewer', () => {
  it('compares numeric x.y.z, remote newer → true', () => {
    expect(isNewer('1.3.1', '1.3.0')).toBe(true);
    expect(isNewer('1.3.10', '1.3.9')).toBe(true); // 数字比对,非字典序
    expect(isNewer('2.0.0', '1.9.9')).toBe(true);
    expect(isNewer('v1.4.0', '1.3.9')).toBe(true); // 容忍前导 v
  });
  it('same or older → false', () => {
    expect(isNewer('1.3.0', '1.3.0')).toBe(false);
    expect(isNewer('1.2.9', '1.3.0')).toBe(false);
  });
});
