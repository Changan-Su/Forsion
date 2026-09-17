/**
 * 实时语音对话(免手)hook:开着就一直听,说完一句自动转写 → onUtterance(text)。
 * 与 useVoiceInput(按住说)并列、互不影响;不绑 Tangu,自动发送由调用方决定。
 * paused=true 时不接新的开口(Agent 回复中;第 3/4 步 TTS 放音防回灌也喂这里),说到一半的那句照常收完。
 *
 * 一场实时对话 = 一个 LiveSession(采集 + 串行转写队列 + 在途发送 + 排队 + 存活位)。组件实例只是它的「接收方」:
 * 主页说出第一句 → 切到会话视图、Composer 换实例时,整个 session 交给显式声明 owner 的下一个实例,
 * 在途状态与排队中的句子一并跟过去(评审 r2:接收方/会话别从 prop 形状推断,在途状态别存在组件 ref 里)。
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { registerMessages, translate } from '../i18n'
import { isNoiseTranscript, startLiveCapture, type LiveCapture } from './liveCapture'
import { wavBase64 } from './useVoiceInput' // 同时注册了 voiceinput.* 报错文案

registerMessages({
  'livevoice.start': { zh: '实时语音对话(免手:说完停顿一下自动发送)', en: 'Live voice conversation (hands-free: pause after speaking to send)' },
  'livevoice.stop': { zh: '结束实时对话', en: 'End live conversation' },
  'livevoice.asrTimeout': { zh: '语音识别超时', en: 'Speech recognition timed out' },
})

export type LivePhase = 'off' | 'starting' | 'listening' | 'speaking' | 'transcribing'

export interface LiveVoiceState {
  phase: LivePhase
  active: boolean
  error: string | null
  analyser: AnalyserNode | null
  supported: boolean
  start: () => void
  stop: () => void
  /** 通话中用户手动发的消息也登记为「在途」:它引起的会话切换(空态建会话)不算用户切走。 */
  track: (sent: Promise<unknown> | undefined) => void
}

/** deliver 返回发送的 promise(resolve false = 没被接受)= 已发出;返回 void = 只进了草稿没发。 */
type Deliver = (text: string) => Promise<unknown> | void
interface Receiver {
  deliver: Deliver
  /** 没发成的话交还给当前接收方(放回草稿),而不是发起那次发送、可能已卸载的实例。 */
  keep: (text: string) => void
  /** 在途发送结束且有排队句:下一次提交之后再发(此刻组件闭包还是上一轮渲染的,附件/引用还没清)。 */
  flush: () => void
  phase: (p: LivePhase) => void
  error: (e: string | null) => void
  fatal: () => void
}
interface LiveSession {
  cap: LiveCapture | null
  alive: boolean
  queue: Promise<void>
  pending: number
  failures: number
  inFlight: Promise<unknown> | null
  backlog: string[]
  rx: Receiver
}

const HANDOFF_MS = 5000 // 交接槽没人接手就关麦的兜底
const MAX_FAILURES = 2 // 连续转写失败(没配 ASR、服务端挂了)就收场,别每句都红一次
// 交接槽:只由声明 handoffOnSend 的实例(主页输入框)在「发送途中失去接收方身份/卸载」时占用;只有 owner 实例能接手。
let handoff: { s: LiveSession; at: number; parked: string[]; kept: string[] } | null = null

function kill(s: LiveSession): void { s.alive = false; s.cap?.stop() }

/** 登记一次在途发送。text = 实时对话发出的那句(没被接受 → 连同排队句交还草稿并收场);null = 用户手动发的。 */
function watch(s: LiveSession, sent: Promise<unknown>, text: string | null): void {
  const p: Promise<void> = sent.then((a) => a !== false, () => false).then((ok) => {
    if (s.inFlight !== p) return
    s.inFlight = null
    if (!s.alive) return
    if (!ok && text != null) { s.rx.keep([text, ...s.backlog.splice(0)].join(' ')); s.rx.fatal(); return }
    if (s.backlog.length) s.rx.flush()
  })
  s.inFlight = p
}

