/** Agent Desk 展开态的悬浮胶囊(10-17 用户选方案 B,方案页 docs/ToBeImproved/AgentDesk方案_2026-10-17/)。
 *  胶囊上的菜单钮在这里;给被托管视图的契约(DeskChromeContext)住在宿主的 tanguSeam(核心插件化 2e-6:文件视图是宿主的),这里转出。 */
import React, { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { MoreHorizontal } from 'lucide-react'
import { OverlayAt } from '@lcl/engine'
import { ContextMenu, type CtxItem, type CtxMenu } from '../../components/RightPanel'
import { useI18n } from '../../i18n'
export { DeskChromeContext, type DeskChrome } from '../../amadeus/plugins/tanguSeam'

/** 菜单从按钮下沿弹出;items 是函数 —— 点开那一刻才求值(视图的 more 写在 ref 里)。 */
export function DeskMenuButton({ items, title, className, children }: {
  items: () => CtxItem[]; title: string; className?: string; children: React.ReactNode
}): React.ReactElement {
  const [menu, setMenu] = useState<CtxMenu>(null)
  const btn = useRef<HTMLButtonElement>(null)
  return (
    <>
      <button
        ref={btn}
        type="button"
        className={className ?? 'icon-btn'}
        title={title}
        aria-haspopup="menu"
        aria-expanded={!!menu}
        onClick={(e) => {
          const list = items()
          if (!list.length) return
          const r = e.currentTarget.getBoundingClientRect()
          setMenu({ x: r.left, y: r.bottom + 4, items: list })
        }}
      >
        {children}
      </button>
      {/* 菜单 autoFocus 把焦点拿进 portal;关掉后还给按钮,键盘用户不掉回 body */}
      {menu && <ContextMenu menu={menu} onClose={() => { setMenu(null); btn.current?.focus({ preventScroll: true }) }} autoFocus />}
    </>
  )
}

export function DeskMoreButton({ items }: { items: () => CtxItem[] }): React.ReactElement {
  const { t } = useI18n()
  return <DeskMenuButton items={items} title={t('desk.more')}><MoreHorizontal size={14} /></DeskMenuButton>
}

/** ▾ 选择菜单的一行:小节标题 / 可选的一行(hint = 行尾淡字,dot = 行首小圆点)。 */
export type DeskPickRow =
  | { head: string; separatorBefore?: boolean }
  | { label: string; hint?: string; dot?: boolean; disabled?: boolean; separatorBefore?: boolean; run: () => void }

/** 名字胶囊上的 ▾:这是**选择菜单**不是操作菜单(DESIGN §3「菜单几何」)—— 224px(--menu-select-width)、
 *  长名省略、分组小标题走 .ctx-head。外壳沿用 .ctx-menu(材质表已登记)。onOpen:打开那一刻(清 ▾ 上的点)。 */
export function DeskPickButton({ rows, title, className, onOpen, children }: {
  rows: () => DeskPickRow[]; title: string; className?: string; onOpen?: () => void; children: React.ReactNode
}): React.ReactElement {
  const [menu, setMenu] = useState<{ x: number; y: number; top: number; rows: DeskPickRow[] } | null>(null)
  const btn = useRef<HTMLButtonElement>(null)
  const panel = useRef<HTMLDivElement | null>(null)
  const close = (): void => { setMenu(null); btn.current?.focus({ preventScroll: true }) }
  useEffect(() => {
    if (!menu) return
    const armed = performance.now()
    const out = (e: Event): void => { if (e.timeStamp >= armed && !panel.current?.contains(e.target as Node)) setMenu(null) }
    window.addEventListener('pointerdown', out)
    window.addEventListener('blur', out)
    panel.current?.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus({ preventScroll: true })
    return () => { window.removeEventListener('pointerdown', out); window.removeEventListener('blur', out) }
  }, [menu])
  return (
    <>
      <button
        ref={btn}
        type="button"
        className={className ?? 'icon-btn'}
        title={title}
        aria-haspopup="menu"
        aria-expanded={!!menu}
        onClick={(e) => {
          const list = rows()
          if (!list.length) return
          const r = e.currentTarget.getBoundingClientRect()
          onOpen?.()
          setMenu({ x: r.left, y: r.bottom + 4, top: r.top, rows: list })
        }}
      >
        {children}
      </button>
      {menu && createPortal(
        <OverlayAt
          innerRef={(el) => { panel.current = el }}
          className="ctx-menu desk-pick-menu"
          role="menu"
          x={menu.x}
          y={menu.y}
          anchorTop={menu.top}
          onPointerDown={(e) => e.stopPropagation()}
          onContextMenu={(e) => { e.preventDefault(); e.stopPropagation() }}
          onKeyDown={(e) => {
            if (e.key === 'Escape' || e.key === 'Tab') { e.preventDefault(); e.stopPropagation(); close(); return }
            if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(e.key)) return
            e.preventDefault(); e.stopPropagation()
            const bs = Array.from(e.currentTarget.querySelectorAll<HTMLButtonElement>('button:not(:disabled)'))
            const i = bs.indexOf(document.activeElement as HTMLButtonElement)
            const n = e.key === 'Home' ? 0 : e.key === 'End' ? bs.length - 1 : (i + (e.key === 'ArrowDown' ? 1 : -1) + bs.length) % bs.length
            bs[n]?.focus()
          }}
        >
          {menu.rows.map((row, i) => (
            <React.Fragment key={i}>
              {row.separatorBefore && <div className="ctx-separator" role="separator" />}
              {'head' in row ? <div className="ctx-head" role="presentation">{row.head}</div> : (
                <button type="button" role="menuitem" className="ctx-item" disabled={row.disabled} aria-label={row.hint ? `${row.label} · ${row.hint}` : row.label} title={row.label}
                  onClick={() => { close(); row.run() }}>
                  {row.dot && <span className="desk-pick-dot" aria-hidden="true" />}
                  <span className="desk-pick-label">{row.label}</span>
                  {row.hint && <span className="ctx-shortcut desk-pick-hint" aria-hidden="true">{row.hint}</span>}
                </button>
              )}
            </React.Fragment>
          ))}
        </OverlayAt>,
        document.body,
      )}
    </>
  )
}
