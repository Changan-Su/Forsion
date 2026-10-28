/**
 * sketch 卡安全边界回归钉(实证背景见 sketchWrapper.ts 头注):
 * 裸 sandbox 挡不住网络——没有内层 CSP 的变体能 fetch 任意 https。这里钉住包装器的不变式。
 */
import { describe, it, expect, vi } from 'vitest'
import { runInNewContext } from 'node:vm'
// Vitest disables CSS processing in node tests; read the same stylesheet the renderer bundles.
vi.mock('./sketch.css?raw', async () => ({
  default: (await import('node:fs')).readFileSync(new URL('./sketch.css', import.meta.url), 'utf8'),
}))
import { buildSketchDoc, IUI_LIB_IMPORTS, SKETCH_CSP, SKETCH_SANDBOX, SKETCH_STATIC_VARS, SKETCH_VARS } from './sketchWrapper'

describe('sketch 包装器安全不变式', () => {
  it('sandbox 恒为仅 allow-scripts(绝不 allow-same-origin/forms/popups)', () => {
    expect(SKETCH_SANDBOX).toBe('allow-scripts')
  })

  it('内层 CSP 收口网络且不给 eval', () => {
    expect(SKETCH_CSP).toContain("default-src 'none'")
    expect(SKETCH_CSP).not.toContain('unsafe-eval')
    expect(SKETCH_CSP).not.toContain('https:')
  })

  it('CSP meta 是 head 第一个元素(模型 HTML 只能收紧不能放松)', () => {
    const doc = buildSketchDoc('<b>hi</b>')
    const head = doc.indexOf('<head>')
    const meta = doc.indexOf('<meta http-equiv="Content-Security-Policy"')
    expect(head).toBeGreaterThan(-1)
    expect(meta).toBe(head + '<head>'.length)
  })

  it('包装脚本在 head 内、模型 HTML 之前(残缺标记吞不掉它)', () => {
    const doc = buildSketchDoc('<div>unclosed')
    expect(doc.indexOf('<script>')).toBeLessThan(doc.indexOf('<div>unclosed'))
    expect(doc).toContain('sketch-height')
    expect(doc.endsWith('</body></html>')).toBe(true)
  })

  it('runs both raw bootstrap scripts without accidental IIFE chaining', () => {
    const script = buildSketchDoc('').match(/<script>([\s\S]*?)<\/script>/)![1]
    const ready: Function[] = []
    const register = vi.fn()
    runInNewContext(script, {
      window: { addEventListener() {} }, HTMLElement: class {},
      document: { readyState: 'loading', addEventListener: (name: string, cb: Function) => { if (name === 'DOMContentLoaded') ready.push(cb) } },
      customElements: { get: () => undefined, define: register },
    })
    expect(ready).toHaveLength(2)
    ready[1]()
    expect(register.mock.calls.map(([name]) => name)).toEqual(['fs-chart', 'fs-flow', 'fs-compare', 'fs-choice', 'fs-checklist'])
  })
})

