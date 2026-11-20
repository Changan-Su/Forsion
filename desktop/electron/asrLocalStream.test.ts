/**
 * 本地准实时听写:假解码器(回「解了多少毫秒的音频」)+ 合成音频(正弦 = 说话,底噪 = 停顿),
 * 钉住事件顺序与切句规则。真模型那半靠真桌面应用里说一遍(见日志)。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanLocalText, createLocalDictation } from './asrLocalStream'

const RATE = 16000
const CHUNK = 1024 // 渲染层 ScriptProcessor 一帧

/** voiced = 220Hz 正弦按 4Hz 音节包络起伏(音节间短暂掉到底噪);amp 是音量;noise 是底噪幅度。 */
function pcm(ms: number, voiced: boolean, seed = 1, amp = 0.2, noise = 0.001): Uint8Array[] {
  const n = Math.round((RATE * ms) / 1000)
  const out = new Int16Array(n)
  let r = seed
  for (let i = 0; i < n; i++) {
    r = (r * 16807) % 2147483647
    const hiss = ((r / 2147483647) - 0.5) * 2 * noise
    const t = i / RATE
    const v = voiced ? amp * Math.abs(Math.sin(2 * Math.PI * 4 * t)) * Math.sin(2 * Math.PI * 220 * t) : 0
    out[i] = Math.max(-32768, Math.min(32767, Math.round((v + hiss) * 32767)))
  }
  const bytes = new Uint8Array(out.buffer)
  const chunks: Uint8Array[] = []
  for (let i = 0; i < bytes.length; i += CHUNK * 2) chunks.push(bytes.slice(i, i + CHUNK * 2))
  return chunks
}

function harness(opts: { decodeMs?: number; fail?: (call: number, samples: Float32Array) => boolean; maxUtteranceMs?: number } = {}) {
  const events: Array<Record<string, any>> = []
  const decoded: number[] = []
  let calls = 0
  let inFlight = 0
  let maxInFlight = 0
  const fail = vi.fn()
  const d = createLocalDictation({
    decode: async (samples, wanted) => {
      calls++
      const call = calls
      inFlight++
      maxInFlight = Math.max(maxInFlight, inFlight)
      await new Promise((r) => setTimeout(r, opts.decodeMs ?? 30))
      inFlight--
      if (opts.fail?.(call, samples)) throw new Error('boom')
      if (!wanted()) return ''
      decoded.push(samples.length)
      return `${Math.round((samples.length / RATE) * 10) / 10}s。`
    },
    send: (m) => events.push(m),
    fail,
    ...(opts.maxUtteranceMs ? { maxUtteranceMs: opts.maxUtteranceMs } : {}),
  })
  /** 按实时节奏喂:每块 64ms 推一次时钟,让解码与定时器在说话途中跑起来。 */
  const feed = async (chunks: Uint8Array[]) => {
    for (const c of chunks) {
      d.write(c)
      await vi.advanceTimersByTimeAsync((CHUNK / RATE) * 1000)
    }
  }
  const done = () => events.filter((e) => e.type === 'conversation.item.input_audio_transcription.completed')
  const partials = () => events.filter((e) => e.type === 'conversation.item.input_audio_transcription.text')
  return { d, events, decoded, fail, feed, done, partials, stats: () => ({ calls, maxInFlight }) }
}

beforeEach(() => { vi.useFakeTimers() })
afterEach(() => { vi.useRealTimers() })

