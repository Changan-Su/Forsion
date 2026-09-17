/**
 * 免手语音采集核心(实时对话第 2 步):麦克风 → 16k PCM → 能量端点检测 → 一句一段 Float32Array。
 * 零依赖、不碰 React/i18n/window.tangu:scripts/live-voice.probe.cjs 直接打包本文件在真 Electron 里跑。
 *
 * 为什么不复用 useVoiceInput 的 MediaRecorder:onset 检测有延迟,rec.start() 时首字已丢;webm 分片带头做不了
 * pre-roll;沉默期整段进 blob;每句还要一趟 decodeAudioData。这里直接拿 PCM,环形缓冲留 pre-roll。
 */

/** 端点检测旋钮。麦克风不是纸上的理想值:实测抖了先调这里,别改算法。 */
export const VAD = {
  frameSize: 1024,      // 16k 下 64ms 一帧
  startRms: 0.02,       // 连续 startFrames 帧高于此 = 开口
  startFrames: 2,
  endRms: 0.01,         // 低于此持续 hangoverMs = 说完(滞回:开口阈值 > 收口阈值)
  hangoverMs: 700,
  minSpeechMs: 200,     // 响度段(含首尾帧)短于此丢掉不转写;「好」「对」这类单字回答约 250ms 要留住,单帧咔哒由 startFrames 挡
  maxUtteranceMs: 30_000,
  prerollMs: 300,
}
export type VadConfig = typeof VAD

export interface VadState { speaking: boolean; loudRun: number; firstLoudAt: number; speechStart: number; lastLoud: number }
/** split = 超长强制切段(照常转写,但下一段不能再带 pre-roll,否则重复)。 */
export type VadEvent = 'start' | 'end' | 'split' | 'discard' | null

export const vadInit = (): VadState => ({ speaking: false, loudRun: 0, firstLoudAt: 0, speechStart: 0, lastLoud: 0 })

/** 喂一帧 RMS,返回新状态与事件。纯函数,liveCapture.test.ts 用合成序列钉它。frameMs = 一帧时长(响度段按帧含首尾计)。 */
export function vadStep(s: VadState, rms: number, now: number, cfg: VadConfig = VAD, frameMs = (cfg.frameSize / 16000) * 1000): { state: VadState; event: VadEvent } {
  if (!s.speaking) {
    const loudRun = rms > cfg.startRms ? s.loudRun + 1 : 0
    const firstLoudAt = loudRun === 1 ? now : s.firstLoudAt
    if (loudRun >= cfg.startFrames) return { state: { speaking: true, loudRun: 0, firstLoudAt, speechStart: firstLoudAt, lastLoud: now }, event: 'start' }
    return { state: { ...s, loudRun, firstLoudAt }, event: null }
  }
  const lastLoud = rms > cfg.endRms ? now : s.lastLoud
  if (now - s.speechStart >= cfg.maxUtteranceMs) return { state: vadInit(), event: 'split' }
  if (now - lastLoud >= cfg.hangoverMs) {
    return { state: vadInit(), event: lastLoud - s.speechStart + frameMs >= cfg.minSpeechMs ? 'end' : 'discard' }
  }
  return { state: { ...s, lastLoud }, event: null }
}

/** ASR 在噪声/呼吸上的典型幻听(实测 SenseVoice:「그.」「The.」「呃。」)——自动发送前丢掉。
 *  单字**真回答**要放行:好/对/是、「嗯」「哦」(应答)、「A」「B」(选项),所以只拦纯犹豫音、纯韩文短串和孤立 the。
 *  ponytail: 词表启发式;误拦/漏拦按实报补词,真要稳就上 ASR 置信度。 */
export function isNoiseTranscript(text: string): boolean {
  const t = text.replace(/[\p{P}\p{S}\s]/gu, '')
  if (!t) return true
  if (/^[\p{Script=Hangul}]{1,2}$/u.test(t)) return true
  if (/^(?:[呃额唔]+|h+m+|u+m+|u+h+|the)$/i.test(t)) return true
  return false
}

export function rmsOf(frame: Float32Array): number {
  let sum = 0
  for (let i = 0; i < frame.length; i++) sum += frame[i] * frame[i]
  return Math.sqrt(sum / (frame.length || 1))
}

