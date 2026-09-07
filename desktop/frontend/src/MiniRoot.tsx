import { flushAllScopes } from './amadeus/store/pageStore'
/** Mini boot connects shared data and a single opt-in Space surface. */
import { useEffect } from 'react'
import { MiniColumnHost, getActiveSpace, setActiveSpace, setMiniMainHandler, setMiniViewRouter, showInMainPanel, supportsMiniPanel, subscribeViews, useSpaceStore, useWorkspace } from '@lcl/engine'
import { useApp } from './stores/appStore'
import { useI18n } from './i18n'
import { installFileDropGuard } from './fileDropGuard'
import { ensureAmadeusReady } from './amadeusPlugins'
import { windowKind } from './windowKind'
import type { MiniOpenOptions } from '../../shared/miniPanel'

if (windowKind() === 'mini') {
  setMiniMainHandler(async (target) => {
    if (target.type === 'amadeus-editor') await flushAllScopes()
    const params = { ...target.params }
    delete params.miniSurface
    if (target.type === 'chat') {
      params.sessionId ||= useApp.getState().activeId || undefined
      params.followActive = !params.sessionId
    }
    window.tangu?.showMainPanel?.({ ...target, params })
  })
  setMiniViewRouter((target) => {
    const space = getActiveSpace()
    if (!space || !supportsMiniPanel(space)) return null
    const mini = space.mini!
    if (target.type === mini.view.type) return target
    if (target.type === mini.mainView.type) return { type: mini.view.type, params: { ...mini.view.params, ...target.params } }
    // Links to full documents/tools belong in the main panel; never expand Mini into Forsion.
    showInMainPanel({ ...target })
    return null
  })
}

function buildMiniPanel(): void {
  const space = getActiveSpace()
  if (space && supportsMiniPanel(space)) useWorkspace.getState().openView(space.mini!.view.type, space.mini!.view.params ?? {}, 'main')
}

export function MiniRoot() {
  const { t } = useI18n()
  useEffect(() => { useApp.getState().setTr((k, vars) => t(k, vars as Record<string, string | number> | undefined)) }, [t])
  useEffect(() => {
    let ready = false
    const query = new URLSearchParams(location.search)
    let pending: MiniOpenOptions | null = query.get('sessionId') ? { sessionId: query.get('sessionId')! } : null
    const apply = (): void => {
      if (!ready || !pending) return
      const spaceId = pending.spaceId || (pending.sessionId ? 'tangu' : undefined)
      const space = useSpaceStore.getState().spaces.find((s) => s.id === spaceId)
      if (!space || !supportsMiniPanel(space)) return // async plugin registration can fulfill the target later
      const target = pending
      pending = null
      setActiveSpace(space.id)
      const params = { ...space.mini!.view.params, ...target.params,
        ...(target.sessionId ? { sessionId: target.sessionId, followActive: false } : {}) }
      useWorkspace.getState().openView(space.mini!.view.type, params, 'main')
      if (target.sessionId) useApp.getState().setActiveId(target.sessionId)
    }
    const off = window.tangu?.onMiniTarget?.((target) => { pending = target; apply() })
    window.tangu?.miniReady?.()
    const offSpaces = useSpaceStore.subscribe(apply)
    const offViews = subscribeViews(apply)
    void useApp.getState().boot().finally(() => { ready = true; apply() })
    return () => { off?.(); offSpaces(); offViews(); ready = false }
  }, [])
  useEffect(() => { if (window.amadeus) ensureAmadeusReady() }, [])
  useEffect(() => installFileDropGuard(), [])
  return <MiniColumnHost buildDefault={buildMiniPanel} />
}
