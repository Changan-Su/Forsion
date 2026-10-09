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
import { mapOutsideFences, outsideCodeSpans } from './links'

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

/** 可替换的资源 URL 构建器(接缝):默认 = amadeus-asset:// 自定义协议(**只有桌面主进程**解析它)。
 *  没有这个协议的宿主启动时经 setAssetUrlBuilder 注入 HTTP 版:云端库(网页版 + 手机缺省,
 *  → /api/amadeus/vaults/:v/asset?ref=…&at=<令牌>)、设备网页版、分享页。桌面不调用注入,零影响。
 *  ⚠️ 两个已知缺陷(2026-10-09 实证,未修;仪器 = mobile 的 npm run e2e:localasset + assets.test.ts 末尾那格):
 *    · **这个接缝只有去程没有回程**:fromAssetUrl / toStoredMarkdown 只认默认前缀。换了构建器的宿主上,
 *      编辑器一存盘就把注入的 HTTP 地址(连同资源令牌)写进笔记,不再是页相对路径;
 *    · 手机本地库没有注入、安卓也没有接默认协议的拦截器(旧注释说有,从来没有)—— 图片显示不出来;
 *      构建器是模块级的,云桥装上后没人撤,切到本地库后图片被指到云端。 */
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
// URL 位认两种写法:尖括号目标 `<a b.png>`(CommonMark 允许,里面可以有空格)排在前面,其余是裸目标(I-15:
// 旧版只认裸目标,`<a.png>` 被整段当路径 → 显示 `%3Ca.png%3E`、落盘写成指向不存在文件的 `%3Ca.png%3E`)。
const IMG_RE = /(!\[[^\]]*\]\()(<[^>\n]*>|[^)\s]+)((?:\s+"[^"]*")?\))/g

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
 *  行首字面制表符 → &#9; 实体,防 remark 读成缩进代码块/列表吸入)。
 *
 *  **代码里的 `![](…)` 逐字不动**(I-15,评审 2026-09-27):围栏代码块整块、行内代码 span 跳过(links 的
 *  mapOutsideFences / outsideCodeSpans,与存盘还原 / 搜索解码同一套配对)。旧版对全文做替换,代码里的示例被换成
 *  `amadeus-asset://…` 显示、「复制代码」拿到内部地址,落盘时又按解码→编码不对称地写回:`%E5%9B%BE.png` 变
 *  `图.png`、`<a.png>` 变 `%3Ca.png%3E`,都不可逆。
 *  ⚠️ 跳过只做在这一侧:toStoredMarkdown 照旧全文把协议 URL 换回相对路径 —— 它是安全网,两侧对「哪里是代码」
 *  的判断万一不一致(缩进代码块、跨行的行内代码按行认不出),协议 URL 也绝不会漏到盘上。
 *  ponytail: 按行匹配,alt 文字跨行的图片(`![a⏎b](x.png)`)不再换成协议 URL(只是显示不出,盘上逐字)。 */
export function toDisplayMarkdown(md: string, pageDir: string): string {
  const toDisplay = (seg: string): string => seg.replace(IMG_RE, (full, pre: string, url: string, rest: string) => {
    // 尖括号目标:括号是语法不是路径(`<a b.png>` = `a b.png`);落盘经 encodeDest 写成 `a%20b.png`(与 Obsidian 同口径)。
    const u = (url.startsWith('<') ? url.slice(1, -1) : url).trim()
    if (!u || isExternal(u)) return full
    // 先解码再拼:盘上是 `%20` 编码形态,不解码的话 toAssetUrl 会二次编码 → 协议侧找不到文件。
    return pre + toAssetUrl(joinRel(pageDir, decodeSafe(u))) + rest
  })
  const out = md.includes('![') ? mapOutsideFences(md, (line) => (line.includes('![') ? outsideCodeSpans(line, toDisplay) : line)) : md
  return tabsToEntities(out)
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
