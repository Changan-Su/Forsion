// In-memory index for global search, backlinks, tags, and `![[ ]]` block-embed resolution.
// Lives in the main process (it reads files); the renderer queries it over IPC.
//
// v3 format: a note's content lives inline in its one `.md` (blocks delimited by
// `<!-- a id -->` markers), so we index the note's own text directly, parse its markers to
// expose each block for cross-note embeds, and record which blocks each note embeds.

import { promises as fs } from 'node:fs'
import path from 'node:path'
import { linkTarget, pageKey, parseEmbeds, parseTags, parseWikiLinks, resolvePageName, stripForIndex } from '@amadeus-shared/links'
import { parseBody, stripFrontmatter } from '@amadeus-shared/compiler'
import { assetKey, assetRefs } from '@amadeus-shared/assets'
import type { BacklinkRef, SearchHit, TagCount } from '@amadeus-shared/ipc'
import { parseMdMarks, type MdMark } from '@amadeus-shared/mdMarks'
import type { VaultManager } from './vaultManager'

interface Entry {
  path: string
  title: string
  key: string
  text: string
  lower: string
  links: string[] // distinct outgoing [[link]] targets
  embeds: string[] // distinct raw `![[note#id]]` targets this note embeds
  tags: string[]
  blocks: { id: string; content: string }[] // inline blocks this note owns
  /** fm `icon:` 的页面 emoji(树/标题展示);缺 = 无。 */
  icon?: string
}

/** 从原文抠 frontmatter 的 icon 键(带引号可容;不整套解析 YAML,一个键不值得)。 */
function parseFmIcon(raw: string): string | undefined {
  const fm = /^---\r?\n([\s\S]*?)\r?\n---/.exec(raw)?.[1]
  if (!fm) return undefined
  const m = /^icon:[ \t]*["']?([^"'\r\n]+?)["']?[ \t]*$/m.exec(fm)
  const v = m?.[1]?.trim()
  return v || undefined
}

const READ_CONCURRENCY = 16

function normId(s: string): string {
  return s.trim().replace(/\.block$/i, '').toLowerCase() // tolerate a v2-style basename
}

/** Split a `![[ ]]` target into its note (by key, or null) + block id. Block ids are only
 *  unique WITHIN a note, so `note#3` must resolve note-scoped — the note part is required. */
function parseEmbedTarget(target: string): { noteKey: string | null; id: string } {
  const hash = target.lastIndexOf('#')
  if (hash < 0) return { noteKey: null, id: normId(target) }
  const note = target.slice(0, hash).trim()
  return { noteKey: note ? pageKey(note) : null, id: normId(target.slice(hash + 1)) }
}

function embedMatches(rawTarget: string, ownerKey: string | null, id: string): boolean {
  const t = parseEmbedTarget(rawTarget)
  return t.id === id && (t.noteKey === null || t.noteKey === ownerKey)
}

export class VaultIndex {
  private entries = new Map<string, Entry>()

  constructor(private readonly vault: VaultManager) {}

  /** Full rebuild from disk. Safe to call before a vault is open (no-ops). */
  async build(): Promise<void> {
    this.entries.clear()
    let pages: string[]
    try {
      pages = await this.vault.listPages()
    } catch {
      return
    }
    for (let i = 0; i < pages.length; i += READ_CONCURRENCY) {
      const slice = pages.slice(i, i + READ_CONCURRENCY)
      const read = await Promise.all(slice.map((p) => this.readEntry(p)))
      for (const e of read) if (e) this.entries.set(e.path, e)
    }
  }

  async update(pagePath: string): Promise<void> {
    const e = await this.readEntry(pagePath)
    if (e) this.entries.set(pagePath, e)
    else this.entries.delete(pagePath)
  }

  remove(pagePath: string): void {
    this.entries.delete(pagePath)
  }

  async rename(oldPath: string, newPath: string): Promise<void> {
    this.entries.delete(oldPath)
    await this.update(newPath)
  }

  private async readEntry(p: string): Promise<Entry | null> {
    let raw: string
    try {
      raw = await fs.readFile(this.vault.absPath(p), 'utf8')
    } catch {
      return null
    }
    const text = stripForIndex(raw) // frontmatter + marker comments stripped → clean content
    const blocks = parseBody(stripFrontmatter(raw))
      .filter((b) => b.id)
      .map((b) => ({ id: b.id!.toLowerCase(), content: b.content }))
    const title = (p.split(/[\\/]/).pop() ?? p).replace(/\.md$/i, '')
    return {
      path: p,
      title,
      key: pageKey(p),
      text,
      lower: text.toLowerCase(),
      links: parseWikiLinks(text),
      embeds: parseEmbeds(raw), // raw `note#id` targets (matched note-scoped on demand)
      tags: parseTags(text),
      blocks,
      icon: parseFmIcon(raw),
    }
  }

