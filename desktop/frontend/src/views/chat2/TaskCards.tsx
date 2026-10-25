/** 任务卡(```forsion-task)的渲染 + 落点按钮 —— 聊天(EditorialMessage)与收件箱(InboxBody)共用这一份。
 *  卡片本身什么也不做,点了才经 onTask 发消息 / 建 Muse 日程;做成了定格成「已…」(失败保留按钮)。
 *  任务书默认折叠但**必须可展开**:点下去发出的是任务书而不是标题,不能让用户看不见自己在同意什么。 */
import { useEffect, useState } from 'react'
import { create } from 'zustand'
import { ArrowDown, Check, ClipboardList, ChevronDown, ChevronRight, Clock, MessageSquarePlus, Play, Sparkles, X } from 'lucide-react'
import { registerMessages, useI18n } from '../../i18n'
import { useApp } from '../../stores/appStore'
import { getMuseTodo } from '../../services/backendService'
import { homeTarget } from '../../services/engine/targets'
import type { UiMessage } from '../../../../../tangu-agent/src/contracts/clientTypes'
import { splitSuggestions, type TaskCard } from './suggest'
import { ChildSessionsBlock } from './ChildSessions'
import { markTaskHandled, taskDoneKey, taskHandled, useTaskHandledVersion, TASK_CARD_TTL_MS, type TaskLanding } from './pendingTasks'
import './chat2.css'
import '../../tangu/messages' // Tangu 自己的文案片段(核心插件化 2c)

registerMessages({
  'chat.task.child': { zh: '开个子会话', en: 'Start child session' },
  'chat.task.askNew': { zh: '新会话', en: 'New session' },
  'chat.task.askTag': { zh: '等你选', en: 'Your call' },
  'chat.task.askNote': { zh: '你选之前什么都不会开始。', en: 'Nothing starts until you choose.' },
  'chat.task.valid': { zh: '7 天内有效', en: 'Valid for 7 days' },
  'chat.task.expired': { zh: '已过期 · 7 天没开始。要做就跟我说一声，我重新写一张。', en: 'Expired · not started within 7 days. Ask me and I’ll write a fresh one.' },
  'chat.task.withdrawn': { zh: '已撤回', en: 'Withdrawn' },
  'chat.task.childFail': { zh: '子会话没开起来：{e}', en: 'Couldn’t start the child session: {e}' },
  'chat.task.inDeck': { zh: '{n} 张任务卡 · 在对话最下面', en: '{n} task cards · at the end of the chat' },
  'chat.task.inDeck1': { zh: '任务卡「{title}」· 在对话最下面', en: 'Task card “{title}” · at the end of the chat' },
  'chat.task.traceDone': { zh: '任务卡「{title}」· {state}', en: 'Task card “{title}” · {state}' },
  'chat.task.redo': { zh: '要做就跟我说一声', en: 'Ask me to write a fresh one' },
  'chat.task.expiredShort': { zh: '已过期 · 7 天没开始', en: 'Expired · not started within 7 days' },
  'chat.task.todoHandled': { zh: '已处理', en: 'Handled' },
  'chat.task.todoGone': { zh: '已不存在', en: 'No longer exists' },
  'chat.task.todoReadFail': { zh: '状态读取失败', en: 'Couldn’t load its status' },
})

export { TASK_CARD_TTL_MS, type TaskLanding }

/** 已处理的任务卡记在 pendingTasks(落 localStorage,按会话 + 内容哈希):切走再切回、重启之后,卡片都不能又长出按钮 ——
 *  那是第二次建同一条日程的入口。从卡开出的子会话也记在那里:卡原地变成子会话行。
 *  进行中的卡(模块级):同一会话分屏 / 新标签挂了两份视图(或卡片堆里一张、流里一张)时,一处点了另一处也必须拒绝 —— busy 是组件私有状态挡不住(Codex 09-11 P1)。 */
const inFlightTaskCards = new Set<string>()
function hashStr(s: string): string {
  let h = 5381
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0
  return (h >>> 0).toString(36)
}
export function taskCardKey(ownerId: string, index: number, c: TaskCard): string {
  return `${ownerId}:${index}:${hashStr(`${c.title}|${c.prompt}`)}`
}

