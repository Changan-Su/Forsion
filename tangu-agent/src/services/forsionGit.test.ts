/**
 * Forsion Git 的凭据提供方(假的云端接缝 + 假时钟,不连网):
 *   - 站点信息:缓存;不是 https / 不发凭据 / 没配 → 没有;读不到当作没有、一段时间内不再试;过期后先用旧值、后台刷新
 *   - 只认领站点自己的 origin;别的主机一概不问云端要凭据
 *   - 凭据只取一次、进程内一直用;并发的两次共用一个请求(同设备名再要一次会让前一枚作废)
 *   - 被拒 → 只作废「被拒的那一枚」再重取;已经换过新的就不动
 *   - 409 GIT_NEEDS_SETUP → forsion_git_needs_setup(到此为止,detail = 站点地址;不缓存,用户去网页登录后马上能再试)
 *   - 429 → forsion_git_rate_limited(这次照没有凭据跑),两分钟内不再向服务端要;过后才再试
 *   - 够不着 / 5xx / 登录失效 → forsion_git_unavailable(同上,退避 30 秒);503 = 这里不发凭据 → 不认领、不带话
 *   - 装上 / 卸掉:没有云端 git 服务(没登录)时接缝上没有这个提供方
 *
 * 负对照(2026-10-10 各改一处实跑,对应的用例红):
 *   - hosting 里去掉 `now() - known.at < infoTtlMs` 的缓存判断(每次都读)→ 「站点信息缓存」红
 *   - readInfo 的失败分支不记 failedAt → 「读不到当作没有,一段时间内不再试」红
 *   - credentials 里去掉 `site.origin === origin` → 「别的主机不认领」红
 *   - credential 里去掉 `if (cached) return cached` → 「凭据只取一次」红
 *   - credential 里把 `flight ??=` 改成每次新发 → 「并发共用一个请求」红
 *   - invalidate 不比对、一律清空 → 「已经换过新的就不动」红
 *   - 409 分支删掉(落到 unavailable)→ 「needs_setup」红
 *   - 429 不退避(block 的时长写成 0)→ 「429 … 两分钟内不再要」红
 *   - 503 分支删掉 → 「503 = 不认领」红
 *   - hosting 过期后等刷新回来(不先用旧值)→ 「过期后先用旧值」红
 *   - installForsionGit 不往接缝上登记 → 「装上 / 卸掉」红
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { GitHostingError, type GitHostingBrain, type GitHostingInfo } from '../seams/cloudBrain.js';
import { FORSION_GIT_PROVIDER_ID, createForsionGit, forsionGit, installForsionGit } from './forsionGit.js';
import { GitCredentialError, gitCredentialEnv, resetGitCredentialProvidersForTest } from './gitCredentials.js';

const WEB = 'https://git.forsion.test';
const HOSTED: GitHostingInfo = { configured: true, webUrl: `${WEB}/`, credentials: true };

function fake(over: { info?: () => Promise<GitHostingInfo>; credential?: (device: string) => Promise<{ webUrl: string; username: string; password: string }> } = {}) {
  let minted = 0;
  const clock = { t: 1_000_000 };
  const brain = {
    info: vi.fn(over.info ?? (async () => HOSTED)),
    credential: vi.fn(over.credential ?? (async () => ({ webUrl: WEB, username: 'dave', password: `tok-${++minted}` }))),
  } satisfies GitHostingBrain;
  const git = createForsionGit(brain, { device: 'test-mac', now: () => clock.t });
  return { brain, git, clock };
}
const failure = async (p: Promise<unknown>): Promise<GitCredentialError> => {
  try { await p; } catch (e) { if (e instanceof GitCredentialError) return e; throw e; }
  throw new Error('expected a GitCredentialError');
};

afterEach(() => { installForsionGit(undefined); resetGitCredentialProvidersForTest(); });

describe('站点信息', () => {
  it('站点信息缓存:十分钟内只读一次;地址去掉尾斜杠', async () => {
    const { brain, git, clock } = fake();
    expect(await git.hosting()).toEqual({ webUrl: WEB, origin: WEB });
    clock.t += 9 * 60_000;
    expect(await git.hosting()).toEqual({ webUrl: WEB, origin: WEB });
    expect(brain.info).toHaveBeenCalledTimes(1);
  });

  it('没配 / 不发凭据 / 站点不是 https → 没有', async () => {
    for (const info of [{ configured: false }, { configured: true, webUrl: WEB, credentials: false }, { configured: true, webUrl: 'http://git.forsion.test', credentials: true }] as GitHostingInfo[]) {
      const { git, brain } = fake({ info: async () => info });
      expect(await git.hosting(), JSON.stringify(info)).toBeNull();
      expect(await git.provider.credentials(WEB)).toBeNull();
      expect(brain.credential).not.toHaveBeenCalled();
    }
  });

  it('读不到当作没有,一段时间内不再试;过了再试,读到了就有', async () => {
    let down = true;
    const { brain, git, clock } = fake({ info: async () => { if (down) throw new GitHostingError(0, 'NETWORK'); return HOSTED; } });
    expect(await git.hosting()).toBeNull();
    expect(await git.provider.credentials(WEB)).toBeNull();
    expect(brain.info).toHaveBeenCalledTimes(1); // 第二次没有再去读
    down = false;
    clock.t += 61_000;
    expect(await git.hosting()).toEqual({ webUrl: WEB, origin: WEB });
    expect(brain.info).toHaveBeenCalledTimes(2);
  });

  it('过期后先用旧值、后台刷新;刷新失败继续用旧值', async () => {
    let answer: () => Promise<GitHostingInfo> = async () => HOSTED;
    const { brain, git, clock } = fake({ info: () => answer() });
    await git.hosting();
    clock.t += 11 * 60_000;
    let release!: (info: GitHostingInfo) => void;
    answer = () => new Promise((resolve) => { release = resolve; });
    expect(await git.hosting()).toEqual({ webUrl: WEB, origin: WEB }); // 没等那次刷新
    expect(brain.info).toHaveBeenCalledTimes(2);
    release({ configured: false });
    await new Promise((r) => setTimeout(r, 0));
    expect(await git.hosting()).toBeNull(); // 刷新的结果生效了
    answer = async () => { throw new GitHostingError(502, ''); };
    clock.t += 11 * 60_000;
    expect(await git.hosting()).toBeNull();
  });
});

describe('推拉凭据', () => {
  it('别的主机不认领,也不向云端要凭据', async () => {
    const { brain, git } = fake();
    expect(await git.provider.credentials('https://github.com')).toBeNull();
    expect(await git.provider.credentials('https://git.forsion.test:8443')).toBeNull();
    expect(brain.credential).not.toHaveBeenCalled();
  });

  it('凭据只取一次、进程内一直用;设备名传给云端', async () => {
    const { brain, git, clock } = fake();
    expect(await git.provider.credentials(WEB)).toEqual({ username: 'dave', password: 'tok-1' });
    clock.t += 3 * 60 * 60_000;
    expect(await git.provider.credentials(WEB)).toEqual({ username: 'dave', password: 'tok-1' });
    expect(brain.credential).toHaveBeenCalledTimes(1);
    expect(brain.credential).toHaveBeenCalledWith('test-mac');
  });

  it('并发共用一个请求(各要各的会让先到的那一枚作废)', async () => {
    const { brain, git } = fake();
    const [a, b, c] = await Promise.all([git.provider.credentials(WEB), git.provider.credentials(WEB), git.account()]);
    expect([a?.password, b?.password, c?.username]).toEqual(['tok-1', 'tok-1', 'dave']);
    expect(brain.credential).toHaveBeenCalledTimes(1);
  });

  it('被拒 → 作废那一枚再重取;已经换过新的就不动', async () => {
    const { brain, git } = fake();
    const first = (await git.provider.credentials(WEB))!;
    git.provider.invalidate!(WEB, first);
    const second = (await git.provider.credentials(WEB))!;
    expect(second.password).toBe('tok-2');
    // 另一个并发的动作此时才报「tok-1 被拒」:手里已经是 tok-2,不该再作废、再要一枚(那会让 tok-2 也失效)
    git.provider.invalidate!(WEB, first);
    expect((await git.provider.credentials(WEB))!.password).toBe('tok-2');
    expect(brain.credential).toHaveBeenCalledTimes(2);
  });

  it('409 GIT_NEEDS_SETUP → forsion_git_needs_setup,到此为止,detail 是站点地址;不缓存', async () => {
    let ready = false;
    const { brain, git } = fake({ credential: async () => { if (!ready) throw new GitHostingError(409, 'GIT_NEEDS_SETUP', 'https://git.forsion.test/'); return { webUrl: WEB, username: 'dave', password: 'tok-1' }; } });
    const e = await failure(git.provider.credentials(WEB));
    expect({ code: e.code, detail: e.detail, fallback: e.fallback }).toEqual({ code: 'forsion_git_needs_setup', detail: 'https://git.forsion.test/', fallback: false });
    ready = true; // 用户去网页登录了一次
    expect((await git.provider.credentials(WEB))!.password).toBe('tok-1');
    expect(brain.credential).toHaveBeenCalledTimes(2);
  });

  it('429 → forsion_git_rate_limited(这次照没有凭据跑),两分钟内不再向服务端要;过后再试', async () => {
    let limited = true;
    const { brain, git, clock } = fake({ credential: async () => { if (limited) throw new GitHostingError(429, 'GIT_CREDENTIAL_RATE_LIMITED'); return { webUrl: WEB, username: 'dave', password: 'tok-1' }; } });
    const e = await failure(git.provider.credentials(WEB));
    expect({ code: e.code, fallback: e.fallback }).toEqual({ code: 'forsion_git_rate_limited', fallback: true });
    limited = false;
    clock.t += 90_000;
    expect((await failure(git.provider.credentials(WEB))).code).toBe('forsion_git_rate_limited');
    expect(brain.credential).toHaveBeenCalledTimes(1);
    clock.t += 31_000;
    expect((await git.provider.credentials(WEB))!.password).toBe('tok-1');
    expect(brain.credential).toHaveBeenCalledTimes(2);
  });

  it('够不着 / 5xx / 登录失效 → forsion_git_unavailable(fallback),退避 30 秒', async () => {
    for (const err of [new GitHostingError(0, 'NETWORK'), new GitHostingError(502, 'GIT_UNAVAILABLE'), new GitHostingError(401, ''), new Error('boom')]) {
      const { brain, git, clock } = fake({ credential: async () => { throw err; } });
      const e = await failure(git.provider.credentials(WEB));
      expect({ code: e.code, fallback: e.fallback }, String(err)).toEqual({ code: 'forsion_git_unavailable', fallback: true });
      await failure(git.provider.credentials(WEB));
      expect(brain.credential).toHaveBeenCalledTimes(1);
      clock.t += 31_000;
      await failure(git.provider.credentials(WEB));
      expect(brain.credential).toHaveBeenCalledTimes(2);
    }
  });

  it('503 = 这里不发凭据 → 不认领、不带话', async () => {
    const { brain, git } = fake({ credential: async () => { throw new GitHostingError(503, 'GIT_CREDENTIALS_NOT_CONFIGURED'); } });
    expect(await git.provider.credentials(WEB)).toBeNull();
    expect(await git.provider.credentials(WEB)).toBeNull();
    expect(await git.account()).toBeNull();
    expect(brain.credential).toHaveBeenCalledTimes(1);
  });
});

describe('装上 / 卸掉', () => {
  it('有云端 git 服务 → 接缝上认领站点的远端;没有(没登录)→ 接缝上没有它', async () => {
    const { brain } = fake();
    expect(installForsionGit(brain, { device: 'test-mac' })).not.toBeNull();
    expect(forsionGit()).not.toBeNull();
    expect(await gitCredentialEnv(`${WEB}/dave/hello.git`, {})).toMatchObject({ providerId: FORSION_GIT_PROVIDER_ID, credential: { username: 'dave', password: 'tok-1' } });
    expect(await gitCredentialEnv('https://github.com/dave/hello.git', {})).toEqual({ env: {}, secrets: [] });
    expect(installForsionGit(undefined)).toBeNull();
    expect(forsionGit()).toBeNull();
    expect(await gitCredentialEnv(`${WEB}/dave/hello.git`, {})).toEqual({ env: {}, secrets: [] });
  });
});
