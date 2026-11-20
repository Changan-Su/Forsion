import { describe, expect, it } from 'vitest'
import { encodeWav16, planCloudChunks, transcribeWavInChunks } from './asrCloudChunks'
import { wavToSamples } from './asrAudio'

const SR = 16000
/** tone(有声) / sil(静音) 交替,单位秒。 */
function build(parts: Array<{ kind: 'tone' | 'sil'; sec: number }>): Float32Array {
  const out = new Float32Array(Math.round(parts.reduce((a, p) => a + p.sec, 0) * SR))
  let i = 0
  for (const p of parts) for (let k = 0, n = Math.round(p.sec * SR); k < n; k++, i++) out[i] = p.kind === 'tone' ? 0.3 * Math.sin((2 * Math.PI * 220 * k) / SR) : 0
  return out
}
/** 8s 说话 + 1s 停顿,重复 n 次。 */
const speech = (n: number) => build(Array.from({ length: n }, () => [{ kind: 'tone' as const, sec: 8 }, { kind: 'sil' as const, sec: 1 }]).flat())

describe('planCloudChunks', () => {
  it('切成 ≤30s 的块,首尾相接、覆盖全长', () => {
    const s = speech(20) // 180s
    const chunks = planCloudChunks(s, SR, 30)
    expect(chunks.length).toBeGreaterThanOrEqual(6)
    expect(chunks[0].from).toBe(0)
    for (let i = 0; i < chunks.length; i++) {
      expect((chunks[i].to - chunks[i].from) / SR).toBeLessThanOrEqual(30.05)
      if (i) expect(chunks[i].from).toBe(chunks[i - 1].to)
    }
    expect(s.length - chunks[chunks.length - 1].to).toBeLessThanOrEqual(SR * 0.02)
  })

  it('一直没停顿也硬切', () => {
    const chunks = planCloudChunks(build([{ kind: 'tone', sec: 95 }]), SR, 30)
    expect(chunks.length).toBeGreaterThanOrEqual(4)
    for (const c of chunks) expect((c.to - c.from) / SR).toBeLessThanOrEqual(30.05)
  })
})

describe('encodeWav16', () => {
  it('编出来的 WAV 能原样解回', () => {
    const s = build([{ kind: 'tone', sec: 1 }])
    const back = wavToSamples(encodeWav16(s, SR))
    expect(back.sampleRate).toBe(SR)
    expect(back.samples.length).toBe(s.length)
    expect(Math.abs(back.samples[100] - s[100])).toBeLessThan(1e-3)
  })
})

describe('transcribeWavInChunks', () => {
  it('短于一段 / 不是 WAV → null(照旧整段送)', async () => {
    const send = async () => 'x'
    expect(await transcribeWavInChunks(encodeWav16(speech(2), SR), {}, send)).toBeNull()
    expect(await transcribeWavInChunks(Buffer.from('ID3 not a wav file at all, mp3 bytes........................'), {}, send)).toBeNull()
  })

  it('长音频逐段送(每段都是 ≤30s 的 WAV),按原顺序拼文本,并发不超过上限', async () => {
    const audio = encodeWav16(speech(20), SR)
    let inFlight = 0, peak = 0, n = 0
    const out = await transcribeWavInChunks(audio, { concurrency: 3 }, async (w) => {
      const i = n++
      inFlight++; peak = Math.max(peak, inFlight)
      const { samples } = wavToSamples(w)
      expect(samples.length / SR).toBeLessThanOrEqual(30.05)
      await new Promise((r) => setTimeout(r, (5 - (i % 5)) * 3)) // 乱序完成
      inFlight--
      return `part${i}`
    })
    expect(typeof out).toBe('string')
    expect((out as string).split('\n')).toEqual(Array.from({ length: n }, (_, i) => `part${i}`))
    expect(peak).toBeLessThanOrEqual(3)
  })

  it('timestamps:上游没给分段 → 每块一条,时间是块的真实起止', async () => {
    const out = await transcribeWavInChunks(encodeWav16(speech(10), SR), { timestamps: true }, async () => 'hello')
    const r = out as { text: string; segments: Array<{ start: number; end: number }> }
    expect(r.segments[0].start).toBe(0)
    for (let i = 1; i < r.segments.length; i++) expect(r.segments[i].start).toBeCloseTo(r.segments[i - 1].end, 5)
    expect(r.segments[r.segments.length - 1].end).toBeGreaterThan(85)
  })

  it('timestamps:上游给了分段 → 按块起点平移', async () => {
    const out = await transcribeWavInChunks(encodeWav16(speech(10), SR), { timestamps: true }, async () => ({ text: 'a', segments: [{ start: 1, end: 2, text: 'a' }] }))
    const r = out as { segments: Array<{ start: number }> }
    expect(r.segments[0].start).toBe(1)
    expect(r.segments[1].start).toBeGreaterThan(20)
  })

  it('没人声的一段 = 空文本,不算失败', async () => {
    let i = 0
    const out = await transcribeWavInChunks(encodeWav16(speech(10), SR), {}, async () => {
      if (i++ === 1) throw new Error('upstream(native) 400: {"code":"CLIENT_ERROR","message":"ASR_RESPONSE_HAVE_NO_WORDS"}')
      return 'ok'
    })
    expect(out).toBe(Array.from({ length: i - 1 }, () => 'ok').join('\n'))
  })

  it('别的错误整次失败,写明第几段,不拿半截冒充全文', async () => {
    let i = 0
    await expect(transcribeWavInChunks(encodeWav16(speech(10), SR), { concurrency: 1 }, async () => {
      if (i++ === 1) throw new Error('Forsion transcription failed: HTTP 504 (gateway timeout)')
      return 'ok'
    })).rejects.toThrow(/chunk 2\/\d+ .*504/)
    expect(i).toBe(2) // 失败后不再发后面的段
  })
})
