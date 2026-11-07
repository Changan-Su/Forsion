import { useEffect, useId, useLayoutEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { Check, ChevronDown, MessageCircle, Search } from 'lucide-react'
import { OverlayAt, UI_ZOOM_EVENT } from '@lcl/engine'
import { registerMessages, useI18n } from '../i18n'
import './compactChatPicker.css'

registerMessages({
  'chatPicker.engines': { zh: '外部引擎', en: 'External engines' },
  'chatPicker.done': { zh: '完成', en: 'Done' },
})

export interface ChatPickItem {
  id: string
  name: string
  /** 只在说明区 / 长按卡片里出现,不进行(方案页:docs/ToBeImproved/窄栏Agent选择器方案_2026-10-23)。 */
  description?: string
  icon: ReactNode
  /** 已选:true = 打勾;数字 = 团队发言序号(从 1 起)。 */
  mark?: true | number
  badge?: ReactNode
  disabled?: boolean
  /** 小节标题;同一小节的项须相邻。 */
  section?: string
  /** 给了就有「私聊」入口(浮层悬停行尾 / 抽屉长按卡片)。 */
  direct?: boolean
  /** 本行下面画一条分隔线(「默认」与具体候选之间)。 */
  separatorAfter?: boolean
  /** 搜索时名字之外也认的词(slug、另一种语言的名字)。 */
  keywords?: string[]
}

/**
 * 输入框工具行里的收件人芯片(.t2c-pill;宽窄同一枚,方案页 docs/ToBeImproved/主页生成式组件方案_2026-11-02/agent.html A)。点开:
 *  - 调用方 `onNative` 接管(安卓原生外壳的勾选清单 / 菜单)→ 不画网页面;
 *  - 触屏(pointer: coarse)→ 贴底抽屉;否则 → 芯片上方的浮层(.ctx-menu 外壳,顶上一行搜索,打开即聚焦)。
 * 两种网页面共用同一份行:头像 + 名字 + 标 + 勾 / 序号,简介不进行(浮层在底部说明区,抽屉在长按卡片)。
 * 点行切换,`closeOnPick` 说了算才收起(多选的 Agent 点一下不收,好接着组队)。
 */
export function CompactChatPicker({
  title, icon, name, status, items, onPick, closeOnPick, onDirect, directLabel, onNative, onRowMenu, searchLabel, hotkeyHint, busy = false,
}: {
  /** 浮层 / 抽屉的标题,也是芯片的可访问名。 */
  title: string
  icon: ReactNode
  name: string
  /** 状态句(「X 将处理这条消息」/「团队模式 · n 人」)。 */
  status?: string
  items: ChatPickItem[]
  onPick: (id: string) => void
  closeOnPick?: (id: string) => boolean
  onDirect?: (id: string) => void
  directLabel?: string
  /** 返回 true = 已由原生面接管;接管失败时调 `fallback` 换回网页面。 */
  onNative?: (fallback: () => void) => boolean
  /** 浮层里右键一行:调用方自己画 ContextMenu;`close` 收起浮层(菜单项要离开这里时用)。 */
  onRowMenu?: (id: string, at: { x: number; y: number }, close: () => void) => void
  /** 浮层搜索框的占位(抽屉不放搜索)。 */
  searchLabel?: string
  /** 搜索框右侧的快捷键提示(如 ⌘⇧A)。 */
  hotkeyHint?: string
  busy?: boolean
}) {
  const { t } = useI18n()
  const listId = useId()
  const optId = (id: string): string => `${listId}-${id || 'default'}`
  const chipRef = useRef<HTMLButtonElement>(null)
  const surfaceRef = useRef<HTMLDivElement | null>(null)
  const searchRef = useRef<HTMLInputElement>(null)
  const [open, setOpen] = useState<null | 'popover' | 'sheet'>(null)
  const [query, setQuery] = useState('')
  // 浮层的活动行(悬停 / ↑↓):焦点一直留在搜索框里,边打边筛,同 Composer2 的 @ 菜单
  const [active, setActive] = useState<string | null>(null)
  const [held, setHeld] = useState<{ id: string; top: number; bottom: number } | null>(null)
  const heldRef = useRef<HTMLDivElement>(null)
  const [heldBelow, setHeldBelow] = useState(false)
  const [anchor, setAnchor] = useState({ x: 0, y: 0, top: 0 })

  const openWeb = (): void => setOpen(window.matchMedia?.('(pointer: coarse)').matches ? 'sheet' : 'popover')
  const close = (refocus = false): void => {
    setOpen(null); setActive(null); setHeld(null); setQuery('')
    if (refocus) chipRef.current?.focus()
  }
  const toggleOpen = (): void => {
    if (open) { close(true); return } // ⌘⇧A 再按一次收起:焦点回芯片,不掉到 body
    if (onNative?.(openWeb)) return
    openWeb()
  }
  const pick = (item: ChatPickItem): void => {
    if (item.disabled) return
    onPick(item.id)
    if (closeOnPick?.(item.id)) close(open === 'popover')
  }

  // 浮层贴芯片上方、左对齐(芯片在工具行左半);芯片随输入区移动(窗口缩放 / 滚动 / 界面缩放)时跟着走。
  useLayoutEffect(() => {
    if (open !== 'popover') return
    const update = (): void => {
      const r = chipRef.current?.getBoundingClientRect()
      if (!r) return
      const next = { x: r.left, y: r.bottom + 6, top: r.top - 6 }
      setAnchor((p) => (p.x === next.x && p.y === next.y && p.top === next.top ? p : next))
    }
    update()
    window.addEventListener('resize', update)
    window.addEventListener(UI_ZOOM_EVENT, update)
    document.addEventListener('scroll', update, true)
    return () => {
      window.removeEventListener('resize', update)
      window.removeEventListener(UI_ZOOM_EVENT, update)
      document.removeEventListener('scroll', update, true)
    }
  }, [open])

  useEffect(() => {
    if (!open) return
    // 行的右键菜单(调用方画的 ContextMenu)开着时:点它不算点外面,Esc 先归它收
    const rowMenu = (): Element | null => document.querySelector('.ctx-menu[role="menu"]')
    const onDown = (e: PointerEvent): void => {
      const t = e.target as Node
      if (!chipRef.current?.contains(t) && !surfaceRef.current?.contains(t) && !rowMenu()?.contains(t)) close()
    }
    // 输入法选字时的 Esc 是取消选字,归输入法
    const onKey = (e: KeyboardEvent): void => { if (e.key === 'Escape' && !e.isComposing && !rowMenu()) { e.stopPropagation(); close(true) } }
    document.addEventListener('pointerdown', onDown, true)
    document.addEventListener('keydown', onKey, true)
    // 浮层:焦点进搜索框(⌘⇧A 打开即可打字);抽屉:落到已选的第一项(没有就第一项),键盘直接上下挑
    const first = open === 'popover' ? searchRef.current
      : surfaceRef.current?.querySelector<HTMLElement>('[role="option"][aria-selected="true"]:not(:disabled)')
        ?? surfaceRef.current?.querySelector<HTMLElement>('[role="option"]:not(:disabled)')
    first?.focus({ preventScroll: true })
    return () => {
      document.removeEventListener('pointerdown', onDown, true)
      document.removeEventListener('keydown', onKey, true)
    }
  }, [open]) // eslint-disable-line react-hooks/exhaustive-deps

  const onListKey = (e: ReactKeyboardEvent<HTMLDivElement>): void => {
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(e.key)) return
    const opts = Array.from(e.currentTarget.querySelectorAll<HTMLElement>('[role="option"]:not(:disabled)'))
    if (!opts.length) return
    e.preventDefault()
    const at = opts.indexOf(document.activeElement as HTMLElement)
    const next = e.key === 'Home' ? 0 : e.key === 'End' ? opts.length - 1
      : e.key === 'ArrowDown' ? (at + 1) % opts.length : (at - 1 + opts.length) % opts.length
    opts[next].focus()
  }

  // 搜索只在浮层里:名字 + 调用方给的别名(slug、另一种语言的名字)里含就算
  const q = open === 'popover' ? query.trim().toLowerCase() : ''
  const shown = q ? items.filter((i) => [i.name, ...(i.keywords ?? [])].some((w) => w.toLowerCase().includes(q))) : items
  const enabled = shown.filter((i) => !i.disabled)
  // 打了字还没挪过活动行:默认第一个命中,↵ 直接选它
  const activeId = enabled.some((i) => i.id === active) ? active : q ? enabled[0]?.id ?? null : null
  useEffect(() => {
    if (open === 'popover') surfaceRef.current?.querySelector('.chat-pick-row[data-active]')?.scrollIntoView({ block: 'nearest' })
  }, [open, activeId])
  const onSearchKey = (e: ReactKeyboardEvent<HTMLInputElement>): void => {
    if (e.nativeEvent.isComposing) return // 输入法选字的 ↵ / ↑↓ 归输入法
    if (e.key === 'Enter') {
      e.preventDefault()
      const item = enabled.find((i) => i.id === activeId)
      if (item) pick(item)
      return
    }
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return
    e.preventDefault()
    if (!enabled.length) return
    const at = enabled.findIndex((i) => i.id === activeId)
    const next = e.key === 'ArrowDown' ? (at + 1) % enabled.length : at < 0 ? enabled.length - 1 : (at - 1 + enabled.length) % enabled.length
    setActive(enabled[next].id)
  }

  // 底部说明区:活动行有简介就讲它,否则是状态句(谁会接这条消息)
  const described = open === 'popover' ? items.find((i) => i.id === activeId && i.description) : undefined
  const footer = described ? <><b>{described.name}</b>{described.description}</> : status

  const rows = (list: ChatPickItem[], sheet: boolean): ReactNode => list.map((item, i) => {
    const head = item.section && item.section !== list[i - 1]?.section
    return [
      head && <div key={`h:${item.section}`} className="chat-pick-section">{item.section}</div>,
      <button
        key={item.id || '__default'}
        type="button"
        role="option"
        aria-selected={!!item.mark}
        disabled={item.disabled}
        tabIndex={sheet ? undefined : -1}
        id={sheet ? undefined : optId(item.id)}
        className={`chat-pick-row${item.mark ? ' is-picked' : ''}${held?.id === item.id ? ' is-held' : ''}`}
        data-pick-id={item.id}
        data-active={(!sheet && item.id === activeId) || undefined}
        title={sheet ? undefined : item.description}
        onClick={() => { if (!held) pick(item) }} // 卡片开着时点哪都只是收卡片(列表上的 onClick 收)
        onMouseDown={sheet ? undefined : (e) => e.preventDefault()} // 焦点留在搜索框
        onPointerEnter={sheet ? undefined : () => setActive(item.id)}
        // 触屏长按在 Chromium 上发 contextmenu:抽屉里 = 简介 + 私聊卡片;浮层右键 = 调用方的行菜单
        onContextMenu={sheet ? (item.description || (item.direct && onDirect) ? (e) => {
          e.preventDefault()
          const sheetTop = surfaceRef.current?.getBoundingClientRect().top ?? 0
          const r = e.currentTarget.getBoundingClientRect()
          setHeld({ id: item.id, top: r.top - sheetTop, bottom: r.bottom - sheetTop })
        } : undefined) : onRowMenu && item.id ? (e) => {
          e.preventDefault()
          setActive(item.id)
          onRowMenu(item.id, { x: e.clientX, y: e.clientY }, () => close())
        } : undefined}
      >
        <span className="chat-pick-icon">{item.icon}</span>
        <span className="chat-pick-name">{item.name}</span>
        {item.badge}
        {!sheet && item.direct && onDirect && (
          <span
            className="chat-pick-direct"
            role="button"
            tabIndex={-1}
            title={directLabel}
            aria-label={directLabel}
            onClick={(e) => { e.stopPropagation(); close(); onDirect(item.id) }}
          ><MessageCircle size={13} /></span>
        )}
        {typeof item.mark === 'number'
          ? <span className="chat-pick-index">{item.mark}</span>
          : item.mark && <Check size={15} className="chat-pick-check" />}
      </button>,
      item.separatorAfter && <div key={`s:${item.id}`} className="ctx-separator chat-pick-sep" />,
    ]
  })

  const heldItem = held ? items.find((i) => i.id === held.id) : undefined
  // 卡片默认浮在被按的那行上方;上方放不下(横屏、前几行)就翻到行下方
  useLayoutEffect(() => {
    if (!held || !heldRef.current || !surfaceRef.current) return
    const sheetTop = surfaceRef.current.getBoundingClientRect().top
    setHeldBelow(sheetTop + held.top - heldRef.current.offsetHeight - 6 < 8)
  }, [held])

  return (
    <>
      <button
        ref={chipRef}
        type="button"
        className={`t2c-pill compact-chat-picker${open ? ' is-open' : ''}`}
        aria-busy={busy || undefined}
        aria-haspopup="listbox"
        aria-expanded={!!open}
        aria-label={`${title}: ${name}`}
        title={name}
        onClick={toggleOpen}
        onKeyDown={(e) => { if (e.key === 'ArrowDown' && !open) { e.preventDefault(); toggleOpen() } }}
      >
        <span className="compact-chat-picker-icon">{icon}</span>
        <span className="t2c-pill-label compact-chat-picker-name">{name}</span>
        <ChevronDown size={10} />
      </button>
      {open === 'popover' && createPortal(
        <div className="ui-popover-backdrop" style={{ pointerEvents: 'none' }} data-cmenu>
          <OverlayAt
            x={anchor.x} y={anchor.y} anchorTop={anchor.top} prefer="above"
            innerRef={(el) => { surfaceRef.current = el }}
            className="ctx-menu chat-pick-pop"
            style={{ pointerEvents: 'auto' }}
            onPointerLeave={() => setActive(null)}
          >
            {searchLabel && (
              <label className="chat-pick-search">
                <Search size={14} aria-hidden="true" />
                <input
                  ref={searchRef}
                  type="text"
                  value={query}
                  placeholder={searchLabel}
                  aria-label={searchLabel}
                  // 焦点留在框里,活动行靠 aria-activedescendant 报给读屏(combobox 模式,同 @ 菜单的行为)
                  role="combobox"
                  aria-expanded
                  aria-controls={listId}
                  aria-activedescendant={activeId !== null ? optId(activeId) : undefined}
                  spellCheck={false}
                  autoComplete="off"
                  onChange={(e) => { setQuery(e.target.value); setActive(null) }}
                  onKeyDown={onSearchKey}
                />
                {hotkeyHint && <kbd aria-hidden="true">{hotkeyHint}</kbd>}
              </label>
            )}
            <div className="ctx-menu-scroll" id={listId} role="listbox" aria-multiselectable aria-label={title}>
              {rows(shown, false)}
              {!shown.length && <div className="chat-pick-empty">{t('addMenu.noMatches')}</div>}
            </div>
            {footer && (
              <>
                <div className="ctx-separator" />
                <div className="chat-pick-desc" aria-live="polite">{footer}</div>
              </>
            )}
          </OverlayAt>
        </div>,
        document.body,
      )}
      {open === 'sheet' && createPortal(
        <div className="chat-pick-scrim" onClick={(e) => { if (e.target === e.currentTarget) close() }}>
          <div ref={(el) => { surfaceRef.current = el }} className="chat-pick-sheet" role="listbox" aria-multiselectable aria-label={title} onKeyDown={onListKey}>
            <div className="chat-pick-grip" aria-hidden="true" />
            <div className="chat-pick-head"><b>{title}</b>{status && <span>{status}</span>}</div>
            <div className="chat-pick-list" onClick={() => setHeld(null)}>{rows(items, true)}</div>
            {heldItem && (
              <div
                ref={heldRef} className={`chat-pick-held${heldBelow ? ' is-below' : ''}`} role="dialog" aria-label={heldItem.name}
                style={{ top: heldBelow ? held!.bottom + 6 : held!.top - 6 }}
              >
                <p><b>{heldItem.name}</b>{heldItem.description}</p>
                {heldItem.direct && onDirect && (
                  <button type="button" onClick={() => { close(); onDirect(heldItem.id) }}>
                    <MessageCircle size={15} />{directLabel} {heldItem.name}
                  </button>
                )}
              </div>
            )}
          </div>
        </div>,
        document.body,
      )}
    </>
  )
}
