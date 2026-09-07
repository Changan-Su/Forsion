/** One dedicated Space surface; no desktop layout, tabs, ribbon or mobile chrome. */
import { Suspense, useEffect, useReducer, useState } from 'react'
import { ChevronDown, ExternalLink, X } from 'lucide-react'
import { getActiveSpace, setActiveSpace, setActiveSpaceCold, useSpaceStore } from './spaceRegistry'
import { getView, subscribeViews } from './viewRegistry'
import { label } from './types'
import { useWorkspace } from './singleColumnStore'
import { supportsMiniPanel, showInMainPanel } from './miniPanel'
import { ViewErrorBoundary } from './Skeleton'
import './miniCard.css'

export const MiniColumnHost: React.FC<{ buildDefault: () => void }> = ({ buildDefault }) => {
  const registered = useSpaceStore((s) => s.spaces)
  const activeId = useSpaceStore((s) => s.activeSpaceId)
  const [, refreshViews] = useReducer((n) => n + 1, 0)
  useEffect(() => subscribeViews(refreshViews), [])
  const spaces = registered.filter(supportsMiniPanel)
  const space = spaces.find((s) => s.id === activeId)
  const active = useWorkspace((s) => s.mainLeaves.find((r) => r.id === s.activeMainId))
  const [menu, setMenu] = useState(false)
  const zh = document.documentElement.lang.startsWith('zh')
  const Icon = space?.icon
  const name = space ? label(space.mini?.name ?? space.name) : 'Mini Panel'

  useEffect(() => {
    const ws = useWorkspace.getState()
    ws.setDefaultBuilder(buildDefault)
    if (!space) {
      const fallback = spaces.find((s) => s.id === 'tangu') ?? spaces[0]
      if (fallback) setActiveSpaceCold(fallback.id)
      ws.resetLayout()
    } else if (ws.getActiveLeaf()?.type !== space.mini!.view.type) ws.resetLayout()
    // Registry changes include plugin enable/disable and removal of an adapter view.
  }, [registered, activeId, space, buildDefault])
  useEffect(() => {
    const escape = (e: KeyboardEvent): void => { if (e.key === 'Escape') setMenu(false) }
    window.addEventListener('keydown', escape)
    return () => window.removeEventListener('keydown', escape)
  }, [])

  const leaf = active && space && active.type === space.mini!.view.type ? useWorkspace.getState().getActiveLeaf() : null
  const view = leaf ? getView(leaf.type) : null
  const showMain = (): void => {
    const current = getActiveSpace()
    if (!current?.mini) return
    showInMainPanel({ spaceId: current.id, type: current.mini.mainView.type,
      params: { ...current.mini.mainView.params, ...useWorkspace.getState().getActiveLeaf()?.params } })
  }
  return (
    <div className="mini-card-shell" data-space={space?.id}>
      <header className="mini-card-chrome">
        <button className="mini-card-space" aria-label={zh ? '切换空间' : 'Switch space'} aria-expanded={menu}
          disabled={spaces.length < 2} onClick={() => setMenu(!menu)}>
          {Icon && <Icon size={15} />}<span>{name}</span>{spaces.length > 1 && <ChevronDown size={12} />}
        </button>
        <div className="mini-card-drag-title" />
        <button className="mini-card-action" aria-label={zh ? '在主面板显示' : 'Show in main panel'}
          title={zh ? '在主面板显示' : 'Show in main panel'} disabled={!space} onClick={showMain}><ExternalLink size={15} /></button>
        <button className="mini-card-action mini-card-close" aria-label={zh ? '关闭 Mini Panel' : 'Close Mini Panel'}
          onClick={() => window.tangu?.closeSelf?.()}><X size={15} /></button>
      </header>
      <main className="mini-card-main">
        {leaf && view ? <div className="mini-panel-view" data-view={leaf.type} key={`${leaf.id}:${leaf.type}`}>
          <ViewErrorBoundary><Suspense fallback={null}>{view.factory({ leaf, params: leaf.params })}</Suspense></ViewErrorBoundary>
        </div> : <div className="mini-panel-empty">{zh ? '暂无已适配的空间' : 'No Mini Panel spaces available'}</div>}
      </main>
      {menu && <>
        <button className="mini-card-dismiss" aria-label={zh ? '关闭菜单' : 'Close menu'} onClick={() => setMenu(false)} />
        <section className="mini-card-popover" aria-label={zh ? '切换空间' : 'Switch space'}>
          <div className="mini-card-popover-list">{spaces.map((item) => {
            const ItemIcon = item.icon
            return <button key={item.id} className={`mini-card-row${item.id === activeId ? ' active' : ''}`}
              onClick={() => { setActiveSpace(item.id); setMenu(false) }}>
              {ItemIcon && <ItemIcon size={15} />}<span className="mini-card-row-label">{label(item.mini!.name ?? item.name)}</span>
            </button>
          })}</div>
        </section>
      </>}
    </div>
  )
}
