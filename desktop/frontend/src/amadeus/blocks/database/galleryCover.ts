/**
 * Gallery card preview from the row body: when a card has no image in its file column,
 * the first image embedded in the row's page content becomes the card cover
 * (similar to "card preview = page content" in other database tools).
 *
 * Two image forms are recognised, in document order:
 * - `![[path/to/photo.jpg]]` / `![[photo.jpg|200]]` (wiki embed; only image extensions count)
 * - `![alt](https://…)` / `![alt](relative/path.png)` (Markdown image; any target, it is an image by syntax)
 * Images inside fenced code blocks or inline code are ignored.
 */

const IMG_EXT_RE = /\.(png|jpe?g|gif|webp|svg|avif|bmp)$/i

export type BodyImage =
  | { kind: 'wiki'; target: string }
  | { kind: 'md'; src: string }

/** Drop fenced code blocks (an unclosed fence runs to the end) and inline code spans; only the order of what is left matters. */
function stripCode(body: string): string {
  const out: string[] = []
  let fence: string | null = null
  for (const line of body.split('\n')) {
    const m = /^ {0,3}(`{3,}|~{3,})/.exec(line)
    if (fence) {
      if (m && m[1][0] === fence[0] && m[1].length >= fence.length) fence = null
      continue
    }
    if (m) { fence = m[1]; continue }
    out.push(line.replace(/`[^`]*`/g, ''))
  }
  return out.join('\n')
}

// Every repeat is bounded so a hostile body (thousands of unclosed `![`) stays linear-ish instead of rescanning to the end at each start.
const IMAGE_RE = /!\[\[([^\]\n]{1,500})\]\]|!\[[^\]\n]{0,300}\]\([ \t]{0,20}<?([^)\s>]{1,2000})>?(?:[ \t]{1,20}"[^"\n]{0,300}")?[ \t]{0,20}\)/g
/** Only the start of the body is searched: a cover image sits near the top, and this caps the work per card. */
const SCAN_MAX = 20_000

/** First image in a row body, or null. */
export function firstBodyImage(body: string | undefined | null): BodyImage | null {
  if (!body || !body.includes('![')) return null
  for (const m of stripCode(body.slice(0, SCAN_MAX)).matchAll(IMAGE_RE)) {
    if (m[1] != null) {
      const target = m[1].split('|')[0].split('#')[0].trim()
      if (target && IMG_EXT_RE.test(target)) return { kind: 'wiki', target }
      continue
    }
    const src = (m[2] ?? '').trim()
    if (!src || /^(?:data|javascript|vbscript):/i.test(src)) continue
    return { kind: 'md', src }
  }
  return null
}
