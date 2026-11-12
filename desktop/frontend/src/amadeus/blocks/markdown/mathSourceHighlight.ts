/** Lightweight LaTeX source tokens. This is deliberately lexical: invalid
 * commands and unmatched brackets stay untouched and use the existing preview
 * diagnostics. Offsets always refer to the original, untrimmed source. */
export interface MathSourceHighlight {
  from: number
  to: number
  className: string
}

type TokenKind = 'command' | 'delimiter'
const CLASSES: Record<TokenKind, string> = {
  command: 'math-source-token math-source-command hljs-keyword',
  delimiter: 'math-source-token math-source-delimiter hljs-attr',
}
const DELIMITERS = new Set('$()[]{}_^')
const ESCAPED_DELIMITERS = new Set('$()[]{}')

/** Only syntax is colored; variables, digits, operators and comments keep the
 * document color. Selected characters have no syntax decoration, so the native
 * selection palette takes precedence in both light and dark themes. */
export function mathSourceHighlights(
  source: string,
  start = 0,
  selected?: { from: number; to: number },
): MathSourceHighlight[] {
  const ranges: MathSourceHighlight[] = []
  // The outer Markdown closer is not part of a TeX comment in the body.
  const closer = source.endsWith('$$') ? source.length - 2 : source.endsWith('$') ? source.length - 1 : source.length
  const add = (from: number, to: number, kind: TokenKind): void => {
    const a = start + from, b = start + to
    const className = CLASSES[kind]
    if (!selected || selected.from === selected.to || selected.to <= a || selected.from >= b) {
      ranges.push({ from: a, to: b, className })
      return
    }
    if (selected.from > a) ranges.push({ from: a, to: selected.from, className })
    if (selected.to < b) ranges.push({ from: selected.to, to: b, className })
  }

  for (let i = 0; i < source.length;) {
    const char = source[i]
    if (char === '\\') {
      let end = i + 1
      if (/[A-Za-z]/.test(source[end] ?? '')) {
        do { end++ } while (/[A-Za-z]/.test(source[end] ?? ''))
      } else if (end < source.length && source[end] !== '\n') {
        end++ // A TeX control symbol, including escaped brackets and line breaks.
      }
      add(i, end, ESCAPED_DELIMITERS.has(source[i + 1]) ? 'delimiter' : 'command')
      i = end
    } else if (char === '%') {
      const end = source.indexOf('\n', i)
      i = end < 0 ? closer : Math.min(end + 1, closer)
    } else if (DELIMITERS.has(char)) {
      let end = i + 1
      while (DELIMITERS.has(source[end])) end++
      add(i, end, 'delimiter')
      i = end
    } else {
      i++
    }
  }
  return ranges
}
