import { useLayoutEffect, useSyncExternalStore } from 'react'
import { ArrowLeft, ArrowRight } from 'lucide-react'
import { useNav } from './navStore'
import { useWorkspace } from './workspaceStore'
import { useEngineI18n } from './i18nSeam'
import { commandHotkeyText } from './commandRegistry'
import { useShortcuts } from './shortcutStore'
import './viewNavigation.css'

const claims = new Map<string, Set<object>>()
const subscribers = new Set<() => void>()
const changed = (): void => { for (const cb of subscribers) cb() }
const subscribe = (cb: () => void): (() => void) => { subscribers.add(cb); return () => { subscribers.delete(cb) } }

/** Reused by existing View heads and the host fallback for headless/plugin Views. */
export function ViewNavigation({ leafId, fallback = false }: { leafId: string | null | undefined; fallback?: boolean }) {
  const { t } = useEngineI18n()
  const stack = useNav(s => leafId ? s.stacks[leafId] : undefined)
  useShortcuts(s => s.overrides)
  const leaf = leafId ? useWorkspace.getState().leafById(leafId) : null
  const eligible = !!leafId && (!leaf || leaf.loc === 'main')
  useLayoutEffect(() => {
    if (!eligible || fallback || !leafId) return
    const token = {}
    const owners = claims.get(leafId) ?? new Set<object>()
    owners.add(token); claims.set(leafId, owners); changed()
    return () => { owners.delete(token); if (!owners.size) claims.delete(leafId); changed() }
  }, [leafId, fallback, eligible])
  if (!eligible) return null
  const tip = (direction: 'back' | 'forward'): string => {
    const entry = stack?.entries[stack.idx + (direction === 'back' ? -1 : 1)]
    const label = t(`lcl.nav.${direction}`) + (entry?.title ? ` · ${entry.title}` : '')
    const key = commandHotkeyText(`nav-${direction}`)
    return key ? t('lcl.withHotkey', { label, key }) : label
  }
  const go = (direction: 'back' | 'forward'): void => {
    if (!leafId) return
    useWorkspace.getState().activateLeaf(leafId)
    useNav.getState()[direction](leafId)
  }
  return <div className="lcl-viewnav" data-view-nav={leafId}>
    <button type="button" data-press="back" disabled={!stack || stack.idx <= 0} title={tip('back')} aria-label={tip('back')} onClick={() => go('back')}><ArrowLeft size={15} /></button>
    <button type="button" data-press="forward" disabled={!stack || stack.idx >= stack.entries.length - 1} title={tip('forward')} aria-label={tip('forward')} onClick={() => go('forward')}><ArrowRight size={15} /></button>
    {stack?.error && <span className="lcl-viewnav-error" role="status">{t('lcl.nav.failed')}</span>}
  </div>
}

/** Built-ins claim the head slot in a layout effect; all other Views get this compact row. */
export function ViewNavigationFallback({ leafId }: { leafId: string }) {
  const claimed = useSyncExternalStore(subscribe, () => (claims.get(leafId)?.size ?? 0) > 0)
  return claimed ? null : <div className="lcl-viewnav-fallback"><ViewNavigation leafId={leafId} fallback /></div>
}
