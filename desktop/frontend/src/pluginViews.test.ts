// @vitest-environment happy-dom
/**
 * 插件视图挂载失败 → 失败卡(报错首行 +「重试」);重试只重跑这一个视图的 mount。
 * 负对照(2026-10-29 实跑红过):effect 依赖里去掉 attempt → 点了重试 mount 不再调,「重试后挂上」红;
 * effect 开头不收失败卡 → 挂上了挂载点仍 hidden,同一条红。
 */
import { act, createElement as h } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { PluginViewHost, errorLine } from './pluginViews'
import type { ViewContribution } from '@amadeus/plugins/types'

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })

let root: Root | null = null
let box: HTMLDivElement
afterEach(() => { act(() => root?.unmount()); root = null; box?.remove() })

function render(def: ViewContribution): void {
  box = document.body.appendChild(document.createElement('div'))
  root = createRoot(box)
  const leaf = { id: 'leaf-1', type: 'plugin:p:v', params: {}, setParams: vi.fn(), close: vi.fn() }
  act(() => root!.render(h(PluginViewHost as never, { def, pluginId: 'p', leaf, params: {} })))
}

describe('PluginViewHost 挂载失败卡', () => {
  it('抛错 → 卡上写首行;重试 → 只重跑 mount,好了就挂上', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    let calls = 0
    const mount = vi.fn((el: HTMLElement) => {
      if (++calls === 1) throw new TypeError('data.items is undefined\n    at mount (main.js:12)')
      el.innerHTML = '<p data-ok>ok</p>'
    })
    render({ id: 'v', title: 'V', mount } as unknown as ViewContribution)
    const card = box.querySelector('[data-plugin-view-failed]')
    expect(card?.textContent).toContain('插件视图加载失败')
    expect(card?.textContent).toContain('TypeError: data.items is undefined')
    expect(card?.textContent).not.toContain('main.js:12')
    expect(box.querySelector<HTMLElement>('[data-plugin-view-host]')!.hidden).toBe(true)

    act(() => box.querySelector<HTMLButtonElement>('[data-action="plugin-view-retry"]')!.click())
    expect(mount).toHaveBeenCalledTimes(2)
    expect(box.querySelector('[data-plugin-view-failed]')).toBeNull()
    const host = box.querySelector<HTMLElement>('[data-plugin-view-host]')!
    expect(host.hidden).toBe(false)
    expect(host.querySelector('[data-ok]')).not.toBeNull()
  })

  it('async mount reject 同样出卡', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    render({ id: 'v', title: 'V', mount: () => Promise.reject(new Error('fetch failed')) } as unknown as ViewContribution)
    await act(async () => { await Promise.resolve() })
    expect(box.querySelector('[data-plugin-view-failed]')?.textContent).toContain('fetch failed')
  })

  it('errorLine:去掉通用 Error 前缀、只留首行、过长截断', () => {
    expect(errorLine(new Error('boom\nstack'))).toBe('boom')
    expect(errorLine(new RangeError('bad'))).toBe('RangeError: bad')
    expect(errorLine('plain')).toBe('plain')
    expect(errorLine(undefined)).toBe('')
    expect(errorLine('x'.repeat(300))).toHaveLength(200)
  })
})
