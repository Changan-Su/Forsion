/** Automation contributes data and actions to the native Workspace View. It does not draw another sidebar. */
import { useWorkspace } from '@lcl/engine'
import { usePluginStore } from '../../amadeus/plugins/pluginStore'
import type { ListItem, ListSourceContribution } from '../../amadeus/plugins/types'
import { translate as t } from '../../i18n'
import { useApp } from '../../stores/appStore'
import { notifyApp } from '../../stores/notificationStore'
import { useAutomation, type AutomationSel } from '../../stores/automationStore'
import { deleteMuseTrigger, saveMuseTrigger, saveSpecialConfig, deleteAgentScheduleEntry, saveAgentScheduleEntry } from '../../services/backendService'
import { actionsText, condText, isFinishedTrigger, triggerToUpsert } from './lib'
import './messages'

export const AUTOMATION_WORKSPACE_MODE = 'plugin:automation:rules' as const
const keyOf = (sel: AutomationSel | null): string | null => sel ? JSON.stringify(sel) : null
const openDetail = () => useWorkspace.getState().openView('automation-detail', {}, 'main')
const mutate = async (run: () => Promise<unknown>): Promise<boolean> => {
  try { await run(); useAutomation.getState().bump(); return true }
  catch (error) { useApp.getState().toast(String(error instanceof Error ? error.message : error), true); return false }
}
/** Engine deletes are hard deletes, so nothing is sent at once: the row hides, the selection drops if it pointed
 *  there, and an "Deleted · Undo" receipt shows. The real delete runs when that receipt leaves the screen without
 *  Undo — so its UNDO_MS only starts once it is actually visible and pauses on hover (U-03 plan M). Quitting before
 *  then just keeps the row, which is the safe way to fail. A failed delete toasts and the row comes back.
 *  onDeleted runs after a successful delete, before the row leaves the pending set, so a caller holding its own
 *  copy of the list (MuseView) drops it without the row flashing back. */
const UNDO_MS = 5000
const pendingDeletes = new Set<string>()
/** Deleted for good: ids never come back, and a view holding its own copy of the rows (MuseView polls on its
 *  own clock) must not show a deleted row again between the delete and its next fetch. */
const deletedKeys = new Set<string>()
const hiddenKey = (key: string): boolean => pendingDeletes.has(key) || deletedKeys.has(key)
export const isPendingDelete = (sel: AutomationSel): boolean => hiddenKey(keyOf(sel)!)
export function deleteWithUndo(sel: AutomationSel, name: string, run: () => Promise<unknown>, onDeleted?: () => void): void {
  const key = keyOf(sel)!
  if (pendingDeletes.has(key)) return
  pendingDeletes.add(key)
  const store = useAutomation.getState()
  if (keyOf(store.sel) === key) store.setSel(null)
  store.bump()
  const settle = () => { pendingDeletes.delete(key); useAutomation.getState().bump() }
  let decided = false
  const commit = () => {
    if (decided) return
    decided = true
    void mutate(run).then((ok) => { if (ok) { deletedKeys.add(key); onDeleted?.() } }).finally(settle)
  }
  const shown = notifyApp({ text: t('automation.deleted', { name }), level: 'info', dedupeKey: `automation.delete:${key}`,
    receipt: true, durationMs: UNDO_MS, onClose: commit,
    action: { label: t('automation.undo'), run() { if (!decided) { decided = true; settle() } } } })
  if (!shown) setTimeout(commit, UNDO_MS) // 没有通知栈可挂(不该发生):照旧给出撤销时长再删
}
let readers = 0
let stopPolling: (() => void) | undefined
/** Shared polling survives a hidden sidebar; each mounted consumer releases its subscription. */
export function subscribeAutomation(cb: () => void): () => void {
  const off = useAutomation.subscribe(cb)
  const offAgents = useApp.subscribe((s, p) => { if (s.agentDefs !== p.agentDefs) cb() })
  if (readers++ === 0) {
    const refresh = () => void useAutomation.getState().refresh(useApp.getState().cfg)
    const offState = useAutomation.subscribe((s, p) => { if (s.refreshNonce !== p.refreshNonce) refresh() })
    const offConfig = useApp.subscribe((s, p) => { if (s.cfg !== p.cfg) refresh() })
    const timer = setInterval(refresh, 8000)
    stopPolling = () => { clearInterval(timer); offState(); offConfig() }
    refresh()
  }
  return () => { off(); offAgents(); if (--readers === 0) { stopPolling?.(); stopPolling = undefined } }
}

