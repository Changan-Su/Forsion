/**
 * 云端转写分段(2026-11-20,遥测「transcribe_audio 失败率 43%」排查)。
 *
 * 云端(Forsion 托管 / 自带 key)以前整段音频一次同步发出去:生产网关对 /api/brain/transcribe 的读超时约 60s,
 * 实测 15s 人声 13s 回来,170s 人声 70s 时网关回 504;桌面主进程的 Node fetch 自己也是响应头 300s 不到就断。
 * 而 transcribe_audio 最常见的来源是视频转写交回的**整段视频音轨**(Bluebird 视频技能给 16k WAV),动辄几分钟。
 * 本地 SenseVoice 那条早就按静音切段(asrLocal.ts),云端照同一个切法切成短段、逐段送,再拼回去。
 *
 * 纯模块:不 import electron,发送函数由调用方给(main.ts 的 runTranscribe),可直接单测。
 * 只切 WAV(PCM)—— 别的格式解不了码,照旧整段送。
 */
import type { AsrResult, AsrSegment } from './asr'
import { splitOnSilence, wavToSamples } from './asrAudio'

/** 一段最多多长(秒)。15s 一段实测 13s 回来,30s 离 60s 网关读超时留了一倍余量。 */
export const CLOUD_CHUNK_SEC = 30
/** 同时在路上的段数:总时长压下来,又不至于一次把上游打满。 */
export const CLOUD_CHUNK_CONCURRENCY = 3

/** 上游把「这段没人声」当错误回(百炼原生接口 400 `ASR_RESPONSE_HAVE_NO_WORDS`):静音、纯音乐的一段不是失败,是空文本。 */
export function isNoSpeechError(message: string): boolean {
  return /ASR_RESPONSE_HAVE_NO_WORDS/.test(message)
}

/**
 * 按静音切段,再把相邻短段并成 ≤ maxSec 的块(块越少往返越少,单块仍远低于网关超时)。
 * 块首尾相接、覆盖全长;splitOnSilence 一直没静音时会硬切,所以单块不会超过 maxSec。
 */
export function planCloudChunks(samples: Float32Array, sampleRate: number, maxSec = CLOUD_CHUNK_SEC): Array<{ from: number; to: number }> {
  const max = Math.max(1, Math.round(maxSec * sampleRate))
  const segs = splitOnSilence(samples, sampleRate, { maxSegMs: maxSec * 1000 })
  const out: Array<{ from: number; to: number }> = []
  for (const s of segs) {
    const last = out[out.length - 1]
    if (last && last.to === s.from && s.to - last.from <= max) last.to = s.to
    else out.push({ from: s.from, to: s.to })
  }
  return out
}

/** 一段样本 → 16-bit PCM 单声道 WAV。 */
export function encodeWav16(samples: Float32Array, sampleRate: number, from = 0, to = samples.length): Buffer {
  const n = Math.max(0, to - from)
  const buf = Buffer.alloc(44 + n * 2)
  buf.write('RIFF', 0, 'ascii'); buf.writeUInt32LE(36 + n * 2, 4); buf.write('WAVE', 8, 'ascii')
  buf.write('fmt ', 12, 'ascii'); buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20); buf.writeUInt16LE(1, 22)
  buf.writeUInt32LE(sampleRate, 24); buf.writeUInt32LE(sampleRate * 2, 28); buf.writeUInt16LE(2, 32); buf.writeUInt16LE(16, 34)
  buf.write('data', 36, 'ascii'); buf.writeUInt32LE(n * 2, 40)
  for (let i = 0; i < n; i++) {
    const v = Math.max(-1, Math.min(1, samples[from + i]))
    buf.writeInt16LE(Math.round(v < 0 ? v * 32768 : v * 32767), 44 + i * 2)
  }
  return buf
}

const isWav = (audio: Buffer): boolean => audio.length >= 44 && audio.toString('ascii', 0, 4) === 'RIFF'

/** 发一段:回字符串(不要时间戳)或 { text, segments? }。 */
export type SendChunk = (wav: Buffer) => Promise<string | AsrResult>

/**
 * 长 WAV 分段转写。不是 WAV、或不超过一段的长度 → 返回 null,调用方照旧整段送。
 * 每段没人声 = 空文本;别的错误整次失败(带上第几段),不拿半截冒充全文。
 * timestamps:上游给了分段就按块起点平移;没给就每块一条(块的真实起止,不编句子级时间)。
 */
export async function transcribeWavInChunks(
  audio: Buffer,
  opts: { timestamps?: boolean; maxSec?: number; concurrency?: number },
  send: SendChunk,
): Promise<string | AsrResult | null> {
  if (!isWav(audio)) return null
  let decoded: { samples: Float32Array; sampleRate: number }
  try { decoded = wavToSamples(audio) } catch { return null }
  const { samples, sampleRate } = decoded
  const maxSec = opts.maxSec ?? CLOUD_CHUNK_SEC
  if (samples.length <= maxSec * sampleRate) return null
  const chunks = planCloudChunks(samples, sampleRate, maxSec)
  if (chunks.length <= 1) return null

  const results: Array<{ text: string; segments?: AsrSegment[] }> = new Array(chunks.length)
  let next = 0
  const worker = async (): Promise<void> => {
    while (next < chunks.length) {
      const i = next++
      const c = chunks[i]
      try {
        const r = await send(encodeWav16(samples, sampleRate, c.from, c.to))
        results[i] = typeof r === 'string' ? { text: r.trim() } : { text: (r.text || '').trim(), segments: r.segments }
      } catch (e) {
        const msg = (e as Error)?.message || String(e)
        if (isNoSpeechError(msg)) { results[i] = { text: '' }; continue }
        next = chunks.length // 别的段不再发
        throw new Error(`chunk ${i + 1}/${chunks.length} (${(c.from / sampleRate).toFixed(0)}s–${(c.to / sampleRate).toFixed(0)}s) failed: ${msg}`)
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(opts.concurrency ?? CLOUD_CHUNK_CONCURRENCY, chunks.length) }, worker))

  const text = results.map((r) => r.text).filter(Boolean).join('\n')
  if (!opts.timestamps) return text
  const segments: AsrSegment[] = []
  results.forEach((r, i) => {
    const off = chunks[i].from / sampleRate
    if (r.segments?.length) for (const s of r.segments) segments.push({ start: s.start + off, end: s.end + off, text: s.text })
    else if (r.text) segments.push({ start: off, end: chunks[i].to / sampleRate, text: r.text })
  })
  return { text, ...(segments.length ? { segments } : {}) }
}
