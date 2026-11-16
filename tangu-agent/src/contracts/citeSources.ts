/**
 * 搜索来源编号(借鉴 DeepSeek chat-demo 方案 ②A):这一轮 web_search 的结果 + web_fetch 读过的网页 = 这一轮的来源;
 * 正文里指向它们的链接按**第一次出现**的顺序编号(同一网址同一个号),其他链接照旧 ↗。模型输出不变 —— 编号全在渲染层认。
 *
 * - 结构化来源(站点 / 日期 / 标题 / 摘要)在工具结果的 metadata.sources 上(引擎 tools/webSources.ts),不进模型上下文。
 * - 老会话没有这份:网址从工具结果的文字里认(web_search 的结果列表、web_fetch 的参数与 `[最终网址]` 头),编号照出,悬停卡退回素卡。
 *   web_fetch 的正文**不扫**:网页正文里的每个链接都保留成 markdown,扫了就全成了来源。
 * - 正文与右栏「来源」卡同用 citeIndexOf,两边的号对得上;悬停联动按「消息 id + 网址」认(citeHoverKey)。
 * - 放在契约目录:引擎不用它,但 Tangu 界面(编号表、右栏)和宿主(Markdown 链接、悬停卡)都要用,纯 TS、零依赖。
 */
import type { ToolEvent, UiMessage, WebSource } from './clientTypes.js'

/** 只认这两个工具上的来源(别的工具结果里就算带了 metadata.sources 也不当来源)。 */
export const CITE_TOOLS: ReadonlySet<string> = new Set(['web_search', 'web_fetch'])

const decode = (s: string): string => { try { return decodeURI(s) } catch { return s } }

/** 正文链接 ↔ 来源的同一把尺:主机(小写、去 www.)+ 端口 + 路径(去尾斜杠、解开百分号转义)+ 查询;不看协议和 #片段。 */
export function citeKey(url: string): string | null {
  let u: URL
  try { u = new URL(url.trim()) } catch { return null }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null
  return `${u.hostname.toLowerCase().replace(/^www\./, '')}${u.port ? `:${u.port}` : ''}${decode(u.pathname).replace(/\/+$/, '')}${decode(u.search)}`
}

const clip = (v: unknown, max: number): string | undefined => {
  if (typeof v !== 'string') return undefined
  const s = v.replace(/\s+/g, ' ').trim()
  return s ? s.slice(0, max) : undefined
}

/** 工具结果 metadata 上的 sources → 干净的 WebSource[](只认 web_search / web_fetch;站点按网址自己算,不信 metadata 里的)。 */
export function sourcesFromMetadata(toolName: string | undefined, metadata: unknown): WebSource[] | undefined {
  if (!toolName || !CITE_TOOLS.has(toolName)) return undefined
  const raw = (metadata as { sources?: unknown } | null | undefined)?.sources
  if (!Array.isArray(raw)) return undefined
  const out: WebSource[] = []
  for (const r of raw.slice(0, 30)) {
    const url = typeof r?.url === 'string' ? r.url.trim() : ''
    if (!url || url.length > 2048 || !/^https?:\/\//i.test(url)) continue
    let site: string
    try { site = new URL(url).hostname.replace(/^www\./i, '').toLowerCase() } catch { continue }
    const s: WebSource = { url, site }
    const title = clip(r.title, 300); if (title) s.title = title
    const date = typeof r.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(r.date) ? r.date : undefined; if (date) s.date = date
    const snippet = clip(r.snippet, 600); if (snippet) s.snippet = snippet
    out.push(s)
  }
  return out.length ? out : undefined
}

// ── 正文里链接出现的顺序 ─────────────────────────────────────────────────────

const TRAIL_PUNCT = /[.,;:!?'"*_~。，；：！？、）】」』》]+$/
// 依次:`](<url>)`、`](url)`(网址里允许一层成对括号)、`<url>` 自动链接、GFM 裸网址
const LINK_RE = /\]\(\s*<(https?:\/\/[^>\s]+)>|\]\(\s*(https?:\/\/[^\s()]*(?:\([^\s()]*\)[^\s()]*)*)|<(https?:\/\/[^>\s]+)>|(https?:\/\/[^\s<>()[\]]+)/gi
const FENCE_RE = /^ {0,3}(`{3,}|~{3,})/

// 引用式链接:定义行 `[label]: url`、用法 `[文字][label]` / `[label][]` / `[label]`
const REF_DEF_RE = /^ {0,3}\[([^\]]+)\]:\s*<?(https?:\/\/[^\s>]+)>?/i
const REF_USE_RE = /\[([^\[\]]*)\]\[([^\[\]]*)\]|\[([^\[\]]+)\](?![(\[:])/g
const refLabel = (s: string): string => s.replace(/\s+/g, ' ').trim().toLowerCase()

/** markdown 里网页链接按**显示**顺序排出来(围栏代码块与行内代码里的不算;引用式链接按用的地方算,定义行不算)。
 *  只用来定编号顺序:漏认的链接照样能对上来源,只是没有号。 */
export function linkUrlsInOrder(md: string): string[] {
  const lines = md.split('\n')
  const code: boolean[] = []
  const defs = new Map<string, string>()
  let fence: string | null = null
  for (const [i, line] of lines.entries()) {
    const f = FENCE_RE.exec(line)
    if (fence) { code[i] = true; if (f && f[1][0] === fence[0] && f[1].length >= fence.length) fence = null; continue }
    if (f) { code[i] = true; fence = f[1]; continue }
    const d = REF_DEF_RE.exec(line)
    if (d) { code[i] = true; const k = refLabel(d[1]); if (!defs.has(k)) defs.set(k, d[2]) }
  }
  const out: string[] = []
  for (const [i, line] of lines.entries()) {
    if (code[i]) continue
    const plain = line.replace(/(`+)[\s\S]*?\1/g, (m) => ' '.repeat(m.length))
    const hits: Array<[number, string]> = []
    for (const m of plain.matchAll(LINK_RE)) {
      const url = m[1] ?? m[2] ?? m[3] ?? m[4]?.replace(TRAIL_PUNCT, '')
      if (url) hits.push([m.index ?? 0, url])
    }
    if (defs.size) {
      for (const m of plain.matchAll(REF_USE_RE)) {
        const label = m[3] ?? (m[2] ? m[2] : m[1])
        const url = label != null ? defs.get(refLabel(label)) : undefined
        if (url) hits.push([m.index ?? 0, url])
      }
      hits.sort((a, b) => a[0] - b[0])
    }
    for (const [, url] of hits) out.push(url)
  }
  return out
}

