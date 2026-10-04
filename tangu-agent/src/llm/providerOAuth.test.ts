import { describe, it, expect, afterEach, vi } from 'vitest';
import { fetchProviderModels, loadOAuthDirectProviders, freshOAuthCred, OAUTH_PROVIDERS, CODEX_MODELS_CLIENT_VERSION } from './providerOAuth.js';
import { GROK_BUILD_CLIENT_IDENTIFIER, GROK_BUILD_CLIENT_MODE, GROK_BUILD_CLIENT_VERSION } from './grokBuildCompat.js';
import { loadProviderCreds, saveProviderCred, type OAuthTokens } from '../standalone/providerCreds.js';

vi.mock('../standalone/providerCreds.js', () => {
  const loadProviderCreds = vi.fn();
  const saveProviderCred = vi.fn();
  // 与真实现同语义的替身:fn 拿盘上此刻那条,返回新记录才写(锁与原子落位另由 providerCreds.test.ts 测)。
  const updateProviderCred = vi.fn((id: string, fn: (cur: unknown) => unknown) => { const next = fn(loadProviderCreds()?.[id]); if (next) saveProviderCred(id, next); });
  return { loadProviderCreds, saveProviderCred, updateProviderCred };
});

describe('fetchProviderModels', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('parses { data: [{ id }] } (Claude / OpenAI shape)', async () => {
    vi.stubGlobal('fetch', () => Promise.resolve({ ok: true, json: () => Promise.resolve({ data: [{ id: 'claude-x' }, { id: 'claude-y' }] }) }));
    const r = await fetchProviderModels({ protocol: 'anthropic-messages', baseUrl: 'https://api.anthropic.com' } as any, 'tok');
    expect(r).toEqual(['claude-x', 'claude-y']);
  });

  it('parses [{ slug, visibility }] and drops hidden (Codex shape); URL carries client_version', async () => {
    let calledUrl = '';
    vi.stubGlobal('fetch', (url: string) => {
      calledUrl = url;
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ // 真实端点顶层是 { models: [...] }(2026-07-17 实测),非裸数组
          models: [
            { slug: 'gpt-6.1-sol', visibility: 'list' },
            { slug: 'gpt-6-astra', visibility: 'list' },
            { slug: 'gpt-6-astra', visibility: 'list' },
            { slug: 'gpt-5.6-sol', visibility: 'list' },
            { slug: 'codex-auto-review', visibility: 'hide' },
            { slug: 'internal-model', visibility: 'hidden' },
          ],
        }),
      });
    });
    const r = await fetchProviderModels({ protocol: 'openai-responses', baseUrl: 'https://chatgpt.com/backend-api/codex' } as any, 'tok', 'acct');
    expect(r).toEqual(['gpt-6.1-sol', 'gpt-6-astra', 'gpt-5.6-sol']);
    // 回归:Codex 后端缺 client_version query 直接 400 → 实拉永远失败,用户被冻结在硬编快照上看不到新模型。
    expect(new URL(calledUrl).searchParams.get('client_version')).toBe('0.159.2'); // 0.155.1 的目录里没有 gpt-6.1-sol
  });

  it('returns null on http error (→ caller falls back to curated hints)', async () => {
    vi.stubGlobal('fetch', () => Promise.resolve({ ok: false, json: () => Promise.resolve({}) }));
    const r = await fetchProviderModels({ protocol: 'openai', baseUrl: 'https://api.x.ai/v1' } as any, 'tok');
    expect(r).toBeNull();
  });

  it('Grok Build 模型目录走 CLI proxy 的 OAuth 请求头', async () => {
    let calledUrl = '';
    let calledInit: any;
    vi.stubGlobal('fetch', (url: string, init: any) => {
      calledUrl = url;
      calledInit = init;
      return Promise.resolve({ ok: true, json: () => Promise.resolve({ data: [{ id: 'grok-build' }] }) });
    });
    const r = await fetchProviderModels(OAUTH_PROVIDERS.xai, 'grok-token');
    expect(r).toEqual(['grok-build']);
    expect(calledUrl).toBe('https://cli-chat-proxy.grok.com/v1/models');
    expect(calledInit.headers).toMatchObject({
      Authorization: 'Bearer grok-token',
      'X-XAI-Token-Auth': 'xai-grok-cli',
      'x-grok-client-version': GROK_BUILD_CLIENT_VERSION,
      'x-grok-client-identifier': GROK_BUILD_CLIENT_IDENTIFIER,
      'x-grok-client-mode': GROK_BUILD_CLIENT_MODE,
      'User-Agent': `grok-shell/${GROK_BUILD_CLIENT_VERSION}`,
    });
  });
});

