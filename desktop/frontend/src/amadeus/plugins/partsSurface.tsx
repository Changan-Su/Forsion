/**
 * 宿主替插件画的零件(走查续八 8.14 / 8.15 / 8.18 / 8.19,2026-10-26):对话框与确认、工具栏尺寸的分段 / 下拉、弹出层、空态。
 * 文案都是 PluginText,画的那一刻求值;开着的零件跟着切语言重画。插件回调一律经 `guard`(插件停用后不再调它、抛错只记一行)。
 * 生命周期由 pluginStore 记账(停用 / 重载统一收);这里只管画与关。
 */
import { useEffect, useRef, useState, type ReactElement } from 'react'
import { createPortal } from 'react-dom'
import { ChevronDown, Check } from 'lucide-react'
import { OverlayAt, ViewModeSwitch, clampMenu, nativeSheetPresenter, presentNativeConfirm, runNativeSheetMenu, zoomOf, UI_ZOOM_EVENT } from '@lcl/engine'
import { mountHostReact } from '@lcl/components'
import { HostLocaleProvider, registerMessages, subscribeLocale, translate, useI18n } from '../../i18n'
import { EmptyState } from '../../components/EmptyState'
import { pluginText } from './pluginText'
import { vocabIcon } from './pluginIcon'
import { overlayLayer } from './contextMenuSurface'
import type { PluginConfirmOptions, PluginControlOption, PluginDialogAction, PluginDialogOptions, PluginEmptyState, PluginPopoverOptions, PluginToolbarControl } from './types'
import './pluginParts.css'

registerMessages({
  'pluginparts.ok': { zh: '确定', en: 'OK' },
  'pluginparts.cancel': { zh: '取消', en: 'Cancel' },
  'pluginparts.delete': { zh: '删除', en: 'Delete' },
  'pluginparts.search': { zh: '搜索', en: 'Search' },
  'pluginparts.noMatch': { zh: '没有匹配的选项', en: 'No matching options' },
})

type Guard = <T>(fn: () => T) => T | undefined

// ── 对话框 ───────────────────────────────────────────────────────────────

/** 插件 mount 返回的清理:插件已停用也要跑(停用时 ctx 先死,走 guard 会被跳过 → 订阅 / 计时器漏掉),只隔离异常。 */
function runCleanup(fn: unknown): void {
  if (typeof fn !== 'function') return
  try { (fn as () => void)() } catch (e) { console.error('[amadeus] plugin cleanup failed', e) }
}

export interface DialogSurface { update(patch: Partial<PluginDialogOptions>): void; close(): void }

