// Shared by the editor decorations and the read-only replacement review.
export interface MathSpan { from: number; to: number; latex: string; display: boolean }

/** 扫描「一块的文本」中的公式跨度(块级 `$$…$$` 优先,再行内 `$…$`)。
 *  入参 s 已由调用方把 code 文本/内联原子替成占位符、硬换行替成 '\n'(见 buildBlockString)。
 *  行内规则(仿 remark-math 核心):开 `$` 后不接空白、闭 `$` 前不接空白、内容非空、不跨行 —— 挡掉「$5 和 $10」这类货币误伤。
 *  ponytail: 不处理 `\$` 转义、不识别同段内 code 里的 `$`(调用方已抹掉 code 文本);够用,漏网是极边角。 */
export function scanMath(s: string): MathSpan[] {
  const spans: MathSpan[] = []
  const n = s.length
  const isSpace = (c: string | undefined): boolean => c === ' ' || c === '\t' || c === '\n' || c === undefined
  let i = 0
  while (i < n) {
    if (s[i] === '$') {
      if (s[i + 1] === '$') {
        // 块级 $$…$$(可跨行);$$$ 三连(Yelp 价位/货币)不当块公式起手。
        if (s[i + 2] !== '$') {
          const close = s.indexOf('$$', i + 2)
          if (close > i + 1) {
            const latex = s.slice(i + 2, close).trim()
            if (latex) { spans.push({ from: i, to: close + 2, latex, display: true }); i = close + 2; continue }
          }
        }
        i += 2; continue // 未闭合 / $$$ → 整体跳过,避免退化成行内误配
      }
      // 行内 $…$:开 `$` 后不接空白;闭 `$` 前不接空白、且其后不接字母数字
      // (否则「$5-$10」价位区间、「$HOME/$USER」环境变量会被吞成公式,污染正文)。
      if (!isSpace(s[i + 1])) {
        let j = i + 1
        let found = -1
        while (j < n) {
          const c = s[j]
          if (c === '\n') break              // 行内公式不跨行
          if (c === '$') { if (!isSpace(s[j - 1]) && !/[A-Za-z0-9]/.test(s[j + 1] ?? '')) found = j; break }
          j++
        }
        if (found > i + 1) {
          spans.push({ from: i, to: found + 1, latex: s.slice(i + 1, found), display: false })
          i = found + 1; continue
        }
      }
    }
    i++
  }
  return spans
}

export interface ObsSpan { kind: 'hl' | 'cmt'; from: number; to: number }

/** 块串里的 `%%…%%` 与 `==…==` 跨度(偏移 = 块串下标,含定界符)。入参同 buildBlockString:代码已抹成空格、硬换行为 `\n`。 */
export function scanObsidian(s: string): ObsSpan[] {
  if (s.indexOf('%%') === -1 && s.indexOf('==') === -1) return []
  // 公式里的不算:抹成等长空格,偏移不动。
  let t = s
  for (const m of scanMath(s)) t = t.slice(0, m.from) + ' '.repeat(m.to - m.from) + t.slice(m.to)
  const out: ObsSpan[] = []
  // `%%…%%`:从左往右配对,内容非空;没配上的 `%%` 是字面。
  for (let i = t.indexOf('%%'); i !== -1;) {
    const close = t.indexOf('%%', i + 2)
    if (close === -1) break
    if (close > i + 2) {
      out.push({ kind: 'cmt', from: i, to: close + 2 })
      i = t.indexOf('%%', close + 2)
    } else {
      i = t.indexOf('%%', i + 1) // `%%%%`:空注释不算,挪一格再找
    }
  }
  // `==x==`:定界符内侧不贴空白、外侧不贴 `=`(`a === b`、`x == y` 不误伤),不跨行,不落在注释里。
  const HL = /(?<!=)==(?![\s=])([^\n]*?)(?<![\s=])==(?!=)/g
  for (let m = HL.exec(t); m; m = HL.exec(t)) {
    const from = m.index
    const to = from + m[0].length
    if (to - from <= 4) continue
    if (out.some((c) => c.kind === 'cmt' && from < c.to && to > c.from)) continue
    out.push({ kind: 'hl', from, to })
  }
  return out.sort((a, b) => a.from - b.from)
}
