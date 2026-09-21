// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as React from 'react'
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import type { ProductSummary } from '../../../../shared/products'

const { devState, reloadDevPlugin, clearDevPluginLogs, studio } = vi.hoisted(() => ({
  devState: {
    loaded: false, active: false, blocked: null as string | null, blockedReason: null as string | null,
    setupError: null as string | null, mountErrors: [] as Array<{ viewId: string; message: string; at: number }>,
    logs: [] as Array<{ level: string; text: string; at: number }>, shadowsInstalled: false,
  },
  reloadDevPlugin: vi.fn(async () => {}),
  clearDevPluginLogs: vi.fn(),
  studio: { activeProject: '/projects/my-plugin' },
}))
// 宿主那半(devSandbox)只提供状态与两个动作;这里要测的是面板把它们接对了没有。
vi.mock('@amadeus/plugins/devSandbox', () => ({
  useDevPluginState: () => devState,
  getDevPluginState: () => devState,
  reloadDevPlugin,
  clearDevPluginLogs,
}))
vi.mock('../../stores/codeStudioStore', () => ({ useCodeStudio: Object.assign(() => undefined, { getState: () => studio }) }))
import { SandboxPanel } from './SandboxPanel'

const globals = globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean; React: typeof React }
globals.IS_REACT_ACT_ENVIRONMENT = true; globals.React = React
let host: HTMLDivElement
let root: Root
const onPrompt = vi.fn()
const onProductChanged = vi.fn()
const productsUpdate = vi.fn(async (_id: string, patch: { devLoad?: boolean }) => ({ ...product({ devLoad: patch.devLoad }) }))
const calls: string[] = []

function product(patch: Partial<ProductSummary> = {}): ProductSummary {
  return { id: 'p_0123456789ab', kind: 'plugin', name: 'My plugin', root: '/projects/my-plugin', entry: null,
    createdAt: 1, updatedAt: 2, published: false, pluginId: 'my-plugin', devLoad: false, ...patch }
}
async function mount(next: ProductSummary | null = product()) {
  await act(async () => {
    root.render(createElement(SandboxPanel, { root: '/projects/my-plugin', product: next, onPrompt, onProductChanged }))
  })
}
const panel = () => host.querySelector('.csu-sandbox')!
const state = () => panel().getAttribute('data-sandbox-state')
const button = (action: string) => host.querySelector<HTMLButtonElement>(`[data-action="${action}"]`)
const click = async (action: string) => { await act(async () => { button(action)!.click() }) }

beforeEach(() => {
  Object.assign(devState, { loaded: false, active: false, blocked: null, blockedReason: null, setupError: null, mountErrors: [], logs: [], shadowsInstalled: false })
  studio.activeProject = '/projects/my-plugin'
  onPrompt.mockReset(); onProductChanged.mockReset(); calls.length = 0
  reloadDevPlugin.mockReset().mockImplementation(async () => { calls.push('reload') })
  clearDevPluginLogs.mockReset()
  productsUpdate.mockReset().mockImplementation(async (_id: string, patch: { devLoad?: boolean }) => { calls.push(`update:${patch.devLoad}`); return product({ devLoad: patch.devLoad }) })
  onProductChanged.mockImplementation(() => { calls.push('changed') })
  window.tangu = { productsUpdate, productsEnsure: vi.fn() } as unknown as NonNullable<typeof window.tangu>
  host = document.createElement('div'); document.body.append(host); root = createRoot(host)
})
afterEach(async () => {
  await act(async () => { root.unmount() })
  host.remove(); delete window.tangu
})

