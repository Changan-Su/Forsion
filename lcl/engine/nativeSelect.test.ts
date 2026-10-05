// DOM-backed: happy-dom wired by hand, same as nativeSheetMenu.test.ts.
import { afterEach, beforeAll, describe, expect, it } from 'vitest'
import { Window } from 'happy-dom'
import type { NativeSheetPayload } from './nativeSheet'

type SheetMod = typeof import('./nativeSheet')
type SelectMod = typeof import('./nativeSelect')
let m: SheetMod
let sel: SelectMod
let win: Window
beforeAll(async () => {
  win = new Window({ url: 'https://localhost/' })
  const g = globalThis as Record<string, unknown>
  for (const key of Object.getOwnPropertyNames(win)) {
    if (key in g) continue
    try { g[key] = (win as unknown as Record<string, unknown>)[key] } catch { /* accessor-only */ }
  }
  g.window = win
  g.document = win.document
  g.getComputedStyle = win.getComputedStyle.bind(win)
  // Node has an `Event` of its own, so the loop above kept it — and happy-dom does not bubble a foreign event.
  g.Event = win.Event
  m = await import('./nativeSheet')
  sel = await import('./nativeSelect')
})

const cleanup: Array<() => void> = []
afterEach(() => { cleanup.splice(0).forEach((fn) => fn()); document.body.innerHTML = '' })

const HTML = `
  <select id="s" aria-label="Startup">
    <option value="a">Alpha</option>
    <option value="b" selected>Beta</option>
    <option value="h" hidden>Hidden</option>
    <optgroup label="Spaces">
      <option value="c">Gamma</option>
      <option value="d" disabled>Delta</option>
    </optgroup>
    <optgroup label="Off" disabled><option value="e">Epsilon</option></optgroup>
  </select>`
function mount(html = HTML): { select: HTMLSelectElement; events: string[] } {
  document.body.innerHTML = html
  const select = document.querySelector('select') as HTMLSelectElement
  const events: string[] = []
  for (const type of ['input', 'change']) document.body.addEventListener(type, () => events.push(`${type}:${select.value}`))
  return { select, events }
}
/** Present with a host that answers `answer` (null = the user cancelled); resolves once the answer was applied. */
function host(answer: (payload: NativeSheetPayload) => unknown): { payloads: NativeSheetPayload[]; settled: () => Promise<void> } {
  const payloads: NativeSheetPayload[] = []
  let done: Promise<unknown> = Promise.resolve()
  cleanup.push(m.installNativeSheetPresenter((payload) => {
    payloads.push(payload)
    return (done = Promise.resolve().then(() => answer(payload)))
  }))
  // serializeMenu awaits before it reaches the presenter: let both sides of the round trip run out.
  return { payloads, settled: async () => { for (let i = 0; i < 20; i++) { await new Promise((r) => setTimeout(r, 0)); await done } } }
}
const press = (el: Element, type = 'mousedown', init: Record<string, unknown> = { button: 0 }): Event => {
  const Ctor = (type === 'keydown' ? win.KeyboardEvent : win.MouseEvent) as unknown as new (t: string, i: object) => Event
  const ev = new Ctor(type, { bubbles: true, cancelable: true, ...init })
  el.dispatchEvent(ev)
  return ev
}

