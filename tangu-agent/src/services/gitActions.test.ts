/**
 * PROJECT 详情「Git」页的宿主动作(真 git,临时目录;全局 git 配置指到空文件,不读本机的):
 *   - 建仓:缺省 .gitignore 只在没有时写、软链不碰;已在仓里(含外层仓)拒绝;没配 init.defaultBranch 用 main,配了照用
 *   - 提交:信息走 stdin;空信息 / 没改动 / 夹着别的仓 / 新文件太多 / 新文件太大 → 带 code 拒绝;没配身份 → no_identity
 *   - 新建分支:合法名切过去;非法名 / 以 - 开头 → invalid_branch
 *   - 推送:首推设上游;无远端 / 游离 HEAD 拒绝;改写历史后不开 forceWithLease 推不上,开了能推
 *   - 提交信息:现场里有最近提交的风格与 diff;模型包的代码块 / 引号剥掉;用户的提交说明进系统提示
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync, symlinkSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  DEFAULT_GITIGNORE, GitActionError, assertCommittable, cleanCommitMessage, commitMessageContext, commitMessagePrompt,
  gitCommit, gitCreateBranch, gitInit, gitPush, serialized,
} from './gitActions.js';
import { resetGitSettingsForTest } from './gitSettings.js';

let root: string;
let globalConfig: string;
const savedEnv = { ...process.env };
const IDENTITY = { GIT_AUTHOR_NAME: 'Tester', GIT_AUTHOR_EMAIL: 't@example.com', GIT_COMMITTER_NAME: 'Tester', GIT_COMMITTER_EMAIL: 't@example.com' };

const git = (cwd: string, ...args: string[]): string => execFileSync('git', ['-C', cwd, ...args], { stdio: 'pipe', encoding: 'utf8' }).trim();
const dir = (name: string): string => { const p = path.join(root, name); mkdirSync(p, { recursive: true }); return p; };
const repo = (name: string): string => { const p = dir(name); git(p, 'init', '-q', '-b', 'main'); return p; };
const codeOf = async (p: Promise<unknown>): Promise<string> => {
  try { await p; return 'ok'; } catch (e) { return e instanceof GitActionError ? e.code : `unexpected: ${(e as Error).message}`; }
};

beforeAll(() => {
  root = mkdtempSync(path.join(tmpdir(), 'tangu-gitactions-'));
  globalConfig = path.join(root, 'gitconfig');
  writeFileSync(globalConfig, '');
  Object.assign(process.env, { GIT_CONFIG_GLOBAL: globalConfig, GIT_CONFIG_NOSYSTEM: '1', ...IDENTITY });
});
afterAll(() => {
  rmSync(root, { recursive: true, force: true });
  for (const key of Object.keys(process.env)) if (!(key in savedEnv)) delete process.env[key];
  Object.assign(process.env, savedEnv);
});
beforeEach(() => { resetGitSettingsForTest(); writeFileSync(globalConfig, ''); });

describe('gitInit', () => {
  it('新目录:建仓 + 缺省 .gitignore,分支叫 main,不做首次提交', async () => {
    const cwd = dir('fresh');
    expect(await gitInit(cwd)).toEqual({ createdGitignore: true });
    expect(readFileSync(path.join(cwd, '.gitignore'), 'utf8')).toBe(DEFAULT_GITIGNORE);
    expect(git(cwd, 'symbolic-ref', '--short', 'HEAD')).toBe('main');
    expect(() => git(cwd, 'rev-parse', '--verify', 'HEAD')).toThrow(); // 还没有提交
  });

  it('已有 .gitignore 一个字不动;软链的 .gitignore 不跟随、不写穿', async () => {
    const own = dir('own-ignore');
    writeFileSync(path.join(own, '.gitignore'), 'dist/\n');
    expect(await gitInit(own)).toEqual({ createdGitignore: false });
    expect(readFileSync(path.join(own, '.gitignore'), 'utf8')).toBe('dist/\n');

    const linked = dir('linked-ignore');
    const target = path.join(root, 'outside-target.txt');
    symlinkSync(target, path.join(linked, '.gitignore'));
    expect(await gitInit(linked)).toEqual({ createdGitignore: false });
    expect(readlinkSync(path.join(linked, '.gitignore'))).toBe(target);
    expect(existsSync(target)).toBe(false);
  });

  it('已经在仓里(含外层仓的子目录)→ already_repo', async () => {
    const outer = repo('outer');
    expect(await codeOf(gitInit(outer))).toBe('already_repo');
    expect(await codeOf(gitInit(dir('outer/sub')))).toBe('already_repo');
  });

  it('用户配了 init.defaultBranch 就照用', async () => {
    writeFileSync(globalConfig, '[init]\n\tdefaultBranch = trunk\n');
    const cwd = dir('custom-branch');
    await gitInit(cwd);
    expect(git(cwd, 'symbolic-ref', '--short', 'HEAD')).toBe('trunk');
  });
});

describe('默认工作区(所有不在项目里的对话共用)', () => {
  it('它和它的上级都不建仓、不提交 → shared_workspace;旁边的兄弟目录照常', async () => {
    const vault = dir('vault');
    const sessions = dir('vault/Sessions');
    process.env.TANGU_DEFAULT_WORKSPACE = sessions;
    try {
      expect(await codeOf(gitInit(sessions))).toBe('shared_workspace');
      expect(await codeOf(gitInit(vault))).toBe('shared_workspace');
      expect(existsSync(path.join(sessions, '.git'))).toBe(false);
      expect(existsSync(path.join(sessions, '.gitignore'))).toBe(false);
      git(sessions, 'init', '-q'); // 用户自己在这里建过仓:面板也不替他整目录提交
      writeFileSync(path.join(sessions, 'note.md'), 'x');
      expect(await codeOf(gitCommit(sessions, 'x'))).toBe('shared_workspace');
      expect(await codeOf(gitInit(dir('vault-sibling')))).toBe('ok');
    } finally { delete process.env.TANGU_DEFAULT_WORKSPACE; }
  });
});

describe('gitCommit', () => {
  it('提交全部改动(含新文件),信息原样落盘;再提交 → nothing_to_commit', async () => {
    const cwd = repo('commit-all');
    writeFileSync(path.join(cwd, 'a.txt'), 'a');
    mkdirSync(path.join(cwd, 'src'));
    writeFileSync(path.join(cwd, 'src', 'b.txt'), 'b');
    const message = 'Add first files\n\nBody line with `backticks` and "quotes"; $(not a command)';
    const r = await gitCommit(cwd, message);
    expect(r.subject).toBe('Add first files');
    expect(git(cwd, 'log', '-1', '--format=%B')).toBe(message);
    expect(git(cwd, 'status', '--porcelain')).toBe('');
    expect(await codeOf(gitCommit(cwd, 'again'))).toBe('nothing_to_commit');
  });

  it('空信息 / 不是仓 → 带 code 拒绝', async () => {
    const cwd = repo('commit-empty');
    writeFileSync(path.join(cwd, 'a.txt'), 'a');
    expect(await codeOf(gitCommit(cwd, '   '))).toBe('empty_message');
    expect(await codeOf(gitCommit(cwd, 42))).toBe('empty_message');
    expect(await codeOf(gitCommit(dir('not-a-repo'), 'x'))).toBe('not_repo');
  });

  it('夹着别的 git 仓 → embedded_repo,什么都不暂存', async () => {
    const cwd = repo('commit-embedded');
    writeFileSync(path.join(cwd, 'a.txt'), 'a');
    const inner = dir('commit-embedded/vendor/lib');
    git(inner, 'init', '-q');
    writeFileSync(path.join(inner, 'x.txt'), 'x');
    const err = await gitCommit(cwd, 'x').catch((e) => e);
    expect(err).toBeInstanceOf(GitActionError);
    expect(err.code).toBe('embedded_repo');
    expect(err.detail).toContain('vendor/lib/');
    expect(git(cwd, 'diff', '--cached', '--name-only')).toBe('');
  });

  it('新文件太多 / 太大 → 点名拒绝(上限可注入)', async () => {
    const cwd = repo('commit-limits');
    writeFileSync(path.join(cwd, 'big.bin'), Buffer.alloc(64));
    const tooMany = await assertCommittable(cwd, { entries: ['a', 'b', 'c/d', 'c/e'], untracked: ['a', 'b', 'c/d', 'c/e'] }, { maxFiles: 3, maxBytes: 1024 }).catch((e) => e);
    expect(tooMany.code).toBe('too_many_files');
    expect(tooMany.detail).toContain('c/ (2)');
    const tooLarge = await assertCommittable(cwd, { entries: ['big.bin'], untracked: ['big.bin'] }, { maxFiles: 10, maxBytes: 10 }).catch((e) => e);
    expect(tooLarge.code).toBe('large_files');
    expect(tooLarge.detail).toContain('big.bin');
  });

  it('git 不知道你是谁 → no_identity(不是笼统的 git_failed)', async () => {
    const cwd = repo('commit-identity');
    git(cwd, 'config', 'user.useConfigOnly', 'true');
    writeFileSync(path.join(cwd, 'a.txt'), 'a');
    for (const key of Object.keys(IDENTITY)) delete process.env[key];
    try {
      expect(await codeOf(gitCommit(cwd, 'x'))).toBe('no_identity');
    } finally { Object.assign(process.env, IDENTITY); }
  });
});

describe('gitCreateBranch', () => {
  it('合法名 → 建好并切过去,未提交的改动跟着走', async () => {
    const cwd = repo('branch');
    writeFileSync(path.join(cwd, 'a.txt'), 'a');
    git(cwd, 'add', '.'); git(cwd, 'commit', '-qm', 'base');
    writeFileSync(path.join(cwd, 'a.txt'), 'changed');
    expect(await gitCreateBranch(cwd, ' tangu/fix-login ')).toEqual({ branch: 'tangu/fix-login' });
    expect(git(cwd, 'symbolic-ref', '--short', 'HEAD')).toBe('tangu/fix-login');
    expect(readFileSync(path.join(cwd, 'a.txt'), 'utf8')).toBe('changed');
  });

  it('非法名 / 以 - 开头 / 空 → invalid_branch;已存在 → git_failed', async () => {
    const cwd = repo('branch-bad');
    writeFileSync(path.join(cwd, 'a.txt'), 'a');
    git(cwd, 'add', '.'); git(cwd, 'commit', '-qm', 'base');
    for (const name of ['bad..name', '-x', '', 'a b', 'x.lock']) expect(await codeOf(gitCreateBranch(cwd, name)), name).toBe('invalid_branch');
    expect(await codeOf(gitCreateBranch(cwd, 'main'))).toBe('git_failed');
  });
});

describe('gitPush', () => {
  const setup = (name: string): { cwd: string; remote: string } => {
    const remote = path.join(root, `${name}-remote.git`);
    execFileSync('git', ['init', '-q', '--bare', remote]);
    const cwd = repo(name);
    writeFileSync(path.join(cwd, 'a.txt'), 'a');
    git(cwd, 'add', '.'); git(cwd, 'commit', '-qm', 'base');
    git(cwd, 'remote', 'add', 'origin', remote);
    return { cwd, remote };
  };

  it('首推到 origin 并设上游;之后按上游推', async () => {
    const { cwd, remote } = setup('push');
    expect(await gitPush(cwd)).toMatchObject({ remote: 'origin', branch: 'main' });
    expect(git(cwd, 'rev-parse', '--abbrev-ref', '@{u}')).toBe('origin/main');
    writeFileSync(path.join(cwd, 'b.txt'), 'b');
    git(cwd, 'add', '.'); git(cwd, 'commit', '-qm', 'second');
    await gitPush(cwd);
    expect(git(remote, 'log', '-1', '--format=%s', 'main')).toBe('second');
  });

  it('改写历史后:不开 forceWithLease 推不上(git_failed),开了能推', async () => {
    const { cwd, remote } = setup('push-lease');
    await gitPush(cwd);
    git(cwd, 'commit', '-q', '--amend', '-m', 'rewritten');
    expect(await codeOf(gitPush(cwd))).toBe('git_failed');
    resetGitSettingsForTest({ forceWithLease: true });
    await gitPush(cwd);
    expect(git(remote, 'log', '-1', '--format=%s', 'main')).toBe('rewritten');
  });

  it('没有远端 → no_remote;游离 HEAD → detached', async () => {
    const cwd = repo('push-none');
    writeFileSync(path.join(cwd, 'a.txt'), 'a');
    git(cwd, 'add', '.'); git(cwd, 'commit', '-qm', 'base');
    expect(await codeOf(gitPush(cwd))).toBe('no_remote');
    git(cwd, 'checkout', '-q', '--detach');
    expect(await codeOf(gitPush(cwd))).toBe('detached');
  });
});

describe('commit message', () => {
  it('现场:最近提交(学语言与风格)+ 新文件 + diff;新仓提示是首次提交;没改动 → nothing_to_commit', async () => {
    const fresh = repo('msg-fresh');
    writeFileSync(path.join(fresh, 'readme.md'), '# hi');
    const first = await commitMessageContext(fresh);
    expect(first).toContain('first commit of the repository');
    expect(first).toContain('readme.md');

    const cwd = repo('msg');
    writeFileSync(path.join(cwd, 'a.txt'), 'line one\n');
    git(cwd, 'add', '.'); git(cwd, 'commit', '-qm', 'feat: 初始化项目');
    writeFileSync(path.join(cwd, 'a.txt'), 'line one\nline two\n');
    writeFileSync(path.join(cwd, 'new.txt'), 'n');
    const ctx = await commitMessageContext(cwd);
    expect(ctx).toContain('feat: 初始化项目');
    expect(ctx).toContain('new.txt');
    expect(ctx).toContain('+line two');
    git(cwd, 'add', '.'); git(cwd, 'commit', '-qm', 'second');
    expect(await codeOf(commitMessageContext(cwd))).toBe('nothing_to_commit');
  });

  it('剥掉模型包的代码块 / 引号;用户的提交说明进系统提示', () => {
    expect(cleanCommitMessage('```\nfix: a thing\n\nbody  \n```')).toBe('fix: a thing\n\nbody');
    expect(cleanCommitMessage('"Add login page"')).toBe('Add login page');
    expect(cleanCommitMessage('Keep "quoted" words')).toBe('Keep "quoted" words');
    expect(commitMessagePrompt('')).not.toContain('instructions from the user');
    expect(commitMessagePrompt('用中文,加 emoji 前缀')).toContain('用中文,加 emoji 前缀');
  });
});

describe('serialized', () => {
  it('同一目录的写动作排队执行,前一个失败不影响后一个', async () => {
    const order: string[] = [];
    const slow = serialized('/x', async () => { await new Promise((r) => setTimeout(r, 30)); order.push('a'); throw new Error('boom'); });
    const fast = serialized('/x', async () => { order.push('b'); return 1; });
    await expect(slow).rejects.toThrow('boom');
    await expect(fast).resolves.toBe(1);
    expect(order).toEqual(['a', 'b']);
  });
});
