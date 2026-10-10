// Asset path transforms (pure, shared by main & renderer).
//
// On disk a block stores PORTABLE, page-folder-relative image links, e.g.
//   ![](.amadeus/img-xyz.png)
// 图片在页目录之外时写成 `../…`(`![](../attachments/x.png)`),不写库内路径 —— 见 relFrom。
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

/** 库内相对路径规范化:折叠 `.` / `..` 与多余的斜杠;越出库根的 `..` 保留在头上(越没越界由调用方判)。 */
export function normPath(p: string): string {
  const out: string[] = []
  for (const seg of p.split('/')) {
    if (!seg || seg === '.') continue
    if (seg === '..' && out.length && out[out.length - 1] !== '..') out.pop()
    else out.push(seg)
  }
  return out.join('/')
}

/** 从 fromDir 指向 vaultRel 的相对路径(两者都已规范化;结果可以 `../` 开头)。 */
export function relPath(fromDir: string, vaultRel: string): string {
  const a = fromDir ? fromDir.split('/') : []
  const b = vaultRel.split('/')
  let i = 0
  while (i < a.length && i < b.length - 1 && a[i] === b[i]) i++
  return [...a.slice(i).map(() => '..'), ...b.slice(i)].join('/')
}

/** Make `vaultRel` relative to a vault-relative dir —— joinRel 的逆:`joinRel(dir, relFrom(dir, x))` 折叠后就是 x。
 *    · 在页目录之下:去掉「页目录/」前缀,其余**逐字**(显示地址里带着没折叠的 `..` 时原样换回 —— 盘上本来的
 *      `../x.png`、`./x.png` 存回去一个字节不变)。
 *    · 在页目录之外:先折叠,再写成 `../…`。
 *  ⚠️ 2026-10-10 之前第二种情况原样返回库内路径:笔记在 notes/、图片在库根的 attachments/(从别的文件夹复制 / 搬块
 *  过来的图片节点就是这样)存成 `![](attachments/x.png)`,而重开一律按页相对拼成 notes/attachments/x.png ——
 *  三端都取不到(桌面的协议处理器对带路径的地址只做精确匹配;云端服务端、手机本地文件服务同样),那里恰好有
 *  同路径的文件时显示的还是另一张图。`../` 不是新写法:附件放固定文件夹时 attachmentPaths 的 pageRel 一直这么写。
 *  已经存成库内路径写法的存量笔记这里不自愈(重开时已经分不清它指的是页目录还是库根)。
 *  仪器:assets.test.ts 的「页目录之外的引用」、electron/amadeus/assetProtocol.test.ts、
 *  frontend/src/services/cloudAssetsRoundtrip.test.ts 同名一组、mobile 的 npm run e2e:localasset 场景 E / F / G。 */
export function relFrom(dir: string, vaultRel: string): string {
  const d = dir.replace(/\\/g, '/').replace(/\/+$/, '')
  if (!d || d === '.') return vaultRel
  const prefix = `${d}/`
  if (vaultRel.startsWith(prefix)) return vaultRel.slice(prefix.length)
  const to = normPath(vaultRel)
  return to ? relPath(normPath(d), to) : vaultRel
}

/** 默认的显示地址:amadeus-asset:// 自定义协议(**只有桌面主进程**解析它)。 */
const defaultAssetUrl = (ref: string): string => `${ASSET_SCHEME}://v/${encodeURIComponent(ref)}`

/** 可替换的资源地址接缝:**成对的「构建 + 解析」**。
 *  没有默认协议的宿主启动时经 setAssetUrlBuilder 注入自己的一对:云端库(网页版 + 手机缺省,
 *  → /api/amadeus/vaults/:v/asset?ref=…&at=<令牌>)、设备网页版、手机本地库(Capacitor 的本地文件地址)。
 *  桌面不调用注入 = 默认协议,零影响。
 *
 *  ⚠️ **两半必须一起装**(2026-10-09 事故:此前只有构建没有解析)。显示时换出去的地址,存盘时要靠解析换回
 *  页相对路径;只装构建的宿主上,编辑器一存盘就把注入的地址(连同资源令牌 / 设备上的绝对路径)写进笔记 ——
 *  令牌过期图片失联,同步到别的设备是一条外链而不是附件。只读的宿主(分享页,从不存盘)可以不给解析。
 *  解析器只许认**自己这个库**的资源地址,认不出一律回 null:它的结果会被写回用户的正文。
 *  仪器:assets.test.ts 的「换了显示地址的构建器之后的往返」+ mobile 的 npm run e2e:localasset。
 *
 *  构建器的第二个参数 `exact`:ref 已经是**完整的库内路径**(笔记正文里的 `![](…)`,toDisplayMarkdown 拼好页目录
 *  之后的结果),宿主照这个路径取、别再按「当前页的目录」解析一遍。`![[裸文件名]]` 这类嵌入不带它。只有
 *  服务端会按页目录解析的宿主(云端库)用得上,别的宿主忽略即可。 */
let assetUrlBuilder: (ref: string, exact?: boolean) => string = defaultAssetUrl
let assetUrlParser: ((url: string) => string | null) | null = null

/** Install a custom display-URL builder for vault assets, together with its inverse.
 *  `parse(url)` → vault-relative path, or null when the URL is not one this builder produced. */
export function setAssetUrlBuilder(build: (ref: string, exact?: boolean) => string, parse?: (url: string) => string | null): void {
  assetUrlBuilder = build
  assetUrlParser = parse ?? null
}

/** 换回默认的那一对(桥被换掉 / 测试收尾)。 */
export function resetAssetUrlBuilder(): void {
  assetUrlBuilder = defaultAssetUrl
  assetUrlParser = null
}

