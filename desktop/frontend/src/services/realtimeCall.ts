/**
 * 实时语音通话(对标 GPT Live)的渲染端:麦克风 16k PCM → 本机引擎 ws /agent/realtime → 百炼 Qwen-Omni-Realtime,
 * 模型语音 24k PCM 回来直接排进 WebAudio 播放。轮次、端点检测、打断判定都在服务端(server VAD);
 * 这边只管:用户一开口(speech_started)立刻清空播放队列,以及把「Tangu 正在处理」之类的状态给界面。
 *
 * 模块级单例(不是组件状态):通话要跨视图活着 —— 主页开打会建会话、切到会话视图,输入框实例会换。
 * 双方的话、代跑的 Tangu run 都由引擎写进会话;onActivity 让调用方当场拉一次(否则等常规轮询)。
 */
import { useSyncExternalStore } from 'react'
import type { EngineTarget } from './engine/target'
import { realtimeSocketUrl } from './backendService'
import { CALL_VOICE_BEAT_MS, CALL_VOICE_TICK_MS, postCallVoice } from './callVoice'

/** 设置浮窗(另一个 renderer)存完实时通话配置后 bump 这个 key:storage 事件跨 renderer 送达,主窗当场重读。 */
export const REALTIME_CFG_BUMP_KEY = 'forsion_realtime_cfg_rev'
let rtCfg = { model: '', voice: '' }
let rtCfgWired = false
const rtCfgListeners = new Set<() => void>()
function readRealtimeConfig(): void {
  void window.tangu?.getConfig?.().then((c) => {
    const next = { model: c.realtimeModelId?.trim() || '', voice: c.realtimeVoice?.trim() || '' }
    if (next.model === rtCfg.model && next.voice === rtCfg.voice) return
    rtCfg = next
    rtCfgListeners.forEach((l) => l())
  }).catch(() => {})
}
/** 输入框读的实时通话配置(模型空 = 不出按钮)。desktopConfig 只在本窗关设置时重读,设置浮窗改的它看不见,所以单独一条线。 */
export function useRealtimeConfig(): { model: string; voice: string } {
  return useSyncExternalStore((fn) => {
    if (!rtCfgWired) {
      rtCfgWired = true
      readRealtimeConfig()
      window.addEventListener('storage', (e) => { if (e.key === REALTIME_CFG_BUMP_KEY) readRealtimeConfig() })
      window.addEventListener('focus', readRealtimeConfig) // 兜底:投递时机错过的那次
    }
    rtCfgListeners.add(fn)
    return () => { rtCfgListeners.delete(fn) }
  }, () => rtCfg)
}

export type CallPhase = 'connecting' | 'reconnecting' | 'listening' | 'hearing' | 'thinking' | 'speaking'

export interface CallState {
  sessionId: string
  phase: CallPhase
  muted: boolean
  /** Tangu 正在代办的任务(模型转述的那句);null = 没有在途委派。 */
  working: string | null
  /** 头像光环读的电平源:说话时是模型输出,其余是麦克风。 */
  analyser: AnalyserNode | null
  /** 接通(ready)的时刻;通话计时从这里起。 */
  connectedAt: number | null
}

export interface StartCallOptions {
  target: EngineTarget
  sessionId: string
  /** <providerId>/<model>(设置 → 语音 → 实时通话)。 */
  model: string
  voice?: string
  /** 会话由引擎补建时的标题(正常路径会话已存在)。 */
  title: string
  run: { model_id: string; agent_config: object }
  /** 麦克风 / 扬声器的 deviceId;空 = 系统默认。设备拔了就退回默认(不用 exact,免得整通打不起来)。 */
  micId?: string
  speakerId?: string
  onActivity?: () => void
  /** 引擎改正了某行语音转写(实时模型听对、旁路识别听错时)。 */
  onTranscriptFix?: (messageId: string, text: string) => void
}

