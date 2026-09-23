/** 技能目录的「其他 Agent 共享」段:有共享才多一段并放行 use_skill;不列借用方自己的;sandbox / 非 host 形态不查。 */
import { describe, it, expect, vi } from 'vitest';

const h = vi.hoisted(() => ({ hostExec: true, shared: [] as Array<Record<string, unknown>> }));
vi.mock('../seams/runtime.js', () => ({ deps: () => ({ profile: { capabilities: { hostExec: h.hostExec } }, brain: { assets: { listSkills: async () => [], getSkill: async () => null } } }) }));
vi.mock('../tools/fileWorkspace.js', () => ({ materializeSkill: async () => {} }));
vi.mock('../seams/runContext.js', () => ({ currentDisplayAgentSlug: () => 'xyra' }));
vi.mock('../skills/localSkills.js', () => ({ listSharedAgentSkills: async (exclude: string | null) => h.shared.filter((s) => s.ownerSlug !== exclude) }));
import { loadSkillLoadout } from './skillLoadout.js';

const CODING = { id: 'local:@coding/forsion-webapp', name: 'Forsion webapp', description: 'preview rules', ownerSlug: 'coding', ownerName: 'Coding' };
const MINE = { id: 'local:@xyra/mine', name: 'Mine', description: '', ownerSlug: 'xyra', ownerName: 'Arioso' };

describe('skillLoadout 共享技能段', () => {
  it('有共享技能:多一段目录 + enabledSkillIds 放行;不列自己的', async () => {
    h.hostExec = true; h.shared = [CODING, MINE];
    const r = await loadSkillLoadout('u', 'tangu', { execMode: 'host' });
    expect(r.sections).toHaveLength(1);
    expect(r.sections[0].startsWith('## Skills shared by other agents (load on demand)\n')).toBe(true);
    expect(r.sections[0]).toContain('- Forsion webapp (id: `local:@coding/forsion-webapp`, from Coding) — preview rules');
    expect(r.sections[0]).not.toContain('@xyra/mine');
    expect(r.enabledSkillIds).toContain('local:@coding/forsion-webapp');
    expect(r.enabledSkillIds).not.toContain('local:@xyra/mine');
  });
  it('负对照:没人共享 → 段与 id 都不变;sandbox / 非 host 形态不查', async () => {
    h.hostExec = true; h.shared = [];
    expect(await loadSkillLoadout('u', 'tangu', { execMode: 'host' })).toEqual({ enabledSkillIds: [], sections: [], requested: [] });
    h.shared = [CODING];
    expect((await loadSkillLoadout('u', 'tangu', { execMode: 'sandbox' })).sections).toEqual([]);
    h.hostExec = false;
    expect((await loadSkillLoadout('u', 'tangu', { execMode: 'host' })).sections).toEqual([]);
    // 用户显式配过装备(含卸空)= 就这些:借用池不塞(委派路径「卸下全部技能」靠这条成立)
    h.hostExec = true;
    const stripped = await loadSkillLoadout('u', 'tangu', { execMode: 'host', enabledSkillIds: [], skillsConfigured: true });
    expect(stripped.sections).toEqual([]);
    expect(stripped.enabledSkillIds).toEqual([]);
  });
});
