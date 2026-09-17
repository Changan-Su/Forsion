import { describe, it, expect } from 'vitest'
import { VAD, vadInit, vadStep, resampleLinear, isNoiseTranscript, type VadEvent } from './liveCapture'

const FRAME = 64
/** 按 [rms, 帧数] 段喂合成序列,收集 [事件, 时刻]。 */
function feed(segments: Array<[number, number]>): Array<[VadEvent, number]> {
  let s = vadInit(), t = 0
  const out: Array<[VadEvent, number]> = []
  for (const [rms, n] of segments) for (let i = 0; i < n; i++) {
    t += FRAME
    const r = vadStep(s, rms, t)
    s = r.state
    if (r.event) out.push([r.event, t])
  }
  return out
}

describe('vadStep (energy endpointing)', () => {
  it('one sentence: starts after 2 loud frames, ends after hangover of silence', () => {
    const ev = feed([[0.001, 10], [0.08, 20], [0.002, 20]])
    expect(ev.map((e) => e[0])).toEqual(['start', 'end'])
    const lastLoud = (10 + 20) * FRAME
    expect(ev[1][1] - lastLoud).toBeGreaterThanOrEqual(VAD.hangoverMs)
    expect(ev[1][1] - lastLoud).toBeLessThan(VAD.hangoverMs + FRAME)
  })

  it('a pause shorter than hangover does not split the sentence', () => {
    const ev = feed([[0.08, 10], [0.002, 8], [0.08, 10], [0.002, 20]]) // 8 帧 = 512ms < 700ms
    expect(ev.map((e) => e[0])).toEqual(['start', 'end'])
  })

  it('hysteresis: level between endRms and startRms keeps an utterance alive but never opens one', () => {
    expect(feed([[0.015, 40]])).toEqual([])
    expect(feed([[0.08, 5], [0.015, 30], [0.002, 20]]).map((e) => e[0])).toEqual(['start', 'end'])
  })

  it('a single loud frame (click) never starts; a short blip is discarded', () => {
    expect(feed([[0.5, 1], [0.001, 30]])).toEqual([])
    expect(feed([[0.08, 3], [0.001, 30]]).map((e) => e[0])).toEqual(['start', 'discard']) // 192ms < 200ms
  })

  it('keeps a one-syllable answer (好 / 对 ≈ 250ms of loud frames)', () => {
    expect(feed([[0.001, 5], [0.08, 4], [0.001, 30]]).map((e) => e[0])).toEqual(['start', 'end'])
  })

  it('two sentences separated by a long pause yield two utterances', () => {
    const ev = feed([[0.08, 15], [0.002, 25], [0.08, 15], [0.002, 25]])
    expect(ev.map((e) => e[0])).toEqual(['start', 'end', 'start', 'end'])
  })

  it('force-splits a never-ending utterance at maxUtteranceMs', () => {
    const frames = Math.ceil(VAD.maxUtteranceMs / FRAME) + 5
    expect(feed([[0.08, frames]]).map((e) => e[0])).toEqual(['start', 'split', 'start'])
  })
})

describe('resampleLinear', () => {
  it('is identity at same rate and keeps duration when downsampling', () => {
    const pcm = new Float32Array([0, 1, 0, -1])
    expect(resampleLinear(pcm, 16000, 16000)).toBe(pcm)
    expect(resampleLinear(new Float32Array(48000), 48000, 16000).length).toBe(16000)
  })
})

describe('isNoiseTranscript', () => {
  it('drops ASR hallucinations on noise but keeps real one-word answers', () => {
    for (const t of ['', '。', '그.', '呃。', '唔', 'The.', 'um', 'Hmm...']) expect(isNoiseTranscript(t), t).toBe(true)
    for (const t of ['好。', '对', '是的', '嗯', '嗯嗯。', '哦', 'A.', 'B', 'I', 'OK', 'yes', '今天有点累', '嗯,我觉得可以']) expect(isNoiseTranscript(t), t).toBe(false)
  })
})
