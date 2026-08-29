// PDF wikilink subpath codec — the stable public contract for linking a note to a
// spot in a PDF, aligned with obsidian-pdf-plus: `[[report.pdf#page=3&color=yellow&annot=id]]`.
// Isomorphic (renderer + editor + main): standard JS only, no Node / Electron / React.
//
// Only `page` is load-bearing this round; `color`/`annot` are optional locate hints.
// Future params (selection=a,b,c,d, rect=x,y,w,h) slot into the same `&`-joined subpath —
// this file is the single extension point.
//
// 同住本文件的锚点族(逐个往下加,别另起炉灶):PDF 页码 `#page=` / 代码行号 `#L42` /
// 笔记标题 `#标题` / 笔记块 `#^abc`(Obsidian 互操作) / 音视频时刻 `#t=95` /
// **网页引语(markdown 链接文字 → `#:~:text=`)**。

export interface PdfLoc {
  /** 1-based page number. */
  page: number
  /** Highlight color name (optional locate hint / palette echo). */
  color?: string
  /** pdf.js annotation id, for locating a specific highlight rather than just the page. */
  annot?: string
  /** Quoted phrase to find & highlight on that page — transient (pdf.js find), never written to the file. */
  q?: string
}

const isPdfPath = (s: string): boolean => /\.pdf$/i.test(s.trim())

/** 绝对路径 = 库外文件(vault 内的路径一律相对)。库外 PDF 只读打开,见 PdfAnnotator。 */
export const isHostPath = (p: string): boolean => /^\/|^[A-Za-z]:[\\/]/.test(p)

/** Does a wikilink's inner text point at a PDF? (`report.pdf`, `report.pdf#page=2`, `a/b.pdf|x`) */
export function isPdfLinkInner(inner: string): boolean {
  let s = inner.trim()
  const bar = s.indexOf('|')
  if (bar >= 0) s = s.slice(0, bar)
  const hash = s.indexOf('#')
  if (hash >= 0) s = s.slice(0, hash)
  return isPdfPath(s)
}

/** Encode a location into a subpath (no leading `#`): `page=3&color=yellow&annot=id`. */
export function encodePdfSubpath(loc: PdfLoc): string {
  const parts = [`page=${Math.max(1, Math.trunc(loc.page) || 1)}`]
  if (loc.color) parts.push(`color=${encodeURIComponent(loc.color)}`)
  if (loc.annot) parts.push(`annot=${encodeURIComponent(loc.annot)}`)
  if (loc.q) parts.push(`q=${encodeURIComponent(loc.q)}`) // 放最后:模型手写时漏编码也只会波及自己
  return parts.join('&')
}

