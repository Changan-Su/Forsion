// DOM-backed (icons render through react-dom): happy-dom wired by hand, same as nativeSheet.test.ts.
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { createElement } from 'react'
import { MessagesSquare, Pencil } from 'lucide-react'
import { Window } from 'happy-dom'
import type { NativeSheetPayload } from './nativeSheet'
import type { SheetMenu } from './nativeSheetMenu'

type SheetMod = typeof import('./nativeSheet')
type MenuMod = typeof import('./nativeSheetMenu')
type IconMod = typeof import('./nativeIcon')
let m: SheetMod
let menu: MenuMod
let ic: IconMod
beforeAll(async () => {
  const win = new Window({ url: 'https://localhost/' })
  const g = globalThis as Record<string, unknown>
  for (const key of Object.getOwnPropertyNames(win)) {
    if (key in g) continue
    try { g[key] = (win as unknown as Record<string, unknown>)[key] } catch { /* accessor-only */ }
  }
  g.window = win
  g.document = win.document
  g.getComputedStyle = win.getComputedStyle.bind(win)
  m = await import('./nativeSheet')
  menu = await import('./nativeSheetMenu')
  ic = await import('./nativeIcon')
})

let uninstall: (() => void) | undefined
afterEach(() => { uninstall?.(); uninstall = undefined })

const build = (ran: string[]): SheetMenu => ({
  title: 'Mode',
  back: 'Back',
  sections: [
    { items: [
      { id: 'normal', label: 'Normal', checked: true, run: () => ran.push('normal') },
      { id: 'agents', label: 'Agent', detail: 'Xyra', search: { placeholder: 'Find', empty: 'None' }, children: [
        { title: 'Agents', items: [{ id: 'agent:a', label: 'A', run: () => ran.push('agent:a') }] },
      ] },
    ] },
    { title: 'Approval', items: [
      { id: 'approval:readonly', label: 'Read only', detail: 'Asks first', act: 'web-only', run: () => ran.push('readonly') },
      { id: 'approval:full-auto', label: 'Full access', danger: true, run: () => ran.push('full-auto') },
      { id: 'info', label: 'Informational' },
    ] },
    { title: 'Empty', items: [] },
  ],
})

describe('callback sheet menus', () => {
  it('without a host: gate returns false synchronously and never builds', () => {
    const b = vi.fn(() => build([]))
    expect(menu.openNativeSheetMenu(b)).toBe(false)
    expect(b).not.toHaveBeenCalled()
  })
  it('serializes once (no run / act / empty sections); informational rows are disabled; runs the pick after onClose', async () => {
    let payload: NativeSheetPayload | undefined
    uninstall = m.installNativeSheetPresenter(async (p) => { payload = p; return { id: 'approval:full-auto' } })
    const order: string[] = []
    const ran: string[] = []
    const done = vi.fn()
    expect(await menu.runNativeSheetMenu(build(ran), { onClose: () => order.push('close') })).toBe(true)
    done()
    expect(ran).toEqual(['full-auto'])
    expect(order).toEqual(['close'])
    const json = JSON.stringify(payload)
    expect(json).not.toContain('web-only')
    expect(json).not.toContain('"run"')
    if (payload?.kind !== 'menu') throw new Error('menu expected')
    expect(payload.sections.map((s) => s.title ?? '')).toEqual(['', 'Approval'])
    const agents = payload.sections[0].items[1]
    expect(agents.search).toEqual({ placeholder: 'Find', empty: 'None' })
    expect(agents.children?.[0].items[0].id).toBe('agent:a')
    expect(payload.sections[1].items[2].disabled).toBe(true)
    expect(payload.sections[1].items[1].danger).toBe(true)
  })
  it('nested pick runs the nested item; cancel runs nothing but still closes; parent / disabled ids are cancels', async () => {
    const ran: string[] = []
    uninstall = m.installNativeSheetPresenter(async () => ({ id: 'agent:a' }))
    await menu.runNativeSheetMenu(build(ran))
    uninstall()
    const closed = vi.fn()
    for (const answer of [null, { id: 'agents' }, { id: 'info' }, { id: 'approval:readonly', trailing: true }]) {
      uninstall = m.installNativeSheetPresenter(async () => answer)
      expect(await menu.runNativeSheetMenu(build(ran), { onClose: closed })).toBe(true)
      uninstall()
    }
    uninstall = undefined
    expect(ran).toEqual(['agent:a'])
    expect(closed).toHaveBeenCalledTimes(4)
  })
  it('a failing host falls back to the web menu', async () => {
    uninstall = m.installNativeSheetPresenter(async () => { throw new Error('plugin missing') })
    const fallback = vi.fn()
    expect(menu.openNativeSheetMenu(() => build([]), { onFallback: fallback })).toBe(true)
    await vi.waitFor(() => expect(fallback).toHaveBeenCalledTimes(1))
  })
  it('an empty menu is not presented', () => {
    uninstall = m.installNativeSheetPresenter(async () => null)
    expect(menu.openNativeSheetMenu(() => ({ sections: [{ items: [] }] }))).toBe(false)
    expect(menu.openNativeSheetMenu(() => null)).toBe(false)
  })
  it('clips text to the native caps without splitting surrogate pairs; ids stay exact', async () => {
    let payload: NativeSheetPayload | undefined
    uninstall = m.installNativeSheetPresenter(async (p) => { payload = p; return null })
    const long = 'x'.repeat(254) + '😀' + 'tail'
    await menu.runNativeSheetMenu({ sections: [{ items: [{ id: 'session:1', label: long, detail: 'd'.repeat(5000), run: () => {} }] }] })
    if (payload?.kind !== 'menu') throw new Error('menu expected')
    const item = payload.sections[0].items[0]
    expect(item.id).toBe('session:1')
    expect(item.label.length).toBeLessThanOrEqual(256)
    expect(item.label.endsWith('…')).toBe(true)
    expect(/[\uD800-\uDBFF]…$/.test(item.label)).toBe(false)
    expect(item.detail!.length).toBe(1024)
    expect(m.clipNativeText('abc', 3)).toBe('abc')
  })
  it('more items than the native cap ⇒ web fallback (not a native rejection)', async () => {
    const spy = vi.fn(async () => null)
    uninstall = m.installNativeSheetPresenter(spy)
    const items = Array.from({ length: m.NATIVE_MENU_MAX_ITEMS + 1 }, (_, i) => ({ id: `s${i}`, label: 'x', run: () => {} }))
    expect(await menu.runNativeSheetMenu({ sections: [{ items }] })).toBe(false)
    expect(spy).not.toHaveBeenCalled()
  })
})