// ── 一轮的来源与编号 ─────────────────────────────────────────────────────────

export interface CiteEntry {
  key: string
  url: string
  /** 结构化来源;老会话没有(悬停卡退回素卡)。 */
  src?: WebSource
  /** 返回过它的 web_search 调用 id(右栏按调用挂结果)。 */
  searchCalls: string[]
  /** 读过它的 web_fetch 调用 id(右栏「读过」)。 */
  fetchCalls: string[]
  /** web_fetch 读到的文字(来源卡在里面找被引的那句)。 */
  fetchedText?: string
  /** 正文里第一次出现的顺序号;正文没引用的没有号。 */
  n?: number
}

export interface CiteIndex {
  msgId: string
  byKey: Map<string, CiteEntry>
  /** 来源出现的顺序(搜索结果顺序 + 读过的页)。 */
  entries: CiteEntry[]
}

const URL_IN_TEXT = /https?:\/\/[^\s<>()[\]"'`]+/g
const HEADER_URL = /^\[(https?:\/\/[^\]\s]+)[\]\s]/

function argsUrl(ev: ToolEvent): string | undefined {
  try { const u = ev.arguments ? JSON.parse(ev.arguments)?.url : undefined; return typeof u === 'string' ? u : undefined } catch { return undefined }
}

/** 把 other 并进 into(同一页的两条):调用记录取并集,结构化来源 / 读到的文字缺哪补哪,other 的键都改指 into。 */
function mergeEntry(into: CiteEntry, other: CiteEntry, byKey: Map<string, CiteEntry>, entries: CiteEntry[]): void {
  for (const c of other.searchCalls) if (!into.searchCalls.includes(c)) into.searchCalls.push(c)
  for (const c of other.fetchCalls) if (!into.fetchCalls.includes(c)) into.fetchCalls.push(c)
  into.src ??= other.src
  into.fetchedText ??= other.fetchedText
  for (const [k, e] of byKey) if (e === other) byKey.set(k, into)
  entries.splice(entries.indexOf(other), 1)
}

function buildIndex(msgId: string, events: ToolEvent[], content: string): CiteIndex | null {
  const byKey = new Map<string, CiteEntry>()
  const entries: CiteEntry[] = []
  const add = (url: string, src?: WebSource): CiteEntry | null => {
    const key = citeKey(url)
    if (!key) return null
    let e = byKey.get(key)
    if (!e) { e = { key, url, searchCalls: [], fetchCalls: [] }; byKey.set(key, e); entries.push(e) }
    if (src && !e.src) e.src = src
    return e
  }
  for (const ev of events) {
    if (!ev.done || ev.isError || !CITE_TOOLS.has(ev.name)) continue
    if (ev.name === 'web_search') {
      const list: Array<{ url: string; src?: WebSource }> = ev.sources?.length
        ? ev.sources.map((s) => ({ url: s.url, src: s }))
        : [...new Set((ev.result || '').match(URL_IN_TEXT) || [])].slice(0, 30).map((u) => ({ url: u.replace(TRAIL_PUNCT, '') }))
      for (const { url, src } of list) {
        const e = add(url, src)
        if (e && !e.searchCalls.includes(ev.id)) e.searchCalls.push(ev.id)
      }
    } else {
      // 要的网址与跳转后的网址都认成同一页(模型可能引任何一个);正文不扫
      const src = ev.sources?.[0]
      const header = HEADER_URL.exec(ev.result || '')?.[1]
      const urls = [src?.url, header, argsUrl(ev)].filter((u): u is string => !!u)
      const keys = urls.map(citeKey).filter((k): k is string => !!k)
      // 已经有的(任何一个网址对得上)并成一条:要的网址和跳转后的网址各是一个搜索结果时也是同一页,否则按第一个网址新开一条
      const known = [...new Set(keys.map((k) => byKey.get(k)).filter((e): e is CiteEntry => !!e))]
      const first = known[0] ?? (urls.length ? add(urls[0], urls[0] === src?.url ? src : undefined) : null)
      if (!first) continue
      for (const other of known.slice(1)) mergeEntry(first, other, byKey, entries)
      for (const k of keys) byKey.set(k, first)
      if (!first.fetchCalls.includes(ev.id)) first.fetchCalls.push(ev.id)
      if (!first.fetchedText && ev.result) first.fetchedText = ev.result
      if (src && !first.src) first.src = src
    }
  }
  if (!entries.length) return null
  let n = 0
  for (const url of linkUrlsInOrder(content)) {
    const k = citeKey(url)
    const e = k ? byKey.get(k) : undefined
    if (e && e.n == null) e.n = ++n
  }
  return { msgId, byKey, entries }
}

