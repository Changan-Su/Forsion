/**
 * 语音通话里「模型此刻的声音」跨窗口的那一截(2026-10-04):通话跑在 Mini 渲染进程(realtimeCall),
 * Desk 上的伴随形象在主窗 —— Mini 把通话相位与模型输出电平报出来,主窗的 agentStatus 叠上它
 * (tanguProbe 的 withCallVoice),插件据此做口型。
 *
 * 叶子模块(零 import):tanguProbe 引它,别把 realtimeCall(麦克风 / WebSocket)拖进探针的依赖图。
 * 走 localStorage 的 storage 事件 —— 与 CALL_EVENT_KEY 同一条已验证的跨窗通道,单独一个 key(那边的监听不必解析电平)。
 * ponytail: 20Hz 写 localStorage,够「音量开合」的口型;要逐音素那种密度再换 BroadcastChannel
 *   (打包版是 file:// 源,换之前先实测它跨窗送不送得到)。
 */
export const CALL_VOICE_KEY = 'forsion_voice_call_voice'
/** Mini 的上报节拍:说话时每拍都报(带电平);其余相位只在变了时报,外加心跳。 */
export const CALL_VOICE_TICK_MS = 50
export const CALL_VOICE_BEAT_MS = 1000
/** 电平这么久没更新就按 0 读:Mini 没了(崩 / 被杀,来不及撤)嘴不能一直张着。 */
const LEVEL_STALE_MS = 300
/** 连心跳都断了这么久 = 通话没了,整条作废。比电平宽得多:主线程卡一下不该让相位闪一下(闪 = 插件重播动作)。 */
const VOICE_STALE_MS = 2500

export interface CallVoice {
  sessionId: string
  /** realtimeCall 的 CallPhase(叶子模块,不 import 它)。 */
  phase: string
  /** 模型输出电平 0..1(RMS×4 截顶,与通话卡头像光环同一口径);非 speaking 恒 0。 */
  level: number
  /** 进入这个相位的时刻(ms,接收端的钟)。 */
  since: number
}

/** Mini 那头:报一次;null = 通话结束。带 t 是因为写入相同的值不触发 storage 事件(心跳会被吞)。 */
export function postCallVoice(v: { sessionId: string; phase: string; level: number } | null): void {
  try {
    if (v) localStorage.setItem(CALL_VOICE_KEY, JSON.stringify({ ...v, t: Date.now() }))
    else localStorage.removeItem(CALL_VOICE_KEY)
  } catch { /* ignore */ }
}

let voice: CallVoice | null = null
let levelAt = 0
let staleTimer: ReturnType<typeof setTimeout> | undefined
let wired = false
const listeners = new Set<() => void>()

/** 收一条(storage 事件的 newValue;null / 不成形 = 通话结束)。只有会话或相位变了才通知订阅方,电平不通知。导出给单测。 */
export function ingestCallVoice(raw: string | null): void {
  clearTimeout(staleTimer)
  let m: { sessionId?: unknown; phase?: unknown; level?: unknown } | null = null
  try { m = raw ? JSON.parse(raw) : null } catch { m = null }
  const prev = voice
  if (m && typeof m.sessionId === 'string' && typeof m.phase === 'string') {
    const same = prev?.sessionId === m.sessionId && prev.phase === m.phase
    voice = { sessionId: m.sessionId, phase: m.phase, level: Math.min(1, Math.max(0, Number(m.level) || 0)), since: same ? prev.since : Date.now() }
    levelAt = Date.now()
    staleTimer = setTimeout(() => ingestCallVoice(null), VOICE_STALE_MS)
  } else voice = null
  if (prev?.sessionId !== voice?.sessionId || prev?.phase !== voice?.phase) listeners.forEach((l) => l())
}

function wire(): void {
  if (wired || typeof window === 'undefined' || typeof window.addEventListener !== 'function') return // 后者:node 单测里的半个 window
  wired = true
  // 只听事件、不读现值:崩掉的 Mini 留在 localStorage 里的那条不许在下次启动时复活。
  window.addEventListener('storage', (e) => { if (e.key === CALL_VOICE_KEY || e.key === null) ingestCallVoice(e.key ? e.newValue : null) })
}

/** 别的窗口里正在进行的通话此刻的声音;没有通话(或在通话窗口自己里 —— storage 事件不投给写的那个窗口)= null。 */
export function getCallVoice(): CallVoice | null {
  wire()
  if (voice && voice.level > 0 && Date.now() - levelAt > LEVEL_STALE_MS) voice = { ...voice, level: 0 }
  return voice
}

export function subscribeCallVoice(fn: () => void): () => void {
  wire()
  listeners.add(fn)
  return () => { listeners.delete(fn) }
}
