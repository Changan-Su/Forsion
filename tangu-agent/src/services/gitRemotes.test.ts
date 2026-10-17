/**
 * 远端一览与推送去向(services/gitRemotes.ts + gitSummary / gitPush / gitSetPushRemote 里用到它的那几处;真 git,远端是本机的裸仓,不连网):
 *   - 每个远端:站点(按主机名)与凭据(按凭据接缝的判法)分开 —— github.com 的 ssh 远端是 host=github、auth=local
 *   - 推送去向:上游配置 → origin → 唯一那个 → null;从配置算,远端上还没有这条分支(@{u} 解析不出来)也照样认
 *   - 新远端的名字:没有远端 → origin;有了 → forsion / github / 主机名,撞名加 -2
 *   - 远端不叫 origin 时面板照样列出来、推送去向照样算得出(原来 Git 页当它不存在)
 *   - 「只推送这一次」推到点名的远端、不动上游;「以后推送到这里」只改上游配置、不推
 *
 * 负对照(2026-10-14 各改一处实跑,对应的用例红):
 *   - describeRemote 的 auth 改成按 host 给 → 「站点与凭据分开」红(ssh 远端成了 github)
 *   - pushRemoteOf 不看上游配置 → 「推送去向」「以后推送到这里」红
 *   - gitSummary 的 pushRemote 改用 @{u} 的远端 → 「以后推送到这里」红(还没推过,解析不出来)
 *   - gitPush 的 once 照样带 --set-upstream → 「只推送这一次」红
 *   - gitSetPushRemote 只写 .remote 不写 .merge → 「以后推送到这里」红(原来没上游的分支,推送照旧去了 origin)
 *   - gitSummary 的上游只看 .remote 不看 .merge → 同一条红(只配了 .remote 的分支:面板说 backup,推送去了 origin —— 两边判法不一致)
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describeRemote, pushRemoteOf, remoteNameFor } from './gitRemotes.js';
import { GitActionError, gitPush, gitSetPushRemote } from './gitActions.js';
import { gitSummary } from './projectContext.js';

const FORSION = 'https://git.forsion.test';
let root: string;
const savedEnv = { ...process.env };
const git = (cwd: string, ...args: string[]): string => execFileSync('git', ['-C', cwd, ...args], { stdio: 'pipe', encoding: 'utf8' }).trim();
const bare = (name: string): string => { const p = path.join(root, `${name}.git`); execFileSync('git', ['init', '-q', '--bare', '-b', 'main', p]); return p; };
const project = (name: string): string => {
  const cwd = path.join(root, name);
  mkdirSync(cwd, { recursive: true });
  git(cwd, 'init', '-q', '-b', 'main');
  writeFileSync(path.join(cwd, 'a.txt'), 'a\n'); git(cwd, 'add', '.'); git(cwd, 'commit', '-qm', 'base');
  return cwd;
};

beforeAll(() => {
  root = mkdtempSync(path.join(tmpdir(), 'tangu-gitremotes-'));
  writeFileSync(path.join(root, 'gitconfig'), '');
  mkdirSync(path.join(root, 'tangu-home'));
  Object.assign(process.env, {
    GIT_CONFIG_GLOBAL: path.join(root, 'gitconfig'), GIT_CONFIG_NOSYSTEM: '1', TANGU_HOME: path.join(root, 'tangu-home'),
    GIT_AUTHOR_NAME: 'Tester', GIT_AUTHOR_EMAIL: 't@example.com', GIT_COMMITTER_NAME: 'Tester', GIT_COMMITTER_EMAIL: 't@example.com',
  });
});
afterAll(() => {
  rmSync(root, { recursive: true, force: true });
  for (const key of Object.keys(process.env)) if (!(key in savedEnv)) delete process.env[key];
  Object.assign(process.env, savedEnv);
});

describe('describeRemote', () => {
  it('站点与凭据分开:github 的 https → github/github;ssh → github/local;Forsion Git 的 https → forsion/forsion;自带凭据的 → local', () => {
    const d = (url: string) => { const r = describeRemote('x', url, url, FORSION); return [r.host, r.auth, r.path, r.web]; };
    expect(d('https://github.com/dave/demo.git')).toEqual(['github', 'github', 'dave/demo', 'https://github.com/dave/demo']);
    expect(d('git@github.com:dave/demo.git')).toEqual(['github', 'local', 'dave/demo', 'https://github.com/dave/demo']);
    expect(d('ssh://git@github.com/dave/demo.git')).toEqual(['github', 'local', 'dave/demo', 'https://github.com/dave/demo']);
    expect(d(`${FORSION}/parmer/notes.git`)).toEqual(['forsion', 'forsion', 'parmer/notes', `${FORSION}/parmer/notes`]);
    expect(d('https://me:tok@github.com/dave/demo.git')).toEqual(['github', 'local', 'dave/demo', 'https://github.com/dave/demo']);
    expect(d('https://gitlab.com/group/sub/repo.git')).toEqual(['other', 'local', 'group/sub/repo', 'https://gitlab.com/group/sub/repo']);
    expect(d('git@gitlab.com:group/repo.git')).toEqual(['other', 'local', 'group/repo', null]); // 别的站的 ssh 拼不出网页
    expect(d('/tmp/some/repo.git')).toEqual(['other', 'local', null, null]);
    // 没有 Forsion Git(没登录)→ 那个主机就是 other、凭据 local
    const off = describeRemote('x', `${FORSION}/parmer/notes.git`, '', null);
    expect([off.host, off.auth]).toEqual(['other', 'local']);
  });
});

describe('pushRemoteOf / remoteNameFor', () => {
  it('推送去向:上游配置 → origin → 唯一那个 → null', () => {
    expect(pushRemoteOf(['origin', 'github'], 'github')).toBe('github');
    expect(pushRemoteOf(['origin', 'github'], '')).toBe('origin');
    expect(pushRemoteOf(['github'], '')).toBe('github');
    expect(pushRemoteOf(['github', 'forsion'], '')).toBeNull();
    expect(pushRemoteOf(['github', 'forsion'], 'gone')).toBeNull(); // 上游指着已经删掉的远端
    expect(pushRemoteOf(['origin'], '--upload-pack=x')).toBe('origin');
    expect(pushRemoteOf([], '')).toBeNull();
  });

  it('新远端的名字:没有 → origin;有了 → 按站点 / 主机名,撞名加 -2', () => {
    expect(remoteNameFor('github', [])).toBe('origin');
    expect(remoteNameFor('github', ['origin'])).toBe('github');
    expect(remoteNameFor('forsion', ['origin', 'forsion', 'forsion-2'])).toBe('forsion-3');
    expect(remoteNameFor('https://gitlab.com/a/b.git', ['origin'])).toBe('gitlab');
    expect(remoteNameFor('git@git.example.com:a/b.git', ['origin'])).toBe('example');
    expect(remoteNameFor('https://10.0.0.5/a/b.git', ['origin'])).toBe('remote');
  });
});

describe('面板与推送', () => {
  it('远端不叫 origin 时照样列出来、推送去向算得出;几个都不叫 origin、没上游 → 去向 null', async () => {
    const cwd = project('not-origin');
    git(cwd, 'remote', 'add', 'github', bare('not-origin-a'));
    let g = await gitSummary(cwd);
    expect({ remote: g.remote, remotes: g.remotes, names: g.remoteList?.map((r) => r.name), push: g.pushRemote }).toEqual({ remote: null, remotes: 1, names: ['github'], push: 'github' });
    git(cwd, 'remote', 'add', 'forsion', bare('not-origin-b'));
    g = await gitSummary(cwd);
    expect({ names: g.remoteList?.map((r) => r.name), push: g.pushRemote }).toEqual({ names: ['forsion', 'github'], push: null });
  });

  it('「以后推送到这里」只改上游配置、不推;远端上还没有这条分支时去向照样是它;「只推送这一次」推到点名的远端、不动上游', async () => {
    const cwd = project('targets');
    const a = bare('targets-a'); const b = bare('targets-b');
    git(cwd, 'remote', 'add', 'origin', a); git(cwd, 'push', '-q', '-u', 'origin', 'main');
    git(cwd, 'remote', 'add', 'backup', b);
    expect((await gitSummary(cwd)).pushRemote).toBe('origin');

    expect(await gitSetPushRemote(cwd, 'backup')).toEqual({ remote: 'backup', branch: 'main' });
    expect(git(b, 'branch', '--list')).toBe(''); // 没推
    const g = await gitSummary(cwd);
    expect({ push: g.pushRemote, upstream: g.upstream }).toEqual({ push: 'backup', upstream: null }); // @{u} 还解析不出来

    await gitSetPushRemote(cwd, 'origin');
    writeFileSync(path.join(cwd, 'b.txt'), 'b\n'); git(cwd, 'add', '.'); git(cwd, 'commit', '-qm', 'second');
    const once = await gitPush(cwd, undefined, 'backup', { once: true });
    expect(once).toMatchObject({ remote: 'backup', target: 'backup/main' });
    expect(git(b, 'rev-parse', 'main')).toBe(git(cwd, 'rev-parse', 'HEAD'));
    expect(git(cwd, 'config', 'branch.main.remote')).toBe('origin'); // 上游没动

    // 分支原来没有上游(.merge 也没有):「以后推送到这里」之后,不点名的推送真的去了那里,面板说的也是它
    git(cwd, 'checkout', '-q', '-b', 'topic');
    await gitSetPushRemote(cwd, 'backup');
    expect((await gitSummary(cwd)).pushRemote).toBe('backup');
    expect(await gitPush(cwd)).toMatchObject({ remote: 'backup', target: 'backup/topic' });
    expect(git(b, 'branch', '--list', 'topic')).toContain('topic');
    expect(git(a, 'branch', '--list', 'topic')).toBe('');
    // 只配了 .remote、没有 .merge(手改的配置):gitPush 不跟它走(推到 origin),面板说的也得是 origin
    git(cwd, 'checkout', '-q', '-b', 'odd');
    git(cwd, 'config', 'branch.odd.remote', 'backup');
    expect((await gitSummary(cwd)).pushRemote).toBe('origin');
    expect(await gitPush(cwd)).toMatchObject({ remote: 'origin', target: 'origin/odd' });
    git(cwd, 'checkout', '-q', 'main');

    for (const bad of ['nope', '--upload-pack=x', '', 42]) {
      await expect(gitSetPushRemote(cwd, bad), String(bad)).rejects.toMatchObject({ code: 'no_remote' });
    }
    expect(git(cwd, 'config', 'branch.main.remote')).toBe('origin');
    git(cwd, 'checkout', '-q', '--detach');
    await expect(gitSetPushRemote(cwd, 'backup')).rejects.toBeInstanceOf(GitActionError);
  });
});
