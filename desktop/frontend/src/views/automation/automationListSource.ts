/** Automation contributes data and actions to the native Workspace View. It does not draw another sidebar. */
import { useWorkspace } from '@lcl/engine'
import { usePluginStore } from '../../amadeus/plugins/pluginStore'
import type { ListItem, ListSourceContribution } from '../../amadeus/plugins/types'
import { translate as t } from '../../i18n'
import { useApp } from '../../stores/appStore'
import { useAutomation, type AutomationSel } from '../../stores/automationStore'
import { deleteMuseTrigger, saveMuseTrigger, saveSpecialConfig, deleteAgentScheduleEntry, saveAgentScheduleEntry } from '../../services/backendService'
import { actionsText, condText, isFinishedTrigger, triggerToUpsert } from './lib'
import './messages'

export const AUTOMATION_WORKSPACE_MODE = 'plugin:automation:rules' as const
const keyOf = (sel: AutomationSel | null): string | null => sel ? JSON.stringify(sel) : null
const openDetail = () => useWorkspace.getState().openView('automation-detail', {}, 'main')
const mutate = async (run: () => Promise<unknown>): Promise<void> => {
  try { await run(); useAutomation.getState().bump() }
  catch (error) { useApp.getState().toast(String(error instanceof Error ? error.message : error), true) }
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
    return rows.filter((row) => (!filter?.group ? q || row.category !== 'finished' : row.category === filter.group)
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
        { id: 'delete', label: t('common.delete'), run() { void mutate(() => deleteMuseTrigger(cfg, tr.id)) } },
      ]
    }
    if (sel.kind === 'schedule') {
      const en = state.schedules.find((s) => s.slug === sel.slug)?.entries.find((e) => e.id === sel.rowId)
      if (!en) return []
      return [
        { id: 'toggle', label: t(en.auto ? 'automation.ux.pause' : 'automation.ux.enable'), run() { void mutate(() => saveAgentScheduleEntry(cfg, sel.slug, { id: en.id, name: en.name, date: en.date, repeat: en.repeat, auto: !en.auto, prompt: en.prompt, description: en.description, todo: en.todo })) } },
        { id: 'delete', label: t('common.delete'), run() { void mutate(() => deleteAgentScheduleEntry(cfg, sel.slug, en.id)) } },
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
