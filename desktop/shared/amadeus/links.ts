// Shared, isomorphic wikilink + tag parsing and page-name resolution.
// Runs in BOTH the Electron main process (the vault index) and the renderer
// (editor decorations, [[ autocomplete, the store). MUST stay free of
// Node / Electron / React — only standard JS.
//
// This is the single source of truth for: the [[…]] / #tag regexes, reducing a
// link to its target page name, normalizing a page key for matching, resolving a
// name to an existing page, and cleaning a page's markdown for the search index.

/** Matches [[Target]] / [[Target|alias]] / [[Target#heading]]; capture group = inner text. */
export const WIKILINK_RE = /\[\[([^\]\n]+)\]\]/g

/** Matches ![[Target]] transclusion embeds; capture group = inner text (e.g. "b_x.block"). */
export const EMBED_RE = /!\[\[([^\]\n]+)\]\]/g

/** Matches #tag preceded by start-or-whitespace; capture = tag text. */
export const TAG_RE = /(?:^|\s)#([\p{L}\p{N}_/-]+)/gu

/** Reduce a wikilink's inner text to its target page name: "Name|alias" / "Name#heading" → "Name". */
export function linkTarget(inner: string): string {
  let s = inner.trim()
  const bar = s.indexOf('|')
  if (bar >= 0) s = s.slice(0, bar)
  const hash = s.indexOf('#')
  if (hash >= 0) s = s.slice(0, hash)
  return s.trim()
}

/** Distinct, order-preserving wikilink targets found in markdown. */
export function parseWikiLinks(md: string): string[] {
  const re = new RegExp(WIKILINK_RE.source, WIKILINK_RE.flags)
  const out: string[] = []
  const seen = new Set<string>()
  let m: RegExpExecArray | null
  while ((m = re.exec(md))) {
    const t = linkTarget(m[1])
    if (!t) continue
    const k = t.toLowerCase()
    if (seen.has(k)) continue
    seen.add(k)
    out.push(t)
  }
  return out
}

/** Distinct, order-preserving embed targets (`![[ ]]`) found in markdown. */
export function parseEmbeds(md: string): string[] {
  const re = new RegExp(EMBED_RE.source, EMBED_RE.flags)
  const out: string[] = []
  const seen = new Set<string>()
  let m: RegExpExecArray | null
  while ((m = re.exec(md))) {
    const t = m[1].trim()
    if (!t) continue
    const k = t.toLowerCase()
    if (seen.has(k)) continue
    seen.add(k)
    out.push(t)
  }
  return out
}

/** Distinct, order-preserving #tags found in markdown (pure-numeric tokens are ignored). */
export function parseTags(md: string): string[] {
  const re = new RegExp(TAG_RE.source, TAG_RE.flags)
  const out: string[] = []
  const seen = new Set<string>()
  let m: RegExpExecArray | null
  while ((m = re.exec(md))) {
    const t = m[1]
    if (/^[0-9/]+$/.test(t)) continue // "#1", "#1/2" etc. are not tags
    const k = t.toLowerCase()
    if (seen.has(k)) continue
    seen.add(k)
    out.push(t)
  }
  return out
}

/** Normalized key for matching a page by name: basename, without .md, lowercased. */
export function pageKey(pathOrName: string): string {
  const seg = pathOrName.split(/[\\/]/).pop() ?? pathOrName
  return seg.replace(/\.md$/i, '').trim().toLowerCase()
}

/**
 * Resolve a link/name to an existing page path by basename, case-insensitively —
 * the same rule the store uses to open a [[wikilink]]. Returns null when no page matches.
 */
export function resolvePageName(name: string, pages: string[]): string | null {
  const target = pageKey(name)
  if (!target) return null
  return pages.find((p) => pageKey(p) === target) ?? null
}

/**
 * Undo remark-stringify's escaping of plain-text `[[` (it emits `\[\[` for wikilinks that were
 * typed but not yet re-parsed into nodes — the index regex above then never matches, so freshly
 * added links form no relations). Fenced code blocks are verbatim user content — a literal `\[\[`
 * there (regex/escaping examples) must NOT be touched, so a per-line fence state machine skips
 * ``` / ~~~ blocks. ponytail: inline-code `\[\[` and indented code blocks accept residual risk
 * (remark emits fenced by default; go AST-level if it ever matters).
 */
export function unescapeWikiOutsideFences(md: string): string {
  if (!md.includes('\\[\\[')) return md
  const lines = md.split('\n')
  let fence: '`' | '~' | null = null
  for (let i = 0; i < lines.length; i++) {
    const m = /^ {0,3}(`{3,}|~{3,})/.exec(lines[i])
    if (m) {
      const mark = m[1][0] as '`' | '~'
      if (!fence) fence = mark
      else if (mark === fence) fence = null
      continue
    }
    if (!fence) lines[i] = lines[i].replace(/\\\[\\\[/g, '[[')
  }
  return lines.join('\n')
}

/**
 * Strip YAML frontmatter and all HTML comments (the invisible Amadeus block/layout
 * markers) so search snippets and indexed text never surface marker noise.
 */
export function stripForIndex(md: string): string {
  return md
    .replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, '') // leading YAML frontmatter
    .replace(/<!--[\s\S]*?-->/g, '') // HTML comments (amadeus:block / amadeus:layout)
}
