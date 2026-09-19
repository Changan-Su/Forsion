/**
 * Agent 的自我进化层:HARNESS.md 工作笔记(Agent 经审批自己沉淀的做法)+ 本机编辑史。
 * Agents 详情的「进化」标签与设置里的 Agent 大脑弹窗共用这一份。
 * 回滚 = 条目级「恢复上一版」(在最近两版间往返);journal 是本机编辑史,不跨设备同步。
 */
import React, { useEffect, useRef, useState } from 'react'
import { Loader2, NotebookPen, Sprout, Undo2 } from 'lucide-react'
import { getAgentHarness, rollbackHarnessEntry, type HarnessEntry, type HarnessJournalLine } from '../services/backendService'
import type { TanguDesktopConfig } from '../types'
import { useI18n } from '../i18n'
import '../views/agentProfile.css'

const MAX_ENTRIES = 30 // 与引擎 harnessStore.MAX_ENTRIES 同值(写入时封顶)
const HISTORY_PREVIEW = 8

type Props = {
  cfg: TanguDesktopConfig
  slug: string
  /** 运行开始 / 结束时重读 —— /refine 经审批写入后不用手动刷新。 */
  running?: boolean
  /** 有会话可复盘时才给:在该会话里发 /refine(引擎按消息前缀识别)。 */
  onRefine?: () => Promise<boolean>
  /** 每次读到数据就把待复盘候选数报上去(详情视图的标签角标用):面板挂着时由它一个人读,免得角标再发一次同样的请求。 */
  onCandidates?: (count: number) => void
}

/** 「2 天前」/「2 days ago」:跟随界面语言,不跟系统语言。 */
function ago(iso: string, tag: string): string {
  const s = (Date.parse(iso) - Date.now()) / 1000
  if (!Number.isFinite(s)) return ''
  const a = Math.abs(s)
  const [n, unit]: [number, Intl.RelativeTimeFormatUnit] = a < 3600 ? [s / 60, 'minute'] : a < 86400 ? [s / 3600, 'hour'] : a < 2592000 ? [s / 86400, 'day'] : [s / 2592000, 'month']
  return new Intl.RelativeTimeFormat(tag, { numeric: 'auto' }).format(Math.round(n), unit)
}

/** 换后端 / 账号 / Agent 整体重挂,旧请求画不进新身份。 */
export const AgentHarnessPanel: React.FC<Props> = (props) => <AgentHarnessBody key={JSON.stringify([props.cfg.backendUrl, props.cfg.token, props.slug])} {...props} />

