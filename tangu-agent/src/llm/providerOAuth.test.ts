import { describe, it, expect, afterEach, vi } from 'vitest';
import { fetchProviderModels, loadOAuthDirectProviders, OAUTH_PROVIDERS, CODEX_MODELS_CLIENT_VERSION } from './providerOAuth.js';
import { loadProviderCreds, saveProviderCred, type OAuthTokens } from '../standalone/providerCreds.js';

vi.mock('../standalone/providerCreds.js', () => ({ loadProviderCreds: vi.fn(), saveProviderCred: vi.fn() }));

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
    expect(r).toEqual(['gpt-6-astra', 'gpt-5.6-sol']);
    // 回归:Codex 后端缺 client_version query 直接 400 → 实拉永远失败,用户被冻结在硬编快照上看不到新模型。
    expect(new URL(calledUrl).searchParams.get('client_version')).toBe('0.153.4');
  });

  it('returns null on http error (→ caller falls back to curated hints)', async () => {
    vi.stubGlobal('fetch', () => Promise.resolve({ ok: false, json: () => Promise.resolve({}) }));
    const r = await fetchProviderModels({ protocol: 'openai', baseUrl: 'https://api.x.ai/v1' } as any, 'tok');
    expect(r).toBeNull();
  });
});

describe('Codex 模型目录缓存升级', () => {
  afterEach(() => { vi.unstubAllGlobals(); vi.clearAllMocks(); });

  const credential = (extra: Partial<OAuthTokens> = {}): OAuthTokens => ({
    access_token: 'test-token', baseUrl: OAUTH_PROVIDERS.codex.baseUrl,
    tokenEndpoint: OAUTH_PROVIDERS.codex.tokenEndpoint!, clientId: OAUTH_PROVIDERS.codex.clientId,
    account_id: 'test-account', modelIds: ['gpt-5.6-sol'], modelIdsAt: Date.now(), ...extra,
  });

  it.each([undefined, '0.150.0'])('刚缓存的旧目录(version=%s)也立即刷新并记录版本', async (version) => {
    vi.mocked(loadProviderCreds).mockReturnValue({ codex: credential({ modelIdsClientVersion: version }) });
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ models: [{ slug: 'gpt-6-astra', visibility: 'list' }] }) });
    vi.stubGlobal('fetch', fetchMock);
    const providers = await loadOAuthDirectProviders();
    expect(providers[0].modelIds).toEqual(['gpt-6-astra']);
    expect(fetchMock.mock.calls[0][1].headers['chatgpt-account-id']).toBe('test-account');
    expect(saveProviderCred).toHaveBeenCalledWith('codex', expect.objectContaining({
      modelIds: ['gpt-6-astra'], modelIdsClientVersion: CODEX_MODELS_CLIENT_VERSION,
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
  });

  it('其他 provider 的有效缓存不受 Codex 目录版本影响', async () => {
    vi.mocked(loadProviderCreds).mockReturnValue({ xai: credential({ baseUrl: OAUTH_PROVIDERS.xai.baseUrl, modelIds: ['grok-4.6'] }) });
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    expect((await loadOAuthDirectProviders())[0].modelIds).toEqual(['grok-4.6']);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
