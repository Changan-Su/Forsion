/**
 * Chat 链接富卡数据(假的 fetcher + 假时钟,不连网;SSRF 那组走真的 fetchPublic,被闸在连接之前):
 *   - URL → 认得的 PR / issue;别的主机、http、带口令、路径穿越、伪装的主机名一律不认 → 不发请求
 *   - 请求只发往 api.github.com 与 Forsion Git 站点自己的 /api/v1
 *   - JSON → 卡片:合并 / 关闭 / 草稿 / 打开;issues 接口问到的 PR 认成 PR
 *   - 缓存按「用户 + 地址」;拿到的一直用,没拿到的 60 秒后再问
 *   - 绑了 GitHub 用 Bearer、Forsion Git 用 Basic;带令牌被拒 → 匿名再问一次
 *
 * 负对照(2026-10-24 实跑):fetchCapped 里给 fetchPublic 换一个不校验的解析器 → SSRF 那条红(本机端口收到 1 次连接)。
 * 只看「返回 null」不够:没有闸时连接被拒也是 null,所以那条数的是连接。
 */
import net from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { linkPreview, previewOf, repoItemOf, resetLinkPreviewCacheForTest, type PreviewFetcher } from './linkPreview.js';
import { registerGitCredentialProvider, resetGitCredentialProvidersForTest } from './gitCredentials.js';

const FG = 'https://git.forsion.net';
const PR = { title: 'Chat: quote tiles', state: 'closed', merged: true, merged_at: '2026-10-23T08:00:00Z', created_at: '2026-10-20T08:00:00Z', user: { login: 'Changan-Su' }, additions: 412, deletions: 186, changed_files: 12, comments: 3 };

function fakeFetch(reply: (url: string, headers: Record<string, string>) => { status: number; body?: unknown }) {
  const calls: Array<{ url: string; headers: Record<string, string> }> = [];
  const fetcher: PreviewFetcher = async (url, headers) => {
    calls.push({ url, headers });
    const r = reply(url, headers);
    return { status: r.status, text: r.body === undefined ? '' : JSON.stringify(r.body) };
  };
  return { fetcher, calls };
}

afterEach(() => { resetLinkPreviewCacheForTest(); resetGitCredentialProvidersForTest(); });

describe('repoItemOf', () => {
  it('认 GitHub 的 PR / issue(子页、查询串、锚点照认)', () => {
    expect(repoItemOf('https://github.com/Changan-Su/Forsion/pull/153', null)).toMatchObject({ source: 'github', kind: 'pr', owner: 'Changan-Su', repo: 'Forsion', number: 153, api: 'https://api.github.com/repos/Changan-Su/Forsion/pulls/153' });
    expect(repoItemOf('https://github.com/a/b.c/pull/7/files?w=1#diff', null)?.api).toBe('https://api.github.com/repos/a/b.c/pulls/7');
    expect(repoItemOf('https://www.github.com/a/b/issues/9', null)).toMatchObject({ kind: 'issue', api: 'https://api.github.com/repos/a/b/issues/9' });
  });

  it('认 Forsion Git 站点下的 pulls / issues(站点可以带路径)', () => {
    expect(repoItemOf(`${FG}/forsion/genesis/pulls/12`, FG)).toMatchObject({ source: 'forsion-git', kind: 'pr', api: `${FG}/api/v1/repos/forsion/genesis/pulls/12` });
    expect(repoItemOf('https://h.example/git/o/r/issues/3', 'https://h.example/git/')?.api).toBe('https://h.example/git/api/v1/repos/o/r/issues/3');
  });

  it.each([
    ['http 明文', 'http://github.com/a/b/pull/1', null],
    ['带账号口令', 'https://u:p@github.com/a/b/pull/1', null],
    ['伪装主机名', 'https://github.com.evil.example/a/b/pull/1', null],
    ['带端口的 github', 'https://github.com:8443/a/b/pull/1', null],
    ['GitHub 没有 pulls 页', 'https://github.com/a/b/pulls/1', null],
    ['Gitea 没有 pull 页', `${FG}/a/b/pull/1`, FG],
    ['路径穿越', 'https://github.com/../b/pull/1', null],
    ['编码的斜杠', 'https://github.com/a%2f..%2fx/b/pull/1', null],
    ['编号后面接主机', 'https://github.com/a/b/pull/1@evil.example', null],
    ['不是 Forsion Git 的站点', 'https://git.forsion.net.evil.example/a/b/pulls/1', FG],
    ['本机', 'https://localhost/a/b/pulls/1', null],
    ['内网 IP', 'https://10.0.0.1/a/b/pull/1', null],
    ['没有 Forsion Git 时不认', `${FG}/a/b/pulls/1`, null],
    ['普通网页', 'https://example.com/docs/DESIGN.md', FG],
    ['不是网址', 'javascript:alert(1)', FG],
  ])('不认:%s', (_name, href, site) => {
    expect(repoItemOf(href, site)).toBeNull();
  });
});

