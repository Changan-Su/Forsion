/** Lightweight LaTeX source tokens. This is deliberately lexical: invalid
 * commands and unmatched brackets stay untouched and use the existing preview
 * diagnostics. Offsets always refer to the original, untrimmed source.
 *
 * Token kinds match what Obsidian's editor shows for math source: `\command`
 * and escaped symbols, `_ ^ &`, letters, numbers, brackets and the `$`
 * delimiters each get a class; spaces, operators and comments keep the
 * document color. Colors live in CSS variables (see `.math-source-*` in
 * amadeus/styles.css), never here. */
export interface MathSourceHighlight {
  from: number
  to: number
  className: string
}

type TokenKind = 'dollar' | 'command' | 'script' | 'letter' | 'number' | 'bracket'
// `math-source-delimiter` is the older umbrella class for punctuation; kept so existing selectors keep matching.
const CLASSES: Record<TokenKind, string> = {
  dollar: 'math-source-token math-source-delimiter math-source-dollar',
  command: 'math-source-token math-source-command',
  script: 'math-source-token math-source-delimiter math-source-script',
  letter: 'math-source-token math-source-letter',
  number: 'math-source-token math-source-number',
  bracket: 'math-source-token math-source-delimiter math-source-bracket',
}
const SCRIPTS = new Set('_^&')
const BRACKETS = new Set('()[]{}')
const LETTER = /[A-Za-z]/
const NUMBER = /\d+\.\d*|\d*\.\d+|\d+/y

/** Selected characters have no syntax decoration, so the native selection
 * palette takes precedence in both light and dark themes. */
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
  const run = (i: number, inSet: (c: string) => boolean): number => {
    let end = i + 1
    while (end < source.length && inSet(source[end])) end++
    return end
  }

  for (let i = 0; i < source.length;) {
    const char = source[i]
    if (char === '\\') {
      let end = i + 1
      if (LETTER.test(source[end] ?? '')) {
        do { end++ } while (LETTER.test(source[end] ?? ''))
      } else if (end < source.length && source[end] !== '\n') {
        end++ // A TeX control symbol, including escaped brackets and line breaks.
      }
      add(i, end, 'command')
      i = end
    } else if (char === '%') {
      const end = source.indexOf('\n', i)
      i = end < 0 ? closer : Math.min(end + 1, closer)
    } else if (char === '$') {
      const end = run(i, (c) => c === '$')
      add(i, end, 'dollar')
      i = end
    } else if (SCRIPTS.has(char)) {
      const end = run(i, (c) => SCRIPTS.has(c))
      add(i, end, 'script')
      i = end
    } else if (BRACKETS.has(char)) {
      const end = run(i, (c) => BRACKETS.has(c))
      add(i, end, 'bracket')
      i = end
    } else if (LETTER.test(char)) {
      const end = run(i, (c) => LETTER.test(c))
      add(i, end, 'letter')
      i = end
    } else {
      NUMBER.lastIndex = i
      const m = NUMBER.exec(source)
      if (m) {
        add(i, i + m[0].length, 'number')
        i += m[0].length
      } else {
        i++
      }
    }
  }
  return ranges
}
