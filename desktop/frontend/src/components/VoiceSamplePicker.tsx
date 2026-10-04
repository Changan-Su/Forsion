/**
 * 复刻样本:在应用里照着文案录一段,或选一个录音文件。两条路都先过本地检查(services/voiceSample.ts)再交出去,
 * 交出去的是 data URI。朗读音色工作室和语音通话的复刻共用。
 * 录音关掉回声消除 / 降噪 / 自动增益(这三样都会改音色);检查用同时采下来的无损 PCM,交出去的是同时压好的 m4a ——
 * 10-04 实测境外到百炼的上行只有 10–30 KB/s:20 秒的 48 kHz WAV 约 2.5 MB(base64),传不完就超时;m4a 约 200 KB,十秒内。
 * 选的文件:m4a / mp3 原样交,其余重编码成 24 kHz 单声道 WAV。
 */
import { useEffect, useRef, useState } from 'react'
import { AlertTriangle, Check, Mic, Play, Square, Upload, XCircle } from 'lucide-react'
import { registerMessages, useI18n } from '../i18n'
import { wavBase64 } from '../hooks/useVoiceInput' // 顺带注册 voiceinput.* 那几条麦克风报错
import { analyzeSample, blobDataUri, decodeToMono, passThroughMime, playDataUri, SAMPLE_MAX_SEC, type SampleReport } from '../services/voiceSample'

const MAX_FILE_MB = 50 // 只防误选整小时的录音把渲染进程解爆;真正的上限是 60 秒
const M4A = 'audio/mp4;codecs=mp4a.40.2' // macOS 实测(Electron 40):能录,百炼两套复刻服务都收;不支持的平台退回 WAV

registerMessages({
  'voicesample.record': { zh: '录一段', en: 'Record' },
  'voicesample.rerecord': { zh: '重录', en: 'Record again' },
  'voicesample.pick': { zh: '选择录音…', en: 'Choose a recording…' },
  'voicesample.stop': { zh: '停止', en: 'Stop' },
  'voicesample.play': { zh: '试听', en: 'Play' },
  'voicesample.readThis': { zh: '用平常说话的语气把下面这段念一遍，念完点「停止」：', en: 'Read the passage below in your normal speaking voice, then press Stop:' },
  'voicesample.script': {
    zh: '今天天气不错，我想跟你聊一聊最近在忙的事情。上周我去了一趟海边，傍晚的风很凉快，沿着沙滩走了很久。回来以后整理了照片，也顺便把下个月的计划重新排了一遍。',
    en: 'Thanks for taking a moment to listen. Last weekend I walked along the coast at sunset, and the breeze was cool and steady. When I got home I sorted my photos and planned out the month ahead, one small step at a time.',
  },
  'voicesample.tips': { zh: '找个安静、不空旷的房间，离麦克风约 10 厘米。', en: 'Use a quiet room without echo, about 10 cm from the microphone.' },
  'voicesample.recorded': { zh: '刚录的', en: 'New recording' },
  'voicesample.summary': { zh: '{sec} 秒，人声 {speech} 秒', en: '{sec} s, {speech} s of speech' },
  'voicesample.ok': { zh: '没发现问题。', en: 'No problems found.' },
  'voicesample.scriptMismatch': { zh: '不过录音和文案对不上，百炼没用上文案；想更像可以照着文案重录一次。', en: 'The recording did not match the passage, so Bailian ignored the text. Re-record following the passage for a closer match.' },
  'voicesample.decodeFailed': { zh: '这个文件解不开，换一个 WAV、MP3 或 M4A。', en: 'Could not decode this file. Try a WAV, MP3 or M4A.' },
  'voicesample.fileTooLarge': { zh: '文件超过 {mb}MB', en: 'File is larger than {mb} MB' },
  'voicesample.uploading': { zh: '正在把样本（{kb} KB）传给百炼…境外网络可能要一两分钟。', en: 'Uploading the sample ({kb} KB) to Bailian… this can take a minute or two from outside mainland China.' },
  'voicesample.uploadTimeout': { zh: '✗ 样本（{kb} KB）传给百炼超时了。境外到百炼的上传很慢：录短一点（10–15 秒）或换个网络再试。', en: '✗ Uploading the sample ({kb} KB) to Bailian timed out. Uploads from outside mainland China are slow: record a shorter clip (10–15 s) or try another network.' },
  'voicesample.block.silent': { zh: '没录到声音。检查系统输入设备选对了没有、麦克风有没有静音。', en: 'No sound was captured. Check the system input device and that the microphone is not muted.' },
  'voicesample.block.tooLong': { zh: '超过 60 秒了，百炼不收。剪到 10–20 秒。', en: 'Longer than 60 seconds, which Bailian rejects. Trim it to 10–20 seconds.' },
  'voicesample.block.tooLittleSpeech': { zh: '人声不到 5 秒，不够复刻。连续说 10–20 秒。', en: 'Less than 5 seconds of speech, not enough to clone. Speak continuously for 10–20 seconds.' },
  'voicesample.warn.short': { zh: '不到 10 秒，偏短。10–20 秒更像。', en: 'Under 10 seconds is on the short side. 10–20 seconds clones better.' },
  'voicesample.warn.quiet': { zh: '声音太小。离麦克风近一点，或调高输入音量。', en: 'The voice is too quiet. Move closer to the microphone or raise the input volume.' },
  'voicesample.warn.clipping': { zh: '声音太大，有破音。离麦克风远一点，或调低输入音量。', en: 'The voice is too loud and distorts. Move back or lower the input volume.' },
  'voicesample.warn.noisy': { zh: '背景噪音偏大。换个安静的地方，关掉风扇和空调。', en: 'There is a lot of background noise. Find a quieter place and turn off fans or air conditioning.' },
  'voicesample.warn.pause': { zh: '中间有超过 2 秒的停顿。连着说，别停太久。', en: 'There is a pause longer than 2 seconds. Keep talking without long gaps.' },
  'voicesample.warn.narrowband': { zh: '录音音质偏低（像是电话或 16 kHz 录的），复刻出来会发闷。换成 24 kHz 以上的录音。', en: 'The recording is low-fidelity (it looks like a phone call or 16 kHz audio), so the clone will sound muffled. Use a recording at 24 kHz or higher.' },
})

