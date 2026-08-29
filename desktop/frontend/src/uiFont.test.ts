/**
 * 字体覆盖会真出事的几条性质:
 *  ① 值拼进 CSS 文本 → 必须挡住 `;` / `}` / 注释,否则一个被改写的 localStorage、或一个插件给的脏 stack,
 *     就能往全局样式表里塞规则。
 *  ② 「跟随主题」必须是**一条声明都不出**,而不是出个空值 —— 出空值会把主题字体清成默认无衬线。
 *  ③ 预设解析不出来(旧脏值 / 预设已删 / 插件被禁)一律等同跟随主题 —— 这条路同时兜住三种情况,
 *     退化成「选了个字体但没反应」都算坏。
 *  ④ 预设必须解析成**带中文兜底的字体栈**:只给拉丁字族 = 汉字仍回落系统字体 = 本次改动等于没做。
 */
import { describe, expect, it, afterEach } from 'vitest'
import { sanitizeFont, buildFontCss, resolveFontStack } from './uiFont'
import { registerFont, getFont, listFonts, migrateLegacyValue, pluginFontFamily, subscribeFonts, _resetDynamicFonts } from './fontPresets'

afterEach(() => _resetDynamicFonts())

describe('sanitizeFont', () => {
  it('放行正常字体名(含中文与引号逗号)', () => {
    expect(sanitizeFont("'PingFang SC', 苹方, ui-sans-serif")).toBe("'PingFang SC', 苹方, ui-sans-serif")
  })

  it('剔掉能越出声明的字符', () => {
    expect(sanitizeFont('Inter; } body { display: none')).toBe('Inter  body  display none')
    expect(sanitizeFont('Inter/*x*/')).toBe('Interx')
    expect(sanitizeFont('a<script>')).toBe('ascript')
  })

  it('空/空白/null → 空串', () => {
    expect(sanitizeFont('   ')).toBe('')
    expect(sanitizeFont(null)).toBe('')
  })
})

describe('预设解析', () => {
  it('内置预设解析成字体栈', () => {
    expect(resolveFontStack('inter')).toContain('Inter Variable')
    expect(resolveFontStack('jetbrains')).toContain('JetBrains Mono Variable')
  })

  it('④ 非等宽预设必须自带内置中文兜底(否则汉字回落系统字体)', () => {
    for (const id of ['inter', 'noto-sans', 'wenkai', 'jetbrains']) {
      expect(resolveFontStack(id)).toContain('Noto Sans SC')
    }
  })

  it('③ 未知 id / 旧字面值 / 空 → 空串(跟随主题)', () => {
    expect(resolveFontStack('no-such-preset')).toBe('')
    expect(resolveFontStack('Microsoft YaHei')).toBe('') // 旧版自由输入留下的
    expect(resolveFontStack('')).toBe('')
    expect(resolveFontStack(null)).toBe('')
  })

  it('旧值迁移只认名单内的,其余落空', () => {
    expect(migrateLegacyValue('Inter')).toBe('inter')
    expect(migrateLegacyValue('system-ui')).toBe('system')
    expect(migrateLegacyValue('Comic Sans MS')).toBe('')
  })

  it('等宽预设不出现在正文档,反之亦然', () => {
    expect(listFonts('mono').map((f) => f.id)).toContain('jetbrains')
    expect(listFonts('body').map((f) => f.id)).not.toContain('jetbrains')
    expect(listFonts('body').map((f) => f.id)).toContain('inter')
  })
})

describe('buildFontCss', () => {
  it('② 三档全空 → 不出任何 CSS(跟随主题)', () => {
    expect(buildFontCss({})).toBe('')
    expect(buildFontCss({ ui: '', body: '  ', mono: '' })).toBe('')
  })

  it('② 全是未知 id 也必须一条声明都不出', () => {
    expect(buildFontCss({ ui: 'gone', body: 'Helvetica Neue', mono: 'nope' })).toBe('')
  })

  it('界面档同时盖 --font-ui 与 Amadeus soft 的 --font,且带 !important', () => {
    const css = buildFontCss({ ui: 'inter' })
    expect(css).toContain('--font-ui:')
    expect(css).toContain('--font:')
    expect(css).toContain('!important')
    expect(css).toContain('Inter Variable')
    expect(css).not.toContain('--font-mono')
  })

  it('选择器点到会重定义字体变量的那几个类(否则被 .tangu-lovable[data-skin] 遮住)', () => {
    const css = buildFontCss({ mono: 'jetbrains' })
    for (const sel of [':root', '.am-app', '.tangu-lovable', '.tangu-soft']) expect(css).toContain(sel)
    expect(css).toContain('--mono:')
  })

  it('① 插件给的脏 stack 也逃不出花括号', () => {
    registerFont({ id: 'evil', label: 'x', slots: ['ui'], source: 'plugin:p', stack: 'X; } * { color: red' })
    const css = buildFontCss({ ui: 'evil' })
    expect(css.match(/[{}]/g)).toEqual(['{', '}'])
    expect(css).not.toContain('color: red')
  })
})

