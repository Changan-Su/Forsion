// 移植自 desktop/electron/amadeus/fs/vaultIndex.ts。~100% 纯内存逻辑;唯一 IO(readEntry 的 fs.readFile)
// 改走 vault.readTextAbs(Capacitor)。links/compiler 是 isomorphic 纯 JS,原样复用。
import { decodeCharRefs, pageKey, parseEmbeds, parseTags, parseWikiLinks, plainSnippet, resolvePageName, stripForIndex, tagMatches } from '@amadeus-shared/links'
import { backlinkHits, mentionHits, noteFmMeta, type FmLinkProp } from '@amadeus-shared/linkIndex'
import { parseBody, stripFrontmatter } from '@amadeus-shared/compiler'
import type { BacklinkHit, BacklinkRef, SearchHit, TagCount, UnlinkedMention } from '@amadeus-shared/ipc'
import type { VaultManager } from './vaultManager'

interface Entry {
  path: string
  title: string
  key: string
  text: string
  /** text 解开数字字符引用后的副本(逐行对齐):搜索 / 摘要 / 标签 / 双链读它(desktop vaultIndex 同款)。 */
  plain: string
  lower: string
  links: string[]
  embeds: string[]
  tags: string[]
  /** fm `aliases:` / 带 `[[ ]]` 的 fm 属性(desktop vaultIndex 同款,口径在 shared/amadeus/linkIndex)。 */
  aliases: string[]
  fmLinks: FmLinkProp[]
  blocks: { id: string; content: string }[]
  /** frontmatter `icon:`(页面 emoji 图标;desktop vaultIndex 同款)。 */
  icon?: string
}

function parseFmIcon(raw: string): string | undefined {
  const fm = /^\uFEFF?---\r?\n([\s\S]*?)\r?\n---/.exec(raw)?.[1] // 容文件头 BOM(口径同 split.ts)
  if (!fm) return undefined
  const m = /^icon:[ \t]*["']?([^"'\r\n]+?)["']?[ \t]*$/m.exec(fm)
  const v = m?.[1]?.trim()
  return v || undefined
}

const READ_CONCURRENCY = 16

