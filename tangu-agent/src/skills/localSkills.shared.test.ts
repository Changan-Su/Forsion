/** 跨 Agent 共享技能:frontmatter `shared: true` 才借出;id 带主人;不列借用方自己的;系统 agent(Muse)不借出;
 *  用户目录同 id 覆盖包内置。独立 TANGU_HOME → ensureAgentsReady 的播种不污染别的用例。 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { promises as fs, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const skill = (dir: string, id: string, name: string, extra = ''): void => {
  mkdirSync(path.join(dir, id), { recursive: true });
  writeFileSync(path.join(dir, id, 'SKILL.md'), `---\nname: ${name}\ndescription: d-${id}\n${extra}---\n# ${name}\nbody-${id}\n`);
};

describe('listSharedAgentSkills / 共享 id 解析', () => {
  let home: string;
  beforeAll(async () => {
    home = await fs.mkdtemp(path.join(os.tmpdir(), 'sk-shared-'));
    process.env.TANGU_HOME = home;
    mkdirSync(path.join(home, 'agents', 'alpha'), { recursive: true });
    writeFileSync(path.join(home, 'agents', 'alpha', 'config.toml'), 'name = "Alpha"\n');
    skill(path.join(home, 'agents', 'alpha', 'skills'), 'pub', 'Alpha Public', 'shared: true\n');
    skill(path.join(home, 'agents', 'alpha', 'skills'), 'priv', 'Alpha Private');
    skill(path.join(home, 'agents', 'muse', 'skills'), 'muse-pub', 'Muse Public', 'shared: true\n'); // 系统 agent:不借出
    skill(path.join(home, 'agents', 'coding', 'skills'), 'web-debugging', 'My Web Debugging', 'shared: true\n'); // 用户覆盖包内置同 id
    skill(path.join(home, 'skills'), 'user-level', 'User Level', 'shared: true\n'); // 用户级写 shared 无意义
  });
  afterAll(async () => {
    await fs.rm(home, { recursive: true, force: true });
    delete process.env.TANGU_HOME;
  });

  it('只借出 shared:true;id 带主人;不列自己;Muse 不借出;用户目录覆盖包内置', async () => {
    const { listSharedAgentSkills, getLocalSkill, sharedSkillId, listLocalSkills } = await import('./localSkills.js');
    const forXyra = await listSharedAgentSkills('xyra');
    const ids = forXyra.map((s) => s.id);
    expect(ids).toContain('local:@alpha/pub');
    expect(ids).not.toContain('local:@alpha/priv');
    expect(ids).toContain('local:@coding/forsion-webapp'); // 随包出厂就开共享
    expect(ids.filter((id) => id.startsWith('local:@coding/'))).toHaveLength(5);
    expect(ids.some((id) => id.startsWith('local:@muse/'))).toBe(false);
    expect(ids.some((id) => id.includes('user-level'))).toBe(false);
    const wd = forXyra.find((s) => s.id === 'local:@coding/web-debugging');
    expect(wd?.name).toBe('My Web Debugging');
    expect(wd?.ownerName).toBe('Coding');
    expect((await listSharedAgentSkills('alpha')).map((s) => s.id)).not.toContain('local:@alpha/pub');
    expect((await getLocalSkill('local:@alpha/pub'))?.content).toContain('body-pub');
    expect(await getLocalSkill('local:@alpha/priv')).toBeNull(); // 没开共享:按 id 也拿不到
    expect(sharedSkillId('alpha', 'pub')).toBe('local:@alpha/pub');
    // 无 run 上下文的普通目录不受影响:没有共享 id 混进去
    expect((await listLocalSkills()).some((s) => s.id.startsWith('local:@'))).toBe(false);
  });
});
