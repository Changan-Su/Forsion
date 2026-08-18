/**
 * Genesis Mini Card:独立的桌面悬浮工作面,只复用单列工作区的数据与 Leaf 渲染。
 *
 * Mini 不是缩小版 mobile shell。它刻意不挂左右抽屉、双层顶栏和全屏 bottom sheet:
 * - 44px 单层 chrome 同时承载 Space、当前标签、标签切换、更多与关闭;
 * - Space / 标签 / 更多均使用卡内锚定面板,不推挤主内容;
 * - feature 视图原样复用,mini 专属密度与聊天几何在 miniCard.css 收口。
 */
import { useEffect, useState } from 'react'
import { ChevronDown, Layers3, MoreHorizontal, Plus, X } from 'lucide-react'
import { getActiveSpace, setActiveSpace, useSpaceStore } from './spaceRegistry'
import { useRibbonStore } from './ribbonRegistry'
import { getView } from './viewRegistry'
import { label } from './types'
import { restoreSingleColumnLayout, useWorkspace } from './singleColumnStore'
import { LeafHost } from './SingleColumnHost'
import './miniCard.css'

type MiniPanel = 'spaces' | 'tabs' | 'more' | null

function useMiniWorkspace(buildDefault?: () => void): void {
  useEffect(() => {
    const ws = useWorkspace.getState()
    if (buildDefault) ws.setDefaultBuilder(buildDefault)
    if (ws.mainLeaves.length === 0 && !restoreSingleColumnLayout()) buildDefault?.()
    ws.refreshTabs()
  }, [buildDefault])
}

function MiniSpacePanel({ onClose }: { onClose: () => void }) {
  const spaces = useSpaceStore((s) => s.spaces)
  const activeId = useSpaceStore((s) => s.activeSpaceId)
  const zh = document.documentElement.lang.startsWith('zh')
  return (
    <section className="mini-card-popover" aria-label={zh ? '切换空间' : 'Switch space'}>
      <div className="mini-card-popover-title">{zh ? '空间' : 'Spaces'}</div>
      <div className="mini-card-popover-list">
        {spaces.map((space) => {
          const Icon = space.icon
          const active = space.id === activeId || (!spaces.some((x) => x.id === activeId) && space === spaces[0])
          return (
            <button
              key={space.id}
              className={`mini-card-row${active ? ' active' : ''}`}
              onClick={() => { setActiveSpace(space.id); onClose() }}
            >
              {Icon ? <Icon size={15} /> : <span className="mini-card-row-fallback" />}
              <span className="mini-card-row-label">{label(space.name)}</span>
              {active ? <span className="mini-card-row-current" aria-hidden="true" /> : null}
            </button>
          )
        })}
      </div>
    </section>
  )
}

function MiniTabsPanel({ onClose }: { onClose: () => void }) {
  const tabs = useWorkspace((s) => s.mainTabs)
  const zh = document.documentElement.lang.startsWith('zh')
  const newTab = (): void => {
    const space = getActiveSpace()
    if (space?.newPage) space.newPage()
    else useWorkspace.getState().openView('launcher', {}, 'main', { newTab: true })
    onClose()
  }
  return (
    <section className="mini-card-popover" aria-label={zh ? '标签页' : 'Tabs'}>
      <div className="mini-card-popover-title">{zh ? '标签页' : 'Tabs'}</div>
      <div className="mini-card-popover-list">
        {tabs.map((tab) => {
          const Icon = getView(tab.type)?.icon
          return (
            <div
              key={tab.id}
              role="button"
              tabIndex={0}
              className={`mini-card-row${tab.active ? ' active' : ''}`}
              onClick={() => { useWorkspace.getState().activateLeaf(tab.id); onClose() }}
              onKeyDown={(event) => {
                if (event.key === 'Enter' || event.key === ' ') {
                  event.preventDefault()
                  useWorkspace.getState().activateLeaf(tab.id)
                  onClose()
                }
              }}
            >
              {Icon ? <Icon size={15} /> : <span className="mini-card-row-fallback" />}
              <span className="mini-card-row-label">{tab.title}</span>
              {tab.closable && tabs.length > 1 ? (
                <button
                  className="mini-card-row-close"
                  aria-label={zh ? '关闭标签页' : 'Close tab'}
                  onClick={(event) => { event.stopPropagation(); useWorkspace.getState().closeLeaf(tab.id) }}
                >
                  <X size={13} />
                </button>
              ) : null}
            </div>
          )
        })}
        <button className="mini-card-row mini-card-row-new" onClick={newTab}>
          <Plus size={15} />
          <span className="mini-card-row-label">{zh ? '新建标签页' : 'New tab'}</span>
        </button>
      </div>
    </section>
  )
}

