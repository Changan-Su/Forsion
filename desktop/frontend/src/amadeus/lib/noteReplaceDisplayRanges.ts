import { decodeString } from 'micromark-util-decode-string'
import type { ReplaceMatch } from './noteReplaceMatches'

/** A text leaf's source range may contain quote/list prefixes on continuation lines and
 * longer spellings for escaped characters. Preserve the parser's text verbatim; only annotate
 * positions that map back to exactly the word the engine selected. */
export function displayRanges(raw: string, rendered: string, hits: ReplaceMatch[], base: number) {
  if (raw === rendered) return hits.map(hit => ({ hit, left: hit.from - base, right: hit.to - base }))
  const sourceLines = raw.split('\n'), displayLines = rendered.split('\n')
  const result: { hit: ReplaceMatch; left: number; right: number }[] = []
  if (sourceLines.length !== displayLines.length) return result
  let rawStart = base, textStart = 0, index = 0
  for (let i = 0; i < sourceLines.length; i++) {
    const line = sourceLines[i].replace(/\r$/, ''), text = displayLines[i].replace(/\r$/, '')
    const cooked = decodeString(line)
    // CommonMark removes list/quote continuation markers before constructing text leaves.
    const prefix = cooked.endsWith(text) ? cooked.length - text.length : cooked.indexOf(text)
    let previousEnd = 0, cookedEnd = 0
    while (index < hits.length && hits[index].from < rawStart + sourceLines[i].length) {
      const hit = hits[index++]
      const from = hit.from - rawStart, to = hit.to - rawStart
      const word = line.slice(from, to)
      const offset = cookedEnd + decodeString(line.slice(previousEnd, from)).length
      const left = offset - prefix
      if (prefix >= 0 && left >= 0 && text.slice(left, left + word.length) === word)
        result.push({ hit, left: textStart + left, right: textStart + left + word.length })
      previousEnd = to
      cookedEnd = offset + word.length
    }
    rawStart += sourceLines[i].length + 1
    textStart += displayLines[i].length + 1
  }
  return result
}
