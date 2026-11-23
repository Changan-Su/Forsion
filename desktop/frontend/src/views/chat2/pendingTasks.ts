/** 任务卡(```forsion-task)的「处理过了没」+ 会话里还在等你选的那几张(对话末尾的卡片堆收它们,方案「待确认卡片」B)。
 *  处理记录落 localStorage:卡片堆按它判断收不收一张卡,不落盘的话重启后 7 天内的旧卡全部回到卡片堆。
 *  键 = 会话(收件箱是信 id)+ 卡内容哈希,不含消息 id 和卡序:消息 id 在乐观气泡 / 落库之间可能换,卡序在重排后会变。
 *
 *  聊天会话的记录同时记在引擎上(GET / POST /agent/sessions/:id/card-marks,11-23):同一台引擎的另一端(手机 / 网页 /
 *  连过来的电脑)打开同一会话,处理过的卡不再回到「N 件等你」、也不会被再执行一次。localStorage 退成缓存,看的时候取并集:
 *   - 只加不减:引擎没有的本机记录照旧算数、永不删;读引擎失败 = 不知道(照本机的看,不往回写空表);
 *   - 引擎读成功后,本机有、引擎没有的这个会话的记录补传上去(老记录 / 写失败的 / 引擎后来才升级的,一条规则全兜住);
 *   - 发的只是要记的那几条,引擎按键合并,两端同时记不同的卡互不覆盖;
 *   - 老引擎(没这条路由 / 远端老宿主 403)→ 只用本机记录,几分钟后再试;收件箱的卡(键是信 id)不发,只记本机。 */
import { useSyncExternalStore } from 'react'
import type { CardMarkRecord, UiMessage } from '../../../../../tangu-agent/src/contracts/clientTypes'
import { splitSuggestions, type CreationCard, type TaskCard } from './suggest'
import { humanAcked, humanChanges, type HumanChange } from '../../services/humanCollaboration'
import { getSessionCardMarks, postSessionCardMarks } from '../../services/backendService'
import { targetForSession } from '../../services/engine/targets'
import type { EngineTarget } from '../../services/engine/target'

/** 任务卡落点:开个子会话 / 在这里做 / 新会话执行(收件箱,没有当前会话)/ 交给 Muse / 忽略(spawn_task 的 worktree、云端两档刻意不搬)。 */
export type TaskLanding = 'child' | 'here' | 'new' | 'muse' | 'ignore'
/** 卡片 7 天内有效(方案「子会话与任务卡」第 3 步):过了就定格成「已过期」,要做让 agent 重写一张。 */
export const TASK_CARD_TTL_MS = 7 * 24 * 3600_000

const KEY = 'forsion_task_cards_handled'
type Rec = { l: TaskLanding; t: number; c?: string }
/** 任务卡 7 天就过期,记录多留一天够了;作品卡过了 7 天在原处照旧能点(不过期),它的记录一直留着(Codex 10-23)。引擎那边同一条。 */
const MARK_TTL_MS = TASK_CARD_TTL_MS + 24 * 3600_000
const LANDINGS: ReadonlySet<string> = new Set<TaskLanding>(['child', 'here', 'new', 'muse', 'ignore'])

function hashStr(s: string): string {
  let h = 5381
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0
  return (h >>> 0).toString(36)
}
/** 作品卡的处理记录(做成了 / 不用了)和任务卡记在同一处:按会话 + 名字与路径。 */
export function creationDoneKey(scope: string, c: CreationCard): string {
  return `${scope}:creation:${hashStr(`${c.name}|${c.path || ''}`)}`
}
/** Muse 待办按待办 id、带 id 的卡按卡 id 认(同样文字的两张不同待办不能共用一条记录,Codex 10-23);其余按内容。 */
export function taskDoneKey(scope: string, c: TaskCard): string {
  return `${scope}:${c.todo ? `todo:${c.todo}` : c.id ? `id:${c.id}` : hashStr(`${c.title}|${c.prompt}`)}`
}