/** 原生 <dialog> + showModal:焦点圈、Esc、遮罩、宿主进场动效(base.css 的 dialog[open])都是原生那一份。 */
export function openPluginDialog(opts: PluginDialogOptions, guard: Guard, onClosed: () => void, focus: 'primary' | 'cancel' = 'primary'): DialogSurface {
  let cur = { ...opts }
  const dlg = document.createElement('dialog')
  dlg.className = 'plugin-dialog'
  if (cur.width === 'md') dlg.dataset.width = 'md'
  const id = `pdlg-${Math.random().toString(36).slice(2, 8)}`
  const title = Object.assign(document.createElement('h2'), { className: 'plugin-dialog-title', id })
  const body = Object.assign(document.createElement('p'), { className: 'plugin-dialog-body' })
  const content = Object.assign(document.createElement('div'), { className: 'plugin-dialog-content' })
  const bar = Object.assign(document.createElement('div'), { className: 'plugin-dialog-actions' })
  dlg.setAttribute('aria-labelledby', id)
  dlg.append(title, body, content, bar)
  let busy = false, open = true
  const acts = (): PluginDialogAction[] => (Array.isArray(cur.actions) && cur.actions.length ? cur.actions : [{ label: () => translate('pluginparts.ok'), primary: true }])
  let primaryBtn: HTMLButtonElement | null = null
  const paint = (): void => {
    title.textContent = pluginText(cur.title)
    const b = cur.body ? pluginText(cur.body) : ''
    body.textContent = b
    body.hidden = !b
    primaryBtn = null
    bar.replaceChildren(...acts().map((a) => {
      const btn = document.createElement('button')
      btn.type = 'button'
      btn.className = a.primary ? 'btn sm primary' : a.danger ? 'btn sm danger' : 'btn sm ghost'
      if (a.primary && a.danger) btn.dataset.danger = ''
      if (!a.primary) btn.dataset.secondary = ''
      btn.textContent = pluginText(a.label)
      btn.disabled = !!a.disabled || busy
      btn.onclick = () => void press(a)
      if (a.primary) primaryBtn = btn
      return btn
    }))
  }
  const press = async (a: PluginDialogAction): Promise<void> => {
    if (busy || !open || a.disabled) return
    if (typeof a.run !== 'function') { close(); return }
    busy = true; paint()
    let keep = false
    try { keep = (await guard(() => a.run!())) === false } catch (e) { console.error('[amadeus] plugin dialog action failed', e); keep = true }
    busy = false
    if (!open) return
    if (keep) paint(); else close()
  }
  const unsub = subscribeLocale(paint)
  let cleanup: unknown
  const close = (): void => {
    if (!open) return
    open = false
    unsub()
    runCleanup(cleanup)
    if (dlg.open) dlg.close()
    dlg.remove()
    onClosed()
  }
  dlg.addEventListener('cancel', (e) => { e.preventDefault(); close() }) // Esc(动作还在跑也能关:卡住的请求不能把人关在模态框里;press 见 !open 就不再收尾)
  dlg.addEventListener('click', (e) => { // 点遮罩(dialog 自己的盒子之外)
    if (e.target !== dlg) return
    const r = dlg.getBoundingClientRect()
    if (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom) close()
  })
  dlg.addEventListener('keydown', (e) => { // 回车 = 主按钮(焦点在别的按钮 / 多行输入 / 输入法组字时不抢)
    if (e.key !== 'Enter' || e.isComposing || e.defaultPrevented || e.shiftKey) return
    const t = e.target as HTMLElement
    if (t.closest('button, textarea, a, [contenteditable="true"], select') && t !== dlg) return
    const p = acts().find((a) => a.primary)
    if (p) { e.preventDefault(); void press(p) }
  })
  paint()
  document.body.append(dlg)
  cleanup = guard(() => cur.mount?.(content))
  dlg.showModal()
  const first = focus === 'cancel' ? bar.querySelector<HTMLButtonElement>('[data-secondary]') : null
  ;(first ?? primaryBtn ?? bar.querySelector('button'))?.focus()
  return {
    update(patch) { if (!open || !patch || typeof patch !== 'object') return; cur = { ...cur, ...patch }; paint() },
    close,
  }
}

/** 是 / 否:Android 上先走原生确认框,宿主没有 / 画不了再落回网页对话框。 */
export function confirmPlugin(o: PluginConfirmOptions, guard: Guard, signal: AbortSignal): Promise<boolean> {
  const ok = o.ok ?? (() => translate(o.danger ? 'pluginparts.delete' : 'pluginparts.ok'))
  const cancel = o.cancel ?? (() => translate('pluginparts.cancel'))
  const web = (): Promise<boolean> => new Promise((resolve) => {
    if (signal.aborted) { resolve(false); return }
    let answer = false
    const d = openPluginDialog({
      title: o.title, body: o.body,
      actions: [{ label: cancel }, { label: ok, primary: true, danger: !!o.danger, run: () => { answer = true } }],
    }, guard, () => resolve(answer), o.danger ? 'cancel' : 'primary')
    signal.addEventListener('abort', () => d.close(), { once: true })
  })
  if (signal.aborted) return Promise.resolve(false)
  if (!nativeSheetPresenter()) return web()
  return presentNativeConfirm({ title: pluginText(o.title), ...(o.body ? { message: pluginText(o.body) } : {}), confirm: pluginText(ok), cancel: pluginText(cancel), danger: !!o.danger }, signal)
    .then((out) => (out.handled ? !!out.value && !signal.aborted : web()))
}

