/**
 * standalone 本地联网搜索(BYO-key)—— server 端 webSearchService 的引擎侧镜像。
 *
 * 场景:未登录 Forsion 或想用自己 key 的用户。配置在 config.json 的 `webSearch` 段:
 *   { "provider": "auto"|"bocha"|"tavily"|"zhipu"|"duckduckgo",
 *     "bochaApiKey": string, "tavilyApiKey": string, "zhipuApiKey": string }
 *
 * 路由语义见 multiBrain:本地配置了 provider → 本地直搜;否则走云 brain;云不可用 → 本地
 * DuckDuckGo 免费兜底。运行时降级与 server 同款:选中 provider 失败 → 其余已配 key → DDG。
 *
 * provider 协议实现须与 server/microserver/brain-api/services/webSearchService.ts 保持一致(两份)。
 * ponytail: 不支持 outbound proxy —— 引擎零新依赖(Node 裸 fetch 无 ProxyAgent);大陆用户
 * 用国内 provider(博查/智谱)即可,需要代理再引 undici。
 */
import { getRawSection } from '../../core/config.js';

export type LocalSearchProvider = 'auto' | 'bocha' | 'tavily' | 'zhipu' | 'duckduckgo';

export interface LocalWebSearchConfig {
  provider: LocalSearchProvider;
  bochaApiKey: string | null;
  tavilyApiKey: string | null;
  zhipuApiKey: string | null;
}

export type SearchHit = { title: string; url?: string; snippet?: string };
export type SearchOk = { provider: string; text: string; results: SearchHit[] };

const SEARCH_TIMEOUT_MS = 8_000;

const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : null);

/** 读 config.json webSearch 段并归一化;段缺失 → 全空(auto)。 */
export function loadLocalWebSearchConfig(): LocalWebSearchConfig {
  const raw = getRawSection('webSearch');
  const o = raw && typeof raw === 'object' ? raw : {};
  const p = String(o.provider ?? 'auto');
  return {
    provider: (['auto', 'bocha', 'tavily', 'zhipu', 'duckduckgo'] as const).includes(p as any) ? (p as LocalSearchProvider) : 'auto',
    bochaApiKey: str(o.bochaApiKey),
    tavilyApiKey: str(o.tavilyApiKey),
    zhipuApiKey: str(o.zhipuApiKey),
  };
}

/** 用户是否显式配置了本地搜索(任一 key,或明选了具体 provider)。auto 且无 key = 未配置。 */
export function hasLocalSearchProvider(cfg: LocalWebSearchConfig): boolean {
  return !!(cfg.bochaApiKey || cfg.tavilyApiKey || cfg.zhipuApiKey) || cfg.provider !== 'auto';
}

function pickProvider(cfg: LocalWebSearchConfig): Exclude<LocalSearchProvider, 'auto'> {
  if (cfg.provider !== 'auto') return cfg.provider;
  if (cfg.bochaApiKey) return 'bocha';
  if (cfg.tavilyApiKey) return 'tavily';
  if (cfg.zhipuApiKey) return 'zhipu';
  return 'duckduckgo';
}

/** 降级顺序:选中者打头 → 其余已配 key → DDG 垫底。纯函数,导出供测试。 */
export function candidateOrder(cfg: LocalWebSearchConfig): Exclude<LocalSearchProvider, 'auto'>[] {
  const primary = pickProvider(cfg);
  const rest: Exclude<LocalSearchProvider, 'auto'>[] = [];
  if (cfg.bochaApiKey) rest.push('bocha');
  if (cfg.tavilyApiKey) rest.push('tavily');
  if (cfg.zhipuApiKey) rest.push('zhipu');
  rest.push('duckduckgo');
  return [primary, ...rest.filter((p) => p !== primary)];
}

// ── provider 实现(与 server 同协议)──────────────────────────────────────────

async function searchBocha(query: string, maxResults: number, apiKey: string): Promise<SearchOk> {
  const r = await fetch('https://api.bochaai.com/v1/web-search', {
    method: 'POST',
    signal: AbortSignal.timeout(SEARCH_TIMEOUT_MS),
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({ query, count: maxResults, summary: true, freshness: 'noLimit' }),
  });
  if (!r.ok) throw new Error(`Bocha HTTP ${r.status} — ${(await r.text().catch(() => '')).slice(0, 200)}`);
  const j: any = await r.json();
  const results: SearchHit[] = (j?.data?.webPages?.value || []).slice(0, maxResults).map((p: any) => ({
    title: p.name || p.title || '', url: p.url, snippet: p.summary || p.snippet,
  }));
  return { provider: 'bocha', text: formatHits('Bocha', results), results };
}

