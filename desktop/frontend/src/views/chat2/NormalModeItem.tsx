/**
 * 模式菜单的「普通模式」行 + 二级 Agent 面板(09-22 用户:可切换的 Agent 平铺在模式菜单里太长,收进普通模式)。
 *
 * 行本身 = 切回普通模式(`data-normal-work`,语义不变);右侧「当前 Agent ›」悬停 / 聚焦 / 点击展开 `.cm-sub`,
 * 选中 = 对话中切换 Agent(拍板 ⑪,只换人,不动计划 / 团队 / 审批档)。触屏没有悬停,右侧那枚是它唯一的入口。
 * 二级面板落位与 ModelPill 同一套:横向 右 → 左 → 叠在菜单上方,纵向贴触发行、越界向上夹。
 * 面板挂在行容器里、行容器**不定位** —— 包含块仍是 `.composer-menu--mode`,genesis-glass 已为它的二级浮面走 ::before 材质代理。
 */
import React, { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { Bot, Check, ChevronRight } from 'lucide-react'
import { nestedPanelPlacement, nestedPanelTop, UI_ZOOM_EVENT, useEdgeNudge, zoomOf, type NestedPanelPlacement, type SheetMenuItem } from '@lcl/engine'
import { useI18n } from '../../i18n'
import type { NormalAgentDef } from '../../types'

interface NormalModeProps {
  active: boolean
  disabled?: boolean
  agents: NormalAgentDef[]
  currentAgentSlug?: string
  onNormalWork: () => void
  /** 不给(群聊态 / 引擎会话 / 空白会话)= 没有二级面板,行退回单按钮。 */
  onAgentSwitch?: (slug: string) => void
  onClose: () => void
}

/** 「普通模式」行 + 「切换 Agent」二级的唯一一份条目:Web 行 / 浮出面板与 Android 原生半屏(二级 = 推入页)共用。
 *  `agentSwitch` 为 null = 没有二级(同 Web:没给 onAgentSwitch 或名册里没有可切换的 Agent)。 */
export function normalModeItems(p: NormalModeProps, t: ReturnType<typeof useI18n>['t']): { normal: SheetMenuItem; agentSwitch: SheetMenuItem | null; agents: SheetMenuItem[] } {
  const list = p.agents.filter((a) => a.createdBy !== 'system')
  const current = p.agents.find((a) => a.slug === p.currentAgentSlug)
  const normal: SheetMenuItem = {
    id: 'normal-work', label: t('input.normalWork'), icon: <Bot size={14} />, checked: p.active, disabled: p.disabled,
    run: () => { p.onNormalWork(); p.onClose() },
  }
  const agents: SheetMenuItem[] = p.onAgentSwitch ? list.map((a) => ({
    id: `agent:${a.slug}`, label: a.name, icon: <Bot size={14} />, checked: p.currentAgentSlug === a.slug,
    run: () => { p.onAgentSwitch!(a.slug); p.onClose() },
  })) : []
  const agentSwitch: SheetMenuItem | null = agents.length ? {
    id: 'agent-switch', label: t('input.agentSwitch.section'), detail: current?.name, icon: <Bot size={14} />,
    children: [{ items: agents }],
  } : null
  return { normal, agentSwitch, agents }
}

export function NormalModeItem(props: NormalModeProps): React.ReactElement {
  const { currentAgentSlug, agents } = props
  const { t } = useI18n()
  const [open, setOpen] = useState(false)
  const [placement, setPlacement] = useState<NestedPanelPlacement>('right')
  const [subTop, setSubTop] = useState(0)
  const rowRef = useRef<HTMLDivElement>(null)
  const subRef = useRef<HTMLDivElement>(null)
  const subFix = useEdgeNudge(open ? placement : '', { boundary: '.t2-chat-view' })
  const items = normalModeItems(props, t)
  const openSub = items.agentSwitch ? () => setOpen(true) : undefined
  const current = agents.find((a) => a.slug === currentAgentSlug)

  useLayoutEffect(() => {
    const row = rowRef.current
    const sub = subRef.current
    const menu = row?.closest<HTMLElement>('.composer-menu')
    if (!open || !row || !sub || !menu) return
    const update = (): void => {
      const menuRect = menu.getBoundingClientRect()
      const boundaryRect = (menu.closest('.t2c-card') || menu.closest('.t2-chat-view'))?.getBoundingClientRect()
      const viewRect = menu.closest('.t2-chat-view')?.getBoundingClientRect()
      const zoom = zoomOf(sub)
      const next = boundaryRect
        ? nestedPanelPlacement(menuRect.left, menuRect.right, sub.offsetWidth, boundaryRect.left, boundaryRect.right, zoom)
        : 'right'
      setPlacement((prev) => prev === next ? prev : next)
      const nextTop = nestedPanelTop(row.getBoundingClientRect().top, sub.offsetHeight, menuRect.top, menuRect.bottom, viewRect?.top ?? 0, viewRect?.bottom ?? window.innerHeight, zoom)
      setSubTop((prev) => Math.abs(prev - nextTop) < 0.5 ? prev : nextTop)
    }
    update()
    window.addEventListener('resize', update)
    window.addEventListener(UI_ZOOM_EVENT, update)
    const ro = new ResizeObserver(update)
    ro.observe(menu)
    ro.observe(sub)
    const boundary = menu.closest('.t2c-card') || menu.closest('.t2-chat-view')
    if (boundary) ro.observe(boundary)
    return () => {
      window.removeEventListener('resize', update)
      window.removeEventListener(UI_ZOOM_EVENT, update)
      ro.disconnect()
    }
  }, [open])

  // 指针移到 / Tab 到菜单里别的行就收起:审批行的说明浮层也从右侧出,两层不能叠。行与面板之间的空隙不是「行」,不算离开。
  useEffect(() => {
    const menu = rowRef.current?.closest('.composer-menu')
    if (!open || !menu) return
    const leave = (e: Event): void => {
      const item = (e.target as Element | null)?.closest?.('.menu-item')
      if (item && !rowRef.current?.contains(item)) setOpen(false)
    }
    menu.addEventListener('pointerover', leave)
    menu.addEventListener('focusin', leave)
    return () => {
      menu.removeEventListener('pointerover', leave)
      menu.removeEventListener('focusin', leave)
    }
  }, [open])

  return (
    <div ref={rowRef} className="mode-normal-row" onPointerEnter={openSub}>
      <button className={`menu-item${items.normal.checked ? ' active' : ''}`} data-normal-work disabled={items.normal.disabled} onClick={items.normal.run}>
        {items.normal.icon}<span className="grow">{items.normal.label}</span>
        {items.normal.checked && <Check size={13} />}
      </button>
      {openSub && (
        <button className="menu-item mode-agent-trigger" data-agent-switch aria-haspopup="menu" aria-expanded={open}
          title={t('input.agentSwitch.section')} onFocus={openSub} onClick={openSub}>
          {current && <span className="mode-agent-name">{current.name}</span>}
          <ChevronRight size={13} />
        </button>
      )}
      {open && openSub && (
        <div
          ref={(el) => { subRef.current = el; subFix.ref.current = el }}
          className={`cm-sub ${placement}`}
          data-pane="agents"
          role="menu"
          style={{ ...subFix.style, '--cm-sub-top': `${subTop}px` } as React.CSSProperties}
        >
          <div className="menu-section">{t('input.agentSwitch.section')}</div>
          {items.agents.map((it) => (
            <button key={it.id} role="menuitemradio" aria-checked={!!it.checked}
              className={`menu-item${it.checked ? ' active' : ''}`}
              onClick={it.run}>
              {it.icon}<span className="grow">{it.label}</span>
              {it.checked && <Check size={13} />}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
