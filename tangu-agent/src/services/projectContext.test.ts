/**
 * 项目上下文的写路径与识别规则:
 *   - 指令文件目标 = cwd 层首个命中的候选名,否则待建的 .tangu/AGENTS.md
 *   - init 幂等、绝不覆盖;cwd 层已有别家文件时不另放骨架
 *   - `.tangu -> 别处` 这类软链一律拒写(clone 来的仓不可信)
 *   - 改写校验 mtime(别处改过 → conflict,不落盘)
 *   - 项目技能落 .tangu/skills/<slug>/SKILL.md,同名不覆盖,加载器按 local:<slug> 看得见
 *   - 项目默认项按 realpath 索引、白名单收窄、空值即删
 *   - 项目图标:图片落 .tangu/icon.<ext>、settings.icon 指过去;换图清旧、移除连文件带指针;软链 / 超限 / 非图片拒;整份 PUT 不抹 icon
 *   - git 摘要:非仓库 repo:false;真仓库能读到分支 / 改动 / 提交(本机没有 git 时跳过)
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, symlinkSync, existsSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  assertSafeChain, createProjectSkill, deleteProjectIcon, gitSummary, initProjectWorkspace, listProjectPlans, maskRemoteUrl, parseStatusLine,
  PROJECT_DOC_TEMPLATE, readProjectIcon, readProjectSettings, resolveDocTarget, sanitizeProjectSettings, saveProjectIcon, writeProjectDoc,
  writeProjectSettings,
} from './projectContext.js';
import { listProjectSkills } from '../skills/localSkills.js';

let root: string;
const mk = (rel: string): string => { const p = path.join(root, rel); mkdirSync(p, { recursive: true }); return p; };
const w = (rel: string, body: string): string => { const p = path.join(root, rel); mkdirSync(path.dirname(p), { recursive: true }); writeFileSync(p, body, 'utf8'); return p; };

beforeAll(() => {
  root = mkdtempSync(path.join(tmpdir(), 'tangu-projctx-'));
  process.env.TANGU_HOME = mk('home'); // 项目默认项落 tanguHome(),测试整体重定向
});
afterAll(() => { rmSync(root, { recursive: true, force: true }); delete process.env.TANGU_HOME; });

describe('resolveDocTarget / init', () => {
  it('cwd 层没有任何指令文件 → 目标是待建的 .tangu/AGENTS.md;init 建目录 + 骨架,再 init 幂等且不覆盖', async () => {
    const cwd = mk('fresh');
    expect(resolveDocTarget(cwd)).toEqual({ path: path.join(cwd, '.tangu', 'AGENTS.md'), exists: false });
    const first = await initProjectWorkspace(cwd);
    expect(first).toEqual({ createdDir: true, createdDoc: true });
    expect(existsSync(path.join(cwd, '.tangu', 'skills'))).toBe(true);
    expect(readFileSync(path.join(cwd, '.tangu', 'AGENTS.md'), 'utf8')).toBe(PROJECT_DOC_TEMPLATE);
    writeFileSync(path.join(cwd, '.tangu', 'AGENTS.md'), '# mine\n');
    const second = await initProjectWorkspace(cwd);
    expect(second).toEqual({ createdDir: false, createdDoc: false });
    expect(readFileSync(path.join(cwd, '.tangu', 'AGENTS.md'), 'utf8')).toBe('# mine\n'); // 用户写的不被骨架盖掉
    expect(resolveDocTarget(cwd)).toEqual({ path: path.join(cwd, '.tangu', 'AGENTS.md'), exists: true });
  });

  it('cwd 层已有别家文件名(CLAUDE.md)→ 它就是目标;init 只建目录,不另放一份 AGENTS.md(引擎每层只读首个命中的)', async () => {
    const cwd = mk('claude');
    const claude = w('claude/CLAUDE.md', 'claude rules');
    expect(resolveDocTarget(cwd)).toEqual({ path: claude, exists: true });
    expect(await initProjectWorkspace(cwd)).toEqual({ createdDir: true, createdDoc: false });
    expect(existsSync(path.join(cwd, '.tangu', 'AGENTS.md'))).toBe(false);
  });

  it('`.tangu` 是软链 → init / 写指令文件 / 建技能全部拒绝(clone 来的仓可以自带 .tangu -> ~/.ssh)', async () => {
    const cwd = mk('linked');
    const outside = mk('outside');
    symlinkSync(outside, path.join(cwd, '.tangu'));
    await expect(initProjectWorkspace(cwd)).rejects.toThrow(/symbolic link/);
    await expect(writeProjectDoc(cwd, 'x')).rejects.toThrow(/symbolic link/);
    await expect(createProjectSkill(cwd, { slug: 'a', content: 'b' })).rejects.toThrow(/symbolic link/);
    expect(existsSync(path.join(outside, 'AGENTS.md'))).toBe(false);
  });

  it('assertSafeChain:中间段是文件也拒;不存在的段放行', async () => {
    const cwd = mk('chain');
    w('chain/.tangu', 'a file, not a dir');
    await expect(assertSafeChain(cwd, '.tangu/skills', false)).rejects.toThrow(/not a directory/);
    await expect(assertSafeChain(cwd, 'nope/deeper/file.md', true)).resolves.toBeUndefined();
  });
});

describe('writeProjectDoc', () => {
  it('新建落 .tangu/AGENTS.md;带过期 mtime 的改写返回 conflict 且不落盘;mtime 对得上才写', async () => {
    const cwd = mk('doc');
    const created = await writeProjectDoc(cwd, '# v1\n');
    expect(created.path).toBe(path.join(cwd, '.tangu', 'AGENTS.md'));
    expect(created.conflict).toBeUndefined();
    // 别处改动:把 mtime 拨到一秒后
    const later = new Date(created.mtimeMs + 5000);
    utimesSync(created.path, later, later);
    const stale = await writeProjectDoc(cwd, '# v2\n', created.mtimeMs);
    expect(stale.conflict).toBe(true);
    expect(readFileSync(created.path, 'utf8')).toBe('# v1\n');
    const fresh = await writeProjectDoc(cwd, '# v2\n', stale.mtimeMs);
    expect(fresh.conflict).toBeUndefined();
    expect(readFileSync(created.path, 'utf8')).toBe('# v2\n');
  });

  it('cwd 层已有 AGENTS.md 时就地改那份,不去 .tangu 下另建', async () => {
    const cwd = mk('rootdoc');
    const existing = w('rootdoc/AGENTS.md', 'old');
    const r = await writeProjectDoc(cwd, 'new');
    expect(r.path).toBe(existing);
    expect(readFileSync(existing, 'utf8')).toBe('new');
    expect(existsSync(path.join(cwd, '.tangu'))).toBe(false);
  });
});

describe('并发写', () => {
  it('两笔几乎同时的指令文件保存(同一个读出 mtime)→ 恰好一笔成功、另一笔 409,不会两笔都过', async () => {
    const cwd = mk('doc-race');
    const created = await writeProjectDoc(cwd, '# v1\n');
    // 两笔都拿着「读出时」的 mtime:把文件 mtime 拨到 10 秒前当作那次读出(紧挨着的两次写会落在同一毫秒里,1ms 容差分不出来 —— 真实场景里
    // 用户读出与保存之间总隔着几秒,测试要造的是这个形状,不是同毫秒双写)
    const past = new Date(created.mtimeMs - 10_000);
    utimesSync(created.path, past, past);
    const base = past.getTime();
    const [a, b] = await Promise.all([writeProjectDoc(cwd, '# from A\n', base), writeProjectDoc(cwd, '# from B\n', base)]);
    const outcomes = [a.conflict, b.conflict].map((c) => !!c).sort();
    expect(outcomes).toEqual([false, true]);
    expect(readFileSync(created.path, 'utf8')).toBe(a.conflict ? '# from B\n' : '# from A\n');
  });

  it('两个项目同时写默认项 → 两条记录都在(读-改-写串行,不互相盖掉)', async () => {
    const a = mk('race-a');
    const b = mk('race-b');
    await Promise.all([writeProjectSettings(a, { model: 'ma' }), writeProjectSettings(b, { model: 'mb' })]);
    expect(await readProjectSettings(a)).toEqual({ model: 'ma' });
    expect(await readProjectSettings(b)).toEqual({ model: 'mb' });
  });
});

describe('createProjectSkill + listProjectSkills', () => {
  it('落 .tangu/skills/<slug>/SKILL.md(frontmatter 带 name / description),加载器按 local:<slug> 看见;同名不覆盖;坏 slug 拒', async () => {
    const cwd = mk('skills');
    const info = await createProjectSkill(cwd, { slug: 'release-notes', name: 'Release notes', description: 'How we write: notes', content: 'Do it like this.' });
    expect(info).toMatchObject({ id: 'local:release-notes', name: 'Release notes', legacy: false });
    const raw = readFileSync(path.join(cwd, '.tangu', 'skills', 'release-notes', 'SKILL.md'), 'utf8');
    expect(raw).toContain('name: "Release notes"');
    expect(raw).toContain('description: "How we write: notes"');
    const found = await listProjectSkills(cwd);
    expect(found.map((f) => [f.skill.id, f.skill.name, f.skill.description, f.legacy])).toEqual([['local:release-notes', 'Release notes', 'How we write: notes', false]]);
    await expect(createProjectSkill(cwd, { slug: 'release-notes', content: 'again' })).rejects.toThrow(/EEXIST|exists/i);
    await expect(createProjectSkill(cwd, { slug: '../escape', content: 'x' })).rejects.toThrow(/folder name/);
    await expect(createProjectSkill(cwd, { slug: 'empty', content: '   ' })).rejects.toThrow(/required/);
  });

  it('旧位置 .forsion/skills 仍被列出并打 legacy 标;同 id 让 .tangu 赢', async () => {
    const cwd = mk('legacy');
    w('legacy/.forsion/skills/old/SKILL.md', '---\nname: Old\n---\nold body');
    w('legacy/.forsion/skills/both/SKILL.md', '---\nname: From forsion\n---\nx');
    w('legacy/.tangu/skills/both/SKILL.md', '---\nname: From tangu\n---\ny');
    const found = (await listProjectSkills(cwd)).sort((a, b) => a.skill.id.localeCompare(b.skill.id));
    expect(found.map((f) => [f.skill.id, f.skill.name, f.legacy])).toEqual([['local:both', 'From tangu', false], ['local:old', 'Old', true]]);
  });
});

describe('plans', () => {
  it('列 .tangu/plans/*.md,新的在前,标题取首个一级标题;非 .md / 软链跳过', async () => {
    const cwd = mk('plans');
    const a = w('plans/.tangu/plans/plan-1.md', '# First plan\n\nbody');
    const b = w('plans/.tangu/plans/plan-2.md', 'no heading here');
    w('plans/.tangu/plans/notes.txt', 'ignored');
    utimesSync(a, new Date(Date.now() - 60_000), new Date(Date.now() - 60_000));
    utimesSync(b, new Date(), new Date());
    const plans = await listProjectPlans(cwd);
    expect(plans.map((p) => [p.name, p.title])).toEqual([['plan-2.md', ''], ['plan-1.md', 'First plan']]);
    expect(await listProjectPlans(mk('noplans'))).toEqual([]);
  });
});

describe('project settings(用户侧)', () => {
  it('白名单收窄:Agent 与 Team 二选一(Agent 优先)、未知思考档 / 审批档丢弃、全无效 → null', () => {
    expect(sanitizeProjectSettings({ defaultAgent: 'coder', defaultTeam: 'squad', model: ' gpt-x ', thinkingLevel: 'ultra', approvalMode: 'full-auto', extra: 1 }))
      .toEqual({ defaultAgent: 'coder', model: 'gpt-x', approvalMode: 'full-auto' });
    expect(sanitizeProjectSettings({ defaultTeam: 'squad', thinkingLevel: 'high' })).toEqual({ defaultTeam: 'squad', thinkingLevel: 'high' });
    expect(sanitizeProjectSettings({ defaultAgent: '../x' })).toBeNull();
    expect(sanitizeProjectSettings(null)).toBeNull();
    expect(sanitizeProjectSettings([])).toBeNull();
  });

  it('按 realpath 索引读写;写 null 即删除;别的项目不受影响', async () => {
    const a = mk('settings-a');
    const b = mk('settings-b');
    expect(await readProjectSettings(a)).toBeNull();
    expect(await writeProjectSettings(a, { defaultAgent: 'coder', approvalMode: 'auto-edit' })).toEqual({ defaultAgent: 'coder', approvalMode: 'auto-edit' });
    await writeProjectSettings(b, { model: 'm1' });
    expect(await readProjectSettings(a)).toEqual({ defaultAgent: 'coder', approvalMode: 'auto-edit' });
    expect(await readProjectSettings(b)).toEqual({ model: 'm1' });
    expect(await writeProjectSettings(a, null)).toBeNull();
    expect(await readProjectSettings(a)).toBeNull();
    expect(await readProjectSettings(b)).toEqual({ model: 'm1' });
    expect(readFileSync(path.join(root, 'home', 'project-settings.json'), 'utf8')).toContain('"m1"');
  });
});

describe('project icon', () => {
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);
  it('导入图片 → .tangu/icon.png + settings.icon;换成 webp 清掉旧 png;整份 PUT 带着 icon 不被抹;移除连文件带指针', async () => {
    const cwd = mk('icon-a');
    await writeProjectSettings(cwd, { model: 'm1' });
    expect(await saveProjectIcon(cwd, `data:image/png;base64,${png.toString('base64')}`, 'image/png')).toEqual({ model: 'm1', icon: 'icon.png' });
    expect(readFileSync(path.join(cwd, '.tangu', 'icon.png'))).toEqual(png);
    expect(await readProjectIcon(cwd)).toEqual({ data: png, mimeType: 'image/png' });
    await saveProjectIcon(cwd, png.toString('base64'), 'image/webp');
    expect(existsSync(path.join(cwd, '.tangu', 'icon.png'))).toBe(false);
    expect((await readProjectSettings(cwd))?.icon).toBe('icon.webp');
    await writeProjectSettings(cwd, { ...(await readProjectSettings(cwd)), model: 'm2' });
    expect(await readProjectSettings(cwd)).toEqual({ model: 'm2', icon: 'icon.webp' });
    expect(await deleteProjectIcon(cwd)).toEqual({ model: 'm2' });
    expect(existsSync(path.join(cwd, '.tangu', 'icon.webp'))).toBe(false);
    expect(await readProjectIcon(cwd)).toBeNull();
  });

  it('emoji 只是 settings.icon 文本,读图片 → null;移除同样清掉', async () => {
    const cwd = mk('icon-emoji');
    expect(await writeProjectSettings(cwd, { icon: '🚀' })).toEqual({ icon: '🚀' });
    expect(await readProjectIcon(cwd)).toBeNull();
    expect(await deleteProjectIcon(cwd)).toBeNull();
    expect(sanitizeProjectSettings({ icon: 'x'.repeat(33) })).toBeNull();
    expect(sanitizeProjectSettings({ icon: 'a\nb' })).toBeNull();
  });

  it('`.tangu` 是软链 / 非图片 / 超 1MB → 拒;settings 指向的图片被换成软链 → 读不出', async () => {
    const linked = mk('icon-linked');
    symlinkSync(mk('icon-outside'), path.join(linked, '.tangu'));
    await expect(saveProjectIcon(linked, png.toString('base64'), 'image/png')).rejects.toThrow(/symbolic link/);
    expect(existsSync(path.join(root, 'icon-outside', 'icon.png'))).toBe(false);
    const cwd = mk('icon-b');
    await expect(saveProjectIcon(cwd, png.toString('base64'), 'image/svg+xml')).rejects.toThrow(/unsupported/);
    await expect(saveProjectIcon(cwd, Buffer.alloc(1_048_577).toString('base64'), 'image/png')).rejects.toThrow(/too large/);
    await saveProjectIcon(cwd, png.toString('base64'), 'image/png');
    rmSync(path.join(cwd, '.tangu', 'icon.png'));
    symlinkSync(w('secret.png', 'secret'), path.join(cwd, '.tangu', 'icon.png'));
    expect(await readProjectIcon(cwd)).toBeNull();
  });
});

describe('git', () => {
  it('遮盖远端地址里的凭据;status 行解析保留 XY 码', () => {
    expect(maskRemoteUrl('https://user:ghp_secret@github.com/a/b.git')).toBe('https://github.com/a/b.git');
    expect(maskRemoteUrl('git@github.com:a/b.git')).toBe('git@github.com:a/b.git');
    expect(parseStatusLine(' M src/a.ts')).toEqual({ code: ' M', path: 'src/a.ts' });
    expect(parseStatusLine('?? new.txt')).toEqual({ code: '??', path: 'new.txt' });
    expect(parseStatusLine('')).toBeNull();
  });

  it('非仓库目录 → repo:false;真仓库读到分支 / 改动计数 / 最近提交(本机无 git 时跳过)', async () => {
    let git = true;
    try { execFileSync('git', ['--version'], { stdio: 'ignore' }); } catch { git = false; }
    if (!git) return;
    const plain = mk('git-plain');
    const none = await gitSummary(plain);
    if (!none.available) return; // 引擎的 git 探测(CLT 路径 / PATH)在这台机器上找不到 git,不硬判
    expect(none.repo).toBe(false);
    const repo = mk('git-repo');
    const env = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@x', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@x' };
    const run = (...args: string[]) => execFileSync('git', ['-c', 'commit.gpgsign=false', '-C', repo, ...args], { env, stdio: 'ignore' });
    run('init', '-q', '-b', 'main');
    writeFileSync(path.join(repo, 'a.txt'), 'a');
    run('add', 'a.txt');
    run('commit', '-q', '-m', 'first commit');
    writeFileSync(path.join(repo, 'a.txt'), 'changed');
    writeFileSync(path.join(repo, 'b.txt'), 'new');
    const s = await gitSummary(repo);
    expect(s).toMatchObject({ available: true, repo: true, nested: false, branch: 'main', detached: false, upstream: null, staged: 0, unstaged: 1, untracked: 1, changesTotal: 2 });
    expect(s.commits?.[0]?.subject).toBe('first commit');
    expect(s.changes?.map((c) => c.path).sort()).toEqual(['a.txt', 'b.txt']);
    // 子目录里的项目:nested:true,分支照样读得到
    const sub = path.join(repo, 'pkg');
    mkdirSync(sub);
    expect(await gitSummary(sub)).toMatchObject({ repo: true, nested: true, branch: 'main' });
  });
});