/** 同一张卡两条记录取哪条(引擎 services/cardMarks.ts 同一条):「忽略」让位给真做了的;其余留先有的(保住先开出的子会话)。 */
export function pickMark<T extends { l: string }>(have: T | undefined, other: T | undefined): T | undefined {
  if (!have) return other
  if (other && have.l === 'ignore' && other.l !== 'ignore') return other
  return have
}
/** 记录还算不算数(creation = 作品卡记录,一直算)。 */
const markLive = (creation: boolean, v: Rec, now: number): boolean => creation || v.t > now - MARK_TTL_MS
const validRec = (v: unknown): v is Rec => !!v && typeof v === 'object' && LANDINGS.has((v as Rec).l) && typeof (v as Rec).t === 'number'

let recs: Record<string, Rec> | null = null
let version = 0
const listeners = new Set<() => void>()
function read(): Record<string, Rec> {
  const out: Record<string, Rec> = {}
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) || '{}') as Record<string, Rec>
    // ponytail: 作品卡记录不清,一条回答最多一张、量很小;多了再按会话归档清
    const now = Date.now()
    for (const [k, v] of Object.entries(raw)) if (v && typeof v.t === 'number' && markLive(k.includes(':creation:'), v, now)) out[k] = v
  } catch { /* 私密窗口 / 坏数据:当作没有记录 */ }
  return out
}
function load(): Record<string, Rec> {
  return (recs ??= read())
}
const bump = (): void => { version++; for (const f of listeners) f() }
// 别的窗口(Mini / 分离窗口各是一个渲染进程)记了一笔:作废缓存,跟着重渲
if (typeof window !== 'undefined') window.addEventListener('storage', (e) => { if (e.key === KEY || e.key === null) { recs = null; bump() } })
export function taskHandled(key: string): { landing: TaskLanding; childId?: string } | undefined {
  const r = pickMark(load()[key], engineRecOf(key))
  return r ? { landing: r.l, childId: r.c } : undefined
}
/** 记一张卡处理过了。sessionId = 卡所在的聊天会话(键以「会话 id:」开头):同时记到那台引擎上;收件箱不传,只记本机。 */
export function markTaskHandled(key: string, landing: TaskLanding, childId?: string, sessionId?: string): void {
  const rec: Rec = { l: landing, t: Date.now(), ...(childId ? { c: childId } : {}) }
  // 写之前重读一遍再并上:两个窗口各拿着旧快照整份写回,后写的会抹掉先写的那条(Codex 10-23)
  recs = { ...load(), ...read(), [key]: rec }
  try { localStorage.setItem(KEY, JSON.stringify(recs)) } catch { /* 存不下就只活到应用关闭 */ }
  bump()
  if (sessionId && key.startsWith(`${sessionId}:`)) pushMark(sessionId, key.slice(sessionId.length + 1), rec)
}
/** 处理记录一变就重渲(卡片堆据此把处理过的卡拿走)。 */
export function useTaskHandledVersion(): number {
  return useSyncExternalStore((f) => { listeners.add(f); return () => { listeners.delete(f) } }, () => version)
}

// ── 引擎那份(按会话)──────────────────────────────────────────────────────────────────────────────
/** ok = 读到过(marks 是引擎说过的并集,只加不减);error = 这次没读到(网络 / 5xx / 形状不对:过一会儿再试);
 *  absent = 引擎说没这个会话(删了 / 不是这台的)。读失败不清 marks,也不改本机记录。 */
