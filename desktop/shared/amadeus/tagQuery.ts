// `tag:` 行级搜索与标签树的纯逻辑(方案 T2)。主进程索引、手机索引、网页云桥、面板共用这一份。
// 和 links.ts 一样同构:不许碰 Node / Electron / React。
//
// 三件事各一个口径:
//  · 匹配一律走 links.tagMatches(嵌套前缀,大小写不敏感);
//  · 「按文件去重的计数」只有 tagCounts 一处算,桥里别各写一份;
//  · 没有 total 的旧来源(云端 /tags、老宿主)由 buildTagTree 现场退回「自身 + 子项之和」。
import { decodeCharRefs, maskCode, parseTags, plainSnippet, stripForIndex, tagMatches, TAG_RE } from './links'
import { noteFmMeta } from './linkIndex'
import type { SearchHit, SearchHitLine, TagCount } from './ipc'

/** 单文件最多列多少行(SearchHit.hits);月文件一个标签可能几百条,要给负载和渲染封顶。 */
export const TAG_LINE_HITS_MAX = 100
/** 带 tag 条件的查询最多回多少个文件(普通查询仍是 50):标签面板原先列全部文件,这里别缩水太多。 */
export const TAG_SEARCH_FILES_MAX = 200
/** 云端要逐篇读原文才列得出行,回合数比本地索引贵,先封得小一点。 */
export const CLOUD_TAG_SEARCH_FILES_MAX = 50
/** 一行太长时只留标签前后这一截;留的是原文的子串,定位时能拿它当查找串。 */
const LINE_TEXT_MAX = 200
const LINE_TEXT_LEAD = 60

const TAG_TOKEN = /^(-?)tag:#?([\p{L}\p{N}_/-]+)$/iu

export interface ParsedSearch {
  /** 全部要有(交集),写法保留用户打的样子(大小写在匹配时才忽略)。 */
  tags: string[]
  /** 一个都不能有。 */
  notTags: string[]
  /** 去掉 tag 条件后剩下的普通关键词,词间单空格。 */
  text: string
}

/** 拆查询串。`tag:` 后面不合标签字符集的(`tag:a.b`、孤零零的 `tag:`)仍当普通关键词。
 *  ⚠️ 没有 tag 条件时调用方必须原样走旧路径,别拿 text 代替原串(text 把连续空白压成了一个)。 */
export function parseSearchQuery(query: string): ParsedSearch {
  const tags: string[] = []
  const notTags: string[] = []
  const words: string[] = []
  const add = (list: string[], tag: string): void => {
    if (!list.some((t) => t.toLowerCase() === tag.toLowerCase())) list.push(tag)
  }
  for (const token of query.trim().split(/\s+/)) {
    if (!token) continue
    const m = TAG_TOKEN.exec(token)
    const tag = m?.[2].replace(/\/+$/, '')
    if (!m || !tag) words.push(token)
    else add(m[1] ? notTags : tags, tag)
  }
  return { tags, notTags, text: words.join(' ') }
}

export const hasTagFilter = (q: ParsedSearch): boolean => q.tags.length > 0 || q.notTags.length > 0

/** 文件级过滤:tags 是这篇的全部标签(正文 + frontmatter)。 */
export function passesTagFilter(tags: string[], q: ParsedSearch): boolean {
  const has = (query: string): boolean => tags.some((t) => tagMatches(t, query))
  return q.tags.every(has) && !q.notTags.some(has)
}

/** 一行里的标签;传进来的行要先 maskCode,否则代码里的 `#include` 也算。口径同 parseTags。 */
function tagsInLine(line: string): string[] {
  const re = new RegExp(TAG_RE.source, TAG_RE.flags)
  const out: string[] = []
  let m: RegExpExecArray | null
  while ((m = re.exec(line))) if (!/^[0-9/]+$/.test(m[1])) out.push(m[1])
  return out
}

/** 长行留标签周围一截,保证标签看得见;留的是子串(不加省略号),定位仍能拿它当查找串。 */
function clipAround(text: string, tag: string): string {
  if (text.length <= LINE_TEXT_MAX) return text
  const at = text.toLowerCase().indexOf(`#${tag.toLowerCase()}`)
  const start = at < 0 ? 0 : Math.max(0, at - LINE_TEXT_LEAD)
  return text.slice(start, start + LINE_TEXT_MAX)
}

