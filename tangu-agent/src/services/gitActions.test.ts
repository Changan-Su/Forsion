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
  DEFAULT_GITIGNORE, GitActionError, assertCommittable, assertStagedSafe, assertWithinReviewed, changesToken, cleanCommitMessage, commitMessageContext, commitMessagePrompt, reviewedStatuses,
  gitCommit, gitCreateBranch, gitInit, gitPending, gitPush, isCredentialPath, serialized,
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
  Object.assign(process.env, { GIT_CONFIG_GLOBAL: globalConfig, GIT_CONFIG_NOSYSTEM: '1', TANGU_HOME: dir('tangu-home'), ...IDENTITY });
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
    const tooMany = await assertCommittable(cwd, { untracked: ['a', 'b', 'c/d', 'c/e'] }, { maxFiles: 3, maxBytes: 1024 }).catch((e) => e);
    expect(tooMany.code).toBe('too_many_files');
    expect(tooMany.detail).toContain('c/ (2)');
    const tooLarge = await assertCommittable(cwd, { untracked: ['big.bin'] }, { maxFiles: 10, maxBytes: 10 }).catch((e) => e);
    expect(tooLarge.code).toBe('large_files');
    expect(tooLarge.detail).toContain('big.bin');
  });

  it('最终 index 复核:按暂存对象的真实大小拦(过滤器处理后变大的、用户预先暂存的都逃不过)', async () => {
    const cwd = repo('commit-final-index');
    writeFileSync(path.join(cwd, 'blob.bin'), Buffer.alloc(64));
    const blob = git(cwd, 'hash-object', '-w', 'blob.bin');
    const err = await assertStagedSafe(cwd, [{ status: 'A', path: 'blob.bin', mode: '100644', blob }], { maxFiles: 10, maxBytes: 10, maxEntries: 10 }).catch((e) => e);
    expect(err.code).toBe('large_files');
    expect(await assertStagedSafe(cwd, [{ status: 'A', path: 'blob.bin', mode: '100644', blob }], { maxFiles: 10, maxBytes: 1024, maxEntries: 10 })).toBeUndefined();
    // 条目多到清单列不全(改动也算,不只新文件)→ 拒:列不全的东西不许提交
    const many = Array.from({ length: 3 }, (_, i) => ({ status: 'M', path: `f${i}.txt`, mode: '100644', blob }));
    expect((await assertStagedSafe(cwd, many, { maxFiles: 10, maxBytes: 1024, maxEntries: 2 }).catch((e) => e)).code).toBe('too_many_files');
  });

  it('提交框清单与提交绑定:看完之后又冒出新文件 → changes_changed;拿新清单的指纹才提交', async () => {
    const cwd = repo('commit-token');
    writeFileSync(path.join(cwd, 'a.txt'), 'a');
    const reviewed = await gitPending(cwd);
    expect(reviewed.token).toBe(changesToken(reviewed.files));
    writeFileSync(path.join(cwd, 'sneaky.txt'), 'not reviewed');
    expect(await codeOf(gitCommit(cwd, 'x', undefined, reviewed.token))).toBe('changes_changed');
    expect(git(cwd, 'diff', '--cached', '--name-only')).toBe('');
    const fresh = await gitPending(cwd);
    expect(fresh.files.map((f) => f.path).sort()).toEqual(['a.txt', 'sneaky.txt']);
    expect((await gitCommit(cwd, 'reviewed', undefined, fresh.token)).subject).toBe('reviewed');
  });

  it('SHA-256 仓的首次提交:空树按对象格式现算(不是那串 SHA-1)', async () => {
    const cwd = dir('commit-sha256');
    try { git(cwd, 'init', '-q', '--object-format=sha256', '-b', 'main'); } catch { return; } // 老 git 不支持就跳过
    writeFileSync(path.join(cwd, 'a.txt'), 'a');
    expect((await gitPending(cwd)).total).toBe(1);
    expect(await commitMessageContext(cwd)).toContain('first commit');
    expect((await gitCommit(cwd, 'first')).subject).toBe('first');
    expect(git(cwd, 'rev-parse', 'HEAD')).toHaveLength(64);
  });

  it('有已暂存的只提交已暂存的,没暂存的改动原样留着(不替用户推翻部分暂存)', async () => {
    const cwd = repo('commit-staged-only');
    writeFileSync(path.join(cwd, 'a.txt'), 'a'); writeFileSync(path.join(cwd, 'b.txt'), 'b');
    git(cwd, 'add', '.'); git(cwd, 'commit', '-qm', 'base');
    writeFileSync(path.join(cwd, 'a.txt'), 'a2'); writeFileSync(path.join(cwd, 'b.txt'), 'b2'); writeFileSync(path.join(cwd, 'new.txt'), 'n');
    git(cwd, 'add', 'a.txt');
    const pending = await gitPending(cwd);
    expect(pending).toMatchObject({ stagedOnly: true, total: 1, files: [{ code: 'M', path: 'a.txt' }] });
    expect((await gitCommit(cwd, 'only a')).stagedOnly).toBe(true);
    expect(git(cwd, 'show', '--name-only', '--format=', 'HEAD')).toBe('a.txt');
    expect(git(cwd, 'diff', '--cached', '--name-only')).toBe(''); // 暂存区清空(那一项进了提交)
    expect(git(cwd, 'diff', '--name-only')).toBe('b.txt');         // 没暂存的改动原样还在工作区
    expect(git(cwd, 'ls-files', '--others', '--exclude-standard')).toBe('new.txt');
  });

  it('凭据类文件 → credential_files 点名拒绝;是我们 add 的就把 index 退回原样;.env.example 照常', async () => {
    const cwd = repo('commit-secrets');
    writeFileSync(path.join(cwd, 'a.txt'), 'a');
    git(cwd, 'add', '.'); git(cwd, 'commit', '-qm', 'base');
    writeFileSync(path.join(cwd, '.env'), 'TOKEN=x'); writeFileSync(path.join(cwd, 'app.js'), 'x');
    const err = await gitCommit(cwd, 'x').catch((e) => e);
    expect(err.code).toBe('credential_files');
    expect(err.detail).toBe('.env');
    expect(git(cwd, 'diff', '--cached', '--name-only')).toBe(''); // 退回了:什么都没暂存
    rmSync(path.join(cwd, '.env')); writeFileSync(path.join(cwd, '.env.example'), 'TOKEN=');
    expect((await gitCommit(cwd, 'ok')).subject).toBe('ok');
    for (const [file, hit] of [['.env.local', true], ['config/secrets.json', true], ['id_ed25519', true], ['id_ed25519.pub', false], ['server.pem', true], ['.npmrc', true], ['src/secretSanta.tsx', false], ['docs/tokens.md', false]] as const) {
      expect(isCredentialPath(file), file).toBe(hit);
    }
  });

  it('用户预先暂存了一个嵌套仓(gitlink)→ embedded_repo', async () => {
    const cwd = repo('commit-gitlink');
    const inner = dir('commit-gitlink/lib');
    git(inner, 'init', '-q'); writeFileSync(path.join(inner, 'x.txt'), 'x'); git(inner, 'add', '.'); git(inner, 'commit', '-qm', 'inner');
    git(cwd, 'add', 'lib');
    expect(await codeOf(gitCommit(cwd, 'x'))).toBe('embedded_repo');
  });

  it('项目是大仓的子目录 → nested_repo:不替它把整个父仓 add -A', async () => {
    const outer = repo('commit-parent');
    writeFileSync(path.join(outer, 'private.txt'), 'p');
    const sub = dir('commit-parent/app');
    writeFileSync(path.join(sub, 'a.txt'), 'a');
    expect(await codeOf(gitCommit(sub, 'x'))).toBe('nested_repo');
    expect(await codeOf(gitPending(sub))).toBe('nested_repo');
    expect(await codeOf(gitCreateBranch(sub, 'b'))).toBe('nested_repo');
    expect(await codeOf(gitPush(sub))).toBe('nested_repo');
    expect(git(outer, 'diff', '--cached', '--name-only')).toBe('');
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

describe('仓库自带会执行程序的配置(gitTrust)', () => {
  it.skipIf(process.platform === 'win32')('未信任:钩子不跑、提交被拒;点了信任才照用户配置跑(钩子执行),之后不再问', async () => {
    const cwd = repo('trust-hooks');
    writeFileSync(path.join(cwd, 'a.txt'), 'a');
    const hooks = dir('trust-hooks/.githooks');
    const marker = path.join(root, 'trust-hooks-ran');
    writeFileSync(path.join(hooks, 'pre-commit'), `#!/bin/sh\ntouch "${marker}"\n`, { mode: 0o755 });
    git(cwd, 'config', 'core.hooksPath', '.githooks');
    const err = await gitCommit(cwd, 'x').catch((e) => e);
    expect(err.code).toBe('untrusted_config');
    expect(err.detail).toContain('core.hookspath');
    expect(existsSync(marker)).toBe(false);
    expect(git(cwd, 'diff', '--cached', '--name-only')).toBe('');
    expect((await gitCommit(cwd, 'trusted', true)).subject).toBe('trusted');
    expect(existsSync(marker)).toBe(true); // 信任后照用户自己的配置跑:钩子真的执行了
    writeFileSync(path.join(cwd, 'b.txt'), 'b');
    expect((await gitCommit(cwd, 'again')).subject).toBe('again'); // 信任记在宿主侧,下次不再问
  });

  it.skipIf(process.platform === 'win32')('信任过的钩子在复核之后又暂存了凭据 → 撤回这次提交(工作区不动);只改格式的钩子照常提交', async () => {
    const cwd = repo('hook-restage');
    writeFileSync(path.join(cwd, 'a.txt'), 'a');
    git(cwd, 'add', '.'); git(cwd, 'commit', '-qm', 'base');
    const hooks = dir('hook-restage/.githooks');
    git(cwd, 'config', 'core.hooksPath', '.githooks');
    writeFileSync(path.join(hooks, 'pre-commit'), '#!/bin/sh\necho "TOKEN=x" > .env\ngit add .env\n', { mode: 0o755 });
    writeFileSync(path.join(cwd, 'a.txt'), 'changed');
    const head = git(cwd, 'rev-parse', 'HEAD');
    const err = await gitCommit(cwd, 'sneaky', true).catch((e) => e);
    expect(err.code).toBe('hook_changed_commit');
    expect(err.detail).toContain('.env');
    expect(git(cwd, 'rev-parse', 'HEAD')).toBe(head);            // 提交撤回了
    expect(readFileSync(path.join(cwd, 'a.txt'), 'utf8')).toBe('changed'); // 用户的改动还在
    // 只改格式的钩子(lint-staged 那类):tree 变了但没有违规 → 照常提交
    writeFileSync(path.join(hooks, 'pre-commit'), '#!/bin/sh\nprintf "formatted" > a.txt\ngit add a.txt\n', { mode: 0o755 });
    rmSync(path.join(cwd, '.env')); git(cwd, 'reset', '-q');
    expect((await gitCommit(cwd, 'formatted by hook')).subject).toBe('formatted by hook');
    expect(git(cwd, 'show', 'HEAD:a.txt')).toBe('formatted');
  });

  it.skipIf(process.platform === 'win32')('钩子加了一个没过目的普通文件 → 撤回(按最终提交 vs 基准权威复核);首次提交也能撤', async () => {
    const cwd = repo('hook-extra');
    const hooks = dir('hook-extra/.githooks');
    git(cwd, 'config', 'core.hooksPath', '.githooks');
    writeFileSync(path.join(hooks, 'pre-commit'), '#!/bin/sh\necho x > unreviewed.txt\ngit add unreviewed.txt\n', { mode: 0o755 });
    writeFileSync(path.join(cwd, 'a.txt'), 'a');
    const err = await gitCommit(cwd, 'first', true).catch((e) => e);
    expect(err.code).toBe('hook_changed_commit');
    expect(err.detail).toContain('unreviewed.txt');
    expect(() => git(cwd, 'rev-parse', '--verify', 'HEAD')).toThrow(); // 首次提交撤回 = 回到还没有提交的样子
  });

  it.skipIf(process.platform === 'win32')('post-commit 钩子又提交了一次 → 认不准是哪个提交:commit_unverified,什么都不撤', async () => {
    const cwd = repo('hook-post');
    writeFileSync(path.join(cwd, 'a.txt'), 'a');
    git(cwd, 'add', '.'); git(cwd, 'commit', '-qm', 'base');
    const hooks = dir('hook-post/.githooks');
    git(cwd, 'config', 'core.hooksPath', '.githooks');
    writeFileSync(path.join(hooks, 'post-commit'), '#!/bin/sh\n[ -f .done ] && exit 0\ntouch .done\necho y > b.txt\ngit add b.txt .done\ngit commit -qm extra\n', { mode: 0o755 });
    writeFileSync(path.join(cwd, 'a.txt'), 'changed');
    const err = await gitCommit(cwd, 'mine', true).catch((e) => e);
    expect(err.code).toBe('commit_unverified');
    expect(git(cwd, 'log', '-2', '--format=%s')).toBe('extra\nmine'); // 不猜、不撤:原样交给用户检查
  });

  it('改动类型也要对得上:看见的是删除,暂存时却成了修改(删掉的又被建回来)→ changes_changed', () => {
    const reviewed = reviewedStatuses([{ code: ' D', path: 'gone.txt' }, { code: 'R ', path: 'new.txt', from: 'old.txt' }, { code: '??', path: 'n.txt' }], false);
    expect([...reviewed]).toEqual([['gone.txt', 'D'], ['new.txt', 'A'], ['old.txt', 'D'], ['n.txt', 'A']]);
    expect(() => assertWithinReviewed([{ status: 'D', path: 'gone.txt', mode: '000000', blob: '' }, { status: 'D', path: 'old.txt', mode: '000000', blob: '' }], reviewed)).not.toThrow();
    const err = (() => { try { assertWithinReviewed([{ status: 'M', path: 'gone.txt', mode: '100644', blob: 'x' }], reviewed) } catch (e) { return e as GitActionError } })();
    expect(err?.code).toBe('changes_changed');
    expect(reviewedStatuses([{ code: 'M', path: 'a' }], true).get('a')).toBe('M');
  });

  it.skipIf(process.platform === 'win32')('过滤器(read 级):未信任时连待提交清单都不读 —— clean 过滤器一次都没跑', async () => {
    const cwd = repo('trust-filter');
    writeFileSync(path.join(cwd, 'a.txt'), 'a');
    git(cwd, 'add', '.'); git(cwd, 'commit', '-qm', 'base');
    const marker = path.join(root, 'trust-filter-ran');
    git(cwd, 'config', 'filter.evil.clean', `sh -c 'touch "${marker}"; cat'`);
    writeFileSync(path.join(cwd, '.gitattributes'), '*.txt filter=evil\n');
    writeFileSync(path.join(cwd, 'a.txt'), 'changed');
    expect(await codeOf(gitPending(cwd))).toBe('untrusted_config');
    expect(await codeOf(commitMessageContext(cwd))).toBe('untrusted_config');
    expect(existsSync(marker)).toBe(false);
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

  it('有上游时推到上游那个分支(显式 refspec,不吃 push.default 的隐式选择)', async () => {
    const { cwd, remote } = setup('push-upstream');
    git(cwd, 'push', '-q', '-u', 'origin', 'HEAD:release');
    writeFileSync(path.join(cwd, 'b.txt'), 'b');
    git(cwd, 'add', '.'); git(cwd, 'commit', '-qm', 'to release');
    git(cwd, 'config', 'push.default', 'nothing'); // 无参数的 git push 在这里会直接失败
    expect(await gitPush(cwd)).toMatchObject({ remote: 'origin', branch: 'release', target: 'origin/release' });
    expect(git(remote, 'log', '-1', '--format=%s', 'release')).toBe('to release');
    expect(() => git(remote, 'rev-parse', '--verify', 'refs/heads/main')).toThrow(); // 没有顺手推出一个同名分支
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
