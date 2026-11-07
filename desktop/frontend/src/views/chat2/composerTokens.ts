/**
 * 输入框里认得出的斜杠命令 / @ 提及(2026-11-04 用户选方案 B,对照页 docs/ToBeImproved/强调色补全方案_2026-11-04):
 * 整枚画强调色浅底 + 强调色字(InlineRefMirror 那层画),退格整枚删。
 * 只认:命令表或技能里有的 `/名字`、从 @ 菜单选过的 `@名字`;前面是行首或空白,后面是空白或结尾。
 * 手打一个不存在的 `/foo` 仍是普通文字;改掉其中一个字就不再认,颜色随之消失。和行内引用段重叠的不算。
 */
export interface TokenMark { start: number; end: number }

const edgeBefore = (text: string, i: number): boolean => i === 0 || /\s/.test(text[i - 1])
const edgeAfter = (text: string, i: number): boolean => i >= text.length || /\s/.test(text[i])

export function findTokens(text: string, commands: ReadonlySet<string>, mentions: readonly string[], skip: readonly TokenMark[] = []): TokenMark[] {
  const out: TokenMark[] = []
  const free = (s: number, e: number): boolean => !skip.some((r) => s < r.end && r.start < e) && !out.some((r) => s < r.end && r.start < e)
  if (commands.size && text.includes('/')) {
    const re = /\/[^\s/]+/g
    let m: RegExpExecArray | null
    while ((m = re.exec(text))) {
      const s = m.index, e = s + m[0].length
      if (commands.has(m[0]) && edgeBefore(text, s) && edgeAfter(text, e) && free(s, e)) out.push({ start: s, end: e })
    }
  }
  // 名字可能带空格(「Orbit One」):长的先认,免得被同前缀的短名字截走
  for (const name of [...new Set(mentions)].filter(Boolean).sort((a, b) => b.length - a.length)) {
    const needle = `@${name}`
    for (let s = text.indexOf(needle); s >= 0; s = text.indexOf(needle, s + 1)) {
      const e = s + needle.length
      if (edgeBefore(text, s) && edgeAfter(text, e) && free(s, e)) out.push({ start: s, end: e })
    }
  }
  return out.sort((a, b) => a.start - b.start)
}

/** 退格(光标紧挨命令末尾或它后面那个空格)/ Delete(光标在命令开头)→ 要整枚删掉的区间,连同后面那个空格;
 *  光标在命令中间不算 —— 那是在改字。 */
export function tokenTouching(marks: readonly TokenMark[], text: string, pos: number, dir: 'back' | 'fwd'): TokenMark | undefined {
  for (const m of marks) {
    const end = text[m.end] === ' ' ? m.end + 1 : m.end
    if (dir === 'back' ? pos === m.end || pos === end : pos === m.start) return { start: m.start, end }
  }
  return undefined
}

/** 已发出的消息开头那个命令(`/名字` 后跟空白或结尾;`/Users/…` 这种路径不算)。气泡里给它同一枚样式。 */
export function leadingCommand(text: string): { cmd: string; rest: string } | null {
  const m = /^\/[^\s/]+(?=\s|$)/.exec(text)
  return m ? { cmd: m[0], rest: text.slice(m[0].length) } : null
}
