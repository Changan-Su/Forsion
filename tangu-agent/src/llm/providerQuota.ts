/**
 * 直连 provider 的额度 / 余额查询(输入框上下文环弹层用,10-27)。只读,按 provider 缓存 5 分钟。
 *
 * 支持的来源(10-27 实测 / 官方文档):
 *   - Codex 订阅:GET chatgpt.com/backend-api/wham/usage(Codex CLI 同一路径)→ 5 小时 / 每周窗口的已用 % 与重置时刻
 *   - DeepSeek:GET {origin}/user/balance → 余额(含赠送)
 *   - Kimi(Moonshot):GET {origin}/v1/users/me/balance → 可用余额(.cn 人民币、其余美元)
 *   - OpenRouter:GET {origin}/api/v1/key → 这把 key 的剩余额度(没设上限 = null,不显示)
 * 不支持:xAI 订阅(/v1/billing 只回 used、单位未校准、没有上限)、Anthropic / OpenAI 普通 key(没有余额接口)、
 * SiliconFlow(/v1/user/info 已 410 下线)。查不到一律返回 null,调用方不显示,不报错。
 */
import { createHash } from 'node:crypto';
import type { DirectProvider } from './providerRegistry.js';
import type { ProviderQuota, QuotaWindow } from '../contracts/clientTypes.js';

export type { ProviderQuota, QuotaWindow };

const TTL_MS = 5 * 60_000;
// ponytail: 换号 / 续期后旧桶不删,只是不再命中;条目数 = 凭证变更次数,引擎重启清零
const cache = new Map<string, { at: number; value: ProviderQuota | null }>();

const num = (v: unknown): number | null => {
  const n = typeof v === 'string' ? Number(v) : v;
  return typeof n === 'number' && Number.isFinite(n) ? n : null;
};

/** Codex /wham/usage → 窗口列表(primary / secondary 任一为 null 就跳过,prolite 只有每周那一个)。 */
export function parseCodexUsage(j: any, now = Date.now()): Omit<ProviderQuota, 'providerId' | 'fetchedAt'> | null {
  const rl = j?.rate_limit;
  const windows: QuotaWindow[] = [];
  for (const w of [rl?.primary_window, rl?.secondary_window]) {
    const used = num(w?.used_percent), secs = num(w?.limit_window_seconds);
    if (used === null || secs === null) continue;
    const at = num(w?.reset_at), after = num(w?.reset_after_seconds);
    windows.push({ seconds: secs, usedPercent: Math.max(0, Math.min(100, used)), resetAt: at !== null ? at * 1000 : after !== null ? now + after * 1000 : undefined });
  }
  if (!windows.length) return null;
  windows.sort((a, b) => a.seconds - b.seconds);
  return { plan: typeof j?.plan_type === 'string' ? j.plan_type : undefined, windows };
}

export function parseDeepSeekBalance(j: any): Omit<ProviderQuota, 'providerId' | 'fetchedAt'> | null {
  const infos: any[] = Array.isArray(j?.balance_infos) ? j.balance_infos : [];
  // 一个账号可能同时有人民币和美元两条;优先人民币(国内站的主币种),没有再取第一条
  const b = infos.find((x) => x?.currency === 'CNY') ?? infos[0];
  const amount = num(b?.total_balance);
  return amount === null ? null : { balance: { currency: String(b.currency || 'CNY'), amount } };
}

export function parseMoonshotBalance(j: any, host: string): Omit<ProviderQuota, 'providerId' | 'fetchedAt'> | null {
  const amount = num(j?.data?.available_balance);
  return amount === null ? null : { balance: { currency: host.endsWith('.cn') ? 'CNY' : 'USD', amount } };
}

export function parseOpenRouterKey(j: any): Omit<ProviderQuota, 'providerId' | 'fetchedAt'> | null {
  const amount = num(j?.data?.limit_remaining);
  return amount === null ? null : { balance: { currency: 'USD', amount } };
}

type Source = { url: string; headers: Record<string, string>; parse: (j: any) => Omit<ProviderQuota, 'providerId' | 'fetchedAt'> | null };

/** provider → 查询方式;不支持返回 null。按协议 / 域名认,不按 providerId(用户可以随便起名)。 */
export function quotaSource(p: Pick<DirectProvider, 'baseUrl' | 'apiKey' | 'protocol' | 'accountId' | 'oauth'>): Source | null {
  if (!p.apiKey) return null;
  const auth = { Authorization: `Bearer ${p.apiKey}` };
  if (p.oauth && p.protocol === 'openai-responses') {
    // Codex 订阅:token 与 account id 成对
    return {
      url: 'https://chatgpt.com/backend-api/wham/usage',
      headers: { ...auth, ...(p.accountId ? { 'chatgpt-account-id': p.accountId } : {}) },
      parse: (j) => parseCodexUsage(j),
    };
  }
  let u: URL;
  try { u = new URL(p.baseUrl); } catch { return null; }
  const host = u.hostname;
  if (host === 'api.deepseek.com') return { url: `${u.origin}/user/balance`, headers: auth, parse: parseDeepSeekBalance };
  if (/^api\.moonshot\.(cn|ai)$/.test(host)) return { url: `${u.origin}/v1/users/me/balance`, headers: auth, parse: (j) => parseMoonshotBalance(j, host) };
  if (host === 'openrouter.ai') return { url: `${u.origin}/api/v1/key`, headers: auth, parse: parseOpenRouterKey };
  return null;
}

/** 查一个 provider 的额度;不支持 / 失败返回 null。5 分钟内复用上次结果(失败也缓存,免得每次点开都打一遍上游)。 */
export async function fetchProviderQuota(p: DirectProvider): Promise<ProviderQuota | null> {
  // 按凭证分桶:换了订阅账号 / 换了 key 不能拿旧账号的数(只存 key 的摘要,不把明文当 Map 键)
  const key = `${p.providerId}:${p.accountId ?? ''}:${createHash('sha256').update(p.apiKey ?? '').digest('hex').slice(0, 16)}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.value;
  const src = quotaSource(p);
  let value: ProviderQuota | null = null;
  if (src) {
    try {
      const r = await fetch(src.url, { headers: src.headers, signal: AbortSignal.timeout(8_000) });
      const parsed = r.ok ? src.parse(await r.json()) : null;
      if (parsed) value = { providerId: p.providerId, ...parsed, fetchedAt: Date.now() };
    } catch { /* 网络 / 解析失败 → null */ }
  }
  cache.set(key, { at: Date.now(), value });
  return value;
}

/** 测试用。 */
export function clearProviderQuotaCache(): void { cache.clear(); }
