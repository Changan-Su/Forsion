/**
 * 首次运行(first_run,遥测 v3 契约 §19):只给**新装**的 —— 本版本起本机记首启时刻;升级上来、本机已有使用痕迹
 * (成就计数 chat.send > 0,或会话列表真读回来时已有会话)的直接标成「不发」。第一次 run 结束(done / error / aborted)时
 * 这条记录就用掉了:遥测可发(Extend telemetry:get 报 active)才发;不可发就不发、也不补(下一次 run 不算「第一次」)。
 *
 * 状态存本机 localStorage(各窗口共用;主进程另按进程挡一道,多窗口同时收到 done 也只交一份)。
 * 只引 preload 桥,不引宿主模块(Tangu 界面会热更新到老宿主上)。
 */
import { tanguFirstRun } from './telemetry'

const KEY = 'forsion_first_run'
/** 成就计数的存储键(achievements/store.ts;这里只读 chat.send,不引那个模块)。 */
const ACHIEVEMENTS_KEY = 'forsion_tangu_achievements'
/** 会话的创建时间早于首启时刻这么多才算「本来就有」:时钟 / 时区解析的误差。 */
const SESSION_SLACK_MS = 60_000

interface FirstRunRecord {
  v: 1
  /** 首启时刻(本版本起第一次启动渲染层)。 */
  at: number
  /** pending = 还在等第一次 run;skip = 不是新装 / 拿不准;done = 第一次 run 已经结束(发没发都算用掉)。 */
  state: 'pending' | 'skip' | 'done'
  /** 会话列表真读回来过、确认是空的(拿到之前不下结论)。 */
  decided?: boolean
}

const storage = (): Storage | null => { try { return typeof localStorage === 'undefined' ? null : localStorage } catch { return null } }
function load(): FirstRunRecord | null {
  try {
    const r = JSON.parse(storage()?.getItem(KEY) || 'null') as FirstRunRecord | null
    return r && r.v === 1 && typeof r.at === 'number' && (r.state === 'pending' || r.state === 'skip' || r.state === 'done') ? r : null
  } catch { return null }
}
function save(r: FirstRunRecord): void { try { storage()?.setItem(KEY, JSON.stringify(r)) } catch { /* 存不下:下次启动再判 */ } }

function chatSends(): number {
  try {
    const raw = JSON.parse(storage()?.getItem(ACHIEVEMENTS_KEY) || 'null') as { counters?: Record<string, unknown> } | null
    const n = raw?.counters?.['chat.send']
    return typeof n === 'number' && n > 0 ? n : 0
  } catch { return 0 }
}

/** 启动时调一次:还没有记录就建一条(有使用痕迹 = skip)。读不了存储就什么都不做。 */
export function initFirstRun(now = Date.now()): void {
  const s = storage()
  if (!s || load()) return
  // 记录读不出来(坏 JSON)也算「已经有」,不重建:读失败 ≠ 新装
  try { if (s.getItem(KEY) !== null) return } catch { return }
  save(chatSends() > 0 ? { v: 1, at: now, state: 'skip' } : { v: 1, at: now, state: 'pending' })
}

/** 本端会话列表真读回来了(调用方只在读成功时调):首启前就有的会话 = 升级上来的,标 skip;一条都没有 = 确认是新装。 */
export function noteSessionsListed(sessions: ReadonlyArray<{ created_at?: string }>): void {
  const r = load()
  if (!r || r.state !== 'pending' || r.decided) return
  const before = sessions.some((x) => {
    const t = Date.parse(String(x.created_at ?? ''))
    return !Number.isFinite(t) || t < r.at - SESSION_SLACK_MS // 认不出时间的当「本来就有」
  })
  save(before ? { ...r, state: 'skip' } : { ...r, decided: true })
}

type TelemetryView = { active?: unknown }
type Bridge = { cloudInvoke?: (channel: string, ...args: unknown[]) => Promise<unknown> }

/** 一次 run 结束。是第一次(且确认是新装)就把记录用掉,遥测可发才交出去。 */
export function noteRunEnded(o: { outcome: 'done' | 'error' | 'aborted'; error?: string; durationMs?: number }, now = Date.now()): void {
  const r = load()
  if (!r || r.state !== 'pending') return
  if (!r.decided) { save({ ...r, state: 'skip' }); return } // 会话列表一直没读回来:拿不准是不是新装,宁可不发
  save({ ...r, state: 'done' }) // 先落「用掉了」:别的窗口同一刻收到 done 不会再发
  const sinceFirstLaunchS = Math.max(0, Math.round((now - r.at) / 1000))
  const durationMs = typeof o.durationMs === 'number' && Number.isFinite(o.durationMs) ? Math.max(0, Math.round(o.durationMs)) : undefined
  const bridge = (globalThis as { window?: { tangu?: Bridge } }).window?.tangu
  if (!bridge?.cloudInvoke) return
  void bridge.cloudInvoke('telemetry:get').then((v) => {
    if ((v as TelemetryView | null)?.active !== true) return
    tanguFirstRun({ outcome: o.outcome, ...(o.error ? { error: o.error } : {}), sinceFirstLaunchS, ...(durationMs !== undefined ? { durationMs } : {}) })
  }, () => { /* 读不到状态 = 不可发 */ })
}
