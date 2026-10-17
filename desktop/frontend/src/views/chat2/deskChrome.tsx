/** Agent Desk 展开态的悬浮胶囊(10-17 用户选方案 B,方案页 docs/ToBeImproved/AgentDesk方案_2026-10-17/)。
 *  格子里的视图不再画自己的顶栏:WsFileView 读到本 context 就把视图专属控件(编辑/源码、换行、缩放…)
 *  portal 进胶囊槽,次要动作写进 more(⋯ 菜单打开那一刻才读,写 ref 不触发重渲染)。 */
import React, { createContext, useState } from 'react'
import { MoreHorizontal } from 'lucide-react'
import { ContextMenu, type CtxItem, type CtxMenu } from '../../components/RightPanel'
import { useI18n } from '../../i18n'

export interface DeskChrome {
  /** 胶囊里给视图留的槽;首帧为 null(ref 还没挂上),视图此时什么都不画,也不画自带顶栏。 */
  slot: HTMLElement | null
  more: { current: CtxItem[] }
}
export const DeskChromeContext = createContext<DeskChrome | null>(null)

/** 菜单从按钮下沿弹出;items 是函数 —— 点开那一刻才求值(视图的 more 写在 ref 里)。 */
export function DeskMenuButton({ items, title, className, children }: {
  items: () => CtxItem[]; title: string; className?: string; children: React.ReactNode
}): React.ReactElement {
  const [menu, setMenu] = useState<CtxMenu>(null)
  return (
    <>
      <button
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
      {menu && <ContextMenu menu={menu} onClose={() => setMenu(null)} autoFocus />}
    </>
  )
}

export function DeskMoreButton({ items }: { items: () => CtxItem[] }): React.ReactElement {
  const { t } = useI18n()
  return <DeskMenuButton items={items} title={t('desk.more')}><MoreHorizontal size={14} /></DeskMenuButton>
}
