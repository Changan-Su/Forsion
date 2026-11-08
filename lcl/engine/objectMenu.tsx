/**
 * 共用菜单渲染器 + 对象菜单的接入口(正典:仓根 docs/ToBeImproved/LCL对象动作统一方案_2026-11-07 §3.6 / §3.9)。
 *
 * 一份 `SheetMenu`(nativeSheetMenu 的条目模型)两种画法:装了 Android 原生半屏就走原生,否则画 `.ctx-menu`。
 * 一次只开一个菜单,画在自己的一个 React 根里(document.body 下 `[data-lcl-menu-host]`),所以任何界面(React 或
 * 纯 DOM、插件自己画的行)都能弹,不用在自己的树里留位置。
 *
 * 行为照笔记树的 TreeMenu(走查续六 6.9):`role="menu"`,打开时焦点进第一项,↑↓ / Home / End 走,Esc 关并把
 * 焦点还给发起处;按下菜单外面、在别处右键、窗口失焦都关。条目的标签是裸文本节点(台架按 `button:text-is(…)` 认行)。
 * 点了先关菜单再执行(执行里弹对话框时菜单已经收了)。
 */
import React, { useEffect, useRef } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { Check } from 'lucide-react'
import { OverlayAt } from './menuAnchor'
import { nativeSheetPresenter } from './nativeSheet'
import { runNativeSheetMenu, type SheetMenu, type SheetMenuSection } from './nativeSheetMenu'
import { buildObjectMenu, menuHasItems, type ObjectMenuRequest, type ObjectRef, type Place } from './objects'

export interface MenuAt {
  x: number
  y: number
  /** 发起菜单的那层本身是浮层(Ribbon 收纳夹浮层)时,菜单要压在它上面。缺省用 `.ctx-menu` 的层级。 */
  zIndex?: number
  /** Esc 关菜单后焦点还给谁;缺省 = 打开时的焦点。 */
  returnFocus?: Element | null
  /** 额外的 class(给台架 / 个别样式认)。 */
  className?: string
}

export function MenuSurface({ menu, x, y, zIndex, returnFocus, className, onClose }: MenuAt & { menu: SheetMenu; onClose: () => void }): React.ReactElement {
  const ref = useRef<HTMLDivElement | null>(null)
  const close = useRef(onClose)
  close.current = onClose
  useEffect(() => {
    const active = document.activeElement
    const back = returnFocus instanceof HTMLElement
      ? returnFocus.closest<HTMLElement>('button, [tabindex]') ?? returnFocus
      : active instanceof HTMLElement && active !== document.body ? active : null
    ref.current?.querySelector<HTMLButtonElement>('button[role^="menuitem"]:not(:disabled)')?.focus({ preventScroll: true })
    const outside = (t: EventTarget | null): boolean => !(t instanceof Node) || !ref.current?.contains(t)
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape' && e.key !== 'Tab') return
      e.preventDefault()
      e.stopPropagation()
      close.current()
      if (back?.isConnected) back.focus({ preventScroll: true })
    }
    const onDown = (e: PointerEvent): void => { if (outside(e.target)) close.current() }
    const onCtx = (e: MouseEvent): void => { if (outside(e.target)) close.current(); else e.preventDefault() }
    const onBlur = (): void => close.current()
    document.addEventListener('keydown', onKey, true)
    document.addEventListener('pointerdown', onDown, true)
    document.addEventListener('contextmenu', onCtx, true)
    window.addEventListener('blur', onBlur)
    return () => {
      document.removeEventListener('keydown', onKey, true)
      document.removeEventListener('pointerdown', onDown, true)
      document.removeEventListener('contextmenu', onCtx, true)
      window.removeEventListener('blur', onBlur)
    }
  }, [returnFocus])
  const move = (e: React.KeyboardEvent<HTMLDivElement>): void => {
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(e.key)) return
    e.preventDefault()
    e.currentTarget.setAttribute('data-kbd', '')
    const list = Array.from(e.currentTarget.querySelectorAll<HTMLButtonElement>('button[role^="menuitem"]:not(:disabled)'))
    if (!list.length) return
    const i = list.indexOf(document.activeElement as HTMLButtonElement)
    const n = e.key === 'Home' ? 0 : e.key === 'End' ? list.length - 1 : (i + (e.key === 'ArrowDown' ? 1 : -1) + list.length) % list.length
    list[i < 0 && e.key === 'ArrowUp' ? list.length - 1 : n].focus({ preventScroll: true })
  }
  return (
    <OverlayAt
      className={className ? `ctx-menu ${className}` : 'ctx-menu'}
      role="menu"
      x={x}
      y={y}
      style={zIndex != null ? { zIndex } : undefined}
      innerRef={(el) => { ref.current = el }}
      data-kbd=""
      data-lcl-menu=""
      onKeyDown={move}
      onMouseDown={(e) => e.stopPropagation()}
      onMouseMove={(e) => {
        e.currentTarget.removeAttribute('data-kbd')
        const b = (e.target as Element).closest('button')
        if (b && !b.disabled && b !== document.activeElement && e.currentTarget.contains(b)) b.focus({ preventScroll: true })
      }}
    >
      {menu.sections.filter((s) => s.items.length).map((s, si) => (
        <React.Fragment key={si}>
          {si > 0 && <div className="ctx-separator" role="separator" />}
          {s.title && <div className="ctx-head">{s.title}</div>}
          {s.items.map((it) => (
            <button
              key={it.id}
              type="button"
              role={it.checked !== undefined ? 'menuitemradio' : 'menuitem'}
              aria-checked={it.checked}
              className={it.danger ? 'danger' : undefined}
              disabled={it.disabled || !it.run}
              title={it.detail}
              data-act={it.act}
              onClick={() => { close.current(); it.run?.() }}
            >
              {it.icon}{it.label}{it.checked ? <Check size={12} className="ctx-check" aria-hidden="true" /> : null}
            </button>
          ))}
        </React.Fragment>
      ))}
    </OverlayAt>
  )
}