  /** 全库页面 emoji 图标(path → icon;只含设置了的)。 */
  pageIcons(): Record<string, string> {
    const out: Record<string, string> = {}
    for (const e of this.entries.values()) if (e.icon) out[e.path] = e.icon
    return out
  }

  /**
   * 「开启云同步」弹窗的递归关联闭包:从条目出发,沿 [[出链]]/![[嵌入]]/markdown 图片
   * 一路收集关联笔记与附件(visited 防环),只返回**种子范围之外**的部分
   * (范围内的东西 scope 本来就带)。另外单列 subPages = 种子页的 `<stem>.fd/` 子笔记树:
   * scope 本来就带,但用户要能看见并剔除(取消勾选 → entrySync 的 exclude)。
   */
  async relatedClosure(
    rootRel: string,
    kind: 'page' | 'folder',
  ): Promise<{ pages: string[]; files: string[]; subPages: string[] }> {
    const nfc = (s: string): string => s.replace(/\\/g, '/').normalize('NFC')
    const root = nfc(rootRel)
    const allPages = [...this.entries.keys()].sort()
    const byNfc = new Map(allPages.map((p) => [nfc(p), p]))
    const seedFd = `${root.replace(/\.md$/i, '')}.fd/`
    const inSeedScope = (rel: string): boolean => {
      const r = nfc(rel)
      if (kind === 'folder') return r === root || r.startsWith(`${root}/`)
      return r === root || r.startsWith(seedFd)
    }
    const seeds = allPages.filter((p) => inSeedScope(p))
    const vaultRoot = this.vault.getRoot()
    const visited = new Set<string>()
    const files = new Set<string>()
    const queue = [...seeds]
    // 镜像 shared/amadeus/assets.ts 的 IMG_RE(未导出;落盘形态标准 md 图片不在 links/embeds 里)。
    const IMG_RE = /!\[[^\]]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g
    const isExternal = (u: string): boolean => /^(https?:|data:|amadeus-asset:|blob:|\/)/.test(u)
    const addFile = async (pagePath: string, ref: string): Promise<void> => {
      if (!vaultRoot) return
      const abs = await this.vault.resolveAttachment(pagePath, ref).catch(() => null)
      if (!abs) return
      const alive = await fs.stat(abs).then((s) => s.isFile()).catch(() => false)
      if (!alive) return
      const rel = path.relative(vaultRoot, abs).split(path.sep).join('/')
      if (rel.startsWith('..')) return
      files.add(rel)
    }
    while (queue.length) {
      const p = queue.pop()!
      if (visited.has(p)) continue
      visited.add(p)
      const e = this.entries.get(p)
      if (!e) continue
      const fd = `${p.replace(/\.md$/i, '')}.fd/`
      for (const q of allPages) if (nfc(q).startsWith(nfc(fd)) && !visited.has(q)) queue.push(q)
      for (const t of e.links) {
        const hit = resolvePageName(t, allPages, p)
        if (hit && !visited.has(hit)) queue.push(hit)
      }
      for (const raw of e.embeds) {
        const hash = raw.lastIndexOf('#')
        const base = (hash >= 0 ? raw.slice(0, hash) : raw).trim()
        if (!base) continue // 本笔记内块嵌入
        const ext = /\.([a-z0-9]+)$/i.exec(base)?.[1]
        if (!ext || /^md$/i.test(ext)) {
          const hit = resolvePageName(base.replace(/\.md$/i, ''), allPages, p) ?? byNfc.get(nfc(base))
          if (hit && !visited.has(hit)) queue.push(hit)
        } else {
          await addFile(p, base)
        }
      }
      let m: RegExpExecArray | null
      IMG_RE.lastIndex = 0
      while ((m = IMG_RE.exec(e.text))) {
        const u = m[1].trim()
        if (!isExternal(u)) await addFile(p, u)
      }
    }
    return {
      pages: [...visited].filter((p) => !inSeedScope(p)).sort(),
      files: [...files].filter((f) => !inSeedScope(f)).sort(),
      // 文件夹条目的「子页面」= 整棵子树,列出来只是噪音(勾选粒度按文件夹走),故仅页面条目给。
      subPages: kind === 'page' ? seeds.filter((p) => nfc(p) !== root).sort() : [],
    }
  }

