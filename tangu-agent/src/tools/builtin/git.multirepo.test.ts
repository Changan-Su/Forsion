/**
 * 11-07 多仓 Git(仓根 docs/ToBeImproved/多仓Git方案_2026-11-07,方案 C):真 git、临时目录,全局配置指到空文件。
 *   - 清单:项目自己不是仓时列出里面 ≤3 层的仓;跳过 node_modules / 隐藏目录 / 第 4 层;额外文件夹按绝对路径认
 *   - git_status 不点名 → repositories 清单;点名 → 只看那个仓;认不出的 id(含清单外的绝对路径)→ unknown_repo
 *   - git_commit 带 repo 只动那个仓;子目录模式只提交项目文件夹,外面有暂存的 → staged_outside
 *   - 内嵌仓三种处理:exclude / .gitignore / 子模块(没远端 → no_remote)
 *   - 审阅页「未提交」多仓合并;git_publish 每次都问
 *
 * 负对照(11-07 各改一处实跑,对应用例红):
 *   - commitScope 去掉 staged_outside 判断 → 「子目录模式」红(外面暂存的 x.txt 被一起提交)
 *   - scanRepos 不跳 node_modules → 「清单」红
 *   - git_publish 的 approval 改成 'command' → 「git_publish 每次都问」红
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { gitApprovalPreview, gitToolsProvider } from './git.js';
import { registerToolProvider, type ToolDef } from '../toolRegistry.js';
import { toolNeedsApproval } from '../../services/approvals.js';
import { invalidateRepos, listProjectRepos, resolveRepo } from '../../services/gitRepos.js';
import { gitCommit, gitEmbedded, gitPending } from '../../services/gitActions.js';
import { gitSummary } from '../../services/projectContext.js';
import { listGitChangesMulti } from '../../services/gitChanges.js';
import type { ToolContext } from '../toolTypes.js';

let root: string;
const savedEnv = { ...process.env };
const git = (cwd: string, ...args: string[]): string => execFileSync('git', ['-C', cwd, ...args], { stdio: 'pipe', encoding: 'utf8' }).trim();
const tools = new Map<string, ToolDef>(gitToolsProvider.tools().map((t) => [t.name, t]));
const ctxOf = (cwd: string, extraRoots?: string[]): ToolContext => ({ userId: 'u1', sessionId: 's1', appId: 'tangu', execMode: 'host', cwd, projectScoped: true, projectPath: cwd, ...(extraRoots ? { extraRoots } : {}) } as ToolContext);
const run = async (name: string, cwd: string, args: Record<string, unknown> = {}, extra?: string[]): Promise<string> => {
  invalidateRepos();
  return String(await tools.get(name)!.execute(args, ctxOf(cwd, extra)));
};
const json = (out: string): any => JSON.parse(out.startsWith('Error:') ? out.slice(out.indexOf('\n') + 1) : out);

function repo(dir: string, file = 'a.txt'): string {
  mkdirSync(dir, { recursive: true });
  git(dir, 'init', '-q', '-b', 'main');
  git(dir, 'config', 'user.name', 'Tester'); git(dir, 'config', 'user.email', 't@example.com');
  writeFileSync(path.join(dir, file), 'a');
  git(dir, 'add', '.'); git(dir, 'commit', '-qm', 'base');
  return dir;
}

beforeAll(() => {
  root = realpathSync(mkdtempSync(path.join(tmpdir(), 'tangu-multirepo-')));
  const globalConfig = path.join(root, 'gitconfig');
  writeFileSync(globalConfig, '');
  const home = path.join(root, 'tangu-home'); mkdirSync(home);
  Object.assign(process.env, { GIT_CONFIG_GLOBAL: globalConfig, GIT_CONFIG_NOSYSTEM: '1', TANGU_HOME: home });
  registerToolProvider(gitToolsProvider);
});
afterAll(() => {
  process.env = savedEnv;
  rmSync(root, { recursive: true, force: true });
});

describe('多仓 Git', () => {
  it('清单:项目里 ≤3 层的仓;跳过 node_modules / 隐藏目录 / 更深的', async () => {
    const proj = path.join(root, 'ws1');
    repo(path.join(proj, 'Project', 'alpha'));
    repo(path.join(proj, 'Project', 'beta'));
    repo(path.join(proj, 'node_modules', 'dep'));
    repo(path.join(proj, '.hidden', 'x'));
    repo(path.join(proj, 'a', 'b', 'c', 'deep'));
    invalidateRepos();
    const ids = (await listProjectRepos(proj)).map((r) => r.id).sort();
    expect(ids).toEqual(['Project/alpha', 'Project/beta']);
    expect(await resolveRepo(proj, [], undefined)).toBeNull(); // 项目自己不是仓
    expect((await resolveRepo(proj, [], 'Project/alpha/'))?.name).toBe('alpha');
    expect(await resolveRepo(proj, [], '/etc')).toBeNull();
  });

  it('git_status:不点名列出里面的仓;点名只看那个;认不出 → unknown_repo', async () => {
    const proj = path.join(root, 'ws2');
    const alpha = repo(path.join(proj, 'Project', 'alpha'));
    repo(path.join(proj, 'Project', 'beta'));
    writeFileSync(path.join(alpha, 'n.txt'), 'n');
    const all = json(await run('git_status', proj));
    expect(all).toMatchObject({ action: 'status', repo: false });
    expect(all.repositories.map((r: any) => r.repo).sort()).toEqual(['Project/alpha', 'Project/beta']);
    expect(all.repositories.find((r: any) => r.repo === 'Project/alpha')).toMatchObject({ branch: 'main', changes: 1 });

    const one = json(await run('git_status', proj, { repo: 'Project/alpha' }));
    expect(one).toMatchObject({ repo: true, branch: 'main', repoInfo: { id: 'Project/alpha', name: 'alpha' } });
    expect(one.changes.files.map((f: any) => f.path)).toEqual(['n.txt']);

    for (const bad of ['Project/gamma', root, '../ws1/Project/alpha']) {
      const out = await run('git_status', proj, { repo: bad });
      expect(out.startsWith('Error:')).toBe(true);
      expect(json(out).error).toBe('unknown_repo');
    }
    const c = await run('git_commit', proj, { message: 'x', repo: '/etc' });
    expect(json(c).error).toBe('unknown_repo');
  });

  it('git_commit 带 repo 只动那个仓;不带 repo 而项目不是仓 → not_repo', async () => {
    const proj = path.join(root, 'ws3');
    const alpha = repo(path.join(proj, 'Project', 'alpha'));
    const beta = repo(path.join(proj, 'Project', 'beta'));
    writeFileSync(path.join(alpha, 'n.txt'), 'n');
    writeFileSync(path.join(beta, 'm.txt'), 'm');
    const c = json(await run('git_commit', proj, { message: 'feat: alpha only', repo: 'Project/alpha' }));
    expect(c).toMatchObject({ action: 'commit', files: 1, repoInfo: { id: 'Project/alpha' } });
    expect(git(alpha, 'log', '-1', '--format=%s')).toBe('feat: alpha only');
    expect(git(beta, 'status', '--porcelain')).toBe('?? m.txt');
    expect(json(await run('git_commit', proj, { message: 'x' })).error).toBe('not_repo');
  });

  it('子目录模式:只提交项目文件夹;仓里别处有暂存的 → staged_outside', async () => {
    const mono = repo(path.join(root, 'mono'));
    const app = path.join(mono, 'apps', 'memo');
    mkdirSync(app, { recursive: true });
    writeFileSync(path.join(app, 'keep.txt'), 'k');
    git(mono, 'add', '.'); git(mono, 'commit', '-qm', 'app');
    writeFileSync(path.join(app, 'keep.txt'), 'k2');
    writeFileSync(path.join(app, 'new.txt'), 'n');
    writeFileSync(path.join(mono, 'outside.txt'), 'o');

    const s = await gitSummary(app);
    expect(s).toMatchObject({ repo: true, nested: true, scope: 'apps/memo', changesTotal: 2 });
    const c = json(await run('git_commit', app, { message: 'feat: memo' }));
    expect(c).toMatchObject({ action: 'commit', files: 2 });
    expect(git(mono, 'show', '--name-only', '--format=', 'HEAD').split('\n').sort()).toEqual(['apps/memo/keep.txt', 'apps/memo/new.txt']);
    expect(git(mono, 'status', '--porcelain')).toBe('?? outside.txt');

    writeFileSync(path.join(mono, 'x.txt'), 'x'); git(mono, 'add', 'x.txt');
    writeFileSync(path.join(app, 'keep.txt'), 'k3');
    const out = await run('git_commit', app, { message: 'nope' });
    expect(json(out).error).toBe('staged_outside');
    expect(git(mono, 'log', '-1', '--format=%s')).toBe('feat: memo');
    expect(git(mono, 'diff', '--cached', '--name-only')).toBe('x.txt'); // 别人的暂存原样留着
  });

  it('额外文件夹:按绝对路径认,写也能写', async () => {
    const proj = path.join(root, 'ws4'); mkdirSync(proj);
    const notes = repo(path.join(root, 'notes-site'));
    writeFileSync(path.join(notes, 'p.md'), 'p');
    const all = json(await run('git_status', proj, {}, [notes]));
    expect(all.repositories).toEqual([expect.objectContaining({ repo: notes, group: 'extra' })]);
    const c = json(await run('git_commit', proj, { message: 'notes', repo: notes }, [notes]));
    expect(c.files).toBe(1);
    // 不在会话额外文件夹里的绝对路径 → 认不出
    expect(json(await run('git_commit', proj, { message: 'x', repo: notes })).error).toBe('unknown_repo');
  });

  it('内嵌仓:列出来;exclude / .gitignore / 子模块三种处理', async () => {
    const outer = repo(path.join(root, 'outer'));
    repo(path.join(outer, 'inner1'));
    repo(path.join(outer, 'inner2'));
    const inner3 = repo(path.join(outer, 'inner3'));
    const s = await gitSummary(outer);
    expect((s.embedded ?? []).sort()).toEqual(['inner1/', 'inner2/', 'inner3/']);

    await gitEmbedded(outer, 'inner1', 'exclude');
    expect(readFileSync(path.join(outer, '.git', 'info', 'exclude'), 'utf8')).toContain('/inner1/\n');
    await gitEmbedded(outer, 'inner2/', 'ignore');
    expect(readFileSync(path.join(outer, '.gitignore'), 'utf8')).toBe('/inner2/\n');
    await expect(gitEmbedded(outer, 'inner3', 'submodule')).rejects.toMatchObject({ code: 'no_remote' });
    git(inner3, 'remote', 'add', 'origin', 'https://git.example.com/me/inner3.git');
    await gitEmbedded(outer, 'inner3', 'submodule');
    expect(readFileSync(path.join(outer, '.gitmodules'), 'utf8')).toContain('url = https://git.example.com/me/inner3.git');
    await expect(gitEmbedded(outer, 'a.txt', 'ignore')).rejects.toMatchObject({ code: 'not_embedded' });
    await expect(gitEmbedded(outer, '../x', 'ignore')).rejects.toMatchObject({ code: 'not_embedded' });
    expect((await gitSummary(outer)).embedded ?? []).toEqual([]);
  });

  it('审阅页「未提交」:多个仓合成一张清单,标出各仓的基准目录', async () => {
    const proj = path.join(root, 'ws5');
    const alpha = repo(path.join(proj, 'Project', 'alpha'));
    const beta = repo(path.join(proj, 'Project', 'beta'));
    writeFileSync(path.join(alpha, 'n.txt'), 'n');
    writeFileSync(path.join(beta, 'a.txt'), 'changed');
    invalidateRepos();
    const repos = (await listProjectRepos(proj)).map((r) => ({ ...r, dir: r.root }));
    const all = await listGitChangesMulti(proj, repos, { diff: true });
    expect(all.available).toBe(true);
    expect(all.files.map((f) => f.path).sort()).toEqual([path.join(alpha, 'n.txt'), path.join(beta, 'a.txt')]);
    expect(all.repos!.map((r) => r.dir).sort()).toEqual([alpha, beta]);
    const one = await listGitChangesMulti(proj, repos, { path: path.join(beta, 'a.txt') });
    expect(one.files.map((f) => f.path)).toEqual([path.join(beta, 'a.txt')]);
  });

  it('git_publish 每次都问;审批说明写明是哪个仓', async () => {
    for (const mode of ['readonly', 'auto-edit', 'full-auto'] as const) expect(toolNeedsApproval('git_publish', mode)).toBe(true);
    expect(tools.get('git_publish')!.capabilities).toMatchObject({ approval: 'always' });
    const proj = path.join(root, 'ws6');
    const alpha = repo(path.join(proj, 'Project', 'alpha'));
    writeFileSync(path.join(alpha, 'c.txt'), 'c');
    invalidateRepos();
    const preview = await gitApprovalPreview('git_commit', { message: 'feat: c', repo: 'Project/alpha' }, proj);
    expect(preview).toMatch(/^repository alpha \(Project\/alpha\)\ncommit to main\nfeat: c\n1 file:/);
    expect(await gitApprovalPreview('git_publish', { repo: 'Project/alpha' }, proj)).toContain('publish main to Forsion Git as a new private repository "alpha"');
  });

  it('评审修补:带空格的内嵌仓认得出、照字面写忽略规则、不跟链接写到仓外', async () => {
    const outer = repo(path.join(root, 'outer2'));
    repo(path.join(outer, 'My Repo'));
    repo(path.join(outer, 'lib[1]'));
    mkdirSync(path.join(outer, 'lib1')); writeFileSync(path.join(outer, 'lib1', 'keep.txt'), 'k');
    expect(((await gitSummary(outer)).embedded ?? []).sort()).toEqual(['My Repo/', 'lib[1]/']);
    await gitEmbedded(outer, 'lib[1]', 'ignore');
    expect(readFileSync(path.join(outer, '.gitignore'), 'utf8')).toBe('/lib\\[1\\]/\n');
    const st = git(outer, 'status', '--porcelain', '-uall');
    expect(st).toContain('lib1/keep.txt'); // 没被误伤
    expect(st).not.toContain('lib[1]');
    const victim = path.join(root, 'victim.txt'); writeFileSync(victim, 'v\n');
    const outer3 = repo(path.join(root, 'outer3'));
    repo(path.join(outer3, 'inner'));
    symlinkSync(victim, path.join(outer3, '.gitignore'));
    await expect(gitEmbedded(outer3, 'inner', 'ignore')).rejects.toMatchObject({ code: 'git_failed' });
    expect(readFileSync(victim, 'utf8')).toBe('v\n');
  });

  it('评审修补:注册成子模块后能提交;地址里的口令不进 .gitmodules', async () => {
    const outer = repo(path.join(root, 'outer4'));
    const inner = repo(path.join(outer, 'inner'));
    git(inner, 'remote', 'add', 'origin', 'https://SECRET_TOKEN@git.example.com/me/inner.git');
    await gitEmbedded(outer, 'inner', 'submodule');
    const mods = readFileSync(path.join(outer, '.gitmodules'), 'utf8');
    expect(mods).toContain('url = https://git.example.com/me/inner.git');
    expect(mods).not.toContain('SECRET');
    const pending = await gitPending(outer);
    const c = await gitCommit(outer, 'chore: register inner as submodule', undefined, pending.token);
    expect(c.subject).toBe('chore: register inner as submodule');
    git(inner, 'remote', 'set-url', 'origin', 'https://git.example.com/me/inner.git?access_token=SECRET');
    const outer5 = repo(path.join(root, 'outer5'));
    const inner5 = repo(path.join(outer5, 'inner'));
    git(inner5, 'remote', 'add', 'origin', 'https://git.example.com/me/inner.git?access_token=SECRET');
    const err: any = await gitEmbedded(outer5, 'inner', 'submodule').catch((e) => e);
    expect(err.code).toBe('no_remote');
    expect(String(err.info ?? '')).not.toContain('SECRET');
  });

  it('评审修补:子目录模式被拒时退回本文件夹的暂存、别处的暂存原样;推送说明写明是整个分支', async () => {
    const mono = repo(path.join(root, 'mono2'));
    const app = path.join(mono, 'apps', 'memo'); mkdirSync(app, { recursive: true });
    writeFileSync(path.join(app, 'k.txt'), 'k'); git(mono, 'add', '.'); git(mono, 'commit', '-qm', 'app');
    writeFileSync(path.join(app, '.env'), 'TOKEN=1'); // 凭据文件 → 暂存后被 assertStagedSafe 拒,触发退回
    // 我们暂存了 apps/memo 之后被拒 → 退回暂存;用的是带路径的 reset(只动本文件夹)
    let pending = await gitPending(mono, undefined, 'apps/memo');
    await expect(gitCommit(mono, 'x', undefined, pending.token, undefined, 'apps/memo')).rejects.toMatchObject({ code: 'credential_files' });
    expect(git(mono, 'diff', '--cached', '--name-only')).toBe('');
    // 仓里别处已有暂存 → 一开始就拒,别人的暂存原样
    writeFileSync(path.join(mono, 'other.txt'), 'o'); git(mono, 'add', 'other.txt');
    await expect(gitPending(mono, undefined, 'apps/memo')).rejects.toMatchObject({ code: 'staged_outside' });
    await expect(gitCommit(mono, 'x', undefined, pending.token, undefined, 'apps/memo')).rejects.toMatchObject({ code: 'staged_outside' });
    expect(git(mono, 'diff', '--cached', '--name-only')).toBe('other.txt');
    invalidateRepos();
    const preview = await gitApprovalPreview('git_push', {}, app);
    expect(preview).toMatch(/^repository mono2: the whole branch, not just this project's folder apps\/memo\n/);
  });
});
