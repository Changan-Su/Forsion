/** DOM presenter for the mobile sheet contract. Native and browser callers share the same requests,
 * validated results and callbacks; browser dialogs provide focus containment and Escape handling. */
import { useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react'
import { ArrowLeft, Check, ChevronRight, X } from 'lucide-react'
import { installNativeSelect, installNativeSheetPresenter, type NativeIcon, type NativeMenuSection, type NativeSheetPayload } from '@lcl/engine'
import { useI18n } from '@/i18n'

interface Pending { payload: NativeSheetPayload; finish(value: unknown): void }
let pending: Pending | null = null
const listeners = new Set<() => void>()
const subscribe = (fn: () => void): (() => void) => { listeners.add(fn); return () => { listeners.delete(fn) } }
export const subscribeBrowserSheet = subscribe
const publish = (): void => { listeners.forEach((fn) => fn()) }

export function installBrowserSheet(): void {
  installNativeSheetPresenter((payload, signal) => new Promise((resolve) => {
    if (signal.aborted) { resolve(null); return }
    pending?.finish(null)
    const abort = (): void => request.finish(null)
    const request: Pending = { payload, finish(value) {
      signal.removeEventListener('abort', abort)
      if (pending === request) { pending = null; publish() }
      resolve(value)
    } }
    pending = request
    signal.addEventListener('abort', abort, { once: true })
    publish()
  }))
  installNativeSelect({ titleOf: (select) => select.closest('.settings-setting-row')?.querySelector('.settings-control-copy strong')?.textContent })
}

function SheetIcon({ icon }: { icon?: NativeIcon }) {
  if (!icon) return <span className="bmc-sheet-icon" />
  if (icon.kind === 'text') return <span className="bmc-sheet-icon" aria-hidden="true">{icon.text}</span>
  return <svg className="bmc-sheet-icon" viewBox={icon.viewBox.join(' ')} strokeWidth={icon.strokeWidth} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    {icon.paths.map((p, i) => <path key={i} d={p.d} fill={p.fill ? 'currentColor' : 'none'} stroke={p.stroke ? 'currentColor' : 'none'} />)}
  </svg>
}

interface MenuPage { title?: string; sections: NativeMenuSection<NativeIcon>[]; search?: { placeholder: string; empty: string } }
function SheetDialog({ request }: { request: Pending }) {
  const { t } = useI18n()
  const { payload } = request
  const dialog = useRef<HTMLDialogElement>(null)
  const input = useRef<HTMLInputElement>(null)
  const [pages, setPages] = useState<MenuPage[]>(payload.kind === 'menu' ? [payload] : [])
  const [query, setQuery] = useState('')
  const [checked, setChecked] = useState(payload.kind === 'checklist' ? payload.checked : [])
  const checkedRef = useRef(checked)
  checkedRef.current = checked
  const [text, setText] = useState(payload.kind === 'prompt' ? payload.initial ?? '' : '')
  const page = pages[pages.length - 1]
  const close = (): void => request.finish(payload.kind === 'checklist' ? { checked: checkedRef.current } : null)
  const back = (): void => { if (pages.length > 1) { setPages((old) => old.slice(0, -1)); setQuery('') } else close() }
  const backRef = useRef(back)
  backRef.current = back
  useLayoutEffect(() => {
    const previous = document.activeElement as HTMLElement | null
    dialog.current?.showModal()
    if (payload.kind === 'prompt') { input.current?.focus(); input.current?.select() }
    const onBack = (e: Event): void => {
      e.preventDefault()
      e.stopImmediatePropagation()
      if (!(e as CustomEvent<{ probe?: boolean }>).detail?.probe) backRef.current()
    }
    window.addEventListener('forsion:mobile-back', onBack, true)
    return () => {
      window.removeEventListener('forsion:mobile-back', onBack, true)
      dialog.current?.close()
      // A selected action may replace this sheet. Never restore focus over a newer modal.
      if (!pending && previous?.isConnected) previous.focus({ preventScroll: true })
    }
  }, [])
  const sections = page?.sections.map((section) => ({ ...section, items: section.items.filter((item) => !query || `${item.label} ${item.detail ?? ''}`.toLocaleLowerCase().includes(query.toLocaleLowerCase())) }))
  const title = page?.title ?? payload.title

  // Native sheets live in a separate window. Keep DOM-sheet presses from the source view's outside-click
  // listeners too: clearing its menu would abort the request before the selected callback can run.
  return <dialog ref={dialog} className="bmc-sheet-dialog" aria-label={title ?? t('common.close')} onCancel={(e) => { e.preventDefault(); back() }} onPointerDown={(e) => e.stopPropagation()} onMouseDown={(e) => e.stopPropagation()} onClick={(e) => { e.stopPropagation(); if (e.target === e.currentTarget) close() }}>
    <section className="bmc-sheet" data-browser-mobile-sheet={payload.kind}>
      <div className="mb-sheet-grip" />
      <header className="bmc-sheet-head">
        {pages.length > 1 && <button className="bmc-button" aria-label={payload.kind === 'menu' ? payload.back ?? t('common.back') : t('common.back')} onClick={back}><ArrowLeft size={20} /></button>}
        <strong>{title}</strong>
        <button className="bmc-button" aria-label={t('common.close')} onClick={close}><X size={20} /></button>
      </header>
      {page?.search && <input className="bmc-sheet-search" aria-label={page.search.placeholder} placeholder={page.search.placeholder} value={query} onChange={(e) => setQuery(e.target.value)} />}
      <div className="bmc-sheet-body">
        {sections?.map((section, i) => <div key={i} className="bmc-sheet-section">
          {section.title && <div className="bmc-sheet-section-title">{section.title}</div>}
          <div className={section.grid ? 'bmc-sheet-grid' : undefined}>
            {section.items.map((item) => <div key={item.id} className="bmc-sheet-item">
              <button className="bmc-sheet-row" data-sheet-item={item.id} disabled={item.disabled} data-danger={item.danger || undefined} aria-pressed={item.checked ?? undefined} onClick={() => {
                if (item.children?.length) { setPages((old) => [...old, { title: item.label, sections: item.children!, search: item.search }]); setQuery('') }
                else request.finish({ id: item.id })
              }}>
                <SheetIcon icon={item.icon} /><span className="bmc-sheet-copy">{item.label}{item.detail && <small>{item.detail}</small>}</span>
                {item.children?.length ? <ChevronRight size={18} /> : item.checked ? <Check size={18} /> : null}
              </button>
              {item.trailing && <button className="bmc-button" aria-label={item.trailing.label} disabled={item.disabled} onClick={() => request.finish({ id: item.id, trailing: true })}><SheetIcon icon={item.trailing.icon} /></button>}
            </div>)}
          </div>
          {section.footer && <p className="bmc-sheet-note">{section.footer}</p>}
        </div>)}
        {page?.search && !sections?.some((section) => section.items.length) && <p className="bmc-sheet-note">{page.search.empty}</p>}
        {payload.kind === 'checklist' && <>
          {payload.items.map((item) => <label className="bmc-sheet-row" key={item.id} data-sheet-item={item.id}>
            <SheetIcon icon={item.icon} /><span className="bmc-sheet-copy">{item.label}{item.detail && <small>{item.detail}</small>}</span>
            <input type="checkbox" checked={checked.includes(item.id)} disabled={item.disabled || (!checked.includes(item.id) && checked.length >= payload.max) || (checked.includes(item.id) && checked.length <= (payload.min ?? 0))} onChange={(e) => setChecked((old) => e.target.checked ? [...old, item.id] : old.filter((id) => id !== item.id))} />
          </label>)}
          {payload.footer && <p className="bmc-sheet-note">{payload.footer}</p>}
          <button className="bmc-sheet-submit" onClick={close}>{payload.done}</button>
        </>}
        {payload.kind === 'prompt' && <form onSubmit={(e) => { e.preventDefault(); request.finish({ text }) }}>
          {payload.label && <label htmlFor="bmc-prompt">{payload.label}</label>}
          <input ref={input} id="bmc-prompt" aria-label={payload.label ?? payload.title} maxLength={100_000} placeholder={payload.placeholder} value={text} onChange={(e) => setText(e.target.value)} />
          <div className="bmc-sheet-buttons"><button type="button" onClick={close}>{payload.cancel}</button><button className="bmc-sheet-submit" type="submit">{payload.confirm}</button></div>
        </form>}
        {payload.kind === 'confirm' && <>
          {payload.message && <p>{payload.message}</p>}
          <div className="bmc-sheet-buttons"><button onClick={close}>{payload.cancel}</button><button className="bmc-sheet-submit" data-danger={payload.danger || undefined} onClick={() => request.finish({ ok: true })}>{payload.confirm}</button></div>
        </>}
      </div>
    </section>
  </dialog>
}

export function BrowserSheet() {
  const request = useSyncExternalStore(subscribe, () => pending)
  useLayoutEffect(() => () => { pending?.finish(null) }, [])
  return request ? <SheetDialog key={requestId(request)} request={request} /> : null
}
const ids = new WeakMap<Pending, number>()
let sequence = 0
function requestId(request: Pending): number {
  if (!ids.has(request)) ids.set(request, ++sequence)
  return ids.get(request)!
}