  /** Resolve a `![[note#id]]` embed to its content + owning note (note-scoped by id). */
  resolveBlock(target: string): { path: string; content: string; type: string } | null {
    const { noteKey, id } = parseEmbedTarget(target)
    for (const e of this.entries.values()) {
      if (noteKey && e.key !== noteKey) continue
      const b = e.blocks.find((x) => x.id === id)
      if (b) return { path: e.path, content: b.content, type: 'markdown' }
    }
    // 整篇笔记转写:`![[笔记名]]` 无 `#` 块锚 → 按名(四级规则,同 `[[链接]]`)解析到笔记,返回整篇正文
    // (`text` 已剥 frontmatter/marker → 干净 md,交前端 markdown 块只读渲染)。
    // ponytail: 被嵌笔记里的 `![[db]]`/画板/二次嵌入只作源码行渲染(块级重解析在 BlockHost,不在本层);
    //           要活块级需满血多块渲染,现不值当。
    if (!target.includes('#')) {
      const notePath = resolvePageName(target, [...this.entries.keys()].sort())
      const e = notePath ? this.entries.get(notePath) : undefined
      if (e) return { path: e.path, content: e.text, type: 'markdown' }
    }
    return null
  }

  /** Notes that embed the given block (passed as its own `note#id`), for safe-delete warnings. */
  blockBacklinks(target: string): BacklinkRef[] {
    const { noteKey, id } = parseEmbedTarget(target)
    const out: BacklinkRef[] = []
    for (const e of this.entries.values()) {
      if (noteKey && e.key === noteKey) continue // the home note isn't a backlink
      if (!e.embeds.some((raw) => embedMatches(raw, noteKey, id))) continue
      out.push({ path: e.path, title: e.title, snippet: e.title })
    }
    out.sort((a, b) => a.title.localeCompare(b.title))
    return out
  }

  /** 全库正文里带 `@` 时间标记的行(只读)。索引已持有清洗后的全文(stripForIndex 只剥
   *  frontmatter 与注释,`- [ ]` 与 `#` 标题原样留着)且随 watcher 逐文件增量更新 ——
   *  这里只遍历内存字符串,不读盘、不碰 build()。解析口径单源在 @amadeus-shared/mdMarks。 */
  marks(): MdMark[] {
    const out: MdMark[] = []
    for (const e of [...this.entries.values()].sort((a, b) => a.path.localeCompare(b.path))) {
      out.push(...parseMdMarks(e.text, e.path, e.title))
    }
    return out
  }

  search(query: string): SearchHit[] {
    const q = query.trim().toLowerCase()
    if (!q) return []
    // 多词 = **模糊到词一级**:全部词都出现即命中,顺序不论、隔着什么符号也不论
    // (用户实报:「moc forsion」要能找到 moc-forsion)。单词查询与从前逐字节一致。
    const terms = searchTerms(q)
    const hits: SearchHit[] = []
    for (const e of this.entries.values()) {
      const title = e.title.toLowerCase()
      if (!terms.every((t) => e.lower.includes(t) || title.includes(t))) continue
      // 摘要/行号锚在**第一个能在正文里找到的词**上(整串找不到时退到词)。
      const bodyIdx = e.lower.indexOf(q) >= 0 ? e.lower.indexOf(q) : terms.map((t) => e.lower.indexOf(t)).find((i) => i >= 0) ?? -1
      const titleHit = title.includes(q) || terms.every((t) => title.includes(t))
      if (bodyIdx < 0 && !titleHit) continue

      let snippet = ''
      let line = 1
      let score = 0

      if (bodyIdx >= 0) {
        const anchor = e.lower.startsWith(q, bodyIdx) ? q : (terms.find((t) => e.lower.startsWith(t, bodyIdx)) ?? q)
        const start = Math.max(0, bodyIdx - 40)
        const end = Math.min(e.text.length, bodyIdx + anchor.length + 80)
        snippet =
          (start > 0 ? '…' : '') +
          e.text.slice(start, end).replace(/\s+/g, ' ').trim() +
          (end < e.text.length ? '…' : '')
        line = countNewlines(e.text, bodyIdx) + 1
        score += 5 - Math.min(4, bodyIdx / 200)
        let n = 0
        let from = 0
        while ((from = e.lower.indexOf(anchor, from)) >= 0) {
          n++
          from += anchor.length
          if (n > 20) break
        }
        score += Math.min(5, n)
      }
      if (titleHit) {
        score += 12
        if (terms.length > 1 && !title.includes(q)) score -= 4 // 分词命中不如整串命中
        if (!snippet) snippet = e.text.replace(/\s+/g, ' ').trim().slice(0, 120)
        if (e.title.toLowerCase() === q) score += 8
      }
      hits.push({ path: e.path, title: e.title, snippet, line, score })
    }
    hits.sort((a, b) => b.score - a.score)
    return hits.slice(0, 50)
  }