/**
 * 这篇里含目标标签的每一行。行号是清洗文本里的 1-based 行号(同 BacklinkHit);
 * frontmatter 里的算一条 line 0,排最前。代码里的不算(maskCode 口径)。
 *
 * 目标标签之外还有条件时(多个 tag、带关键词)先收窄:月文件里一条闪念就是一行,文件级的交集会把同月别的闪念
 * 全带出来。收窄后一行都不剩(两个标签分在不同行、关键词不在标签那行),退回列全部含目标标签的行。
 */
export function tagLineHits(plain: string, fmTags: string[], q: ParsedSearch, terms: string[] = []): SearchHitLine[] {
  const targets = q.tags
  if (!targets.length) return []
  const matching = (tags: string[]): string[] => tags.filter((t) => targets.some((x) => tagMatches(t, x)))
  const coversAll = (tags: string[]): boolean => targets.every((x) => tags.some((t) => tagMatches(t, x)))
  const rows: Array<SearchHitLine & { strict: boolean }> = []
  const fmHit = matching(fmTags)
  if (fmHit.length) rows.push({ line: 0, text: `tags: ${fmHit.map((t) => `#${t}`).join(' ')}`, strict: !terms.length && coversAll(fmTags) })
  const masked = maskCode(plain).split('\n')
  const lines = plain.split('\n')
  for (let i = 0; i < masked.length; i++) {
    if (!masked[i].includes('#')) continue
    const found = tagsInLine(masked[i])
    const hit = matching(found)
    if (!hit.length) continue
    const lower = lines[i].toLowerCase()
    rows.push({ line: i + 1, text: clipAround(plainSnippet(lines[i]), hit[0]), strict: coversAll(found) && terms.every((t) => lower.includes(t)) })
  }
  const strict = rows.filter((r) => r.strict)
  return (strict.length ? strict : rows).slice(0, TAG_LINE_HITS_MAX).map(({ line, text }) => ({ line, text }))
}

export interface TagSearchDoc {
  path: string
  title: string
  /** 正文 + frontmatter 的全部标签。 */
  tags: string[]
  fmTags: string[]
  /** 清洗并解开字符引用后的正文(同 vaultIndex 的 Entry.plain)。 */
  plain: string
}

const headOf = (plain: string): string => plain.replace(/\s+/g, ' ').trim().slice(0, 120)

/**
 * 带 tag 条件的查询:过标签 → 过关键词(textHit 是各索引自己的普通搜索,命中才回)→ 列行。
 * 只有 `-tag:` 没有 tag 也没有关键词 = 「不带这个标签的全部笔记」:按标题排,没有 hits,界面走普通行。
 */
export function tagSearch<D extends TagSearchDoc>(docs: Iterable<D>, q: ParsedSearch, textHit: (doc: D) => SearchHit | null, terms: string[] = [], limit = TAG_SEARCH_FILES_MAX): SearchHit[] {
  const out: SearchHit[] = []
  for (const doc of docs) {
    if (!passesTagFilter(doc.tags, q)) continue
    const base = q.text ? textHit(doc) : null
    if (q.text && !base) continue
    const lines = tagLineHits(doc.plain, doc.fmTags, q, terms)
    const hit: SearchHit = {
      path: doc.path,
      title: doc.title,
      snippet: base?.snippet ?? lines[0]?.text ?? headOf(doc.plain),
      line: base?.line ?? (lines.find((l) => l.line > 0)?.line ?? 1),
      score: base?.score ?? lines.length,
    }
    if (q.tags.length) hit.hits = lines
    out.push(hit)
  }
  out.sort((a, b) => b.score - a.score || a.title.localeCompare(b.title))
  return out.slice(0, limit)
}

/** 从原文拼 TagSearchDoc:本地索引手里已经有这些字段,这个给现读原文的云桥。清洗口径同 vaultIndex.readEntry。 */
export function tagDocFromRaw(path: string, raw: string): TagSearchDoc {
  const plain = decodeCharRefs(stripForIndex(raw))
  const fmTags = noteFmMeta(raw).tags
  const seen = new Set<string>()
  const tags = [...parseTags(plain), ...fmTags].filter((t) => {
    const k = t.toLowerCase()
    if (seen.has(k)) return false
    seen.add(k)
    return true
  })
  return { path, title: (path.split(/[\\/]/).pop() ?? path).replace(/\.md$/i, ''), tags, fmTags, plain }
}

export interface TagSearchSource {
  listTags(): Promise<TagCount[]>
  /** 精确标签名 → 路径(云端 /tags/pages 不认前缀,前缀在这里用 listTags 展开)。 */
  pagesByTag(tag: string): Promise<string[]>
  allPages(): Promise<string[]>
  /** 普通关键词搜索,给 tag + 关键词混用时取分和摘要。 */
  textSearch(text: string): Promise<SearchHit[]>
  /** 读不到回 null,那篇跳过。 */
  readText(path: string): Promise<string | null>
}

/** 服务端不认 `tag:`、也不懂嵌套前缀的来源(网页云桥):在客户端拼出同样的结果。逐篇读原文,故封顶 limit 篇。 */
export async function tagSearchRemote(q: ParsedSearch, src: TagSearchSource, limit = CLOUD_TAG_SEARCH_FILES_MAX): Promise<SearchHit[]> {
  const listed = await src.listTags()
  const pathsOf = async (query: string): Promise<Set<string>> => {
    const rows = listed.filter((r) => r.count > 0 && tagMatches(r.tag, query))
    return new Set((await Promise.all(rows.map((r) => src.pagesByTag(r.tag)))).flat())
  }
  const groups = await Promise.all(q.tags.map(pathsOf))
  const banned = await Promise.all(q.notTags.map(pathsOf))
  let paths = groups.length ? [...groups[0]] : await src.allPages()
  for (const g of groups.slice(1)) paths = paths.filter((p) => g.has(p))
  paths = paths.filter((p) => !banned.some((g) => g.has(p)))
  const textHits = q.text ? new Map((await src.textSearch(q.text)).map((h) => [h.path, h])) : null
  if (textHits) paths = paths.filter((p) => textHits.has(p))
  const picked = paths.sort().slice(0, limit)
  const docs: TagSearchDoc[] = []
  const READ_CONCURRENCY = 8
  for (let i = 0; i < picked.length; i += READ_CONCURRENCY) {
    const slice = picked.slice(i, i + READ_CONCURRENCY)
    const raws = await Promise.all(slice.map((p) => src.readText(p).catch(() => null)))
    raws.forEach((raw, k) => { if (raw != null) docs.push(tagDocFromRaw(slice[k], raw)) })
  }
  const terms = q.text.toLowerCase().split(/\s+/).filter(Boolean)
  return tagSearch(docs, q, (d) => textHits?.get(d.path) ?? null, terms, limit)
}

// ─────────────────────────────── 计数 ───────────────────────────────

const segmentsOf = (tag: string): string[] => tag.split('/').filter(Boolean)

/**
 * 全库标签计数:count 与从前逐字一致(带这个确切标签的文件数),排序也一致;total = 自身 + 子标签按文件去重;
 * 只作父级存在的前缀补成 `{ count: 0, total }`,排在有真实计数的行后面。
 * 调用方的 tags 须已按文件大小写不敏感去重(索引的 Entry.tags 就是)。
 */
export function tagCounts(files: Iterable<{ tags: string[] }>): TagCount[] {
  const rows = new Map<string, TagCount>()
  const totals = new Map<string, { tag: string; total: number }>()
  for (const file of files) {
    const prefixes = new Map<string, string>()
    for (const t of file.tags) {
      const k = t.toLowerCase()
      const row = rows.get(k)
      if (row) row.count++
      else rows.set(k, { tag: t, count: 1 })
      const segs = segmentsOf(t)
      for (let i = 1; i <= segs.length; i++) {
        const prefix = segs.slice(0, i).join('/')
        if (!prefixes.has(prefix.toLowerCase())) prefixes.set(prefix.toLowerCase(), prefix)
      }
    }
    for (const [k, tag] of prefixes) {
      const cur = totals.get(k)
      if (cur) cur.total++
      else totals.set(k, { tag, total: 1 })
    }
  }
  for (const [k, row] of rows) row.total = totals.get(segmentsOf(k).join('/'))?.total ?? row.count
  for (const [k, { tag, total }] of totals) if (!rows.has(k)) rows.set(k, { tag, count: 0, total })
  return [...rows.values()].sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag))
}

