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
  // ⚠️ 结果要塞进 markdown 的链接目标(`![](…)`),那里**不许有裸括号** —— IMG_RE 和 CommonMark
  // 都在第一个 `)` 处截断,而 `encodeURIComponent` 偏偏不编码 `()`(实测:`export (1).png` →
  // `export%20(1).png`)。截断的后果是落盘写出 `![](…%281).png)` 这种半截路径,图片当场失联。
  // 统一在**唯一出口**兜住:桌面协议版、云端 HTTP 版(setAssetUrlBuilder 注入)都不必各自记得。
  // 解析侧 decodeURIComponent 认 `%28`/`%29`,对称。
  return assetUrlBuilder(vaultRelPath).replace(/[()]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase())
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

/** markdown 的链接目标里,空格和括号会当场把图片语法弄坏 —— 必须百分号编码。
 *
 *  ⚠️ 2026-08-27 用户实报「原来的图片文件都无法被引用了」的根因就在这:
 *  粘贴/上传一张名字带空格的图(`Screenshot 2026-08-27 at 22.25.59.png`),这里原样写下
 *  `![](attachments/Screenshot 2026-08-27 at 22.25.59.png)` —— 这**不是**合法的 markdown 图片
 *  (CommonMark 的链接目标遇空格即止),remark 于是当纯文本读,下一次保存又给 `[`/`(` 加上反斜杠
 *  转义 → 盘上永久变成 `!\[]\(…)` 一行死字,图片再也回不来。
 *
 *  编码而不是用 `<...>` 包裹:Obsidian 自己写的就是 `%20`,这条是兼容口径。
 *  ⚠️ 天花板:文件名里**字面**含 `%20` 这种串,读回时会被解码成空格(与 Obsidian 同一处歧义)。 */
function encodeDest(rel: string): string {
  return rel.replace(/[ ()<>]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase())
}

function isExternal(url: string): boolean {
  return /^(https?:|data:|amadeus-asset:|blob:|\/)/.test(url)
}

/** Stored (page-relative) markdown → display markdown (protocol URLs for local images;
 *  行首字面制表符 → &#9; 实体,防 remark 读成缩进代码块/列表吸入)。 */
export function toDisplayMarkdown(md: string, pageDir: string): string {
  return tabsToEntities(md.replace(IMG_RE, (full, pre: string, url: string, rest: string) => {
    const u = url.trim()
    if (isExternal(u)) return full
    // 先解码再拼:盘上是 `%20` 编码形态,不解码的话 toAssetUrl 会二次编码 → 协议侧找不到文件。
    return pre + toAssetUrl(joinRel(pageDir, decodeSafe(u))) + rest
  }))
}

/** Display markdown (protocol URLs) → stored (page-relative) markdown(行首缩进实体 → 字面制表符)。 */
export function toStoredMarkdown(md: string, pageDir: string): string {
  return entitiesToTabs(md.replace(IMG_RE, (full, pre: string, url: string, rest: string) => {
    const vaultRel = fromAssetUrl(url.trim())
    if (vaultRel == null) return full
    return pre + encodeDest(relFrom(pageDir, vaultRel)) + rest
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
