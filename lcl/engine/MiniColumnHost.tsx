/** One dedicated Space surface; no desktop layout, tabs, ribbon or mobile chrome. */
import { Suspense, useEffect, useReducer, useRef, useState } from 'react'
import { ChevronDown, ExternalLink, X } from 'lucide-react'
import { getActiveSpace, setActiveSpace, setActiveSpaceCold, useSpaceStore } from './spaceRegistry'
import { getView, subscribeViews } from './viewRegistry'
import { label } from './types'
import { useWorkspace } from './singleColumnStore'
import { supportsMiniPanel, showInMainPanel } from './miniPanel'
import { ViewErrorBoundary } from './Skeleton'
import './miniCard.css'
import { useEngineI18n } from './i18nSeam'

interface DirectMiniViewTarget { type: string; params?: Record<string, unknown> }

export const MiniColumnHost: React.FC<{
  buildDefault: () => void
  direct?: { title?: string; view: DirectMiniViewTarget; mainView: DirectMiniViewTarget } | null
}> = ({ buildDefault, direct }) => {
  const registered = useSpaceStore((s) => s.spaces)
  const activeId = useSpaceStore((s) => s.activeSpaceId)
  const [, refreshViews] = useReducer((n) => n + 1, 0)
  useEffect(() => subscribeViews(refreshViews), [])
  const spaces = registered.filter(supportsMiniPanel)
  const space = spaces.find((s) => s.id === activeId)
  const active = useWorkspace((s) => s.mainLeaves.find((r) => r.id === s.activeMainId))
  const [menu, setMenu] = useState(false)
  const { t } = useEngineI18n()
  const Icon = space?.icon
  const directDef = direct ? getView(direct.view.type) : undefined
  const directSeen = useRef(false)
  if (directDef) directSeen.current = true
  useEffect(() => {
    if (direct && directSeen.current && !directDef) window.tangu?.closeSelf?.()
  }, [direct, directDef])
  const name = direct?.title || (directDef ? label(directDef.displayName) : space ? label(space.mini?.name ?? space.name) : 'Mini Panel')

  useEffect(() => {
    const ws = useWorkspace.getState()
    ws.setDefaultBuilder(buildDefault)
    if (direct) return
    if (!space) {
      const fallback = spaces.find((s) => s.id === 'tangu') ?? spaces[0]
      if (fallback) setActiveSpaceCold(fallback.id)
      ws.resetLayout()
    } else if (ws.getActiveLeaf()?.type !== space.mini!.view.type) ws.resetLayout()
    // Registry changes include plugin enable/disable and removal of an adapter view.
  }, [registered, activeId, space, buildDefault, direct])
  useEffect(() => {
    const escape = (e: KeyboardEvent): void => { if (e.key === 'Escape') setMenu(false) }
    window.addEventListener('keydown', escape)
    return () => window.removeEventListener('keydown', escape)
  }, [])

  const leaf = active && (direct ? active.type === direct.view.type : space && active.type === space.mini!.view.type) ? useWorkspace.getState().getActiveLeaf() : null
  const view = leaf ? getView(leaf.type) : null
  const showMain = (): void => {
    if (direct) {
      showInMainPanel({ type: direct.mainView.type, params: { ...direct.mainView.params, ...useWorkspace.getState().getActiveLeaf()?.params } })
      return
    }
    const current = getActiveSpace()
    if (!current?.mini) return
    showInMainPanel({ spaceId: current.id, type: current.mini.mainView.type,
      params: { ...current.mini.mainView.params, ...useWorkspace.getState().getActiveLeaf()?.params } })
  }
  return (
    <div className="mini-card-shell" data-space={direct ? 'direct' : space?.id}>
      <header className="mini-card-chrome">
        <button className="mini-card-space" aria-label={t('lcl.mini.switchSpace')} aria-expanded={menu}
          disabled={!!direct || spaces.length < 2} onClick={() => setMenu(!menu)}>
          {!direct && Icon && <Icon size={15} />}<span>{name}</span>{!direct && spaces.length > 1 && <ChevronDown size={12} />}
        </button>
        <div className="mini-card-drag-title" />
        <button className="mini-card-action" aria-label={t('lcl.mini.showMain')}
          title={t('lcl.mini.showMain')} disabled={!direct && !space} onClick={showMain}><ExternalLink size={15} /></button>
        <button className="mini-card-action mini-card-close" aria-label={t('lcl.mini.close')}
          onClick={() => window.tangu?.closeSelf?.()}><X size={15} /></button>
      </header>
      <main className="mini-card-main">
        {leaf && view ? <div className="mini-panel-view" data-view={leaf.type} key={`${leaf.id}:${leaf.type}`}>
          <ViewErrorBoundary><Suspense fallback={null}>{view.factory({ leaf, params: leaf.params })}</Suspense></ViewErrorBoundary>
        </div> : <div className="mini-panel-empty">{t('lcl.mini.empty')}</div>}
      </main>
      {menu && <>
        <button className="mini-card-dismiss" aria-label={t('lcl.mini.closeMenu')} onClick={() => setMenu(false)} />
        <section className="mini-card-popover" aria-label={t('lcl.mini.switchSpace')}>
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
