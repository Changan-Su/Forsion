import React, { useEffect, useRef, useState } from 'react'
import { ChevronDown, ChevronRight, Loader2, Pencil, RefreshCw } from 'lucide-react'
import { registerMessages, useI18n } from '../i18n'
import { getAgentLogSnapshot, listAgentLogDates, putAgentLog } from '../services/backendService'
import { connectionKey, homeTarget } from '../services/engine/targets'
import type { TanguDesktopConfig } from '../types'
import { Markdown } from './Markdown'
import '../views/agentProfile.css'

registerMessages({
  'agentLog.days': { zh: '{count} 天有记录', en: '{count} days on record' },
  'agentLog.older': { zh: '更早的 {count} 天', en: '{count} earlier days' },
  'agentLog.today': { zh: '今天', en: 'Today' },
  'agentLog.editDay': { zh: '编辑 {date} 的日志', en: 'Edit the log for {date}' },
  'agentLog.error': { zh: '日志操作失败', en: 'The log could not be updated' },
  'agentLog.changed': { zh: '这一天的日志已有新版本，这次没有保存。', en: 'This day’s log has a newer version, so nothing was saved.' },
  'agentLog.discardAndReload': { zh: '放弃草稿并载入当前版本', en: 'Discard draft and load the current version' },
})

/** 最近几天直接列出,更早的收进一个折叠块:用了几个月的 Agent 有上百天,全摊开就是一墙日期。 */
const RECENT_DAYS = 7
const todayLocal = (): string => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}` }

/** 给人读的那一份:去掉文件头的 `# 日期`(行头已经写了)和每条开头的 `@设备号`(多端合并用的标记,对读的人是噪音)。
 *  设备号是引擎生成的 8 位十六进制(core/deviceId.ts),只认这个形状:手写的「@某人 …」开头照常显示。
 *  ponytail: 不解析 Markdown —— 围栏代码块里恰好同形状的两行也会被去掉;只影响显示,真碰到了再换成按块处理。
 *  编辑时看到的仍是磁盘原文。 */
