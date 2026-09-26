import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { describe, expect, it } from 'vitest'

// ⚠️ 用 fs 读,别用 `?raw`:vitest 对 .css 的 ?raw 给空串,两边都空时第一条会空对空假绿。
const read = (url: URL | string): string => readFileSync(url, 'utf8')
const upstream = read(createRequire(import.meta.url).resolve('@astryxdesign/core/reset.css'))
const vendored = read(new URL('./astryxReset.css', import.meta.url))
const bridge = read(new URL('./astryxBridge.tsx', import.meta.url))

/** 把 CSS 摊平成「[媒体条件] 选择器 { 声明 }」的叶子规则表;@layer / @scope 只是外壳,拆掉。 */
function leafRules(css: string): string[] {
  const out: string[] = []
  const walk = (s: string, ctx: string): void => {
    let i = 0
    while (i < s.length) {
      const open = s.indexOf('{', i)
      if (open < 0) break
      const head = s.slice(i, open).trim().replace(/\s+/g, ' ')
      let depth = 1
      let j = open + 1
      while (depth && j < s.length) {
        if (s[j] === '{') depth++
        else if (s[j] === '}') depth--
        j++
      }
      const body = s.slice(open + 1, j - 1)
      if (head.startsWith('@layer') || head.startsWith('@scope')) walk(body, ctx)
      else if (head.startsWith('@media')) walk(body, `${ctx}${head} `)
      else out.push(`${ctx}${head} { ${body.split(';').map((d) => d.trim().replace(/\s+/g, ' ')).filter(Boolean).join('; ')} }`)
      i = j
    }
  }
  walk(css.replace(/\/\*[\s\S]*?\*\//g, ''), '')
  return out
}

const SCOPE_ROOT = ':where(:scope) {'
/** 选择器的每个分支都只能命中 <html> / <body>(作用域里永远匹配不到)才算根规则;混着别的分支的要人工拆,直接报错。 */
function rootOnly(rule: string): boolean {
  const sel = rule.slice(0, rule.indexOf('{')).trim()
  const m = /^:where\((.*)\)$/.exec(sel)
  const branches = (m ? m[1] : sel).split(/,(?![^(]*\))/).map((b) => b.trim())
  const root = branches.filter((b) => /^(html|body)(?![\w-])/.test(b))
  if (root.length && root.length !== branches.length) throw new Error(`原件出现混合选择器,需人工拆:${sel}`)
  return root.length > 0
}
/** 去掉的根规则,逐条钉死:原件改了其中任何一条(或新增一条),这里就红,逼着重新判断它该不该挪到作用域根上。
 *  line-height:body 自己设 1.6,子树从来继承不到 html 的 1.5;color-scheme:base.css 按 data-mode 设在 :root,
 *  Theme 包裹层也按 mode 自设;body 的 margin / 字体平滑:base.css 已有。 */
const DROPPED = [
  ':where(html) { line-height: 1.5; -webkit-text-size-adjust: 100%; tab-size: 4; color-scheme: light dark }',
  ':where(body) { margin: 0; line-height: inherit; -webkit-font-smoothing: antialiased; -moz-osx-font-smoothing: grayscale }',
  ':where(html) { -webkit-tap-highlight-color: transparent }',
  ':where(html[data-theme="light"]) { color-scheme: light }',
  ':where(html[data-theme="dark"]) { color-scheme: dark }',
  ':where(html:not([data-theme])) { color-scheme: light dark }',
]

describe('theme/astryxReset.css —— Astryx 重置的作用域版', () => {
  it('除根元素规则外,与 @astryxdesign/core 的原件逐条一致(升级 Astryx 时对照原件同步)', () => {
    const want = leafRules(upstream).filter((r) => !rootOnly(r))
    const got = leafRules(vendored).filter((r) => !r.startsWith(SCOPE_ROOT))
    expect(want.length).toBeGreaterThan(20)
    expect(got).toEqual(want)
  })

  it('去掉的只有这几条根规则(原件改了就红)', () => {
    expect(leafRules(upstream).filter(rootOnly)).toEqual(DROPPED)
  })

  it('混合选择器会被拦下,不会整条漏检', () => {
    expect(() => rootOnly(':where(html, button) { cursor: pointer }')).toThrow(/混合选择器/)
    expect(rootOnly(':where(html:not([data-theme])) { color-scheme: light dark }')).toBe(true)
    expect(rootOnly(':where(button, [role=\'button\']) { cursor: pointer }')).toBe(false)
  })

  it('挂到作用域根上的继承项,原件都写在 html 上', () => {
    const decls = (r: string): string[] => r.slice(r.indexOf('{') + 1, r.lastIndexOf('}')).split(';').map((d) => d.trim()).filter(Boolean)
    const htmlDecls = leafRules(upstream).filter((r) => r.startsWith(':where(html) {')).flatMap(decls)
    const scopeDecls = leafRules(vendored).filter((r) => r.startsWith(SCOPE_ROOT)).flatMap(decls)
    expect(scopeDecls.length).toBeGreaterThan(0)
    for (const d of scopeDecls) expect(htmlDecls).toContain(d)
  })

  it('整份规则都在 @layer reset 里,并收进 @scope (div[data-astryx-theme])', () => {
    const src = vendored.replace(/\/\*[\s\S]*?\*\//g, '').trim()
    expect(src.startsWith('@layer reset {')).toBe(true)
    expect(src).toContain('@scope (div[data-astryx-theme]) {')
  })

  it('接入桥不再 import 原件的全局重置', () => {
    expect(bridge).not.toMatch(/import\s+['"]@astryxdesign\/core\/reset\.css['"]/)
    expect(bridge).toMatch(/import\s+['"]\.\/astryxReset\.css['"]/)
  })
})