describe('useNativeSheetMenu (state-driven menus)', () => {
  type Rendered = { web: boolean }
  async function mount(): Promise<{
    seen: Rendered[]
    setOpen: (v: object | null) => Promise<void>
    closed: ReturnType<typeof vi.fn>
    ran: string[]
    unmount: () => Promise<void>
  }> {
    const React = await import('react')
    const { createRoot } = await import('react-dom/client')
    ;(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true
    const seen: Rendered[] = []
    const ran: string[] = []
    const closed = vi.fn()
    let setter: (v: object | null) => void = () => {}
    function Probe(): null {
      const [open, setOpenState] = React.useState<object | null>(null)
      setter = setOpenState
      const web = menu.useNativeSheetMenu(open, () => build(ran), () => { closed(); setOpenState(null) })
      if (open) seen.push({ web })
      return null
    }
    const host = document.createElement('div')
    const root = createRoot(host)
    await React.act(async () => { root.render(createElement(Probe)) })
    return {
      seen, closed, ran,
      setOpen: async (v) => { await React.act(async () => { setter(v); await new Promise((r) => setTimeout(r, 0)) }) },
      unmount: async () => { await React.act(async () => root.unmount()); (globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = false },
    }
  }
  it('no host ⇒ the web menu renders', async () => {
    const t = await mount()
    await t.setOpen({})
    expect(t.seen.every((s) => s.web)).toBe(true)
    await t.unmount()
  })
  it('host ⇒ never renders web, presents once per opening, closes and runs the pick', async () => {
    const present = vi.fn(async () => ({ id: 'approval:readonly' }))
    uninstall = m.installNativeSheetPresenter(present)
    const t = await mount()
    await t.setOpen({})
    await vi.waitFor(() => expect(t.closed).toHaveBeenCalledTimes(1))
    expect(t.seen.length).toBeGreaterThan(0)
    expect(t.seen.every((s) => !s.web)).toBe(true)
    expect(t.ran).toEqual(['readonly'])
    expect(present).toHaveBeenCalledTimes(1)
    await t.unmount()
  })
  it('host failure ⇒ that opening falls back to web; the next opening tries native again', async () => {
    const present = vi.fn(async () => { throw new Error('no plugin') })
    uninstall = m.installNativeSheetPresenter(present)
    const t = await mount()
    await t.setOpen({})
    await vi.waitFor(() => expect(t.seen.at(-1)?.web).toBe(true))
    expect(t.closed).not.toHaveBeenCalled()
    await t.setOpen(null)
    t.seen.length = 0
    await t.setOpen({})
    expect(t.seen[0]?.web).toBe(false)
    await vi.waitFor(() => expect(present).toHaveBeenCalledTimes(2))
    await t.unmount()
  })
  it('closing the menu from outside dismisses the native sheet', async () => {
    let signal: AbortSignal | undefined
    uninstall = m.installNativeSheetPresenter((_p, s) => { signal = s; return new Promise((r) => s.addEventListener('abort', () => r(null))) })
    const t = await mount()
    await t.setOpen({})
    await vi.waitFor(() => expect(signal).toBeDefined())
    await t.setOpen(null)
    expect(signal?.aborted).toBe(true)
    expect(t.ran).toEqual([])
    await t.unmount()
  })
})

describe('icon dedupe', () => {
  it('renders repeated icons once and copies the result', async () => {
    const out = await ic.renderNativeIcons([
      MessagesSquare, MessagesSquare, createElement(Pencil, { size: 13 }), createElement(Pencil, { size: 13 }), createElement(Pencil, { size: 14 }),
    ])
    expect(out[0]?.kind).toBe('vector')
    expect(out[1]).toBe(out[0])
    expect(out[3]).toBe(out[2])
    expect(out[4]).toEqual(out[2]) // different props → rendered separately, same drawing
    expect(out[4]).not.toBe(out[2])
  })
})
