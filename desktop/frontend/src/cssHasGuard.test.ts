// `:has()` 后面接一个「没有类名可认」的结尾(2026-10-11)。
//
// 形如 `.list:has(> .item) > :first-child`、`.owner:has(> .cover) > :not(.cover)` 的选择器:`:has` 不在最后一段,
// 而最后一段只有伪类 / 通配(`:first-child`、`:not(…)`、`*`),浏览器没有类名、标签、属性可以拿来缩小范围 ——
// 于是页面上**任何地方**插入或移除一个元素,浏览器都要把带 `:has` 的元素的**整棵子树**重算一遍样式。
// 挂在聊天流、整个 View 这种大容器上就等于整页。不报错、不崩,只是处处慢:
// 实测一段 60 条消息的对话(约 4800 个元素)里每插入一个元素 50ms,降速 4 倍(≈ 中端手机)约 200ms;
// 流式输出每多一个节点、弹一次菜单、挂一个按钮都要付一次。三条这样的规则各自都足以触发(聊天流两条、临时 View 一条)。
//
// 改法:把「有没有那个子元素」记成父元素上的一个属性 / 类(由渲染它的代码写),或者让结尾点名具体的类。
// **锚点小也不行**(10-16 桌面实测推翻了 10-11 的「三两个后代不必改」):Blink 把所有「`:has` 不在最后一段」的规则的结尾
// 合成一份失效清单,一条结尾是通配,页面上**每个**被这类 `:has` 牵动的元素(包括别的规则挂在大容器上的)都按「整棵子树」失效。
// 锚点在页面上根本不存在的 `.nope:has(.x) > *` 照样让 60 条消息的对话每插入 + 移除一次多花 18ms(同一条结尾点名类就是 0.6ms)。
// `:is()` / `:where()` 里面是完整的选择器,同样算:StyleX 的 `when.ancestor(':has(…)')` 生成 `.x.x:where(.m:has(…) *)`,结尾是里面那个 `*`。
// 依赖库的 CSS 也扫(DEPS):astryx 那 6 条由 frontend/astryxHasPlugin.ts 在构建时改写(10-16),这里钉住改写后一条不剩。
// 仪器:desktop 的 `node scripts/insert-restyle.probe.cjs`(真 Electron,逐条找出让插入变贵的规则,含依赖库生成的 CSS);
// mobile 的 `npm run emu:perf`(`MODE=exp` 可以量「插入一个元素要多久」)。
import { describe, expect, it } from 'vitest'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join, relative } from 'node:path'
import { rewriteAstryxHas } from '../astryxHasPlugin'