/** Parse a subpath (`#`-prefixed or not) into a location; returns null if no valid `page`. */
export function parsePdfSubpath(subpath: string): PdfLoc | null {
  const raw = subpath.replace(/^#/, '')
  if (!raw) return null
  const params = new Map<string, string>()
  for (const kv of raw.split('&')) {
    const eq = kv.indexOf('=')
    if (eq < 0) continue
    params.set(kv.slice(0, eq), kv.slice(eq + 1))
  }
  const page = parseInt(params.get('page') ?? '', 10)
  if (!Number.isFinite(page) || page < 1) return null
  const loc: PdfLoc = { page }
  const color = params.get('color')
  if (color) loc.color = decodeURIComponent(color)
  const annot = params.get('annot')
  if (annot) loc.annot = decodeURIComponent(annot)
  const q = params.get('q')
  // 模型手写的 q 常常没编码(空格/中文原样)——解不开就按原文用,别把整条引用废掉。
  if (q) { try { loc.q = decodeURIComponent(q) } catch { loc.q = q } }
  return loc
}

/** Split a raw wikilink inner (`report.pdf#page=3&...`, alias stripped) into target path + location. */
export function parsePdfLinkInner(inner: string): { target: string; loc: PdfLoc | null } | null {
  let s = inner.trim()
  const bar = s.indexOf('|')
  if (bar >= 0) s = s.slice(0, bar).trim()
  const hash = s.indexOf('#')
  const target = (hash >= 0 ? s.slice(0, hash) : s).trim()
  if (!isPdfPath(target)) return null
  return { target, loc: hash >= 0 ? parsePdfSubpath(s.slice(hash + 1)) : null }
}

/** Build a copy-to-clipboard wikilink to a PDF location: `[[report.pdf#page=3&annot=id]]`. */
export function buildPdfLink(pdfName: string, loc: PdfLoc): string {
  return `[[${pdfName}#${encodePdfSubpath(loc)}]]`
}

// ── 行号锚点(代码/文本文件引用,GitHub #L 约定)────────────────────────────────
// read_file 教模型写 `[[path.ts#L42]]` / `[[path.ts#L42-L48]]`,聊天里渲染成引用条,
// 点开 = WsFileView 滚到那一行并高亮。与 PDF 的 page= 锚同住本文件(引用锚点的唯一扩展点)。

export interface LineLoc {
  /** 1-based 起始行。 */
  from: number
  /** 1-based 结束行(仅 > from 时存在;倒序/相等一律折叠成单行)。 */
  to?: number
}

/** `L42` / `L42-L48` / `L42-48`(`#` 前缀可有可无)→ LineLoc;其余(含 page=)→ null。 */
export function parseLineSubpath(subpath: string): LineLoc | null {
  const m = /^#?L(\d+)(?:-L?(\d+))?$/i.exec(subpath.trim())
  if (!m) return null
  const from = parseInt(m[1], 10)
  if (!from || from < 1) return null
  const to = m[2] ? parseInt(m[2], 10) : NaN
  return to > from ? { from, to } : { from }
}

// ── 块锚点(Obsidian 互操作:`[[笔记#^abc123]]`)────────────────────────────────
// ⚠️ 这是**外来格式**,本仓自己一行都不产:Amadeus 的块引用是 `![[笔记#块ID]]`(井号,无插入符,
//    id 是 marker `<!-- a 3 -->` 里的十进制小整数)。`^id` 的唯一现实来源 = 从 Obsidian 导入的
//    笔记 —— 那些是素文件,落 v4 渲染,`^abc` 在正文里就是一段字面文本(挂在块最后一行尾部)。
//    因此跳转只在 v4 上做;v3 老笔记(Amadeus 自己写的)按构造不可能带 `^id`,自然回落「只开笔记」。
// 字符集照 Obsidian:`[A-Za-z0-9-]`。这套字符里没有 `=`,所以与 `page=`/`t=` 天然互斥;
// 与 `#L42` 靠前导 `^` 区分;调用方必须**先问块锚再当标题**(标题是兜底分支,什么都接)。

/** `^abc123`(`#` 前缀可有可无)→ 块 id;其余(含 page=/L42/t=/普通标题)→ null。 */
export function parseBlockSubpath(subpath: string): string | null {
  const m = /^#?\^([A-Za-z0-9-]+)$/.exec(subpath.trim())
  return m ? m[1] : null
}

/** 一行文本的尾部块锚:`一段话 ^abc123` → `abc123`;整行只有 `^abc123` 也算(Obsidian 里那种
 *  形态指的是**上一个块**,由调用方负责往回退一格)。没有 → null。 */
export function trailingBlockId(line: string): string | null {
  const m = /(?:^|\s)\^([A-Za-z0-9-]+)\s*$/.exec(line)
  return m ? m[1] : null
}

/** 整行只有一个块锚(`^abc123`),按 Obsidian 语义它标注的是**上一个块**。 */
export const isLoneBlockId = (line: string): boolean => /^\s*\^[A-Za-z0-9-]+\s*$/.test(line)

// ── 标题锚点(笔记引用 `[[笔记#标题]]` / 嵌套链 `[[笔记#H1#H2]]`)──────────────────

/** 标题锚点归一:模型/用户从原文抄来的标题可能带行内格式(`**加粗**`/`` ` ``/[[链]]),
 *  编辑器大纲给的是 PM 纯文本 —— 两边都剥掉格式字符再比,大小写不敏感。 */
export const headingKey = (s: string): string => s.replace(/[*_~`]|!?\[\[|\]\]/g, '').trim().toLowerCase()

const cleanKey = (s: string): string => s.trim().toLowerCase()

/** 在标题列表(带层级,文档序)里解析标题锚点;找不到 → -1(调用方**不跳**,绝不静默跳错)。
 *  - 两档匹配,**精确优先**:第一档大小写不敏感的原文比对;第二档只对**锚点侧**剥行内格式
 *    (锚点是从原文 md 抄来的,可能带 `**`/`` ` ``;标题侧是 PM 纯文本,里面的 `_` 是正文)。
 *    两侧都剥会把 `foo_bar` 与 `foobar` 并成同 key = 静默错跳(Codex 二审)。
 *  - 整串匹配优先(标题文本本身含 `#` 的罕见形态);嵌套链 `#H1#H2` 按**祖先链**匹配:
 *    候选是末段同名的标题,其往上最近的逐级祖先里要按序出现链上的前置各段(允许跳级)。
 *    两个父标题下都有同名子标题时,只有链对得上的那个才中(Codex 一审 high)。
 *  - 单段锚点维持全文档首个同名(Obsidian 同语义)。 */
export function findHeadingIndex(hs: Array<{ level: number; text: string }>, heading: string): number {
  for (const anchorKey of [cleanKey, headingKey]) {
    const hit = findWithKey(hs, heading, anchorKey)
    if (hit >= 0) return hit
  }
  return -1
}

function findWithKey(hs: Array<{ level: number; text: string }>, heading: string, anchorKey: (s: string) => string): number {
  const whole = anchorKey(heading)
  if (!whole) return -1
  const exact = hs.findIndex((h) => cleanKey(h.text) === whole)
  if (exact >= 0) return exact
  const segs = heading.split('#').map(anchorKey).filter(Boolean)
  if (!segs.length) return -1
  const last = segs[segs.length - 1]
  for (let i = 0; i < hs.length; i++) {
    if (cleanKey(hs[i].text) !== last) continue
    if (segs.length === 1) return i
    // 从 i 往回收集层级严格递减的最近祖先(外层在前)
    const anc: string[] = []
    let lv = hs[i].level
    for (let j = i - 1; j >= 0 && lv > 1; j--) {
      if (hs[j].level < lv) {
        anc.unshift(cleanKey(hs[j].text))
        lv = hs[j].level
      }
    }
    let k = 0
    for (const a of anc) if (k < segs.length - 1 && a === segs[k]) k++
    if (k === segs.length - 1) return i
  }
  return -1
}

/** 任意 wikilink 内文 → 目标 + 原始 subpath(别名剥掉,`#` 后原样保留;无 `#` → null)。
 *  linkTarget 会把 subpath 砍掉 —— 需要锚点的消费方(聊天引用条)用这个。 */
export function splitLinkInner(inner: string): { target: string; subpath: string | null } {
  let s = inner.trim()
  const bar = s.indexOf('|')
  if (bar >= 0) s = s.slice(0, bar).trim()
  const hash = s.indexOf('#')
  if (hash < 0) return { target: s, subpath: null }
  const sub = s.slice(hash + 1).trim()
  return { target: s.slice(0, hash).trim(), subpath: sub || null }
}

// ── 媒体时间锚点(音视频定点引用,W3C Media Fragments 的 `t=` 子集)──────────────────
// `![[lecture.mp4#t=95]]` 嵌入起播 / `[[lecture.mp4#t=95|01:35]]` 引用条。与 PDF 的 `page=`、
// 代码的 `#L42`、笔记的 `#标题` 同住本文件(引用锚点的唯一扩展点)。
//
// ⚠️ 只在 base 后缀命中音视频时才允许消费 —— 否则 `[[笔记#t=90]]` 会被从标题锚点里抢走
//    (标题真叫 "t=90" 极罕见,但错跳比不跳更坏)。调用方一律走 parseMediaLinkInner,别自己拆。

export const VIDEO_EXT_RE = /\.(mp4|webm|mov|m4v)$/i
export const AUDIO_EXT_RE = /\.(mp3|wav|ogg|m4a|flac)$/i

/** 这个路径是 Chromium 能内联播放的音视频吗?
 *  ⚠️ 刻意**不**与 services/fileKinds.ts 那份合并:那份是「文件类型图标」口径,含 mkv|avi —— 合并会让
 *  `.mkv` 从「📄 文件卡」变成一块播不动的黑 `<video>`。两处口径不同是有意的。 */
export const isMediaPath = (s: string): boolean => VIDEO_EXT_RE.test(s.trim()) || AUDIO_EXT_RE.test(s.trim())

export interface MediaLoc {
  /** 起播秒(可含小数)。 */
  at: number
  /** 区间终点(仅 > at 时存在)。 */
  to?: number
  /** 用户**写了**终点但它解不开 / 不大于起点(`t=95,foo`、`t=95,80`)→ 降级成单点锚。
   *  留这个标记是为了「降级不等于静默」:引用条据此在 title 里说明终点被忽略了。 */
  badTo?: true
}

/** NPT 时间:纯秒 `95`/`95.5`、`MM:SS`(MM **恰两位**)、`HH:MM:SS`。
 *  `1:35` 判非法 —— 抄 Logseq issue #9920 的血:`10:44` 被解释成 10 小时 44 分,用户当场懵。
 *  失败形态是「静默跳到 0 秒」,规则层堵死比事后修便宜。 */
function npt(s: string): number | null {
  const t = s.trim()
  let m: RegExpExecArray | null
  let v: number | null = null
  if ((m = /^(\d+):([0-5]\d):([0-5]\d(?:\.\d+)?)$/.exec(t))) v = +m[1] * 3600 + +m[2] * 60 + +m[3]
  else if ((m = /^([0-5]\d):([0-5]\d(?:\.\d+)?)$/.exec(t))) v = +m[1] * 60 + +m[2]
  else if (/^\d+(?:\.\d+)?$/.test(t)) v = +t
  // ⚠️ 超长数字串(`t=999…9`,400 位)`Number()` 给的是 **Infinity** —— 它过得了「>= 0」这类守卫,
  // 一路走到 `el.currentTime = Infinity` 才炸/被静默钳住。非有限值一律判非法(Codex 评审)。
  return v != null && Number.isFinite(v) ? v : null
}

/** `t=95` / `t=01:35` / `t=95,120`(`#` 前缀可有可无)→ MediaLoc;其余(含 page=/L42/标题)→ null。 */
export function parseMediaSubpath(subpath: string): MediaLoc | null {
  const m = /^#?t=(.*)$/i.exec(subpath.trim())
  if (!m) return null
  // ⚠️ 光杆 `t=`(逗号都没有)是**非法**,不是「从 0 秒开始」—— 判 null 交给调用方的 badAnchor
  // 分支去提示。本文件自己定的规矩就是「非法锚点不许静默变成 0 秒」,这里破例就自噬(Codex 评审)。
  // `t=,120` 不在此列:那是 Media Fragments 里合法的「从头播到 120 秒」。
  if (m[1].trim() === '') return null
  const [a, b] = m[1].split(',')
  const at = a.trim() === '' ? 0 : npt(a)
  if (at == null || at < 0) return null
  if (b === undefined) return { at }
  const to = npt(b)
  // 终点解不开(`t=95,foo`)/ 空(`t=95,`)/ 倒序或相等(`t=95,80`)/ 多出第三段(`t=95,120,200`)
  // 一律**降级成单点锚 + `badTo` 标记**,不把整条判非法。
  // ⚠️ Codex 三审建议这里返 null,**不采纳**:判非法会让 `t=95,foo` 从 0 秒起播 —— 把用户唯一
  //    写对的那半(起点)也丢掉,比丢掉区间更坏。本文件那条「非法锚点不许静默变成 0 秒」的规矩
  //    正是冲这个来的。
  // ⚠️ 但四审那句「只证明了不该返 null,没证明应当**静默**」是对的 —— 所以降级带标记,
  //    调用方(引用条 title)据此明说终点被忽略。降级 ≠ 不吭声。
  return to != null && to > at ? { at, to } : { at, badTo: true }
}

export const encodeMediaSubpath = (loc: MediaLoc): string =>
  `t=${Math.round(loc.at)}${loc.to ? `,${Math.round(loc.to)}` : ''}`

/** 秒 → `01:35` / `1:02:30`(给别名位与 UI 用;MM/SS 恒两位,与 npt 的解析口径对称)。 */
export function mediaLabel(sec: number): string {
  const s = Math.max(0, Math.floor(sec || 0))
  const p = (n: number): string => String(n).padStart(2, '0')
  const h = Math.floor(s / 3600)
  return h ? `${h}:${p(Math.floor((s % 3600) / 60))}:${p(s % 60)}` : `${p(Math.floor(s / 60))}:${p(s % 60)}`
}

/** 媒体链接内文 → `{ target, loc }`;**非音视频后缀 → 整条 null**(形状同 parsePdfLinkInner)。
 *  锚点解不开时 `loc === null` 而不是整条 null —— 调用方据此「照样渲染播放器 + 提示锚点无效」,
 *  绝不让 `![[a.mp4#t=1:35]]` 掉进跨笔记分支变成「嵌入丢失」(那是静默失败的另一种形态)。 */
export function parseMediaLinkInner(inner: string): { target: string; loc: MediaLoc | null } | null {
  const { target, subpath } = splitLinkInner(inner)
  if (!target || !isMediaPath(target)) return null
  return { target, loc: subpath ? parseMediaSubpath(subpath) : null }
}

/** 复制用的媒体锚点链接:`[[lecture.mp4#t=95|01:35]]`。 */
export const buildMediaLink = (name: string, loc: MediaLoc, label?: string): string =>
  `[[${name}#${encodeMediaSubpath(loc)}${label === undefined ? `|${mediaLabel(loc.at)}` : label ? `|${label}` : ''}]]`

// ── 网页引语锚点(Chromium 原生 scroll-to-text-fragment)────────────────────────
// 聊天里 agent 写的普通 markdown 链接 `[一句原文](https://…)` = 网页引用:点开在 Agent Desk 的
// 内置浏览器里打开,并**滚到那句话 + 原生高亮**。定位不用自研 —— 浏览器自己认 `#:~:text=`。
//
// ⚠️ 引语刻意放在**链接文字**里,不进 URL:markdown 的链接目标不许含空格(`[x](url#:~:text=a b)`
//    整条会退化成字面文本),而模型忘记 %20 是必然事件。文字位天生能放空格,零编码要求。
// 实测(scripts/text-fragment.check.cjs):冷加载与同文档换 fragment **都**生效,
// 所以同一页点第二条引语照样能就地跳,不需要 findInPage 那套状态机。

/** 给 URL 挂上文本片段指令。命中不了 = 页面照常打开、只是不高亮(同 PDF 的 `q=` 语义)。
 *  - 已带 `:~:`(模型自己写了)→ 原样返回,别叠第二条;
 *  - 页面自带锚点 `#install` → 追加成 `#install:~:text=…`(规范形态,两者共存);
 *  - 引语必须 encodeURIComponent:`,` 与 `&` 在片段指令语法里是分隔符,不编码会被从中截断。
 *  太短/太长的都不挂:「点这里」当搜索词多半命中无关处,超长句几乎必不匹配。 */
export function withTextFragment(url: string, quote: string): string {
  if (!/^https?:\/\//i.test(url) || url.includes(':~:')) return url
  const q = quote.replace(/\s+/g, ' ').trim()
  if (q.length < 8 || q.length > 300 || url.startsWith(q)) return url
  return `${url.includes('#') ? url : url + '#'}:~:text=${encodeURIComponent(q)}`
}

/** 网页引用在 Desk 里的身份键 = 去掉 fragment 的 URL:同一页的不同引语必须复用同一个
 *  `<webview>`(换 key = 重挂 = 整页重新下载),新引语靠 amadeus:browser-goto 就地跳。 */
export const webCiteKey = (url: string): string => url.split('#')[0]

// ── 嵌入宽度 `![[…|560]]` 与 URL 形态(2026-08-29)──────────────────────────────
// 放这里的理由与 `parseMediaLinkInner` 一样:**三条分类链**(v4 embedLayer / v3 BlockHost /
// 收件箱 InboxBody)必须逐字同源,谁 fork 一份谁就是下一次「同一份 md 三个地方三种样子」。

/** 嵌入宽度 = 管道**末段的纯数字**(`![[a.mp4#t=95|400]]` / `![[https://…|560]]`),与图片的
 *  `![[pic.png|200]]` 同一套口径(Obsidian 式)。位数下限 2 是因为把手最小宽 40,上限 4 免得
 *  把某个长数字串当宽度。
 *  ⚠️ **只在最终判成 web/file 的形态上读**:嵌入形态的管道段在别处另有含义(`![[x.db|视图]]`、
 *  `![[报告.md|2024]]` 的跨笔记别名)——统一当宽度吃掉会改掉那些块的渲染。 */
export function embedWidthOf(target: string): number | undefined {
  const segs = target.split('|')
  if (segs.length < 2) return undefined
  const last = segs[segs.length - 1].trim()
  return /^\d{2,4}$/.test(last) ? Number(last) : undefined
}

/** 换掉(或去掉,w=null)末段宽度,拿回可回写的 `![[…]]` 内文。 */
export function withEmbedWidth(target: string, w: number | null): string {
  const segs = target.split('|')
  if (embedWidthOf(target) !== undefined) segs.pop()
  const base = segs.join('|')
  return w == null ? base : `${base}|${w}`
}

/** `![[https://…]]` 的 URL(不是网址 → null)。
 *  ⚠️ **只剥末段宽度,不许 `split('|')[0]`**:`|` 在 URL 里是合法字符(浏览器不编码就直接发),
 *  `![[https://x.test/?q=a|b]]` 一刀切会加载半条地址,而「转为书签卡」把截断后的那半条写回正文
 *  = 用户的 URL 后半段**永久丢失**(Codex 2026-08-29)。写入侧另有 `wikiSafeUrl` 兜。 */
export function embedUrlOf(target: string): string | null {
  const t = withEmbedWidth(target.trim(), null).trim()
  return /^https?:\/\/\S+$/i.test(t) ? t : null
}

/** 往 `![[…]]` 里写 URL 前的编码:`|` 与 `]` 是这套语法的分隔符,原样写进去就再也读不回来。
 *  两个都是 URL 里合法但非保留的字符,百分号编码后语义不变(浏览器一样能开)。 */
export const wikiSafeUrl = (url: string): string => url.replace(/\|/g, '%7C').replace(/\]/g, '%5D')
