import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { manageSkillProvider } from './manageSkill.js';

const tool = manageSkillProvider.tools()[0];
const run = (args: Record<string, any>) => tool.execute(args, {} as any);

let home: string;
const skillMd = (slug: string) => path.join(home, 'skills', slug, 'SKILL.md');
const exists = (p: string) => fs.access(p).then(() => true, () => false);

beforeAll(async () => {
  home = await fs.mkdtemp(path.join(os.tmpdir(), 'tangu-skill-'));
  process.env.TANGU_HOME = home;
});
afterAll(async () => {
  delete process.env.TANGU_HOME;
  await fs.rm(home, { recursive: true, force: true });
});

describe('manage_skill', () => {
  it('create writes SKILL.md (slug from name, frontmatter + body)', async () => {
    const r = await run({ action: 'create', name: 'Deploy Web', description: 'how to ship the web app', instructions: 'step 1\nstep 2' });
    expect(r).toContain('已创建');
    const raw = await fs.readFile(skillMd('deploy-web'), 'utf-8');
    expect(raw).toContain('name: Deploy Web');
    expect(raw).toContain('description: how to ship the web app');
    expect(raw).toContain('origin: agent'); // 来源标识:桌面据此打「自建」徽标(09-18)
    expect(raw).toContain('step 1');
    const { parseFrontmatter } = await import('../../skills/localSkills.js');
    expect(parseFrontmatter(raw).meta.origin).toBe('agent');
  });

  it('create refuses when the skill already exists', async () => {
    expect(await run({ action: 'create', name: 'Deploy Web', instructions: 'x' })).toContain('已存在');
  });

  it('create/update/delete refuse built-in skills (protected read-only source)', async () => {
    // 'skill-creator' is a bundled skill under the package skills/ dir.
    expect(await run({ action: 'create', name: 'skill-creator', instructions: 'x' })).toContain('内置');
    expect(await run({ action: 'update', slug: 'skill-creator', instructions: 'x' })).toContain('内置');
    expect(await run({ action: 'delete', slug: 'skill-creator' })).toContain('内置');
  });

  it('update preserves name when omitted, rewrites body', async () => {
    const r = await run({ action: 'update', slug: 'deploy-web', instructions: 'new steps' });
    expect(r).toContain('已更新');
    const raw = await fs.readFile(skillMd('deploy-web'), 'utf-8');
    expect(raw).toContain('name: Deploy Web'); // preserved from existing frontmatter
    expect(raw).toContain('new steps');
  });

  it('rejects path-traversal slugs', async () => {
    expect(await run({ action: 'delete', slug: '../../etc/passwd' })).toContain('合法 slug');
    expect(await run({ action: 'update', slug: '../x', instructions: 'y' })).toContain('合法 slug');
  });

  it('requires instructions for create/update', async () => {
    expect(await run({ action: 'create', name: 'Empty', instructions: '   ' })).toContain('instructions');
  });

  it('delete removes the skill', async () => {
    expect(await run({ action: 'delete', slug: 'deploy-web' })).toContain('已删除');
    expect(await exists(skillMd('deploy-web'))).toBe(false);
    expect(await run({ action: 'list' })).toContain('no user skills');
  });

  // 放最后:listLocalSkills 会把包内置技能播种进这个临时家目录,前面「删完为空」的断言会被撞。
  it('listLocalSkills 把 origin 带到记录上(用户级根认;包内置的没有)—— 桌面徽标的上游那一跳', async () => {
    expect(await run({ action: 'create', name: 'Origin probe', instructions: 'probe' })).toContain('已创建');
    const { listLocalSkills } = await import('../../skills/localSkills.js');
    const recs = (await listLocalSkills()) as Array<{ id: string; origin?: 'agent' | null }>;
    expect(recs.find((r) => r.id === 'local:origin-probe')?.origin).toBe('agent');
    expect(recs.find((r) => r.id === 'local:skill-creator')?.origin ?? null).toBeNull();
  });
});