// ─────────────────────────────── 单例宿主 ───────────────────────────────

let root: Root | null = null
let hostEl: HTMLElement | null = null
let seq = 0
let current: { id: number; onClose?: () => void; abort?: AbortController } | null = null

function ensureRoot(): Root {
  if (!root || !hostEl?.isConnected) {
    hostEl = document.createElement('div')
    hostEl.setAttribute('data-lcl-menu-host', '')
    hostEl.style.display = 'contents'
    document.body.appendChild(hostEl)
    root = createRoot(hostEl)
  }
  return root
}

function closeById(id: number): void {
  if (current?.id !== id) return
  const c = current
  current = null
  c.abort?.abort()
  root?.render(null)
  try { c.onClose?.() } catch (e) { console.error('[menu] onClose failed', e) }
}

export interface OpenMenuRequest extends MenuAt { menu: SheetMenu; onClose?: () => void }

/** 弹一个菜单(先关掉开着的那个)。没有条目就什么都不做。返回关闭函数。 */
export function openMenu(req: OpenMenuRequest): () => void {
  closeMenu()
  if (!menuHasItems(req.menu)) return () => {}
  const id = ++seq
  const renderWeb = (): void => {
    ensureRoot().render(<MenuSurface key={id} {...req} onClose={() => closeById(id)} />)
  }
  if (nativeSheetPresenter()) {
    const abort = new AbortController()
    current = { id, onClose: req.onClose, abort }
    void runNativeSheetMenu(req.menu, {
      signal: abort.signal,
      onClose: () => { if (current?.id === id) { current = null; req.onClose?.() } },
    }).then((handled) => { if (!handled && current?.id === id && !abort.signal.aborted) renderWeb() })
  } else {
    current = { id, onClose: req.onClose }
    renderWeb()
  }
  return () => closeById(id)
}

export function closeMenu(): void { if (current) closeById(current.id) }
export function menuIsOpen(): boolean { return current != null }

/** 给一组对象弹菜单。没有任何可列的项 = 不弹、返回 false(调用方让事件照常冒泡)。 */
export function openObjectMenu(req: ObjectMenuRequest & MenuAt & { onClose?: () => void }): boolean {
  const menu = buildObjectMenu(req)
  if (!menuHasItems(menu)) return false
  openMenu({ ...req, menu })
  return true
}

// ─────────────────────────────── 接入 ───────────────────────────────

export interface ObjectMenuBinding {
  /** 右键的是谁;函数形式在右键那一刻现取(多选)。 */
  refs: ObjectRef[] | (() => ObjectRef[])
  place: Place
  /** 本处项,右键那一刻现取。 */
  placeSections?: () => SheetMenuSection[]
  zIndex?: number
  className?: string
}

/** contextmenu 处理函数:别人已经 preventDefault 的不管;没有可列的项不拦、事件照常冒泡(交给外层的区菜单)。 */
export function objectContextMenuHandler(get: () => ObjectMenuBinding): (e: MouseEvent | React.MouseEvent) => void {
  return (e) => {
    if (e.defaultPrevented) return
    const b = get()
    const refs = typeof b.refs === 'function' ? b.refs() : b.refs
    const opened = openObjectMenu({
      refs,
      place: b.place,
      placeSections: b.placeSections?.(),
      x: e.clientX,
      y: e.clientY,
      zIndex: b.zIndex,
      className: b.className,
      returnFocus: e.currentTarget instanceof Element ? e.currentTarget : null,
    })
    if (opened) { e.preventDefault(); e.stopPropagation() }
  }
}

/** React 接法:`<div onContextMenu={menu.onContextMenu}>`;「⋯」按钮用 `menu.openAt(el)`。回调稳定。 */
export function useObjectMenu(binding: ObjectMenuBinding): { onContextMenu: (e: React.MouseEvent) => void; openAt: (anchor: Element) => boolean } {
  const latest = useRef(binding)
  latest.current = binding
  const api = useRef<{ onContextMenu: (e: React.MouseEvent) => void; openAt: (anchor: Element) => boolean } | null>(null)
  if (!api.current) {
    api.current = {
      onContextMenu: objectContextMenuHandler(() => latest.current),
      openAt: (anchor) => {
        const b = latest.current
        const r = anchor.getBoundingClientRect()
        return openObjectMenu({
          refs: typeof b.refs === 'function' ? b.refs() : b.refs,
          place: b.place,
          placeSections: b.placeSections?.(),
          x: r.left,
          y: r.bottom + 4,
          zIndex: b.zIndex,
          className: b.className,
          returnFocus: anchor,
        })
      },
    }
  }
  return api.current
}

/** DOM 接法(非 React、插件自己画的行):返回解绑函数。 */
export function bindObject(el: Element, binding: ObjectMenuBinding | (() => ObjectMenuBinding)): () => void {
  const handler = objectContextMenuHandler(typeof binding === 'function' ? binding : () => binding)
  const h = handler as (e: Event) => void
  el.addEventListener('contextmenu', h)
  return () => el.removeEventListener('contextmenu', h)
}
