/**
 * 桌面级可复用语音输入 hook:麦克风采集 → 主进程转写 → 文本回调。
 * 任意功能(聊天框、以后的 Amadeus 笔记…)drop-in;不绑定 Tangu。
 * MediaRecorder 采集整段,停止时交主进程 transcribeAudio(本地 SenseVoice / 自带-key 云端)。
 * modelId 缺省 → 主进程用设置里的默认 asr 模型。
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { registerMessages, translate } from '../i18n'

// 文案在**报错发生时**解析(translate 而非 useI18n):这些串都进 state 当错误信息用,
// 且本文件里 `t` 已被 `getTracks().forEach((t) => …)` 占用,别再引入同名绑定。
registerMessages({
  'voiceinput.silent': { zh: '没采集到声音(输入电平≈0):检查系统输入设备是否选对、麦克风没被静音', en: 'No audio captured (input level ≈ 0): check that the right input device is selected and that the microphone is not muted' },
  'voiceinput.unsupported': { zh: '此环境不支持语音输入', en: 'Voice input is not supported in this environment' },
  'voiceinput.denied': { zh: '麦克风权限被拒绝(打开 系统设置 › 隐私与安全 › 麦克风,允许本 App)', en: 'Microphone access was denied (open System Settings › Privacy & Security › Microphone and allow this app)' },
  'voiceinput.noDevice': { zh: '没检测到麦克风设备', en: 'No microphone found' },
  'voiceinput.openFailed': { zh: '麦克风打不开:{e}', en: 'Could not open the microphone: {e}' },
  'voiceinput.unclear': { zh: '没听清,再试一次', en: "Didn't catch that — try again" },
})

/**
 * 录音 Blob → 16kHz 单声道 WAV 的 base64。渲染端(Chromium)解码 + 重采样,
 * 于是主进程既不需要音频解码器(云端直传该 WAV),本地 SenseVoice 也直接吃这个 16k 单声道 WAV。
 */
async function blobToWav16kBase64(blob: Blob): Promise<string> {
  const arrayBuf = await blob.arrayBuffer()
  const ac = new AudioContext()
  const decoded = await ac.decodeAudioData(arrayBuf)
  await ac.close()
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
  if (peak < 0.005) throw new Error(translate('voiceinput.silent'))
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
  /** 未录=开始录;录音中=停止并转写;转写中=忽略。 */
  toggle: () => void
  /** 丢弃当前录音,不转写。 */
  cancel: () => void
  supported: boolean
  /** 录音期间接在麦克风流上的分析节点(供实时波形可视化);非录音=null。 */
  analyser: AnalyserNode | null
}

export function useVoiceInput(onResult: (text: string) => void, modelId?: string): VoiceInputState {
  const [recording, setRecording] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const recRef = useRef<MediaRecorder | null>(null)
  const chunksRef = useRef<Blob[]>([])
  const canceledRef = useRef(false)
  const [analyser, setAnalyser] = useState<AnalyserNode | null>(null)
  const liveAcRef = useRef<AudioContext | null>(null)

  const teardownAnalyser = useCallback(() => {
    setAnalyser(null)
    liveAcRef.current?.close().catch(() => {})
    liveAcRef.current = null
  }, [])
  useEffect(() => teardownAnalyser, [teardownAnalyser]) // 卸载时关掉 AudioContext,别泄露

  const supported =
    typeof navigator !== 'undefined' &&
    !!navigator.mediaDevices?.getUserMedia &&
    typeof MediaRecorder !== 'undefined' &&
    !!window.tangu?.transcribeAudio

  const stop = useCallback((cancel: boolean) => {
    canceledRef.current = cancel
    recRef.current?.stop()
  }, [])

  const start = useCallback(async () => {
    setError(null)
    if (!supported) { setError(translate('voiceinput.unsupported')); return }
    let stream: MediaStream
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true })
    } catch (e: any) {
      console.warn('[voice] getUserMedia failed:', e?.name, e?.message || e)
      setError(
        e?.name === 'NotAllowedError' ? translate('voiceinput.denied')
          : e?.name === 'NotFoundError' ? translate('voiceinput.noDevice')
          : translate('voiceinput.openFailed', { e: e?.name || e?.message || e }),
      )
      return
    }
    // 实时波形:接一个 AnalyserNode 到麦克风流(不连 destination=不外放)。失败不影响录音本身。
    try {
      const ac = new AudioContext()
      const node = ac.createAnalyser()
      node.fftSize = 128
      node.smoothingTimeConstant = 0.7
      ac.createMediaStreamSource(stream).connect(node)
      liveAcRef.current = ac
      setAnalyser(node)
    } catch { /* 可视化非关键,忽略 */ }
    const rec = new MediaRecorder(stream)
    recRef.current = rec
    chunksRef.current = []
    canceledRef.current = false
    rec.ondataavailable = (e) => { if (e.data.size) chunksRef.current.push(e.data) }
    rec.onstop = async () => {
      stream.getTracks().forEach((t) => t.stop())
      teardownAnalyser()
      setRecording(false)
      recRef.current = null
      if (canceledRef.current || !chunksRef.current.length) return
      const blob = new Blob(chunksRef.current, { type: rec.mimeType || 'audio/webm' })
      setBusy(true)
      try {
        const text = await window.tangu!.transcribeAudio!({
          audioBase64: await blobToWav16kBase64(blob),
          mime: 'audio/wav',
          modelId,
        })
        if (text) onResult(text)
        else setError(translate('voiceinput.unclear'))
      } catch (e: any) {
        console.warn('[voice] transcribe failed:', e?.message || e)
        setError(e?.message || String(e))
      } finally {
        setBusy(false)
      }
    }
    rec.start()
    setRecording(true)
  }, [supported, modelId, onResult, teardownAnalyser])

  const toggle = useCallback(() => {
    if (busy) return
    if (recording) stop(false)
    else void start()
  }, [busy, recording, start, stop])

  const cancel = useCallback(() => { if (recording) stop(true) }, [recording, stop])

  return { recording, busy, error, toggle, cancel, supported, analyser }
}
