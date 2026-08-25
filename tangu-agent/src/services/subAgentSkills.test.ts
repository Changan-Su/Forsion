/** 具名子代理的技能装载(08-24 引擎原生路 P0):delegate(agentSlug) 此前不装载目标 agent 的
 *  技能目录 → 委派 bluebird 看不到 bluebird-video。回归防线:装载须按该 agent 的 ALS 身份圈
 *  作用域(agents/<slug>/skills 可见),且 runWithAgentSlug 的记忆/展示双作用域可分开给。 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { promises as fs, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const skill = (dir: string, id: string, name: string): void => {
  mkdirSync(path.join(dir, id), { recursive: true });
  writeFileSync(path.join(dir, id, 'SKILL.md'), `---\nname: ${name}\ndescription: d\n---\nbody\n`);
};

describe('loadSubAgentSkills(具名子代理技能面)', () => {
  let home: string;
  beforeAll(async () => {
    home = await fs.mkdtemp(path.join(os.tmpdir(), 'subskill-home-'));
    process.env.TANGU_HOME = home;
    skill(path.join(home, 'agents', 'bluebird', 'skills'), 'bb-video', 'BB Video');
    const { configureTangu } = await import('../seams/runtime.js');
    const { createTanguProfile } = await import('../profiles/index.js');
    const { listLocalSkills, getLocalSkill } = await import('../skills/localSkills.js');
    configureTangu({
      host: {} as any,
      brain: { assets: { listSkills: () => listLocalSkills(), getSkill: (id: string) => getLocalSkill(id) } } as any,
      billing: {} as any,
      profile: createTanguProfile({ sandboxMode: 'none' }),
    });
  });
  afterAll(async () => {
    await fs.rm(home, { recursive: true, force: true });
    delete process.env.TANGU_HOME;
  });

  it('按目标 agent 身份装载:agent 级技能进 enabledSkillIds 与目录段', async () => {
    const { loadSubAgentSkills } = await import('./subAgent.js');
    const out = await loadSubAgentSkills('bluebird', { userId: 'u', appId: 'tangu', execMode: 'host' } as any);
    expect(out).not.toBeNull();
    expect(out!.enabledSkillIds).toContain('local:bb-video');
    expect(out!.sections.join('\n')).toContain('bb-video');
  });

  it('无该 agent 作用域(别的 slug)则看不到它的技能', async () => {
    const { loadSubAgentSkills } = await import('./subAgent.js');
    const out = await loadSubAgentSkills('someone-else', { userId: 'u', appId: 'tangu', execMode: 'host' } as any);
    expect(out!.enabledSkillIds).not.toContain('local:bb-video');
  });

  it('runWithAgentSlug 第三参:记忆作用域与展示/技能身份可分开', async () => {
    const rc = await import('../seams/runContext.js');
    await rc.runWithAgentSlug('DEFAULT', async () => {
      expect(rc.currentAgentSlug()).toBe('DEFAULT');
      expect(rc.currentDisplayAgentSlug()).toBe('bluebird');
    }, 'bluebird');
    // 缺省仍然同值(既有调用方语义不变)
    await rc.runWithAgentSlug('muse', async () => {
      expect(rc.currentDisplayAgentSlug()).toBe('muse');
    });
  });
});
