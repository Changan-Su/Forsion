/**
 * ASR 音频前处理(纯函数,不 import electron/sherpa —— 故可直接单测)。
 * asrLocal.ts 在模块加载期就要 healMacQuarantine(需要 electron app),把这两个函数留在那边等于不可测。
 */

/**
 * WAV(PCM)→ V8 拥有的单声道 Float32Array + 采样率。
 * ⚠️不用 sherpa `readWave`:它返回 native 分配的 external buffer,而 Electron 禁止 external buffer,
 * 传给 acceptWaveform 会抛「External buffers are not allowed」(plain-node 不触发,只 Electron 触发)。
 * 自解析成普通 Float32Array 绕开。渲染端固定 16k 单声道 16-bit,但也兼容多声道(取首声道)/8·32-bit。
 */
export function wavToSamples(buf: Buffer): { samples: Float32Array; sampleRate: number } {
  let off = 12, sampleRate = 16000, channels = 1, bits = 16, dataOff = -1, dataLen = 0
  if (buf.length >= 44 && buf.toString('ascii', 0, 4) === 'RIFF') {
    while (off + 8 <= buf.length) {
      const id = buf.toString('ascii', off, off + 4)
      const sz = buf.readUInt32LE(off + 4)
      if (id === 'fmt ') { channels = buf.readUInt16LE(off + 10); sampleRate = buf.readUInt32LE(off + 12); bits = buf.readUInt16LE(off + 22) }
      else if (id === 'data') { dataOff = off + 8; dataLen = sz; break }
      off += 8 + sz + (sz & 1)
    }
  }
  if (dataOff < 0) { dataOff = 44; dataLen = Math.max(0, buf.length - 44) } // 兜底
  const frameBytes = Math.max(1, bits >> 3) * Math.max(1, channels)
  const n = Math.floor(Math.max(0, dataLen) / frameBytes)
  const samples = new Float32Array(n) // V8 拥有(非 external)
  for (let i = 0; i < n; i++) {
    const p = dataOff + i * frameBytes // 取首声道
    samples[i] = bits === 16 ? buf.readInt16LE(p) / 32768
      : bits === 32 ? buf.readFloatLE(p)
      : bits === 8 ? (buf.readUInt8(p) - 128) / 128
      : 0
  }
  return { samples, sampleRate }
}

/**
 * 按静音切段(纯函数,可单测)。两个用途合一:
 *  ① SenseVoice 是**短句模型**,整段几十分钟喂进去结果没法看 —— 必须切;
 *  ② 切点即时间戳来源 —— 视频转录要的 segments 就是这么来的(近似但真实,不是编的)。
 * 门限按本段音频自适应(p10 当底噪、p90 当人声),避免固定阈值在录音电平差异下失灵。
 */
export function splitOnSilence(
  samples: Float32Array,
  sampleRate: number,
  o: { minSilenceMs?: number; minSegMs?: number; maxSegMs?: number } = {},
): Array<{ from: number; to: number }> {
  const minSilence = Math.round(((o.minSilenceMs ?? 420) / 1000) * sampleRate)
  const minSeg = Math.round(((o.minSegMs ?? 1200) / 1000) * sampleRate)
  const maxSeg = Math.round(((o.maxSegMs ?? 24000) / 1000) * sampleRate)
  const frame = Math.max(1, Math.round(sampleRate * 0.02)) // 20ms
  const n = samples.length
  if (n === 0) return []
  if (n <= maxSeg && n <= minSeg) return [{ from: 0, to: n }]

  const rms: number[] = []
  for (let i = 0; i < n; i += frame) {
    let sum = 0
    const end = Math.min(n, i + frame)
    for (let j = i; j < end; j++) sum += samples[j] * samples[j]
    rms.push(Math.sqrt(sum / Math.max(1, end - i)))
  }
  const sorted = [...rms].sort((a, b) => a - b)
  const at = (p: number): number => sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))]
  const thr = Math.max(1e-4, at(0.1) + 0.12 * (at(0.9) - at(0.1)))

  const out: Array<{ from: number; to: number }> = []
  let segStart = 0, silRun = 0
  for (let f = 0; f < rms.length; f++) {
    const pos = f * frame
    if (rms[f] < thr) silRun += frame
    else {
      // 一段够长的静音结束了 → 在静音中点断开(前后各留一半,免得切掉字头字尾)
      if (silRun >= minSilence && pos - segStart >= minSeg) {
        const cut = pos - Math.floor(silRun / 2)
        out.push({ from: segStart, to: cut })
        segStart = cut
      }
      silRun = 0
    }
    if (pos - segStart >= maxSeg) { out.push({ from: segStart, to: pos }); segStart = pos; silRun = 0 } // 一直没静音 → 硬切
  }
  if (n - segStart > frame) out.push({ from: segStart, to: n })
  return out.length ? out : [{ from: 0, to: n }]
}
