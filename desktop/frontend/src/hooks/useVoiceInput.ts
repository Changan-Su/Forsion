/**
 * 桌面级可复用语音输入 hook:麦克风采集 → 主进程转写 → 文本回调。
 * 任意功能(聊天框、以后的 Amadeus 笔记…)drop-in;不绑定 Tangu。
 * 支持实时的宿主同时接收 PCM，整段录音仍可交给已有转写接口。
 * modelId 缺省 → 主进程用设置里的默认 asr 模型。
 */
import { useCallback, useLayoutEffect, useRef, useState } from 'react'
import { registerMessages, translate } from '../i18n'
import { VOICE_INPUT_RATE } from '../../../shared/voiceInputStream'
import { startStreamingDictation, type VoicePreview } from '../services/voiceInputStream'
export { joinVoiceText } from '../services/voiceInputStream'

// 文案在**报错发生时**解析(translate 而非 useI18n):这些串都进 state 当错误信息用,
// 且本文件里 `t` 已被 `getTracks().forEach((t) => …)` 占用,别再引入同名绑定。
registerMessages({
  'voiceinput.silent': { zh: '没采集到声音（输入电平≈0）：检查系统输入设备是否选对、麦克风没被静音', en: 'No audio captured (input level ≈ 0): check that the right input device is selected and that the microphone is not muted' },
  'voiceinput.unsupported': { zh: '此环境不支持语音输入', en: 'Voice input is not supported in this environment' },
  'voiceinput.denied': { zh: '麦克风权限被拒绝（打开 系统设置 › 隐私与安全 › 麦克风，允许本 App）', en: 'Microphone access was denied (open System Settings › Privacy & Security › Microphone and allow this app)' },
  // 手机(window.tangu.mobile)的说法:没有「输入设备选没选对」,权限在系统的应用设置里。
  'voiceinput.silentPhone': { zh: '没录到声音，再试一次', en: 'No sound was recorded — try again' },
  'voiceinput.deniedPhone': { zh: '麦克风权限被拒绝（到系统设置 › 应用 › 权限里允许麦克风）', en: 'Microphone access was denied (allow it in system Settings › Apps › Permissions)' },
  'voiceinput.noDevice': { zh: '没检测到麦克风设备', en: 'No microphone found' },
  'voiceinput.openFailed': { zh: '麦克风打不开：{e}', en: 'Could not open the microphone: {e}' },
  'voiceinput.interrupted': { zh: '实时转写中断，已保留识别完成的文字', en: 'Live transcription was interrupted. Completed text was kept.' },
  'voiceinput.connectionLost': { zh: '实时转写中断，请再试一次', en: 'Live transcription was interrupted. Try again.' },
  'voiceinput.unclear': { zh: '没听清，再试一次', en: "Didn't catch that — try again" },
})

/**
 * 录音 Blob → 16kHz 单声道 WAV 的 base64。渲染端(Chromium)解码 + 重采样,
 * 于是主进程既不需要音频解码器(云端直传该 WAV),本地 SenseVoice 也直接吃这个 16k 单声道 WAV。
 */
async function blobToWav16kBase64(blob: Blob): Promise<string> {
  const arrayBuf = await blob.arrayBuffer()
  const ac = new AudioContext()
  const decoded = await ac.decodeAudioData(arrayBuf).finally(() => ac.close().catch(() => {}))
  const frames = Math.max(1, Math.round(decoded.duration * 16000))
  const off = new OfflineAudioContext(1, frames, 16000)
  const src = off.createBufferSource()
  src.buffer = decoded
  src.connect(off.destination)
  src.start()
  const pcm = (await off.startRendering()).getChannelData(0)
  // 采集自检:算峰值/RMS。麦克风给静音轨(设备选错/系统静音/权限假授权)时,离线 SenseVoice 会把静音
  // 转成噪声 token(常见「그.」),报个明确错比吐乱码强。ponytail: peak<0.005 视为无声,真人语音恒远超此值。
  let peak = 0, sum = 0
  for (let i = 0; i < pcm.length; i++) { const a = Math.abs(pcm[i]); if (a > peak) peak = a; sum += pcm[i] * pcm[i] }
  console.warn(`[voice] captured ${pcm.length} samples @16k, ${(pcm.length / 16000).toFixed(2)}s, peak=${peak.toFixed(4)} rms=${Math.sqrt(sum / (pcm.length || 1)).toFixed(4)}`)
  if (peak < 0.005) throw new Error(window.tangu?.mobile ? translate('voiceinput.silentPhone') : translate('voiceinput.silent'))
  return wavBase64(pcm, 16000)
}

