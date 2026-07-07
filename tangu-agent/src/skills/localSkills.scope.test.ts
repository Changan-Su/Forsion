/** 技能作用域:agent 级(agents/<slug>/skills)+ 项目级(<cwd>/.forsion/skills)加载与覆盖。
 *  独立文件 → seedBuiltinSkills 的一次性播种不污染别的用例。 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { promises as fs, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const skill = (dir: string, id: string, name: string): void => {
  mkdirSync(path.join(dir, id), { recursive: true });
  writeFileSync(path.join(dir, id, 'SKILL.md'), `---\nname: ${name}\ndescription: d\n---\nbody\n`);
};

describe('localSkills agent/project 作用域', () => {
  let home: string;
  let cwd: string;
  beforeAll(async () => {
    home = await fs.mkdtemp(path.join(os.tmpdir(), 'sk-home-'));
    cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'sk-proj-'));
    process.env.TANGU_HOME = home;
    skill(path.join(home, 'skills'), 'user-skill', 'User Skill');
    skill(path.join(home, 'agents', 'coding', 'skills'), 'agent-skill', 'Agent Skill');
    skill(path.join(cwd, '.forsion', 'skills'), 'proj-skill', 'Project Skill');
    skill(path.join(home, 'skills'), 'shared', 'From User');
    skill(path.join(home, 'agents', 'coding', 'skills'), 'shared', 'From Agent'); // 同 id
  });
  afterAll(async () => {
    await fs.rm(home, { recursive: true, force: true });
    await fs.rm(cwd, { recursive: true, force: true });
    delete process.env.TANGU_HOME;
  });

  it('无 run 上下文:只见 user,不见 agent/project(云端/无上下文行为不变)', async () => {
    const { listLocalSkills } = await import('./localSkills.js');
    const ids = (await listLocalSkills()).map((s) => s.id);
    expect(ids).toContain('local:user-skill');
    expect(ids).not.toContain('local:agent-skill');
    expect(ids).not.toContain('local:proj-skill');
  });

  it('有 agent+cwd 上下文:见 agent + project;同 id agent 覆盖 user', async () => {
    const rc = await import('../seams/runContext.js');
    const { listLocalSkills } = await import('./localSkills.js');
    rc.enterRunContext('u', 'r', 'coding', 'coding');
    rc.setRunCwd(cwd);
    const all = await listLocalSkills();
    const ids = all.map((s) => s.id);
    expect(ids).toContain('local:agent-skill');
    expect(ids).toContain('local:proj-skill');
    expect(all.find((s) => s.id === 'local:shared')?.name).toBe('From Agent');
    // coding 激活 → 包内置 agent-skills/coding/ 的默认技能也应加载(随包发布,不在 temp home)
    expect(ids).toContain('local:forsion-webapp');
  });

  it('切到别的 agent(xyra):不加载 coding 的 agent 级技能', async () => {
    const rc = await import('../seams/runContext.js');
    const { listLocalSkills } = await import('./localSkills.js');
    await rc.runWithAgentSlug('xyra', async () => {
      const ids = (await listLocalSkills()).map((s) => s.id);
      expect(ids).not.toContain('local:forsion-webapp'); // coding 专属,xyra 看不到
      expect(ids).not.toContain('local:agent-skill');
    });
  });
});
