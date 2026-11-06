/**
 * 动效收口(motionGuard.ts):磁盘主题的 CSS 进注册表前删掉动效 token、给主题自己的关键帧与层名加前缀。
 * 真 Electron 里的层序 / 减少动态效果 / 主题注入另由台架 check:motiontheme 钉(带负对照)。
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { guardThemeCss, isMotionToken } from './motionGuard'

const base = readFileSync(new URL('../styles/base.css', import.meta.url), 'utf8')

describe('动效 token 名单不漂移', () => {
  it('base.css「动效 token」那块(:root 里 --menu-enter-duration 起到块尾)声明的每个变量都在名单里', () => {
    const start = base.indexOf('--menu-enter-duration:')
    expect(start).toBeGreaterThan(0)
    const block = base.slice(start, base.indexOf('\n}', start))
    const names = [...block.matchAll(/(--[a-z0-9-]+)\s*:/g)].map((m) => m[1])
    expect(names.length).toBeGreaterThan(30)
    expect(names.filter((n) => !isMotionToken(n))).toEqual([])
  })
  it('--duration-* / --ease-*(base.css 第一块)也在;样子类的同族名不在', () => {
    for (const n of ['--duration-instant', '--duration-fast', '--duration-base', '--duration-slow', '--ease-out', '--ease-spring', '--ease-apple', '--view-enter-duration', '--frame-reveal-duration', '--seg-edge-duration', '--seg-edge-lag']) expect(isMotionToken(n)).toBe(true)
    for (const n of ['--droplet-shadow', '--menu-hover', '--menu-shell-padding', '--seg-thumb', '--tip-bg', '--duration', '--easel']) expect(isMotionToken(n)).toBe(false)
  })
})

describe('guardThemeCss', () => {
  it('删掉任何选择器、任何层级上的动效 token,别的声明照留', () => {
    const { css, report } = guardThemeCss(`
      [data-theme='x'] { --bg: #fff; --droplet-duration: 1600ms; --radius-lg: 20px }
      [data-theme='x'] .app { --menu-enter-duration: 2s !important; color: red; }
      @media (min-width: 600px) { :root { --ease-surface: cubic-bezier(.5, 2, .5, 1) } }
      @supports (display: grid) { .a { --collapse-duration:0s;--switch-edge-lag : 400ms } }
    `, 'x')
    expect(css).not.toMatch(/--droplet-duration|--menu-enter-duration|--ease-surface|--collapse-duration|--switch-edge-lag/)
    expect(css).toContain('--bg: #fff;')
    expect(css).toContain('--radius-lg: 20px')
    expect(css).toContain('color: red;')
    expect(report.tokens).toEqual(['--droplet-duration', '--menu-enter-duration', '--ease-surface', '--collapse-duration', '--switch-edge-lag'])
  })
  it('值里带括号 / 字符串 / 分号也删干净,不吃掉后面的声明', () => {
    const { css } = guardThemeCss(`.a { --ease-exit: cubic-bezier(0.4, 0, 1, 1); --tip-delay: var(--x, "a;b"); --keep: 1 }`, 'x')
    expect(css.replace(/\s+/g, ' ')).toBe('.a { --keep: 1 }')
  })
  it('注释里的不算;别的变量名里含动效 token 字样的不删', () => {
    const { css, report } = guardThemeCss(`/* --droplet-duration: 9s; */ .a { --my-droplet-duration: 1s; --x--duration-fast: 2s; content: "--duration-fast: 0s" }`, 'x')
    expect(report.tokens).toEqual([])
    expect(css).toContain('--my-droplet-duration: 1s')
    expect(css).toContain('--x--duration-fast: 2s')
    expect(css).toContain('"--duration-fast: 0s"')
  })
  it('@property --<动效 token> 整块删(inherits: false 会让子孙拿不到宿主的值)', () => {
    const { css, report } = guardThemeCss(`@property --menu-exit-duration { syntax: '<time>'; inherits: false; initial-value: 2s; } @property --mine { syntax: '<length>'; inherits: true; initial-value: 0px } .a{}`, 'x')
    expect(css).not.toContain('--menu-exit-duration')
    expect(css).toContain('@property --mine')
    expect(report.tokens).toEqual(['--menu-exit-duration'])
  })
  it('主题自己的关键帧加前缀并改写自己的引用;引用宿主关键帧(没定义的名字)不动', () => {
    const { css, report } = guardThemeCss(`
      @keyframes ui-menu-enter { from { opacity: 0 } }
      @keyframes kami-fade { to { opacity: 1 } }
      .a { animation: kami-fade 200ms ease-out, lcl-fade-out 80ms !important; }
      .b { animation-name: ui-menu-enter; }
      .c { animation: ui-fade-in 1s; }
    `, 'market-1A2B')
    expect(report.keyframes).toEqual(['ui-menu-enter', 'kami-fade'])
    expect(css).toContain('@keyframes t-market-1a2b-ui-menu-enter')
    expect(css).toContain('@keyframes t-market-1a2b-kami-fade')
    expect(css).not.toMatch(/@keyframes ui-menu-enter/)
    expect(css).toContain('animation: t-market-1a2b-kami-fade 200ms ease-out, lcl-fade-out 80ms !important;')
    expect(css).toContain('animation-name: t-market-1a2b-ui-menu-enter;')
    expect(css).toContain('animation: ui-fade-in 1s;')
  })
  it('主题自己的层名加前缀:塞不进宿主的 forsion-guard 层', () => {
    const { css } = guardThemeCss(`@layer forsion-guard { * { animation-duration: 2s !important } } @layer a, b.c; @layer { .x {} }`, 'k')
    expect(css).not.toMatch(/@layer forsion-guard/)
    expect(css).toContain('@layer t-k-forsion-guard {')
    expect(css).toContain('@layer t-k-a, t-k-b.t-k-c ;')
    expect(css).toContain('@layer { .x {} }')
  })
  it('什么都没写的主题原样过(除了注释)', () => {
    const src = `[data-theme='soft'] { --bg: #faf7f2; --card-shadow: 0 1px 2px rgba(0,0,0,.1); }\n.btn:hover { transition: background 120ms; }`
    expect(guardThemeCss(src, 'soft').css).toBe(src)
  })
})