  backlinks(targetPath: string): BacklinkRef[] {
    if (!pageKey(targetPath)) return []
    // 逐条把原始链接按「源笔记上下文」重解析,只有真正解析到 targetPath 的才算反链
    // (重名笔记不再互相污染)。pages 排序 = 解析规则(4)的确定性并列序。
    // ponytail: O(entries×links×pages) 朴素扫,个人 vault 规模足够。
    const pages = [...this.entries.keys()].sort()
    const out: BacklinkRef[] = []
    for (const e of this.entries.values()) {
      if (e.path === targetPath) continue
      const hits = (l: string): boolean => resolvePageName(l, pages, e.path) === targetPath
      if (!e.links.some(hits)) continue
      out.push({ path: e.path, title: e.title, snippet: backlinkSnippet(e.text, hits) })
    }
    out.sort((a, b) => a.title.localeCompare(b.title))
    return out
  }

  /**
   * 该笔记引用、且**全库没有第二篇笔记引用**的附件(vault 相对路径)。删除笔记时可一并清理。
   *
   * 判据刻意保守 —— 只要别的笔记提到同名文件就算共享,宁可留孤儿也绝不误删别人的图
   * (毁档防线)。索引里的 text 是「去 frontmatter/去标记注释」的原文,`![[x]]`、`[[x]]`、
   * `![](x)` 三种写法都还在,足够抽引用;.md(含画板/思维导图)一律不算附件,不参与删除。
   * ponytail: O(笔记数×引用数) 朴素扫,只在用户按删除时跑一次。
   */
  async exclusiveAssets(pagePath: string): Promise<string[]> {
    const self = this.entries.get(pagePath)
    const root = this.vault.getRoot()
    if (!self || !root) return []
    const mine = assetRefs(self.text)
    if (!mine.length) return []
    const shared = new Set<string>()
    for (const e of this.entries.values()) {
      if (e.path === pagePath) continue
      for (const r of assetRefs(e.text)) shared.add(assetKey(r))
    }
    const out: string[] = []
    for (const ref of mine) {
      if (shared.has(assetKey(ref))) continue
      const abs = await this.vault.resolveAttachment(pagePath, ref)
      if (!abs) continue
      const rel = path.relative(root, abs)
      if (rel && !rel.startsWith('..') && !path.isAbsolute(rel) && !out.includes(rel)) out.push(rel)
    }
    return out.sort()
  }

  listTags(): TagCount[] {
    const counts = new Map<string, TagCount>()
    for (const e of this.entries.values()) {
      for (const t of e.tags) {
        const k = t.toLowerCase()
        const c = counts.get(k)
        if (c) c.count++
        else counts.set(k, { tag: t, count: 1 })
      }
    }
    return [...counts.values()].sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag))
  }

  pagesByTag(tag: string): string[] {
    const k = tag.toLowerCase()
    const out: string[] = []
    for (const e of this.entries.values()) {
      if (e.tags.some((t) => t.toLowerCase() === k)) out.push(e.path)
    }
    return out.sort()
  }
}

/** 查询串 → 词表。空白/连字符/下划线/斜杠/点一律当分隔符 —— 用户不该记得原名里到底用的哪一种
 *  (实报:「moc forsion」要找得到 moc-forsion)。切不出多个词时返回原串,行为与从前逐字节一致。 */
export function searchTerms(q: string): string[] {
  const parts = q.split(/[\s\-_/.]+/).filter(Boolean)
  return parts.length > 1 ? parts : [q]
}

function countNewlines(s: string, end: number): number {
  let n = 0
  const stop = Math.min(end, s.length)
  for (let i = 0; i < stop; i++) if (s[i] === '\n') n++
  return n
}

/** The line containing the first [[link]] whose target satisfies `isMatch`(与 backlinks 同一解析判据,摘录引对重名)。 */
function backlinkSnippet(text: string, isMatch: (target: string) => boolean): string {
  const re = /\[\[([^\]\n]+)\]\]/g
  let m: RegExpExecArray | null
  while ((m = re.exec(text))) {
    if (!isMatch(linkTarget(m[1]))) continue
    let start = text.lastIndexOf('\n', m.index)
    start = start < 0 ? 0 : start + 1
    let end = text.indexOf('\n', m.index)
    if (end < 0) end = text.length
    return text.slice(start, end).replace(/\s+/g, ' ').trim().slice(0, 160)
  }
  return ''
}