/** 跨窗口事件(通话跑在 Mini 窗,聊天区在主窗):localStorage 的 storage 事件只投给**别的**窗口。 */
export const CALL_EVENT_KEY = 'forsion_voice_call_evt'
export type CallEvent = { kind: 'activity'; sessionId: string } | { kind: 'effort'; sessionId: string; level: string }
  /** 主窗输入框 → Mini:通话中打的字;Mini 转进电话后回 text-ack(同 id)。 */
  | { kind: 'text'; sessionId: string; text: string; id: string; at: number } | { kind: 'text-ack'; id: string }
  /** Mini → 主窗:引擎用实时模型听到的原话改正了一行语音转写(轮询不刷已显示的消息,得点名替换)。 */
  | { kind: 'transcript'; sessionId: string; messageId: string; text: string }
export function postCallEvent(e: CallEvent): void {
  try { localStorage.setItem(CALL_EVENT_KEY, JSON.stringify({ ...e, n: `${Date.now()}-${Math.random()}` })) } catch { /* ignore */ }
}
/** 正在通话的会话(Mini 接通时写、收线时删)。主窗据此把打的字送进电话;跨窗靠 storage 事件,本窗改动直接通知。 */
const ACTIVE_KEY = 'forsion_voice_call_active'
const presenceListeners = new Set<() => void>()
let presenceWired = false
export function setCallPresence(sessionId: string | null): void {
  try { if (sessionId) localStorage.setItem(ACTIVE_KEY, sessionId); else localStorage.removeItem(ACTIVE_KEY) } catch { /* ignore */ }
  presenceListeners.forEach((l) => l())
}
export function getCallPresence(): string | null {
  try { return localStorage.getItem(ACTIVE_KEY) } catch { return null }
}
export function subscribeCallPresence(fn: () => void): () => void {
  if (!presenceWired) {
    presenceWired = true
    window.addEventListener('storage', (e) => { if (e.key === ACTIVE_KEY || e.key === null) presenceListeners.forEach((l) => l()) })
  }
  presenceListeners.add(fn)
  return () => { presenceListeners.delete(fn) }
}

/** 通话里打字的长度上限(引擎同口径截断);更长的照常交给 Tangu,别被截了还当送到了。 */
export const CALL_TEXT_MAX = 4000
/** Mini 只认这么新的 text 事件:比主窗超时(2s)短,超时改发 Tangu 之后晚到的那条不会再进电话(否则一句话办两遍)。 */
export const CALL_TEXT_FRESH_MS = 1500

/** 主窗:把打的字交给 Mini 里的通话。Mini 没在 2s 内确认(崩了 / 已挂、登记没来得及删)就清掉登记、返回 false,
 *  调用方改走普通发送 —— 打的字绝不能悄悄丢掉。 */
export function sendTextToCall(sessionId: string, text: string, timeoutMs = 2000): Promise<boolean> {
  const id = `${Date.now()}-${Math.random()}`
  return new Promise((resolve) => {
    const off = onCallEvent((e) => { if (e.kind === 'text-ack' && e.id === id) { off(); clearTimeout(timer); resolve(true) } })
    const timer = setTimeout(() => {
      off()
      if (getCallPresence() === sessionId) setCallPresence(null)
      resolve(false)
    }, timeoutMs)
    postCallEvent({ kind: 'text', sessionId, text, id, at: Date.now() })
  })
}

export function onCallEvent(fn: (e: CallEvent) => void): () => void {
  const h = (ev: StorageEvent): void => {
    if (ev.key !== CALL_EVENT_KEY || !ev.newValue) return
    try { fn(JSON.parse(ev.newValue)) } catch { /* ignore */ }
  }
  window.addEventListener('storage', h)
  return () => window.removeEventListener('storage', h)
}

/** 半双工兜底:放音期间,低于这个 RMS 的麦克风帧换成静音再上传。
 *  Chromium 回声消除对 WebAudio 外放不一定兜得住;回声漏进去会被服务端 VAD 当成插话,模型就自己掐断自己。
 *  ponytail: 固定阈值,外放环境吵 / 麦克风灵敏度差得多时要调(真人外放实测后定)。 */