type EngineEntry = { state: 'loading' | 'ok' | 'error' | 'absent'; at: number; marks: Record<string, Rec>; loading?: Promise<void> }
const engine = new Map<string, EngineEntry>()
/** 没这条路由的目标(老引擎 404 / 远端老宿主 403 / 405):几分钟内不再问 —— 引擎会热更新,不能记一辈子。 */
const unsupported = new Map<string, number>()
const REFRESH_MS = 30_000
const RETRY_MS = 30_000
const ABSENT_MS = 5 * 60_000
const UNSUPPORTED_MS = 5 * 60_000
const ENGINE_KEY_MAX = 200
const POST_BATCH = 200
/** 最近一次在看的会话(焦点回来时刷新它)+ 见过卡的会话(没卡的会话不去问引擎)。 */
let activeSid: string | null = null
const sessionsWithCards = new Set<string>()

function engineRecOf(key: string): Rec | undefined {
  const i = key.indexOf(':')
  if (i <= 0) return undefined
  return engine.get(key.slice(0, i))?.marks[key.slice(i + 1)]
}

/** 引擎回来的表并进缓存(只加不减;坏条目 / 过期的任务卡记录不收)。有变化返回 true。 */
function absorb(entry: EngineEntry, got: Record<string, CardMarkRecord>): boolean {
  const now = Date.now()
  let changed = false
  for (const [k, v] of Object.entries(got)) {
    if (!validRec(v) || !markLive(k.startsWith('creation:'), v, now)) continue
    const next = pickMark(entry.marks[k], v)
    if (next !== entry.marks[k]) { entry.marks[k] = next!; changed = true }
  }
  return changed
}

type Failure = 'session' | 'unsupported' | 'transient'
function failureOf(e: unknown): Failure {
  const x = e as { status?: unknown; code?: unknown } | null
  const status = typeof x?.status === 'number' ? x.status : 0
  if (status === 404 && x?.code === 'session_not_found') return 'session'
  if (status === 404 || status === 405 || status === 403 || status === 501) return 'unsupported'
  return 'transient'
}

function targetOf(sid: string): EngineTarget | null {
  try { return targetForSession(sid) } catch { return null }
}

/** 按需读一次引擎上这个会话的记录(去重、不抛、不同步 bump)。maxAge = 已有结果多旧才重读(缺省:读到过 30s、失败 30s、会话不在 5min)。 */
function ensureEngine(sid: string, maxAge?: number): Promise<void> | undefined {
  const now = Date.now()
  const had = engine.get(sid)
  if (had?.loading) return had.loading
  if (had) {
    const wait = maxAge ?? (had.state === 'ok' ? REFRESH_MS : had.state === 'absent' ? ABSENT_MS : RETRY_MS)
    if (now - had.at < wait) return undefined
  }
  const t = targetOf(sid)
  if (!t) return undefined
  const since = unsupported.get(t.key)
  if (since != null && now - since < UNSUPPORTED_MS) return undefined
  const entry: EngineEntry = had ?? { state: 'loading', at: now, marks: {} }
  engine.set(sid, entry)
  const run = (async () => {
    try {
      const got = await getSessionCardMarks(t, sid)
      unsupported.delete(t.key)
      absorb(entry, got)
      // 先置 ok 再补传:此后新记的直接 POST;此前记的在下面 reconcile 读本机时一并带上
      entry.state = 'ok'; entry.at = Date.now()
      bump()
      await reconcile(sid, t, entry)
    } catch (e) {
      const f = failureOf(e)
      if (f === 'unsupported') unsupported.set(t.key, Date.now())
      entry.state = f === 'session' ? 'absent' : 'error'
      entry.at = Date.now()
    } finally {
      entry.loading = undefined
    }
  })()
  entry.loading = run
  return run
}

