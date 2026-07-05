// 移植自 desktop/electron/amadeus/fs/vaultIndex.ts。~100% 纯内存逻辑;唯一 IO(readEntry 的 fs.readFile)
// 改走 vault.readTextAbs(Capacitor)。links/compiler 是 isomorphic 纯 JS,原样复用。
import { linkTarget, pageKey, parseEmbeds, parseTags, parseWikiLinks, stripForIndex } from '@amadeus-shared/links'
import { parseBody, stripFrontmatter } from '@amadeus-shared/compiler'
import type { BacklinkRef, SearchHit, TagCount } from '@amadeus-shared/ipc'
import type { VaultManager } from './vaultManager'

interface Entry {
  path: string
  title: string
  key: string
  text: string
  lower: string
  links: string[]
  embeds: string[]
  tags: string[]
  blocks: { id: string; content: string }[]
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
    const blocks = parseBody(stripFrontmatter(raw))
      .filter((b) => b.id)
      .map((b) => ({ id: b.id!.toLowerCase(), content: b.content }))
    const title = (p.split(/[\\/]/).pop() ?? p).replace(/\.md$/i, '')
    return {
      path: p, title, key: pageKey(p),
      text, lower: text.toLowerCase(),
      links: parseWikiLinks(text),
      embeds: parseEmbeds(raw),
      tags: parseTags(text),
      blocks,
    }
  }

  resolveBlock(target: string): { path: string; content: string; type: string } | null {
    const { noteKey, id } = parseEmbedTarget(target)
    for (const e of this.entries.values()) {
      if (noteKey && e.key !== noteKey) continue
      const b = e.blocks.find((x) => x.id === id)
      if (b) return { path: e.path, content: b.content, type: 'markdown' }
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
        const end = Math.min(e.text.length, bodyIdx + q.length + 80)
        snippet =
          (start > 0 ? '…' : '') +
          e.text.slice(start, end).replace(/\s+/g, ' ').trim() +
          (end < e.text.length ? '…' : '')
        line = countNewlines(e.text, bodyIdx) + 1
        score += 5 - Math.min(4, bodyIdx / 200)
        let n = 0
        let from = 0
        while ((from = e.lower.indexOf(q, from)) >= 0) { n++; from += q.length; if (n > 20) break }
        score += Math.min(5, n)
      }
      if (titleHit) {
        score += 12
        if (!snippet) snippet = e.text.replace(/\s+/g, ' ').trim().slice(0, 120)
        if (e.title.toLowerCase() === q) score += 8
      }
      hits.push({ path: e.path, title: e.title, snippet, line, score })
    }
    hits.sort((a, b) => b.score - a.score)
    return hits.slice(0, 50)
  }

  backlinks(targetPath: string): BacklinkRef[] {
    const tk = pageKey(targetPath)
    if (!tk) return []
    const out: BacklinkRef[] = []
    for (const e of this.entries.values()) {
      if (e.path === targetPath) continue
      if (!e.links.some((l) => pageKey(l) === tk)) continue
      out.push({ path: e.path, title: e.title, snippet: backlinkSnippet(e.text, tk) })
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

  pagesByTag(tag: string): string[] {
    const k = tag.toLowerCase()
    const out: string[] = []
    for (const e of this.entries.values()) {
      if (e.tags.some((t) => t.toLowerCase() === k)) out.push(e.path)
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

function backlinkSnippet(text: string, tk: string): string {
  const re = /\[\[([^\]\n]+)\]\]/g
  let m: RegExpExecArray | null
  while ((m = re.exec(text))) {
    if (pageKey(linkTarget(m[1])) !== tk) continue
    let start = text.lastIndexOf('\n', m.index)
    start = start < 0 ? 0 : start + 1
    let end = text.indexOf('\n', m.index)
    if (end < 0) end = text.length
    return text.slice(start, end).replace(/\s+/g, ' ').trim().slice(0, 160)
  }
  return ''
}
