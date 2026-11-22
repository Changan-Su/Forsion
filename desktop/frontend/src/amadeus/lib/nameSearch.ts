import { fuzzyScore } from './fuzzy'

export type PinyinReadings = (text: string) => string[][]
const han = /\p{Script=Han}/u
const separators = /[\s\-_/\\.]+/gu
// Cache individual Han characters. Typing, renaming and switching vaults never retain a title or path.
const syllables = new Map<string, string[]>()
function readings(char: string, lookup: PinyinReadings): string[] {
  const known = syllables.get(char)
  if (known) return known
  const options = [char, ...(lookup(char)[0] ?? [])]
  syllables.set(char, options)
  return options
}

/** Earliest end of a match, starting on any character boundary. Carry query offsets across
 * characters, so polyphonic words never require generating every pronunciation of a title. */
function matchPart(chars: string, start: number, term: string, lookup: PinyinReadings): { from: number; end: number } | null {
  let active = new Map<number, number>()
  for (let i = start; i < chars.length; i++) {
    active.set(0, i)
    const next = new Map<number, number>()
    const char = chars[i]
    const options = han.test(char) ? readings(char, lookup) : [char]
    for (const [offset, from] of active) {
      for (const syllable of options) {
        if (syllable[0] !== term[offset]) continue
        const rest = term.length - offset
        if (rest <= syllable.length && syllable.startsWith(term.slice(offset))) return { from, end: i + 1 }
        // A character can contribute just its initial, or its entire syllable.
        if (!next.has(offset + 1)) next.set(offset + 1, from)
        if (syllable.length > 1 && term.startsWith(syllable, offset) && !next.has(offset + syllable.length)) {
          next.set(offset + syllable.length, from)
        }
      }
    }
    active = next
  }
  return null
}

function pinyinScore(parts: string[], text: string, lookup: PinyinReadings): number | null {
  if (!han.test(text)) return null
  const chars = text.toLowerCase().replace(separators, '')
  let end = 0, skipped = 0
  for (const term of parts) {
    const hit = matchPart(chars, end, term, lookup)
    if (!hit) return null
    skipped += hit.from - end
    end = hit.end
  }
  return -skipped - chars.length / 1000
}

/** Shared by Quick Find and the wiki picker. Literal title, literal path, phonetic title, then
 * phonetic path. Sorting retains the caller's order on ties, including an empty query. */
export function rankNames<T>(items: T[], query: string, nameOf: (it: T) => string, pathOf: (it: T) => string | undefined,
  lookup?: PinyinReadings, aliasesOf?: (it: T) => readonly string[] | undefined): T[] {
  const raw = query.trim().toLowerCase()
  const parts = raw.replace(/ü/g, 'v').split(separators).filter(Boolean)
  const phonetic = lookup && /[a-z]/i.test(parts.join('')) ? lookup : null
  const scored: Array<{ item: T; rank: number; score: number }> = []
  for (const item of items) {
    const title = nameOf(item)
    const path = pathOf(item)
    const aliases = aliasesOf?.(item) ?? []
    let rank = 4, score = fuzzyScore(query, title)
    for (const alias of aliases) {
      const hit = fuzzyScore(query, alias)
      if (hit !== null && (score === null || hit > score)) score = hit
    }
    if (raw && raw === title.toLowerCase()) rank = 6
    else if (raw && aliases.some((alias) => alias.toLowerCase() === raw)) rank = 5
    if (score === null && path) { rank = 3; score = fuzzyScore(query, path) }
    if (score === null && phonetic) {
      rank = 2
      score = pinyinScore(parts, title, phonetic)
      for (const alias of aliases) {
        const hit = pinyinScore(parts, alias, phonetic)
        if (hit !== null && (score === null || hit > score)) score = hit
      }
    }
    if (score === null && phonetic && path) { rank = 1; score = pinyinScore(parts, path, phonetic) }
    if (score !== null) scored.push({ item, rank, score })
  }
  scored.sort((a, b) => b.rank - a.rank || b.score - a.score)
  return scored.map((entry) => entry.item)
}