const cache = new WeakMap<ToolEvent[], { content: string; msgId: string; index: CiteIndex | null }>()

/** 一条回答的来源编号表。没有搜索 / 读网页就是 null(绝大多数消息,一眼跳过)。按 toolEvents 引用 + 正文缓存,正文与右栏共用一份。 */
export function citeIndexOf(msg: Pick<UiMessage, 'id' | 'content' | 'toolEvents'>): CiteIndex | null {
  const events = msg.toolEvents
  if (!events?.length || !events.some((ev) => CITE_TOOLS.has(ev.name))) return null
  const content = msg.content || ''
  const hit = cache.get(events)
  if (hit && hit.content === content && hit.msgId === msg.id) return hit.index
  const index = buildIndex(msg.id, events, content)
  cache.set(events, { content, msgId: msg.id, index })
  return index
}

/** 正文编号 ↔ 右栏「来源」行的悬停联动键:消息 id + 网址键(同一网址在不同回答里各是各的号)。 */
export const citeHoverKey = (msgId: string, key: string): string => `${msgId}\u0000${key}`

/** 聊天回答交给 Markdown(宿主)的来源编号:编号表 + 悬停联动的读写口。悬停状态归 Tangu 界面(views/chat2/citeHover),
 *  宿主只经这几个函数读写,不 import 它(tangu-boundary:Tangu → 宿主、宿主 → Tangu 都不加新依赖)。
 *  from:悬停的是正文链接还是右栏那行 —— 右栏悬停时正文链接才垫底色,正文自己悬停只亮编号。 */
export interface CiteBinding {
  index: CiteIndex
  subscribe(onChange: () => void): () => void
  hotOf(key: string): 'body' | 'rail' | null
  enter(key: string, from: 'body' | 'rail'): void
  leave(key: string): void
}

/** 正文链接查来源。 */
export function citeEntryOf(index: CiteIndex | null | undefined, href: string): CiteEntry | undefined {
  if (!index) return undefined
  const k = citeKey(href)
  return k ? index.byKey.get(k) : undefined
}

// ── 来源卡的摘要:被引那句垫底色 ─────────────────────────────────────────────

export interface Excerpt { before: string; hit: string; after: string }

const norm = (s: string): string => s.replace(/\s+/g, ' ').trim()

/** 在 text 里找 phrase(空白归一后逐字包含才算),切出它前后一段;找不到给 null。before 太长就从附近的句首起,免得那句被三行截断挤出去。 */
export function excerptAround(text: string | undefined, phrase: string, room = 70): Excerpt | null {
  const t = norm(text || '')
  const p = norm(phrase)
  if (!t || p.length < 2) return null
  const i = t.indexOf(p)
  if (i < 0) return null
  let start = Math.max(0, i - room)
  let midSentence = start > 0
  if (start > 0) {
    const cut = t.slice(start, i).search(/[。！？.!?；;]\s*[^。！？.!?；;]*$/)
    if (cut >= 0) { start += cut + 1; midSentence = false }
  }
  const end = Math.min(t.length, i + p.length + room * 2)
  return {
    before: `${midSentence ? '…' : ''}${t.slice(start, i).trimStart()}`,
    hit: t.slice(i, i + p.length),
    after: `${t.slice(i + p.length, end)}${end < t.length ? '…' : ''}`,
  }
}

/** 来源卡的摘要:搜索结果的摘要;读过的页先在读到的文字里找那句,找不到用页面自己的描述。 */
export function cardExcerpt(entry: CiteEntry, phrase: string): Excerpt | null {
  const snippet = entry.src?.snippet
  const inSnippet = snippet ? excerptAround(snippet, phrase) : null
  if (inSnippet) return inSnippet
  const inPage = entry.fetchedText ? excerptAround(entry.fetchedText, phrase) : null
  if (inPage) return inPage
  return snippet ? { before: snippet, hit: '', after: '' } : null
}
