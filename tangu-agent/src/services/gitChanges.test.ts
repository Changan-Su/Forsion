/**
 * 「未提交(Git)」范围:真临时仓库里的 modified / 未跟踪(created)/ deleted / 已暂存新文件 / 二进制,numstat 数字与 patch 形状。
 * 机器上没有 git 就整组跳过。
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gitExecutable } from './gitExec.js';
import { listGitChanges } from './gitChanges.js';

const hasGit = (() => {
  try { execFileSync(gitExecutable(), ['--version'], { stdio: 'ignore' }); return true; } catch { return false; }
})();

let home = '';
let scratch = '';
const prevHome = process.env.TANGU_HOME;
const gitEnv = (): NodeJS.ProcessEnv => ({
  ...process.env,
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_CONFIG_GLOBAL: join(scratch, 'empty.gitconfig'),
  GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.com', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.com',
});
const g = (cwd: string, ...args: string[]): string => execFileSync(gitExecutable(), ['-C', cwd, ...args], { env: gitEnv(), encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });

function newRepo(name: string): string {
  const dir = join(scratch, name);
  mkdirSync(dir, { recursive: true });
  g(dir, 'init', '-q');
  g(dir, 'config', 'commit.gpgsign', 'false');
  return realpathSync(dir);
}

beforeAll(() => {
  home = mkdtempSync(join(tmpdir(), 'gc-home-'));
  scratch = mkdtempSync(join(tmpdir(), 'gc-repo-'));
  writeFileSync(join(scratch, 'empty.gitconfig'), '');
  process.env.TANGU_HOME = home;
});

afterAll(() => {
  if (prevHome === undefined) delete process.env.TANGU_HOME;
  else process.env.TANGU_HOME = prevHome;
  rmSync(home, { recursive: true, force: true });
  rmSync(scratch, { recursive: true, force: true });
});

describe.skipIf(!hasGit)('listGitChanges', () => {
  it('modified / deleted / 已暂存新文件 / 未跟踪 / 二进制;忽略的不列;numstat 数字与 patch', async () => {
    const repo = newRepo('r1');
    writeFileSync(join(repo, 'a.txt'), '1\n2\n3\n4\n5\n');
    writeFileSync(join(repo, 'b.txt'), 'x\ny\nz\n');
    writeFileSync(join(repo, 'bin.dat'), Buffer.from([1, 0, 2]));
    writeFileSync(join(repo, '.gitignore'), 'ignored.txt\n');
    g(repo, 'add', '-A');
    g(repo, 'commit', '-qm', 'init');

    writeFileSync(join(repo, 'a.txt'), '1\n2\nthree\n4\n5\n'); // 未暂存修改
    rmSync(join(repo, 'b.txt'));                               // 删除
    writeFileSync(join(repo, 'bin.dat'), Buffer.from([1, 0, 3, 4]));
    writeFileSync(join(repo, 'staged.txt'), 's1\ns2\n');
    g(repo, 'add', 'staged.txt');                             // 已暂存的新文件
    mkdirSync(join(repo, 'dir'));
    writeFileSync(join(repo, 'dir', 'u.txt'), 'u1\nu2\nu3');   // 未跟踪(无末尾换行)
    writeFileSync(join(repo, 'ignored.txt'), 'nope\n');

    const r = await listGitChanges(repo, { diff: true });
    expect(r.available).toBe(true);
    expect(r.root).toBe(repo);
    expect(r.truncatedFiles).toBeUndefined();
    const by = Object.fromEntries(r.files.map((f) => [f.path, f]));
    expect(Object.keys(by).sort()).toEqual(['a.txt', 'b.txt', 'bin.dat', 'staged.txt', join('dir', 'u.txt')].map((p) => join(repo, p)).sort());

    expect(by[join(repo, 'a.txt')]).toMatchObject({ kind: 'modified', adds: 1, dels: 1, runs: 0 });
    expect(by[join(repo, 'a.txt')].patch).toBe(['@@ -1,5 +1,5 @@', ' 1', ' 2', '-3', '+three', ' 4', ' 5'].join('\n'));
    expect(by[join(repo, 'b.txt')]).toMatchObject({ kind: 'deleted', adds: 0, dels: 3 });
    expect(by[join(repo, 'b.txt')].patch).toBe('@@ -1,3 +0,0 @@\n-x\n-y\n-z');
    expect(by[join(repo, 'staged.txt')]).toMatchObject({ kind: 'created', adds: 2, dels: 0 });
    expect(by[join(repo, 'bin.dat')]).toMatchObject({ kind: 'modified', adds: null, dels: null, reason: 'binary' });
    expect(by[join(repo, 'bin.dat')].patch).toBeUndefined();
    expect(by[join(repo, 'dir', 'u.txt')]).toMatchObject({ kind: 'created', adds: 3, dels: 0, runs: 0 });
    expect(by[join(repo, 'dir', 'u.txt')].patch).toBe('@@ -0,0 +1,3 @@\n+u1\n+u2\n+u3');

    // 不要 diff 时不带 patch
    const plain = await listGitChanges(repo);
    expect(plain.files.every((f) => f.patch === undefined)).toBe(true);

    // path 过滤:只回这一条;项目外的路径 → 空
    const one = await listGitChanges(repo, { diff: true, path: join(repo, 'a.txt') });
    expect(one.files.map((f) => f.path)).toEqual([join(repo, 'a.txt')]);
    const untrackedOne = await listGitChanges(repo, { path: join(repo, 'dir', 'u.txt') });
    expect(untrackedOne.files.map((f) => f.path)).toEqual([join(repo, 'dir', 'u.txt')]);
    expect((await listGitChanges(repo, { path: join(scratch, 'elsewhere.txt') })).files).toEqual([]);
  });

  it('还没有提交的新仓:对空树比,已暂存的算新建', async () => {
    const repo = newRepo('fresh');
    writeFileSync(join(repo, 'first.txt'), 'hello\nworld\n');
    g(repo, 'add', 'first.txt');
    writeFileSync(join(repo, 'loose.txt'), 'x\n');
    const r = await listGitChanges(repo);
    expect(r.available).toBe(true);
    const by = Object.fromEntries(r.files.map((f) => [f.path, f]));
    expect(by[join(repo, 'first.txt')]).toMatchObject({ kind: 'created', adds: 2, dels: 0 });
    expect(by[join(repo, 'loose.txt')]).toMatchObject({ kind: 'created', adds: 1, dels: 0 });
  });

  it('不是仓库 → notrepo', async () => {
    const dir = join(scratch, 'plain');
    mkdirSync(dir, { recursive: true });
    // 临时目录的上级不在任何仓里时才成立(GIT_CEILING_DIRECTORIES 被 readGit 剥掉,不能靠它)
    let outside = true;
    try { g(dir, 'rev-parse', '--is-inside-work-tree'); outside = false; } catch { /* 不在仓里 */ }
    if (!outside) return;
    expect(await listGitChanges(realpathSync(dir))).toEqual({ available: false, reason: 'notrepo', files: [] });
  });

  it('仓库带过滤器配置且未经信任 → 不读(untrusted)', async () => {
    const repo = newRepo('filtered');
    g(repo, 'config', 'filter.evil.clean', 'false');
    writeFileSync(join(repo, 'x.txt'), 'x\n');
    const r = await listGitChanges(repo);
    expect(r).toMatchObject({ available: false, reason: 'untrusted', files: [] });
  });
});

describe.skipIf(!hasGit)('listGitChanges · 评审补的两条', () => {
  it('用户配了 diff.noprefix / mnemonicPrefix 也照样出 patch(前缀钉死 a/ b/)', async () => {
    const repo = newRepo('r-prefix');
    writeFileSync(join(repo, 'a.txt'), '1\n2\n3\n');
    g(repo, 'add', '-A');
    g(repo, 'commit', '-qm', 'init');
    g(repo, 'config', 'diff.noprefix', 'true');
    writeFileSync(join(repo, 'a.txt'), '1\nTWO\n3\n');
    const r = await listGitChanges(repo, { diff: true });
    const a = r.files.find((f) => f.path.endsWith('a.txt'))!;
    expect(a).toMatchObject({ adds: 1, dels: 1 });
    expect(a.patch).toContain('+TWO');
    g(repo, 'config', '--unset', 'diff.noprefix');
    g(repo, 'config', 'diff.mnemonicPrefix', 'true');
    const r2 = await listGitChanges(repo, { diff: true });
    expect(r2.files.find((f) => f.path.endsWith('a.txt'))!.patch).toContain('+TWO');
  });
});