describe('previewOf', () => {
  const item = repoItemOf('https://github.com/Changan-Su/Forsion/pull/153', null)!;
  it('合并的 PR:状态、作者、合并时刻、几个事实', () => {
    expect(previewOf(item, PR)).toEqual({ source: 'github', kind: 'pr', repo: 'Changan-Su/Forsion', number: 153, title: 'Chat: quote tiles', state: 'merged', author: 'Changan-Su', at: '2026-10-23T08:00:00Z', additions: 412, deletions: 186, changedFiles: 12, comments: 3 });
  });
  it('关闭 / 草稿 / 打开', () => {
    expect(previewOf(item, { title: 't', state: 'closed', closed_at: 'c', created_at: 'o' })).toMatchObject({ state: 'closed', at: 'c' });
    expect(previewOf(item, { title: 't', state: 'open', draft: true, created_at: 'o' })).toMatchObject({ state: 'draft', at: 'o' });
    expect(previewOf(item, { title: 't', state: 'open', created_at: 'o' })).toMatchObject({ state: 'open', at: 'o' });
  });
  it('issues 接口问到的是 PR → 认成 PR,合并状态从 pull_request 里取', () => {
    const issue = repoItemOf('https://github.com/a/b/issues/5', null)!;
    expect(previewOf(issue, { title: 't', state: 'closed', pull_request: { merged_at: 'm' } })).toMatchObject({ kind: 'pr', state: 'merged', at: 'm' });
  });
  it('没有标题 / 不是对象 → null', () => {
    expect(previewOf(item, { message: 'Not Found' })).toBeNull();
    expect(previewOf(item, null)).toBeNull();
  });
});

