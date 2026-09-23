/**
 * GET /agent/skills 的 origin 透传:桌面「自建」徽标只认这一键(localSkills.toRecord → 这里 → SkillInfo.origin)。
 * 少了这一行,引擎/桌面全套测试与 check:agentprofile(桩里手写 origin)都还是绿的 —— 所以单独钉住。
 */
import { describe, it, expect } from 'vitest';
import { skillSummary } from './assets.js';

describe('skillSummary', () => {
  it('透传 origin:agent;其余(没有 / 伪造成别的值)归 null', () => {
    expect(skillSummary({ id: 'local:a', name: 'A', origin: 'agent', source: 'local' })).toMatchObject({ id: 'local:a', origin: 'agent', source: 'local', description: '', icon: null, category: null });
    expect(skillSummary({ id: 'local:b', name: 'B', source: 'local' }).origin).toBeNull();
    expect(skillSummary({ id: 'cloud:c', name: 'C', origin: 'user' }).origin).toBeNull();
    expect(skillSummary({ id: 'cloud:c', name: 'C' }).source).toBe('cloud');
  });

  it('透传 builtin:只认 is_builtin === true(桌面据此折叠内置技能;category 各写各的,不能当判据)', () => {
    expect(skillSummary({ id: 'local:a', name: 'A', is_builtin: true, category: '写作' }).builtin).toBe(true);
    expect(skillSummary({ id: 'local:b', name: 'B', is_builtin: false, category: 'built-in' }).builtin).toBe(false);
    expect(skillSummary({ id: 'local:c', name: 'C' }).builtin).toBe(false);
  });

  it('共享徽标只在 Agent 技能显式 shared=true 时出现', () => {
    expect(skillSummary({ id: 'local:@coding/pub', name: 'Pub', shared: true }).shared).toBe(true);
    expect(skillSummary({ id: 'local:private', name: 'Private' }).shared).toBe(false);
  });
});
