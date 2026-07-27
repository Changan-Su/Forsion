import { describe, expect, it } from 'vitest'
import { splitOnSilence, wavToSamples } from './asrAudio'

/** 造一段 16k 单声道:tone(有声) / silence(静音) 交替,单位秒。 */
function build(parts: Array<{ kind: 'tone' | 'sil'; sec: number }>, sr = 16000): Float32Array {
  const total = Math.round(parts.reduce((a, p) => a + p.sec, 0) * sr)
  const out = new Float32Array(total)
  let i = 0
  for (const p of parts) {
    const n = Math.round(p.sec * sr)
    for (let k = 0; k < n; k++, i++) out[i] = p.kind === 'tone' ? 0.3 * Math.sin((2 * Math.PI * 220 * k) / sr) : 0
  }
  return out
}

describe('splitOnSilence(SenseVoice 是短句模型,长音频必须切;切点即时间戳来源)', () => {
  it('静音处断开,段数=有声段数', () => {
    const s = build([{ kind: 'tone', sec: 3 }, { kind: 'sil', sec: 1 }, { kind: 'tone', sec: 3 }, { kind: 'sil', sec: 1 }, { kind: 'tone', sec: 2 }])
    const segs = splitOnSilence(s, 16000)
    expect(segs.length).toBe(3)
    // 第一刀落在 3~4s 那段静音里(中点 ~3.5s),不该切进人声
    expect(segs[0].to / 16000).toBeGreaterThan(3)
    expect(segs[0].to / 16000).toBeLessThan(4)
  })

  it('短于阈值的停顿不切(不会把一句话剁碎)', () => {
    const s = build([{ kind: 'tone', sec: 2 }, { kind: 'sil', sec: 0.15 }, { kind: 'tone', sec: 2 }])
    expect(splitOnSilence(s, 16000).length).toBe(1)
  })

  it('一直没静音也必须硬切(否则整段几十分钟喂进模型)', () => {
    const s = build([{ kind: 'tone', sec: 70 }])
    const segs = splitOnSilence(s, 16000, { maxSegMs: 20000 })
    expect(segs.length).toBeGreaterThanOrEqual(3)
    for (const g of segs) expect((g.to - g.from) / 16000).toBeLessThanOrEqual(20.1)
  })

  it('段落首尾相接、单调、覆盖全长(时间戳不能有洞或倒退)', () => {
    const s = build([{ kind: 'tone', sec: 2 }, { kind: 'sil', sec: 0.8 }, { kind: 'tone', sec: 5 }, { kind: 'sil', sec: 0.6 }, { kind: 'tone', sec: 3 }])
    const segs = splitOnSilence(s, 16000)
    expect(segs[0].from).toBe(0)
    expect(segs[segs.length - 1].to).toBe(s.length)
    for (let i = 1; i < segs.length; i++) expect(segs[i].from).toBe(segs[i - 1].to)
  })

  it('全静音 / 空输入不崩', () => {
    expect(splitOnSilence(new Float32Array(0), 16000)).toEqual([])
    expect(splitOnSilence(build([{ kind: 'sil', sec: 5 }]), 16000).length).toBeGreaterThanOrEqual(1)
  })
})

describe('wavToSamples', () => {
  it('解析 16-bit 单声道 WAV 头', () => {
    const n = 8, header = Buffer.alloc(44)
    header.write('RIFF', 0); header.write('WAVE', 8); header.write('fmt ', 12)
    header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20); header.writeUInt16LE(1, 22)
    header.writeUInt32LE(16000, 24); header.writeUInt16LE(16, 34)
    header.write('data', 36); header.writeUInt32LE(n * 2, 40)
    const body = Buffer.alloc(n * 2)
    body.writeInt16LE(16384, 0)
    const { samples, sampleRate } = wavToSamples(Buffer.concat([header, body]))
    expect(sampleRate).toBe(16000)
    expect(samples.length).toBe(n)
    expect(samples[0]).toBeCloseTo(0.5, 3)
  })
})
