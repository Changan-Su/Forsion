/** Opaque source spans survive both MT and chat models. Restore only after every marker is validated. */
import { unified } from 'unified'
import remarkParse from 'remark-parse'
import remarkMath from 'remark-math'
import remarkGfm from 'remark-gfm'

type MdNode = { type: string; label?: string; identifier?: string; referenceType?: string; children?: MdNode[]; position?: { start: { offset?: number }; end: { offset?: number } } }
type Span = { start: number; end: number; restored?: string }
const parser = unified().use(remarkParse).use(remarkMath).use(remarkGfm)

export function protectTranslation(source: string): { text: string; protected: boolean; restore: (answer: string) => string | null } {
  const spans: Span[] = []
  const add = (start: number | undefined, end: number | undefined, restored?: string): void => { if (start != null && end != null && end > start) spans.push({ start, end, restored }) }
  const visit = (node: MdNode): void => {
    const start = node.position?.start.offset
    const end = node.position?.end.offset
    if (['math', 'inlineMath', 'code', 'inlineCode', 'definition', 'image', 'imageReference'].includes(node.type)) { add(start, end); return }
    if (node.type === 'link' || node.type === 'linkReference') {
      const first = node.children?.[0]?.position?.start.offset
      const last = node.children?.at(-1)?.position?.end.offset
      // Autolinks/bare URLs are entirely opaque; otherwise the visible label remains translatable.
      if (first === start || source[start ?? 0] === '<') { add(start, end); return }
      add(start, first)
      // A translated label cannot keep using itself as the reference ID: [Book][] → [书][Book].
      add(last, end, node.type === 'linkReference' && node.referenceType !== 'full' ? `][${node.label ?? node.identifier}]` : undefined)
    }
    node.children?.forEach(visit)
  }
  visit(parser.parse(source) as MdNode)
  // remark-math parses $ delimiters. Recover the other supported TeX delimiters without rewriting their source.
  for (const match of source.matchAll(/\\\(([\s\S]*?)\\\)|\\\[([\s\S]*?)\\\]/g)) {
    const start = match.index!
    let slashes = 0
    for (let i = start - 1; i >= 0 && source[i] === '\\'; i--) slashes++
    if (!(slashes % 2) && !spans.some((span) => span.start <= start && span.end > start)) add(start, start + match[0].length)
  }
  for (const match of source.matchAll(/!?\[\[[^\]\n]+\]\]/g)) {
    const start = match.index!
    if (!spans.some((span) => span.start <= start && span.end > start)) add(start, start + match[0].length)
  }
  spans.sort((a, b) => a.start - b.start || b.end - a.end)
  const unique = spans.filter((span, i) => !spans.slice(0, i).some((other) => other.start <= span.start && other.end >= span.end))
  if (!unique.length) return { text: source, protected: false, restore: (answer) => answer }
  let prefix: string
  do { prefix = `ZXQ${crypto.randomUUID().replace(/-/g, '').slice(0, 8)}_` } while (source.includes(prefix))
  const entries = unique.map((span, i) => ({ ...span, marker: `${prefix}${i}QXZ`, source: span.restored ?? source.slice(span.start, span.end) }))
  let text = ''; let cursor = 0
  for (const entry of entries) { text += source.slice(cursor, entry.start) + entry.marker; cursor = entry.end }
  text += source.slice(cursor)
  return {
    text,
    protected: true,
    restore: (answer) => {
      // Validate before inserting original content (which can itself look like a marker).
      if (entries.some((entry) => answer.split(entry.marker).length !== 2)) return null
      let remaining = answer
      for (const entry of entries) remaining = remaining.replace(entry.marker, '')
      if (remaining.includes(prefix)) return null
      const byMarker = new Map(entries.map((entry) => [entry.marker, entry.source]))
      return answer.replace(new RegExp(`${prefix}\\d+QXZ`, 'g'), (marker) => byMarker.get(marker)!)
    },
  }
}