export const BARGE_IN_RMS = 0.04
const OUT_RATE = 24000

let state: CallState | null = null
let lastError: string | null = null
const listeners = new Set<() => void>()
let teardown: ((reason?: string) => void) | null = null
let controls: { mic(id: string): Promise<void>; speaker(id: string): Promise<void>; run(run: StartCallOptions['run']): void; text(text: string): boolean } | null = null

const emit = (): void => listeners.forEach((l) => l())
const patch = (p: Partial<CallState>): void => { if (state) { state = { ...state, ...p }; emit() } }

export function subscribeCall(fn: () => void): () => void {
  listeners.add(fn)
  return () => { listeners.delete(fn) }
}
export const getCall = (): CallState | null => state
export const getCallError = (): string | null => lastError

export function endCall(error?: string): void {
  teardown?.(error)
}

export function toggleMute(): void {
  if (state) patch({ muted: !state.muted })
}

/** 通话中换麦克风 / 扬声器;没在通话就是空操作(下次开打从参数读)。 */
export const setCallMic = (id: string): Promise<void> => controls?.mic(id) ?? Promise.resolve()
export const setCallSpeaker = (id: string): Promise<void> => controls?.speaker(id) ?? Promise.resolve()
/** 通话中换委派参数(如 Effort):之后 ask_tangu 起的 run 按新参数跑。 */
export const updateCallRun = (run: StartCallOptions['run']): void => controls?.run(run)
/** 通话中打的字:模型的话当场停(同插话),文字送进电话,模型用语音回。没接通返回 false。 */
export const sendCallText = (text: string): boolean => controls?.text(text) ?? false