// ─────────────────────────────── 标签树 ───────────────────────────────

export interface TagTreeNode {
  /** 完整标签名,跳搜索用它。 */
  tag: string
  /** 这一层的名字。 */
  name: string
  count: number
  /** 自身 + 子标签。来源给了 total 用它(按文件去重);没给退回自身 + 子项之和,同一文件带父子两个标签时会多算。 */
  total: number
  children: TagTreeNode[]
}

export type TagTreeSort = 'count' | 'name'

/** 展开状态的键:大小写不敏感,与索引分行的口径一致。 */
export const tagTreeKey = (tag: string): string => tag.toLowerCase()

/** TagCount 列表 → 树,按 `/` 分层。缺的父级现场补上,所以旧来源不带 count:0 的行也能成树。 */
export function buildTagTree(rows: TagCount[]): TagTreeNode[] {
  interface Draft extends TagTreeNode { explicit?: number }
  const roots: Draft[] = []
  const byKey = new Map<string, Draft>()
  for (const row of rows) {
    const segs = segmentsOf(row.tag)
    if (!segs.length) continue
    let siblings = roots
    let node: Draft | undefined
    for (let i = 0; i < segs.length; i++) {
      const path = segs.slice(0, i + 1).join('/')
      const key = path.toLowerCase()
      node = byKey.get(key)
      if (!node) {
        node = { tag: path, name: segs[i], count: 0, total: 0, children: [] }
        byKey.set(key, node)
        siblings.push(node)
      }
      siblings = node.children as Draft[]
    }
    if (!node) continue
    if (row.count > 0) {
      if (node.count === 0) node.tag = row.tag // 确切那行的写法优先于别的行切出来的前缀
      node.count += row.count
    }
    if (row.total !== undefined) node.explicit = Math.max(node.explicit ?? 0, row.total)
  }
  const settle = (nodes: Draft[]): void => {
    for (const n of nodes) {
      settle(n.children as Draft[])
      n.total = n.explicit ?? n.count + n.children.reduce((sum, c) => sum + c.total, 0)
      delete n.explicit
    }
  }
  settle(roots)
  return roots
}

