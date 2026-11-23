/**
 * 本地准实时听写的真模型探针:WAV(16k 单声道)按实时节奏喂进 createLocalDictation,解码用真 SenseVoice
 * (~/.forsion-dev/models/sensevoice 或 FORSION_SENSEVOICE_DIR),打印每个事件到达的时刻。
 * 用法:npx vite-node scripts/probe-local-dictation.ts -- <speech.wav>
 * 生成测试语音:say -v Tingting "……[[slnc 1200]]……" -o x.aiff && afconvert -f WAVE -d LEI16@16000 -c 1 x.aiff x.wav
 */
import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { createLocalDictation } from '../electron/asrLocalStream'

const wav = process.argv.slice(2).find((a) => a.endsWith('.wav'))
if (!wav) throw new Error('usage: probe-local-dictation.ts <speech.wav>')
const dir = process.env.FORSION_SENSEVOICE_DIR || join(homedir(), '.forsion-dev', 'models', 'sensevoice')
const sherpa = createRequire(import.meta.url)('sherpa-onnx-node')
const rec = await sherpa.OfflineRecognizer.createAsync({
  featConfig: { sampleRate: 16000, featureDim: 80 },
  modelConfig: { senseVoice: { model: join(dir, 'model.int8.onnx'), language: '', useInverseTextNormalization: 1 }, tokens: join(dir, 'tokens.txt'), numThreads: 2, provider: 'cpu', debug: 0 },
})
const buf = readFileSync(wav)
let off = 12
while (buf.toString('ascii', off, off + 4) !== 'data') off += 8 + buf.readUInt32LE(off + 4)
const pcm = buf.subarray(off + 8, off + 8 + buf.readUInt32LE(off + 4))
const t0 = Date.now()
const stamp = () => `${((Date.now() - t0) / 1000).toFixed(2)}s`
let decodes = 0, decodeMs = 0
await new Promise<void>((resolve) => {
  const d = createLocalDictation({
    decode: async (samples) => {
      const s = Date.now()
      const stream = rec.createStream()
      stream.acceptWaveform({ samples, sampleRate: 16000 })
      const r = await rec.decodeAsync(stream)
      decodes++; decodeMs += Date.now() - s
      return r.text || ''
    },
    send: (m) => {
      const kind = String(m.type).replace('conversation.item.input_audio_transcription.', '')
      console.log(stamp(), kind.padEnd(16), m.item_id ?? '', JSON.stringify(m.stash ?? m.transcript ?? ''))
      if (m.type === 'session.finished') resolve()
    },
    fail: () => { console.log(stamp(), 'FAIL'); resolve() },
  })
  const chunk = 2048 // 1024 个采样,同渲染层
  let i = 0
  const tick = () => {
    if (i >= pcm.length) { console.log(stamp(), 'finish (audio ended)'); d.finish(); return }
    d.write(new Uint8Array(pcm.subarray(i, i + chunk)))
    i += chunk
    setTimeout(tick, 64)
  }
  tick()
})
console.log(`audio ${(pcm.length / 32000).toFixed(2)}s, ${decodes} decodes, avg ${(decodeMs / Math.max(1, decodes)).toFixed(0)}ms`)