export const logForReading = (content: string): string =>
  content.replace(/^# \d{4}-\d{2}-\d{2}[ \t]*\n+/, '').replace(/^(### \d{2}:\d{2}\n)@[0-9a-f]{8} /gm, '$1')

type Props = { cfg: TanguDesktopConfig; slug: string; /** 面板常驻挂载时由外面告知是否正被看着:再次切回来会重读 */ active?: boolean }

/** 一个 Agent 的日志:按天折叠,最近一天展开;点开才读那一天,读为主、要改再点编辑。
 *  保存带着读到的版本号(引擎按版本拒绝覆盖别人的改动);冲突时草稿留在原地、不报已保存,给一条「放弃草稿并载入当前版本」的出路。
 *  编辑期间不换天、不重读 —— 草稿对着的是开始编辑时的那个版本。 */
export const AgentLogPanel: React.FC<Props> = (props) =>
  // 换 Agent / 换连接 = 另一份日志:整块重挂,草稿和「开着哪一天」不带过去(否则 A 的草稿能存进 B 的同一天)
  <AgentLogPanelBody key={JSON.stringify([connectionKey(props.cfg), props.slug])} {...props} />

const AgentLogPanelBody: React.FC<Props> = ({ slug, active = true }) => {
  const { t } = useI18n()
  const [dates, setDates] = useState<string[] | null>(null)
  const [open, setOpen] = useState<string | null>(null)
  const [day, setDay] = useState<{ content: string; version: string } | null>(null)
  const [draft, setDraft] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [saved, setSaved] = useState(false)
  const [error, setError] = useState('')
  const [conflict, setConflict] = useState(false)
  const [reload, setReload] = useState(0)
  const request = useRef(0)
  const writeLock = useRef(false)
  const first = useRef(true)
  const shown = useRef(active)
  const editing = draft !== null

  useEffect(() => {
    let live = true
    listAgentLogDates(homeTarget(), slug).then((ds) => {
      if (!live) return
      const sorted = ds.slice().sort((a, b) => b.localeCompare(a))
      setDates(sorted)
      if (first.current) { first.current = false; setOpen(sorted[0] ?? null) }
    // 重读失败时留着上一份日期:清空会把正开着的那一天连同它的草稿一起从界面上拿掉(Codex 评审 10-13)
    }).catch((e) => { if (live) { setDates((previous) => previous ?? []); setError(e?.message || t('agentLog.error')) } })
    return () => { live = false }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [slug, reload])

  useEffect(() => {
    const id = ++request.current
    setDay(null); setSaved(false); setError(''); setConflict(false)
    if (!open) { setBusy(false); return } // 读到一半就收起:那次请求已作废,不会再有人把 busy 放下
    setBusy(true)
    getAgentLogSnapshot(homeTarget(), slug, open).then((r) => { if (id === request.current) setDay({ content: r.content, version: r.version }) })
      .catch((e) => { if (id === request.current) setError(e?.message || t('agentLog.error')) })
      .finally(() => { if (id === request.current) setBusy(false) })
    return () => { ++request.current }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, slug, reload])

  useEffect(() => {
    if (active && !shown.current && !editing) setReload((n) => n + 1)
    shown.current = active
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active])

  const save = async (): Promise<void> => {
    if (!open || !day || draft === null || busy || writeLock.current) return
    writeLock.current = true
    const id = request.current
    setBusy(true); setSaved(false); setError(''); setConflict(false)
    try {
      await putAgentLog(homeTarget(), slug, open, draft, day.version)
      const r = await getAgentLogSnapshot(homeTarget(), slug, open)
      if (id === request.current) { setDay({ content: r.content, version: r.version }); setDraft(null); setSaved(true) }
    } catch (e: any) { if (id === request.current) { if (e?.status === 409) setConflict(true); else setError(e?.message || t('agentLog.error')) } }
    finally { writeLock.current = false; if (id === request.current) setBusy(false) }
  }

  if (dates === null) return <p className="profile-empty" data-testid="agent-log-panel"><Loader2 size={14} className="spin" /></p>
  const today = todayLocal()
  const row = (date: string): React.ReactNode => {
    const isOpen = open === date
    return <div key={date} className="agentmem-log" data-log-date={date}>
      <div className="agentmem-log-row">
        <button type="button" className="agentmem-log-head" aria-expanded={isOpen} disabled={editing} onClick={() => setOpen(isOpen ? null : date)}>
          {isOpen ? <ChevronDown size={12} /> : <ChevronRight size={12} />}<span>{date}</span>{date === today && <small>{t('agentLog.today')}</small>}
        </button>
        {isOpen && saved && <small className="agentmem-log-saved">{t('settings.agents.memSaved')}</small>}
        {isOpen && day && !editing && <button type="button" className="harness-undo" title={t('common.edit')} aria-label={t('agentLog.editDay', { date })} onClick={() => { setDraft(day.content); setSaved(false) }}><Pencil size={13} /></button>}
      </div>
      {isOpen && (editing
        ? <div className="field agentmem-log-edit">
          <textarea aria-label={t('agentLog.editDay', { date })} rows={12} value={draft} disabled={busy} onChange={(e) => setDraft(e.target.value)} />
          {conflict && <p role="alert" className="agentmem-log-error">{t('agentLog.changed')} <button type="button" className="profile-text-action" onClick={() => { setDraft(null); setReload((n) => n + 1) }}>{t('agentLog.discardAndReload')}</button></p>}
          <div className="agentmem-log-actions">
            <button type="button" className="btn primary sm" disabled={busy} onClick={() => void save()}>{busy ? <Loader2 size={13} className="spin" /> : null} {t('common.save')}</button>
            <button type="button" className="btn sm" disabled={busy} onClick={() => { setDraft(null); setError(''); setConflict(false) }}>{t('common.cancel')}</button>
          </div>
        </div>
        : day && <div className="agentmem-log-body msg-content"><Markdown content={logForReading(day.content)} /></div>)}
    </div>
  }
  return <div className="profile-log" data-testid="agent-log-panel" data-agent-slug={slug}>
    <div className="harness-summary">
      <span>{t('agentLog.days', { count: dates.length })}</span>
      <button type="button" className="profile-text-action" disabled={busy || editing} onClick={() => setReload((n) => n + 1)}><RefreshCw size={12} />{t('common.refresh')}</button>
    </div>
    {error && <p role="alert" className="agentmem-log-error">{error}</p>}
    {!dates.length ? (!error && <p className="profile-empty">{t('settings.agents.noLog')}</p>) : <>
      {dates.slice(0, RECENT_DAYS).map(row)}
      {dates.length > RECENT_DAYS && <details className="profile-disclosure"><summary>{t('agentLog.older', { count: dates.length - RECENT_DAYS })}</summary>{dates.slice(RECENT_DAYS).map(row)}</details>}
    </>}
  </div>
}