/** Float32 PCM([-1,1]) → 16-bit 单声道 WAV → base64。导出供单测。 */
export function wavBase64(pcm: Float32Array, sampleRate: number): string {
  const n = pcm.length
  const buf = new ArrayBuffer(44 + n * 2)
  const dv = new DataView(buf)
  const w = (o: number, s: string) => { for (let i = 0; i < s.length; i++) dv.setUint8(o + i, s.charCodeAt(i)) }
  w(0, 'RIFF'); dv.setUint32(4, 36 + n * 2, true); w(8, 'WAVE')
  w(12, 'fmt '); dv.setUint32(16, 16, true); dv.setUint16(20, 1, true); dv.setUint16(22, 1, true)
  dv.setUint32(24, sampleRate, true); dv.setUint32(28, sampleRate * 2, true); dv.setUint16(32, 2, true); dv.setUint16(34, 16, true)
  w(36, 'data'); dv.setUint32(40, n * 2, true)
  for (let i = 0; i < n; i++) {
    const s = Math.max(-1, Math.min(1, pcm[i]))
    dv.setInt16(44 + i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true)
  }
  const bytes = new Uint8Array(buf)
  let bin = ''
  const chunk = 0x8000
  for (let i = 0; i < bytes.length; i += chunk) bin += String.fromCharCode(...bytes.subarray(i, i + chunk))
  return btoa(bin)
}

export interface VoiceInputState {
  recording: boolean
  busy: boolean
  error: string | null
  toggle: () => void
  cancel: () => void
  supported: boolean
  analyser: AnalyserNode | null
  preview: VoicePreview | null
}

interface Recording {
  recorder?: MediaRecorder
  stream?: MediaStream
  context?: AudioContext
  dictation?: ReturnType<typeof startStreamingDictation>
}

function releaseMicrophone(session: Recording) {
  session.stream?.getTracks().forEach(track => track.stop())
  void session.context?.close().catch(() => {})
  session.stream = undefined
  session.context = undefined
}