export interface VoiceSample {
  dataUri: string
  /** 没有被拦住的问题才能复刻。 */
  ok: boolean
  /** 照着文案录的:原文和语种一起交给百炼(对不上它会自己退回不用文案的方式,不会失败)。 */
  script?: { text: string; language: 'zh' | 'en' }
}

type T = (key: string, vars?: Record<string, unknown>) => string
const kb = (s: VoiceSample): number => Math.round(s.dataUri.length / 1024)
/** 复刻进行中的提示:慢网络上传要等,别让人以为卡死了。 */
export const cloneBusyText = (s: VoiceSample, t: T): string => t('voicesample.uploading', { kb: kb(s) })
/** 复刻失败的提示:引擎等百炼等到超时(Node 的原话是 "The operation was aborted due to timeout")换成人话,带上样本体积。 */
export const cloneErrorText = (e: any, s: VoiceSample, t: T): string =>
  /timeout|timed out/i.test(String(e?.message || e)) ? t('voicesample.uploadTimeout', { kb: kb(s) }) : `✗ ${e?.message || e}`

interface Rec { ctx: AudioContext; stream: MediaStream; proc: ScriptProcessorNode; chunks: Float32Array[]; mr?: MediaRecorder; parts: Blob[]; startedAt: number; timer: ReturnType<typeof setInterval> }

/** 只读元数据拿时长(秒);拿不到回 0。 */
function mediaSeconds(file: File): Promise<number> {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(file)
    const a = new Audio()
    const done = (sec: number): void => { URL.revokeObjectURL(url); a.removeAttribute('src'); resolve(Number.isFinite(sec) ? sec : 0) }
    a.preload = 'metadata'
    a.onloadedmetadata = () => done(a.duration)
    a.onerror = () => done(0)
    a.src = url
  })
}

const clock = (sec: number): string => `${Math.floor(sec / 60)}:${String(Math.floor(sec % 60)).padStart(2, '0')}`