describe('插件字体', () => {
  it('注册后进对应档位的名单,并能解析成栈', () => {
    registerFont({ id: 'plugin:acme:serif', label: 'Acme Serif', slots: ['body'], source: 'plugin:acme', stack: "'Acme Serif', 'Noto Sans SC', serif" })
    expect(listFonts('body').map((f) => f.id)).toContain('plugin:acme:serif')
    expect(resolveFontStack('plugin:acme:serif')).toContain('Acme Serif')
  })

  it('dispose 后从名单消失,且存了该 id 的档位回落跟随主题', () => {
    const off = registerFont({ id: 'plugin:acme:x', label: 'X', slots: ['ui'], source: 'plugin:acme', stack: "'X', 'Noto Sans SC', sans-serif" })
    expect(buildFontCss({ ui: 'plugin:acme:x' })).not.toBe('')
    off()
    expect(getFont('plugin:acme:x')).toBeUndefined()
    expect(buildFontCss({ ui: 'plugin:acme:x' })).toBe('') // ③ 被禁插件的字体 = 跟随主题
  })
})

// ── 以下为 codex 评审 2026-08-28 抓出的几条,补上回归 ──────────────────────────
describe('插件字体:文件与生命周期', () => {
  it('③ 带文件的插件字体,宿主必须把安全 family 放到栈首(否则文件加载了也用不上)', () => {
    registerFont({
      id: 'plugin:acme:withfile', label: 'F', slots: ['ui'], source: 'plugin:acme',
      stack: "'Noto Sans SC', sans-serif",
      files: [{ url: '/plugins/acme/f.woff2' }],
    })
    const fam = pluginFontFamily('plugin:acme:withfile')
    expect(fam).toMatch(/^pf-plugin-acme-withfile-[a-z0-9]+$/)
    expect(getFont('plugin:acme:withfile')!.stack.startsWith(`'${fam}'`)).toBe(true)
    // 关键:family 必须活得过 sanitize,否则栈里那个名字会被剥成对不上的东西
    const css = buildFontCss({ ui: 'plugin:acme:withfile' })
    expect(css).toContain(fam)
  })

  it('⑤ 同 id 重复注册 = 原子替换,旧 disposer 不该删掉新的那条', () => {
    const offOld = registerFont({ id: 'plugin:a:x', label: 'old', slots: ['ui'], source: 'plugin:a', stack: "'Old', sans-serif" })
    registerFont({ id: 'plugin:a:x', label: 'new', slots: ['ui'], source: 'plugin:a', stack: "'New', sans-serif" })
    offOld() // 旧的 disposer 迟到:不能把新注册的那条带走
    expect(getFont('plugin:a:x')?.label).toBe('new')
    expect(resolveFontStack('plugin:a:x')).toContain('New')
  })

  it('④ 注册与 dispose 都要通知订阅者(否则注入的 <style> 不会重算)', () => {
    let hits = 0
    const unsub = subscribeFonts(() => { hits++ })
    const off = registerFont({ id: 'plugin:a:n', label: 'N', slots: ['ui'], source: 'plugin:a', stack: "'N', sans-serif" })
    expect(hits).toBe(1)
    off()
    expect(hits).toBe(2)
    unsub()
    registerFont({ id: 'plugin:a:m', label: 'M', slots: ['ui'], source: 'plugin:a', stack: "'M', sans-serif" })
    expect(hits).toBe(2) // 退订后不再收
  })
  it('③b 不同 id 不得映射到同一 family(折叠非字母数字会确定性撞车)', () => {
    // codex 评审第二轮给的确切反例:两者折叠后都是 pf-plugin-a-b-c
    expect(pluginFontFamily('plugin:a-b:c')).not.toBe(pluginFontFamily('plugin:a:b-c'))
    // 且必须仍然是 CSS 安全的(过得了 sanitizeFont,否则栈里那个名字会被剥变形)
    for (const id of ['plugin:a-b:c', 'plugin:a:b-c']) {
      const fam = pluginFontFamily(id)
      expect(sanitizeFont(fam)).toBe(fam)
      expect(fam).toMatch(/^[a-z0-9-]+$/)
    }
  })
})