// 随包库(10-28,方案页 docs/ToBeImproved/IntelligentUI卡内库方案_2026-10-27):卡能 import three / d3 / chart.js / gsap,
// 但仍然断网 —— 内层 CSP 相对基线只许多 script-src 一个来源,connect-src 一个字都不许出现。
describe('sketch 随包库', () => {
  const policyOf = (doc: string) => doc.match(/Content-Security-Policy" content="([^"]*)"/)![1]
  const directives = (csp: string) => Object.fromEntries(csp.split(';').map((d) => d.trim().split(/\s+/)).map(([k, ...v]) => [k, v]))
  const importMapOf = (doc: string) => JSON.parse(doc.match(/<script type="importmap">([^<]*)<\/script>/)?.[1] ?? 'null')
  const onPlatform = (tangu: object | undefined, fn: () => void) => {
    vi.stubGlobal('window', { tangu }); vi.stubGlobal('document', { baseURI: 'https://web.example/chat/s1' })
    try { fn() } finally { vi.unstubAllGlobals() }
  }
  const expectOnlyExtraScriptSource = (doc: string, source: string) => {
    const got = directives(policyOf(doc)), base = directives(SKETCH_CSP)
    expect(got['script-src']).toEqual([...base['script-src'], source])
    expect({ ...got, 'script-src': base['script-src'] }).toEqual(base)
    expect(policyOf(doc)).not.toMatch(/connect-src|unsafe-eval|https:(?!\/\/web\.example\/iui-lib\/)/)
  }

  it('桌面:只多 forsion-iui:,importmap 指向应用自己的协议', () => {
    onPlatform({}, () => {
      const doc = buildSketchDoc('')
      expectOnlyExtraScriptSource(doc, 'forsion-iui:')
      expect(importMapOf(doc).imports.three).toBe('forsion-iui://lib/three@0.186/three.module.js')
    })
  })

  it('网页:只多本站带路径的 /iui-lib/(不是整站、更不是 https:)', () => {
    onPlatform({ cloudWeb: true }, () => {
      const doc = buildSketchDoc('')
      expectOnlyExtraScriptSource(doc, 'https://web.example/iui-lib/')
      expect(importMapOf(doc).imports.d3).toBe('https://web.example/iui-lib/d3@7/d3.js')
    })
  })

  it('手机原生包没带库:CSP 与今天逐字相同,没有 importmap', () => {
    onPlatform({ mobile: true }, () => {
      const doc = buildSketchDoc('')
      expect(policyOf(doc)).toBe(SKETCH_CSP)
      expect(importMapOf(doc)).toBeNull()
    })
  })

  it('importmap 紧跟 CSP、早于任何脚本;键正好是引擎说明里列的那几个', () => {
    const doc = buildSketchDoc('<script type="module">import * as THREE from "three"</script>')
    const meta = doc.indexOf('<meta http-equiv="Content-Security-Policy"')
    const map = doc.indexOf('<script type="importmap">')
    expect(map).toBe(doc.indexOf('>', meta) + 1)
    expect(map).toBeLessThan(doc.indexOf('<script>'))
    expect(Object.keys(importMapOf(doc).imports).sort()).toEqual(['chart.js', 'chart.js/auto', 'd3', 'gsap', 'three', 'three/addons/'])
  })

  it('importmap 指的文件都已生成(build/copy-iui-libs.cjs 的目录名与这里一致)', async () => {
    const { existsSync } = await import('node:fs')
    for (const rel of Object.values(IUI_LIB_IMPORTS)) {
      const p = new URL(`../../public/iui-lib/${rel}${rel.endsWith('/') ? 'controls/OrbitControls.js' : ''}`, import.meta.url)
      expect(existsSync(p), rel).toBe(true)
    }
  })
})

describe('sketch 主题桥', () => {
  it('变量注入在 head 的 style 里、且晚于 CSP meta', () => {
    const doc = buildSketchDoc('<b>hi</b>', { '--fs-accent': '#1c1c1c', 'color-scheme': 'dark' })
    expect(doc).toContain('--fs-accent:#1c1c1c')
    expect(doc).toContain('color-scheme:dark')
    expect(doc.indexOf('Content-Security-Policy')).toBeLessThan(doc.indexOf('<style>'))
  })

  it('token 值是半可信输入:尖括号必须被掐掉,拼不出提前闭合的 style', () => {
    const doc = buildSketchDoc('<b>hi</b>', { '--fs-bg': '</style><script>alert(1)</script>' })
    expect(doc).not.toContain('</style><script>alert(1)')
    expect(doc).not.toContain('alert(1)</script>')
    // 变量名本身也过滤:非法键名不该带出属性/选择器
    const doc2 = buildSketchDoc('', { 'x:red;}<style>a{b': 'c' })
    expect(doc2).not.toContain('<style>a{b')
  })

  it('缺省无变量时仍产出可用文档(历史卡/单测路径)', () => {
    const doc = buildSketchDoc('<b>hi</b>')
    expect(doc).toContain('--fs-s1:var(--fs-accent)')
    expect(doc).toContain('background: var(--fs-bg)')
  })

  it('supplies legacy layout classes and native interactive controls', () => {
    const doc = buildSketchDoc('<header class="fs-header"><h1 class="fs-title">T</h1></header>')
    for (const cls of ['.fs-header', '.fs-eyebrow', '.fs-title', '.fs-subtitle', '.fs-plot', '.fs-source', '.fs-stat-grid', '.fs-value', '.fs-bar-track', '.fs-controls', '.fs-range', '.fs-tabs']) {
      expect(doc).toContain(cls)
    }
    expect(doc).toContain('font-variant-numeric: tabular-nums')
    expect(doc).toContain('@media(max-width:480px)')
    expect(doc).toContain('@media(prefers-reduced-motion:reduce)')
  })

  it('卡内变量名与引擎描述同名(跨仓两份的锚:改名必须两边一起改)', () => {
    const names = [...Object.keys(SKETCH_STATIC_VARS), ...SKETCH_VARS.map(([into]) => into)]
    expect(names).toEqual([
      '--fs-bg', '--fs-surface', '--fs-text', '--fs-muted', '--fs-faint',
      '--fs-border', '--fs-rule', '--fs-accent', '--fs-accent-soft',
      '--fs-green', '--fs-danger', '--fs-radius', '--fs-font', '--fs-mono',
    ])
    expect(SKETCH_STATIC_VARS).toEqual({ '--fs-bg': 'transparent' })
  })

  it('换肤走 postMessage 就地改,且只认 parent(不重建 srcdoc)', () => {
    const doc = buildSketchDoc('')
    expect(doc).toContain('sketch-theme')
    expect(doc).toContain('event.source !== parent')
    expect(doc).toContain('setProperty')
  })

  it('embeds the host nonce (sanitized) and removes its own script after running', () => {
    const doc = buildSketchDoc('<p>x</p>', {}, null, 'abc-123"<>\'')
    expect(doc).toContain("NONCE = 'abc-123'")
    expect(doc).not.toContain('__SKETCH_NONCE__')
    expect(doc).toContain('document.currentScript?.remove()')
  })
  it('escapes persisted state as script data, never markup or replacement syntax', () => {
    const value = '</script><script>alert(1)</script>$&\u2028'
    const doc = buildSketchDoc('<p>body</p>', {}, { value })
    expect(doc).not.toContain('</script><script>alert(1)')
    expect(doc).toContain('\\u003c/script>')
    expect(doc).not.toContain('__SKETCH_INITIAL_STATE__')
    expect(doc).toContain('$&\\u2028')
    expect(doc.match(/<script>/g)).toHaveLength(1)
  })
})