describe('createLocalDictation', () => {
  it('说话途中就发未定稿,停顿后定稿,收尾发 session.finished', async () => {
    const h = harness()
    await h.feed(pcm(300, false))
    await h.feed(pcm(1500, true))
    const partials = h.events.filter((e) => e.type === 'conversation.item.input_audio_transcription.text')
    expect(partials.length).toBeGreaterThanOrEqual(2) // 1.5 秒里至少刷新两次
    expect(partials.every((e) => e.item_id === 'local_1' && e.text === '' && e.stash)).toBe(true)
    await h.feed(pcm(900, false)) // 停顿 → 第一句定稿
    const firstDone = h.events.find((e) => e.type === 'conversation.item.input_audio_transcription.completed')
    expect(firstDone).toMatchObject({ item_id: 'local_1' })
    expect(firstDone!.transcript).toMatch(/^\d/)
    await h.feed(pcm(800, true, 7))
    h.d.finish()
    await vi.advanceTimersByTimeAsync(500)
    const done = h.events.filter((e) => e.type === 'conversation.item.input_audio_transcription.completed')
    expect(done.map((e) => e.item_id)).toEqual(['local_1', 'local_2'])
    expect(h.events.at(-1)).toEqual({ type: 'session.finished' })
    expect(h.stats().maxInFlight).toBe(1) // 一次只在途一个
  })

  it('第一句定稿含整段说话,句头留了一点静音、没带上开头那一大段', async () => {
    const h = harness()
    await h.feed(pcm(2000, false))
    await h.feed(pcm(1000, true))
    await h.feed(pcm(900, false))
    const done = h.events.find((e) => e.type === 'conversation.item.input_audio_transcription.completed')!
    const secs = parseFloat(done.transcript)
    expect(secs).toBeGreaterThanOrEqual(1.1) // 说话 1 秒 + 句头 / 句尾的静音
    expect(secs).toBeLessThan(2) // 开头 2 秒静音没进来
  })

  it('全程没出声:不解码,直接 session.finished', async () => {
    const h = harness()
    await h.feed(pcm(3000, false))
    h.d.finish()
    await vi.advanceTimersByTimeAsync(100)
    expect(h.stats().calls).toBe(0)
    expect(h.events).toEqual([{ type: 'session.finished' }])
  })

  it('一直不停顿:到上限就切一句,每句不超过上限', async () => {
    const h = harness({ maxUtteranceMs: 3000 })
    await h.feed(pcm(7000, true))
    h.d.finish()
    await vi.advanceTimersByTimeAsync(500)
    expect(h.done().length).toBeGreaterThanOrEqual(3)
    expect(Math.max(...h.decoded)).toBeLessThanOrEqual(3000 * 16 + CHUNK)
    expect(h.events.at(-1)).toEqual({ type: 'session.finished' })
  })

  it('前一句响、后一句轻:两句都定稿(评审 1)', async () => {
    const h = harness()
    await h.feed(pcm(300, false))
    await h.feed(pcm(4000, true, 3, 0.4))
    await h.feed(pcm(1000, false))
    await h.feed(pcm(1200, true, 5, 0.03))
    h.d.finish()
    await vi.advanceTimersByTimeAsync(500)
    const done = h.done()
    expect(done.map((e) => e.item_id)).toEqual(['local_1', 'local_2'])
    expect(parseFloat(done[1].transcript)).toBeGreaterThanOrEqual(1)
  })

  it('稳定底噪:不当成一直在说,有底噪的停顿照样切句(评审 5)', async () => {
    const h = harness()
    await h.feed(pcm(3000, false, 9, 0, 0.04))
    expect(h.partials().length).toBe(0)
    expect(h.done().length).toBe(0)
    await h.feed(pcm(1500, true, 2, 0.3, 0.04))
    await h.feed(pcm(1000, false, 4, 0, 0.04))
    expect(h.done().map((e) => e.item_id)).toEqual(['local_1'])
    expect(parseFloat(h.done()[0].transcript)).toBeLessThan(2.5) // 没把前面 3 秒底噪一起带上
  })

  it('一次都没认出声但确实有音量:收尾整段解一次,不丢', async () => {
    const h = harness()
    await h.feed(pcm(2000, false, 9, 0, 0.04))
    h.d.finish()
    await vi.advanceTimersByTimeAsync(500)
    expect(h.done().length).toBe(1)
    expect(parseFloat(h.done()[0].transcript)).toBeGreaterThanOrEqual(1.9)
    expect(h.events.at(-1)).toEqual({ type: 'session.finished' })
  })

  it('未定稿解码失败只少刷新一次,定稿照常(评审 3)', async () => {
    const h = harness({ fail: (call) => call === 1 })
    await h.feed(pcm(1500, true))
    h.d.finish()
    await vi.advanceTimersByTimeAsync(500)
    expect(h.fail).not.toHaveBeenCalled()
    expect(h.done().length).toBe(1)
    expect(h.events.at(-1)).toEqual({ type: 'session.finished' })
  })

  it('积压的定稿超过上限就结束,不无限攒(评审 4)', async () => {
    const h = harness({ decodeMs: 10_000_000, maxUtteranceMs: 2000 })
    for (let i = 0; i < 60 && !h.fail.mock.calls.length; i++) await h.feed(pcm(2000, true, i + 1))
    expect(h.fail).toHaveBeenCalledTimes(1)
  })

  it('定稿解码出错:调 fail,之后不再发事件', async () => {
    const h = harness({ fail: (_call, samples) => samples.length > RATE * 1.5 && samples.length < RATE * 3 })
    await h.feed(pcm(1800, true))
    await h.feed(pcm(900, false))
    await vi.advanceTimersByTimeAsync(200)
    expect(h.fail).toHaveBeenCalledTimes(1)
    const n = h.events.length
    await h.feed(pcm(800, true))
    h.d.finish()
    await vi.advanceTimersByTimeAsync(200)
    expect(h.events.length).toBe(n)
  })

  it('close 后在途解码的结果丢掉', async () => {
    const h = harness({ decodeMs: 200 })
    await h.feed(pcm(400, true))
    h.d.close()
    await vi.advanceTimersByTimeAsync(500)
    expect(h.events.filter((e) => e.type !== 'conversation.item.input_audio_transcription.text').length).toBe(0)
    const before = h.events.length
    await vi.advanceTimersByTimeAsync(500)
    expect(h.events.length).toBe(before)
  })
})

describe('cleanLocalText', () => {
  it('只有标点的结果当没说', () => {
    expect(cleanLocalText(' 。 ')).toBe('')
    expect(cleanLocalText('.')).toBe('')
    expect(cleanLocalText(' 你好。')).toBe('你好。')
  })
})
