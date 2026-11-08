/**
 * Muse 面板(Muse Space 右栏 + 后台智能体详情页共用)。2026-11-07 右栏改版(方案页 docs/ToBeImproved/MuseSpace优化方案_2026-11-07/
 * panel.html,用户选 B、按建议先上 A):头行 = 名字 + 打开 Library + 设置 → 状态一行字(在想 / 等你批准 / 在睡 / 空闲)+ 一行下次醒来与权限档
 * → 要你批准(有才出,只展开第一件)→ 上一轮在想(正文、不加框、5 行 + 展开)→ 待办 → 它给自己排的 → 什么时候叫醒它。
 * 行操作悬停 / 键盘聚焦才出;待办勾了才出「放进会话 / 新对话里做」那条。没开:只留一行「未开启 · 去设置」,下面什么都不摆
 * (主区已经是「Muse 还没开」空态,不在侧栏再讲一遍,DESIGN §6 空态)。
 * 主区换成宿主模板(方案 D)那天,Space 右栏切到 B:待办、追踪中挪去主区,这里加「最近几轮」。外层容器负责 padding / 滚动。
 */
import React, { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { Sparkles, Check, X, Trash2, ShieldQuestion, MessageSquarePlus, FolderOpen, Settings, Pause, Play, Pencil, HeartPulse, AlarmClock, Zap, ChevronRight } from 'lucide-react'
import { setActiveSpace, useWorkspace } from '@lcl/engine'
import { syncAgentSpace } from '../builtins/agentSpaceSync'
import {
  getMuseStatus, getMuseTodos, patchMuseTodo, injectMuseTodos, listMessages, getMuseTriggers, deleteMuseTrigger, saveMuseTrigger,
  listMuseApprovals, decideMuseApproval, getAgentSchedules, deleteAgentScheduleEntry, postMuseFeedback,
} from '../services/backendService'
import { useApp } from '../stores/appStore'
import { openNewChat } from '../sessionNav'
import type { AgentScheduleEntry, MuseStatusInfo, MuseTodo, MuseTriggerInfo, PendingApprovalInfo, SessionRecord, TanguDesktopConfig } from '../types'
import { registerMessages, useI18n } from '../i18n'
import { formatDateTime, formatDayTime, formatMessageTime, formatRelative } from '../format/time'
import { formatRepeat } from '../format/repeat'
import { agentName } from '../agentName'
import { useAutomation } from '../stores/automationStore'
import { deleteWithUndo, isPendingDelete } from '../views/automation/automationListSource'
import { condText as ruleCondText, nextHeartbeatAt, noticeText, onlyText, triggerToUpsert } from '../views/automation/lib'
import '../views/automation/messages'
import { homeTarget, targetForSession } from '../services/engine/targets'
import { previewNeedsScrollHint } from './approvalText'
import { SelectField } from './SelectField'
import { colTime, trackWhen } from './museViewFormat'
import './museView.css'

registerMessages({
  'special.muse.off': { zh: '未开启', en: 'Off' },
  'special.muse.goSettings': { zh: '去设置', en: 'Settings' },
  'special.muse.rulePause': { zh: '暂停', en: 'Pause' },
  'special.muse.ruleResume': { zh: '恢复', en: 'Resume' },
  'special.muse.ruleEdit': { zh: '在画布里打开', en: 'Open in canvas' },
  'special.muse.rulePaused': { zh: '已暂停', en: 'Paused' },
  'special.muse.heartbeatEvery': { zh: '每 {n} 分钟，或你一有动静', en: 'Every {n} min, or when you’re active' },
  'special.muse.sleepingTitle': {
    zh: 'Muse 判断暂时没事可做，跳过心跳到这个时刻；你一有动作、规则命中或日程到期都会提前叫醒它。理由：{reason}',
    en: 'Muse found nothing to do and skips its heartbeat until then; your activity, a rule or a due schedule wakes it earlier. Reason: {reason}',
  },
  'musePanel.idle': { zh: '空闲', en: 'Idle' },
  'musePanel.idleWoke': { zh: '空闲 · {ago}醒过', en: 'Idle · woke {ago}' },
  'musePanel.running': { zh: '正在想', en: 'Thinking' },
  'musePanel.pending': { zh: '等你批准 {n} 件事', en: '{n} waiting for your OK' },
  'musePanel.sleeping': { zh: '在睡 · 到{time}', en: 'Asleep until {time}' },
  'musePanel.sleepWhy': { zh: '它自己定的：{reason}', en: 'Its own call: {reason}' },
  'musePanel.nextWake': { zh: '下次醒来 {time}', en: 'Next wake {time}' },
  'musePanel.mode.ask': { zh: '越界的事先问你', en: 'Asks you before going out of bounds' },
  'musePanel.mode.agent': { zh: '越界的事由默认 Agent 代批', en: 'Your default agent approves out-of-bounds steps' },
  'musePanel.mode.auto': { zh: '全自动', en: 'Fully automatic' },
  'musePanel.approvals': { zh: '要你批准', en: 'Needs your OK' },
  'musePanel.apWrite': { zh: '想写入一个文件', en: 'Wants to write a file' },
  'musePanel.apRun': { zh: '想运行 {tool}', en: 'Wants to run {tool}' },
  'musePanel.thinkLast': { zh: '上一轮在想', en: 'Last round' },
  'musePanel.thinkNow': { zh: '正在想', en: 'Thinking now' },
  'musePanel.live': { zh: '实时', en: 'Live' },
  'musePanel.more': { zh: '展开', en: 'More' },
  'musePanel.less': { zh: '收起', en: 'Less' },
  'musePanel.lastFailed': { zh: '上一轮没跑完：{e}', en: 'The last round did not finish: {e}' },
  'musePanel.todos': { zh: '待办', en: 'To-dos' },
  'musePanel.todosEmpty': { zh: '还没有待办。它想到值得替你做的事，会先放在这里。', en: 'No to-dos yet. When it finds something worth doing for you, it lands here first.' },
  'musePanel.selectAll': { zh: '全选', en: 'Select all' },
  'musePanel.selectNone': { zh: '取消', en: 'Clear' },
  'musePanel.selected': { zh: '已选 {n} 条', en: '{n} selected' },
  'musePanel.toSession': { zh: '放进这个会话', en: 'Send to this chat' },
  'musePanel.toNew': { zh: '新对话里做', en: 'Do in a new chat' },
  'musePanel.tracks': { zh: '它给自己排的', en: 'On its schedule' },
  'musePanel.wake': { zh: '什么时候叫醒它', en: 'What wakes it' },
  'musePanel.automation': { zh: '自动化', en: 'Automations' },
  'musePanel.heartbeat': { zh: '心跳', en: 'Heartbeat' },
  'musePanel.heartbeatOff': { zh: '心跳关着，只有规则和它排的日程会叫醒它', en: 'Heartbeat is off. Only rules and its schedule wake it' },
  'musePanel.rulesEmpty': { zh: '还没有规则。在私聊里跟它说「打开 Steam 时提醒我先做题」就能加一条。', en: 'No rules yet. Tell it "remind me to study when I open Steam" in your chat to add one.' },
})

const arr = <T,>(v: unknown): T[] => (Array.isArray(v) ? v : [])

/** 改文件的工具:标题写「想写入一个文件」,其余写工具名。 */
const WRITE_TOOLS: ReadonlySet<string> = new Set(['write_file', 'edit_file', 'multi_edit', 'apply_patch'])
/** pending_approvals.reason 是引擎 JSON.stringify 的 ApprovalReason → 「为什么问你」那行。坏串 / 旧行 / 认不出的 kind → 不写。
 *  ponytail: 没用 approvalReason.ts 的 approvalReasonText —— 那是 Tangu 界面文件,宿主不许直连(check:tanguboundary);
 *  这里只照抄 kind → 词条的映射,mode 档不写(Muse 的档位不是聊天那套,套聊天档名会说错)。 */
const reasonText = (raw: string | null, t: (k: string, v?: Record<string, string>) => string): string => {
  let r: { kind?: unknown; rule?: unknown } | null = null
  try { r = raw ? JSON.parse(raw) : null } catch { return '' }
  if (r?.kind === 'custom-ask') return t('approval.why.customAsk', { rule: String(r.rule ?? '').slice(0, 200) })
  if (r?.kind === 'escalate' || r?.kind === 'protected' || r?.kind === 'control' || r?.kind === 'always') return t(`approval.why.${r.kind}`)
  return ''
}
/** 时间型规则画闹钟,其余(看到某个活动、文件变化、插件事件)画闪电。 */
const TIME_CONDS: ReadonlySet<string> = new Set(['daily_at', 'at', 'every'])

export const MuseView: React.FC<{
  cfg: TanguDesktopConfig
  sessions: SessionRecord[]
  onInjected: (sessionId: string) => void
}> = ({ cfg, sessions, onInjected }) => {
  const { t, locale } = useI18n()
  const museDef = useApp((s) => s.agentDefs.find((a) => a.slug === 'muse'))
  const museName = agentName(museDef ?? { name: 'Muse', nameZh: '卜算子', nameEn: 'Muse', slug: 'muse' }, locale)
  const [status, setStatus] = useState<MuseStatusInfo | null>(null)
  const [todos, setTodos] = useState<MuseTodo[]>([])
  const [triggers, setTriggers] = useState<MuseTriggerInfo[]>([])
  const [approvals, setApprovals] = useState<PendingApprovalInfo[]>([])
  const [tracks, setTracks] = useState<AgentScheduleEntry[]>([])
  const [thinking, setThinking] = useState<string>('')
  const [thinkAt, setThinkAt] = useState<number>(0)
  const [thinkOpen, setThinkOpen] = useState(false)
  const [thinkClamped, setThinkClamped] = useState(false)
  const thinkRef = useRef<HTMLParagraphElement>(null)
  const [openTodos, setOpenTodos] = useState<Set<string>>(new Set())
  const [openApproval, setOpenApproval] = useState<string>('')
  const [sel, setSel] = useState<Set<string>>(new Set())
  const [target, setTarget] = useState<string>('')
  const [msg, setMsg] = useState('')
  const [busy, setBusy] = useState<string>('') // 正在裁决的审批 id(approve 会同步执行工具)
  // 本面板只列 Muse 的时机:叫醒它的规则(无动作链/无执行者;legacy 落盘可能有显式 agentSlug:'muse'=同义)
  // 和只做直接提醒的规则;别的自动化在自动化 Space 统一管理
  useAutomation((s) => s.refreshNonce) // 删除进入 / 撤出撤销窗口时重渲
  const museTriggers = triggers.filter((tg) => (!tg.actions?.length || tg.actions.every((a) => a.type === 'remind')) && (!tg.agentSlug || tg.agentSlug === 'muse') && !isPendingDelete({ kind: 'trigger', triggerId: tg.id }))
  const shownTracks = tracks.filter((e) => !isPendingDelete({ kind: 'schedule', slug: 'muse', rowId: e.id }))

  const load = async (): Promise<void> => {
    const st = await getMuseStatus(homeTarget()).catch(() => null)
    setStatus(st)
    void syncAgentSpace(cfg, 'muse', st?.spaceStamp) // 自建 Space 变了 → 只重载 agent-muse 插件(按戳去重)
    // 各列表缺省一律补空数组:老引擎 / 外部后端可能回一个不是数组的壳,渲染里的 .filter / .length 会崩掉整个面板。
    const nextTodos = arr<MuseTodo>(await getMuseTodos(homeTarget(), 'pending').catch(() => []))
    setTodos(nextTodos)
    setSel((p) => new Set([...p].filter((id) => nextTodos.some((x) => x.id === id)))) // 已被处理/消失的 TODO 不留在选择集里
    setTriggers(arr(await getMuseTriggers(homeTarget()).catch(() => [])))
    // 旧引擎无此端点 → 404 → 空列表(读端兜底,面板不红)。
    setApprovals(arr(await listMuseApprovals(homeTarget(), 'pending').catch(() => [])))
    setTracks(await getAgentSchedules(homeTarget()).then((all) => arr<AgentScheduleEntry>(arr<{ slug: string; entries?: AgentScheduleEntry[] }>(all).find((s) => s.slug === 'muse')?.entries).filter((e) => e.auto)).catch(() => []))
    if (st?.sessionId) {
      const ms = arr<{ role: string; content?: unknown; timestamp?: unknown }>(await listMessages(targetForSession(st.sessionId), st.sessionId, 6).catch(() => []))
      const lastAssistant = [...ms].reverse().find((m) => m.role === 'assistant' || m.role === 'model')
      // 每个周期一个新会话(09-27):新周期**还在跑**、没写出回复时留着上一轮的思考,别闪成空的;
      // 已经不在跑了还没有回复(周期失败)→ 清空,别把上一轮的当成「上一轮在想」一直挂着
      if (lastAssistant?.content) {
        setThinking(String(lastAssistant.content).slice(0, 4000))
        setThinkAt(typeof lastAssistant.timestamp === 'number' ? lastAssistant.timestamp : 0)
      } else if (!st.running) { setThinking(''); setThinkAt(0) }
    } else {
      setThinking(''); setThinkAt(0)
    }
  }
  // 串行轮询:上一轮(五个请求)全部结束后再等 4s,不与慢请求重叠;cfg 变了重起。
  useEffect(() => {
    let alive = true
    let timer: ReturnType<typeof setTimeout> | null = null
    const loop = async (): Promise<void> => {
      if (!alive) return
      await load()
      if (alive) timer = setTimeout(() => void loop(), 4000)
    }
    void loop()
    return () => { alive = false; if (timer) clearTimeout(timer) }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cfg])
  // 「展开」按实际有没有被截掉来给(六行短句也会被五行截断,按字数判会漏);栏宽一变重新量。展开着时量不出截断,靠 thinkOpen 留住「收起」。
  useLayoutEffect(() => {
    const el = thinkRef.current
    if (!el) { setThinkClamped(false); return }
    const measure = (): void => setThinkClamped(el.scrollHeight > el.clientHeight + 1)
    measure()
    if (typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    return () => ro.disconnect()
  }, [thinking, thinkOpen])

  const toggle = (id: string): void => setSel((p) => { const n = new Set(p); n.has(id) ? n.delete(id) : n.add(id); return n })
  const inject = async (): Promise<void> => {
    if (!target || !sel.size) return
    try {
      await injectMuseTodos(homeTarget(), [...sel], target)
      setMsg(t('special.muse.injected', { n: sel.size }))
      setSel(new Set())
      onInjected(target)
    } catch (e: any) {
      setMsg(t('special.muse.injectFail', { e: e?.message || e }))
    }
  }
  /** 新会话执行(08-20 评审的第②刀):走 appStore.send(…, null) 的隐式建会话路径,沿用当前默认工作区/模型/agent。 */
  const runInNew = async (): Promise<void> => {
    if (!sel.size) return
    const picked = todos.filter((x) => sel.has(x.id))
    if (!picked.length) return
    const message = `${t('special.muse.injectPrefix')}\n\n` + picked.map((x, i) => `${i + 1}. ${x.title}${x.detail ? `\n   ${x.detail}` : ''}`).join('\n\n')
    try {
      openNewChat()
      const ok = await useApp.getState().send(message, [], undefined, undefined, undefined, null)
      if (!ok) return
      for (const x of picked) await patchMuseTodo(homeTarget(), x.id, 'injected').catch(() => {})
      void postMuseFeedback(homeTarget(), `todos run in a new session by user: ${picked.map((x) => `"${x.title}"`).join('; ')}`).catch(() => {})
      setMsg(t('special.muse.injected', { n: picked.length }))
      setSel(new Set())
      const sid = useApp.getState().activeId
      if (sid) onInjected(sid)
    } catch (e: any) {
      setMsg(t('special.muse.injectFail', { e: e?.message || e }))
    }
  }
  // 删除类:请求成功才动列表;失败留在原地并说明(吞掉异常后先删再被轮询复活,用户只看到「闪一下」)。
  const fail = (e: any): void => setMsg(t('special.muse.actionFail', { e: e?.message || e }))
  const setTodoStatus = async (id: string, status: MuseTodo['status']): Promise<void> => {
    try { await patchMuseTodo(homeTarget(), id, status); setTodos((p) => p.filter((x) => x.id !== id)); setSel((p) => { const n = new Set(p); n.delete(id); return n }) } catch (e) { fail(e) }
  }
  // 规则 / 跟踪日程是引擎硬删(与 U-03 自动化删除同一类数据):走同一套「先藏起来、撤销窗口过了才真删」,
  // 自动化 Space 指向它的选中与列表由 deleteWithUndo 一并收拾。
  const removeTrigger = (id: string, name: string): void =>
    deleteWithUndo({ kind: 'trigger', triggerId: id }, name, () => deleteMuseTrigger(homeTarget(), id), () => { setTriggers((p) => p.filter((x) => x.id !== id)); setMsg('') })
  const removeTrack = (id: string, name: string): void =>
    deleteWithUndo({ kind: 'schedule', slug: 'muse', rowId: id }, name, () => deleteAgentScheduleEntry(homeTarget(), 'muse', id), () => { setTracks((p) => p.filter((x) => x.id !== id)); setMsg('') })
  const decide = async (a: PendingApprovalInfo, decision: 'approve' | 'reject'): Promise<void> => {
    setBusy(a.id)
    try {
      const r = await decideMuseApproval(homeTarget(), a.id, decision)
      // 200 也可能是「批准了但工具执行失败」(status=failed,result=错误文本):不能静默当成功。
      if (r.status === 'failed') setMsg(t('special.muse.execFailed', { e: String(r.result || '').slice(0, 200) }))
      else setMsg('')
      setApprovals((p) => p.filter((x) => x.id !== a.id)) // 无论 approved/failed/rejected,它都不再是 pending
    } catch (e: any) {
      setMsg(t('special.muse.approveFail', { e: e?.message || e }))
    } finally {
      setBusy('')
    }
  }
  const toggleRule = async (tg: MuseTriggerInfo): Promise<void> => {
    try {
      const saved = await saveMuseTrigger(homeTarget(), { ...triggerToUpsert({ ...tg, enabled: !tg.enabled }), actor: 'user' })
      setTriggers((p) => p.map((x) => (x.id === tg.id ? { ...x, ...saved } : x)))
    } catch (e) { fail(e) }
  }
  const openRule = (id: string): void => { useApp.getState().closeSettings(); setActiveSpace('automation'); void useAutomation.getState().openRule(id) }
  const openAutomation = (): void => { useApp.getState().closeSettings(); setActiveSpace('automation') }
  const openSettings = (): void => useApp.getState().openSettings('agents/ag-special/muse')
  const condText = (tg: MuseTriggerInfo): string =>
    'params' in tg.cond ? ruleCondText(t, tg.cond) : tg.cond.type === 'file_chars_gte'
      ? t('special.muse.trigFile', { path: tg.cond.path.split(/[\\/]/).pop() || tg.cond.path, n: tg.cond.n })
      : tg.cond.type === 'event_seen'
        ? t('special.muse.trigEvent', { match: tg.cond.match })
        : tg.cond.type === 'daily_at'
          ? t('special.muse.trigDaily', { time: tg.cond.time })
          : tg.cond.type === 'at'
            ? formatDayTime(tg.cond.datetime) || tg.cond.datetime.replace('T', ' ')
            : tg.cond.type === 'every'
              ? formatRepeat(t, tg.cond.interval)
              : '—'

  const off = !!status && !status.enabled
  const running = !!status?.running
  // Muse 自己定的休眠(set_next_wake):醒着 / 跑着时不显示;过期的休眠引擎侧已当醒着,这里再兜一次。
  const sleepUntil = !running && status?.sleepUntil && status.sleepUntil > Date.now() ? status.sleepUntil : 0
  const nextHeartbeat = nextHeartbeatAt(status)
  const pendingN = approvals.length || status?.pendingApprovals || 0
  const stateKey = running ? 'running' : pendingN > 0 ? 'pending' : sleepUntil ? 'sleeping' : 'idle'
  const stateLine = stateKey === 'running' ? t('musePanel.running')
    : stateKey === 'pending' ? t('musePanel.pending', { n: pendingN })
      : stateKey === 'sleeping' ? t('musePanel.sleeping', { time: formatDayTime(sleepUntil) })
        : status?.lastCycleAt ? t('musePanel.idleWoke', { ago: formatRelative(status.lastCycleAt) }) : t('musePanel.idle')
  const modeText = status?.mode ? t(`musePanel.mode.${status.mode === 'auto' || status.mode === 'agent' ? status.mode : 'ask'}`) : ''
  // 在睡时第一段换成它自己定的理由(到几点已经在上一行),权限档照写
  const stateMeta = [
    stateKey === 'sleeping' && status?.sleepReason ? t('musePanel.sleepWhy', { reason: status.sleepReason })
      : !running && nextHeartbeat ? t('musePanel.nextWake', { time: formatDayTime(nextHeartbeat) }) : '',
    modeText,
  ].filter(Boolean).join(' · ')
  const lastError = !running && !thinking && status?.lastError ? status.lastError : ''
  const shownApproval = approvals.find((a) => a.id === openApproval) ? openApproval : approvals[0]?.id
  const allSelected = todos.length > 0 && sel.size === todos.length

  return (
    <div className="mv" data-muse-panel="" data-state={off ? 'off' : stateKey}>
      <div className="mv-hd">
        <span className="mv-av" aria-hidden><Sparkles size={14} /></span>
        <b className="mv-name">{museName}</b>
        <span className="mv-sp" />
        <button type="button" className="icon-btn" title={t('muse.openLibrary')} aria-label={t('muse.openLibrary')} onClick={() => useWorkspace.getState().openView('muse-files', {}, 'main', { newTab: true })}><FolderOpen size={14} /></button>
        {/* Muse 开着时 Space 里唯一去设置的路;关着时下面那行「去设置」已经有了 */}
        {!off && <button type="button" className="icon-btn" data-action="muse-settings" title={t('muse.settings')} aria-label={t('muse.settings')} onClick={openSettings}><Settings size={14} /></button>}
      </div>

      {/* 没开:一行「未开启 · 去设置」(10-25 第四轮 4.1),下面什么都不摆 —— 主区那栏已经是「Muse 还没开」空态。status 还没回来时不说话。 */}
      {off ? (
        <div className="muse-off-line" data-state="disabled">
          {t('special.muse.off')} · <button type="button" className="muse-off-link" data-action="muse-settings" onClick={openSettings}>{t('special.muse.goSettings')}</button>
        </div>
      ) : <>
        {status && (
          <div className="mv-st" data-state={stateKey} title={stateKey === 'sleeping' && status.sleepReason ? t('special.muse.sleepingTitle', { reason: status.sleepReason }) : undefined}>
            <div className="mv-st-line"><i className="mv-dot" data-state={stateKey} />{stateLine}</div>
            {stateMeta && <div className="mv-meta">{stateMeta}</div>}
          </div>
        )}

        {/* 要你批准:ask/agent 档下 Muse 的越界写入 / 命令。批准 = 引擎按当时的原参数直接执行(写类先留检查点),不再经模型。
            只展开一件(缺省第一件),其余一行一件,点开换着看。 */}
        {(approvals.length > 0 || !!status?.pendingApprovals) && (
          <section className="mv-sec" data-section="approvals">
            <div className="mv-sh"><b>{t('musePanel.approvals')}</b><span>{pendingN}</span></div>
            {approvals.length === 0 && <div className="mv-hint">{t('special.muse.approvalsEmpty')}</div>}
            {approvals.map((a) => {
              const title = WRITE_TOOLS.has(a.tool) ? t('musePanel.apWrite') : t('musePanel.apRun', { tool: a.tool })
              if (a.id !== shownApproval) {
                return (
                  <button key={a.id} type="button" className="mv-ap-row" data-muse-approval={a.id} onClick={() => setOpenApproval(a.id)}>
                    <ShieldQuestion size={14} /><span className="mv-n">{title}</span><span className="mv-time">{colTime(formatMessageTime(a.created_at))}</span><ChevronRight size={13} />
                  </button>
                )
              }
              const why = reasonText(a.reason, t)
              return (
                // 7.18:和聊天里的 ApprovalCard 同一套 approval-* 排法(标题 → 为什么问你 → 预览占满宽 → 一行说明 → 按钮一排)。
                // 不直接挂 ApprovalCard:它吃的是 approval_request 事件,还会给「总允许」,Muse 的队列兑现不了。
                <div key={a.id} className="approval-card muse-approval" data-muse-approval={a.id}>
                  <div className="approval-title">
                    <ShieldQuestion size={15} style={{ color: 'var(--accent-ink)' }} />
                    {title}
                  </div>
                  {why && <div className="approval-why">{why}</div>}
                  {/* 批准 = 引擎按原参数直接执行:预览必须多行原样(`# 注释\nrm` 折成一行会像注释),超长给滚动与提示 */}
                  <div className="approval-preview" style={{ maxHeight: 240, overflow: 'auto', overflowWrap: 'anywhere' }}>{a.preview}</div>
                  {previewNeedsScrollHint(a.preview) && <div className="approval-why">{t('approval.previewScrollHint')}</div>}
                  <div className="approval-why">
                    {a.tool}{a.cwd ? ` · ${a.cwd}` : ''} · {formatMessageTime(a.created_at)}
                    {a.note && <div>{t('special.muse.approvalNote', { note: a.note })}</div>}
                  </div>
                  <div className="approval-actions">
                    <button className="btn primary sm" disabled={busy === a.id} onClick={() => void decide(a, 'approve')}>
                      <Check size={13} /> {t('special.muse.approve')}
                    </button>
                    <button className="btn danger sm" disabled={busy === a.id} onClick={() => void decide(a, 'reject')}>
                      <X size={13} /> {t('special.muse.reject')}
                    </button>
                  </div>
                </div>
              )
            })}
          </section>
        )}

        {/* 上一轮在想 / 正在想:正文,不加框(框读起来像输入框)。没开整格不画(10-02 用户拍板 v7);周期失败写原因,不挂上一轮的。 */}
        {status?.enabled && (thinking || lastError) && (
          <section className="mv-sec" data-section="thinking">
            <div className="mv-sh"><b>{t(running ? 'musePanel.thinkNow' : 'musePanel.thinkLast')}</b><span>{running ? t('musePanel.live') : thinkAt ? formatMessageTime(thinkAt) : ''}</span></div>
            {thinking
              ? <p ref={thinkRef} className={`mv-think${thinkOpen ? ' open' : ''}${running ? ' live' : ''}`}>{thinking}</p>
              : <p className="mv-think muted">{t('musePanel.lastFailed', { e: lastError.slice(0, 200) })}</p>}
            {thinking && (thinkOpen || thinkClamped) && (
              <button type="button" className="mv-link" onClick={() => setThinkOpen((v) => !v)}>{t(thinkOpen ? 'musePanel.less' : 'musePanel.more')}</button>
            )}
          </section>
        )}

        {/* 待办:一行一条;完成 / 略过悬停才出;勾了才出「放进会话 / 新对话里做」那条。 */}
        <section className="mv-sec" data-section="todos">
          <div className="mv-sh">
            <b>{t('musePanel.todos')}</b>{todos.length > 0 && <span>{todos.length}</span>}
            {todos.length > 1 && <button type="button" className="mv-link r" onClick={() => setSel(allSelected ? new Set() : new Set(todos.map((x) => x.id)))}>{t(allSelected ? 'musePanel.selectNone' : 'musePanel.selectAll')}</button>}
          </div>
          {todos.length === 0 && <div className="mv-hint">{t('musePanel.todosEmpty')}</div>}
          {todos.length > 0 && <div className="mv-rows">
            {todos.map((td) => (
              <div key={td.id} className={`mv-row${sel.has(td.id) ? ' on' : ''}`} data-todo-id={td.id}>
                <input type="checkbox" className="mv-check" checked={sel.has(td.id)} onChange={() => toggle(td.id)} aria-label={td.title} />
                {/* 标题整句换行;详情缺省两行,点开看全文(勾选 / 完成前要能读完它要做什么) */}
                {td.detail
                  ? <button type="button" className={`mv-rt mv-rt-btn${openTodos.has(td.id) ? ' open' : ''}`} aria-expanded={openTodos.has(td.id)} onClick={() => setOpenTodos((p) => { const n = new Set(p); n.has(td.id) ? n.delete(td.id) : n.add(td.id); return n })}><b>{td.title}</b><i>{td.detail}</i></button>
                  : <span className="mv-rt"><b>{td.title}</b></span>}
                <span className="mv-acts">
                  <button type="button" className="icon-btn" title={t('special.muse.markDone')} aria-label={t('special.muse.markDone')} onClick={() => void setTodoStatus(td.id, 'done')}><Check size={13} /></button>
                  <button type="button" className="icon-btn" title={t('special.muse.dismiss')} aria-label={t('special.muse.dismiss')} onClick={() => void setTodoStatus(td.id, 'dismissed')}><X size={13} /></button>
                </span>
              </div>
            ))}
          </div>}
          {sel.size > 0 && (
            <div className="mv-bar" data-section="inject">
              <span className="mv-bar-n">{t('musePanel.selected', { n: sel.size })}</span>
              <div className="mv-bar-pick">
                <SelectField size="sm" field="muse-target" ariaLabel={t('special.muse.pickSession')} value={target} onChange={setTarget}
                  options={[{ value: '', label: t('special.muse.pickSession') }, ...sessions.map((s) => ({ value: s.id, label: s.title || s.id.slice(0, 8) }))]} />
              </div>
              <button type="button" className="btn primary sm" disabled={!target} onClick={() => void inject()}>{t('musePanel.toSession')}</button>
              <button type="button" className="btn ghost sm" onClick={() => void runInNew()}><MessageSquarePlus size={12} /> {t('musePanel.toNew')}</button>
            </div>
          )}
          {msg && <div className="mv-hint" role="status">{msg}</div>}
        </section>

        {/* 它给自己排的:Muse 自己 SCHEDULE.db 的 auto 条目(任务卡「交给 Muse 追踪」/ Muse 自己排的后续),到期回灌它的周期;Calendar 同源可见。 */}
        <section className="mv-sec" data-section="tracks">
          <div className="mv-sh"><b>{t('musePanel.tracks')}</b>{shownTracks.length > 0 && <span>{shownTracks.length}</span>}</div>
          {shownTracks.length === 0 && <div className="mv-hint">{t('special.muse.tracksEmpty')}</div>}
          {shownTracks.length > 0 && <div className="mv-rows">
            {shownTracks.map((e) => (
              <div key={e.id} className="mv-row tl" title={e.lastRun ? t('special.muse.trigFired', { t: formatDateTime(e.lastRun) }) : undefined}>
                <span className="mv-time">{trackWhen(e.date)}</span>
                <span className="mv-rt"><b>{e.name}</b>{(e.repeat || e.description) && <i title={e.description || undefined}>{[e.repeat ? formatRepeat(t, e.repeat) : '', e.description || ''].filter(Boolean).join(' · ')}</i>}</span>
                <span className="mv-acts"><button type="button" className="icon-btn" title={t('special.muse.trackDelete')} aria-label={t('special.muse.trackDelete')} onClick={() => removeTrack(e.id, e.name)}><Trash2 size={13} /></button></span>
              </div>
            ))}
          </div>}
        </section>

        {/* 什么时候叫醒它:心跳一行 + Muse 唤醒式规则(只列无动作链/无执行者的老式规则;带动作的自动化归自动化 Space 统一管理)。 */}
        <section className="mv-sec" data-section="wake">
          <div className="mv-sh"><b>{t('musePanel.wake')}</b><button type="button" className="mv-link r" onClick={openAutomation}>{t('musePanel.automation')} →</button></div>
          <div className="mv-rows">
            {status?.enabled && (
              <div className="mv-row" data-next-heartbeat="">
                <HeartPulse size={14} className="mv-ric" />
                {/* 心跳开没开看 heartbeatMinutes;右边的时刻是下一次醒(可能是它自己定的休眠到点,心跳关着也会醒那一次) */}
                <span className="mv-rt"><b>{t('musePanel.heartbeat')}</b><i>{(status.heartbeatMinutes ?? 0) > 0 ? t('special.muse.heartbeatEvery', { n: status.heartbeatMinutes }) : t('musePanel.heartbeatOff')}</i></span>
                {nextHeartbeat ? <span className="mv-time">{colTime(formatDayTime(nextHeartbeat))}</span> : null}
              </div>
            )}
            {museTriggers.map((tg) => {
              const Icon = 'type' in tg.cond && TIME_CONDS.has(tg.cond.type) ? AlarmClock : Zap
              // 只发提醒的规则不叫醒它,写明是哪种,别和叫醒的混成一样
              const meta = [condText(tg), onlyText(t, tg), tg.actions?.length ? t('automation.step.remind') : t('automation.step.wake'), !tg.enabled ? t('special.muse.rulePaused') : tg.observe ? t('automation.ux.observing') : ''].filter(Boolean).join(' · ')
              return (
                <div key={tg.id} className={`mv-row muse-rule-row${tg.enabled ? '' : ' paused'}`} data-rule-id={tg.id} title={tg.lastFiredAt ? t('special.muse.trigFired', { t: formatDateTime(tg.lastFiredAt) }) : undefined}>
                  <Icon size={14} className="mv-ric" />
                  <span className="mv-rt"><b>{tg.desc}</b><i>{meta}</i>{tg.enabled && tg.notice && <i>{noticeText(t, tg.notice)}</i>}</span>
                  <span className="mv-acts">
                    <button type="button" className="icon-btn" title={t(tg.enabled ? 'special.muse.rulePause' : 'special.muse.ruleResume')} aria-label={t(tg.enabled ? 'special.muse.rulePause' : 'special.muse.ruleResume')} onClick={() => void toggleRule(tg)}>{tg.enabled ? <Pause size={13} /> : <Play size={13} />}</button>
                    <button type="button" className="icon-btn" title={t('special.muse.ruleEdit')} aria-label={t('special.muse.ruleEdit')} onClick={() => openRule(tg.id)}><Pencil size={13} /></button>
                    <button type="button" className="icon-btn" title={t('special.muse.watchDelete')} aria-label={t('special.muse.watchDelete')} onClick={() => removeTrigger(tg.id, tg.desc)}><Trash2 size={13} /></button>
                  </span>
                </div>
              )
            })}
          </div>
          {museTriggers.length === 0 && <div className="mv-hint">{t('musePanel.rulesEmpty')}</div>}
        </section>
      </>}
    </div>
  )
}
