/**
 * Agent 的自我进化层:HARNESS.md 进化记录(Agent 自己沉淀的做法,写入立即生效、对话里出可撤销的更新卡)+ 候选 + 本机编辑史。
 * 候选(10-04):带网址、命令或权限字眼的只等用户逐条「采纳 / 丢弃」,/refine 不取;其余的等复盘,用户也可以先一步处理。
 * Agents 详情的「进化」标签与设置里的 Agent 大脑弹窗共用这一份。
 * 回滚 = 条目级「恢复上一版」(在最近两版间往返);journal 是本机编辑史,不跨设备同步。
 */
import React, { useEffect, useRef, useState } from 'react'
import { Loader2, NotebookPen, Sprout, Undo2 } from 'lucide-react'
import { getAgentHarness, resolveHarnessCandidate, rollbackHarnessEntry, type HarnessCandidate, type HarnessEntry, type HarnessJournalLine } from '../services/backendService'
import type { TanguDesktopConfig } from '../types'
import { useI18n } from '../i18n'
import { parseCandidateLine } from '../services/selfUpdates'
import { formatDate, formatDateTime, formatRelative } from '../format/time'
import '../views/agentProfile.css'
import { homeTarget, connectionKey } from '../services/engine/targets'
import { HARNESS_CHANGED_EVENT } from '../services/harnessUpdates'

const MAX_ENTRIES = 30 // 与引擎 harnessStore.MAX_ENTRIES 同值(写入时封顶)
const HISTORY_PREVIEW = 8
/** 采纳 / 丢弃失败的机器码 → 文案(引擎 harnessStore.HarnessCandidateError)。 */
const CANDIDATE_ERRORS: Record<string, string> = {
  HARNESS_CANDIDATE_GONE: 'settings.agents.harnessCandidateGone',
  HARNESS_CANDIDATE_FULL: 'settings.agents.harnessCandidateFull',
  HARNESS_CANDIDATE_TOO_LONG: 'settings.agents.harnessCandidateTooLong',
}

type Props = {
  cfg: TanguDesktopConfig
  slug: string
  /** 运行开始 / 结束时重读 —— Agent 写完笔记后不用手动刷新。 */
  running?: boolean
  /** 有会话可复盘时才给:在该会话里发 /refine(引擎按消息前缀识别)。 */
  onRefine?: () => Promise<boolean>
  /** 每次读到数据就把待复盘候选数报上去(详情视图的标签角标用):面板挂着时由它一个人读,免得角标再发一次同样的请求。 */
  onCandidates?: (count: number) => void
}

/** 换后端 / 账号 / Agent 整体重挂,旧请求画不进新身份。 */
export const AgentHarnessPanel: React.FC<Props> = (props) => <AgentHarnessBody key={JSON.stringify([connectionKey(props.cfg), props.slug])} {...props} />

