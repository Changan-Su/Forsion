import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { Check, ChevronDown, MessageCircle } from 'lucide-react'
import { OverlayAt, UI_ZOOM_EVENT } from '@lcl/engine'
import { registerMessages } from '../i18n'
import './compactChatPicker.css'

registerMessages({
  'chatPicker.engine': { zh: '引擎', en: 'Engine' },
  'chatPicker.agent': { zh: 'Agent', en: 'Agent' },
  'chatPicker.team': { zh: '团队', en: 'Team' },
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
}

/**
 * 窄栏(≤520px 容器查询)里选择条折成的单枚芯片。点开:
 *  - 调用方 `onNative` 接管(安卓原生外壳的勾选清单 / 菜单)→ 不画网页面;
 *  - 触屏(pointer: coarse)→ 贴底抽屉;否则 → 芯片上方的浮层(.ctx-menu 外壳)。
 * 两种网页面共用同一份行:头像 + 名字 + 勾 / 序号,简介不进行。点行切换,`closeOnPick` 说了算才收起
 * (多选的 Agent 条点一下不收,和宽栏头像条同一套「再点取消、点第二个组队」)。
 */
export function CompactChatPicker({
  label, title, icon, name, status, items, onPick, closeOnPick, onDirect, directLabel, onNative, busy = false,
}: {
  /** 芯片前缀(Agent / 团队 / 引擎)。 */
  label: string
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
  busy?: boolean
}) {
  const chipRef = useRef<HTMLButtonElement>(null)
  const surfaceRef = useRef<HTMLDivElement | null>(null)
  const [open, setOpen] = useState<null | 'popover' | 'sheet'>(null)
  const [hover, setHover] = useState<string | null>(null)
  const [held, setHeld] = useState<{ id: string; top: number; bottom: number } | null>(null)
  const heldRef = useRef<HTMLDivElement>(null)
  const [heldBelow, setHeldBelow] = useState(false)
  const [anchor, setAnchor] = useState({ x: 0, y: 0, top: 0 })

  const openWeb = (): void => setOpen(window.matchMedia?.('(pointer: coarse)').matches ? 'sheet' : 'popover')
  const toggleOpen = (): void => {
    if (open) { setOpen(null); return }
    if (onNative?.(openWeb)) return
    openWeb()
  }
  const close = (refocus = false): void => {
    setOpen(null); setHover(null); setHeld(null)
    if (refocus) chipRef.current?.focus()
  }
  const pick = (item: ChatPickItem): void => {
    if (item.disabled) return
    onPick(item.id)
    if (closeOnPick?.(item.id)) close(open === 'popover')
  }

  // 浮层贴芯片上方、右对齐;芯片随输入区移动(窗口缩放 / 滚动 / 界面缩放)时跟着走。
  useLayoutEffect(() => {
    if (open !== 'popover') return
    const update = (): void => {
      const r = chipRef.current?.getBoundingClientRect()
      if (!r) return
      const w = surfaceRef.current?.offsetWidth || 252
      const next = { x: r.right - w, y: r.bottom + 6, top: r.top - 6 }
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
    const onDown = (e: PointerEvent): void => {
      const t = e.target as Node
      if (!chipRef.current?.contains(t) && !surfaceRef.current?.contains(t)) close()
    }
    const onKey = (e: KeyboardEvent): void => { if (e.key === 'Escape') { e.stopPropagation(); close(true) } }
    document.addEventListener('pointerdown', onDown, true)
    document.addEventListener('keydown', onKey, true)
    // 打开时焦点落到已选的第一项(没有就第一项),键盘直接上下挑
    const first = surfaceRef.current?.querySelector<HTMLElement>('[role="option"][aria-selected="true"]:not(:disabled)')
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

  const describedId = hover ?? items.find((i) => i.mark)?.id
  const described = items.find((i) => i.id === describedId && i.description)
  const hasDescriptions = items.some((i) => i.description)

  const rows = (sheet: boolean): ReactNode => items.map((item, i) => {
    const head = item.section && item.section !== items[i - 1]?.section
    return [
      head && <div key={`h:${item.section}`} className="chat-pick-section">{item.section}</div>,
      <button
        key={item.id || '__default'}
        type="button"
        role="option"
        aria-selected={!!item.mark}
        disabled={item.disabled}
        className={`chat-pick-row${item.mark ? ' is-picked' : ''}${held?.id === item.id ? ' is-held' : ''}`}
        data-pick-id={item.id}
        title={sheet ? undefined : item.description}
        onClick={() => { if (!held) pick(item) }} // 卡片开着时点哪都只是收卡片(列表上的 onClick 收)
        onPointerEnter={sheet ? undefined : () => setHover(item.id)}
        onFocus={sheet ? undefined : () => setHover(item.id)}
        // 触屏长按在 Chromium 上发 contextmenu:抽屉里 = 简介 + 私聊卡片
        onContextMenu={sheet && (item.description || (item.direct && onDirect)) ? (e) => {
          e.preventDefault()
          const sheetTop = surfaceRef.current?.getBoundingClientRect().top ?? 0
          const r = e.currentTarget.getBoundingClientRect()
          setHeld({ id: item.id, top: r.top - sheetTop, bottom: r.bottom - sheetTop })
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
        className="compact-chat-picker"
        aria-busy={busy || undefined}
        aria-haspopup="listbox"
        aria-expanded={!!open}
        aria-label={`${title}: ${name}`}
        title={name}
        onClick={toggleOpen}
        onKeyDown={(e) => { if (e.key === 'ArrowDown' && !open) { e.preventDefault(); toggleOpen() } }}
      >
        <span className="compact-chat-picker-kind">{label}</span>
        <span className="compact-chat-picker-icon">{icon}</span>
        <span className="compact-chat-picker-name">{name}</span>
        <ChevronDown size={13} />
      </button>
      {open === 'popover' && createPortal(
        <div className="ui-popover-backdrop" style={{ pointerEvents: 'none' }} data-cmenu>
          <OverlayAt
            x={anchor.x} y={anchor.y} anchorTop={anchor.top} prefer="above"
            innerRef={(el) => { surfaceRef.current = el }}
            className="ctx-menu chat-pick-pop"
            style={{ pointerEvents: 'auto' }}
            role="listbox" aria-multiselectable aria-label={title}
            onKeyDown={onListKey}
            onPointerLeave={() => setHover(null)}
          >
            {status && <div className="chat-pick-status">{status}</div>}
            <div className="ctx-menu-scroll">{rows(false)}</div>
            {hasDescriptions && (
              <>
                <div className="ctx-separator" />
                <div className="chat-pick-desc" aria-live="polite">
                  {described && <><b>{described.name}</b>{described.description}</>}
                </div>
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
            <div className="chat-pick-list" onClick={() => setHeld(null)}>{rows(true)}</div>
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