export function VoiceSamplePicker({ onChange, disabled }: { onChange: (s: VoiceSample | null) => void; disabled?: boolean }) {
  const { t, locale } = useI18n()
  const [recording, setRecording] = useState(false)
  const [elapsed, setElapsed] = useState(0)
  const [level, setLevel] = useState(0)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [sample, setSample] = useState<{ name: string; dataUri: string; report: SampleReport } | null>(null)
  const rec = useRef<Rec | null>(null)
  const starting = useRef(false) // 等麦克风授权的那一会儿:再点一次不许开第二路
  const alive = useRef(true)
  const fileRef = useRef<HTMLInputElement>(null)

  const release = (): void => {
    const r = rec.current
    if (!r) return
    rec.current = null
    clearInterval(r.timer)
    r.proc.onaudioprocess = null
    r.proc.disconnect()
    if (r.mr && r.mr.state !== 'inactive') r.mr.stop() // 没人接 onstop(卸载)= 录到的直接丢
    r.stream.getTracks().forEach((tr) => tr.stop())
    void r.ctx.close().catch(() => {})
  }
  useEffect(() => { alive.current = true; return () => { alive.current = false; release() } }, []) // 关设置页时别把麦克风一直占着

  /** payload = 现成的 data URI(录音压好的 m4a、原样交的文件);没有就把 pcm 编成 WAV。 */
  const accept = (name: string, pcm: Float32Array, rate: number, script?: VoiceSample['script'], payload?: string): void => {
    const report = analyzeSample(pcm, rate)
    const dataUri = report.blocks.includes('tooLong') ? '' : payload || `data:audio/wav;base64,${wavBase64(pcm, rate)}` // 超长的不编码:反正交不出去,别白占内存
    setSample({ name, dataUri, report })
    onChange({ dataUri, ok: report.blocks.length === 0, script })
  }
  const clear = (): void => { setSample(null); setError(''); onChange(null) }

  const start = async (): Promise<void> => {
    if (starting.current || rec.current || busy) return
    clear()
    if (!navigator.mediaDevices?.getUserMedia) { setError(t('voiceinput.unsupported')); return }
    let stream: MediaStream
    starting.current = true
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: false, noiseSuppression: false, autoGainControl: false } })
    } catch (e: any) {
      if (alive.current) setError(e?.name === 'NotAllowedError' ? t('voiceinput.denied') : e?.name === 'NotFoundError' ? t('voiceinput.noDevice') : t('voiceinput.openFailed', { e: e?.message || String(e) }))
      return
    } finally {
      starting.current = false
    }
    if (!alive.current) { stream.getTracks().forEach((tr) => tr.stop()); return } // 授权弹窗还没点完设置页就关了
    // 固定 48 kHz:高采样率声卡(96 / 192 kHz)录满 60 秒会超过引擎的请求体上限
    const ctx = new AudioContext({ sampleRate: 48000 })
    // ponytail: ScriptProcessorNode 已废弃但 Electron 仍支持(realtimeCall.ts 同款);换 AudioWorklet 要单独的 worklet 模块文件。
    const proc = ctx.createScriptProcessor(4096, 1, 1)
    const chunks: Float32Array[] = []
    proc.onaudioprocess = (e) => {
      const f = e.inputBuffer.getChannelData(0)
      chunks.push(new Float32Array(f))
      let sum = 0
      for (let i = 0; i < f.length; i++) sum += f[i] * f[i]
      setLevel(Math.min(1, Math.sqrt(sum / f.length) * 6))
    }
    ctx.createMediaStreamSource(stream).connect(proc)
    proc.connect(ctx.destination) // 不接到 destination 就不回调;输出缓冲不写 = 静音
    // 同一路麦克风再接一个 m4a 编码器:交给百炼的是它(小),上面的 PCM 只管电平和检查
    let mr: MediaRecorder | undefined
    const parts: Blob[] = []
    try {
      if (typeof MediaRecorder !== 'undefined' && MediaRecorder.isTypeSupported(M4A)) {
        mr = new MediaRecorder(stream, { mimeType: M4A, audioBitsPerSecond: 128000 })
        mr.ondataavailable = (e) => { if (e.data.size) parts.push(e.data) }
        mr.start()
      }
    } catch { mr = undefined }
    const startedAt = Date.now()
    const timer = setInterval(() => {
      const sec = (Date.now() - startedAt) / 1000
      setElapsed(sec)
      if (sec >= SAMPLE_MAX_SEC - 0.5) stop() // 百炼最长 60 秒;m4a 压好了没法再截,留半秒余量给定时器和编码器收尾
    }, 250)
    rec.current = { ctx, stream, proc, chunks, mr, parts, startedAt, timer }
    setElapsed(0); setLevel(0); setRecording(true)
  }

  const stop = (): void => {
    const r = rec.current
    if (!r) return
    const rate = r.ctx.sampleRate
    // 封顶 60 秒:自动停止由 250ms 的定时器触发,攒下的总会多出一点,不截就被自己的「超过 60 秒」拦住
    const pcm = new Float32Array(Math.min(r.chunks.reduce((a, c) => a + c.length, 0), rate * SAMPLE_MAX_SEC))
    let at = 0
    for (const c of r.chunks) { if (at >= pcm.length) break; pcm.set(c.subarray(0, pcm.length - at), at); at += c.length }
    const name = t('voicesample.recorded')
    const script: VoiceSample['script'] = { text: t('voicesample.script'), language: locale === 'en' ? 'en' : 'zh' }
    let settled = false
    const finish = (payload?: string): void => {
      if (settled || !alive.current) return
      settled = true
      setBusy(false)
      accept(name, pcm, rate, script, payload)
    }
    const { mr, parts } = r
    if (mr) {
      mr.onstop = () => {
        const blob = new Blob(parts, { type: 'audio/mp4' }) // 不带 codecs 参数:data URI 原样转给百炼,实测过的是这个写法
        void (blob.size ? blobDataUri(blob) : Promise.resolve('')).then((uri) => finish(uri || undefined), () => finish())
      }
      setBusy(true)
      setTimeout(() => finish(), 3000) // 编码器没按时收尾:退回 WAV,别卡在这
    }
    release() // 里面停 MediaRecorder → 触发上面的 onstop
    setRecording(false)
    if (!mr) finish()
  }

  const pick = (file: File | undefined): void => {
    if (!file || busy) return
    clear()
    if (file.size > MAX_FILE_MB * 1024 * 1024) { setError(t('voicesample.fileTooLarge', { mb: MAX_FILE_MB })); return }
    setBusy(true)
    // 先只读时长:一小时的 MP3 不到 50MB,整个解开是几百 MB 的 PCM。读不出时长(裸流等)就照常解码
    mediaSeconds(file)
      .then((sec) => {
        if (sec > SAMPLE_MAX_SEC + 1) { setError(t('voicesample.block.tooLong')); return }
        return file.arrayBuffer().then(async (buf) => {
          const mime = passThroughMime(file.name, file.type)
          const { pcm, rate } = await decodeToMono(buf.slice(0)) // 解码器会收走传进去的缓冲,给它一份拷贝
          const payload = mime
            ? await blobDataUri(new Blob([buf], { type: mime }))
            : await decodeToMono(buf, 24000).then((d) => `data:audio/wav;base64,${wavBase64(d.pcm, d.rate)}`) // 24 kHz = 百炼的下限,体积是 48 kHz 的一半
          if (alive.current) accept(file.name, pcm, rate, undefined, payload)
        })
      })
      .catch(() => { if (alive.current) setError(t('voicesample.decodeFailed')) })
      .finally(() => { if (alive.current) setBusy(false) })
  }

  const r = sample?.report
  const line = (kind: 'ok' | 'warn' | 'block', text: string, key: string) => (
    <div key={key} className={`voice-sample-check voice-sample-check--${kind}`} style={{ display: 'flex', gap: 6, alignItems: 'flex-start', fontSize: 'var(--ui-font-meta, 12px)', lineHeight: 1.5 }}>
      <span style={{ flex: 'none', marginTop: 2, color: kind === 'ok' ? 'var(--ok)' : kind === 'warn' ? 'var(--warning)' : 'var(--danger)' }}>
        {kind === 'ok' ? <Check size={12} /> : kind === 'warn' ? <AlertTriangle size={12} /> : <XCircle size={12} />}
      </span>
      <span>{text}</span>
    </div>
  )

  return (
    <div className="voice-sample" style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      {recording && (
        <div className="voice-sample-script" style={{ border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)', padding: '10px 12px' }}>
          <div className="hint" style={{ marginTop: 0 }}>{t('voicesample.readThis')}</div>
          <div style={{ marginTop: 6, lineHeight: 1.7 }}>{t('voicesample.script')}</div>
          <div className="hint">{t('voicesample.tips')}</div>
        </div>
      )}
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
        <input ref={fileRef} type="file" accept="audio/*" hidden onChange={(e) => { pick(e.target.files?.[0]); e.target.value = '' }} />
        {recording ? (
          <>
            <button className="btn primary sm voice-sample-stop" onClick={stop}><Square size={12} /> {t('voicesample.stop')} · {clock(elapsed)}</button>
            <div className="voice-sample-level" aria-hidden style={{ width: 96, height: 4, borderRadius: 'var(--radius-pill)', background: 'var(--border)', overflow: 'hidden' }}>
              <div style={{ width: `${Math.round(level * 100)}%`, height: '100%', background: 'var(--accent)' }} />
            </div>
          </>
        ) : (
          <>
            <button className="btn ghost sm voice-sample-record" disabled={disabled || busy} onClick={() => void start()}><Mic size={12} /> {t(sample ? 'voicesample.rerecord' : 'voicesample.record')}</button>
            <button className="btn ghost sm voice-sample-pick" disabled={disabled || busy} onClick={() => fileRef.current?.click()}><Upload size={12} /> {t('voicesample.pick')}</button>
            {sample?.dataUri && <button className="btn ghost sm voice-sample-play" onClick={() => playDataUri(sample.dataUri)}><Play size={12} /> {t('voicesample.play')}</button>}
          </>
        )}
      </div>
      {sample && r && (
        <div className="voice-sample-report" style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          <div className="voice-sample-name" style={{ fontSize: 'var(--ui-font-meta, 12px)', color: 'var(--text-muted)' }}>
            {sample.name} · {t('voicesample.summary', { sec: r.seconds.toFixed(1), speech: r.speechSeconds.toFixed(1) })}
          </div>
          {r.blocks.map((b) => line('block', t(`voicesample.block.${b}`), b))}
          {r.warns.map((w) => line('warn', t(`voicesample.warn.${w}`), w))}
          {!r.blocks.length && !r.warns.length && line('ok', t('voicesample.ok'), 'ok')}
        </div>
      )}
      {error && <div className="hint voice-sample-error" style={{ color: 'var(--danger)' }}>{error}</div>}
    </div>
  )
}
