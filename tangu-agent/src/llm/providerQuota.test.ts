import { afterEach, describe, expect, it, vi } from 'vitest';
import { clearProviderQuotaCache, fetchProviderQuota, parseCodexUsage, parseDeepSeekBalance, parseMoonshotBalance, parseOpenRouterKey, quotaSource } from './providerQuota.js';

describe('providerQuota', () => {
  it('Codex /wham/usage:两个窗口按长度排、reset_at 秒转毫秒;null 窗口跳过', () => {
    // 10-27 dev 账号实测形状(prolite 只有 primary = 每周)
    const one = parseCodexUsage({ plan_type: 'prolite', rate_limit: { primary_window: { used_percent: 6, limit_window_seconds: 604800, reset_after_seconds: 479773, reset_at: 1793606445 }, secondary_window: null } });
    expect(one).toEqual({ plan: 'prolite', windows: [{ seconds: 604800, usedPercent: 6, resetAt: 1793606445000 }] });
    const two = parseCodexUsage({ rate_limit: { primary_window: { used_percent: 61, limit_window_seconds: 604800, reset_at: 2 }, secondary_window: { used_percent: 38, limit_window_seconds: 18000, reset_after_seconds: 60 } } }, 1000);
    expect(two?.windows?.map((w) => [w.seconds, w.usedPercent, w.resetAt])).toEqual([[18000, 38, 61000], [604800, 61, 2000]]);
    expect(parseCodexUsage({ rate_limit: { primary_window: null, secondary_window: null } })).toBeNull();
  });

  it('余额:DeepSeek 优先人民币、Kimi 按域名定币种、OpenRouter 没上限不显示', () => {
    expect(parseDeepSeekBalance({ is_available: true, balance_infos: [{ currency: 'USD', total_balance: '1.00' }, { currency: 'CNY', total_balance: '42.18' }] })).toEqual({ balance: { currency: 'CNY', amount: 42.18 } });
    expect(parseDeepSeekBalance({ balance_infos: [] })).toBeNull();
    expect(parseMoonshotBalance({ data: { available_balance: 49.58894 } }, 'api.moonshot.cn')).toEqual({ balance: { currency: 'CNY', amount: 49.58894 } });
    expect(parseMoonshotBalance({ data: { available_balance: 3 } }, 'api.moonshot.ai')?.balance?.currency).toBe('USD');
    expect(parseOpenRouterKey({ data: { limit_remaining: 7.5 } })).toEqual({ balance: { currency: 'USD', amount: 7.5 } });
    expect(parseOpenRouterKey({ data: { limit_remaining: null } })).toBeNull();
  });

  it('来源按协议 / 域名认:Codex 带 account id,其余不认识的(含 xAI、OpenAI、SiliconFlow)不查', () => {
    const codex = quotaSource({ baseUrl: 'https://chatgpt.com/backend-api/codex', apiKey: 't', protocol: 'openai-responses', oauth: true, accountId: 'acc' });
    expect(codex?.url).toBe('https://chatgpt.com/backend-api/wham/usage');
    expect(codex?.headers['chatgpt-account-id']).toBe('acc');
    expect(quotaSource({ baseUrl: 'https://api.deepseek.com', apiKey: 'k' })?.url).toBe('https://api.deepseek.com/user/balance');
    expect(quotaSource({ baseUrl: 'https://api.moonshot.cn/v1', apiKey: 'k' })?.url).toBe('https://api.moonshot.cn/v1/users/me/balance');
    expect(quotaSource({ baseUrl: 'https://openrouter.ai/api/v1', apiKey: 'k' })?.url).toBe('https://openrouter.ai/api/v1/key');
    for (const baseUrl of ['https://cli-chat-proxy.grok.com/v1', 'https://api.openai.com/v1', 'https://api.siliconflow.cn/v1', 'not a url']) {
      expect(quotaSource({ baseUrl, apiKey: 'k' })).toBeNull();
    }
    expect(quotaSource({ baseUrl: 'https://api.deepseek.com' })).toBeNull(); // 没 key 不查
  });

  afterEach(() => { vi.unstubAllGlobals(); clearProviderQuotaCache(); });

  it('缓存按凭证分桶:同账号 5 分钟内复用,换订阅账号立刻重查(评审 P2)', async () => {
    const used: Record<string, number> = { A: 10, B: 80 };
    const fetchMock = vi.fn(async (_url: string, init: any) => new Response(JSON.stringify({
      rate_limit: { primary_window: { used_percent: used[init.headers['chatgpt-account-id']], limit_window_seconds: 604800, reset_at: 1 } },
    })));
    vi.stubGlobal('fetch', fetchMock);
    const codex = (accountId: string) => ({ providerId: 'codex', baseUrl: 'https://chatgpt.com/backend-api/codex', apiKey: `tok-${accountId}`, protocol: 'openai-responses' as const, oauth: true, accountId });
    expect((await fetchProviderQuota(codex('A')))?.windows?.[0].usedPercent).toBe(10);
    expect((await fetchProviderQuota(codex('A')))?.windows?.[0].usedPercent).toBe(10);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect((await fetchProviderQuota(codex('B')))?.windows?.[0].usedPercent).toBe(80);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