// ── 工具栏控件 ────────────────────────────────────────────────────────────

function ToolbarSelect({ c, pick }: { c: PluginToolbarControl; pick(v: string): void }): ReactElement {
  const { t } = useI18n() // 也让切语言时重画
  const btn = useRef<HTMLButtonElement>(null)
  const menuRef = useRef<HTMLDivElement | null>(null)
  const [at, setAt] = useState<{ x: number; y: number; top: number; kb: boolean } | null>(null)
  const [q, setQ] = useState('')
  const cur = c.options.find((o) => o.value === c.value) ?? c.options[0]
  const label = (o: PluginControlOption | undefined): string => (o ? pluginText(o.label) : '')
  const searchable = c.options.length > 5
  const shown = searchable && q.trim() ? c.options.filter((o) => label(o).toLowerCase().includes(q.trim().toLowerCase())) : c.options
  useEffect(() => {
    if (!at) return
    const outside = (e: Event): void => { if (!menuRef.current?.contains(e.target as Node) && !btn.current?.contains(e.target as Node)) setAt(null) }
    const blur = (): void => setAt(null)
    window.addEventListener('pointerdown', outside, true)
    window.addEventListener('blur', blur)
    const m = menuRef.current
    // 键盘打开:焦点落当前项;鼠标打开:落在菜单本身(方向键照样能走,不在当前项上画焦点框)
    ;(m?.querySelector<HTMLElement>('.plugin-lb-search') ?? (at.kb ? m?.querySelector<HTMLElement>('[aria-selected="true"]') ?? m?.querySelector<HTMLElement>('[role="option"]') : m))?.focus({ preventScroll: true })
    return () => { window.removeEventListener('pointerdown', outside, true); window.removeEventListener('blur', blur) }
  }, [at])
  const openMenu = (e: React.MouseEvent): void => {
    const kb = e.detail === 0
    if (at) { setAt(null); return }
    if (nativeSheetPresenter()) {
      void runNativeSheetMenu({ ...(c.label ? { title: pluginText(c.label) } : {}), sections: [{ items: c.options.map((o) => { const G = vocabIcon(o.icon); return { id: o.value, label: label(o), ...(G ? { icon: <G size={16} /> } : {}), checked: o.value === c.value, run: () => pick(o.value) } }) }] })
        .then((shown) => { if (!shown) place(kb) })
      return
    }
    place(kb)
  }
  const place = (kb: boolean): void => { const r = btn.current?.getBoundingClientRect(); if (r) { setQ(''); setAt({ x: r.left, y: r.bottom + 4, top: r.top - 4, kb }) } }
  const done = (v?: string): void => { setAt(null); btn.current?.focus(); if (v !== undefined && v !== c.value) pick(v) }
  const keys = (e: React.KeyboardEvent<HTMLDivElement>): void => {
    const items = [...e.currentTarget.querySelectorAll<HTMLElement>('[role="option"]')]
    const i = items.indexOf(document.activeElement as HTMLElement)
    const go = (n: number): void => { e.preventDefault(); items[(n + items.length) % items.length]?.focus() }
    if (e.key === 'ArrowDown') go(i + 1)
    else if (e.key === 'ArrowUp') go(i < 0 ? items.length - 1 : i - 1)
    else if (e.key === 'Home' && i >= 0) go(0)
    else if (e.key === 'End' && i >= 0) go(items.length - 1)
    else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); done() }
    else if (e.key === 'Tab') { e.preventDefault(); done() }
    else if (e.key === 'Enter' && i < 0 && shown[0]) { e.preventDefault(); done(shown[0].value) }
  }
  const G = vocabIcon(cur?.icon)
  return (
    <>
      <button ref={btn} type="button" className="plugin-tbsel" aria-haspopup="listbox" aria-expanded={!!at} disabled={c.disabled}
        aria-label={c.label ? `${pluginText(c.label)}: ${label(cur)}` : undefined} onMouseDown={(e) => e.preventDefault()} onClick={openMenu}>
        {G ? <G size={14} /> : null}<span>{label(cur)}</span><ChevronDown size={12} />
      </button>
      {at && createPortal(
        <OverlayAt className="ctx-menu ctx-menu-scroll plugin-menu plugin-listbox" x={at.x} y={at.y} anchorTop={at.top} innerRef={(el) => { menuRef.current = el }}
          role="listbox" tabIndex={-1} aria-label={c.label ? pluginText(c.label) : undefined} onKeyDown={keys}>
          {searchable ? <input className="plugin-lb-search" value={q} onChange={(e) => setQ(e.target.value)} placeholder={t('pluginparts.search')} aria-label={t('pluginparts.search')} /> : null}
          {shown.map((o) => { const I = vocabIcon(o.icon); return (
            <button key={o.value} type="button" role="option" aria-selected={o.value === c.value} onClick={() => done(o.value)}>
              {I ? <I size={13} className="plugin-menu-ic" /> : null}
              <span className="plugin-menu-label">{label(o)}</span>
              <Check size={13} className="plugin-menu-check" />
            </button>
          ) })}
          {!shown.length ? <div className="plugin-lb-empty">{t('pluginparts.noMatch')}</div> : null}
        </OverlayAt>,
        overlayLayer(btn.current),
      )}
    </>
  )
}