function MiniMorePanel({ onClose }: { onClose: () => void }) {
  const items = useRibbonStore((s) => s.items).filter((item) => item.side === 'bottom' && item.id !== 'rb-account')
  const zh = document.documentElement.lang.startsWith('zh')
  return (
    <section className="mini-card-popover" aria-label={zh ? '更多操作' : 'More actions'}>
      <div className="mini-card-popover-title">{zh ? '更多' : 'More'}</div>
      <div className="mini-card-popover-list">
        {items.map((item) => {
          const Icon = item.icon
          const Component = item.component
          if (Component) return <div key={item.id} className="mini-card-component-row"><Component expanded /></div>
          return (
            <button key={item.id} className="mini-card-row" onClick={() => { item.onClick?.(); onClose() }}>
              {Icon ? <Icon size={15} /> : <span className="mini-card-row-fallback" />}
              <span className="mini-card-row-label">{item.tooltip ? label(item.tooltip) : item.id}</span>
            </button>
          )
        })}
      </div>
    </section>
  )
}

export const MiniColumnHost: React.FC<{ buildDefault?: () => void }> = ({ buildDefault }) => {
  useMiniWorkspace(buildDefault)
  const spaces = useSpaceStore((s) => s.spaces)
  const activeSpaceId = useSpaceStore((s) => s.activeSpaceId)
  const activeSpace = spaces.find((space) => space.id === activeSpaceId) ?? spaces[0]
  const tabs = useWorkspace((s) => s.mainTabs)
  const activeTitle = tabs.find((tab) => tab.active)?.title || ''
  const [panel, setPanel] = useState<MiniPanel>(null)
  const zh = document.documentElement.lang.startsWith('zh')
  const SpaceIcon = activeSpace?.icon

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setPanel(null)
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [])

  const toggle = (next: Exclude<MiniPanel, null>): void => setPanel((current) => current === next ? null : next)
  const closePanel = (): void => setPanel(null)

  return (
    <div className="mini-card-shell" data-panel={panel || undefined}>
      <header className="mini-card-chrome">
        <button
          className="mini-card-space"
          aria-label={zh ? '切换空间' : 'Switch space'}
          aria-expanded={panel === 'spaces'}
          disabled={spaces.length < 2}
          onClick={() => toggle('spaces')}
        >
          {SpaceIcon ? <SpaceIcon size={15} /> : null}
          <span>{activeSpace ? label(activeSpace.name) : 'Forsion'}</span>
          {spaces.length > 1 ? <ChevronDown size={12} /> : null}
        </button>

        <div className="mini-card-drag-title" title={activeTitle}>{activeTitle}</div>

        <button
          className="mini-card-action"
          aria-label={zh ? '标签页' : 'Tabs'}
          aria-expanded={panel === 'tabs'}
          onClick={() => toggle('tabs')}
        >
          <Layers3 size={15} />
          <span className="mini-card-tab-count">{tabs.length || 1}</span>
        </button>
        <button
          className="mini-card-action"
          aria-label={zh ? '更多' : 'More'}
          aria-expanded={panel === 'more'}
          onClick={() => toggle('more')}
        >
          <MoreHorizontal size={17} />
        </button>
        <button className="mini-card-action mini-card-close" aria-label={zh ? '关闭 Mini 卡片' : 'Close mini card'} onClick={() => window.tangu?.closeSelf?.()}>
          <X size={15} />
        </button>
      </header>

      <main className="mb-main mini-card-main"><LeafHost /></main>

      {panel ? <button className="mini-card-dismiss" aria-label={zh ? '关闭菜单' : 'Close menu'} onClick={closePanel} /> : null}
      {panel === 'spaces' ? <MiniSpacePanel onClose={closePanel} /> : null}
      {panel === 'tabs' ? <MiniTabsPanel onClose={closePanel} /> : null}
      {panel === 'more' ? <MiniMorePanel onClose={closePanel} /> : null}
    </div>
  )
}
