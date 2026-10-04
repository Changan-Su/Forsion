/** 云端技能开关(CLOUD_SKILLS_ENABLED):关 = 只有磁盘技能;开 = 原来的「本地在前 + 云端并入」。 */
import { describe, it, expect, vi } from 'vitest';

vi.mock('../../skills/localSkills.js', () => ({
  LOCAL_SKILL_PREFIX: 'local:',
  listLocalSkills: async () => [{ id: 'local:pdf', name: 'pdf', description: 'd' }],
  getLocalSkill: async (id: string) => (id === 'local:pdf' ? { id, name: 'pdf', description: 'd', content: 'BODY' } : null),
}));
import { createLocalAssets, CLOUD_SKILLS_ENABLED } from './localAssetsBrain.js';

const cloud = () => ({
  getSkill: vi.fn(async (id: string) => ({ id, name: 'cloud', description: '', content: 'CLOUD BODY' })),
  listSkills: vi.fn(async () => [{ id: 'skill_1777233639334', name: 'cloud', description: '' }]),
  upsertUserSkill: vi.fn(async () => ({ id: 'skill_x' })),
  deleteUserSkill: vi.fn(async () => true),
  listCustomTools: async () => [],
  listForcedCustomTools: async () => [],
});

describe('createLocalAssets', () => {
  it('当前缺省:云端技能停用', () => expect(CLOUD_SKILLS_ENABLED).toBe(false));

  it('停用:云端的不列、不取、不发布,连网络都不打;本地技能照常', async () => {
    const inner = cloud();
    const assets = createLocalAssets(inner as any, false);
    expect((await assets.listSkills!()).map((s) => s.id)).toEqual(['local:pdf']);
    expect(await assets.getSkill('skill_1777233639334')).toBeNull();
    expect((await assets.getSkill('local:pdf'))?.content).toBe('BODY');
    expect(assets.upsertUserSkill).toBeUndefined();
    expect(inner.listSkills).not.toHaveBeenCalled();
    expect(inner.getSkill).not.toHaveBeenCalled();
    expect(assets.deleteUserSkill).toBe(inner.deleteUserSkill); // 清理旧副本的口子留着
  });

  it('启用:本地在前、云端并入,云端 id 原样委托', async () => {
    const inner = cloud();
    const assets = createLocalAssets(inner as any, true);
    expect((await assets.listSkills!()).map((s) => s.id)).toEqual(['local:pdf', 'skill_1777233639334']);
    expect((await assets.getSkill('skill_1777233639334'))?.content).toBe('CLOUD BODY');
    expect(assets.upsertUserSkill).toBe(inner.upsertUserSkill);
  });
});
