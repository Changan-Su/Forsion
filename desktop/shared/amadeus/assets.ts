// Asset path transforms (pure, shared by main & renderer).
//
// On disk a block stores PORTABLE, page-folder-relative image links, e.g.
//   ![](.amadeus/img-xyz.png)
// The renderer can't load those directly (its base URL isn't the vault), so for DISPLAY
// we rewrite them to a custom protocol URL that the main process resolves against the vault:
//   ![](amadeus-asset://v/<encoded vault-relative path>)
// …and rewrite back to the relative form before persisting, keeping main.md Obsidian-clean.
//
// 2026-08-14 起这对函数同时是「段落缩进」的编解码边界(indentIo):磁盘=行首字面制表符,
// 编辑器(remark)侧=&#9; 实体。挂这儿的理由:display/stored 恰好就是 parser/serializer
// 的唯一必经口(v3 MarkdownBlock ×2 + v4 UnifiedPage ×5 站点),磁盘 IO、源码模式与
// 搜索索引永远只见字面制表符。

import { tabsToEntities, entitiesToTabs } from './indentIo'

export const ASSET_SCHEME = 'amadeus-asset'

/** Join a vault-relative dir with a page-relative path (always '/'-separated). */
export function joinRel(dir: string, rel: string): string {
  const d = dir.replace(/\\/g, '/').replace(/\/+$/, '')
  const r = rel.replace(/\\/g, '/')
  return !d || d === '.' ? r : `${d}/${r}`.replace(/\/{2,}/g, '/')
}

/** Make `vaultRel` relative to a vault-relative dir (inverse of joinRel). */
export function relFrom(dir: string, vaultRel: string): string {
  const d = dir.replace(/\\/g, '/').replace(/\/+$/, '')
  if (!d || d === '.') return vaultRel
  const prefix = `${d}/`
  return vaultRel.startsWith(prefix) ? vaultRel.slice(prefix.length) : vaultRel
}

/** 可替换的资源 URL 构建器(接缝):默认 = amadeus-asset:// 自定义协议(桌面主进程解析,
 *  移动端由原生 WebView 拦截)。Tangu Web 无 host 协议,启动时经 setAssetUrlBuilder 注入
 *  HTTP 版(→ /api/amadeus/vaults/:v/asset?ref=…)。桌面/移动不调用注入,零影响。 */
let assetUrlBuilder: (ref: string) => string = (ref) =>
  `${ASSET_SCHEME}://v/${encodeURIComponent(ref)}`

/** Install a custom display-URL builder for vault assets (web cloud bridge). */
export function setAssetUrlBuilder(fn: (ref: string) => string): void {
  assetUrlBuilder = fn
}

export function toAssetUrl(vaultRelPath: string): string {
  return assetUrlBuilder(vaultRelPath)
}

export function fromAssetUrl(url: string): string | null {
  const prefix = `${ASSET_SCHEME}://v/`
  if (!url.startsWith(prefix)) return null
  try {
    return decodeURIComponent(url.slice(prefix.length))
  } catch {
    return null
  }
}

// ![alt](path) or ![alt](path "title") — captures alt-wrapper, the URL token, then the rest.
const IMG_RE = /(!\[[^\]]*\]\()([^)\s]+)((?:\s+"[^"]*")?\))/g

function isExternal(url: string): boolean {
  return /^(https?:|data:|amadeus-asset:|blob:|\/)/.test(url)
}

/** Stored (page-relative) markdown → display markdown (protocol URLs for local images;
 *  行首字面制表符 → &#9; 实体,防 remark 读成缩进代码块/列表吸入)。 */
export function toDisplayMarkdown(md: string, pageDir: string): string {
  return tabsToEntities(md.replace(IMG_RE, (full, pre: string, url: string, rest: string) => {
    const u = url.trim()
    if (isExternal(u)) return full
    return pre + toAssetUrl(joinRel(pageDir, u)) + rest
  }))
}

/** Display markdown (protocol URLs) → stored (page-relative) markdown(行首缩进实体 → 字面制表符)。 */
export function toStoredMarkdown(md: string, pageDir: string): string {
  return entitiesToTabs(md.replace(IMG_RE, (full, pre: string, url: string, rest: string) => {
    const vaultRel = fromAssetUrl(url.trim())
    if (vaultRel == null) return full
    return pre + relFrom(pageDir, vaultRel) + rest
  }))
}

/** `![[x|200]]` / `[[x#锚]]` / `![](x)` / `[名](x)` 里的**附件**引用(非 .md、非外链、带扩展名)。
 *  主进程用它算「删笔记时哪些附件是独占的」,渲染层用它算「整块删掉的引用块牵着哪个文件」——
 *  同一套判据,别再抄第二份。 */
export function assetRefs(text: string): string[] {
  const out: string[] = []
  const add = (raw: string): void => {
    const r = raw.split('|')[0].split('#')[0].trim().replace(/^<|>$/g, '')
    if (!r || /^[a-z][a-z0-9+.-]*:/i.test(r)) return // http(s)/data/amadeus-asset… 一律不是 vault 附件
    if (!/\.[a-z0-9]{1,12}$/i.test(r) || /\.md$/i.test(r)) return // 无扩展名 = 笔记名;.md = 笔记/画板,不删
    if (!out.includes(r)) out.push(r)
  }
  for (const m of text.matchAll(/!?\[\[([^\]\n]+)\]\]/g)) add(m[1])
  for (const m of text.matchAll(/!?\[[^\]\n]*\]\(([^)\s]+)/g)) add(decodeSafe(m[1]))
  return out
}

/** 共享判定只认文件名(小写):同名不同目录也当共享 —— 宁可少删。 */
export function assetKey(ref: string): string {
  return (ref.split(/[\\/]/).pop() ?? ref).toLowerCase()
}

function decodeSafe(s: string): string {
  try { return decodeURIComponent(s) } catch { return s }
}
