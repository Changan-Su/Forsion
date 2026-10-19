// @vitest-environment happy-dom
/**
 * 现场圈注(2026-10-19,使用指南「带我去」):
 *  · 只给首方内置包 —— 别的插件调了恒 'missing',不画;
 *  · 锚点在 → 画圈 + 卡,「知道了」→ 'ok'、「不再提示」→ 'mute';目标消失 → 'gone';不认识的锚点 → 'missing';
 *  · 新一次顶掉旧的('replaced'),传 null 收起('closed'),插件停用时宿主收掉。
 * 负对照:删掉 ctx.app.spotlight 里的 locked 判断 → 第一条红;tick 里不判 lostAt → 'gone' 那条超时。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ExternalPluginSource } from '@amadeus-shared/ipc'

const env = vi.hoisted(() => ({ sources: [] as ExternalPluginSource[] }))
vi.mock('../api', () => ({
  amadeus: { listPlugins: async () => env.sources, listPages: async () => [], listFiles: async () => [] },
}))
const { usePluginStore } = await import('./pluginStore')
const { showSpotlight, closeSpotlight } = await import('./guideSpotlight')

const src = (over: Partial<ExternalPluginSource> & { id: string }): ExternalPluginSource => ({ name: over.id, version: '0.0.1', apiVersion: 1, code: '', ...over })
const anchor = (name: string): HTMLElement => {
  const el = document.createElement('button')
  el.dataset.guideAnchor = name
  el.getBoundingClientRect = () => ({ x: 50, y: 70, left: 50, top: 70, width: 260, height: 30, right: 310, bottom: 100, toJSON: () => ({}) }) as DOMRect
  document.body.appendChild(el)
  return el
}
const until = async (f: () => unknown): Promise<void> => { for (let i = 0; i < 100 && !f(); i++) await new Promise((r) => setTimeout(r, 20)) }

beforeEach(() => {
  closeSpotlight()
  document.body.innerHTML = ''
  usePluginStore.setState({ plugins: [], activeIds: [], disabledIds: [], disposers: {}, lastSetupError: {}, initialized: false })
  env.sources = []
})

describe('现场圈注', () => {
  it('只给首方内置包:普通插件恒 missing、不画', async () => {
    anchor('note-new')
    env.sources = [
      src({ id: 'forsion-extend', preinstalled: true, locked: true, bundleOff: false, code: "window.__ext = ctx.app.spotlight({ anchor: 'note-new', title: 'T' })" }),
      src({ id: 'third', code: "window.__third = ctx.app.spotlight({ anchor: 'note-new', title: 'T' })" }),
    ]
    await usePluginStore.getState().loadExternal()
    const w = window as unknown as { __ext: Promise<string>; __third: Promise<string> }
    expect(await w.__third).toBe('missing')
    await until(() => document.querySelector('.guide-spot-card'))
    expect(document.querySelector('.guide-spot-title')?.textContent).toBe('T')
    ;(document.querySelector('.guide-spot-card .btn') as HTMLElement).click()
    expect(await w.__ext).toBe('ok')
    expect(document.querySelector('.guide-spot-ring')).toBeNull()
  })

  it('手机上不挂 spotlight(没有锚点,插件直接走老做法)', async () => {
    const w = window as unknown as { tangu?: unknown; __has?: string }
    w.tangu = { mobile: true }
    try {
      env.sources = [src({ id: 'forsion-extend', preinstalled: true, locked: true, bundleOff: false, code: 'window.__has = typeof ctx.app.spotlight' })]
      await usePluginStore.getState().loadExternal()
      expect(w.__has).toBe('undefined')
    } finally { delete w.tangu }
  })

  it('不再提示 → mute;目标消失 → gone;不认识的锚点 → missing', async () => {
    anchor('note-canvas')
    const p = showSpotlight('x', { anchor: 'note-canvas', title: 'a', step: '第 3 步' })
    await until(() => document.querySelector('.guide-spot-mute'))
    ;(document.querySelector('.guide-spot-mute') as HTMLElement).click()
    expect(await p).toBe('mute')

    const el = anchor('note-body')
    const q = showSpotlight('x', { anchor: 'note-body', title: 'b' })
    await until(() => document.querySelector('.guide-spot-ring'))
    el.remove()
    expect(await q).toBe('gone')

    expect(await showSpotlight('x', { anchor: 'no-such', title: 'c' })).toBe('missing')
  })

  it('目标滚出了可视区:先滚进来,卡不落到屏幕外(Codex 评审)', async () => {
    const el = anchor('note-new')
    el.getBoundingClientRect = () => ({ x: 50, y: -600, left: 50, top: -600, width: 260, height: 30, right: 310, bottom: -570, toJSON: () => ({}) }) as DOMRect
    const spy = vi.fn()
    el.scrollIntoView = spy
    void showSpotlight('x', { anchor: 'note-new', title: 't' })
    await until(() => document.querySelector('.guide-spot-card'))
    expect(spy).toHaveBeenCalledWith({ block: 'nearest', inline: 'nearest' })
    expect(parseFloat((document.querySelector('.guide-spot-card') as HTMLElement).style.top)).toBeGreaterThanOrEqual(8)
    closeSpotlight()
  })

  it('新一次顶掉旧的;按插件收起', async () => {
    anchor('note-new'); anchor('chat-composer')
    const first = showSpotlight('a', { anchor: 'note-new', title: '1' })
    await until(() => document.querySelector('.guide-spot-ring'))
    const second = showSpotlight('a', { anchor: 'chat-composer', title: '2' })
    expect(await first).toBe('replaced')
    await until(() => document.querySelector('.guide-spot-ring'))
    closeSpotlight('b') // 别人的不收
    expect(document.querySelectorAll('.guide-spot-ring').length).toBe(1)
    closeSpotlight('a')
    expect(await second).toBe('closed')
    expect(document.querySelector('.guide-spot-card')).toBeNull()
  })
})