describe('sandbox states', () => {
  it('reports a plugin that is not loaded yet', async () => {
    await mount()
    expect(state()).toBe('unloaded')
    expect(host.querySelector('[data-sandbox-state-label]')!.textContent).toBe('未加载')
    expect(button('sandbox-load')!.disabled).toBe(false)
    expect(button('sandbox-unload')).toBeNull()
    expect(button('sandbox-reload')).toBeNull()
  })
  it('reports a loaded and running plugin with its hot reload rule', async () => {
    Object.assign(devState, { loaded: true, active: true })
    await mount(product({ devLoad: true }))
    expect(state()).toBe('active')
    expect(panel().textContent).toContain('保存即重载')
    expect(button('sandbox-load')).toBeNull()
    expect(button('sandbox-unload')).not.toBeNull()
    expect(button('sandbox-reload')).not.toBeNull()
  })
  it('explains a blocked plugin and refuses to offer the load button as usable', async () => {
    Object.assign(devState, { blocked: 'dev-fileext', blockedReason: 'plugin declares fileExtensions' })
    await mount()
    expect(state()).toBe('blocked')
    expect(panel().textContent).toContain('自定义文件类型')
    expect(button('sandbox-load')!.disabled).toBe(true)
  })
  it('shows the host reason verbatim for any other refusal', async () => {
    Object.assign(devState, { blocked: 'engine-plugin', blockedReason: 'engine plugins cannot hot reload' })
    await mount()
    expect(state()).toBe('blocked')
    expect(panel().textContent).toContain('engine plugins cannot hot reload')
  })
  it('surfaces a setup failure with the thrown text', async () => {
    Object.assign(devState, { loaded: true, active: false, setupError: 'TypeError: ctx.registerVeiw is not a function' })
    await mount(product({ devLoad: true }))
    expect(state()).toBe('failed')
    expect(host.querySelector('[data-sandbox-error="setup"]')!.textContent).toContain('ctx.registerVeiw')
  })
  it('never hides the trust notice, whatever the state', async () => {
    const cases: Array<[Record<string, unknown>, boolean, string]> = [
      [{}, false, 'unloaded'],
      [{ loaded: true, active: true }, true, 'active'],
      [{ blocked: 'dev-fileext' }, false, 'blocked'],
      [{ loaded: true, setupError: 'boom' }, true, 'failed'],
    ]
    for (const [patch, devLoad, expected] of cases) {
      Object.assign(devState, { loaded: false, active: false, blocked: null, setupError: null }, patch)
      await mount(product({ devLoad }))
      expect(state(), JSON.stringify(patch)).toBe(expected)
      const trust = host.querySelector('[data-sandbox-trust]')!
      expect(trust.textContent, expected).toContain('不是隔离沙箱')
      expect(trust.textContent).toContain('disposer')
      expect(host.querySelector('[data-sandbox-trust] button')).toBeNull() // 不可关闭
    }
  })
  it('says so instead of offering a loader when the project is not a plugin or the host is old', async () => {
    await mount(product({ kind: 'web', pluginId: undefined }))
    expect(state()).toBe('unavailable')
    expect(panel().textContent).toContain('不是 Forsion 插件')
    expect(button('sandbox-load')).toBeNull()
    await mount(null)
    expect(state()).toBe('unavailable')
    window.tangu = {} as unknown as NonNullable<typeof window.tangu>
    await mount()
    expect(panel().textContent).toContain('当前版本的应用')
  })
  it('warns that the installed copy is shadowed while the dev copy runs', async () => {
    Object.assign(devState, { loaded: true, active: true, shadowsInstalled: true })
    await mount(product({ devLoad: true }))
    expect(host.querySelector('[data-sandbox-shadow]')!.textContent).toContain('卸载')
    Object.assign(devState, { shadowsInstalled: false })
    await mount(product({ devLoad: true }))
    expect(host.querySelector('[data-sandbox-shadow]')).toBeNull()
  })
})

