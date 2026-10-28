/**
 * git_status / git_commit / git_push / git_pull(真 git,临时目录;全局 git 配置指到空文件,不读本机的;远端是本地裸仓):
 *   - 只在属于本机项目的会话里出现(projectScoped + cwd)
 *   - status 回 JSON:分支、改动清单、远端(标出推送去向);commit 提交全部改动并回 sha / 文件数;push 推到去向、带 remote 只推这一次;
 *     失败以 `Error:` 开头、第二行是带机器码的 JSON(桌面卡据此本地化)
 *   - 审批档(10-28 用户定「有权限就直接做」):status 不问;commit 同写文件;push / pull 同跑命令;完全通行全放行
 *   - 审批说明写出提交哪些文件、推到哪个远端
 *
 * 负对照(10-28 各改一处实跑,对应用例红):
 *   - approvals.toolNeedsApproval 的 writesFiles 去掉 git_commit → 「审批档」红(只读档不问提交)
 *   - git_push 的 capabilities.approval 改成 'always' → 同一条红(完全通行也问)
 *   - git_push 带 remote 时不传 { once: true } → 「只推这一次」红(上游被改成 backup)
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { gitApprovalPreview, gitToolsProvider } from './git.js';
import { registerToolProvider, type ToolDef } from '../toolRegistry.js';
import { toolNeedsApproval } from '../../services/approvals.js';
import type { ToolContext } from '../toolTypes.js';

let root: string;
const savedEnv = { ...process.env };
const git = (cwd: string, ...args: string[]): string => execFileSync('git', ['-C', cwd, ...args], { stdio: 'pipe', encoding: 'utf8' }).trim();
const tools = new Map<string, ToolDef>(gitToolsProvider.tools().map((t) => [t.name, t]));
const ctxOf = (cwd: string): ToolContext => ({ userId: 'u1', sessionId: 's1', appId: 'tangu', execMode: 'host', cwd, projectScoped: true, projectPath: cwd } as ToolContext);
const run = async (name: string, cwd: string, args: Record<string, unknown> = {}): Promise<string> => String(await tools.get(name)!.execute(args, ctxOf(cwd)));
const json = (out: string): any => JSON.parse(out.startsWith('Error:') ? out.slice(out.indexOf('\n') + 1) : out);

function project(name: string, opts: { remote?: boolean } = {}): { cwd: string; remote: string } {
  const cwd = path.join(root, name);
  const remote = path.join(root, `${name}.git`);
  mkdirSync(cwd, { recursive: true });
  git(cwd, 'init', '-q', '-b', 'main');
  git(cwd, 'config', 'user.name', 'Tester'); git(cwd, 'config', 'user.email', 't@example.com');
  writeFileSync(path.join(cwd, 'a.txt'), 'a');
  git(cwd, 'add', '.'); git(cwd, 'commit', '-qm', 'base');
  if (opts.remote !== false) {
    execFileSync('git', ['init', '-q', '--bare', remote]);
    git(cwd, 'remote', 'add', 'origin', remote);
    git(cwd, 'push', '-q', '-u', 'origin', 'main');
  }
  return { cwd, remote };
}

beforeAll(() => {
  root = mkdtempSync(path.join(tmpdir(), 'tangu-gittools-'));
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

describe('git 工具', () => {
  it('只在属于本机项目的会话里出现', () => {
    const t = tools.get('git_status')!;
    expect(t.mode).toBe('host');
    expect(t.isEnabledFor!({} as never, { ...ctxOf('/tmp'), projectScoped: undefined, projectPath: undefined })).toBe(false);
    expect(t.isEnabledFor!({} as never, ctxOf('/tmp'))).toBe(true);
  });

  it('status → 分支、改动、远端与推送去向', async () => {
    const { cwd } = project('status');
    writeFileSync(path.join(cwd, 'a.txt'), 'changed');
    writeFileSync(path.join(cwd, 'new.txt'), 'n');
    const s = json(await run('git_status', cwd));
    expect(s).toMatchObject({ action: 'status', repo: true, branch: 'main', upstream: 'origin/main', ahead: 0, pushTarget: 'origin' });
    expect(s.changes.total).toBe(2);
    expect(s.changes.files.map((f: any) => f.path).sort()).toEqual(['a.txt', 'new.txt']);
    expect(s.remotes).toEqual([expect.objectContaining({ name: 'origin', pushTarget: true, account: "this computer's own git credentials" })]);
    expect(s.recentCommits[0].subject).toBe('base');
  });

  it('不是仓库 → repo:false 带说明,不报错', async () => {
    const cwd = path.join(root, 'plain'); mkdirSync(cwd);
    const out = await run('git_status', cwd);
    expect(out.startsWith('Error')).toBe(false);
    expect(json(out)).toMatchObject({ repo: false });
  });

  it('commit → 提交全部改动,回 sha 与文件数', async () => {
    const { cwd } = project('commit');
    writeFileSync(path.join(cwd, 'a.txt'), 'changed');
    writeFileSync(path.join(cwd, 'b.txt'), 'b');
    const c = json(await run('git_commit', cwd, { message: 'feat: two files\n\nbody line' }));
    expect(c).toMatchObject({ action: 'commit', subject: 'feat: two files', branch: 'main', files: 2, author: 'Tester <t@example.com>' });
    expect(git(cwd, 'rev-parse', 'HEAD')).toBe(c.sha);
    expect(git(cwd, 'status', '--porcelain')).toBe('');
    const again = await run('git_commit', cwd, { message: 'nothing' });
    expect(again.startsWith('Error:')).toBe(true);
    expect(json(again)).toMatchObject({ action: 'commit', error: 'nothing_to_commit' });
  });

  it('push → 推到去向并回推了几个提交;带 remote 只推这一次', async () => {
    const { cwd, remote } = project('push');
    writeFileSync(path.join(cwd, 'b.txt'), 'b');
    git(cwd, 'add', '.'); git(cwd, 'commit', '-qm', 'second');
    const p = json(await run('git_push', cwd));
    expect(p).toMatchObject({ action: 'push', remote: 'origin', branch: 'main', target: 'origin/main', commits: 1 });
    expect(git(remote, 'log', '-1', '--format=%s', 'main')).toBe('second');

    const backup = path.join(root, 'push-backup.git');
    execFileSync('git', ['init', '-q', '--bare', backup]);
    git(cwd, 'remote', 'add', 'backup', backup);
    expect(json(await run('git_push', cwd, { remote: 'backup' }))).toMatchObject({ action: 'push', remote: 'backup', target: 'backup/main' });
    expect(git(backup, 'log', '-1', '--format=%s', 'main')).toBe('second');
    expect(git(cwd, 'rev-parse', '--abbrev-ref', '@{u}')).toBe('origin/main'); // 去向没被改
  });

  it('push 失败 → Error: 开头 + 带机器码的 JSON', async () => {
    const { cwd } = project('noremote', { remote: false });
    const out = await run('git_push', cwd);
    expect(out.startsWith('Error:')).toBe(true);
    expect(json(out)).toMatchObject({ action: 'push', error: 'no_remote' });
  });

  it('pull → 已一致时 updated:false', async () => {
    const { cwd } = project('pull');
    expect(json(await run('git_pull', cwd))).toMatchObject({ action: 'pull', updated: false, upstream: 'origin/main' });
  });

  it('审批档:status 不问;commit 同写文件;push / pull 同跑命令;完全通行全放行', () => {
    for (const mode of ['readonly', 'auto-edit', 'full-auto'] as const) expect(toolNeedsApproval('git_status', mode)).toBe(false);
    expect([toolNeedsApproval('git_commit', 'readonly'), toolNeedsApproval('git_commit', 'auto-edit'), toolNeedsApproval('git_commit', 'full-auto')]).toEqual([true, false, false]);
    for (const name of ['git_push', 'git_pull']) {
      expect([toolNeedsApproval(name, 'readonly'), toolNeedsApproval(name, 'auto-edit'), toolNeedsApproval(name, 'full-auto')]).toEqual([true, true, false]);
    }
  });

  it('只在会话的项目里动手:运行目录指向别处也一样;run 停了就不动手', async () => {
    const { cwd } = project('scoped');
    const { cwd: other } = project('other');
    writeFileSync(path.join(cwd, 'p.txt'), 'p'); writeFileSync(path.join(other, 'o.txt'), 'o');
    const c = json(String(await tools.get('git_commit')!.execute({ message: 'scoped' }, { ...ctxOf(cwd), cwd: other })));
    expect(git(cwd, 'rev-parse', 'HEAD')).toBe(c.sha);
    expect(git(other, 'status', '--porcelain')).toBe('?? o.txt');
    const ac = new AbortController(); ac.abort();
    const out = String(await tools.get('git_commit')!.execute({ message: 'late' }, { ...ctxOf(other), signal: ac.signal }));
    expect(out.startsWith('Error:')).toBe(true);
    expect(git(other, 'log', '-1', '--format=%s')).toBe('base');
  });

  it('默认工作区:推 / 拉照样拒(和提交同一道闸)', async () => {
    const { cwd } = project('shared');
    process.env.TANGU_DEFAULT_WORKSPACE = cwd;
    expect(json(await run('git_push', cwd)).error).toBe('shared_workspace');
    expect(json(await run('git_pull', cwd)).error).toBe('shared_workspace');
    delete process.env.TANGU_DEFAULT_WORKSPACE;
  });

  it('审批说明写出提交哪些文件、推到哪个远端', async () => {
    const { cwd } = project('preview');
    writeFileSync(path.join(cwd, 'c.txt'), 'c');
    const commit = await gitApprovalPreview('git_commit', { message: 'feat: c' }, cwd);
    expect(commit).toContain('commit to main\nfeat: c\n1 file:');
    expect(commit).toContain('c.txt');
    const push = await gitApprovalPreview('git_push', {}, cwd);
    expect(push).toMatch(/^push main to .*\(origin\)\nwith this computer's own git credentials\n0 commits ahead of origin\/main$/);
    expect(await gitApprovalPreview('git_status', {}, cwd)).toBeNull();
    git(cwd, 'remote', 'set-url', '--push', 'origin', path.join(root, 'elsewhere.git'));
    expect(await gitApprovalPreview('git_push', {}, cwd)).toMatch(/^⚠ origin pushes to .*elsewhere\.git, not to the address/);
  });
});