describe('Codex 模型目录缓存升级', () => {
  afterEach(() => { vi.unstubAllGlobals(); vi.clearAllMocks(); });

  const credential = (extra: Partial<OAuthTokens> = {}): OAuthTokens => ({
    access_token: 'test-token', baseUrl: OAUTH_PROVIDERS.codex.baseUrl,
    tokenEndpoint: OAUTH_PROVIDERS.codex.tokenEndpoint!, clientId: OAUTH_PROVIDERS.codex.clientId,
    account_id: 'test-account', modelIds: ['gpt-5.6-sol'], modelIdsAt: Date.now(), ...extra,
  });

  it.each([undefined, '0.150.0', '0.153.4', '0.155.1'])('刚缓存的旧目录(version=%s)也立即刷新并记录版本', async (version) => {
    vi.mocked(loadProviderCreds).mockReturnValue({ codex: credential({ modelIdsClientVersion: version }) });
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ models: [{ slug: 'gpt-6.1-sol', visibility: 'list' }] }) });
    vi.stubGlobal('fetch', fetchMock);
    const providers = await loadOAuthDirectProviders();
    expect(providers[0].modelIds).toEqual(['gpt-6.1-sol']);
    expect(fetchMock.mock.calls[0][1].headers['chatgpt-account-id']).toBe('test-account');
    expect(saveProviderCred).toHaveBeenCalledWith('codex', expect.objectContaining({
      modelIds: ['gpt-6.1-sol'], modelIdsClientVersion: CODEX_MODELS_CLIENT_VERSION,
    }));
  });

  it('当前版本的有效缓存不重复拉取,也不把兜底模型强塞进账号目录', async () => {
    vi.mocked(loadProviderCreds).mockReturnValue({ codex: credential({ modelIdsClientVersion: CODEX_MODELS_CLIENT_VERSION }) });
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    expect((await loadOAuthDirectProviders())[0].modelIds).toEqual(['gpt-5.6-sol']);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(saveProviderCred).not.toHaveBeenCalled();
  });

  it('当前版本缓存超过 24h 仍刷新', async () => {
    vi.mocked(loadProviderCreds).mockReturnValue({ codex: credential({ modelIdsClientVersion: CODEX_MODELS_CLIENT_VERSION, modelIdsAt: Date.now() - 25 * 3600_000 }) });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => ({ data: [{ id: 'gpt-6-astra' }] }) }));
    expect((await loadOAuthDirectProviders())[0].modelIds).toEqual(['gpt-6-astra']);
  });

  it('刷新失败保留旧目录且不盖版本,下次仍会重试;无缓存时才用兜底', async () => {
    vi.mocked(loadProviderCreds).mockReturnValue({ codex: credential() });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false }));
    expect((await loadOAuthDirectProviders())[0].modelIds).toEqual(['gpt-5.6-sol']);
    expect(saveProviderCred).not.toHaveBeenCalled();
    vi.mocked(loadProviderCreds).mockReturnValue({ codex: credential({ modelIds: undefined }) });
    expect((await loadOAuthDirectProviders())[0].modelIds).toContain('gpt-6-astra');
    expect((await loadOAuthDirectProviders())[0].modelIds).toContain('gpt-6.1-sol');
  });

  it('其他 provider 的有效缓存不受 Codex 目录版本影响', async () => {
    vi.mocked(loadProviderCreds).mockReturnValue({ xai: credential({ baseUrl: OAUTH_PROVIDERS.xai.baseUrl, modelIds: ['grok-4.6'] }) });
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    expect((await loadOAuthDirectProviders())[0].modelIds).toEqual(['grok-4.6']);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('旧 xAI 凭证迁移到 Grok Build proxy 并替换旧模型 slug', async () => {
    vi.mocked(loadProviderCreds).mockReturnValue({ xai: {
      access_token: 'grok-token',
      baseUrl: 'https://api.x.ai/v1',
      tokenEndpoint: 'https://auth.x.ai/oauth2/token',
      clientId: OAUTH_PROVIDERS.xai.clientId,
      modelIds: ['grok-build-0.1'],
      modelIdsAt: Date.now(),
    } });
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const providers = await loadOAuthDirectProviders();
    expect(providers[0]).toMatchObject({
      baseUrl: 'https://cli-chat-proxy.grok.com/v1',
      protocol: 'grok-build',
      modelIds: ['grok-build'],
    });
    expect(saveProviderCred).toHaveBeenCalledWith('xai', expect.objectContaining({
      baseUrl: 'https://cli-chat-proxy.grok.com/v1',
      modelIds: ['grok-build'],
    }));
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('freshOAuthCred(取用前续期;反馈 6a239e58:token 只在启动时续一次,后端跑过 6h 后 grok 全 502)', () => {
  afterEach(() => { vi.unstubAllGlobals(); vi.clearAllMocks(); });

  const xai = (extra: Partial<OAuthTokens> = {}): OAuthTokens => ({
    access_token: 'old', refresh_token: 'r1', expires_at: Date.now() + 3600_000,
    baseUrl: OAUTH_PROVIDERS.xai.baseUrl, tokenEndpoint: OAUTH_PROVIDERS.xai.tokenEndpoint!, clientId: OAUTH_PROVIDERS.xai.clientId,
    modelIds: ['grok-build'], modelIdsAt: Date.now(), ...extra,
  });
  const tokenEndpoint = (body: any) => vi.fn().mockResolvedValue({ json: async () => body });
  const token = async (force = false) => (await freshOAuthCred('xai', force))?.access_token;

  it('没到期 → 原样返回,不打网络不写盘', async () => {
    vi.mocked(loadProviderCreds).mockReturnValue({ xai: xai() });
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    expect(await token()).toBe('old');
    expect(fetchMock).not.toHaveBeenCalled();
    expect(saveProviderCred).not.toHaveBeenCalled();
  });

  it('快到期 → 续期,只换 token 三件套(模型目录等以盘上最新为准);令牌端点带超时', async () => {
    const stale = xai({ expires_at: Date.now() + 30_000 });
    // 续期期间别处(如模型目录懒刷)改了同一条记录的其它字段
    vi.mocked(loadProviderCreds).mockReturnValueOnce({ xai: stale }).mockReturnValue({ xai: { ...stale, modelIds: ['grok-4.7'] } });
    const fetchMock = tokenEndpoint({ access_token: 'new', refresh_token: 'r2', expires_in: 3600 });
    vi.stubGlobal('fetch', fetchMock);
    expect(await token()).toBe('new');
    expect(String(fetchMock.mock.calls[0][1].body)).toContain('refresh_token=r1');
    expect(fetchMock.mock.calls[0][1].signal).toBeInstanceOf(AbortSignal); // 挂住的令牌端点不能把所有 run 拖死
    expect(saveProviderCred).toHaveBeenCalledTimes(1);
    expect(saveProviderCred).toHaveBeenCalledWith('xai', expect.objectContaining({ access_token: 'new', refresh_token: 'r2', modelIds: ['grok-4.7'] }));
    expect(vi.mocked(saveProviderCred).mock.calls[0][1].expires_at).toBeGreaterThan(Date.now() + 3000_000);
  });

  it('force:没到期也续(上游已明说凭证失效)', async () => {
    vi.mocked(loadProviderCreds).mockReturnValue({ xai: xai() });
    vi.stubGlobal('fetch', tokenEndpoint({ access_token: 'new', expires_in: 3600 }));
    expect(await token(true)).toBe('new');
    expect(saveProviderCred).toHaveBeenCalledWith('xai', expect.objectContaining({ access_token: 'new', refresh_token: 'r1' }));
  });

  it('续期失败 → 返回旧 token,不写盘', async () => {
    vi.mocked(loadProviderCreds).mockReturnValue({ xai: xai({ expires_at: Date.now() - 1 }) });
    vi.stubGlobal('fetch', tokenEndpoint({ error: 'invalid_grant' }));
    expect(await token()).toBe('old');
    expect(saveProviderCred).not.toHaveBeenCalled();
  });

  it('续期期间盘上记录已被别的进程轮换 → 用盘上那份,不拿自己的盖回去', async () => {
    const stale = xai({ expires_at: Date.now() - 1 });
    vi.mocked(loadProviderCreds).mockReturnValueOnce({ xai: stale }).mockReturnValue({ xai: xai({ access_token: 'theirs', refresh_token: 'r9' }) });
    vi.stubGlobal('fetch', tokenEndpoint({ access_token: 'mine', refresh_token: 'r2', expires_in: 3600 }));
    expect(await token()).toBe('theirs');
    expect(saveProviderCred).not.toHaveBeenCalled();
  });

  it('续期期间记录从盘上消失(登出)→ 不写回去,也不把刚续出来的 token 交出去', async () => {
    vi.mocked(loadProviderCreds).mockReturnValueOnce({ xai: xai({ expires_at: Date.now() - 1 }) }).mockReturnValue({});
    vi.stubGlobal('fetch', tokenEndpoint({ access_token: 'mine', expires_in: 3600 }));
    expect(await freshOAuthCred('xai')).toBeUndefined();
    expect(saveProviderCred).not.toHaveBeenCalled();
  });

  it('并发调用共用一次续期(refresh_token 轮换的端点重复续会把自己踢掉)', async () => {
    vi.mocked(loadProviderCreds).mockReturnValue({ xai: xai({ expires_at: Date.now() - 1 }) });
    const fetchMock = tokenEndpoint({ access_token: 'new', refresh_token: 'r2', expires_in: 3600 });
    vi.stubGlobal('fetch', fetchMock);
    expect(await Promise.all([token(), token(), token(true)])).toEqual(['new', 'new', 'new']);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('返回整条凭证:Codex 的 account id 与 token 成对(别的进程换号登录后不能新 token 配旧账号)', async () => {
    vi.mocked(loadProviderCreds).mockReturnValue({ codex: { ...xai({ access_token: 'tok-b' }), account_id: 'acct-b' } });
    expect(await freshOAuthCred('codex')).toMatchObject({ access_token: 'tok-b', account_id: 'acct-b' });
  });

  it('不是订阅登录的 provider / 没登录 → undefined', async () => {
    vi.mocked(loadProviderCreds).mockReturnValue({ xai: xai() });
    expect(await freshOAuthCred('openai')).toBeUndefined();
    expect(await freshOAuthCred('codex')).toBeUndefined();
  });
});
