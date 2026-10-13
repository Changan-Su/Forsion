/**
 * 提交身份(真 git、临时仓库;全局配置指到临时文件,系统配置关掉,环境里不带 GIT_AUTHOR_*):
 *   - git 配置里名字和邮箱都有 → 照用,什么都不加,也不去问云端
 *   - 都没有 → 由 Forsion 账号推出来的补上:只经环境变量进提交这一个子进程,提交真的署上了,git 配置一个字没动
 *   - 「设置 → Git」里填的优先于账号推出来的;两样都填了就不问云端
 *   - git 配置里只有名字 → 只补邮箱(环境变量压得过配置,补多了会盖掉用户自己配的)
 *   - 仓库级配置只在给了 cwd 时算
 *   - 凑不齐 → 不补,git 照旧 no_identity
 *   - 凑不齐、但 git 自己取得出来(没有 useConfigOnly;邮箱取自环境变量 EMAIL)→ 报成 auto,什么都不补;设置里只填了名字 → 名字用填的、邮箱是 git 取的
 *
 * 负对照(2026-10-13 各改一处实跑,对应的用例红):
 *   - resolveGitIdentity 的 env 一律回空 → 「都没有 → 补上并真的署上」红
 *   - fill 里把 custom 和 fallback 的先后对调 → 「设置里填的优先」红
 *   - `if (!name && fill.name)` 去掉 `!name` → 「只补邮箱」红
 *   - configured 不传 cwd(一律读家目录)→ 「仓库级配置只在给了 cwd 时算」红
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { GitActionError, gitCommit } from './gitActions.js';
import { forsionIdentity, resolveGitIdentity } from './gitIdentity.js';
import { resetGitSettingsForTest } from './gitSettings.js';

let root: string;
let globalConfig: string;
const savedEnv = { ...process.env };
const git = (cwd: string, ...args: string[]): string => execFileSync('git', ['-C', cwd, ...args], { stdio: 'pipe', encoding: 'utf8' }).trim();
const repo = (name: string): string => { const p = path.join(root, name); mkdirSync(p, { recursive: true }); git(p, 'init', '-q', '-b', 'main'); return p; };
/** 不让 git 从系统用户名 / 主机名猜身份:没配就是没配(各台机器上结果一致)。 */
const NO_GUESS = '[user]\n\tuseConfigOnly = true\n';
const DAVE = async () => ({ name: 'Dave', email: 'dave@noreply.git.forsion.test' });

beforeAll(() => {
  root = mkdtempSync(path.join(tmpdir(), 'tangu-gitidentity-'));
  globalConfig = path.join(root, 'gitconfig');
  for (const key of ['GIT_AUTHOR_NAME', 'GIT_AUTHOR_EMAIL', 'GIT_COMMITTER_NAME', 'GIT_COMMITTER_EMAIL', 'EMAIL']) delete process.env[key];
  Object.assign(process.env, { GIT_CONFIG_GLOBAL: globalConfig, GIT_CONFIG_NOSYSTEM: '1', TANGU_HOME: path.join(root, 'tangu-home') });
});
afterAll(() => {
  rmSync(root, { recursive: true, force: true });
  for (const key of Object.keys(process.env)) if (!(key in savedEnv)) delete process.env[key];
  Object.assign(process.env, savedEnv);
});
beforeEach(() => { resetGitSettingsForTest(); writeFileSync(globalConfig, NO_GUESS); });

describe('由 Forsion 账号推出来的缺省', () => {
  it('名字 = 昵称,没有就用用户名;邮箱 = <用户名小写>@noreply.<Forsion Git 主机>', () => {
    expect(forsionIdentity({ username: 'Dave', nickname: '大卫' }, 'git.forsion.test')).toEqual({ name: '大卫', email: 'dave@noreply.git.forsion.test' });
    expect(forsionIdentity({ username: 'Dave', nickname: null }, 'git.forsion.test')).toEqual({ name: 'Dave', email: 'dave@noreply.git.forsion.test' });
  });
  it('这里没有 Forsion Git → 没有缺省邮箱;拼不出站上账号的用户名同理;尖括号和换行进不了作者行', () => {
    expect(forsionIdentity({ username: 'dave' }, null)).toEqual({ name: 'dave', email: '' });
    expect(forsionIdentity({ username: '大卫' }, 'git.forsion.test')).toEqual({ name: '大卫', email: '' });
    expect(forsionIdentity({ username: 'dave', nickname: 'D <x@y>\nz' }, null).name).toBe('D x@yz');
    expect(forsionIdentity(null, 'git.forsion.test')).toEqual({ name: '', email: '' });
  });
});

