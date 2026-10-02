// DOM-backed: happy-dom is wired by hand. A per-file environment docblock switches vitest to web transform
// mode, which refuses to load test files outside desktop/ (this one lives in lcl/).
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { createElement } from 'react'
import { Trash2, PanelLeft } from 'lucide-react'
import { Window } from 'happy-dom'
import type { NativeMenuSection, NativeSheetPayload } from './nativeSheet'

type SheetMod = typeof import('./nativeSheet')
type IconMod = typeof import('./nativeIcon')
let m: SheetMod
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
  // react-dom decides "can use DOM" at module init → import the modules under test only now.
  m = await import('./nativeSheet')
  ic = await import('./nativeIcon')
})

const sections: NativeMenuSection<string>[] = [
  { items: [
    { id: 'a', label: 'A', trailing: { id: 'close', label: 'Close' } },
    { id: 'b', label: 'B', disabled: true },
    { id: 'group', label: 'Group', children: [{ items: [{ id: 'nested', label: 'Nested' }] }] },
  ] },
]

let uninstall: (() => void) | undefined
afterEach(() => { uninstall?.(); uninstall = undefined; document.documentElement.removeAttribute('data-mode'); document.documentElement.removeAttribute('style') })

describe('native sheet result validation', () => {
  it('accepts only enabled, selectable ids of this request', () => {
    expect(m.menuResult({ sections }, { id: 'a' })).toEqual({ id: 'a' })
    expect(m.menuResult({ sections }, { id: 'nested' })).toEqual({ id: 'nested' })
    expect(m.menuResult({ sections }, { id: 'a', trailing: true })).toEqual({ id: 'a', trailing: true })
    for (const bad of [null, [], {}, { id: 'zzz' }, { id: 'b' }, { id: 'group' }, { id: 'nested', trailing: true }, { id: 'a', extra: 1 }, { id: 1 }, { id: 'a', trailing: 'yes' }]) {
      expect(m.menuResult({ sections }, bad)).toBeNull()
    }
  })
  it('prompt and confirm answers are exact shapes', () => {
    expect(m.promptResult({ text: 'x' })).toEqual({ text: 'x' })
    expect(m.promptResult({ text: 'x', more: 1 })).toBeNull()
    expect(m.promptResult({ text: 3 })).toBeNull()
    expect(m.confirmResult({ ok: true })).toEqual({ ok: true })
    expect(m.confirmResult({ ok: 'true' })).toBeNull()
    expect(m.confirmResult({ ok: true, x: 1 })).toBeNull()
  })
})

