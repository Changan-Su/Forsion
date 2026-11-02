/**
 * 连接器(连接器方案 2026-10-23「要补的两样」):mcp.json 里带 `connector` 标记的条目,由宿主从后台目录连上。
 *   - alwaysAsk:目录条目里列的远端工具名走「每次都问」(declaredApproval → 'always')。只认带标记的 mcp.json 条目,
 *     名单只从本机目录缓存(connector-catalog.json,桌面主进程写、受保护配置)读,mcp.json 里写了也不算。
 *     缓存读不到 / 解析不了 / 找不到这个 id → 按「每次都问」(读失败 ≠ 空名单)。
 *   - 用户自带 Key:地址模板里的 `{userKey}` 只在连接时换成本机 connector-auth.json 里的 Key(oauth.ts),
 *     mcp.json、日志、报错、回给模型的内容里只出现模板(redactKey)。
 * 本模块不引 manager / deps:toolRegistry 经 setMcpApprovalLookup 注册的回调问 manager,免得循环引用。
 */
import { readFileSync } from 'node:fs';
import { connectorCatalogFile } from '../core/tanguHome.js';

export const USER_KEY = '{userKey}';
export const isUserKeyUrl = (url: string | undefined): boolean => !!url && url.includes(USER_KEY);
export const fillUserKey = (url: string, key: string): string => url.split(USER_KEY).join(encodeURIComponent(key));
const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
/** 文本里出现的 Key 一律换回占位符。形态:原文、encodeURIComponent、URL 序列化再编码的 !'()*、JSON 转义;百分号编码不分大小写。 */
export function redactKey(text: string, key: string | undefined): string {
  if (!key) return text;
  const enc = encodeURIComponent(key);
  const forms = [key, enc, enc.replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`), JSON.stringify(key).slice(1, -1), key.replace(/\//g, '\\/')];
  const re = new RegExp([...new Set(forms)].sort((a, b) => b.length - a.length).map(escapeRe).join('|'), 'gi'); // 不分大小写:%2f 与 %2F 同一个 Key(字母部分顺带也不分,多遮不漏)
  return text.replace(re, USER_KEY);
}

/** 目录缓存里 id → alwaysAsk 名单;读不到 / 坏了 = null(不知道)。
 *  ponytail: 每次审批判定读一次文件(几 KB);真成了瓶颈再按 mtime 缓存。 */
export function catalogAlwaysAsk(): Map<string, string[]> | null {
  try {
    const raw = JSON.parse(readFileSync(connectorCatalogFile(), 'utf8'));
    if (!Array.isArray(raw?.connectors)) return null;
    const out = new Map<string, string[]>();
    for (const c of raw.connectors) {
      if (typeof c?.id !== 'string') continue;
      out.set(c.id, Array.isArray(c.alwaysAsk) ? c.alwaysAsk.filter((x: unknown) => typeof x === 'string') : []);
    }
    return out;
  } catch {
    return null;
  }
}

/** 连接器条目上的这个远端工具要不要每次都问。 */
/** remoteNames = 这个桥接名在本进程里指过的所有远端工具(工具列表变了、快照里冻着的还是旧的那个):任一被列进就算。 */
export function connectorToolAlwaysAsk(connectorId: string, remoteNames: Iterable<string> | undefined): boolean {
  const list = catalogAlwaysAsk()?.get(connectorId);
  const names = remoteNames ? [...remoteNames] : [];
  if (!list || !names.length) return true;
  return names.some((n) => list.includes(n));
}

const lookups = new Set<(bridgedName: string) => 'always' | undefined>();
/** manager 注册:桥接名 → 'always'(连接器 alwaysAsk)/ undefined。返回注销函数。多个 manager 并存时任一说 always 就算(只收紧)。 */
export function setMcpApprovalLookup(fn: (bridgedName: string) => 'always' | undefined): () => void {
  lookups.add(fn);
  return () => { lookups.delete(fn); };
}
export const mcpDeclaredApproval = (name: string): 'always' | undefined =>
  name.startsWith('mcp__') && [...lookups].some((f) => f(name) === 'always') ? 'always' : undefined;