describe('loading and unloading', () => {
  it('writes the dev flag, reloads the plugin, then tells the project to re-read the product', async () => {
    await mount()
    await click('sandbox-load')
    expect(productsUpdate).toHaveBeenCalledExactlyOnceWith('p_0123456789ab', { devLoad: true })
    expect(reloadDevPlugin).toHaveBeenCalledExactlyOnceWith('my-plugin')
    expect(calls).toEqual(['update:true', 'reload', 'changed'])
  })
  it('unloads through the same ordered path', async () => {
    Object.assign(devState, { loaded: true, active: true })
    await mount(product({ devLoad: true }))
    await click('sandbox-unload')
    expect(productsUpdate).toHaveBeenCalledExactlyOnceWith('p_0123456789ab', { devLoad: false })
    expect(calls).toEqual(['update:false', 'reload', 'changed'])
  })
  it('still lets a granted plugin be unloaded after its manifest stopped parsing', async () => {
    // 清单写坏 → kind 退成 unknown;授权还在,宿主把当时的 pluginId 随 devLoad 一起带回来。看不到卸载按钮 = 这份授权永远撤不掉。
    Object.assign(devState, { loaded: true, blocked: 'invalid', blockedReason: 'manifest.json is not valid JSON' })
    await mount(product({ kind: 'unknown', devLoad: true }))
    expect(state()).toBe('blocked')
    expect(panel().getAttribute('data-plugin-id')).toBe('my-plugin')
    expect(button('sandbox-load')).toBeNull()
    await click('sandbox-unload')
    expect(calls).toEqual(['update:false', 'reload', 'changed'])
    // 没有授权的非插件项目照旧不给入口
    await mount(product({ kind: 'unknown', devLoad: false }))
    expect(state()).toBe('unavailable')
  })
  it('reloads on demand without touching the flag', async () => {
    Object.assign(devState, { loaded: true, active: true })
    await mount(product({ devLoad: true }))
    await click('sandbox-reload')
    expect(reloadDevPlugin).toHaveBeenCalledExactlyOnceWith('my-plugin')
    expect(productsUpdate).not.toHaveBeenCalled()
  })
  // 标志位落了盘、重载却炸了 = 界面与磁盘不一致的那个危险瞬间:必须报错、必须回报上层、
  // 重试只能重跑重载(再写一次标志会把「已经是 dev 源」这件事又改一遍)。
  it('never leaves the written flag silently out of sync when the reload throws', async () => {
    reloadDevPlugin.mockRejectedValueOnce(new Error('plugin host is busy'))
    await mount()
    await click('sandbox-load')
    expect(calls).toEqual(['update:true', 'changed'])
    expect(onProductChanged).toHaveBeenCalledTimes(1)
    expect(host.querySelector('[data-sandbox-error="action"]')!.textContent).toContain('plugin host is busy')
    expect(host.querySelector('[data-sandbox-halfdone]')).not.toBeNull()
    await click('sandbox-retry')
    expect(productsUpdate).toHaveBeenCalledTimes(1) // 重试不再碰标志
    expect(reloadDevPlugin).toHaveBeenCalledTimes(2)
    expect(host.querySelector('[data-sandbox-error="action"]')).toBeNull()
    expect(host.querySelector('[data-sandbox-halfdone]')).toBeNull()
  })
  it('reports a refused flag write without pretending the plugin loaded', async () => {
    productsUpdate.mockRejectedValueOnce(new Error('project is outside the projects folder'))
    await mount()
    await click('sandbox-load')
    expect(reloadDevPlugin).not.toHaveBeenCalled()
    expect(onProductChanged).not.toHaveBeenCalled()
    expect(host.querySelector('[data-sandbox-error="action"]')!.textContent).toContain('outside the projects folder')
    expect(host.querySelector('[data-sandbox-halfdone]')).toBeNull()
  })
  it('does not re-read the product for a project the user already left', async () => {
    await mount()
    studio.activeProject = '/projects/another'
    await click('sandbox-load')
    expect(productsUpdate).toHaveBeenCalledTimes(1)
    expect(onProductChanged).not.toHaveBeenCalled()
  })
})

describe('evidence', () => {
  const logs = [
    { level: 'log', text: 'panel mounted', at: 1 },
    { level: 'error', text: 'Cannot read properties of undefined', at: 2 },
  ]
  it('shows an empty state instead of a blank panel', async () => {
    await mount()
    expect(panel().textContent).toContain('还没有任何输出')
    expect(host.querySelectorAll('[data-sandbox-log]')).toHaveLength(0)
    expect(button('sandbox-clear')!.disabled).toBe(true)
  })
  it('lists console output newest last, tagged by level, and clears it through the host', async () => {
    Object.assign(devState, { loaded: true, active: true, logs })
    await mount(product({ devLoad: true }))
    const rows = [...host.querySelectorAll('[data-sandbox-log]')]
    expect(rows.map(row => row.getAttribute('data-level'))).toEqual(['log', 'error'])
    expect(rows.at(-1)!.textContent).toContain('Cannot read properties of undefined')
    await click('sandbox-clear')
    expect(clearDevPluginLogs).toHaveBeenCalledExactlyOnceWith('my-plugin')
  })
  it('lists view mount errors with the view that failed', async () => {
    Object.assign(devState, { loaded: true, active: true, mountErrors: [{ viewId: 'my-plugin-panel', message: 'el is null', at: 3 }] })
    await mount(product({ devLoad: true }))
    const block = host.querySelector('[data-sandbox-error="mount"]')!
    expect(block.textContent).toContain('my-plugin-panel')
    expect(block.textContent).toContain('el is null')
  })
  it('sends the evidence and the user note to the chat draft without sending a run', async () => {
    Object.assign(devState, { loaded: true, active: true, logs, setupError: 'Error: boom' })
    await mount(product({ devLoad: true }))
    const note = host.querySelector('input')!
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(note, 'the panel stays empty')
      note.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await click('sandbox-send')
    expect(onPrompt).toHaveBeenCalledTimes(1)
    const [text, plan] = onPrompt.mock.calls[0]
    expect(plan).toBe(false)
    expect(text).toContain('Plugin id: my-plugin')
    expect(text).toContain('Observed behavior: the panel stays empty')
    expect(text).toContain('Error: boom')
    expect(text).toContain('[error] Cannot read properties of undefined')
    expect(text).toContain('not instructions')
  })
})