describe('presenter slot', () => {
  it('no host ⇒ not handled (callers render web UI)', async () => {
    expect(m.nativeSheetPresenter()).toBeUndefined()
    expect(await m.presentNativeMenu({ sections })).toEqual({ handled: false })
    expect(await m.presentNativePrompt({ title: 't', confirm: 'OK', cancel: 'Cancel' })).toEqual({ handled: false })
    expect(await m.runNativeCtxMenu([{ label: 'x', run: () => {} }])).toBe(false)
  })
  it('old cleanup cannot unregister a replacement', () => {
    const first = m.installNativeSheetPresenter(async () => null)
    const next = async (): Promise<unknown> => null
    const second = m.installNativeSheetPresenter(next)
    first(); expect(m.nativeSheetPresenter()).toBe(next)
    second(); expect(m.nativeSheetPresenter()).toBeUndefined()
  })
  it('presenter rejection ⇒ not handled; null ⇒ cancelled; unknown id ⇒ cancelled', async () => {
    uninstall = m.installNativeSheetPresenter(async () => { throw new Error('plugin missing') })
    expect(await m.presentNativeMenu({ sections })).toEqual({ handled: false })
    uninstall()
    uninstall = m.installNativeSheetPresenter(async () => null)
    expect(await m.presentNativeMenu({ sections })).toEqual({ handled: true, value: null })
    uninstall()
    uninstall = m.installNativeSheetPresenter(async () => ({ id: 'injected' }))
    expect(await m.presentNativeMenu({ sections })).toEqual({ handled: true, value: null })
  })
  it('duplicate ids fall back to web instead of guessing', async () => {
    const spy = vi.fn(async () => ({ id: 'x' }))
    uninstall = m.installNativeSheetPresenter(spy)
    const dup = [{ items: [{ id: 'x', label: 'X' }] }, { items: [{ id: 'x', label: 'Y' }] }]
    expect(await m.presentNativeMenu({ sections: dup })).toEqual({ handled: false })
    expect(spy).not.toHaveBeenCalled()
  })
  it('payload is JSON with serialized icons, theme and labels; abort cancels', async () => {
    let seen: NativeSheetPayload | undefined
    let signal: AbortSignal | undefined
    uninstall = m.installNativeSheetPresenter((payload, s) => { seen = payload; signal = s; return new Promise((r) => s.addEventListener('abort', () => r(null))) })
    const ctl = new AbortController()
    const pending = m.presentNativeMenu({ title: 'Tabs', sections: [{ items: [{ id: 't', label: 'T', icon: PanelLeft, checked: true }, { id: 'e', label: 'Emoji', icon: '📝' }] }] }, ctl.signal)
    await vi.waitFor(() => expect(seen).toBeDefined())
    expect(JSON.parse(JSON.stringify(seen))).toEqual(seen)
    expect(seen!.kind).toBe('menu')
    const items = seen!.kind === 'menu' ? seen!.sections[0].items : []
    expect(items[0].icon?.kind).toBe('vector')
    expect(items[0].checked).toBe(true)
    expect(items[1].icon).toEqual({ kind: 'text', text: '📝' })
    expect(seen!.theme.background).toMatch(/^#[0-9A-F]{8}$/)
    ctl.abort()
    expect(signal?.aborted).toBe(true)
    expect(await pending).toEqual({ handled: true, value: null })
  })
  it('prompt / confirm round trip', async () => {
    uninstall = m.installNativeSheetPresenter(async (p) => (p.kind === 'prompt' ? { text: 'Folder' } : { ok: true }))
    expect(await m.presentNativePrompt({ title: 'New folder', initial: 'x', confirm: 'OK', cancel: 'Cancel' })).toEqual({ handled: true, value: { text: 'Folder' } })
    expect(await m.presentNativeConfirm({ title: 'Delete?', confirm: 'Delete', cancel: 'Cancel', danger: true })).toEqual({ handled: true, value: { ok: true } })
  })
})

describe('callback menus (ContextMenu item shape)', () => {
  it('splits sections at separators and runs the picked item', async () => {
    let payload: NativeSheetPayload | undefined
    uninstall = m.installNativeSheetPresenter(async (p) => { payload = p; return { id: '2' } })
    const ran: string[] = []
    const items = [
      { label: 'Open', run: () => ran.push('open') },
      { label: 'Rename', run: () => ran.push('rename'), icon: createElement(Trash2, { size: 14 }) },
      { label: 'Delete', danger: true, separatorBefore: true, run: () => ran.push('delete') },
      { label: 'Off', disabled: true, run: () => ran.push('off') },
    ]
    expect(await m.runNativeCtxMenu(items)).toBe(true)
    expect(ran).toEqual(['delete'])
    expect(payload?.kind === 'menu' && payload.sections.map((s) => s.items.map((i) => i.id))).toEqual([['0', '1'], ['2', '3']])
    expect(payload?.kind === 'menu' && payload.sections[1].items[0].danger).toBe(true)
    expect(payload?.kind === 'menu' && payload.sections[0].items[1].icon?.kind).toBe('vector')
  })
  it('a disabled pick is a cancel', async () => {
    uninstall = m.installNativeSheetPresenter(async () => ({ id: '0' }))
    const out = await m.pickNativeCtxItem([{ label: 'Off', disabled: true, run: () => {} }])
    expect(out).toEqual({ handled: true, value: null })
  })
})

describe('icons', () => {
  it('flattens svg primitives into path data', () => {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
    svg.setAttribute('viewBox', '0 0 24 24'); svg.setAttribute('fill', 'none'); svg.setAttribute('stroke', 'currentColor'); svg.setAttribute('stroke-width', '2')
    svg.innerHTML = '<rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="12" cy="12" r="1" fill="currentColor"/><line x1="9" y1="3" x2="9" y2="21"/><polyline points="1 2 3 4"/><defs><path d="M0 0"/></defs>'
    const icon = ic.serializeSvg(svg)
    expect(icon?.kind).toBe('vector')
    if (icon?.kind !== 'vector') return
    expect(icon.viewBox).toEqual([0, 0, 24, 24])
    expect(icon.strokeWidth).toBe(2)
    expect(icon.paths).toHaveLength(4)
    expect(icon.paths[0].d).toMatch(/^M5 3H19A2 2 0 0 1 21 5/)
    expect(icon.paths[1]).toMatchObject({ fill: true, stroke: true })
    expect(icon.paths[2]).toEqual({ d: 'M9 3L9 21', fill: false, stroke: true })
    expect(ic.primitiveToPath(svg.querySelector('polyline')!)).toBe('M1 2L3 4')
  })
  it('renders hook-free and hook components alike; bad icons do not break the batch', async () => {
    const Throws = (): never => { throw new Error('boom') }
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    const out = await ic.renderNativeIcons([PanelLeft, createElement('span', null, '🎯'), Throws, undefined, '⭐'])
    err.mockRestore()
    expect(out[0]?.kind).toBe('vector')
    expect(out[1]).toEqual({ kind: 'text', text: '🎯' })
    expect(out[2]).toBeUndefined()
    expect(out[3]).toBeUndefined()
    expect(out[4]).toEqual({ kind: 'text', text: '⭐' })
  })
})

describe('theme', () => {
  it('parses computed colour syntaxes and emits ARGB hex', () => {
    expect(m.parseCssColor('rgb(1, 2, 3)')).toEqual([1, 2, 3, 1])
    expect(m.parseCssColor('rgba(10, 20, 30, 0.5)')).toEqual([10, 20, 30, 0.5])
    expect(m.parseCssColor('#336699')).toEqual([51, 102, 153, 1])
    expect(m.toArgbHex([51, 102, 153, 1])).toBe('#FF336699')
    expect(m.toArgbHex([0, 0, 0, 0.5])).toBe('#80000000')
  })
  it('follows data-mode and keeps opaque containers', () => {
    document.documentElement.dataset.mode = 'dark'
    const dark = m.readNativeTheme()
    expect(dark.dark).toBe(true)
    expect(dark.surface.slice(1, 3)).toBe('FF')
    expect(dark.background.slice(1, 3)).toBe('FF')
    document.documentElement.dataset.mode = 'light'
    document.documentElement.style.setProperty('--bg', '#123456')
    const light = m.readNativeTheme()
    expect(light.dark).toBe(false)
    expect(light.background).toBe('#FF123456')
  })
})