function Control({ c, pick }: { c: PluginToolbarControl; pick(v: string): void }): ReactElement | null {
  useI18n()
  if (c.type === 'select') return <ToolbarSelect c={c} pick={pick} />
  if (c.disabled) return <span inert className="plugin-ctl-off"><ViewModeSwitch spec={{ modes: c.options.map((o) => ({ value: o.value, label: pluginText(o.label), icon: vocabIcon(o.icon) as never })), value: c.value, onChange: () => {} }} /></span>
  return <ViewModeSwitch spec={{
    modes: c.options.map((o) => ({ value: o.value, label: pluginText(o.label), icon: vocabIcon(o.icon) as never })),
    value: c.value, onChange: pick, ...(c.label ? { ariaLabel: pluginText(c.label) } : {}),
  }} />
}

/** 半受控:用户点了先自己挪过去再告诉插件(插件不回 update 也不会卡在旧值);插件 update 的 value 为准。 */
export function mountPluginControl(el: HTMLElement, control: PluginToolbarControl, guard: Guard): { update(patch: Partial<PluginToolbarControl>): void; dispose(): void } {
  let c = control
  const pick = (v: string): void => { if (c.disabled) return; c = { ...c, value: v }; m.render(tree()); guard(() => c.onChange(v)) }
  const tree = (): ReactElement => <HostLocaleProvider><Control c={c} pick={pick} /></HostLocaleProvider>
  const m = mountHostReact(el, tree())
  return { update(patch) { c = { ...c, ...patch, type: c.type }; m.render(tree()) }, dispose: m.dispose }
}

// ── 空态 ─────────────────────────────────────────────────────────────────

function PluginEmpty({ o, guard }: { o: PluginEmptyState; guard: Guard }): ReactElement {
  useI18n()
  const Icon = (vocabIcon(o.icon) ?? vocabIcon('list-checks'))!
  const act = o.action
  return (
    <EmptyState icon={Icon as never} title={pluginText(o.title)} line={o.line ? pluginText(o.line) : undefined}
      action={act ? { label: pluginText(act.label), icon: vocabIcon(act.icon) as never, onClick: () => guard(() => act.run()) } : null}
      secondary={o.secondary ? <button type="button" className="btn ghost sm" onClick={() => guard(() => o.secondary!.run())}>{pluginText(o.secondary.label)}</button> : undefined} />
  )
}