export async function startCall(o: StartCallOptions): Promise<void> {
  if (state) endCall()
  lastError = null
  state = { sessionId: o.sessionId, phase: 'connecting', muted: false, working: null, analyser: null, connectedAt: null }
  emit()

  let stream: MediaStream | null = null
  let ws: WebSocket | null = null
  const inCtx = new AudioContext({ sampleRate: 16000 }) // Chromium 自己把麦克风重采样到 16k
  const outCtx = new AudioContext({ sampleRate: OUT_RATE })
  const micAnalyser = inCtx.createAnalyser()
  const outAnalyser = outCtx.createAnalyser()
  outAnalyser.connect(outCtx.destination)
  const sources = new Set<AudioBufferSourceNode>()
  let playHead = 0
  let ended = false
  let micSrc: MediaStreamAudioSourceNode | null = null
  let proc: ScriptProcessorNode | null = null
  const micConstraints = (id?: string): MediaTrackConstraints => ({
    echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1, ...(id ? { deviceId: id } : {}),
  })
  // 麦克风源接到电平表 + 上传节点;换麦时整个换掉,proc 与 analyser 不动。
  const attachMic = (): void => {
    micSrc = inCtx.createMediaStreamSource(stream!)
    micSrc.connect(micAnalyser)
    if (proc) micSrc.connect(proc)
  }
  const setSink = (id: string): Promise<void> =>
    // AudioContext.setSinkId:Chromium 110+(Electron 40 有),TS lib 还没收
    ((outCtx as unknown as { setSinkId?: (id: string) => Promise<void> }).setSinkId?.(id) ?? Promise.resolve())
      .catch((e: unknown) => console.warn('[realtime] setSinkId failed:', e))
  // 只动自己这通:挂断 / 新通话之后,旧调用残留的回调(建连、onclose、播放结束)不许碰全局状态(Codex 10-01)。
  const own = (p: Partial<CallState>): void => { if (!ended) patch(p) }
  const ping = (delay = 500): void => { if (o.onActivity) window.setTimeout(o.onActivity, delay) }

  const flush = (): void => {
    sources.forEach((s) => { try { s.stop() } catch { /* 已停 */ } })
    sources.clear()
    playHead = 0
  }
  const play = (data: ArrayBuffer): void => {
    const pcm = new Int16Array(data, 0, data.byteLength >> 1)
    if (!pcm.length) return
    const buf = outCtx.createBuffer(1, pcm.length, OUT_RATE)
    const ch = buf.getChannelData(0)
    for (let i = 0; i < pcm.length; i++) ch[i] = pcm[i] / 32768
    const src = outCtx.createBufferSource()
    src.buffer = buf
    src.connect(outAnalyser)
    const at = Math.max(outCtx.currentTime + 0.05, playHead) // 50ms 抖动缓冲;网络帧比实时快,排在队尾
    src.start(at)
    playHead = at + buf.duration
    sources.add(src)
    src.onended = () => {
      sources.delete(src)
      if (!sources.size && state?.phase === 'speaking') own({ phase: 'listening', analyser: micAnalyser })
    }
    if (state?.phase !== 'speaking') own({ phase: 'speaking', analyser: outAnalyser })
  }

  // 把「模型此刻的声音」报给别的窗口:主窗 Desk 上的伴随形象按它做口型(见 callVoice.ts)。
  // 定时器而不是 rAF:卡片被别的窗口盖住时 rAF 会停,放着音的页面定时器不降频。
  const lvl = new Uint8Array(outAnalyser.fftSize)
  let saidPhase = ''
  let saidAt = 0
  const voiceTimer = window.setInterval(() => {
    if (ended || !state) return
    const speaking = state.phase === 'speaking'
    const now = Date.now()
    if (!speaking && state.phase === saidPhase && now - saidAt < CALL_VOICE_BEAT_MS) return
    let level = 0
    if (speaking) {
      outAnalyser.getByteTimeDomainData(lvl)
      const from = lvl.length >> 1 // 后半窗 ≈ 最近 43ms,与上报节拍相当;整窗(85ms)会把音节抹平
      let sum = 0
      for (let i = from; i < lvl.length; i++) { const v = (lvl[i] - 128) / 128; sum += v * v }
      level = Math.min(1, Math.sqrt(sum / (lvl.length - from)) * 4)
    }
    saidPhase = state.phase
    saidAt = now
    postCallVoice({ sessionId: o.sessionId, phase: state.phase, level })
  }, CALL_VOICE_TICK_MS)
  // 关窗即挂断:渲染进程直接没了,finish 不一定跑得到 —— 走之前撤掉,主窗的形象当场收声(没撤也有心跳超时兜底)。
  const voiceBye = (): void => postCallVoice(null)
  window.addEventListener('pagehide', voiceBye)

  const finish = (error?: string): void => {
    if (ended) return
    ended = true
    const current = teardown === finish
    if (current) teardown = null
    window.clearInterval(voiceTimer)
    window.removeEventListener('pagehide', voiceBye)
    if (current) voiceBye() // 被新通话顶掉的旧通话不许撤:那个 key 已经归新通话
    flush()
    try { ws?.close() } catch { /* ignore */ }
    stream?.getTracks().forEach((t) => t.stop())
    void inCtx.close().catch(() => {})
    void outCtx.close().catch(() => {})
    if (current) { controls = null; lastError = error || null; state = null; emit() }
    ping(300)
  }
  teardown = finish
  controls = {
    mic: async (id) => {
      const next = await navigator.mediaDevices.getUserMedia({ audio: micConstraints(id) })
      if (ended) { next.getTracks().forEach((t) => t.stop()); return }
      micSrc?.disconnect()
      stream?.getTracks().forEach((t) => t.stop())
      stream = next
      if (micSrc) attachMic() // 还没 ready 就只换流,ready 时再接
    },
    speaker: setSink,
    run: (run) => {
      o.run = run // 还没发 start 的话,start 直接带新值
      if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'run', run }))
    },
    text: (text) => {
      if (ended || !state?.connectedAt || state.phase === 'reconnecting' || ws?.readyState !== WebSocket.OPEN) return false // 重连中引擎收不下,让主窗改发 Tangu
      flush()
      own({ phase: 'thinking', analyser: micAnalyser })
      ws.send(JSON.stringify({ type: 'text', text }))
      ping() // 引擎落库那行,叫主窗拉
      return true
    },
  }

  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: micConstraints(o.micId) })
    if (ended) { stream.getTracks().forEach((t) => t.stop()); return }
    if (o.speakerId) await setSink(o.speakerId)
    const url = await realtimeSocketUrl(o.target)
    if (ended) return // 等鉴权头期间被挂断 / 被新通话顶掉
    ws = new WebSocket(url)
    ws.binaryType = 'arraybuffer'
  } catch (e: any) {
    finish(e?.message || String(e))
    return
  }

  const sock = ws
  sock.onopen = () => sock.send(JSON.stringify({ type: 'start', session_id: o.sessionId, model: o.model, voice: o.voice || undefined, title: o.title, run: o.run }))
  sock.onclose = (ev) => finish(ev.reason || (ev.code === 1000 ? undefined : `connection closed (${ev.code})`))
  sock.onmessage = (ev) => {
    if (ended) return
    if (ev.data instanceof ArrayBuffer) { play(ev.data); return }
    let m: any
    try { m = JSON.parse(String(ev.data)) } catch { return }
    switch (m.type) {
      case 'ready': {
        // 引擎换了一条上游重连好了:麦克风那一套原样接着用(再建一个上传节点 = 每帧发两遍),计时不清零。
        if (proc) { own(sources.size ? { phase: 'speaking', analyser: outAnalyser } : { phase: 'listening', analyser: micAnalyser }); break }
        // ponytail: ScriptProcessorNode 已废弃但 Electron 仍支持;换 AudioWorklet 要单独的 worklet 模块文件。
        proc = inCtx.createScriptProcessor(1024, 1, 1)
        proc.connect(inCtx.destination) // 不接到 destination 就不回调;输出缓冲不写 = 静音
        proc.onaudioprocess = (e) => {
          if (ended || !state || state.muted || sock.readyState !== WebSocket.OPEN) return
          const f = e.inputBuffer.getChannelData(0)
          let sum = 0
          for (let i = 0; i < f.length; i++) sum += f[i] * f[i]
          const gated = sources.size > 0 && Math.sqrt(sum / f.length) < BARGE_IN_RMS
          const pcm = new Int16Array(f.length)
          if (!gated) for (let i = 0; i < f.length; i++) pcm[i] = Math.max(-32768, Math.min(32767, Math.round(f[i] * 32767)))
          sock.send(pcm.buffer)
        }
        attachMic()
        own({ phase: 'listening', analyser: micAnalyser, connectedAt: Date.now() })
        break
      }
      case 'input_audio_buffer.speech_started':
        flush() // 打断:模型的话立刻停,不等服务端
        own({ phase: 'hearing', analyser: micAnalyser })
        break
      case 'input_audio_buffer.speech_stopped':
        own({ phase: 'thinking' })
        break
      case 'conversation.item.input_audio_transcription.completed':
      case 'response.audio_transcript.done':
        ping()
        break
      case 'response.done':
        if (!sources.size && state?.phase === 'thinking' && m.response?.status !== 'completed') own({ phase: 'listening', analyser: micAnalyser })
        break
      case 'transcript.corrected':
        if (typeof m.message_id === 'string' && typeof m.text === 'string') o.onTranscriptFix?.(m.message_id, m.text)
        break
      case 'tangu.run':
        own({ working: m.status === 'started' ? String(m.task || '') : null })
        ping(m.status === 'started' ? 300 : 800)
        break
      case 'error':
        console.warn('[realtime] upstream error:', m.error?.message || m.error)
        break
      case 'reconnecting': // 上游服务端出错断开,引擎正换一条。断在没答完的那句上(会重答)才掐掉半句;已生成完的回答照常放完
        if (m.replay) flush()
        own({ phase: 'reconnecting' })
        break
      case 'end':
        finish(m.reason && m.reason !== 'client closed' ? String(m.reason) : undefined)
        break
    }
  }
}
