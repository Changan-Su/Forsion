import { describe, expect, it } from 'vitest'
import { analyzeSample } from './voiceSample'

const RATE = 48000
let seed = 7
const rnd = (): number => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 2 ** 32 - 0.5 }

/** 像说话的测试信号:0.25 秒一个音节、音节间 0.08 秒空隙;基频 + 共振峰 + 一点 9 kHz 齿音(wide=false 就没有 8 kHz 以上的东西)。 */
function speech(sec: number, { wide = true, gain = 0.3 } = {}): Float32Array {
  const x = new Float32Array(Math.round(sec * RATE))
  for (let i = 0; i < x.length; i++) {
    const t = i / RATE
    if (t % 0.33 > 0.25) continue
    x[i] = gain * (Math.sin(2 * Math.PI * 200 * t) + 0.5 * Math.sin(2 * Math.PI * 1200 * t) + (wide ? 0.2 * Math.sin(2 * Math.PI * 9000 * t) : 0))
  }
  return x
}
const withNoise = (x: Float32Array, amp: number): Float32Array => x.map((v) => v + rnd() * amp)

describe('analyzeSample', () => {
  it('passes a clean 12-second sample', () => {
    const r = analyzeSample(speech(12), RATE)
    expect(r.blocks).toEqual([])
    expect(r.warns).toEqual([])
    expect(r.seconds).toBeCloseTo(12, 1)
    expect(r.speechSeconds).toBeGreaterThan(8)
  })

  it('blocks silence, too little speech and anything over 60 seconds', () => {
    expect(analyzeSample(new Float32Array(RATE * 5), RATE).blocks).toEqual(['silent'])
    expect(analyzeSample(speech(4), RATE).blocks).toEqual(['tooLittleSpeech'])
    expect(analyzeSample(speech(61), RATE).blocks).toEqual(['tooLong'])
  })

  it('does not mistake unbroken, level speech for a noise floor', () => {
    const x = new Float32Array(RATE * 12)
    for (let i = 0; i < x.length; i++) x[i] = 0.3 * Math.sin((2 * Math.PI * 200 * i) / RATE) + 0.05 * Math.sin((2 * Math.PI * 9000 * i) / RATE)
    const r = analyzeSample(x, RATE)
    expect(r.blocks).toEqual([])
    expect(r.speechSeconds).toBeGreaterThan(11)
  })

  it('accepts exactly 60 seconds', () => {
    expect(analyzeSample(speech(60), RATE).blocks).toEqual([])
  })

  it('warns on a short but usable sample', () => {
    const r = analyzeSample(speech(8), RATE)
    expect(r.blocks).toEqual([])
    expect(r.warns).toEqual(['short'])
  })

  it('warns when the voice is too quiet or clips', () => {
    expect(analyzeSample(speech(12, { gain: 0.006 }), RATE).warns).toEqual(['quiet'])
    expect(analyzeSample(speech(12, { gain: 4 }).map((v) => Math.max(-1, Math.min(1, v))), RATE).warns).toContain('clipping')
  })

  it('warns on background noise', () => {
    expect(analyzeSample(withNoise(speech(12), 0.2), RATE).warns).toContain('noisy')
    expect(analyzeSample(withNoise(speech(12), 0.002), RATE).warns).not.toContain('noisy') // 普通麦克风底噪不算
  })

  it('warns on a pause longer than two seconds', () => {
    const x = new Float32Array(RATE * 15)
    x.set(speech(6))
    x.set(speech(6), RATE * 9)
    const r = analyzeSample(x, RATE)
    expect(r.warns).toEqual(['pause'])
    expect(r.longestPauseSec).toBeGreaterThan(2.9)
  })

  // 样本会被重编码成 48 kHz 再上传,百炼自己查不出「原本是 16 kHz 录的」—— 只能靠这条
  it('warns when there is nothing above 8 kHz (a 16 kHz recording upsampled)', () => {
    expect(analyzeSample(speech(12, { wide: false }), RATE).warns).toEqual(['narrowband'])
    expect(analyzeSample(speech(12).filter((_, i) => i % 3 === 0), 16000).warns).toContain('narrowband')
  })
})
