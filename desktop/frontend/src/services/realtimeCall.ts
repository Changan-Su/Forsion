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

export type CallPhase = 'connecting' | 'listening' | 'hearing' | 'thinking' | 'speaking'

export interface CallState {
  sessionId: string
  phase: CallPhase
  muted: boolean
  /** Tangu 正在代办的任务(模型转述的那句);null = 没有在途委派。 */
  working: string | null
  /** 波形条读的电平源:说话时是模型输出,其余是麦克风。 */
  analyser: AnalyserNode | null
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
  onActivity?: () => void
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

export async function startCall(o: StartCallOptions): Promise<void> {
  if (state) endCall()
  lastError = null
  state = { sessionId: o.sessionId, phase: 'connecting', muted: false, working: null, analyser: null }
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
      if (!sources.size && state?.phase === 'speaking') patch({ phase: 'listening', analyser: micAnalyser })
    }
    if (state?.phase !== 'speaking') patch({ phase: 'speaking', analyser: outAnalyser })
  }

  teardown = (error?: string) => {
    if (ended) return
    ended = true
    teardown = null
    flush()
    try { ws?.close() } catch { /* ignore */ }
    stream?.getTracks().forEach((t) => t.stop())
    void inCtx.close().catch(() => {})
    void outCtx.close().catch(() => {})
    lastError = error || null
    state = null
    emit()
    ping(300)
  }

  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 },
    })
    if (ended) { stream.getTracks().forEach((t) => t.stop()); return }
    const auth = (await o.target.headers()).Authorization || ''
    const url = `${o.target.base.replace(/^http/, 'ws')}/agent/realtime?token=${encodeURIComponent(auth.replace(/^Bearer\s+/i, ''))}`
    ws = new WebSocket(url)
    ws.binaryType = 'arraybuffer'
  } catch (e: any) {
    endCall(e?.message || String(e))
    return
  }

  const sock = ws
  sock.onopen = () => sock.send(JSON.stringify({ type: 'start', session_id: o.sessionId, model: o.model, voice: o.voice || undefined, title: o.title, run: o.run }))
  sock.onclose = (ev) => { if (!ended) endCall(ev.reason || (ev.code === 1000 ? undefined : `connection closed (${ev.code})`)) }
  sock.onmessage = (ev) => {
    if (ev.data instanceof ArrayBuffer) { play(ev.data); return }
    let m: any
    try { m = JSON.parse(String(ev.data)) } catch { return }
    switch (m.type) {
      case 'ready': {
        const src = inCtx.createMediaStreamSource(stream!)
        src.connect(micAnalyser)
        // ponytail: ScriptProcessorNode 已废弃但 Electron 仍支持;换 AudioWorklet 要单独的 worklet 模块文件。
        const proc = inCtx.createScriptProcessor(1024, 1, 1)
        src.connect(proc)
        proc.connect(inCtx.destination) // 不接到 destination 就不回调;输出缓冲不写 = 静音
        proc.onaudioprocess = (e) => {
          if (!state || state.muted || sock.readyState !== WebSocket.OPEN) return
          const f = e.inputBuffer.getChannelData(0)
          let sum = 0
          for (let i = 0; i < f.length; i++) sum += f[i] * f[i]
          const gated = sources.size > 0 && Math.sqrt(sum / f.length) < BARGE_IN_RMS
          const pcm = new Int16Array(f.length)
          if (!gated) for (let i = 0; i < f.length; i++) pcm[i] = Math.max(-32768, Math.min(32767, Math.round(f[i] * 32767)))
          sock.send(pcm.buffer)
        }
        patch({ phase: 'listening', analyser: micAnalyser })
        break
      }
      case 'input_audio_buffer.speech_started':
        flush() // 打断:模型的话立刻停,不等服务端
        patch({ phase: 'hearing', analyser: micAnalyser })
        break
      case 'input_audio_buffer.speech_stopped':
        patch({ phase: 'thinking' })
        break
      case 'conversation.item.input_audio_transcription.completed':
      case 'response.audio_transcript.done':
        ping()
        break
      case 'response.done':
        if (!sources.size && state?.phase === 'thinking' && m.response?.status !== 'completed') patch({ phase: 'listening', analyser: micAnalyser })
        break
      case 'tangu.run':
        patch({ working: m.status === 'started' ? String(m.task || '') : null })
        ping(m.status === 'started' ? 300 : 800)
        break
      case 'error':
        console.warn('[realtime] upstream error:', m.error?.message || m.error)
        break
      case 'end':
        endCall(m.reason && m.reason !== 'client closed' ? String(m.reason) : undefined)
        break
    }
  }
}
