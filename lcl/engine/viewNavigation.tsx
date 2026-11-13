import React from 'react'
import { ArrowLeft, ArrowRight } from 'lucide-react'
import { useNav } from './navStore'
import { useWorkspace } from './workspaceStore'
import { useEngineI18n } from './i18nSeam'
import { commandHotkeyText } from './commandRegistry'
import { useShortcuts } from './shortcutStore'
import './viewNavigation.css'

/** Shared controls; desktop hosts these in each group's tab strip. */
export function ViewNavigation({ leafId }: { leafId: string | null | undefined }) {
  const { t } = useEngineI18n()
  const stack = useNav(s => leafId ? s.stacks[leafId] : undefined)
  useShortcuts(s => s.overrides)
  const leaf = leafId ? useWorkspace.getState().leafById(leafId) : null
  const eligible = !!leafId && (!leaf || leaf.loc === 'main')
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

/** Single-column/mobile shell has no tab strip; keep its existing navigation entry. */
export function ViewNavigationFallback({ leafId }: { leafId: string }) {
  return <div className="lcl-viewnav-fallback"><ViewNavigation leafId={leafId} /></div>
}
