/**
 * 设置 › 系统 › 回收站(10-28 手动卸载规范 D):删掉的 Agent、技能、插件先放这里,30 天后引擎静默清掉。
 * 恢复 = 放回原处、接上原来的设置(Agent 的私聊取消归档、团队与自动化接回);原名被占用时落到「名字-2」。
 * 只在本机:回收站不同步。手机上同一页。
 */
import { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import { Bot, Loader2, Puzzle, RotateCcw, Sparkles } from 'lucide-react'
import { ConfirmDialog } from '@amadeus/components/Dialogs'
import { registerMessages, useI18n } from '../i18n'
import { useApp } from '../stores/appStore'
import { homeTarget } from '../services/engine/targets'
import { emptyTrash, listTrash, purgeTrashEntry, type TrashEntry } from '../services/backendService'
import { fmtSize, restoreErrorText, restoreFromTrash } from './UninstallDialog'
import './pluginManagement.css'

registerMessages({
  'trash.tab': { zh: '回收站', en: 'Trash' },
  'trash.page': {
    zh: '删掉的 Agent、技能、插件先放这里，30 天后自动清掉。恢复会把它放回原处、接上原来的设置。回收站只在这台设备上，不同步。',
    en: 'Deleted agents, skills and plugins wait here for 30 days, then are cleared. Restore puts them back with their settings. The Trash stays on this device and does not sync.',
  },
  'trash.empty': { zh: '回收站是空的', en: 'The Trash is empty' },
  'trash.today': { zh: '今天', en: 'Today' },
  'trash.earlier': { zh: '更早', en: 'Earlier' },
  'trash.kind.agent': { zh: 'Agent', en: 'Agent' },
  'trash.kind.skill': { zh: '技能', en: 'Skill' },
  'trash.kind.plugin': { zh: '插件', en: 'Plugin' },
  'trash.daysLeft': { zh: '还剩 {n} 天', en: '{n} days left' },
  'trash.lastDay': { zh: '今天到期', en: 'Expires today' },
  'trash.restore': { zh: '恢复', en: 'Restore' },
  'trash.purge': { zh: '彻底删除', en: 'Delete forever' },
  'trash.emptyAll': { zh: '清空回收站', en: 'Empty Trash' },
  'trash.emptyTitle': { zh: '清空回收站？', en: 'Empty the Trash?' },
  'trash.emptyMsg': { zh: '这 {n} 项会被彻底删除，不能再恢复。', en: 'These {n} items are deleted for good and cannot be restored.' },
  'trash.purgeTitle': { zh: '彻底删除「{name}」？', en: 'Delete “{name}” forever?' },
  'trash.purgeMsg': { zh: '删了就不能再恢复。', en: 'This cannot be undone.' },
  'trash.chatsArchived': { zh: '私聊已归档', en: 'chats archived' },
  'trash.withTeam': { zh: '连同团队', en: 'with its team' },
  'trash.settingsOnly': { zh: '只有设置', en: 'settings only' },
  'trash.unavailable': { zh: '回收站只在本机引擎上有。', en: 'The Trash is only available with the engine on this device.' },
})

const DAY = 864e5

function detail(e: TrashEntry, t: (k: string, v?: Record<string, unknown>) => string): string {
  const bits = [fmtSize(e.size)]
  if (e.kind === 'agent' && Array.isArray(e.extra?.chats) && e.extra.chats.length) bits.push(t('trash.chatsArchived'))
  if (e.items.some((i) => i.role?.startsWith('team:'))) bits.push(t('trash.withTeam'))
  if (e.kind === 'plugin' && !e.items.some((i) => i.role === 'files')) bits.push(t('trash.settingsOnly'))
  return bits.join(' · ')
}

export function TrashSettings() {
  const { t } = useI18n()
  const [entries, setEntries] = useState<TrashEntry[] | null>(null)
  const [days, setDays] = useState(30)
  const [err, setErr] = useState('')
  const [busy, setBusy] = useState<string | null>(null)
  const [asking, setAsking] = useState<TrashEntry | 'all' | null>(null)
  const load = (): void => { listTrash(homeTarget()).then((r) => { setEntries(r.entries); setDays(r.days); setErr('') }, () => setErr(t('trash.unavailable'))) }
  useEffect(load, [])
  const toast = useApp((s) => s.toast)

  const restore = async (e: TrashEntry): Promise<void> => {
    setBusy(e.id)
    try {
      const r = await restoreFromTrash(e)
      toast(r.renamedTo ? t('uninstall.restoredAs', { name: r.renamedTo }) : t('uninstall.restored', { name: e.name }))
    } catch (x) { toast(restoreErrorText(x), true) }
    finally { setBusy(null); load() }
  }
  const purge = async (target: TrashEntry | 'all'): Promise<void> => {
    setBusy(target === 'all' ? 'all' : target.id)
    try { if (target === 'all') await emptyTrash(homeTarget()); else await purgeTrashEntry(homeTarget(), target.id) }
    catch (x: any) { toast(String(x?.message || x), true) }
    finally { setBusy(null); load() }
  }

  if (err) return <div className="hint">{err}</div>
  if (!entries) return <div className="hint">{t('common.loading')}</div>
  if (!entries.length) return <div className="hint" data-trash-empty>{t('trash.empty')}</div>
  const start = new Date(); start.setHours(0, 0, 0, 0)
  const groups = [
    { key: 'today', label: t('trash.today'), rows: entries.filter((e) => e.deletedAt >= start.getTime()) },
    { key: 'earlier', label: t('trash.earlier'), rows: entries.filter((e) => e.deletedAt < start.getTime()) },
  ].filter((g) => g.rows.length)
  const ic = { size: 16, strokeWidth: 1.8 }
  return <div className="plugin-management trash-page" data-trash>
    {groups.map((g) => <div key={g.key} className="trash-group">
      <div className="trash-group-label">{g.label}</div>
      {g.rows.map((e) => {
        const left = Math.max(0, Math.ceil((e.deletedAt + days * DAY - Date.now()) / DAY))
        return <div key={e.id} className="plugin-card trash-item" data-trash-entry={e.id}>
          <span className="trash-ico">{e.kind === 'agent' ? <Bot {...ic} /> : e.kind === 'skill' ? <Sparkles {...ic} /> : <Puzzle {...ic} />}</span>
          <div className="trash-copy"><b>{e.name} · {t(`trash.kind.${e.kind}`)}</b><div className="trash-meta">{detail(e, t)}</div></div>
          <span className="trash-left">{left > 0 ? t('trash.daysLeft', { n: left }) : t('trash.lastDay')}</span>
          <button className="btn sm" disabled={!!busy} onClick={() => void restore(e)}>{busy === e.id ? <Loader2 size={13} className="spin" /> : <RotateCcw size={13} />}{t('trash.restore')}</button>
          <button className="btn ghost sm" disabled={!!busy} onClick={() => setAsking(e)}>{t('trash.purge')}</button>
        </div>
      })}
    </div>)}
    <div className="trash-foot"><button className="btn ghost sm" disabled={!!busy} onClick={() => setAsking('all')}>{t('trash.emptyAll')}</button></div>
    {asking && createPortal(<div className="am-app tangu-lovable" style={{ display: 'contents' }}>
      <ConfirmDialog
        title={asking === 'all' ? t('trash.emptyTitle') : t('trash.purgeTitle', { name: asking.name })}
        message={asking === 'all' ? t('trash.emptyMsg', { n: entries.length }) : t('trash.purgeMsg')}
        confirmLabel={asking === 'all' ? t('trash.emptyAll') : t('trash.purge')}
        onConfirm={() => void purge(asking)} onClose={() => setAsking(null)} />
    </div>, document.body)}
  </div>
}
