import { describe, it, expect } from 'vitest';
import { buildActivityDigest } from './muse.js';

describe('buildActivityDigest (Muse 跨 agent 活动摘要拼装)', () => {
  it('空清单 / 全空白 → 空串(不注入噪声)', () => {
    expect(buildActivityDigest([])).toBe('');
    expect(buildActivityDigest([{ scope: 'xyra', text: '   \n ' }])).toBe('');
  });
  it('带域标头,单域截尾 ≤1200 字', () => {
    const out = buildActivityDigest([{ scope: 'xyra', text: 'x'.repeat(3000) }]);
    expect(out).toContain("[Recent activity across the user's agents");
    expect(out).toContain('--- agent:xyra ---');
    const body = out.split('--- agent:xyra ---\n')[1];
    expect(body.length).toBeLessThanOrEqual(1200);
  });
  it('总量帽 4000:装不下的域整体丢弃(不截半个域)', () => {
    const sections = ['a', 'b', 'c', 'd'].map((s) => ({ scope: s, text: 'y'.repeat(1200) }));
    const out = buildActivityDigest(sections);
    expect(out).toContain('agent:a');
    expect(out).toContain('agent:c'); // 3×1200=3600 ≤ 4000
    expect(out).not.toContain('agent:d'); // 第 4 个会到 4800 → 丢
  });
});
