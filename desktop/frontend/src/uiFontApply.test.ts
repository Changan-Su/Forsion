// @vitest-environment happy-dom
/** applyUiFonts 的真实接线(纯函数那半在 uiFont.test.ts)。这里钉的是 codex 评审 2026-08-28 抓出的
 *  第 4 条:**注册表变了,已注入的 <style> 必须跟着重算**。
 *
 *  为什么非要一个 DOM 测试:外置插件是异步装的,启动那趟 applyUiFonts 早就跑完了。
 *  ① 插件装好前:存着的插件字体 id 解析不出来 → 该档一条声明都不出(而不是残留半条);
 *  ② 插件装好后:必须自己重算,否则用户重启一次,选好的插件字体就永远回不来;
 *  ③ 插件禁用后:必须把那条撤掉,否则 <style> 里的插件栈继续盖着主题。
 *  这三条在 node 环境的纯函数测试里都测不到 —— 那边看不见 <style>。
 */
import { describe, expect, it, beforeEach } from 'vitest'
import { applyUiFonts } from './uiFont'
import { registerFont, _resetDynamicFonts } from './fontPresets'
import { FONT_UI_KEY } from './types'

const styleText = (): string | null =>
  document.getElementById('forsion-ui-font')?.textContent ?? null

beforeEach(() => {
  _resetDynamicFonts()
  localStorage.clear()
  document.getElementById('forsion-ui-font')?.remove()
})

describe('applyUiFonts 注入', () => {
  it('三档都跟随主题 → 根本不留 <style> 元素', () => {
    applyUiFonts()
    expect(styleText()).toBeNull()
  })

  it('内置预设 → 注入完整字体栈', () => {
    localStorage.setItem(FONT_UI_KEY, 'inter')
    applyUiFonts()
    expect(styleText()).toContain('Inter Variable')
    expect(styleText()).toContain('Noto Sans SC') // 中文兜底不能丢
  })

  it('① 插件还没装:存着的插件 id 解析不出来 → 该档一条声明都不出', () => {
    localStorage.setItem(FONT_UI_KEY, 'plugin:demo:f')
    applyUiFonts()
    expect(styleText()).toBeNull()
  })

  it('② 插件装好后必须自己重算(否则重启一次选好的插件字体就回不来)', () => {
    localStorage.setItem(FONT_UI_KEY, 'plugin:demo:f')
    applyUiFonts() // 启动那趟:插件尚未装
    expect(styleText()).toBeNull()

    registerFont({
      id: 'plugin:demo:f', label: 'Demo', slots: ['ui'], source: 'plugin:demo',
      stack: "'Noto Sans SC', sans-serif",
      files: [{ url: '/plugins/demo/f.woff2' }],
    })
    // 没人再调 applyUiFonts —— 全靠注册表的变更通知
    expect(styleText()).toContain('--font-ui')
    expect(styleText()).toContain('pf-plugin-demo-f') // 宿主生成的安全 family 必须在栈里
  })

  it('③ 插件禁用后必须撤掉那条,而不是继续盖着主题', () => {
    localStorage.setItem(FONT_UI_KEY, 'plugin:demo:f')
    applyUiFonts()
    const off = registerFont({
      id: 'plugin:demo:f', label: 'Demo', slots: ['ui'], source: 'plugin:demo',
      stack: "'Noto Sans SC', sans-serif",
    })
    expect(styleText()).toContain('--font-ui')
    off()
    expect(styleText()).toBeNull() // 退化成跟随主题
  })
})
