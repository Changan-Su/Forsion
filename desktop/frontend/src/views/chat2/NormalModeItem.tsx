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
import { nestedPanelPlacement, nestedPanelTop, UI_ZOOM_EVENT, useEdgeNudge, zoomOf, type NestedPanelPlacement } from '@lcl/engine'
import { useI18n } from '../../i18n'
import type { NormalAgentDef } from '../../types'

export function NormalModeItem({ active, disabled, agents, currentAgentSlug, onNormalWork, onAgentSwitch, onClose }: {
  active: boolean
  disabled?: boolean
  agents: NormalAgentDef[]
  currentAgentSlug?: string
  onNormalWork: () => void
  /** 不给(群聊态 / 引擎会话 / 空白会话)= 没有二级面板,行退回单按钮。 */
  onAgentSwitch?: (slug: string) => void
  onClose: () => void
}): React.ReactElement {
  const { t } = useI18n()
  const [open, setOpen] = useState(false)
  const [placement, setPlacement] = useState<NestedPanelPlacement>('right')
  const [subTop, setSubTop] = useState(0)
  const rowRef = useRef<HTMLDivElement>(null)
  const subRef = useRef<HTMLDivElement>(null)
  const subFix = useEdgeNudge(open ? placement : '', { boundary: '.t2-chat-view' })
  const list = agents.filter((a) => a.createdBy !== 'system')
  const openSub = onAgentSwitch && list.length ? () => setOpen(true) : undefined
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
      <button className={`menu-item${active ? ' active' : ''}`} data-normal-work disabled={disabled} onClick={() => { onNormalWork(); onClose() }}>
        <Bot size={14} /><span className="grow">{t('input.normalWork')}</span>
        {active && <Check size={13} />}
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
          {list.map((a) => (
            <button key={a.slug} role="menuitemradio" aria-checked={currentAgentSlug === a.slug}
              className={`menu-item${currentAgentSlug === a.slug ? ' active' : ''}`}
              onClick={() => { onAgentSwitch!(a.slug); onClose() }}>
              <Bot size={14} /><span className="grow">{a.name}</span>
              {currentAgentSlug === a.slug && <Check size={13} />}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