/** 一条消息里的撤回标记(`withdraw: <id>`):按消息对象缓存 —— 消息不可变,没变的消息不重扫;流式中的那条不算(还没写完)。 */
const withdrawCache = new WeakMap<UiMessage, string[]>()
function withdrawalsOf(m: UiMessage): string[] {
  if (m.role !== 'assistant' || m.status === 'streaming' || !m.content.includes('withdraw')) return []
  let hit = withdrawCache.get(m)
  if (!hit) {
    hit = splitSuggestions(m.content).tasks.filter((c) => c.withdraw).map((c) => `${c.withdraw}\u0000${c.reason || ''}`)
    withdrawCache.set(m, hit)
  }
  return hit
}
/** 同会话里被撤回的卡:id → 理由。选择器回一个串(没变就不重渲染)。 */
function useWithdrawn(sessionId?: string): Map<string, string> {
  const sig = useApp((s) => (sessionId ? (s.messagesBySession[sessionId] || []).flatMap(withdrawalsOf).join('\u0001') : ''))
  return new Map(sig ? sig.split('\u0001').map((x) => x.split('\u0000') as [string, string]) : [])
}

/** Muse TODO 卡按待办的真状态(按 id 现拉)决定给不给按钮:确认 pending 才给;还在查 / 读失败 / 已不存在 / 已处理都不给
 *  —— 否则一张旧卡(应用重启后模块级记录没了)能把已交给 Muse 的待办改成忽略、或再发一遍(Codex 09-11 P1)。
 *  收件箱里 Muse 的信与 Muse 私聊里它提的待办(10-18 方案 B)共用。没有 todo 卡 → status 为 undefined(TaskCards 不锁)。 */
/** 各处按 id 读到的 Muse 待办真状态(流里那行、卡片堆里那张、收件箱):卡片堆按它收不收这张卡 —— 谁读到新状态,
 *  卡片堆跟着进出(重试、换到这张卡时的重读、在别处处理掉)。按钮给不给仍按各自那一代的结果(见下),不读这份。 */
export const useMuseTodoSeen = create<Record<string, string>>(() => ({}))
const todoInflight = new Map<string, Promise<string>>()
/** 读一条待办的状态并记进 useMuseTodoSeen;同一 id 并发只发一次。 */
export function fetchMuseTodoStatus(id: string): Promise<string> {
  let p = todoInflight.get(id)
  if (!p) {
    p = getMuseTodo(homeTarget(), id)
      .then((t): string => t.status, (e: any): string => (e?.code === 'todo_not_found' ? 'missing' : 'error'))
      .then((st) => { todoInflight.delete(id); useMuseTodoSeen.setState({ [id]: st }); return st })
    todoInflight.set(id, p)
  }
  return p
}

export function useMuseTodoStatus(ownerId: string, tasks: TaskCard[]): { status: Record<string, string> | undefined; retry: () => void } {
  const cfg = useApp((s) => s.cfg)
  const todoKey = tasks.map((c) => c.todo || '').filter(Boolean).join(',')
  const [tick, setTick] = useState(0)
  // 结果按「归属 + 这组 id + 第几次拉」分代:换信 / 重拉的第一帧就当「还在查」,不会先闪出上一代的 pending 按钮。
  const gen = `${ownerId}|${todoKey}|${tick}`
  const [res, setRes] = useState<{ gen: string; map: Record<string, string> }>({ gen: '', map: {} })
  useEffect(() => {
    if (!todoKey) return
    let alive = true
    for (const id of todoKey.split(',')) {
      void fetchMuseTodoStatus(id).then((st) => { if (alive) setRes((p) => ({ gen, map: { ...(p.gen === gen ? p.map : {}), [id]: st } })) })
    }
    return () => { alive = false }
  }, [cfg, gen, todoKey])
  return { status: todoKey ? (res.gen === gen ? res.map : {}) : undefined, retry: () => setTick((n) => n + 1) }
}

function doneTextOf(done: TaskLanding | undefined, c: TaskCard): string {
  return done === 'here' ? 'chat.task.doneHere' : done === 'new' || done === 'child' ? 'chat.task.doneNew' : done === 'muse' ? (c.todo ? 'chat.task.doneMuseDo' : 'chat.task.doneMuse') : 'chat.task.doneIgnore'
}