export function mountPluginEmptyState(el: HTMLElement, opts: PluginEmptyState, guard: Guard): { update(patch: Partial<PluginEmptyState>): void; dispose(): void } {
  let o = opts
  const tree = (): ReactElement => <HostLocaleProvider><PluginEmpty o={o} guard={guard} /></HostLocaleProvider>
  const m = mountHostReact(el, tree())
  return { update(patch) { o = { ...o, ...patch }; m.render(tree()) }, dispose: m.dispose }
}

// ── 弹出层 ────────────────────────────────────────────────────────────────

let currentPop: (() => void) | null = null

/** 锚在元素上的小面板:宿主 .ui-popover 外壳,夹边、翻面、界面缩放、Esc / 点外面 / 失焦关。同一时刻只开一个。 */
export function openPluginPopover(anchor: HTMLElement, opts: PluginPopoverOptions, guard: Guard, onClosed: () => void): { update(): void; close(): void } {
  currentPop?.()
  const el = document.createElement('div')
  el.className = 'ui-popover plugin-popover'
  el.setAttribute('role', 'dialog')
  el.dataset.motion = 'enter'
  if (opts.label) el.setAttribute('aria-label', pluginText(opts.label))
  el.style.visibility = 'hidden'
  overlayLayer(anchor).append(el)
  let open = true
  let cleanup: unknown
  const place = (): void => {
    if (!open) return
    const r = anchor.getBoundingClientRect(), z = zoomOf(el)
    const end = opts.align === 'end'
    const v = clampMenu(end ? r.right : r.left, r.bottom + 4, el.offsetWidth * z, el.offsetHeight * z, window.innerWidth, window.innerHeight,
      { anchorTop: r.top - 4, prefer: opts.side === 'top' ? 'above' : 'below', alignEnd: end })
    el.style.left = `${v.left / z}px`
    el.style.top = `${v.top / z}px`
    el.style.visibility = ''
  }
  const ro = new ResizeObserver(place)
  const close = (): void => {
    if (!open) return
    open = false
    if (currentPop === close) currentPop = null
    ro.disconnect()
    document.removeEventListener('pointerdown', onDown, true)
    document.removeEventListener('keydown', onKey, true)
    window.removeEventListener('blur', onBlur)
    window.removeEventListener('resize', place)
    window.removeEventListener(UI_ZOOM_EVENT, place)
    runCleanup(cleanup)
    el.remove()
    onClosed()
  }
  const onDown = (e: PointerEvent): void => {
    if (e.target instanceof Node && el.contains(e.target)) return
    if (e.target instanceof Node && anchor.contains(e.target)) { // 再点锚点 = 收起,别让它的 click 再开一份
      const eat = (c: Event): void => c.stopImmediatePropagation()
      anchor.addEventListener('click', eat, { capture: true, once: true })
      window.setTimeout(() => anchor.removeEventListener('click', eat, { capture: true }), 800)
    }
    close()
  }
  const onKey = (e: KeyboardEvent): void => { if (e.key === 'Escape' && !e.isComposing) { e.preventDefault(); e.stopPropagation(); close(); anchor.focus?.() } }
  // 失焦 = 切到别的窗口;焦点只是进了弹出层里的 iframe / webview 不算
  const onBlur = (): void => { window.setTimeout(() => { if (!el.contains(document.activeElement)) close() }, 0) }
  document.addEventListener('pointerdown', onDown, true)
  document.addEventListener('keydown', onKey, true)
  window.addEventListener('blur', onBlur)
  window.addEventListener('resize', place)
  window.addEventListener(UI_ZOOM_EVENT, place)
  currentPop = close
  cleanup = guard(() => opts.mount(el))
  ro.observe(el)
  place()
  return { update: place, close }
}