const AgentHarnessBody: React.FC<Props> = ({ cfg, slug, running, onRefine, onCandidates }) => {
  const { t, locale } = useI18n()
  const [entries, setEntries] = useState<HarnessEntry[] | null>(null)
  const [journal, setJournal] = useState<HarnessJournalLine[]>([])
  const [candidates, setCandidates] = useState<HarnessCandidate[]>([]) // 提名,还不是记录
  const [canDecide, setCanDecide] = useState(false) // 老引擎只回原始行、没有逐条处理的路由:照旧只读
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
      const r = await getAgentHarness(homeTarget(), slug)
      const items = r.candidateItems ?? (r.candidates || []).map((line) => ({ line, needsUser: false, adoptable: false }))
      if (alive.current && mine === seq.current) { setEntries(r.entries); setJournal(r.journal); setCandidates(items); setCanDecide(!!r.candidateItems); setError(''); onCandidates?.(items.length) }
    } catch (e: any) {
      // 吞掉会显示假「空」(Codex 评审 Minor);云端引擎的 404 detail 是中文硬编码,换成本地化文案。
      if (alive.current && mine === seq.current) setError(e?.status === 404 ? t('settings.agents.harnessLocalOnly') : String(e?.message || e))
    }
  }
  useEffect(() => { void load() }, [running]) // eslint-disable-line react-hooks/exhaustive-deps
  // 对话里的更新卡撤销了一笔(或 Agent 运行中又写了一条)→ 面板跟着重读
  useEffect(() => { const again = () => { void load() }; window.addEventListener(HARNESS_CHANGED_EVENT, again); return () => window.removeEventListener(HARNESS_CHANGED_EVENT, again) }, []) // eslint-disable-line react-hooks/exhaustive-deps

  const rollback = async (id: string, title: string): Promise<void> => {
    if (busy || !window.confirm(t('settings.agents.harnessRollbackConfirm', { title }))) return
    setBusy(true); setError(''); setNotice('')
    try { await rollbackHarnessEntry(homeTarget(), slug, id); await load(); window.dispatchEvent(new CustomEvent(HARNESS_CHANGED_EVENT)) }
    catch (e: any) { if (alive.current) setError(String(e?.message || e)) }
    finally { if (alive.current) setBusy(false) }
  }
  const decide = async (c: HarnessCandidate, action: 'adopt' | 'dismiss'): Promise<void> => {
    if (busy) return
    setBusy(true); setError(''); setNotice('')
    try {
      await resolveHarnessCandidate(homeTarget(), slug, c.line, action)
      await load()
      if (action === 'adopt') window.dispatchEvent(new CustomEvent(HARNESS_CHANGED_EVENT))
      if (alive.current) setNotice(t(action === 'adopt' ? 'settings.agents.harnessCandidateAdopted' : 'settings.agents.harnessCandidateDismissed'))
    } catch (e: any) {
      if (e?.code === 'HARNESS_CANDIDATE_GONE') await load() // 被复盘取走 / 别处已经处理:清单以引擎为准
      const key = CANDIDATE_ERRORS[e?.code]
      if (alive.current) setError(key ? t(key, { max: MAX_ENTRIES }) : String(e?.message || e))
    } finally { if (alive.current) setBusy(false) }
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
  // 这次改动不是 agent 自己在对话里写的:后台复盘直接采纳 / Muse 巡检后代为收起 / 用户采纳的候选(10-04)。别的来源不标。
  const byLabel = (by?: string): string => by === 'historian' ? t('settings.agents.harnessByHistorian') : by === 'muse' ? t('settings.agents.harnessByMuse') : by === 'user' ? t('settings.agents.harnessByUser') : ''
  const kindLabel = (kind: string): string => kind === 'note' ? t('settings.agents.harnessKindNote') : kind === 'recipe' ? t('settings.agents.harnessKindRecipe') : kind === 'equip' ? t('settings.agents.harnessKindEquip') : kind
  const listSep = locale === 'zh' ? '、' : ', '
  // 条目日期是引擎写的 YYYY-MM-DD(纯日期,单源按本地那一天解读,不串到前后一天);journal ts 是完整 ISO,按本地时区显示。
  // HARNESS.md 允许手改,解析不了的原样显示,绝不渲出「Invalid Date」。
  const day = (d: string): string => formatDate(d, { locale }) || d
  const stamp = (iso: string): string => formatDateTime(iso, { locale }) || iso
  // 收件箱原始行的日期留下,会话标签是内部记号,不上屏。
  const candidate = parseCandidateLine
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
            <span>{t('settings.agents.harnessCount', { count: entries.length, max: MAX_ENTRIES })}{rev[0] && <> · <time dateTime={rev[0].ts} title={stamp(rev[0].ts)}>{t('settings.agents.harnessLastChange', { time: formatRelative(rev[0].ts, { locale }) })}</time></>}</span>
            {refineButton(false)}
          </div>
          <ul className="harness-entries">{entries.map((e) => <li key={e.id} className="harness-entry" data-harness-entry={e.id}>
            <div className="harness-entry-head">
              {/* 芯片放进标题行内:窄栏里标题折行从左缘续排,不在芯片右侧挤成一条竖栏 */}
              <strong><span className={`harness-kind${e.kind === 'recipe' || e.kind === 'equip' ? ' recipe' : ''}`}>{kindLabel(e.kind)}</span>{e.title}</strong>
              {latestIdx.has(e.id) && <button type="button" className="harness-undo" disabled={busy} title={t('settings.agents.harnessRollback')} aria-label={t('settings.agents.harnessRollback')} onClick={() => void rollback(e.id, e.title)}><Undo2 size={13} /></button>}
            </div>
            <p>{e.body}</p>
            {/* 装备(equip):这一条收起了哪些工具 / 技能 —— 撤销或删掉这一条它们就回来 */}
            {!!e.tools?.length && <small className="harness-evidence" data-harness-shelved="tools">{t('settings.agents.harnessShelvedTools', { names: e.tools.join(listSep) })}</small>}
            {!!e.skills?.length && <small className="harness-evidence" data-harness-shelved="skills">{t('settings.agents.harnessShelvedSkills', { names: e.skills.join(listSep) })}</small>}
            {e.evidence && <small className="harness-evidence">{t('settings.agents.harnessEvidence', { text: e.evidence })}</small>}
            <small className="harness-meta">v{e.version}{e.updatedAt && <> · {day(e.updatedAt)}</>}{byLabel(rev[latestIdx.get(e.id) ?? -1]?.by) && <span data-harness-by={rev[latestIdx.get(e.id) ?? -1]?.by}> · {byLabel(rev[latestIdx.get(e.id) ?? -1]?.by)}</span>}</small>
          </li>)}</ul>
        </>}
    {/* 空态也要显示候选:第一次用的人正是「还没有笔记、但收件箱里已经有提名」这个状态 */}
    {candidates.length > 0 && <section className="harness-candidates" data-harness-candidates={candidates.length}>
      <h3>{t('settings.agents.harnessCandidates', { count: candidates.length })}</h3>
      <ul>{candidates.map((item, i) => { const c = candidate(item.line); return <li key={`${i}-${item.line}`} className="harness-candidate" data-harness-candidate={item.needsUser ? 'needs-user' : 'refine'}>
        {c.date ? <time dateTime={c.date}>{day(c.date)}</time> : <span />}
        <span>{item.needsUser && <span className="harness-kind recipe">{t('settings.agents.harnessCandidateNeedsYou')}</span>}{c.text}</span>
        {canDecide && <div className="harness-candidate-actions">
          {item.adoptable && <button type="button" className="profile-text-action adopt" disabled={busy} onClick={() => void decide(item, 'adopt')}>{t('settings.agents.harnessCandidateAdopt')}</button>}
          <button type="button" className="profile-text-action" disabled={busy} onClick={() => void decide(item, 'dismiss')}>{t('settings.agents.harnessCandidateDismiss')}</button>
        </div>}
      </li> })}</ul>
      <small>{t('settings.agents.harnessCandidatesHint')}</small>
    </section>}
    {rev.length > 0 && <section className="harness-history">
      <h3>{t('settings.agents.harnessHistory')}</h3>
      <ol>{(showAll ? rev : rev.slice(0, HISTORY_PREVIEW)).map((l, i) => {
        const title = l.after?.title || l.before?.title || l.entryId
        const restorable = latestIdx.get(l.entryId) === i && !currentIds.has(l.entryId) && !!l.before
        return <li key={`${l.ts}-${i}`} className={`harness-event ${l.action}`}>
          <span><b>{actLabel(l)}{byLabel(l.by) && ` · ${byLabel(l.by)}`}</b>{title}</span>
          {restorable && <button type="button" className="profile-text-action" disabled={busy} onClick={() => void rollback(l.entryId, title)}>{t('settings.agents.harnessRestore')}</button>}
          <time dateTime={l.ts}>{stamp(l.ts)}</time>
        </li>
      })}</ol>
      {!showAll && rev.length > HISTORY_PREVIEW && <button type="button" className="profile-text-action" onClick={() => setShowAll(true)}>{t('settings.agents.harnessShowAll', { count: rev.length })}</button>}
    </section>}
    {/* 从详情页底栏挪进来(09-19):底栏常驻两行说明,窄栏里白占高度;放在面板末尾,读完笔记正好看到「谁写的、怎么撤」 */}
    {entries !== null && <p className="memory-footnote">{t('settings.agents.harnessHint')}</p>}
  </div>
}