/** 交给接收方;上一句还在发送途中就排队,发完合并成一句再发(否则会话还没建好/run 还没起就又发一次)。 */
function dispatch(s: LiveSession, text: string): void {
  if (s.inFlight) { s.backlog.push(text); return }
  const r = s.rx.deliver(text)
  if (r) watch(s, r, text)
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const id = setTimeout(() => reject(new Error(translate('livevoice.asrTimeout'))), ms)
    p.then((v) => { clearTimeout(id); resolve(v) }, (e) => { clearTimeout(id); reject(e) })
  })
}

export function useLiveVoice(
  onUtterance: Deliver,
  /** owner = 这个实例是实时对话的合法接收方(主页 / 跟随侧栏的主区聊天);失去身份时在途则交接、否则挂断,且永不接交接。
   *  sessionKey = 这个实例真正发往的会话;换会话即挂断(在途发送引起的切换除外)。
   *  onKeep = 没发成的语音放回草稿。 */
  opts: { paused: boolean; modelId?: string; owner: boolean; sessionKey?: string | null; handoffOnSend?: boolean; onKeep: (text: string) => void },
): LiveVoiceState {
  const [phase, setPhase] = useState<LivePhase>('off')
  const [error, setError] = useState<string | null>(null)
  const [analyser, setAnalyser] = useState<AnalyserNode | null>(null)
  const [flushTick, setFlushTick] = useState(0)
  const sessRef = useRef<LiveSession | null>(null)
  const cbRef = useRef(onUtterance)
  cbRef.current = onUtterance
  const optsRef = useRef(opts)
  optsRef.current = opts

  const supported =
    typeof navigator !== 'undefined' && !!navigator.mediaDevices?.getUserMedia &&
    typeof AudioContext !== 'undefined' && !!window.tangu?.transcribeAudio

  const stop = useCallback(() => {
    const s = sessRef.current
    sessRef.current = null
    if (s) kill(s)
    setAnalyser(null)
    setPhase('off')
  }, [])

  const bind = useCallback((s: LiveSession) => {
    sessRef.current = s
    s.rx = {
      deliver: (t) => cbRef.current(t), keep: (t) => optsRef.current.onKeep(t), flush: () => setFlushTick((n) => n + 1),
      phase: setPhase, error: setError, fatal: stop,
    }
  }, [stop])

  /** 接手交接槽里新鲜的一场;槽不在/已过期/采集已死 → false(并清掉坏槽)。 */
  const adopt = useCallback((): boolean => {
    const h = handoff
    if (!h) return false
    handoff = null
    if (!h.s.alive || !h.s.cap?.alive() || performance.now() - h.at >= HANDOFF_MS) { kill(h.s); return false }
    bind(h.s)
    setError(null)
    setAnalyser(h.s.cap.analyser)
    setPhase(h.s.pending ? 'transcribing' : 'listening')
    for (const t of h.kept.splice(0)) h.s.rx.keep(t)
    h.s.backlog.push(...h.parked.splice(0))
    if (!h.s.inFlight && h.s.backlog.length) h.s.rx.flush()
    return true
  }, [bind])

  /** 失去接收方身份或卸载:主页输入框发送途中 → 整场放进交接槽(不关采集);其余挂断。 */
  const release = useCallback(() => {
    const s = sessRef.current
    if (s?.cap && optsRef.current.handoffOnSend && s.inFlight) {
      sessRef.current = null
      s.cap.setPaused(true)
      if (handoff && handoff.s !== s) kill(handoff.s)
      const slot = { s, at: performance.now(), parked: [] as string[], kept: [] as string[] }
      s.rx = {
        deliver: (t) => { slot.parked.push(t) }, keep: (t) => { slot.kept.push(t) }, flush: () => {},
        phase: () => {}, error: () => {}, fatal: () => { kill(s); if (handoff === slot) handoff = null },
      }
      handoff = slot
      setTimeout(() => { if (handoff === slot) { handoff = null; kill(s) } }, HANDOFF_MS)
      setAnalyser(null)
      setPhase('off')
      return
    }
    stop()
  }, [stop])

  const start = useCallback(() => {
    if (sessRef.current) return
    if (!supported) { setError(translate('voiceinput.unsupported')); return }
    if (adopt()) return
    setError(null)
    const s: LiveSession = { cap: null, alive: true, queue: Promise.resolve(), pending: 0, failures: 0, inFlight: null, backlog: [], rx: null! }
    bind(s)
    setPhase('starting')
    startLiveCapture({
      onSpeechStart: () => { if (s.alive) s.rx.phase('speaking') },
      onEnded: () => { if (!s.alive) return; s.rx.error(translate('voiceinput.noDevice')); s.rx.fatal() },
      onUtterance: (pcm, endedAt) => {
        if (!s.alive) return
        s.pending++
        s.rx.phase('transcribing')
        const audioBase64 = wavBase64(pcm, 16000)
        const seconds = pcm.length / 16000
        s.queue = s.queue.then(async () => {
          if (!s.alive) return
          try {
            const req = window.tangu!.transcribeAudio!({ audioBase64, mime: 'audio/wav', modelId: optsRef.current.modelId })
            const text = (await withTimeout(req, Math.max(15_000, seconds * 4000))).trim()
            s.failures = 0
            console.warn(`[voice] live utterance ${seconds.toFixed(2)}s → text in ${Math.round(performance.now() - endedAt)}ms: ${text.slice(0, 40)}`)
            if (!s.alive || isNoiseTranscript(text)) return
            s.rx.error(null)
            dispatch(s, text)
          } catch (e: any) {
            console.warn('[voice] live transcribe failed:', e?.message || e)
            if (!s.alive) return
            s.rx.error(e?.message || String(e))
            if (++s.failures >= MAX_FAILURES) s.rx.fatal()
          } finally {
            if (s.alive && --s.pending === 0) s.rx.phase('listening')
          }
        })
      },
    }).then((cap) => {
      if (!s.alive) { cap.stop(); return } // 权限弹窗期间用户已点了结束
      s.cap = cap
      if (sessRef.current === s) { setAnalyser(cap.analyser); cap.setPaused(optsRef.current.paused) }
      s.rx.phase('listening')
    }, (e: any) => {
      if (!s.alive) return
      console.warn('[voice] live getUserMedia failed:', e?.name, e?.message || e)
      s.rx.error(
        e?.name === 'NotAllowedError' ? translate('voiceinput.denied')
          : e?.name === 'NotFoundError' ? translate('voiceinput.noDevice')
          : translate('voiceinput.openFailed', { e: e?.name || e?.message || e }),
      )
      s.rx.fatal()
    })
  }, [supported, bind, adopt])

  const track = useCallback((sent: Promise<unknown> | undefined) => {
    const s = sessRef.current
    if (s && sent && !s.inFlight) watch(s, sent, null)
  }, [])

  useEffect(() => release, [release]) // 卸载
  useEffect(() => { sessRef.current?.cap?.setPaused(opts.paused) }, [opts.paused, analyser])
  // 排队句在提交之后发:此时 cbRef 与草稿/附件都是上一次发送清理后的新值。
  useEffect(() => {
    const s = sessRef.current
    if (!flushTick || !s?.alive || s.inFlight || !s.backlog.length) return
    dispatch(s, s.backlog.splice(0).join(' '))
  }, [flushTick])
  // owner 变化:成为接收方 → 接手交接槽(只接不新开);不再是接收方 → 在途交接,否则挂断。
  useEffect(() => {
    if (!opts.owner) { if (sessRef.current) release(); return }
    if (!opts.handoffOnSend && handoff && !sessRef.current) adopt()
  }, [opts.owner, opts.handoffOnSend, adopt, release])
  // 换会话 = 挂断(别把话说进别的会话;空态点开已有会话也算)。在途发送引起的切换(空态建会话、主页交接)不挂。
  const prevKeyRef = useRef(opts.sessionKey)
  useEffect(() => {
    const prev = prevKeyRef.current
    prevKeyRef.current = opts.sessionKey
    const s = sessRef.current
    if (s && prev !== opts.sessionKey && !s.inFlight) stop()
  }, [opts.sessionKey, stop])

  return { phase, active: phase !== 'off', error, analyser, supported, start, stop, track }
}
