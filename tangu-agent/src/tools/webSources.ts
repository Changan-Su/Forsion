/**
 * 网页来源的结构化一份(搜索来源编号,借鉴 DeepSeek chat-demo 方案 ②A):
 * web_search 的每个结果、web_fetch 读到的那一页,另存成 { url, title, site, date, snippet },
 * 经 ctx.noteWebSources 落进 ToolResult.metadata.sources。**不进模型上下文** —— 模型那份仍是工具返回的文字,
 * historyReplay 回放逐字不变。渲染层拿它给正文链接编号、出来源卡、在右栏「来源」里列结果。
 */
import type { WebSource } from '../contracts/clientTypes.js';

/** 只有这两个内置工具在执行时拿得到 noteWebSources(registry.executeTool 按名字挂)。 */
export const WEB_SOURCE_TOOLS: ReadonlySet<string> = new Set(['web_search', 'web_fetch']);

const MAX_SOURCES = 20;
const URL_MAX = 2048;
const TITLE_MAX = 200;
const SNIPPET_MAX = 400;

const clip = (v: unknown, max: number): string | undefined => {
  if (typeof v !== 'string') return undefined;
  const s = v.replace(/\s+/g, ' ').trim();
  if (!s) return undefined;
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
};

/** 搜索服务 / 网页 meta 里五花八门的日期 → YYYY-MM-DD;认不出、年份离谱就不要。 */
export function normalizeSourceDate(v: unknown): string | undefined {
  if (typeof v !== 'string' && typeof v !== 'number') return undefined;
  const s = String(v).trim();
  if (!s || s.length > 64) return undefined;
  const ymd = /^(\d{4})-(\d{2})-(\d{2})(?:$|[T\s])/.exec(s);
  if (ymd) {
    const [, y, m, d] = ymd;
    const yy = Number(y);
    return yy >= 1990 && yy <= 2100 && Number(m) >= 1 && Number(m) <= 12 && Number(d) >= 1 && Number(d) <= 31 ? `${y}-${m}-${d}` : undefined;
  }
  const t = Date.parse(s);
  if (!Number.isFinite(t)) return undefined;
  const dt = new Date(t);
  const y = dt.getUTCFullYear();
  if (y < 1990 || y > 2100) return undefined;
  return `${y}-${String(dt.getUTCMonth() + 1).padStart(2, '0')}-${String(dt.getUTCDate()).padStart(2, '0')}`;
}

/** 一条原始结果(搜索 hit 或自己拼的页) → WebSource;不是 http(s) 公网地址形状的不要。 */
export function toWebSource(raw: any): WebSource | null {
  if (!raw || typeof raw !== 'object') return null;
  const url = typeof raw.url === 'string' ? raw.url.trim() : '';
  if (!url || url.length > URL_MAX || !/^https?:\/\//i.test(url)) return null;
  let host: string;
  try { host = new URL(url).hostname; } catch { return null; }
  const out: WebSource = { url, site: host.replace(/^www\./i, '').toLowerCase() };
  const title = clip(raw.title, TITLE_MAX);
  if (title) out.title = title;
  const date = normalizeSourceDate(raw.date ?? raw.datePublished ?? raw.published_date ?? raw.publishedDate ?? raw.publish_date);
  if (date) out.date = date;
  const snippet = clip(raw.snippet, SNIPPET_MAX);
  if (snippet) out.snippet = snippet;
  return out;
}

/** 一串结果 → 去重(同一 URL 留第一条)、封顶的 WebSource[]。 */
export function webSourcesOf(list: unknown): WebSource[] {
  if (!Array.isArray(list)) return [];
  const seen = new Set<string>();
  const out: WebSource[] = [];
  for (const raw of list) {
    const s = toWebSource(raw);
    if (!s || seen.has(s.url)) continue;
    seen.add(s.url);
    out.push(s);
    if (out.length >= MAX_SOURCES) break;
  }
  return out;
}