const AgentHarnessBody: React.FC<Props> = ({ cfg, slug, running, onRefine, onCandidates }) => {
  const { t, locale } = useI18n()
  const tag = locale === 'en' ? 'en' : 'zh-CN'
  const [entries, setEntries] = useState<HarnessEntry[] | null>(null)
  const [journal, setJournal] = useState<HarnessJournalLine[]>([])
  const [candidates, setCandidates] = useState<string[]>([]) // Historian 自动档的提名,还不是笔记;/refine 时才被 Agent 审阅
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [busy, setBusy] = useState(false)
  const [showAll, setShowAll] = useState(false)
  const alive = useRef(true)
  useEffect(() => { alive.current = true; return () => { alive.current = false } }, [])
  // 重读会连发(run 起、run 止两个沿挨得很近):只认最后一次发出的请求,先发后到的旧快照不许盖掉 /refine 刚写完的笔记。
  const seq = useRef(0)

  const load = async (): Promise<void> => {
    const mine = ++seq.current
    try {
      const r = await getAgentHarness(cfg, slug)
      if (alive.current && mine === seq.current) { setEntries(r.entries); setJournal(r.journal); setCandidates(r.candidates || []); setError(''); onCandidates?.(r.candidates?.length ?? 0) }
    } catch (e: any) {
      // 吞掉会显示假「空」(Codex 评审 Minor);云端引擎的 404 detail 是中文硬编码,换成本地化文案。
      if (alive.current && mine === seq.current) setError(e?.status === 404 ? t('settings.agents.harnessLocalOnly') : String(e?.message || e))
    }
  }
  useEffect(() => { void load() }, [running]) // eslint-disable-line react-hooks/exhaustive-deps

  const rollback = async (id: string, title: string): Promise<void> => {
    if (busy || !window.confirm(t('settings.agents.harnessRollbackConfirm', { title }))) return
    setBusy(true); setError(''); setNotice('')
    try { await rollbackHarnessEntry(cfg, slug, id); await load() }
    catch (e: any) { if (alive.current) setError(String(e?.message || e)) }
    finally { if (alive.current) setBusy(false) }
  }
  const refine = async (): Promise<void> => {
    if (!onRefine || busy) return
    setBusy(true); setError(''); setNotice('')
    try { if (await onRefine() && alive.current) setNotice(t('settings.agents.harnessRefineSent')) }
    catch (e: any) { if (alive.current) setError(String(e?.message || e)) }
    finally { if (alive.current) setBusy(false) }
  }

  const currentIds = new Set((entries || []).map((e) => e.id))
  const rev = [...journal].reverse()
  const latestIdx = new Map<string, number>()
  rev.forEach((l, i) => { if (!latestIdx.has(l.entryId)) latestIdx.set(l.entryId, i) })
  const actLabel = (l: HarnessJournalLine): string =>
    l.action === 'delete' ? t('settings.agents.harnessActDelete')
      : l.action === 'rollback' ? t('settings.agents.harnessActRollback')
        : l.before === null ? t('settings.agents.harnessActCreate') : t('settings.agents.harnessActUpdate')
  const kindLabel = (kind: string): string => kind === 'note' ? t('settings.agents.harnessKindNote') : kind === 'recipe' ? t('settings.agents.harnessKindRecipe') : kind
  // 条目日期是引擎按 UTC 写的 YYYY-MM-DD,按 UTC 解读才不会串到前后一天;journal ts 是完整 ISO,按本地时区显示。
  // HARNESS.md 允许手改,解析不了的原样显示,绝不渲出「Invalid Date」。
  const day = (d: string): string => {
    const dateOnly = /^\d{4}-\d{2}-\d{2}$/.test(d)
    const ms = Date.parse(dateOnly ? `${d}T00:00:00Z` : d)
    return Number.isFinite(ms) ? new Date(ms).toLocaleDateString(tag, { month: 'short', day: 'numeric', ...(dateOnly ? { timeZone: 'UTC' } : {}) }) : d
  }
  const stamp = (iso: string): string => Number.isFinite(Date.parse(iso)) ? new Date(iso).toLocaleString(tag, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : iso
  // 收件箱原始行 `- [YYYY-MM-DD s:xxxxxxxx] 正文`(harnessStore.appendHarnessCandidates 的形状):日期留下,会话标签是内部记号,不上屏。
  const candidate = (line: string): { date: string; text: string } => {
    const m = line.match(/^-\s*\[(\d{4}-\d{2}-\d{2})(?:\s+s:[A-Za-z0-9-]*)?\]\s*(.*)$/)
    return m ? { date: m[1], text: m[2] } : { date: '', text: line.replace(/^-\s*/, '') }
  }
  const refineButton = (primary: boolean) => onRefine && <button type="button" className={primary ? 'btn primary sm' : 'profile-text-action'} disabled={busy || running} onClick={() => void refine()}>
    {busy ? <Loader2 size={12} className="spin" /> : <NotebookPen size={12} />}{t('settings.agents.harnessRefine')}</button>

  return <div className="agent-harness" data-agent-harness={slug}>
    {error && <p className="agent-profile-error" role="alert">{error}</p>}
    {notice && <p className="profile-save-notice" role="status">{notice}</p>}
    {entries === null ? !error && <p className="agent-profile-muted" role="status"><Loader2 size={14} className="spin" /> {t('settings.agents.harnessLoading')}</p>
      : entries.length === 0 ? <div className="harness-empty">
        <Sprout size={22} strokeWidth={1.6} aria-hidden="true" />
        <p>{t('settings.agents.harnessEmpty')}</p>
        {refineButton(true)}
      </div>
        : <>
          <div className="harness-summary">
            <span>{t('settings.agents.harnessCount', { count: entries.length, max: MAX_ENTRIES })}{rev[0] && <> · <time dateTime={rev[0].ts} title={stamp(rev[0].ts)}>{t('settings.agents.harnessLastChange', { time: ago(rev[0].ts, tag) })}</time></>}</span>
            {refineButton(false)}
          </div>
          <ul className="harness-entries">{entries.map((e) => <li key={e.id} className="harness-entry" data-harness-entry={e.id}>
            <div className="harness-entry-head">
              {/* 芯片放进标题行内:窄栏里标题折行从左缘续排,不在芯片右侧挤成一条竖栏 */}
              <strong><span className={`harness-kind${e.kind === 'recipe' ? ' recipe' : ''}`}>{kindLabel(e.kind)}</span>{e.title}</strong>
              {latestIdx.has(e.id) && <button type="button" className="harness-undo" disabled={busy} title={t('settings.agents.harnessRollback')} aria-label={t('settings.agents.harnessRollback')} onClick={() => void rollback(e.id, e.title)}><Undo2 size={13} /></button>}
            </div>
            <p>{e.body}</p>
            {e.evidence && <small className="harness-evidence">{t('settings.agents.harnessEvidence', { text: e.evidence })}</small>}
            <small className="harness-meta">v{e.version}{e.updatedAt && <> · {day(e.updatedAt)}</>}</small>
          </li>)}</ul>
        </>}
    {/* 空态也要显示候选:第一次用的人正是「还没有笔记、但收件箱里已经有提名」这个状态 */}
    {candidates.length > 0 && <section className="harness-candidates" data-harness-candidates={candidates.length}>
      <h3>{t('settings.agents.harnessCandidates', { count: candidates.length })}</h3>
      <ul>{candidates.map((line, i) => { const c = candidate(line); return <li key={`${i}-${line}`} className="harness-candidate">{c.date ? <time dateTime={c.date}>{day(c.date)}</time> : <span />}<span>{c.text}</span></li> })}</ul>
      <small>{t('settings.agents.harnessCandidatesHint')}</small>
    </section>}
    {rev.length > 0 && <section className="harness-history">
      <h3>{t('settings.agents.harnessHistory')}</h3>
      <ol>{(showAll ? rev : rev.slice(0, HISTORY_PREVIEW)).map((l, i) => {
        const title = l.after?.title || l.before?.title || l.entryId
        const restorable = latestIdx.get(l.entryId) === i && !currentIds.has(l.entryId) && !!l.before
        return <li key={`${l.ts}-${i}`} className={`harness-event ${l.action}`}>
          <span><b>{actLabel(l)}</b>{title}</span>
          {restorable && <button type="button" className="profile-text-action" disabled={busy} onClick={() => void rollback(l.entryId, title)}>{t('settings.agents.harnessRestore')}</button>}
          <time dateTime={l.ts}>{stamp(l.ts)}</time>
        </li>
      })}</ol>
      {!showAll && rev.length > HISTORY_PREVIEW && <button type="button" className="profile-text-action" onClick={() => setShowAll(true)}>{t('settings.agents.harnessShowAll', { count: rev.length })}</button>}
    </section>}
    {/* 从详情页底栏挪进来(09-19):底栏常驻两行说明,窄栏里白占高度;放在面板末尾,读完笔记正好看到「写入要经审批」 */}
    {entries !== null && <p className="memory-footnote">{t('settings.agents.harnessHint')}</p>}
  </div>
}