/** 同层排序。按数量看 total(折叠时用户只看得见它),并列或按名称时按这层的名字。 */
export function sortTagTree(nodes: TagTreeNode[], sort: TagTreeSort): TagTreeNode[] {
  return [...nodes]
    .sort((a, b) => (sort === 'count' ? b.total - a.total : 0) || a.name.localeCompare(b.name))
    .map((n) => ({ ...n, children: sortTagTree(n.children, sort) }))
}

/** 按完整标签名子串筛选,大小写不敏感,可带 `#`。留下命中的和它们的祖先;open = 要自动展开的那些祖先(不落盘)。 */
export function filterTagTree(nodes: TagTreeNode[], query: string): { nodes: TagTreeNode[]; open: Set<string> } {
  const q = query.trim().replace(/^#/, '').toLowerCase()
  const open = new Set<string>()
  if (!q) return { nodes, open }
  const walk = (list: TagTreeNode[]): TagTreeNode[] => {
    const kept: TagTreeNode[] = []
    for (const n of list) {
      const children = walk(n.children)
      if (children.length) open.add(tagTreeKey(n.tag))
      if (children.length || n.tag.toLowerCase().includes(q)) kept.push({ ...n, children })
    }
    return kept
  }
  return { nodes: walk(nodes), open }
}

// ─────────────────────────────── 结果行 ───────────────────────────────

export interface TagTextPiece {
  text: string
  /** 有 = 这段是 `#标签`(不含 `#`)。 */
  tag?: string
}

/** 结果行切成普通文字和 `#标签` 两种片段,给界面画胶囊。识别口径同 TAG_RE。 */
export function splitTagText(text: string): TagTextPiece[] {
  const re = new RegExp(TAG_RE.source, TAG_RE.flags)
  const out: TagTextPiece[] = []
  let at = 0
  let m: RegExpExecArray | null
  while ((m = re.exec(text))) {
    if (/^[0-9/]+$/.test(m[1])) continue
    const start = m.index + m[0].indexOf('#')
    if (start > at) out.push({ text: text.slice(at, start) })
    out.push({ text: `#${m[1]}`, tag: m[1] })
    at = start + m[1].length + 1
  }
  if (at < text.length) out.push({ text: text.slice(at) })
  return out
}

/** 这行里实际命中查询的标签。查 `#work` 命中 `#work/urgent` 时,定位的回退串要用后者:
 *  `#work` 过不了 tag 右边界。 */
export function matchedTagInLine(text: string, tags: string[]): string | null {
  for (const piece of splitTagText(text)) {
    if (piece.tag && tags.some((q) => tagMatches(piece.tag!, q))) return piece.tag
  }
  return null
}
