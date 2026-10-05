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
    expect(r).toContain('Created skill "deploy-web"');
    // 带脚本 / 资料的技能要往文件夹里放文件:结果里必须有它的绝对路径和装载用的 id
    expect(r).toContain(path.join(home, 'skills', 'deploy-web'));
    expect(r).toContain('local:deploy-web');
    // 之后改正文的正路写在结果里(带上这个技能的 slug):模型建完顺手用文件工具改 SKILL.md 会多弹一次审批
    expect(r).toContain('action="update" and slug "deploy-web"');
    const raw = await fs.readFile(skillMd('deploy-web'), 'utf-8');
    expect(raw).toContain('name: Deploy Web');
    expect(raw).toContain('description: how to ship the web app');
    expect(raw).toContain('origin: agent'); // 来源标识:桌面据此打「自建」徽标(09-18)
    expect(raw).toContain('step 1');
    const { parseFrontmatter } = await import('../../skills/localSkills.js');
    expect(parseFrontmatter(raw).meta.origin).toBe('agent');
  });

  it('create refuses when the skill already exists', async () => {
    expect(await run({ action: 'create', name: 'Deploy Web', instructions: 'x' })).toContain('already exists');
  });

  it('create/update/delete refuse built-in skills (protected read-only source)', async () => {
    // 'skill-creator' is a bundled skill under the package skills/ dir.
    expect(await run({ action: 'create', name: 'skill-creator', instructions: 'x' })).toContain('built-in');
    expect(await run({ action: 'update', slug: 'skill-creator', instructions: 'x' })).toContain('built-in');
    expect(await run({ action: 'delete', slug: 'skill-creator' })).toContain('built-in');
  });

  it('cannot edit or delete an untouched package-seeded mirror', async () => {
    const source = path.join(home, 'package-source');
    await fs.mkdir(path.join(source, 'seeded-example'), { recursive: true });
    await fs.writeFile(path.join(source, 'seeded-example', 'SKILL.md'), '---\nname: Seeded example\n---\nKeep this\n');
    const { seedSkillsInto } = await import('../../skills/localSkills.js');
    await seedSkillsInto(source, path.join(home, 'skills'));
    expect(await run({ action: 'update', slug: 'seeded-example', instructions: 'overwrite' })).toContain('read-only');
    expect(await run({ action: 'delete', slug: 'seeded-example' })).toContain('read-only');
    expect(await fs.readFile(skillMd('seeded-example'), 'utf8')).toContain('Keep this');
    await fs.rm(path.join(home, 'skills', 'seeded-example'), { recursive: true });
  });

  it('update preserves name when omitted, rewrites body', async () => {
    const r = await run({ action: 'update', slug: 'deploy-web', instructions: 'new steps' });
    expect(r).toContain('Updated skill "deploy-web"');
    expect(r).toContain(path.join(home, 'skills', 'deploy-web'));
    const raw = await fs.readFile(skillMd('deploy-web'), 'utf-8');
    expect(raw).toContain('name: Deploy Web'); // preserved from existing frontmatter
    expect(raw).toContain('new steps');
  });

  it('update keeps a hand-added shared flag; create never adds one', async () => {
    await fs.mkdir(path.join(home, 'skills', 'lendable'), { recursive: true });
    await fs.writeFile(skillMd('lendable'), '---\nname: Lendable\ndescription: d\nshared: true\n---\nold body\n');
    expect(await run({ action: 'update', slug: 'lendable', instructions: 'new body' })).toContain('Updated skill');
    const raw = await fs.readFile(skillMd('lendable'), 'utf-8');
    expect(raw).toContain('shared: true');
    expect(raw).toContain('new body');
    await run({ action: 'create', name: 'Plain One', instructions: 'x' });
    expect(await fs.readFile(skillMd('plain-one'), 'utf-8')).not.toContain('shared');
    for (const slug of ['lendable', 'plain-one']) await run({ action: 'delete', slug }); // 末尾用例要看到「no user skills」
  });

  // 用户手写 / 导入的技能带着别的 frontmatter 键(版本、图标、分类、许可、嵌套的 metadata…):模型改正文时不许动它们。
  // 逐行照抄,不是「读出值再写回去」:读出来的值去了引号,写回去 `author: "A: B # C"` 成了坏 YAML、`icon: "#fff"` 成了空值(Codex 评审 10-05)。
  it('update keeps every other frontmatter line verbatim (quotes, nested blocks); origin and name stay single', async () => {
    await fs.mkdir(path.join(home, 'skills', 'imported'), { recursive: true });
    const others = ['version: 1.2.0', 'icon: "#fff"', 'author: "A: B # C"', 'category: "\\"quoted\\""', 'metadata:', '  team: docs', '  tags: [a, b]', 'license: MIT'];
    await fs.writeFile(skillMd('imported'), ['---', 'name: Imported', 'description: old d', ...others, 'origin: agent', '---', 'old body', ''].join('\n'));
    expect(await run({ action: 'update', slug: 'imported', description: 'new d', instructions: 'new body' })).toBe(`Updated skill "imported" (Imported) in ${path.join(home, 'skills', 'imported')}.`);
    const raw = await fs.readFile(skillMd('imported'), 'utf-8');
    expect(raw).toBe(['---', 'name: Imported', 'description: new d', ...others, 'origin: agent', '---', '', 'new body', ''].join('\n')); // 键的顺序也不动
    await fs.rm(path.join(home, 'skills', 'imported'), { recursive: true });
  });

  // 多行写法的 description(`>` 折叠块):没改它 → 连同缩进的续行原样留着(以前读成一个 ">" 再写回去,正文就没了);
  // 改它 → 旧的续行一起去掉,不留在别的键底下。
  it('a multi-line description survives an update that does not touch it, and is fully replaced by one that does', async () => {
    await fs.mkdir(path.join(home, 'skills', 'folded'), { recursive: true });
    await fs.writeFile(skillMd('folded'), ['---', 'name: Folded', 'description: >', '  Use when the user asks', '  for a folded thing.', 'version: 2', '---', 'old body', ''].join('\n'));
    await run({ action: 'update', slug: 'folded', instructions: 'body 2' });
    expect(await fs.readFile(skillMd('folded'), 'utf-8')).toBe(['---', 'name: Folded', 'description: >', '  Use when the user asks', '  for a folded thing.', 'version: 2', 'origin: agent', '---', '', 'body 2', ''].join('\n'));
    await run({ action: 'update', slug: 'folded', name: 'Folded two', description: 'one line now', instructions: 'body 3' });
    expect(await fs.readFile(skillMd('folded'), 'utf-8')).toBe(['---', 'name: Folded two', 'description: one line now', 'version: 2', 'origin: agent', '---', '', 'body 3', ''].join('\n'));
    await fs.rm(path.join(home, 'skills', 'folded'), { recursive: true });
  });

  // slugify 只认拉丁字母 / 数字:纯中文名推不出 slug,以前一律落到兜底值 "agent" —— 第一个中文名技能占掉它,第二个就报「已存在」;
  // 中英混合的名字只剩零碎(「CSV 排序去重」→ "csv")。名字不是纯 ASCII 就要模型自己给 slug。
  it('a name that is not plain ASCII needs an explicit slug', async () => {
    const r = await run({ action: 'create', name: '周报整理', instructions: 'x' });
    expect(r).toContain('Error: cannot derive a clear slug');
    expect(await exists(skillMd('agent'))).toBe(false);
    expect(await run({ action: 'create', name: 'CSV 排序去重', instructions: 'x' })).toContain('Error: cannot derive a clear slug');
    expect(await exists(skillMd('csv'))).toBe(false);
    expect(await run({ action: 'create', name: '周报整理', slug: 'weekly-report', instructions: 'x' })).toContain('Created skill "weekly-report" (周报整理)');
    expect(await fs.readFile(skillMd('weekly-report'), 'utf-8')).toContain('name: 周报整理');
    await fs.rm(path.join(home, 'skills', 'weekly-report'), { recursive: true });
  });

  it('rejects path-traversal slugs', async () => {
    expect(await run({ action: 'delete', slug: '../../etc/passwd' })).toContain('valid slug');
    expect(await run({ action: 'update', slug: '../x', instructions: 'y' })).toContain('valid slug');
  });

  it('requires instructions for create/update', async () => {
    expect(await run({ action: 'create', name: 'Empty', instructions: '   ' })).toContain('instructions');
  });

  // 技能文件夹里可能带着脚本和资料:删除 = 整夹移进回收目录(与设置页删技能同一处),不是直接删
  it('delete moves the whole skill folder to the trash (helper files included), not rm', async () => {
    await fs.mkdir(path.join(home, 'skills', 'deploy-web', 'scripts'), { recursive: true });
    await fs.writeFile(path.join(home, 'skills', 'deploy-web', 'scripts', 'ship.sh'), 'echo ship\n');
    const r = String(await run({ action: 'delete', slug: 'deploy-web' }));
    expect(r).toContain('Deleted skill "deploy-web"');
    expect(await exists(skillMd('deploy-web'))).toBe(false);
    const kept = (await fs.readdir(path.join(home, 'skill-trash'))).filter((n) => n.startsWith('user-global-deploy-web-'));
    expect(kept).toHaveLength(1);
    expect(r).toContain(path.join(home, 'skill-trash', kept[0]));
    expect(await fs.readFile(path.join(home, 'skill-trash', kept[0], 'scripts', 'ship.sh'), 'utf8')).toBe('echo ship\n');
    expect(await fs.readFile(path.join(home, 'skill-trash', kept[0], 'SKILL.md'), 'utf8')).toContain('new steps');
    expect(await run({ action: 'list' })).toContain('no user skills');
  });

  // 回收目录要是个软链,删除会把私有技能的全部内容挪到链接指向的地方 —— 与设置页那条路同一套检查:拒绝,技能原样留着
  it('delete refuses when the trash is a symlink; the skill stays where it is', async () => {
    await run({ action: 'create', name: 'Keep Me', instructions: 'x' });
    const elsewhere = await fs.mkdtemp(path.join(os.tmpdir(), 'tangu-elsewhere-'));
    const trash = path.join(home, 'skill-trash');
    await fs.rename(trash, `${trash}.real`);
    await fs.symlink(elsewhere, trash);
    try {
      expect(await run({ action: 'delete', slug: 'keep-me' })).toContain('Error: Skill trash is not a regular directory');
      expect(await exists(skillMd('keep-me'))).toBe(true);
      expect(await fs.readdir(elsewhere)).toEqual([]);
    } finally {
      await fs.unlink(trash);
      await fs.rename(`${trash}.real`, trash);
      await fs.rm(elsewhere, { recursive: true, force: true });
    }
    expect(await run({ action: 'delete', slug: 'keep-me' })).toContain('Deleted skill "keep-me"');
    expect(await run({ action: 'list' })).toContain('no user skills');
  });

  // 放最后:listLocalSkills 会把包内置技能播种进这个临时家目录,前面「删完为空」的断言会被撞。
  it('listLocalSkills 把 origin 带到记录上(用户级根认;包内置的没有)—— 桌面徽标的上游那一跳', async () => {
    expect(await run({ action: 'create', name: 'Origin probe', instructions: 'probe' })).toContain('Created skill');
    const { listLocalSkills, builtinSkillsDir } = await import('../../skills/localSkills.js');
    const recs = (await listLocalSkills()) as Array<{ id: string; origin?: 'agent' | null; is_builtin?: boolean; dir?: string }>;
    // 文件夹:自建的指它自己那一夹;包内置的指家目录里那份没改过的镜像(不是应用包里的原件 —— 模型会照说明去那里跑脚本),
    // 而且还是「内置」(下面 is_builtin 那条)。
    expect(recs.find((r) => r.id === 'local:origin-probe')?.dir).toBe(path.join(home, 'skills', 'origin-probe'));
    expect(recs.find((r) => r.id === 'local:skill-creator')?.dir).toBe(path.join(home, 'skills', 'skill-creator'));
    expect(recs.find((r) => r.id === 'local:skill-creator')?.dir).not.toBe(path.join(builtinSkillsDir(), 'skill-creator'));
    expect(recs.find((r) => r.id === 'local:origin-probe')?.origin).toBe('agent');
    expect(recs.find((r) => r.id === 'local:skill-creator')?.origin ?? null).toBeNull();
    // is_builtin 走的是同一条链(包内置 → 家目录里没改过的镜像不覆盖它 → 记录):桌面详情页靠它折叠内置技能(routes/assets.ts skillSummary.builtin)。
    // 镜像那一跳若把内置降成 user,折叠在生产里静默失效,而 skillSummary 的单测与台架(桩里手写 builtin)都还是绿的。
    expect(recs.find((r) => r.id === 'local:skill-creator')?.is_builtin).toBe(true);
    expect(recs.find((r) => r.id === 'local:origin-probe')?.is_builtin).toBe(false);
  });
});