/** 本机有、引擎没有(或引擎只记了「忽略」而本机是做了的)的这个会话的记录 → 补传。失败就算了,下次读成功再补。 */
async function reconcile(sid: string, t: EngineTarget, entry: EngineEntry): Promise<void> {
  const prefix = `${sid}:`
  const local = { ...read(), ...(recs || {}) }
  const missing = Object.entries(local).filter(([k, v]) => {
    if (!k.startsWith(prefix)) return false
    const rest = k.slice(prefix.length)
    if (!rest || rest.length > ENGINE_KEY_MAX) return false
    return pickMark(entry.marks[rest], v) !== entry.marks[rest]
  }).map(([k, v]) => [k.slice(prefix.length), v] as const)
  for (let i = 0; i < missing.length; i += POST_BATCH) {
    const got = await postSessionCardMarks(t, sid, Object.fromEntries(missing.slice(i, i + POST_BATCH)))
    if (absorb(entry, got)) bump()
  }
}

function pushMark(sid: string, rest: string, rec: Rec): void {
  if (!rest || rest.length > ENGINE_KEY_MAX) return
  const entry = engine.get(sid)
  if (entry?.state !== 'ok') { void ensureEngine(sid, 0); return } // 还没读到:读成功后 reconcile 会把它带上
  const t = targetOf(sid)
  if (!t) return
  postSessionCardMarks(t, sid, { [rest]: rec }).then((got) => { if (absorb(entry, got)) bump() }, () => { /* 下次读成功时 reconcile 补 */ })
}

/** 卡片堆 / 回答下面那行算卡之前调:这个会话有卡就去引擎读一下(异步,读回来 bump 重渲)。 */
function watchSession(sid: string, hasCards: boolean): void {
  activeSid = sid
  if (!hasCards) return
  sessionsWithCards.add(sid)
  void ensureEngine(sid)
}

/** 点卡执行前跟引擎再对一下(另一端可能刚处理过):最多等 timeoutMs,等不到照旧往下走(引擎慢 / 不在不能卡住按钮)。 */
export async function refreshCardMarks(sid: string, maxAgeMs = 5_000, timeoutMs = 1_500): Promise<void> {
  sessionsWithCards.add(sid)
  const p = ensureEngine(sid, maxAgeMs)
  if (!p) return
  let timer: ReturnType<typeof setTimeout> | undefined
  await Promise.race([p, new Promise<void>((r) => { timer = setTimeout(r, timeoutMs) })])
  if (timer) clearTimeout(timer)
}

// 切回窗口 / 应用回到前台:在看的那个会话重读一次(别的端这期间可能处理了卡)
if (typeof window !== 'undefined') {
  const back = (): void => {
    if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return
    if (activeSid && sessionsWithCards.has(activeSid)) void ensureEngine(activeSid, 5_000)
  }
  window.addEventListener('focus', back)
  if (typeof document !== 'undefined') document.addEventListener('visibilitychange', back)
}

/** 卡片堆里的一张任务卡。id 带消息 id 和卡序,只在这一屏里用来区分;判断处理过没用 doneKey。 */
export interface PendingTask { kind: 'task'; id: string; messageId: string; card: TaskCard; createdAt?: number; doneKey: string }

const tasksCache = new WeakMap<UiMessage, TaskCard[]>()
export function tasksOf(m: UiMessage): TaskCard[] {
  let hit = tasksCache.get(m)
  // Muse 私聊里它提的待办(origin proactive:todo):`todo:` 头只在这种消息上生效(同 EditorialMessage)
  if (!hit) { hit = m.content.includes('forsion-task') ? splitSuggestions(m.content, { kinds: ['task'], todo: m.origin === 'proactive:todo' }).tasks : []; tasksCache.set(m, hit) }
  return hit
}

/** 会话里还在等你选的任务卡,按出现顺序。不收:流式中的、撤回的、过 7 天的、处理过的。
 *  Muse 提的待办(带 `todo:` 的卡)状态在引擎那边:只收 musePending 里有的(引擎确认还 pending);没拉到(null)就先不收。 */
