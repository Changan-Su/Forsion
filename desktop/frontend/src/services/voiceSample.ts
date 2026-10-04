/**
 * 复刻样本的本地检查:录音 / 选的文件先过这里,再交给百炼。纯函数,不碰 DOM(解码在 decodeToMono)。
 * 阈值出处 = 百炼「声音复刻」文档的音频要求:推荐 10–20 秒、最长 60 秒、至少 5 秒连续清晰朗读、停顿 ≤ 2 秒、
 * 无背景音、采样率 ≥ 24 kHz。电平口径 10-04 拿真实录音校过(见 voiceSample.test.ts)。
 * 交出去的样本:应用里录的是 m4a,选的 m4a / mp3 原样交,其余重编码成 24 kHz 单声道 16-bit WAV(见 VoiceSamplePicker)——
 * 体积要紧:10-04 实测境外到百炼的上行只有 10–30 KB/s,20 秒的 48 kHz WAV 要传两三分钟。
 * 重编码的那一路绕过了百炼自己的采样率检查 —— narrowband 那条就是替它查的。检查本身一律在 48 kHz 无损 PCM 上做。
 */

/** 拦住不让复刻的(百炼会拒,或者根本没录到)。 */
export type SampleBlock = 'silent' | 'tooLong' | 'tooLittleSpeech'
/** 只提醒:能复刻,但多半不像。 */
export type SampleWarn = 'short' | 'quiet' | 'clipping' | 'noisy' | 'pause' | 'narrowband'

export interface SampleReport {
  seconds: number
  /** 有人声的总时长。 */
  speechSeconds: number
  /** 人声中间最长的一段停顿。 */
  longestPauseSec: number
  /** 说话时的电平(dBFS,响的那 5% 帧)。 */
  levelDb: number
  /** 说话电平比最安静的那 5% 帧高多少 dB(粗略的信噪比)。 */
  snrDb: number
  blocks: SampleBlock[]
  warns: SampleWarn[]
}

export const SAMPLE_MAX_SEC = 60
const MIN_SPEECH_SEC = 5
const FRAME_SEC = 0.05
const SILENT_PEAK = 0.005 // 与 useVoiceInput 的静音口径一致
const db = (x: number): number => 20 * Math.log10(Math.max(x, 1e-6))

/** 原地 radix-2 FFT(只给 narrowband 那条用;n 必须是 2 的幂)。 */
function fft(re: Float64Array, im: Float64Array): void {
  const n = re.length
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1
    for (; j & bit; bit >>= 1) j ^= bit
    j ^= bit
    if (i < j) { const a = re[i]; re[i] = re[j]; re[j] = a; const b = im[i]; im[i] = im[j]; im[j] = b }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len
    for (let i = 0; i < n; i += len) {
      for (let k = 0; k < len / 2; k++) {
        const c = Math.cos(ang * k), s = Math.sin(ang * k), a = i + k, b = a + len / 2
        const tr = re[b] * c - im[b] * s, ti = re[b] * s + im[b] * c
        re[b] = re[a] - tr; im[b] = im[a] - ti; re[a] += tr; im[a] += ti
      }
    }
  }
}

/** 8 kHz 以上的能量占比。16 kHz 录的东西升采样上来,这里是一片空白(< 1e-6);真的宽带录音哪怕很干净也有底噪和齿音。 */
function highBandShare(pcm: Float32Array, rate: number, frames: number[], frameLen: number): number {
  const N = 1024
  const cut = Math.ceil((8000 * N) / rate)
  const re = new Float64Array(N), im = new Float64Array(N)
  let hi = 0, all = 0
  const step = Math.max(1, Math.floor(frames.length / 200)) // 抽 200 帧够了
  for (let f = 0; f < frames.length; f += step) {
    const at = frames[f] * frameLen
    if (at + N > pcm.length) break
    for (let i = 0; i < N; i++) { re[i] = pcm[at + i] * (0.5 - 0.5 * Math.cos((2 * Math.PI * i) / N)); im[i] = 0 }
    fft(re, im)
    for (let k = 1; k < N / 2; k++) { const p = re[k] * re[k] + im[k] * im[k]; all += p; if (k >= cut) hi += p }
  }
  return all > 0 ? hi / all : 0
}

