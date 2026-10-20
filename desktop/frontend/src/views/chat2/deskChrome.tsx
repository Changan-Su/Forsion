/** Agent Desk 展开态的悬浮胶囊(10-17 用户选方案 B,方案页 docs/ToBeImproved/AgentDesk方案_2026-10-17/)。
 *  胶囊上的菜单钮在这里;给被托管视图的契约(DeskChromeContext)住在宿主的 tanguSeam(核心插件化 2e-6:文件视图是宿主的),这里转出。 */
import React, { useRef, useState } from 'react'
import { MoreHorizontal } from 'lucide-react'
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
