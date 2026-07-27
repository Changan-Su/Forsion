/**
 * 桌面级共享语音转写(ASR)—— 只在 Electron 主进程,不经引擎/服务端。
 * 自带-key 云端:直连某 provider 的 OpenAI 兼容 /audio/transcriptions(multipart 上传)。
 * 本地 SenseVoice(离线)见 asrLocal.ts。
 *
 * **时间戳按需返回**(2026-07-26):语音输入只要一段文本,拿时间戳纯属浪费;而视频转录要靠时间戳
 * 做字幕面板与点击跳播放器。故 `timestamps` 是入参开关 —— 不要就还是回字符串(老调用方零改),
 * 要才回 { text, segments }。上游给不了分段时(比如托管端未支持)照实只回 text,不编时间点。
 */

/** 一条带时间的转写片段(秒)。 */
export interface AsrSegment { start: number; end: number; text: string }
/** 要时间戳时的返回;segments 缺席 = 上游确实给不了,不是空数组。 */
export interface AsrResult { text: string; segments?: AsrSegment[] }

export interface TranscribeCloudOpts {
  baseUrl: string
  apiKey?: string
  /** 上游模型名(如 FunAudioLLM/SenseVoiceSmall、whisper-1)。 */
  model: string
  audio: Buffer
  mime: string
  language?: string
  timestamps?: boolean
}

/** 音频 mime → 上游期望的文件后缀(部分服务按扩展名判编码)。 */
function extForMime(mime: string): string {
  if (/wav/.test(mime)) return 'wav'
  if (/mp4|m4a|aac/.test(mime)) return 'm4a'
  if (/ogg/.test(mime)) return 'ogg'
  if (/mpeg|mp3/.test(mime)) return 'mp3'
  return 'webm'
}

/** OpenAI verbose_json 的 segments → AsrSegment(两种字段口径都认;缺时间的丢掉,不猜)。 */
export function parseVerboseSegments(data: unknown): AsrSegment[] | undefined {
  const segs = (data as { segments?: unknown })?.segments
  if (!Array.isArray(segs)) return undefined
  const out: AsrSegment[] = []
  for (const s of segs as Array<Record<string, unknown>>) {
    const start = Number(s.start ?? s.begin_time ?? s.startTime)
    const end = Number(s.end ?? s.end_time ?? s.endTime)
    const text = String(s.text ?? s.transcript ?? '').trim()
    if (!Number.isFinite(start) || !Number.isFinite(end) || !text) continue
    // 部分实现用毫秒(阿里/讯飞口径):超过 10 小时的「秒」必然是毫秒,按 1000 折算。
    const ms = end > 36000
    out.push({ start: ms ? start / 1000 : start, end: ms ? end / 1000 : end, text })
  }
  return out.length ? out : undefined
}

/** POST 音频到 OpenAI 兼容 /audio/transcriptions(multipart)。要时间戳则请求 verbose_json。 */
export async function transcribeViaOpenAI(o: TranscribeCloudOpts): Promise<string | AsrResult> {
  const url = `${o.baseUrl.replace(/\/+$/, '')}/audio/transcriptions`
  const form = new FormData()
  // Uint8Array.from → 纯 ArrayBuffer 视图(Buffer 的 ArrayBufferLike 不满足 BlobPart)。
  form.append('file', new Blob([Uint8Array.from(o.audio)], { type: o.mime }), `audio.${extForMime(o.mime)}`)
  form.append('model', o.model)
  form.append('response_format', o.timestamps ? 'verbose_json' : 'json')
  if (o.timestamps) form.append('timestamp_granularities[]', 'segment')
  if (o.language) form.append('language', o.language)
  const res = await fetch(url, {
    method: 'POST',
    headers: o.apiKey ? { Authorization: `Bearer ${o.apiKey}` } : {},
    body: form,
  })
  if (!res.ok) {
    const detail = await res.text().catch(() => '')
    throw new Error(`transcribe ${res.status}: ${detail.slice(0, 300)}`)
  }
  const data = (await res.json().catch(() => ({}))) as { text?: string }
  const text = (data.text || '').trim()
  return o.timestamps ? { text, segments: parseVerboseSegments(data) } : text
}

/** Forsion 托管云端转写:桌面主进程直连 Forsion 服务端 /api/brain/transcribe(计费,provider key 不下发)。 */
export async function transcribeViaForsion(o: {
  cloudUrl: string
  token: string
  modelId: string
  audioB64: string
  mime: string
  language?: string
  timestamps?: boolean
}): Promise<string | AsrResult> {
  const res = await fetch(`${o.cloudUrl.replace(/\/+$/, '')}/api/brain/transcribe`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${o.token}` },
    body: JSON.stringify({ modelId: o.modelId || undefined, audioBase64: o.audioB64, mime: o.mime, language: o.language, timestamps: o.timestamps || undefined, projectSource: 'tangu' }),
  })
  const data = (await res.json().catch(() => ({}))) as { text?: string; detail?: string }
  if (!res.ok) throw new Error(data.detail || `Forsion 转写失败 ${res.status}`)
  const text = (data.text || '').trim()
  // 服务端还没支持 timestamps 时只会回 text —— 照实回 segments:undefined,绝不伪造时间点。
  return o.timestamps ? { text, segments: parseVerboseSegments(data) } : text
}
