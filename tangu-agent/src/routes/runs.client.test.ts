/**
 * normalizeClientTag —— 客户端面标识的白名单闸(信任边界:值来自客户端,
 * 进 admin /client-stats 的 group-by 与展示,绝不能放脏东西过去)。
 */
import { describe, it, expect } from 'vitest';
import { normalizeClientTag } from './runs.js';

describe('normalizeClientTag', () => {
  it('放行三端正常形态', () => {
    expect(normalizeClientTag('desktop/2.7.4')).toBe('desktop/2.7.4');
    expect(normalizeClientTag('web/2.7.4')).toBe('web/2.7.4');
    expect(normalizeClientTag('mobile/2.7.4-beta_1')).toBe('mobile/2.7.4-beta_1');
  });

  it('拒绝脏值(空/超长/特殊字符/非字符串)', () => {
    expect(normalizeClientTag('')).toBeUndefined();
    expect(normalizeClientTag('desktop/' + 'x'.repeat(33))).toBeUndefined();
    expect(normalizeClientTag("desktop/1'; DROP TABLE agent_runs;--")).toBeUndefined();
    expect(normalizeClientTag('web/<script>')).toBeUndefined();
    expect(normalizeClientTag('带 空格/1.0')).toBeUndefined();
    expect(normalizeClientTag(42)).toBeUndefined();
    expect(normalizeClientTag(undefined)).toBeUndefined();
  });

  it('拒绝未知平台与畸形结构(高基数污染防线,非法字符之外)', () => {
    expect(normalizeClientTag('x')).toBeUndefined(); // 无平台前缀
    expect(normalizeClientTag('foo/1.0')).toBeUndefined(); // 未知平台
    expect(normalizeClientTag('desktop')).toBeUndefined(); // 缺版本段
    expect(normalizeClientTag('desktop/1.0/extra')).toBeUndefined(); // 多余层级
    expect(normalizeClientTag('cli/0.3.0')).toBe('cli/0.3.0'); // 预留平台放行
  });
});