describe('dropdowns on the native sheet', () => {
  it('without a host the press is left alone (the WebView opens its own dialog)', () => {
    cleanup.push(sel.installNativeSelect())
    const { select } = mount()
    expect(press(select).defaultPrevented).toBe(false)
  })

  it('a press presents the options (groups as sections, current one checked) and the pick changes the control once', async () => {
    cleanup.push(sel.installNativeSelect())
    const { select, events } = mount()
    const h = host(() => ({ id: 'opt:3' }))
    expect(press(select).defaultPrevented).toBe(true)
    await h.settled()
    const sent = h.payloads[0]
    if (sent?.kind !== 'menu') throw new Error('menu expected')
    expect(sent.title).toBe('Startup')
    expect(sent.sections.map((s) => [s.title ?? '', s.items.map((i) => `${i.id}=${i.label}${i.checked ? '✓' : ''}${i.disabled ? '×' : ''}`)])).toEqual([
      ['', ['opt:0=Alpha', 'opt:1=Beta✓']],
      ['Spaces', ['opt:3=Gamma', 'opt:4=Delta×']],
      ['Off', ['opt:5=Epsilon×']],
    ])
    expect(select.value).toBe('c')
    expect(events).toEqual(['input:c', 'change:c'])
  })

  it('cancel, the current option, a disabled option and an answer outside the list change nothing', async () => {
    cleanup.push(sel.installNativeSelect())
    for (const answer of [null, { id: 'opt:1' }, { id: 'opt:4' }, { id: 'opt:5' }, { id: 'opt:2' }, { id: 'opt:99' }]) {
      const { select, events } = mount()
      const h = host(() => answer)
      expect(press(select).defaultPrevented).toBe(true)
      await h.settled()
      expect([select.value, events]).toEqual(['b', []])
      cleanup.splice(0).forEach((fn) => fn())
      cleanup.push(sel.installNativeSelect())
    }
  })

  it('the pick is dropped when the control left the page, was disabled, or shows other options by then', async () => {
    cleanup.push(sel.installNativeSelect())
    const changes: Array<(s: HTMLSelectElement) => void> = [
      (s) => s.remove(),
      (s) => { s.disabled = true },
      (s) => { s.options[0].value = 'z' }, // same position, another option
      (s) => { s.options[0].textContent = 'Replacement' }, // same position and value, but not what the user read
      (s) => { s.options[0].hidden = true },
      (s) => { s.options[0].disabled = true },
    ]
    for (const change of changes) {
      const { select, events } = mount()
      const h = host(() => { change(select); return { id: 'opt:0' } })
      press(select)
      await h.settled()
      expect([select.value === 'a', events]).toEqual([false, []])
      cleanup.splice(0).forEach((fn) => fn())
      cleanup.push(sel.installNativeSelect())
    }
  })

  it('Space / Enter open it too; other keys, other buttons, list boxes and disabled controls are left alone', async () => {
    cleanup.push(sel.installNativeSelect())
    const h = host(() => null)
    const { select } = mount()
    expect(press(select, 'keydown', { key: ' ' }).defaultPrevented).toBe(true)
    expect(press(select, 'keydown', { key: 'Enter' }).defaultPrevented).toBe(true)
    expect(press(select, 'keydown', { key: 'ArrowDown' }).defaultPrevented).toBe(false)
    expect(press(select, 'mousedown', { button: 2 }).defaultPrevented).toBe(false)
    select.multiple = true
    expect(press(select).defaultPrevented).toBe(false)
    select.multiple = false
    select.disabled = true
    expect(press(select).defaultPrevented).toBe(false)
    expect(press(document.body).defaultPrevented).toBe(false)
    await h.settled()
    expect(h.payloads).toHaveLength(2)
  })

  it('names the sheet after a wrapping label (without the option texts), else after what the app says', async () => {
    cleanup.push(sel.installNativeSelect({ titleOf: (s) => s.closest('.row')?.querySelector('strong')?.textContent }))
    const h = host(() => null)
    press(mount('<label>Language <select><option>English</option><option>中文</option></select></label>').select)
    await h.settled()
    press(mount('<div class="row"><strong> Open on </strong><span><select><option>Home</option></select></span></div>').select)
    await h.settled()
    press(mount('<select><option>Bare</option></select>').select)
    await h.settled()
    expect(h.payloads.map((p) => (p.kind === 'menu' ? p.title ?? '' : '?'))).toEqual(['Language', 'Open on', ''])
  })

  it('a host that refuses falls back to the browser picker', async () => {
    cleanup.push(sel.installNativeSelect())
    cleanup.push(m.installNativeSheetPresenter(() => Promise.reject(new Error('cannot present'))))
    const { select, events } = mount()
    let reopened = 0
    ;(select as unknown as { showPicker: () => void }).showPicker = () => { reopened++ }
    expect(press(select).defaultPrevented).toBe(true)
    for (let i = 0; i < 20; i++) await new Promise((r) => setTimeout(r, 0))
    expect([reopened, select.value, events]).toEqual([1, 'b', []])
    // … and that control is the browser's from then on (it must never end up unopenable), others are not affected
    expect(press(select).defaultPrevented).toBe(false)
    const other = document.createElement('select')
    other.innerHTML = '<option>One</option>'
    document.body.appendChild(other)
    expect(press(other).defaultPrevented).toBe(true)
  })
})