/** 线性插值重采样;只在 AudioContext 没按 16k 开出来时兜底。 */
export function resampleLinear(pcm: Float32Array, from: number, to: number): Float32Array {
  if (from === to) return pcm
  const out = new Float32Array(Math.max(1, Math.round(pcm.length * to / from)))
  const r = from / to
  for (let i = 0; i < out.length; i++) {
    const x = i * r, i0 = Math.floor(x), i1 = Math.min(pcm.length - 1, i0 + 1)
    out[i] = pcm[i0] + (pcm[i1] - pcm[i0]) * (x - i0)
  }
  return out
}

export interface LiveCapture {
  analyser: AnalyserNode
  /** true = 丢帧并复位 VAD(Agent 回复中;第 3/4 步 TTS 放音时也喂这里,防扬声器回灌自触发)。 */
  setPaused: (paused: boolean) => void
  /** 换回调接收方(组件换实例时把同一路采集整个交过去,不关不重开麦克风)。 */
  setHandlers: (h: LiveCaptureHandlers) => void
  /** false = 已停(含轨道意外结束);交接前要看。 */
  alive: () => boolean
  stop: () => void
}

export interface LiveCaptureHandlers {
  onSpeechStart?: () => void
  /** 一句话结束:16k 单声道 PCM,endedAt = performance.now()(给调用方算 ASR 延迟)。 */
  onUtterance: (pcm: Float32Array, endedAt: number) => void
  /** 麦克风轨道意外结束(拔设备、权限中途被撤)。 */
  onEnded?: () => void
}

export async function startLiveCapture(handlers: LiveCaptureHandlers, cfg: VadConfig = VAD): Promise<LiveCapture> {
  let h = handlers
  const stream = await navigator.mediaDevices.getUserMedia({
    // 显式开回声消除:第 3 步逐句放音时扬声器会回灌麦克风,macOS AEC 能兜掉同机放音的一大半。
    audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 },
  })
  const ac = new AudioContext({ sampleRate: 16000 })
  const rate = ac.sampleRate
  const src = ac.createMediaStreamSource(stream)
  const analyser = ac.createAnalyser()
  analyser.fftSize = 128
  analyser.smoothingTimeConstant = 0.7
  src.connect(analyser)
  // ponytail: ScriptProcessorNode 已废弃但 Electron 仍支持;要换就是 AudioWorklet(需单独的 worklet 模块文件)。
  const proc = ac.createScriptProcessor(cfg.frameSize, 1, 1)
  const mute = ac.createGain()
  mute.gain.value = 0
  src.connect(proc)
  proc.connect(mute) // Chromium 里 ScriptProcessor 必须连到 destination 才会回调;经 0 增益不外放
  mute.connect(ac.destination)

  const frameMs = (cfg.frameSize / rate) * 1000
  const prerollFrames = Math.max(1, Math.ceil(cfg.prerollMs / frameMs))
  const ring: Float32Array[] = []
  let utter: Float32Array[] | null = null
  let vad = vadInit()
  let paused = false
  let stopped = false

  proc.onaudioprocess = (e) => {
    if (stopped) return
    // 暂停只挡「开口」:已经说到一半的这句照常收完交出去(否则 Agent 一开始回复,用户后半句就被吞了)。
    if (paused && !vad.speaking) { vad = vadInit(); utter = null; ring.length = 0; return }
    const frame = new Float32Array(e.inputBuffer.getChannelData(0)) // 拷贝:底层 buffer 会被复用
    const now = performance.now()
    const { state, event } = vadStep(vad, rmsOf(frame), now, cfg, frameMs)
    vad = state
    if (event === 'start') { utter = [...ring, frame]; h.onSpeechStart?.() }
    else if (utter) utter.push(frame)
    if ((event === 'end' || event === 'split') && utter) {
      const n = utter.reduce((a, f) => a + f.length, 0)
      const pcm = new Float32Array(n)
      let o = 0
      for (const f of utter) { pcm.set(f, o); o += f.length }
      utter = null
      h.onUtterance(resampleLinear(pcm, rate, 16000), now)
    } else if (event === 'discard') utter = null
    if (event === 'split') { ring.length = 0; return } // 强制切段:环里是刚交出去的语音,留着会在下一段开头重复
    ring.push(frame)
    if (ring.length > prerollFrames) ring.shift()
  }

  const stop = () => {
    if (stopped) return
    stopped = true
    proc.onaudioprocess = null
    stream.getTracks().forEach((tr) => { tr.onended = null; tr.stop() })
    ac.close().catch(() => {})
  }
  stream.getAudioTracks().forEach((tr) => { tr.onended = () => { if (!stopped) { stop(); h.onEnded?.() } } })
  return { analyser, setPaused: (p) => { paused = p }, setHandlers: (next) => { h = next }, alive: () => !stopped, stop }
}
