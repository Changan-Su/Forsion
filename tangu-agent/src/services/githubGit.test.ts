/**
 * 绑定的 GitHub 账号的凭据提供方(假的云端接缝 + 假时钟,不连网):
 *   - 只认领 https://github.com;别的主机一概不问云端
 *   - 凭据只取一次、进程内一直用;并发的两次共用一个请求
 *   - 没绑(404 GITHUB_NOT_LINKED)/ 绑定失效(409)/ 够不着 → 带话但不拦(fallback),各歇 30 秒;status 读到「已绑定」提前放开
 *   - 云端没开绑定(503)/ 旧云端(404 不带 code)→ 不认领、不带话
 *   - github.com 拒了这一枚 → 作废重取;云端给回同一枚 = 授权被撤 → github_relink_required,不再拿它去撞
 *   - status 读到「没绑定」→ 丢掉手里那一枚
 *   - 装上 / 卸掉:没有云端 github 服务(没登录)时接缝上没有这个提供方
 *
 * 负对照(2026-10-13 各改一处实跑,对应的用例红):
 *   - credentials 里去掉 `origin === GITHUB_ORIGIN` → 「别的主机不认领」红
 *   - credential 里去掉 `if (cached) return cached` → 「凭据只取一次」红
 *   - 404 分支的 fallback 写成 false → 「没绑:带话但不拦」红
 *   - 503 分支删掉(落到 unavailable)→ 「云端没开绑定」红
 *   - `issued.password === rejected` 那一行删掉 → 「给回同一枚 = 授权被撤」红
 *   - status 里不清 blocked → 「读到已绑定提前放开」红
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { GitHostingError, type GithubBrain, type GithubLinkStatus } from '../seams/cloudBrain.js';
import { GitCredentialError, gitCredentialEnv, refreshGitCredential, resetGitCredentialProvidersForTest } from './gitCredentials.js';
import { GITHUB_PROVIDER_ID, createGithubGit, githubGit, githubLinkInfo, installGithubGit } from './githubGit.js';

const REMOTE = 'https://github.com/dave/demo.git';
const LINKED: GithubLinkStatus = { configured: true, linked: true, login: 'dave', avatarUrl: null };

function fakeBrain(over: Partial<{ status: GithubLinkStatus; token: string; fail: GitHostingError | null }> = {}) {
  const state = { status: over.status ?? LINKED, token: over.token ?? 'gho_one', fail: over.fail ?? null as GitHostingError | null };
  const brain: GithubBrain = {
    status: vi.fn(async () => state.status),
    credential: vi.fn(async () => { if (state.fail) throw state.fail; return { username: 'dave', password: state.token }; }),
  };
  return { brain, state };
}
const codeOf = async (p: Promise<unknown>): Promise<{ code: string; fallback: boolean } | null> =>
  p.then(() => null, (e) => (e instanceof GitCredentialError ? { code: e.code, fallback: e.fallback } : null));

afterEach(() => { installGithubGit(undefined); resetGitCredentialProvidersForTest(); });

describe('认领哪些远端', () => {
  it('只认领 https://github.com;别的主机不认领,也不问云端', async () => {
    const { brain } = fakeBrain();
    const git = createGithubGit(brain);
    expect(await git.provider.credentials('https://github.com')).toEqual({ username: 'dave', password: 'gho_one' });
    expect(await git.provider.credentials('https://gitlab.com')).toBeNull();
    expect(await git.provider.credentials('https://github.com.evil.test')).toBeNull();
    expect(brain.credential).toHaveBeenCalledTimes(1);
  });

  it('凭据只取一次、进程内一直用;并发的两次共用一个请求', async () => {
    const { brain } = fakeBrain();
    const git = createGithubGit(brain);
    const [a, b] = await Promise.all([git.credential(), git.credential()]);
    expect(a).toEqual(b);
    await git.credential();
    expect(brain.credential).toHaveBeenCalledTimes(1);
  });
});

describe('取不到凭据', () => {
  it('没绑:带话但不拦(fallback),30 秒内不再问云端;过后再问', async () => {
    let t = 0;
    const { brain, state } = fakeBrain({ fail: new GitHostingError(404, 'GITHUB_NOT_LINKED') });
    const git = createGithubGit(brain, { now: () => t });
    expect(await codeOf(git.credential())).toEqual({ code: 'github_not_linked', fallback: true });
    expect(await codeOf(git.credential())).toEqual({ code: 'github_not_linked', fallback: true });
    expect(brain.credential).toHaveBeenCalledTimes(1);
    t = 31_000; state.fail = null;
    expect(await git.credential()).toEqual({ username: 'dave', password: 'gho_one' });
  });

  it('读到已绑定提前放开:刚在账户中心绑好,回来不用等那 30 秒', async () => {
    const { brain, state } = fakeBrain({ fail: new GitHostingError(404, 'GITHUB_NOT_LINKED'), status: { configured: true, linked: false } });
    const git = createGithubGit(brain, { now: () => 0 });
    expect(await codeOf(git.credential())).toMatchObject({ code: 'github_not_linked' });
    state.fail = null; state.status = LINKED;
    await git.status();
    expect(await git.credential()).toEqual({ username: 'dave', password: 'gho_one' });
  });

  it('绑定失效(409)→ github_relink_required;够不着 → github_unavailable;都不拦', async () => {
    expect(await codeOf(createGithubGit(fakeBrain({ fail: new GitHostingError(409, 'GITHUB_RELINK_REQUIRED') }).brain).credential())).toEqual({ code: 'github_relink_required', fallback: true });
    expect(await codeOf(createGithubGit(fakeBrain({ fail: new GitHostingError(0, 'NETWORK') }).brain).credential())).toEqual({ code: 'github_unavailable', fallback: true });
    expect(await codeOf(createGithubGit(fakeBrain({ fail: new GitHostingError(401, '') }).brain).credential())).toEqual({ code: 'github_unavailable', fallback: true });
  });

  it('云端没开绑定(503)/ 旧云端(404 不带 code)→ 不认领、不带话,十分钟内不再问', async () => {
    for (const fail of [new GitHostingError(503, 'GITHUB_NOT_CONFIGURED'), new GitHostingError(404, '')]) {
      const { brain } = fakeBrain({ fail });
      const git = createGithubGit(brain, { now: () => 0 });
      expect(await git.credential()).toBeNull();
      expect(await git.credential()).toBeNull();
      expect(brain.credential).toHaveBeenCalledTimes(1);
    }
  });
});

describe('github.com 拒了这一枚', () => {
  it('作废重取;云端换了新的就用新的', async () => {
    const { brain, state } = fakeBrain();
    installGithubGit(brain);
    const first = await gitCredentialEnv(REMOTE, {});
    expect(first.providerId).toBe(GITHUB_PROVIDER_ID);
    state.token = 'gho_two';
    const next = await refreshGitCredential(REMOTE, first, {});
    expect(next.credential).toEqual({ username: 'dave', password: 'gho_two' });
  });

  it('给回同一枚 = 授权被撤:带话 github_relink_required,之后也不再拿它去撞;重新绑好(status 已绑定 + 新令牌)后恢复', async () => {
    const { brain, state } = fakeBrain();
    const git = installGithubGit(brain, { now: () => 0 })!;
    const first = await gitCredentialEnv(REMOTE, {});
    const next = await refreshGitCredential(REMOTE, first, {});
    expect(next.credential).toBeUndefined();
    expect(next.unavailable?.code).toBe('github_relink_required');
    expect((await gitCredentialEnv(REMOTE, {})).credential).toBeUndefined();
    state.token = 'gho_new';
    await git.status();
    expect((await gitCredentialEnv(REMOTE, {})).credential).toEqual({ username: 'dave', password: 'gho_new' });
  });
});

describe('界面读的状态', () => {
  it('没装 / 云端没开 → null;开了 → 绑没绑 + 登录名;读不到 → null', async () => {
    expect(await githubLinkInfo()).toBeNull();
    const { brain, state } = fakeBrain();
    installGithubGit(brain);
    expect(await githubLinkInfo()).toEqual({ linked: true, login: 'dave' });
    state.status = { configured: true, linked: false };
    expect(await githubLinkInfo()).toEqual({ linked: false });
    state.status = { configured: false };
    expect(await githubLinkInfo()).toBeNull();
    (brain.status as any).mockRejectedValueOnce(new GitHostingError(0, 'NETWORK'));
    expect(await githubLinkInfo()).toBeNull();
  });

  it('读到没绑定 → 丢掉手里那一枚(在账户中心解绑了)', async () => {
    const { brain, state } = fakeBrain();
    const git = createGithubGit(brain);
    await git.credential();
    state.status = { configured: true, linked: false };
    state.fail = new GitHostingError(404, 'GITHUB_NOT_LINKED');
    await git.status();
    expect(await codeOf(git.credential())).toMatchObject({ code: 'github_not_linked' });
  });

  it('装上 / 卸掉:没有云端 github 服务时接缝上没有这个提供方', async () => {
    installGithubGit(fakeBrain().brain);
    expect(githubGit()).not.toBeNull();
    expect((await gitCredentialEnv(REMOTE, {})).providerId).toBe(GITHUB_PROVIDER_ID);
    installGithubGit(undefined);
    expect(githubGit()).toBeNull();
    expect((await gitCredentialEnv(REMOTE, {})).credential).toBeUndefined();
  });
});
