// CSS 注释被正文里的 `*/` 提前闭合(2026-10-10)。
//
// 注释里写 `--text*/--accent`、`themes/*/theme.css` 这种字样,注释就在那个 `*/` 处结束了;剩下的半截正文不是注释,
// 浏览器把它和**紧跟着的那条规则的选择器**读成一条选择器 —— 选择器非法,整条规则被丢掉。不报错、不崩,
// 构建只给一行 `[css-syntax-error]` 警告。实翻两处,都是从写下那天起就没生效过:
//   views/inbox/inbox.css 的 `.ibx-iconbtn`(07-03 起)、amadeus/styles.css 的 `.amx-btnblock`(07-31 起)。
//
// 判法:按 CSS 的规则切开注释与字符串,注释之外再出现的 `*/` 就是原注释真正的结尾(落了单)。
// ⚠️ 天花板:半截正文里要是恰好又有一个 `/*`,它会把落单的那个 `*/` 配走,这里看不见(那种只能靠构建警告)。
import { describe, expect, it } from 'vitest'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'

const GENESIS = join(__dirname, '../../..')
const ROOTS = ['desktop/frontend/src', 'lcl', 'mobile/src', 'web/src']

/** 落单的 `*\/` 所在的行号(从 1 起);没有就是空数组。 */
export function strayCommentEnds(css: string): number[] {
  const lines: number[] = []
  let i = 0
  while (i < css.length) {
    const c = css[i], d = css[i + 1]
    if (c === '/' && d === '*') { const end = css.indexOf('*/', i + 2); if (end < 0) break; i = end + 2; continue }
    if (c === '"' || c === "'") {
      let j = i + 1
      while (j < css.length && css[j] !== c && css[j] !== '\n') j += css[j] === '\\' ? 2 : 1
      i = j + 1; continue
    }
    if (c === '*' && d === '/') { lines.push(css.slice(0, i).split('\n').length); i += 2; continue }
    i++
  }
  return lines
}

function cssFiles(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === 'dist' || name === 'out' || name.startsWith('.')) continue
    const p = join(dir, name)
    if (statSync(p).isDirectory()) cssFiles(p, out)
    else if (name.endsWith('.css')) out.push(p)
  }
  return out
}

describe('CSS 注释不许被正文里的 */ 提前闭合', () => {
  it('判法本身:坏样例抓得到,好样例、字符串里的 */ 不误报', () => {
    expect(strayCommentEnds('/* 全 token 驱动(--bg/--text*/--accent) */\n.a { color: red; }')).toEqual([1])
    expect(strayCommentEnds('/* 头\n * themes/*/theme.css 里成对定义\n */\n.a {}')).toEqual([3])
    expect(strayCommentEnds('/* --bg / --text-* / --accent */\n.a { color: red; }')).toEqual([])
    expect(strayCommentEnds('.a::after { content: "*/"; } /* 正常 */')).toEqual([])
  })

  it('源码里没有(改法:`*` 和 `/` 之间留空格,或把通配写成 <名字>)', () => {
    const hits: string[] = []
    let scanned = 0
    for (const root of ROOTS) {
      const dir = join(GENESIS, root)
      if (!existsSync(dir)) continue
      for (const file of cssFiles(dir)) {
        scanned++
        for (const line of strayCommentEnds(readFileSync(file, 'utf8'))) hits.push(`${relative(GENESIS, file)}:${line}`)
      }
    }
    expect(scanned).toBeGreaterThan(50) // 一个文件都没扫到 = 路径算错了,不是真干净
    expect(hits).toEqual([])
  })
})