async function searchTavily(query: string, maxResults: number, apiKey: string): Promise<SearchOk> {
  const r = await fetch('https://api.tavily.com/search', {
    method: 'POST',
    signal: AbortSignal.timeout(SEARCH_TIMEOUT_MS),
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ api_key: apiKey, query, max_results: maxResults, include_answer: true, search_depth: 'basic' }),
  });
  if (!r.ok) throw new Error(`Tavily HTTP ${r.status} — ${(await r.text().catch(() => '')).slice(0, 200)}`);
  const j: any = await r.json();
  const results: SearchHit[] = (j?.results || []).slice(0, maxResults).map((p: any) => ({
    title: p.title, url: p.url, snippet: p.content,
  }));
  const parts: string[] = [];
  if (typeof j?.answer === 'string' && j.answer.trim()) parts.push(`Answer: ${j.answer}`);
  if (results.length) parts.push(formatHits('Tavily', results));
  return { provider: 'tavily', text: parts.length ? parts.join('\n\n') : 'No results found.', results };
}

async function searchZhipu(query: string, maxResults: number, apiKey: string): Promise<SearchOk> {
  const r = await fetch('https://open.bigmodel.cn/api/paas/v4/web_search', {
    method: 'POST',
    signal: AbortSignal.timeout(SEARCH_TIMEOUT_MS),
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({ search_query: query, search_engine: 'search-std', count: maxResults }),
  });
  if (!r.ok) throw new Error(`Zhipu HTTP ${r.status} — ${(await r.text().catch(() => '')).slice(0, 200)}`);
  const j: any = await r.json();
  const items = j?.search_result || j?.data?.search_result || [];
  const results: SearchHit[] = items.slice(0, maxResults).map((p: any) => ({
    title: p.title, url: p.link || p.url, snippet: p.content || p.snippet,
  }));
  return { provider: 'zhipu', text: formatHits('Zhipu', results), results };
}

async function searchDuckDuckGo(query: string, maxResults: number): Promise<SearchOk> {
  // Instant Answer 先;无 abstract/answer/related 落 html.duckduckgo.com 爬结果页。
  const r = await fetch(`https://api.duckduckgo.com/?q=${encodeURIComponent(query)}&format=json&no_html=1&skip_disambig=1`, {
    signal: AbortSignal.timeout(SEARCH_TIMEOUT_MS),
    headers: { Accept: 'application/json', 'User-Agent': 'Tangu-WebAccess/1.0' },
  }).catch(() => null);

  const data: any = r && r.ok ? await r.json().catch(() => ({})) : {};
  const related: SearchHit[] = [];
  const flatten = (topics: any[]) => {
    for (const t of topics) {
      if (t?.Text) related.push({ title: t.Text, url: t.FirstURL });
      if (Array.isArray(t?.Topics)) flatten(t.Topics);
    }
  };
  if (Array.isArray(data?.RelatedTopics)) flatten(data.RelatedTopics);

  const textParts: string[] = [];
  if (typeof data?.AbstractText === 'string' && data.AbstractText.trim()) {
    textParts.push(data.AbstractURL ? `${data.AbstractText}\nSource: ${data.AbstractURL}` : data.AbstractText);
  }
  if (typeof data?.Answer === 'string' && data.Answer.trim()) textParts.push(`Answer: ${data.Answer}`);
  let finalResults = related.slice(0, maxResults);
  if (finalResults.length) {
    textParts.push(`Related results:\n${finalResults.map((it) => `- ${it.title}${it.url ? ` (${it.url})` : ''}`).join('\n')}`);
  }

  if (textParts.length === 0) {
    const htmlR = await fetch(`https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`, {
      signal: AbortSignal.timeout(SEARCH_TIMEOUT_MS),
      headers: {
        Accept: 'text/html,application/xhtml+xml',
        'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
        'User-Agent': 'Mozilla/5.0 (compatible; Tangu-WebAccess/1.0)',
      },
    });
    if (htmlR.ok) {
      const out = parseDdgHtml(await htmlR.text(), maxResults);
      if (out.length) {
        finalResults = out;
        textParts.push(formatHits('', out));
      }
    }
  }

  return {
    provider: textParts.length === 0 || related.length === 0 ? 'duckduckgo_html' : 'duckduckgo_instant_answer',
    text: textParts.length ? textParts.join('\n\n') : 'No results found.',
    results: finalResults,
  };
}

/** DDG 结果页解析(与 server 同一正则);导出供测试。 */
export function parseDdgHtml(html: string, maxResults: number): SearchHit[] {
  const re = /<a[^>]+class="result__a"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>[\s\S]*?(?:<a[^>]+class="result__snippet"[^>]*>([\s\S]*?)<\/a>|<div[^>]+class="result__snippet"[^>]*>([\s\S]*?)<\/div>)?/gi;
  const decode = (s: string) => s
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(parseInt(d, 10)));
  const stripHtml = (s: string) => decode(s.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim());
  const normalizeUrl = (raw: string) => {
    try {
      const u = new URL(decode(raw), 'https://duckduckgo.com');
      return u.searchParams.get('uddg') ? decodeURIComponent(u.searchParams.get('uddg')!) : u.toString();
    } catch { return decode(raw); }
  };
  const out: SearchHit[] = [];
  for (const m of html.matchAll(re)) {
    const title = stripHtml(m[2] ?? '');
    const url = normalizeUrl(m[1] ?? '');
    const snippet = (m[3] ?? m[4]) ? stripHtml(m[3] ?? m[4] ?? '') : undefined;
    if (!title || !url) continue;
    out.push({ title, url, snippet });
    if (out.length >= maxResults) break;
  }
  return out;
}