/** 写卡那条回答下面:卡本身进了对话末尾的卡片堆(方案「待确认卡片」B),这里只留一行 —— 还在等你选的并成一行
 *  「N 张任务卡 · 在对话最下面」(点了滚过去),处理过 / 撤回 / 过期的各一行结局;从卡开出的子会话照旧原地变成子会话行。
 *  Muse 提的待办(todo 卡)按引擎里的真状态(todoStatus,MuseTodoTraces 传入):还 pending 才算在卡片堆里,还在查的先不画。 */
export function TaskTraces({ tasks, ownerId, sessionId, createdAt, onJump, todoStatus, onTodoRetry }: {
  tasks: TaskCard[]
  ownerId: string
  sessionId: string
  createdAt?: number
  /** 滚到对话末尾的卡片堆。 */
  onJump?: () => void
  todoStatus?: Record<string, string>
  onTodoRetry?: () => void
}) {
  const { t } = useI18n()
  const withdrawn = useWithdrawn(sessionId)
  useTaskHandledVersion()
  const expired = !!createdAt && Date.now() - createdAt > TASK_CARD_TTL_MS
  const rows: React.ReactNode[] = []
  const pending: TaskCard[] = []
  const line = (key: string, icon: React.ReactNode, text: string, state: string): React.ReactNode => (
    <div key={key} className="t2-dim t2-tasktrace" data-task-trace={state}>{icon}<span>{text}</span></div>
  )
  tasks.forEach((c, i) => {
    if (c.withdraw) return
    const key = taskCardKey(ownerId, i, c)
    const rec = taskHandled(taskDoneKey(sessionId, c))
    if (rec?.landing === 'child' && rec.childId) rows.push(<ChildSessionsBlock key={key} parentId={sessionId} ids={[rec.childId]} />)
    else if (rec) rows.push(line(key, <Check size={13} />, t('chat.task.traceDone', { title: c.title, state: t(doneTextOf(rec.landing, c)) }), rec.landing))
    else if (c.id && withdrawn.has(c.id)) rows.push(line(key, <X size={13} />, t('chat.task.traceDone', { title: c.title, state: `${t('chat.task.withdrawn')}${withdrawn.get(c.id) ? ` · ${withdrawn.get(c.id)}` : ''}` }), 'withdrawn'))
    else if (expired) rows.push(line(key, <Clock size={13} />, `${t('chat.task.traceDone', { title: c.title, state: t('chat.task.expiredShort') })} · ${t('chat.task.redo')}`, 'expired'))
    else if (c.todo && todoStatus) {
      const st = todoStatus[c.todo]
      if (st === 'pending') pending.push(c)
      else if (st === 'injected') rows.push(line(key, <Check size={13} />, t('chat.task.traceDone', { title: c.title, state: t('chat.task.doneMuseDo') }), 'muse'))
      else if (st === 'missing') rows.push(line(key, <X size={13} />, t('chat.task.traceDone', { title: c.title, state: t('chat.task.todoGone') }), 'missing'))
      else if (st === 'error') rows.push(
        <div key={key} className="t2-dim t2-tasktrace" data-task-trace="error">
          <X size={13} /><span>{t('chat.task.traceDone', { title: c.title, state: t('chat.task.todoReadFail') })}</span>
          {onTodoRetry && <button type="button" className="t2-taskcard-toggle" onClick={onTodoRetry}>{t('inbox.approval.retry')}</button>}
        </div>,
      )
      else if (st) rows.push(line(key, <Check size={13} />, t('chat.task.traceDone', { title: c.title, state: t('chat.task.todoHandled') }), 'handled'))
    }
    else pending.push(c)
  })
  if (pending.length) {
    rows.unshift(
      <button key="pending" type="button" className="t2-dim t2-tasktrace t2-tasktrace-jump" data-task-trace="pending" onClick={onJump}>
        <ClipboardList size={13} />
        <span>{pending.length === 1 ? t('chat.task.inDeck1', { title: pending[0].title }) : t('chat.task.inDeck', { n: pending.length })}</span>
        <ArrowDown size={12} />
      </button>,
    )
  }
  return rows.length ? <div className="t2-tasks t2-tasks--trace">{rows}</div> : null
}

