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
/** 文本里出现的 Key(原文与编码后两种形态)一律换回占位符。 */
export function redactKey(text: string, key: string | undefined): string {
  if (!key) return text;
  for (const form of new Set([key, encodeURIComponent(key)])) text = text.split(form).join(USER_KEY);
  return text;
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
export function connectorToolAlwaysAsk(connectorId: string, remoteName: string | undefined): boolean {
  const list = catalogAlwaysAsk()?.get(connectorId);
  if (!list || remoteName === undefined) return true;
  return list.includes(remoteName);
}

let lookup: ((bridgedName: string) => 'always' | undefined) | undefined;
/** manager 注册:桥接名 → 'always'(连接器 alwaysAsk)/ undefined。返回注销函数。 */
export function setMcpApprovalLookup(fn: (bridgedName: string) => 'always' | undefined): () => void {
  lookup = fn;
  return () => { if (lookup === fn) lookup = undefined; };
}
export const mcpDeclaredApproval = (name: string): 'always' | undefined => (name.startsWith('mcp__') ? lookup?.(name) : undefined);