function formatHits(label: string, results: SearchHit[]): string {
  if (!results.length) return 'No results found.';
  const head = label ? `Search results (${label}):` : 'Search results:';
  return `${head}\n${results
    .map((it, i) => `${i + 1}. ${it.title}\n  ${it.url}${it.snippet ? `\n  ${it.snippet}` : ''}`)
    .join('\n')}`;
}

async function runProvider(which: Exclude<LocalSearchProvider, 'auto'>, cfg: LocalWebSearchConfig, query: string, maxResults: number): Promise<SearchOk> {
  switch (which) {
    case 'bocha':
      if (!cfg.bochaApiKey) throw new Error('Bocha selected but no API key configured');
      return searchBocha(query, maxResults, cfg.bochaApiKey);
    case 'tavily':
      if (!cfg.tavilyApiKey) throw new Error('Tavily selected but no API key configured');
      return searchTavily(query, maxResults, cfg.tavilyApiKey);
    case 'zhipu':
      if (!cfg.zhipuApiKey) throw new Error('Zhipu selected but no API key configured');
      return searchZhipu(query, maxResults, cfg.zhipuApiKey);
    default:
      return searchDuckDuckGo(query, maxResults);
  }
}

/** 本地搜索入口:降级链 + 注记。cfgOverride 供「云不可用 → 强制 DDG 兜底」等场景。 */
export async function runLocalSearch(query: string, maxResults: number, cfgOverride?: Partial<LocalWebSearchConfig>): Promise<SearchOk> {
  const cfg: LocalWebSearchConfig = { ...loadLocalWebSearchConfig(), ...cfgOverride };
  const failures: string[] = [];
  for (const which of candidateOrder(cfg)) {
    try {
      const out = await runProvider(which, cfg, query, maxResults);
      if (failures.length) {
        out.text = `[web_search note] primary provider failed (${failures.join('; ')}); results served by ${out.provider}.\n\n${out.text}`;
      }
      return out;
    } catch (e) {
      failures.push(`${which}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  throw new Error(`All local search providers failed — ${failures.join(' | ')}`);
}

/** 设置页「连通性测试」:只测指定 provider,不降级、不落盘。apiKey 传 '__keep__' 用已存 key。 */
export async function testLocalSearch(input: { provider: LocalSearchProvider; apiKey?: string }): Promise<{
  ok: boolean; provider: string; latencyMs: number; resultCount?: number; sampleTitle?: string; error?: string;
}> {
  const stored = loadLocalWebSearchConfig();
  const key = input.apiKey === '__keep__' || input.apiKey === undefined ? undefined : (input.apiKey || null);
  const cfg: LocalWebSearchConfig = {
    ...stored,
    provider: input.provider,
    ...(input.provider === 'bocha' && key !== undefined ? { bochaApiKey: key } : {}),
    ...(input.provider === 'tavily' && key !== undefined ? { tavilyApiKey: key } : {}),
    ...(input.provider === 'zhipu' && key !== undefined ? { zhipuApiKey: key } : {}),
  };
  const which = input.provider === 'auto' ? pickProvider(cfg) : input.provider;
  const start = Date.now();
  try {
    const out = await runProvider(which, cfg, 'forsion connectivity test', 3);
    return { ok: true, provider: out.provider, latencyMs: Date.now() - start, resultCount: out.results.length, sampleTitle: out.results[0]?.title };
  } catch (e) {
    return { ok: false, provider: which, latencyMs: Date.now() - start, error: e instanceof Error ? e.message : String(e) };
  }
}

/** 设置页 GET 用:key 只回 hasKey 布尔,永不回明文。 */
export function redactedLocalConfig(): {
  provider: LocalSearchProvider; bochaHasKey: boolean; tavilyHasKey: boolean; zhipuHasKey: boolean; effectiveProvider: string; configured: boolean;
} {
  const cfg = loadLocalWebSearchConfig();
  return {
    provider: cfg.provider,
    bochaHasKey: !!cfg.bochaApiKey,
    tavilyHasKey: !!cfg.tavilyApiKey,
    zhipuHasKey: !!cfg.zhipuApiKey,
    effectiveProvider: pickProvider(cfg),
    configured: hasLocalSearchProvider(cfg),
  };
}