export function TaskCards({ tasks, ownerId, onTask, noHere = false, todoStatus, onTodoRetry, sessionId, createdAt }: {
  tasks: TaskCard[]
  /** 卡片归属(消息 id):定格记录按它 + 卡序 + 内容哈希索引。 */
  ownerId: string
  /** 返回 false = 没做成(卡片保留按钮);其余(true / void)= 做成,卡片定格;{ childId } = 开出了子会话,卡原地变成子会话行。 */
  onTask?: (card: TaskCard, landing: TaskLanding) => boolean | void | { childId: string } | Promise<boolean | void | { childId: string }>
  /** 卡所在的会话(聊天):「开个子会话」挂在它下面,撤回标记也在它的消息里找。收件箱不传。 */
  sessionId?: string
  /** 写卡那条消息的时间(ms):超过 7 天的卡定格成「已过期」。不传不过期。 */
  createdAt?: number
  /** 收件箱没有当前会话:不给「在此执行」。 */
  noHere?: boolean
  /** Muse TODO 的真状态(id → status | 'missing' | 'error',收件箱按 id 现拉;缺键 = 还在查)。传了它,todo 卡只在确认 pending 后给按钮。 */
  todoStatus?: Record<string, string>
  /** 待办状态读取失败时的「重试」。 */
  onTodoRetry?: () => void
}) {
  const { t } = useI18n()
  // 任务卡各自一次性:做成了才定格成「已…」(失败保留按钮),busy 期间按钮禁用 —— 防双击把同一任务书发两遍 / 建两条日程。
  const [taskDone, setTaskDone] = useState<Record<string, TaskLanding>>({})
  const [taskBusy, setTaskBusy] = useState<string | null>(null)
  const [taskOpen, setTaskOpen] = useState<Record<string, boolean>>({})
  const withdrawn = useWithdrawn(sessionId)
  useTaskHandledVersion() // 另一处(卡片堆 / 分屏)处理了同一张,这里跟着定格
  // 能开子会话:本机引擎在场 + 这条会话自己不是子会话(子会话 / @项目派遣出的会话不能再开;分支能开)。否则回落「新会话执行」(Codex 10-17 #8)。
  const isChild = useApp((s) => { const x = sessionId ? s.sessions.find((y) => y.id === sessionId) : undefined; return !!x?.parent_session_id && !x.fork_message_id })
  const [, rerender] = useState(0)
  if (!tasks.some((c) => !c.withdraw)) return null
  const expired = !!createdAt && Date.now() - createdAt > TASK_CARD_TTL_MS
  return (
    <div className="t2-tasks">
      {tasks.map((c, i) => {
        if (c.withdraw) return null
        const key = taskCardKey(ownerId, i, c)
        const doneKey = taskDoneKey(sessionId || ownerId, c)
        const rec = taskHandled(doneKey)
        const done = taskDone[key] ?? rec?.landing
        const childId = rec?.childId
        // 开出了子会话:卡原地变成子会话行(同开出子会话那条回答下面的块)
        if (done === 'child' && childId && sessionId) return <ChildSessionsBlock key={key} parentId={sessionId} ids={[childId]} />
        const gone = !done && c.id && withdrawn.has(c.id) ? 'withdrawn' : !done && expired ? 'expired' : null
        // Muse TODO 卡只在确认 pending 后给按钮:还在查 / 读失败 / 已不存在 / 已在别处处理 —— 一律不给(Codex 09-11 P1)。
        const todoState = !done && c.todo && todoStatus ? (todoStatus[c.todo] ?? 'checking') : 'pending'
        const locked = todoState !== 'pending'
        const busy = taskBusy === key
        const open = !!taskOpen[key]
        // Muse 落点只在本地引擎在场时给(Web/移动端没有 /agent/special 端点,按钮只会失败)。
        const museOk = !!window.tangu?.backendStatus
        const pick = async (landing: TaskLanding): Promise<void> => {
          if (busy || done || locked || inFlightTaskCards.has(doneKey) || taskHandled(doneKey)) return
          if (createdAt && Date.now() - createdAt > TASK_CARD_TTL_MS) { rerender((n) => n + 1); return } // 挂着跨过 7 天:点的这一下定格成已过期
          inFlightTaskCards.add(doneKey)
          setTaskBusy(key)
          let ok = false
          let child: string | undefined
          try {
            const r = await onTask?.(c, landing)
            ok = r !== false
            if (r && typeof r === 'object') child = r.childId
          } catch { ok = false }
          inFlightTaskCards.delete(doneKey)
          setTaskBusy((b) => (b === key ? null : b))
          if (ok) { markTaskHandled(doneKey, landing, child); setTaskDone((p) => ({ ...p, [key]: landing })) }
        }
        const btn = (landing: TaskLanding, icon: React.ReactNode, label: string, primary = false): React.ReactNode => (
          <button key={landing} className={primary ? 'primary' : ''} disabled={busy} onClick={() => void pick(landing)}>{icon} {label}</button>
        )
        // Muse 当主按钮:追踪卡(track),以及 Muse 自己提的 TODO 卡(todo:「交给 Muse 执行」= 批准它去做,见 taskLanding)。
        const musePrimary = !!(c.track || c.todo) && museOk
        // 聊天里能开子会话:主按钮「开个子会话」(做完送回这里),其次「在这里做」;开不了(收件箱 / 子会话里 / 没有本机引擎):
        // 照旧「在这里做」+「新会话执行」(收件箱主按钮顺延给后者)。先问卡(ask)只有「新会话 / 在这里做」。
        // Muse 私聊里它提的待办(todo 卡,10-18 方案 B)按收件箱那张的落点:交给 Muse 执行 / 在此执行 / 新会话执行 / 忽略,不开子会话。
        const canChild = !noHere && !!sessionId && museOk && !isChild && !c.todo
        const child = canChild ? btn('child', <MessageSquarePlus size={12} />, t(c.ask ? 'chat.task.askNew' : 'chat.task.child'), c.ask || !musePrimary) : null
        const here = noHere ? null : btn('here', <Play size={12} />, t('chat.task.here'), !c.ask && !canChild && !musePrimary)
        const fresh = canChild ? null : btn('new', <MessageSquarePlus size={12} />, t(c.ask ? 'chat.task.askNew' : 'chat.task.new'), c.ask || (noHere && !musePrimary))
        const muse = museOk && !c.ask ? btn('muse', <Sparkles size={12} />, t(c.todo ? 'chat.task.museDo' : 'chat.task.muse'), musePrimary) : null
        const doneText = doneTextOf(done, c)
        return (
          <div key={key} className={`t2-taskcard${done || locked || gone ? ' done' : ''}${busy ? ' busy' : ''}`} data-task-state={gone || done || (c.ask ? 'ask' : 'open')}>
            <div className="t2-taskcard-head">
              <ClipboardList size={13} /> <b>{c.title}</b>
              {c.track && <span className="t2-taskcard-tag">{t('chat.task.trackTag')}</span>}
              {!done && !gone && !locked && (c.ask || createdAt) ? <span className="t2-taskcard-expire">{t(c.ask ? 'chat.task.askTag' : 'chat.task.valid')}</span> : null}
            </div>
            {c.tldr && <div className="t2-taskcard-tldr">{c.tldr}</div>}
            <button className="t2-taskcard-toggle" onClick={() => setTaskOpen((p) => ({ ...p, [key]: !open }))} aria-expanded={open}>
              {open ? <ChevronDown size={12} /> : <ChevronRight size={12} />} {t(open ? 'chat.task.hidePrompt' : 'chat.task.showPrompt')}
            </button>
            {open && <pre className="t2-taskcard-prompt" data-motion="enter">{c.prompt}</pre>}
            {gone
              ? <div className="t2-taskcard-done">{gone === 'expired' ? t('chat.task.expired') : `${t('chat.task.withdrawn')}${withdrawn.get(c.id!) ? ` · ${withdrawn.get(c.id!)}` : ''}`}</div>
              : done
              ? <div className="t2-taskcard-done">{t(doneText)}</div>
              : locked
                ? (
                  <div className="t2-taskcard-done">
                    {t(todoState === 'checking' ? 'chat.task.todoChecking' : todoState === 'error' ? 'chat.task.todoCheckFail' : todoState === 'missing' ? 'chat.task.todoMissing' : 'chat.task.doneTodo')}
                    {todoState === 'error' && onTodoRetry && <> <button className="t2-taskcard-toggle" onClick={onTodoRetry}>{t('inbox.approval.retry')}</button></>}
                  </div>
                )
                : (
                <>
                <div className="t2-taskcard-actions">
                  {c.ask ? [child ?? fresh, here] : musePrimary ? [muse, child, here, fresh] : [child, here, fresh, muse]}
                  {!c.ask && btn('ignore', <X size={12} />, t('chat.task.ignore'))}
                </div>
                {c.ask && <div className="t2-taskcard-note">{t('chat.task.askNote')}</div>}
                </>
              )}
          </div>
        )
      })}
    </div>
  )
}