describe('linkPreview', () => {
  const url = 'https://github.com/Changan-Su/Forsion/pull/153';

  it('认不得的链接不发请求', async () => {
    const f = fakeFetch(() => ({ status: 200, body: PR }));
    for (const href of ['https://example.com/a', 'http://127.0.0.1/a/b/pull/1', 'https://localhost/a/b/pulls/1', 'https://[::1]/a/b/pull/1']) {
      expect(await linkPreview('u', href, { fetcher: f.fetcher, forsionGitWebUrl: FG })).toBeNull();
    }
    expect(f.calls).toEqual([]);
  });

  it('请求只发往 api.github.com / Forsion Git 的 /api/v1,带 UA', async () => {
    const f = fakeFetch(() => ({ status: 200, body: PR }));
    await linkPreview('u', url, { fetcher: f.fetcher, forsionGitWebUrl: FG });
    await linkPreview('u', `${FG}/forsion/genesis/issues/2`, { fetcher: f.fetcher, forsionGitWebUrl: FG });
    expect(f.calls.map((c) => c.url)).toEqual(['https://api.github.com/repos/Changan-Su/Forsion/pulls/153', `${FG}/api/v1/repos/forsion/genesis/issues/2`]);
    expect(f.calls[0]!.headers['user-agent']).toBeTruthy();
    expect(f.calls[0]!.headers.authorization).toBeUndefined();
  });

  it('缓存:同一用户第二次不再请求,并发共用一次;换个用户各问各的', async () => {
    const f = fakeFetch(() => ({ status: 200, body: PR }));
    const opts = { fetcher: f.fetcher, forsionGitWebUrl: null };
    const [a, b] = await Promise.all([linkPreview('u', url, opts), linkPreview('u', url, opts)]);
    expect(a?.state).toBe('merged');
    expect(b).toEqual(a);
    await linkPreview('u', url, opts);
    expect(f.calls).toHaveLength(1);
    await linkPreview('v', url, opts);
    expect(f.calls).toHaveLength(2);
  });

  it('没拿到(限流)→ null,60 秒内用缓存,之后再问', async () => {
    let t = 1000;
    let status = 403;
    const f = fakeFetch(() => ({ status, body: status === 200 ? PR : undefined }));
    const opts = { fetcher: f.fetcher, forsionGitWebUrl: null, now: () => t };
    expect(await linkPreview('u', url, opts)).toBeNull();
    await new Promise((r) => setTimeout(r, 0));
    t += 30_000;
    expect(await linkPreview('u', url, opts)).toBeNull();
    expect(f.calls).toHaveLength(1);
    t += 31_000;
    status = 200;
    expect((await linkPreview('u', url, opts))?.title).toBe('Chat: quote tiles');
    expect(f.calls).toHaveLength(2);
  });

  it('坏 JSON / 抛错 → null,不外抛', async () => {
    const bad: PreviewFetcher = async () => ({ status: 200, text: '<html>' });
    expect(await linkPreview('u', url, { fetcher: bad, forsionGitWebUrl: null })).toBeNull();
    const boom: PreviewFetcher = async () => { throw new Error('too large'); };
    expect(await linkPreview('w', url, { fetcher: boom, forsionGitWebUrl: null })).toBeNull();
  });

  it('绑了 GitHub:带 Bearer;被拒(401)→ 匿名再问一次', async () => {
    registerGitCredentialProvider('github', async (origin) => (origin === 'https://github.com' ? { username: 'x-access-token', password: 'gho_secret' } : null));
    const f = fakeFetch((_u, h) => (h.authorization ? { status: 401 } : { status: 200, body: PR }));
    expect((await linkPreview('u', url, { fetcher: f.fetcher, forsionGitWebUrl: null }))?.state).toBe('merged');
    expect(f.calls.map((c) => c.headers.authorization)).toEqual(['Bearer gho_secret', undefined]);
  });

  it('Forsion Git:用推拉那一枚(Basic),GitHub 的令牌不会带过去', async () => {
    registerGitCredentialProvider('github', async (origin) => (origin === 'https://github.com' ? { username: 'gh', password: 'gho_secret' } : null));
    registerGitCredentialProvider('forsion-git', async (origin) => (origin === FG ? { username: 'skyler', password: 'tok' } : null));
    const f = fakeFetch(() => ({ status: 200, body: PR }));
    await linkPreview('u', `${FG}/forsion/genesis/pulls/12`, { fetcher: f.fetcher, forsionGitWebUrl: FG });
    expect(f.calls[0]!.headers.authorization).toBe(`Basic ${Buffer.from('skyler:tok').toString('base64')}`);
  });

  it('取凭据抛错 → 匿名照问', async () => {
    registerGitCredentialProvider('github', async () => { throw new Error('cloud down'); });
    const f = fakeFetch(() => ({ status: 200, body: PR }));
    expect(await linkPreview('u', url, { fetcher: f.fetcher, forsionGitWebUrl: null })).not.toBeNull();
    expect(f.calls[0]!.headers.authorization).toBeUndefined();
  });

  it('取凭据挂住 → 等够就匿名去问,不把总时限耗光', async () => {
    registerGitCredentialProvider('github', () => new Promise(() => {}));
    const f = fakeFetch(() => ({ status: 200, body: PR }));
    const t0 = Date.now();
    expect(await linkPreview('u', url, { fetcher: f.fetcher, forsionGitWebUrl: null, authWaitMs: 50 })).not.toBeNull();
    expect(Date.now() - t0).toBeLessThan(1000);
    expect(f.calls[0]!.headers.authorization).toBeUndefined();
  });

  it('SSRF:站点地址指向本机 / 内网时,真的 fetchPublic 在连接之前拒掉 → null(本机监听的端口一次连接都没收到)', async () => {
    let hits = 0;
    const server = net.createServer((s) => { hits++; s.destroy(); });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const port = (server.address() as net.AddressInfo).port;
    try {
      for (const site of [`https://127.0.0.1:${port}`, 'https://10.1.2.3:3000', 'https://[::1]']) {
        expect(await linkPreview('u', `${site}/o/r/pulls/1`, { forsionGitWebUrl: site })).toBeNull();
      }
      expect(hits).toBe(0);
    } finally {
      server.close();
    }
  });
});