export function toAssetUrl(vaultRelPath: string, exact = false): string {
  // ⚠️ 结果要塞进 markdown 的链接目标(`![](…)`),那里**不许有裸括号** —— IMG_RE 和 CommonMark
  // 都在第一个 `)` 处截断,而 `encodeURIComponent` 偏偏不编码 `()`(实测:`export (1).png` →
  // `export%20(1).png`)。截断的后果是落盘写出 `![](…%281).png)` 这种半截路径,图片当场失联。
  // 统一在**唯一出口**兜住:桌面协议版、云端 HTTP 版(setAssetUrlBuilder 注入)都不必各自记得。
  // 解析侧 decodeURIComponent 认 `%28`/`%29`,对称。
  return assetUrlBuilder(vaultRelPath, exact).replace(/[()]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase())
}

/** 只认默认协议的那一半(不问装上的解析器)。
 *  ⚠️ 「据此决定删不删文件」的调用方用这个(unified/assetDelete.ts),别用 fromAssetUrl:独占判定(主进程
 *  exclusiveAssets)只看得见相对路径的引用,看不见别的笔记里被旧缺陷写坏的 http 资源地址 —— 设备网页版上一旦借
 *  解析器把图片认回库内路径,「连文件一起删」的询问就会出现,而那张图可能正被一篇存量坏笔记引用着(评审 2026-10-09)。 */
export function fromDefaultAssetUrl(url: string): string | null {
  const prefix = `${ASSET_SCHEME}://v/`
  if (!url.startsWith(prefix)) return null
  try {
    return decodeURIComponent(url.slice(prefix.length))
  } catch {
    return null
  }
}

/** 显示地址 → 库内相对路径;不是资源地址 = null。
 *  先认默认协议(桌面逐字不变;换了构建器的宿主上残留的默认协议地址也照样还原),再问装上的解析器。
 *  编辑器序列化时会给目标里的 `&` 加反斜杠(图片与文字同段时 remark 的转义),先去掉再问。 */
export function fromAssetUrl(url: string): string | null {
  if (url.startsWith(`${ASSET_SCHEME}://v/`)) return fromDefaultAssetUrl(url)
  if (!assetUrlParser) return null
  try {
    return assetUrlParser(url.replace(/\\&/g, '&')) || null
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
 *  ponytail: 按行匹配,alt 文字跨行的图片(`![a⏎b](x.png)`)不再换成协议 URL(只是显示不出,盘上逐字)。
 *
 *  盘上已经是本库显示地址的图片(被旧缺陷写坏的存量笔记)在这里按当前构建器重拼,见函数体内的注。
 *  仪器:cloudAssetsRoundtrip.test.ts 的「已经存坏的笔记」+ mobile 图片往返台架的场景 D。 */
export function toDisplayMarkdown(md: string, pageDir: string): string {
  const toDisplay = (seg: string): string => seg.replace(IMG_RE, (full, pre: string, url: string, rest: string) => {
    // 尖括号目标:括号是语法不是路径(`<a b.png>` = `a b.png`);落盘经 encodeDest 写成 `a%20b.png`(与 Obsidian 同口径)。
    const u = (url.startsWith('<') ? url.slice(1, -1) : url).trim()
    if (!u) return full
    if (isExternal(u)) {
      // 盘上已经是**本库的显示地址**(2026-10-09 之前的缺陷把它写进了正文:带着过期的令牌,或者是另一端的接口源)
      // → 按现在的构建器重拼,图当场显示得出;存盘时照常换回页相对路径。只换显示,不为此写盘(打开不算修改)。
      // 认不认得出由装上的解析器说了算:桌面没装,盘上的云端地址在桌面上仍是一条外链。
      // 只动「裸目标 + 解析器认得」这一种(旧缺陷写出来的就是它)。尖括号目标、默认协议的字面地址照旧逐字不动:
      // 产品不会把它们写到盘上,存盘那一侧也不拆尖括号 —— 这里拆了,原本逐字保住的引用就会在下次存盘被改写(评审 2026-10-09)。
      // 坏了之后又被挪到别的文件夹的笔记,ref 落在页目录之外:存盘时 relFrom 写成 `../…`,重开照样找得到。
      if (url.startsWith('<') || u.startsWith(`${ASSET_SCHEME}:`)) return full
      const own = fromAssetUrl(u)
      return own == null ? full : pre + toAssetUrl(own, true) + rest
    }
    // 先解码再拼:盘上是 `%20` 编码形态,不解码的话 toAssetUrl 会二次编码 → 协议侧找不到文件。
    // joinRel 不折叠 `..`:显示地址里原样带着,存盘时 relFrom 才能逐字换回(各宿主取文件时自己折叠)。
    return pre + toAssetUrl(joinRel(pageDir, decodeSafe(u)), true) + rest
  })
  const out = md.includes('![') ? mapOutsideFences(md, (line) => (line.includes('![') ? outsideCodeSpans(line, toDisplay) : line)) : md
  return tabsToEntities(out)
}

/** Display markdown (protocol URLs) → stored (page-relative) markdown(行首缩进实体 → 字面制表符)。
 *  全文替换、不跳代码(见 toDisplayMarkdown 的注:这一侧是安全网)。装了解析器的宿主上因此多一处已知代价:
 *  代码示例里字面写着**本库**资源地址的 `![](…)` 也会被换成相对路径 —— 宁可如此,也不让带令牌的地址因为两侧对
 *  「哪里是代码」判断不一致而漏到盘上。 */
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