export function pendingTaskCardsOf(list: UiMessage[] | undefined, sessionId: string, now = Date.now(), musePending?: ReadonlySet<string> | null): PendingTask[] {
  const done = (m: UiMessage): boolean => m.role === 'assistant' && m.status === 'done'
  const withdrawn = new Set<string>()
  for (const m of list || []) if (done(m)) for (const c of tasksOf(m)) if (c.withdraw) withdrawn.add(c.withdraw)
  const out: PendingTask[] = []
  watchSession(sessionId, (list || []).some((m) => done(m) && !(m.timestamp && now - m.timestamp > TASK_CARD_TTL_MS) && tasksOf(m).some((c) => !c.withdraw)))
  for (const m of list || []) {
    if (!done(m)) continue
    if (m.timestamp && now - m.timestamp > TASK_CARD_TTL_MS) continue
    tasksOf(m).forEach((card, i) => {
      if (card.withdraw || (card.id && withdrawn.has(card.id))) return
      if (card.todo && !musePending?.has(card.todo)) return
      const doneKey = taskDoneKey(sessionId, card)
      if (taskHandled(doneKey)) return
      out.push({ kind: 'task', id: `task:${m.id}:${i}`, messageId: m.id, card, createdAt: m.timestamp || undefined, doneKey })
    })
  }
  return out
}

/** 卡片堆里的一张作品卡(```forsion-creation):还没做成、也没点「不用了」的。 */
export interface PendingCreation { kind: 'creation'; id: string; messageId: string; card: CreationCard; createdAt?: number; doneKey: string }
const creationsCache = new WeakMap<UiMessage, CreationCard[]>()
function creationsOf(m: UiMessage): CreationCard[] {
  let hit = creationsCache.get(m)
  if (!hit) { hit = m.content.includes('forsion-creation') ? splitSuggestions(m.content, { kinds: ['creation'] }).creations : []; creationsCache.set(m, hit) }
  return hit
}
/** 会话里还在等你点的作品卡,按出现顺序;过 7 天的不收(原处照旧摆整张)。会话工作目录本来就是造物(卡已完成)由调用方判。 */
export function pendingCreationCardsOf(list: UiMessage[] | undefined, sessionId: string, now = Date.now()): PendingCreation[] {
  const out: PendingCreation[] = []
  const live = (m: UiMessage): boolean => m.role === 'assistant' && m.status === 'done' && !(m.timestamp && now - m.timestamp > TASK_CARD_TTL_MS)
  if ((list || []).some((m) => live(m) && creationsOf(m).length > 0)) watchSession(sessionId, true)
  for (const m of list || []) {
    if (!live(m)) continue
    creationsOf(m).forEach((card, i) => {
      const doneKey = creationDoneKey(sessionId, card)
      if (!taskHandled(doneKey)) out.push({ kind: 'creation', id: `creation:${m.id}:${i}`, messageId: m.id, card, createdAt: m.timestamp || undefined, doneKey })
    })
  }
  return out
}

/** 卡片堆里的一张协作请求卡(Agent 改了协作说明,请你配合):还没「知道了」/ 撤销的。 */
export interface PendingHuman { kind: 'human'; id: string; messageId: string; changes: HumanChange[]; agentName?: string; createdAt?: number }
/** 会话里还没处理的协作请求卡;过 7 天的不收(原处照旧摆整张)。不看回答收没收尾:写入在工具结果那一刻就生效了,
 *  回答之后被停 / 出错,卡也得能处理(流里那行照样指过来,Codex 10-23)。 */
export function pendingHumanCardsOf(list: UiMessage[] | undefined, now = Date.now()): PendingHuman[] {
  const out: PendingHuman[] = []
  for (const m of list || []) {
    if (m.role !== 'assistant' || !m.toolEvents?.length) continue
    if (m.timestamp && now - m.timestamp > TASK_CARD_TTL_MS) continue
    const changes = humanChanges(m.toolEvents)
    if (changes.length && !humanAcked(changes.map((c) => c.id))) out.push({ kind: 'human', id: `human:${m.id}`, messageId: m.id, changes, agentName: m.agentName, createdAt: m.timestamp || undefined })
  }
  return out
}