describe('提交时署谁的名', () => {
  it('git 配置里名字和邮箱都有 → 照用,什么都不加,也不问云端', async () => {
    writeFileSync(globalConfig, `${NO_GUESS}\tname = Own\n\temail = own@example.com\n`);
    const defaults = vi.fn(DAVE);
    expect(await resolveGitIdentity(defaults)).toEqual({ identity: { name: 'Own', email: 'own@example.com', source: 'git' }, env: {} });
    expect(defaults).not.toHaveBeenCalled();
  });

  it('都没有 → 补上并真的署上;git 配置一个字没动', async () => {
    const cwd = repo('fresh');
    writeFileSync(path.join(cwd, 'a.txt'), 'a\n');
    const who = await resolveGitIdentity(DAVE, cwd);
    expect(who.identity).toEqual({ name: 'Dave', email: 'dave@noreply.git.forsion.test', source: 'forsion' });
    await gitCommit(cwd, 'first', undefined, undefined, who.env);
    expect(git(cwd, 'log', '-1', '--format=%an <%ae> | %cn <%ce>')).toBe('Dave <dave@noreply.git.forsion.test> | Dave <dave@noreply.git.forsion.test>');
    expect(readFileSync(globalConfig, 'utf8')).toBe(NO_GUESS);
    expect(readFileSync(path.join(cwd, '.git', 'config'), 'utf8')).not.toMatch(/\[user\]/);
  });

  it('设置里填的优先于账号推出来的;两样都填了就不问云端', async () => {
    resetGitSettingsForTest({ identityName: 'Custom', identityEmail: 'c@example.com' });
    const defaults = vi.fn(DAVE);
    const who = await resolveGitIdentity(defaults);
    expect(who.identity).toEqual({ name: 'Custom', email: 'c@example.com', source: 'custom' });
    expect(who.env.GIT_AUTHOR_EMAIL).toBe('c@example.com');
    expect(defaults).not.toHaveBeenCalled();
    resetGitSettingsForTest({ identityEmail: 'only@example.com' });
    expect((await resolveGitIdentity(DAVE)).identity).toEqual({ name: 'Dave', email: 'only@example.com', source: 'custom' });
  });

  it('git 配置里只有名字 → 只补邮箱', async () => {
    writeFileSync(globalConfig, `${NO_GUESS}\tname = Own\n`);
    const who = await resolveGitIdentity(DAVE);
    expect(who.identity).toEqual({ name: 'Own', email: 'dave@noreply.git.forsion.test', source: 'forsion' });
    expect(who.env).toEqual({ GIT_AUTHOR_EMAIL: 'dave@noreply.git.forsion.test', GIT_COMMITTER_EMAIL: 'dave@noreply.git.forsion.test' });
  });

  it('仓库级配置只在给了 cwd 时算', async () => {
    const cwd = repo('local');
    git(cwd, 'config', 'user.name', 'Repo'); git(cwd, 'config', 'user.email', 'repo@example.com');
    expect((await resolveGitIdentity(DAVE, cwd)).identity).toEqual({ name: 'Repo', email: 'repo@example.com', source: 'git' });
    expect((await resolveGitIdentity(DAVE)).identity?.source).toBe('forsion');
  });

  it('凑不齐 → 不补;提交照旧 no_identity', async () => {
    const cwd = repo('nobody');
    writeFileSync(path.join(cwd, 'a.txt'), 'a\n');
    const who = await resolveGitIdentity(async () => null, cwd);
    expect(who).toEqual({ identity: null, env: {} });
    const failed = await gitCommit(cwd, 'x', undefined, undefined, who.env).then(() => null, (e) => e);
    expect(failed instanceof GitActionError && failed.code).toBe('no_identity');
    // 云端够不着(defaults 抛)同样当作没有,不把提交卡死
    expect((await resolveGitIdentity(async () => { throw new Error('offline'); }, cwd)).identity).toBeNull();
  });
  it('凑不齐、但 git 自己取得出来 → 报成 auto(界面看得见提交会署什么),什么都不补', async () => {
    writeFileSync(globalConfig, ''); // 放开 git 自己取
    process.env.EMAIL = 'guessed@host.example'; // git 取邮箱时先看这个变量:各台机器上结果一致
    try {
      const who = await resolveGitIdentity(async () => null);
      expect(who.env).toEqual({});
      expect(who.identity).toMatchObject({ email: 'guessed@host.example', source: 'auto' });
      expect(who.identity!.name).not.toBe('');
      resetGitSettingsForTest({ identityName: 'Typed Name' });
      const partly = await resolveGitIdentity(async () => null);
      expect(partly.identity).toEqual({ name: 'Typed Name', email: 'guessed@host.example', source: 'auto' });
      expect(partly.env).toEqual({ GIT_AUTHOR_NAME: 'Typed Name', GIT_COMMITTER_NAME: 'Typed Name' });
    } finally { delete process.env.EMAIL; }
  });
});
