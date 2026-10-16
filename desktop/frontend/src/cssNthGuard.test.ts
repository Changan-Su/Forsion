// `:nth-*()` / `*-of-type` 不在最后一段、最后一段又只有标签或通配(2026-10-16)。
//
// 形如 `.reset-ceremony-quota:nth-child(2) .reset-ceremony-track span` 的选择器:Blink 把所有这类规则右边的特征并成**一份**
// 公共失效集合,页面上任何地方的兄弟结构一变(加 / 删一个组、插一条消息),所有兄弟节点底下凡是带这些特征的元素都要重算。
// 特征是类时只牵动那几个元素;是 `span` / `strong` 这种标签时,3000 块的长笔记里一次就是 1.5 万个元素(开合一次左栏 70–220ms,
// 10-16 用 invalidationTracking 看到集合是 {span, strong, .d2h-file-header, .dv-pane-header},来源就是重置额度动画那两条)。
// `:first-child` / `:last-child` / `:only-child` 不走这份集合(同一次跟踪里 `tr:last-child td` 的 td 不在里面),不管。
// 改法:最后一段点名一个类,或者把「第几个」的差别用变量传下去(resetCardCeremony.css 的 --reset-stagger)。
// 姊妹规矩见 cssHasGuard.test.ts(:has 那一类)与 DESIGN §7 第 10 条;真 Electron 的仪器是 desktop 的 `npm run check:restylescope`。
import { describe, expect, it } from 'vitest'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'

const GENESIS = join(__dirname, '../../..')
const ROOTS = ['desktop/frontend/src', 'lcl', 'mobile/src', 'web/src']
const STRUCTURAL = /:(?:nth-(?:last-)?(?:child|of-type)|(?:first|last|only)-of-type)\(?/
const splitTop = (s: string, isSep: (c: string) => boolean): string[] => {
  const out: string[] = []
  let depth = 0, cur = ''
  for (const c of s) {
    if (c === '(' || c === '[') depth++
    if (c === ')' || c === ']') depth--
    if (depth === 0 && isSep(c)) { out.push(cur); cur = ''; continue }
    cur += c
  }
  out.push(cur)
  return out
}
const outsideParens = (s: string): string => { let out = '', depth = 0; for (const c of s) { if (c === '(') depth++; else if (c === ')') depth--; else if (depth === 0) out += c } return out }

/** 一条选择器(不含逗号):结构伪类出现在最后一段之前,且最后一段没有类 / id / 属性(标签不算数)。 */
export function broadAfterNth(selector: string): boolean {
  const sel = selector.replace(/::[\w-]+(\([^)]*\))?/g, '').trim()
  const compounds = splitTop(sel.replace(/\s*([>+~])\s*/g, ' $1 '), (c) => c === ' ').map((x) => x.trim()).filter((x) => x && !/^[>+~]$/.test(x))
  if (compounds.length < 2 || !compounds.slice(0, -1).some((c) => STRUCTURAL.test(c))) return false
  // :is(.a, .b) / :where(.a) 认它的参数
  return !/[.#[]/.test(outsideParens(compounds[compounds.length - 1].replace(/:(?:is|where)\(([^()]*)\)/g, ' $1 ')))
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

describe(':nth-*() 后面不许接只有标签的结尾', () => {
  it('判法认得出 10-16 那两条,也放过改好的写法和 :first-child 一族', () => {
    expect(broadAfterNth('.q:nth-child(2) .track span')).toBe(true)
    expect(broadAfterNth('.q:nth-of-type(2) > *')).toBe(true)
    expect(broadAfterNth('.q:nth-child(2) .track .bar')).toBe(false)
    expect(broadAfterNth('.q:nth-child(2)')).toBe(false)
    expect(broadAfterNth('.q:nth-child(2) :is(.a, .b)')).toBe(false)
    expect(broadAfterNth('tr:last-child td')).toBe(false)
  })
  it('自家 CSS 一条都没有', () => {
    const hits: string[] = []
    for (const root of ROOTS) for (const file of cssFiles(join(GENESIS, root))) {
      const css = readFileSync(file, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '')
      for (const m of css.matchAll(/([^{}]+)\{/g)) {
        const head = m[1].trim()
        if (head.startsWith('@') || !STRUCTURAL.test(head)) continue
        for (const sel of splitTop(head, (c) => c === ',')) if (broadAfterNth(sel)) hits.push(`${relative(GENESIS, file)}: ${sel.trim()}`)
      }
    }
    expect(hits).toEqual([])
  })
})