const GENESIS = join(__dirname, '../../..')
const ROOTS = ['desktop/frontend/src', 'lcl', 'mobile/src', 'web/src']
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
/** `:is(` / `:where(` 的参数(到配对的右括号为止)。 */
const logicalArgs = (s: string): string[] => [...s.matchAll(/:(?:is|where)\(/g)].map((m) => {
  let depth = 1, j = (m.index ?? 0) + m[0].length
  const from = j
  for (; j < s.length && depth; j++) { if (s[j] === '(') depth++; else if (s[j] === ')') depth-- }
  return s.slice(from, j - 1)
})
const outsideParens = (s: string): string => { let out = '', depth = 0; for (const c of s) { if (c === '(') depth++; else if (c === ')') depth--; else if (depth === 0) out += c } return out }

/** 一条选择器(不含逗号):`:has(` 出现在最后一段之前,且最后一段没有类 / id / 属性 / 标签可认。 */
export function broadAfterHas(selector: string): boolean {
  const sel = selector.replace(/::[\w-]+(\([^)]*\))?/g, '').trim()
  if (logicalArgs(sel).some((arg) => arg.includes(':has(') && splitTop(arg, (c) => c === ',').some(broadAfterHas))) return true
  const compounds = splitTop(sel.replace(/\s*([>+~])\s*/g, ' $1 '), (c) => c === ' ').map((x) => x.trim()).filter((x) => x && !/^[>+~]$/.test(x))
  if (compounds.length < 2 || !compounds.slice(0, -1).some((c) => c.includes(':has('))) return false
  // :is(.a, .b) / :where(.a) 认它的参数;:not(…) 什么也认不了
  const keyed = outsideParens(compounds[compounds.length - 1].replace(/:(?:is|where)\(([^()]*)\)/g, ' $1 '))
  return !/(^|[\s,])[a-zA-Z.#[]/.test(keyed)
}

/** 文件里所有这种选择器:`行号  选择器`。 */
export function broadHasSelectors(css: string): Array<{ line: number; selector: string }> {
  const bare = css.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
  const hits: Array<{ line: number; selector: string }> = []
  for (const m of bare.matchAll(/([^{}]+)\{/g)) {
    const head = m[1].trim()
    if (!head.includes(':has(') || head.startsWith('@')) continue
    for (const sel of splitTop(head, (c) => c === ',')) if (broadAfterHas(sel)) hits.push({ line: bare.slice(0, (m.index ?? 0) + m[1].length - m[1].trimStart().length).split('\n').length, selector: sel.trim().replace(/\s+/g, ' ') })
  }
  return hits
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

describe(':has() 后面不许接没有类名可认的结尾', () => {
  it('判法本身:三条实翻的写法抓得到,改过的写法与无关的 :has 不误报', () => {
    expect(broadAfterHas('.t2-stream-inner:has(> .t2-asst, > .t2-userwrap) > :first-child')).toBe(true)
    expect(broadAfterHas('.wb-extend-owner:has(> .wb-extend-inline) > :not(.wb-extend-inline)')).toBe(true)
    expect(broadAfterHas('.a:has(.b) *')).toBe(true)
    expect(broadAfterHas('.xkri23q.xkri23q:where(.x1tspnpo:has(:focus-visible) *):not(#\\#)')).toBe(true) // StyleX when.ancestor
    expect(broadAfterHas(':is(.t2s-side, .t2sw-plug) .t2s-srow:hover .t2s-lead > :has(~ .t2s-lead-chev)')).toBe(false)
    expect(broadAfterHas('.x.x:where(.m:has(.y) .x)')).toBe(false)
    expect(broadAfterHas('.t2-stream-inner[data-has-messages] > :first-child')).toBe(false) // 没有 :has
    expect(broadAfterHas('.wb-extend-owner:has(> .wb-view--right) > .wb-extend-inline')).toBe(false) // 结尾有类名
    expect(broadAfterHas('.lead:has(.chev) > :is(.icon, .emoji)')).toBe(false) // :is(…) 认它的参数
    expect(broadAfterHas('.mb-cap:has(> .mb-icon-btn--ghost:only-child)')).toBe(false) // :has 在最后一段:只动它自己
    expect(broadAfterHas('.shell:has(.home)::before')).toBe(false)
    expect(broadHasSelectors('/* .a:has(.b) > * */\n.x, .a:has(.b) > :last-child { color: red }')).toEqual([{ line: 2, selector: '.a:has(.b) > :last-child' }])
  })

  it('源码里没有', () => {
    const hits: string[] = []
    let scanned = 0
    for (const root of ROOTS) {
      const dir = join(GENESIS, root)
      if (!existsSync(dir)) continue
      for (const file of cssFiles(dir)) {
        scanned++
        for (const h of broadHasSelectors(readFileSync(file, 'utf8'))) hits.push(`${relative(GENESIS, file)}:${h.line}  ${h.selector}`)
      }
    }
    expect(scanned).toBeGreaterThan(50) // 一个文件都没扫到 = 路径算错了,不是真干净
    expect(hits).toEqual([])
  })

  it('依赖库:astryx 原件里那 6 条抓得到,构建时改写之后一条不剩', () => {
    const css = readFileSync(createRequire(import.meta.url).resolve('@astryxdesign/core/astryx.css'), 'utf8')
    expect(broadHasSelectors(css)).toHaveLength(6) // 升级 astryx 后数变了:先看新来的是什么形状,别直接改数
    expect(broadHasSelectors(rewriteAstryxHas(css))).toEqual([])
  })
})