function normId(s: string): string {
  return s.trim().replace(/\.block$/i, '').toLowerCase()
}

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

  async build(): Promise<void> {
    this.entries.clear()
    let pages: string[]
    try { pages = await this.vault.listPages() } catch { return }
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

  remove(pagePath: string): void { this.entries.delete(pagePath) }

  async rename(oldPath: string, newPath: string): Promise<void> {
    this.entries.delete(oldPath)
    await this.update(newPath)
  }

  private async readEntry(p: string): Promise<Entry | null> {
    let raw: string
    try { raw = await this.vault.readTextAbs(this.vault.absPath(p)) } catch { return null }
    const text = stripForIndex(raw)
    const plain = decodeCharRefs(text)
    const blocks = parseBody(stripFrontmatter(raw))
      .filter((b) => b.id)
      .map((b) => ({ id: b.id!.toLowerCase(), content: b.content }))
    const title = (p.split(/[\\/]/).pop() ?? p).replace(/\.md$/i, '')
    const meta = noteFmMeta(raw)
    return {
      path: p, title, key: pageKey(p),
      text, plain, lower: plain.toLowerCase(),
      links: mergeCi(parseWikiLinks(plain), meta.links.flatMap((l) => l.targets)),
      embeds: parseEmbeds(raw),
      tags: mergeCi(parseTags(plain), meta.tags),
      aliases: meta.aliases,
      fmLinks: meta.links,
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

  /** 全库 fm 别名(path → aliases;只含设置了的)。 */
  pageAliases(): Record<string, string[]> {
    const out: Record<string, string[]> = {}
    for (const e of this.entries.values()) if (e.aliases.length) out[e.path] = e.aliases
    return out
  }

  resolveBlock(target: string): { path: string; content: string; type: string } | null {
    const { noteKey, id } = parseEmbedTarget(target)
    for (const e of this.entries.values()) {
      if (noteKey && e.key !== noteKey) continue
      const b = e.blocks.find((x) => x.id === id)
      if (b) return { path: e.path, content: b.content, type: 'markdown' }
    }
    // 整篇笔记转写:`![[笔记名]]` 无 `#` 块锚 → 按名(四级规则,同 `[[链接]]`)解析到笔记,返回整篇正文
    // (`text` 已剥 frontmatter/marker → 干净 md,交前端 markdown 块只读渲染)。
    // ponytail: 被嵌笔记里的 `![[db]]`/画板/二次嵌入只作源码行渲染(块级重解析在 BlockHost,不在本层)。
    if (!target.includes('#')) {
      const notePath = resolvePageName(target, [...this.entries.keys()].sort())
      const e = notePath ? this.entries.get(notePath) : undefined
      if (e) return { path: e.path, content: e.text, type: 'markdown' }
    }
    return null
  }

  blockBacklinks(target: string): BacklinkRef[] {
    const { noteKey, id } = parseEmbedTarget(target)
    const out: BacklinkRef[] = []
    for (const e of this.entries.values()) {
      if (noteKey && e.key === noteKey) continue
      if (!e.embeds.some((raw) => embedMatches(raw, noteKey, id))) continue
      out.push({ path: e.path, title: e.title, snippet: e.title })
    }
    out.sort((a, b) => a.title.localeCompare(b.title))
    return out
  }

  search(query: string): SearchHit[] {
    const q = query.trim().toLowerCase()
    if (!q) return []
    const hits: SearchHit[] = []
    for (const e of this.entries.values()) {
      const bodyIdx = e.lower.indexOf(q)
      const titleHit = e.title.toLowerCase().includes(q)
      if (bodyIdx < 0 && !titleHit) continue
      let snippet = ''
      let line = 1
      let score = 0
      if (bodyIdx >= 0) {
        const start = Math.max(0, bodyIdx - 40)
        const end = Math.min(e.plain.length, bodyIdx + q.length + 80)
        snippet =
          (start > 0 ? '…' : '') +
          e.plain.slice(start, end).replace(/\s+/g, ' ').trim() +
          (end < e.plain.length ? '…' : '')
        line = countNewlines(e.plain, bodyIdx) + 1
        score += 5 - Math.min(4, bodyIdx / 200)
        let n = 0
        let from = 0
        while ((from = e.lower.indexOf(q, from)) >= 0) { n++; from += q.length; if (n > 20) break }
        score += Math.min(5, n)
      }
      if (titleHit) {
        score += 12
        if (!snippet) snippet = e.plain.replace(/\s+/g, ' ').trim().slice(0, 120)
        if (e.title.toLowerCase() === q) score += 8
      }
      hits.push({ path: e.path, title: e.title, snippet, line, score })
    }
    hits.sort((a, b) => b.score - a.score)
    return hits.slice(0, 50)
  }

  backlinks(targetPath: string): BacklinkRef[] {
    if (!pageKey(targetPath)) return []
    // 与 desktop vaultIndex 同款:原始链接按源上下文重解析,重名不互相污染。
    const pages = [...this.entries.keys()].sort()
    const out: BacklinkRef[] = []
    for (const e of this.entries.values()) {
      if (e.path === targetPath) continue
      const isMatch = (l: string): boolean => resolvePageName(l, pages, e.path) === targetPath
      if (!e.links.some(isMatch)) continue
      const hits: BacklinkHit[] = [
        ...e.fmLinks.filter((l) => l.targets.some(isMatch)).map((l) => ({ line: 0, text: `${l.key}: ${plainSnippet(l.text)}` })),
        ...backlinkHits(e.plain, isMatch),
      ]
      out.push({ path: e.path, title: e.title, snippet: hits[0]?.text ?? '', hits })
    }
    out.sort((a, b) => a.title.localeCompare(b.title))
    return out
  }

  unlinkedMentions(targetPath: string): UnlinkedMention[] {
    const target = this.entries.get(targetPath)
    if (!target) return []
    const names = [target.title, ...target.aliases]
    const out: UnlinkedMention[] = []
    for (const e of this.entries.values()) {
      if (e.path === targetPath) continue
      const hits = mentionHits(e.plain, e.text, names)
      if (hits.length) out.push({ path: e.path, title: e.title, hits })
    }
    out.sort((a, b) => a.title.localeCompare(b.title))
    return out
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

  /** 嵌套标签按前缀(desktop 同款):查 `work` 也命中 `work/urgent`。 */
  pagesByTag(tag: string): string[] {
    const out: string[] = []
    for (const e of this.entries.values()) {
      if (e.tags.some((t) => tagMatches(t, tag))) out.push(e.path)
    }
    return out.sort()
  }
}

function countNewlines(s: string, end: number): number {
  let n = 0
  const stop = Math.min(end, s.length)
  for (let i = 0; i < stop; i++) if (s[i] === '\n') n++
  return n
}

function mergeCi(a: string[], b: string[]): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const x of [...a, ...b]) {
    const k = x.toLowerCase()
    if (seen.has(k)) continue
    seen.add(k)
    out.push(x)
  }
  return out
}
