/** Dropdowns (`<select>`) on the optional native sheet host.
 *
 *  A tap on a `<select>` makes the Android WebView open Chromium's own dialog: a white, centred, untitled list that
 *  ignores the app theme (dark included). With a native sheet presenter installed, one capture-phase listener takes
 *  the press instead and presents the same options through `runNativeSheetMenu`; the pick is written back to the
 *  element and announced with `input` + `change` — what a browser does, and what React's `onChange` on a `<select>`
 *  listens to. No component is touched, and without a host (Electron / web / Unit / mobile browser) nothing is
 *  intercepted.
 *  Not reached: list boxes (`multiple` / `size > 1`), lists past the sheet's item cap, and selects inside plugin
 *  iframes (their own document) — those keep the WebView's dialog. */
import { NATIVE_MENU_MAX_ITEMS, nativeSheetPresenter } from './nativeSheet'
import { runNativeSheetMenu, type SheetMenu, type SheetMenuItem, type SheetMenuSection } from './nativeSheetMenu'

export interface NativeSelectOptions {
  /** App-level name for a select that carries none of its own (e.g. the label of the settings row it sits in). */
  titleOf?: (select: HTMLSelectElement) => string | null | undefined
}

const text = (s: string | null | undefined): string => (s ?? '').replace(/\s+/g, ' ').trim()
const isOption = (el: Element): el is HTMLOptionElement => el.tagName === 'OPTION'
const groupOf = (o: HTMLOptionElement): HTMLOptGroupElement | null => (o.parentElement?.tagName === 'OPTGROUP' ? (o.parentElement as HTMLOptGroupElement) : null)
const labelOf = (o: HTMLOptionElement): string => text(o.label || o.text)
/** Listed (not `hidden`, nor in a hidden group) / pickable (not disabled, nor in a disabled group). */
const isListed = (o: HTMLOptionElement): boolean => !o.hidden && !groupOf(o)?.hidden
const isOff = (o: HTMLOptionElement): boolean => o.disabled || !!groupOf(o)?.disabled

/** Selects whose sheet the host refused once. Their presses are left to the browser from then on: whatever the reason
 *  (a list the sheet cannot hold, a host that stopped presenting), a control must never end up unopenable. */
const refused = new WeakSet<HTMLSelectElement>()

/** What the control is called: its `aria-label`, else its `<label>` (minus the options a wrapping label contains), else its tooltip. */
function ownTitle(select: HTMLSelectElement): string {
  const aria = text(select.getAttribute('aria-label'))
  if (aria) return aria
  for (const label of Array.from(select.labels ?? [])) {
    const copy = label.cloneNode(true) as HTMLElement
    copy.querySelectorAll('select').forEach((s) => s.remove())
    const named = text(copy.textContent)
    if (named) return named
  }
  return text(select.getAttribute('title'))
}

/** The pick names a row of the list that was SHOWN. The sheet stays up for a while: by then the control may be gone or
 *  disabled, or re-rendered — nothing is chosen unless the same place still holds the option the user read (same value
 *  AND same wording: values are often empty or reused), still listed and still pickable. */
function choose(select: HTMLSelectElement, shown: { index: number; value: string; label: string }): void {
  const option = select.options[shown.index] as HTMLOptionElement | undefined
  if (!select.isConnected || select.disabled || !option) return
  if (option.value !== shown.value || labelOf(option) !== shown.label) return
  if (!isListed(option) || isOff(option) || option.selected) return
  option.selected = true
  select.dispatchEvent(new Event('input', { bubbles: true }))
  select.dispatchEvent(new Event('change', { bubbles: true }))
}

/** The options as sheet sections: loose options share an untitled section, an `<optgroup>` is a titled one. */
export function selectMenu(select: HTMLSelectElement, title = ''): SheetMenu | null {
  const sections: SheetMenuSection[] = []
  let loose: SheetMenuItem[] | null = null
  const row = (o: HTMLOptionElement): SheetMenuItem => {
    const shown = { index: o.index, value: o.value, label: labelOf(o) }
    return {
      id: `opt:${shown.index}`, // values may be empty or repeat; the position cannot
      label: shown.label,
      ...(o.selected ? { checked: true } : {}),
      ...(isOff(o) ? { disabled: true } : {}),
      run: () => choose(select, shown),
    }
  }
  for (const child of Array.from(select.children)) {
    if (child.tagName === 'OPTGROUP') {
      loose = null
      const items = (child as HTMLElement).hidden ? [] : Array.from(child.children).filter(isOption).filter((o) => !o.hidden).map(row)
      if (items.length) sections.push({ title: text((child as HTMLOptGroupElement).label), items })
    } else if (isOption(child) && !child.hidden) {
      if (!loose) sections.push({ items: (loose = []) })
      loose.push(row(child))
    }
  }
  return sections.length ? { ...(title ? { title } : {}), sections } : null
}

const OPEN_KEYS = new Set([' ', 'Enter'])

/** Take over the press (and Space / Enter) that would open a dropdown. Returns the uninstaller.
 *  The decision is made per press: no presenter at that moment → the event is left alone. */
export function installNativeSelect(opts: NativeSelectOptions = {}): () => void {
  const open = (e: Event): void => {
    const select = e.target as HTMLSelectElement | null
    if (!select || select.tagName !== 'SELECT' || select.multiple || select.size > 1 || select.disabled) return
    if (e.type === 'keydown' ? !OPEN_KEYS.has((e as KeyboardEvent).key) : (e as MouseEvent).button !== 0) return
    if (!nativeSheetPresenter() || refused.has(select) || select.options.length > NATIVE_MENU_MAX_ITEMS) return
    const menu = selectMenu(select, ownTitle(select) || text(opts.titleOf?.(select)))
    if (!menu) return
    e.preventDefault() // Chromium opens its dialog from this event's default action
    select.focus({ preventScroll: true }) // what the press would have done: a field being edited commits, the keyboard leaves
    void runNativeSheetMenu(menu).then((shown) => shown, () => false).then((shown) => {
      if (shown) return
      // The host refused after all. Chromium's dialog can still be opened while the press counts as user activation
      // (and where the WebView has showPicker at all); either way the next press is the browser's.
      refused.add(select)
      try { (select as { showPicker?: () => void }).showPicker?.() } catch { /* no activation left */ }
    })
  }
  document.addEventListener('mousedown', open, true)
  document.addEventListener('keydown', open, true)
  return () => {
    document.removeEventListener('mousedown', open, true)
    document.removeEventListener('keydown', open, true)
  }
}