export const automationListSource: ListSourceContribution = {
  id: 'rules', get title() { return t('space.automation') }, search: true,
  activeKey: () => useAutomation.getState().builder ? null : keyOf(useAutomation.getState().sel),
  subscribe: subscribeAutomation,
  items(filter) {
    const state = useAutomation.getState(), defs = useApp.getState().agentDefs
    const q = filter?.query?.trim().toLowerCase()
    const rows: Array<ListItem & { category: string; searchText?: string }> = state.triggers.map((tr) => ({
      key: keyOf({ kind: 'trigger', triggerId: tr.id })!, title: tr.desc, icon: 'today',
      category: isFinishedTrigger(tr) ? 'finished' : tr.cond.type === 'manual' ? 'buttons' : 'rules',
      hint: t(isFinishedTrigger(tr) ? 'automation.finished' : tr.enabled ? 'automation.ux.on' : 'automation.ux.off'),
      searchText: `${condText(t, tr.cond)} ${actionsText(t, defs, tr)}`,
    }))
    for (const schedule of state.schedules) for (const en of schedule.entries) {
      if (en.date && en.prompt) rows.push({ key: keyOf({ kind: 'schedule', slug: schedule.slug, rowId: en.id })!,
        title: en.name, icon: 'calendar', category: 'schedules', searchText: schedule.name,
        hint: t(en.auto ? 'automation.ux.on' : 'automation.ux.off') })
    }
    for (const kind of ['muse', 'historian'] as const) rows.push({ key: keyOf({ kind })!, title: t(`automation.${kind}.title`),
      icon: kind === 'muse' ? 'sparkles' : 'history', category: 'system', hint: t(state.specialCfg?.[kind].enabled ? 'automation.ux.on' : 'automation.ux.off') })
    return rows.filter((row) => !hiddenKey(row.key) && (!filter?.group ? q || row.category !== 'finished' : row.category === filter.group)
      && (!q || `${row.title} ${row.searchText || ''}`.toLowerCase().includes(q)))
  },
  groups: () => ['rules', 'buttons', 'schedules', 'system', 'finished'].map((key) => ({ key,
    title: t(key === 'rules' ? 'automation.ux.myWorkflows' : key === 'finished' ? 'automation.finished' : `automation.group.${key}`),
    count: automationListSource.items({ group: key }).length,
  })).filter((group) => group.count > 0 || group.key === 'rules'),
  open(item) { useAutomation.getState().setSel(JSON.parse(item.key)); openDetail() },
  actions: [
    { id: 'new', get label() { return t('automation.new') }, run() { useAutomation.getState().openBuilder(); openDetail() } },
    { id: 'overview', get label() { return t('automation.ux.overview') }, run() { useAutomation.getState().setSel(null); openDetail() } },
  ],
  itemMenu(item) {
    const sel = JSON.parse(item.key) as AutomationSel, state = useAutomation.getState(), cfg = useApp.getState().cfg
    if (sel.kind === 'trigger') {
      const tr = state.triggers.find((r) => r.id === sel.triggerId)
      if (!tr) return []
      return [
        { id: 'edit', label: t('common.edit'), run() { state.openBuilder(tr.id); openDetail() } },
        { id: 'toggle', label: t(tr.enabled ? 'automation.ux.pause' : 'automation.ux.enable'), run() { void mutate(() => saveMuseTrigger(cfg, { ...triggerToUpsert(tr), enabled: !tr.enabled, actor: 'user' })) } },
        { id: 'delete', label: t('common.delete'), danger: true, run() { deleteWithUndo(sel, tr.desc, () => deleteMuseTrigger(cfg, tr.id)) } },
      ]
    }
    if (sel.kind === 'schedule') {
      const en = state.schedules.find((s) => s.slug === sel.slug)?.entries.find((e) => e.id === sel.rowId)
      if (!en) return []
      return [
        { id: 'toggle', label: t(en.auto ? 'automation.ux.pause' : 'automation.ux.enable'), run() { void mutate(() => saveAgentScheduleEntry(cfg, sel.slug, { id: en.id, name: en.name, date: en.date, repeat: en.repeat, auto: !en.auto, prompt: en.prompt, description: en.description, todo: en.todo })) } },
        { id: 'delete', label: t('common.delete'), danger: true, run() { deleteWithUndo(sel, en.name, () => deleteAgentScheduleEntry(cfg, sel.slug, en.id)) } },
      ]
    }
    const config = state.specialCfg?.[sel.kind]
    return config ? [{ id: 'toggle', label: t(config.enabled ? 'automation.ux.pause' : 'automation.ux.enable'),
      run() { void mutate(() => saveSpecialConfig(cfg, { [sel.kind]: { ...config, enabled: !config.enabled } })) } }] : []
  },
}

export function registerAutomationListSource(): void {
  usePluginStore.setState((s) => ({ listSources: [...s.listSources.filter((source) => !(source.pluginId === 'automation' && source.item.id === 'rules')),
    { pluginId: 'automation', item: automationListSource }] }))
}