export function useVoiceInput(onResult: (text: string) => void, scope: string, modelId?: string): VoiceInputState {
  const [phase, setPhase] = useState<'idle' | 'recording' | 'busy'>('idle')
  const [error, setError] = useState<string | null>(null)
  const [analyser, setAnalyser] = useState<AnalyserNode | null>(null)
  const [preview, setPreview] = useState<VoicePreview | null>(null)
  const sessionRef = useRef<Recording | null>(null)

  const dispose = useCallback(() => {
    const session = sessionRef.current
    sessionRef.current = null
    if (!session) return
    session.dictation?.close()
    if (session.recorder) {
      session.recorder.onstop = session.recorder.ondataavailable = session.recorder.onerror = null
      if (session.recorder.state !== 'inactive') session.recorder.stop()
    }
    releaseMicrophone(session)
  }, [])

  const cancel = useCallback(() => {
    dispose()
    setPhase('idle')
    setAnalyser(null)
    setPreview(null)
    setError(null)
  }, [dispose])

  // A late final result belongs to the recording's original composer, never a different chat.
  useLayoutEffect(() => {
    cancel()
    return dispose
  }, [scope, cancel, dispose])

  const supported = typeof navigator !== 'undefined' && !!navigator.mediaDevices?.getUserMedia
    && typeof MediaRecorder !== 'undefined' && !!window.tangu?.transcribeAudio

  const start = useCallback(async () => {
    const transcribe = window.tangu?.transcribeAudio
    if (!supported || !transcribe || sessionRef.current) return
    setError(null)
    const session: Recording = {}
    sessionRef.current = session
    const current = () => sessionRef.current === session
    let stream: MediaStream
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true })
    } catch (e: any) {
      if (!current()) return
      cancel()
      setError(
        e?.name === 'NotAllowedError' ? (window.tangu?.mobile ? translate('voiceinput.deniedPhone') : translate('voiceinput.denied'))
          : e?.name === 'NotFoundError' ? translate('voiceinput.noDevice')
          : translate('voiceinput.openFailed', { e: e?.name || e?.message || e }),
      )
      return
    }
    if (!current()) { stream.getTracks().forEach(track => track.stop()); return }
    session.stream = stream
    try {
      const rec = new MediaRecorder(stream)
      session.recorder = rec
      const chunks: Blob[] = []
      rec.ondataavailable = ({ data }) => { if (data.size) chunks.push(data) }
      rec.onerror = () => {
        if (!current()) return
        cancel()
        setError(translate('voiceinput.unclear'))
      }
      let final: ReturnType<NonNullable<Recording['dictation']>['finish']> | undefined
      const stopCapture = () => {
        final ??= session.dictation?.finish()
        releaseMicrophone(session)
        setAnalyser(null)
        setPhase('busy')
      }
      rec.onstop = async () => {
        if (!current()) return
        stopCapture()
        try {
          const streaming = await final
          if (!current()) return
          let text = streaming?.text ?? ''
          if (!streaming && chunks.length) {
            const blob = new Blob(chunks, { type: rec.mimeType || 'audio/webm' })
            const audioBase64 = await blobToWav16kBase64(blob)
            if (!current()) return
            text = await transcribe({ audioBase64, mime: 'audio/wav', modelId })
          }
          if (!current()) return
          if (text.trim()) onResult(text.trim())
          if (streaming?.interrupted) setError(text.trim() ? translate('voiceinput.interrupted') : translate('voiceinput.connectionLost'))
          else if (!text.trim()) setError(translate('voiceinput.unclear'))
        } catch (e: any) {
          if (current()) setError(e?.message || String(e))
        } finally {
          if (current()) {
            dispose()
            setPreview(null)
            setPhase('idle')
          }
        }
      }
      rec.start()
      setPhase('recording')

      const open = window.tangu?.openVoiceInput
      try {
        let context: AudioContext
        try { context = new AudioContext(open ? { sampleRate: VOICE_INPUT_RATE } : undefined) }
        catch { context = new AudioContext() }
        session.context = context
        const source = context.createMediaStreamSource(stream)
        const node = context.createAnalyser()
        node.fftSize = 128
        node.smoothingTimeConstant = 0.7
        source.connect(node)
        setAnalyser(node)
        if (open) session.dictation = startStreamingDictation(source, context, open, modelId, value => {
          if (current()) setPreview(value)
        })
        void context.resume().catch(() => {})
      } catch { /* A missing waveform or PCM capture does not prevent batch recording. */ }
    } catch (e: any) {
      cancel()
      setError(e?.message || String(e))
    }
  }, [supported, modelId, onResult, cancel, dispose])

  const toggle = useCallback(() => {
    if (phase === 'busy') return
    const session = sessionRef.current
    if (!session) { void start(); return }
    if (session.recorder?.state !== 'recording') return
    session.recorder.stop()
    // Stop forwarding audio at the click, before MediaRecorder posts its final blob.
    void session.dictation?.finish()
    setPhase('busy')
  }, [phase, start])

  return { recording: phase === 'recording', busy: phase === 'busy', error, toggle, cancel, supported, analyser, preview }
}