export function analyzeSample(pcm: Float32Array, rate: number): SampleReport {
  const seconds = pcm.length / rate
  const frameLen = Math.max(1, Math.round(rate * FRAME_SEC))
  const n = Math.floor(pcm.length / frameLen)
  const rms = new Float64Array(n)
  let peak = 0, clipped = 0
  for (let f = 0; f < n; f++) {
    let sum = 0
    for (let i = f * frameLen, end = i + frameLen; i < end; i++) {
      const a = Math.abs(pcm[i])
      if (a > peak) peak = a
      if (a >= 0.985) clipped++
      sum += a * a
    }
    rms[f] = Math.sqrt(sum / frameLen)
  }
  const empty: SampleReport = { seconds, speechSeconds: 0, longestPauseSec: 0, levelDb: db(peak), snrDb: 0, blocks: ['silent'], warns: [] }
  if (!n || peak < SILENT_PEAK) return empty

  const sorted = Float64Array.from(rms).sort()
  const loud = sorted[Math.min(n - 1, Math.floor(n * 0.95))]
  const quiet = sorted[Math.floor(n * 0.05)]
  // 算作「在说话」:比说话电平低不超过 20 dB,且明显高过底噪。底噪那头封顶在说话电平的一半 ——
  // 一口气说到底、没有停顿的录音里,最安静的 5% 也是人声,不封顶就把整段都算成底噪了
  const thr = Math.max(loud * 0.1, Math.min(quiet * 2, loud * 0.5))
  const speech: number[] = []
  let longestPause = 0, last = -1
  for (let f = 0; f < n; f++) {
    if (rms[f] <= thr) continue
    if (last >= 0) longestPause = Math.max(longestPause, f - last - 1)
    last = f
    speech.push(f)
  }
  const speechSeconds = speech.length * FRAME_SEC
  const report: SampleReport = {
    seconds, speechSeconds, longestPauseSec: longestPause * FRAME_SEC, levelDb: db(loud), snrDb: db(loud) - db(quiet), blocks: [], warns: [],
  }
  if (seconds > SAMPLE_MAX_SEC) report.blocks.push('tooLong')
  if (speechSeconds < MIN_SPEECH_SEC) report.blocks.push('tooLittleSpeech')
  if (report.blocks.length) return report

  if (seconds < 10) report.warns.push('short')
  if (report.levelDb < -30) report.warns.push('quiet')
  if (clipped / pcm.length > 0.001) report.warns.push('clipping')
  if (report.snrDb < 25) report.warns.push('noisy') // 量出来的比真实信噪比高 4 dB 左右(拿的是响帧不是平均)→ 真实 ≈ 20 dB 以下就提醒
  if (report.longestPauseSec > 2) report.warns.push('pause')
  if (rate < 24000 || highBandShare(pcm, rate, speech, frameLen) < 1e-6) report.warns.push('narrowband')
  return report
}

/** 播一段 data URI 音频。页面 CSP 的 media-src 不放行 data:(直接 new Audio(dataUri) 会静默失败),转成 blob 再播。 */
export function playDataUri(uri: string): void {
  void fetch(uri).then((r) => r.blob()).then((b) => {
    const url = URL.createObjectURL(b)
    const a = new Audio(url)
    a.onended = a.onerror = () => URL.revokeObjectURL(url)
    return a.play()
  }).catch(() => {})
}

/** 百炼直接收的压缩格式(m4a / mp3):回它的 MIME,原样交不重编码;其余回空串 = 要重编码成 WAV。 */
export function passThroughMime(name: string, type: string): '' | 'audio/mp4' | 'audio/mpeg' {
  const ext = name.toLowerCase().split('.').pop() || ''
  if (/^audio\/(mp4|x-m4a|m4a)$/i.test(type) || (!type && ext === 'm4a')) return 'audio/mp4'
  if (/^audio\/(mpeg|mp3)$/i.test(type) || (!type && ext === 'mp3')) return 'audio/mpeg'
  return ''
}

export const blobDataUri = (b: Blob): Promise<string> => new Promise((resolve, reject) => {
  const r = new FileReader()
  r.onload = () => resolve(String(r.result))
  r.onerror = () => reject(r.error)
  r.readAsDataURL(b)
})

/** 任意音频文件 → 单声道 PCM(缺省 48 kHz;渲染端解码,双声道只取首声道,百炼也只处理首声道)。⚠️ 传进来的 ArrayBuffer 会被解码器收走。 */
export async function decodeToMono(data: ArrayBuffer, rate = 48000): Promise<{ pcm: Float32Array; rate: number }> {
  const buf = await new OfflineAudioContext(1, 1, rate).decodeAudioData(data)
  return { pcm: buf.getChannelData(0), rate: buf.sampleRate }
}
