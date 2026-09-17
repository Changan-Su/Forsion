/**
 * 语音台架共用:macOS `say`(Tingting)合成几句中文 + 句间静音 → 16k 16-bit 单声道 WAV,
 * 喂给 Chromium 假麦克风。live-voice.probe.cjs(采集+ASR)与 live-voice.e2e.cjs(整条 UI)共用。
 *
 * ⚠️ Electron 里假麦克风要三件套才有声音:
 *   --use-fake-device-for-media-stream --use-file-for-fake-audio-capture=<wav>%noloop
 *   --disable-features=AudioServiceOutOfProcess   ← 缺这个:设备在、帧照常回调、电平恒 0(音频服务进程收不到文件开关)
 */
const { execFileSync } = require('child_process')
const fs = require('fs')
const path = require('path')

const RATE = 16000

/** 16-bit PCM WAV → Int16Array(只认 afconvert 产出的规整 RIFF)。 */
function readWav(file) {
  const b = fs.readFileSync(file)
  let o = 12
  while (o < b.length) {
    const id = b.toString('ascii', o, o + 4), size = b.readUInt32LE(o + 4)
    if (id === 'data') return new Int16Array(b.buffer.slice(b.byteOffset + o + 8, b.byteOffset + o + 8 + size))
    o += 8 + size + (size % 2)
  }
  throw new Error(`no data chunk: ${file}`)
}

function writeWav(file, samples, rate = RATE) {
  const h = Buffer.alloc(44)
  h.write('RIFF', 0); h.writeUInt32LE(36 + samples.length * 2, 4); h.write('WAVE', 8); h.write('fmt ', 12)
  h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22); h.writeUInt32LE(rate, 24)
  h.writeUInt32LE(rate * 2, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34); h.write('data', 36); h.writeUInt32LE(samples.length * 2, 40)
  fs.writeFileSync(file, Buffer.concat([h, Buffer.from(samples.buffer, samples.byteOffset, samples.byteLength)]))
}

/** texts[i] 之间按 gaps 插静音(gaps.length = texts.length + 1:句前…句后)。返回 { file, seconds, lineSeconds }。 */
function synthMic(outDir, texts, gaps) {
  const parts = [new Int16Array(Math.round(RATE * gaps[0]))]
  const lineSeconds = []
  texts.forEach((text, i) => {
    const aiff = path.join(outDir, `l${i}.aiff`), wav = path.join(outDir, `l${i}.wav`)
    execFileSync('say', ['-v', 'Tingting', '-o', aiff, text])
    execFileSync('afconvert', ['-f', 'WAVE', '-d', `LEI16@${RATE}`, '-c', '1', aiff, wav])
    const samples = readWav(wav)
    lineSeconds.push(samples.length / RATE)
    parts.push(samples, new Int16Array(Math.round(RATE * gaps[i + 1])))
  })
  const mic = new Int16Array(parts.reduce((a, p) => a + p.length, 0))
  parts.reduce((o, p) => { mic.set(p, o); return o + p.length }, 0)
  const file = path.join(outDir, 'mic.wav')
  writeWav(file, mic)
  return { file, seconds: mic.length / RATE, lineSeconds }
}

const fakeMicSwitches = (wav) => [
  '--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream',
  `--use-file-for-fake-audio-capture=${wav}%noloop`, '--disable-features=AudioServiceOutOfProcess',
]

module.exports = { RATE, readWav, writeWav, synthMic, fakeMicSwitches }
