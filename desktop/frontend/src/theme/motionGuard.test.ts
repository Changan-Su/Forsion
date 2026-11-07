/**
 * 动效收口(motionGuard.ts):磁盘主题的 CSS 进注册表前删掉动效 token、给主题自己的关键帧与层名加前缀、删 @import。
 * 用例含 Codex 评审给的绕过 / 误伤写法(大写与转义的 at 规则、转义的变量名、嵌套规则后的声明、字符串里像声明的字、
 * 注释夹在两个 token 中间、大小写不同的关键帧、简写里和关键字同名的关键帧)。
 * 真 Electron 里的层序 / 减少动态效果 / 主题注入另由台架 check:motiontheme 钉(带负对照)。
 */
import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { guardThemeCss, isMotionToken } from './motionGuard'

const here = fileURLToPath(new URL('.', import.meta.url))
const roots = [join(here, '..'), join(here, '../../../../lcl'), join(here, '../../../../mobile/src')]
const cssFiles = roots.flatMap((r) => {
  try { return (readdirSync(r, { recursive: true }) as string[]).filter((f) => f.endsWith('.css') && !f.includes('node_modules')).map((f) => join(r, f)) } catch { return [] }
})

describe('动效 token 名单不漂移', () => {
  it('宿主全部样式表里,值是时长 / 缓动 / 引用动效 token 的自定义属性都在名单里', () => {
    expect(cssFiles.length).toBeGreaterThan(50)
    const missing = new Set<string>()
    const seen = new Set<string>()
    for (const f of cssFiles) {
      const src = readFileSync(f, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '')
      for (const m of src.matchAll(/(--[a-zA-Z0-9_-]+)\s*:\s*([^;{}]+)/g)) {
        const [, name, value] = m
        const motion = /^\s*-?[\d.]+m?s\b/.test(value) || /\b(cubic-bezier|steps|linear)\(/.test(value)
          || [...value.matchAll(/var\((--[a-zA-Z0-9_-]+)/g)].some((v) => isMotionToken(v[1]))
        if (!motion) continue
        seen.add(name)
        if (!isMotionToken(name)) missing.add(`${name}  (${f.split('/src/').pop()})`)
      }
    }
    expect(seen.size).toBeGreaterThan(40)
    expect([...missing]).toEqual([])
  })
  it('样子类的同族名不在名单里', () => {
    for (const n of ['--droplet-shadow', '--menu-hover', '--menu-shell-padding', '--seg-thumb', '--tip-bg', '--duration', '--easel', '--mb-top']) expect(isMotionToken(n)).toBe(false)
  })
})

describe('guardThemeCss', () => {
  it('删掉任何选择器、任何层级上的动效 token,别的声明照留', () => {
    const { css, report } = guardThemeCss(`
      [data-theme='x'] { --bg: #fff; --droplet-duration: 1600ms; --radius-lg: 20px }
      [data-theme='x'] .app { --menu-enter-duration: 2s !important; color: red; }
      @media (min-width: 600px) { :root { --ease-surface: cubic-bezier(.5, 2, .5, 1) } }
      @supports (display: grid) { .a { --collapse-duration:0s;--switch-edge-lag : 400ms } }
      .mb-shell { --mb-dur: 3s !important }
    `, 'x')
    expect(css).not.toMatch(/--droplet-duration|--menu-enter-duration|--ease-surface|--collapse-duration|--switch-edge-lag|--mb-dur/)
    expect(css).toContain('--bg: #fff;')
    expect(css).toContain('--radius-lg: 20px')
    expect(css).toContain('color: red;')
    expect(report.tokens).toEqual(['--droplet-duration', '--menu-enter-duration', '--ease-surface', '--collapse-duration', '--switch-edge-lag', '--mb-dur'])
  })
  it('转义写的变量名、嵌套规则后面的声明也删', () => {
    const { css, report } = guardThemeCss(`.shell { --\\6d enu-enter-duration: 2s !important; } .shell { & .child { color: red } --menu-exit-duration: 2s; }`, 'x')
    expect(report.tokens).toEqual(['--menu-enter-duration', '--menu-exit-duration'])
    expect(css).toContain('& .child { color: red }')
    expect(css).not.toMatch(/2s/)
  })
  it('值里带括号 / 字符串 / 分号 / 转义的花括号也删干净,不吃掉后面的声明', () => {
    const { css } = guardThemeCss(`.a { --ease-exit: cubic-bezier(0.4, 0, 1, 1); --tip-delay: var(--x, "a;b"); --duration-fast: \\{; --keep: 1 } .b { color: blue }`, 'x')
    expect(css.replace(/\s+/g, ' ')).toBe('.a { --keep: 1 } .b { color: blue }')
  })
  it('字符串 / 注释里长得像声明的不算,也不误删后面的规则;注释原样保留', () => {
    const src = `/* --droplet-duration: 9s; */ .a { content: "; --duration-fast: 0s"; color: red } .b { color: blue; --my-droplet-duration: 1s; transition: opacity 1s/**/linear }`
    const { css, report } = guardThemeCss(src, 'x')
    expect(report.tokens).toEqual([])
    expect(css).toBe(src)
  })
  it('@property --<动效 token> 整块删(大写也认);别的 @property 照留', () => {
    const { css, report } = guardThemeCss(`@PROPERTY --menu-exit-duration { syntax: '<time>'; inherits: false; initial-value: 2s; } @property --mine { syntax: '<length>'; inherits: true; initial-value: 0px } .a{}`, 'x')
    expect(css).not.toContain('--menu-exit-duration')
    expect(css).toContain('@property --mine')
    expect(report.tokens).toEqual(['--menu-exit-duration'])
  })
  it('@import 一律删(谷歌字体也删,走 theme.json 的 fonts.google;CDO 后面的也认)', () => {
    const { css, report } = guardThemeCss(`@import url('https://fonts.googleapis.com/css2?family=Inter') layer(forsion-guard); <!-- @IMPORT "y.css"; @import url(https://fonts.googleapis.com\\.evil.test/); .a { color: red }`, 'x')
    expect(css.replace(/\s+/g, ' ').trim()).toBe('<!-- .a { color: red }')
    expect(report.imports).toHaveLength(3)
    expect(report.tokens).toEqual([])
  })
  it('主题自己的关键帧加前缀(大小写照原样)并改写自己的引用;引用宿主关键帧不动', () => {
    const { css, report } = guardThemeCss(`
      @keyframes ui-menu-enter { from { opacity: 0 } }
      @KEYFRAMES kami-fade { to { opacity: 1 } }
      @keyframes Fade { to { opacity: .5 } }
      .a { animation: kami-fade 200ms ease-out, lcl-fade-out 80ms !important; }
      .b { ANIMATION-NAME: ui-menu-enter, Fade; }
      .c { animation: ui-fade-in 1s; }
      .d { animation: fade 1s; }
    `, 'market-1A2B')
    expect(report.keyframes).toEqual(['ui-menu-enter', 'kami-fade', 'Fade'])
    expect(css).toContain('@keyframes t-market-1a2b-ui-menu-enter')
    expect(css).toContain('@KEYFRAMES t-market-1a2b-kami-fade')
    expect(css).toContain('@keyframes t-market-1a2b-Fade')
    expect(css).not.toMatch(/@keyframes ui-menu-enter/)
    expect(css).toContain('animation: t-market-1a2b-kami-fade 200ms ease-out, lcl-fade-out 80ms !important;')
    expect(css).toContain('ANIMATION-NAME: t-market-1a2b-ui-menu-enter, t-market-1a2b-Fade;')
    expect(css).toContain('animation: ui-fade-in 1s;')
    expect(css).toContain('animation: fade 1s;') // 小写 fade 不是 Fade
  })
  it('和关键字同名的关键帧:定义照样加前缀,简写里同名的词当关键字不改;长写 / 字符串名照改;值里有 var() 的整条不碰', () => {
    const { css } = guardThemeCss(`@keyframes linear { to { opacity: 1 } } @keyframes "my anim" { to { opacity: 1 } } @keyframes "none" {}
      .a { animation: linear 1s linear; } .b { animation-name: linear, "none"; } .c { animation: "my anim" 1s; } .d { animation: "my anim" 1s, var(--x) linear; }
      .e { animation: calc(1s) linear; }`, 'k')
    expect(css).toContain('@keyframes t-k-linear')
    expect(css).toContain('@keyframes "t-k-my anim"')
    expect(css).toContain('@keyframes "t-k-none"')
    expect(css).toContain('animation: linear 1s linear;')
    expect(css).toContain('animation-name: t-k-linear, "t-k-none";')
    expect(css).toContain('animation: "t-k-my anim" 1s;')
    expect(css).toContain('animation: "my anim" 1s, var(--x) linear;')
    expect(css).toContain('animation: calc(1s) linear;')
  })
  it('关键帧块里的动效 token 也删(自定义属性能被关键帧动画改写)', () => {
    const { css, report } = guardThemeCss(`@keyframes k { to { --droplet-duration: 9s; opacity: 1 } }`, 'x')
    expect(css).toBe('@keyframes t-x-k { to {  opacity: 1 } }')
    expect(report.tokens).toEqual(['--droplet-duration'])
  })
  it('主题自己的层名加前缀(大写、转义也认):塞不进宿主的 forsion-guard 层', () => {
    const { css } = guardThemeCss(`@LAYER forsion-guard { * { animation-duration: 2s !important } } @layer a, b.c; @layer { .x {} } @layer forsion\\-guard { .y {} }`, 'k')
    expect(css).not.toMatch(/@layer forsion/i)
    expect(css).toContain('@LAYER t-k-forsion-guard {')
    expect(css).toContain('@layer t-k-a, t-k-b.t-k-c;')
    expect(css).toContain('@layer { .x {} }')
    expect(css).toContain('@layer t-k-forsion-guard { .y {} }')
  })
  // Codex 评审第二轮(2026-11-06)给的样本:选择器被当成声明、声明值里的数据、CR / FF 转义、url( 后的长空白、值里像规则的字
  it.each([
    ['顶层只有规则:animation:hover{} 是选择器,不吞掉后面', `animation:hover{}@keyframes a{}a{--duration-fast:1s}@layer forsion-guard{}`, `animation:hover{}@keyframes t-x-a{}a{}@layer t-x-forsion-guard{}`],
    ['块里 a:hover{…} 是嵌套规则,里面的声明照删', `.s{a:hover{--duration-fast:1s;color:red}--tip-delay:1s}`, `.s{a:hover{color:red}}`],
    ['声明值里的 @import 是数据,不吃掉后面的规则', `.a{--x:@import "x"}.b{color:red}`, `.a{--x:@import "x"}.b{color:red}`],
    ['自定义属性值里的 {…} 是数据,不删', `a{--x:{--duration-fast:1s}}`, `a{--x:{--duration-fast:1s}}`],
    ['声明值里的 @keyframes 不算定义', `a{--x:@keyframes host;animation-name:host}`, `a{--x:@keyframes host;animation-name:host}`],
    ['url( 后面空白再长也认引号', `a{--x:url(${' '.repeat(31)}")");--duration-fast:1s}`, `a{--x:url(${' '.repeat(31)}")");}`],
    ['块里的 @media 里的声明照删', `.a{@media (min-width:1px){--duration-fast:1s;color:red}}`, `.a{@media (min-width:1px){color:red}}`],
    ['infinite 名字当关键字(简写里引用不到,定义照样加前缀)', `@keyframes infinite{}a{animation:1e1 infinite 1s}`, `@keyframes t-x-infinite{}a{animation:1e1 infinite 1s}`],
    // 第三轮
    ['!important 不当关键帧名改', `@keyframes important{}a{animation-name:host!important}`, `@keyframes t-x-important{}a{animation-name:host!important}`],
    ['没有块的 @keyframes 不算定义', `@keyframes host;a{animation-name:host}`, `@keyframes host;a{animation-name:host}`],
    ['顶层 @media 块里是规则表:--x:hover{} 是规则,后面的 a{} 照删', `@media all{--x:hover{}a{--duration-fast:1s}}`, `@media all{--x:hover{}a{}}`],
    ['转义点号的层名是一个名字', `@layer a\\.b{a{color:red}}`, `@layer t-x-a\\2e b{a{color:red}}`],
  ])('%s', (_label, input, output) => {
    expect(guardThemeCss(input, 'x').css).toBe(output)
  })
  it('换行断掉的字符串不是合法名字:不当定义、不修成合法的', () => {
    const src = '@keyframes "fade\n{}a{animation-name:fade}'
    expect(guardThemeCss(src, 'x').css).toBe(src)
  })
  it('CR / FF 先按规范换成换行再读(转义后面跟 CR 照样拼出名字)', () => {
    expect(guardThemeCss('a{--\\64\ruration-fast:1s}', 'x').css).toBe('a{}')
    expect(guardThemeCss('a{--\\64\furation-fast:1s}', 'x').css).toBe('a{}')
    expect(guardThemeCss('@\\6c\rayer forsion-guard{}', 'x').css).toBe('@\\6c\nayer t-x-forsion-guard{}')
  })
  it('深嵌套不爆栈(块和函数各十万层)', () => {
    const deep = '('.repeat(100000) + ')'.repeat(100000)
    expect(guardThemeCss(`a{--x:${deep};--duration-fast:1s}`, 'x').css).toBe(`a{--x:${deep};}`)
  })
  it('什么都没写的主题一个字节不变', () => {
    const src = `/* soft */ [data-theme='soft'] { --bg: #faf7f2; --card-shadow: 0 1px 2px rgba(0,0,0,.1); }\n.btn:hover { transition: background 120ms; } @media (prefers-color-scheme: dark) { a:hover { color: red } }`
    expect(guardThemeCss(src, 'soft').css).toBe(src)
  })
})
