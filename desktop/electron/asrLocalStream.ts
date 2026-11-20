/**
 * 本地听写的准实时转写。SenseVoice 是离线模型(一次解一整句),这里把它包成和云端实时转写同一套事件
 * (Qwen realtime 的 transcription 事件:`session.updated` 由调用方发,这里发 `…transcription.text`(stash = 未定稿)、
 * `…transcription.completed`、`session.finished`),渲染层 services/voiceInputStream.ts 不用改就能边说边出字。
 *
 * 做法:当前这句的音频一直攒着,隔一小段就把整句重解一次当未定稿;停顿够长(endSilenceMs)就在停顿中点切开,
 * 这句再解一次定稿,余下的静音留作下一句的句头。一直不停顿到 maxUtteranceMs 就在最近 1.5 秒里最安静处硬切
 * (SenseVoice 一句过 30 秒就不可用)。没出声的句子不解:静音会被解成噪声 token(常见「그.」)。
 * 同一会话里一次只解一段;定稿排在未定稿前面。解码失败 = 整条结束(fail),渲染层留下已定稿的句子。
 */

export interface LocalDictationOptions {
  /** 解一段 16 kHz 单声道音频。同一会话里不会并发调用。 */
  decode(samples: Float32Array): Promise<string>
  /** 发一条事件(调用方序列化成 JSON 交给渲染层)。 */
  send(message: Record<string, unknown>): void
  /** 解码出错:调用方关掉连接并通知渲染层。 */
  fail(): void
  sampleRate?: number
  /** 两次未定稿解码之间至少隔多久;实际间隔还会跟着解码耗时放宽(耗时 × 1.5)。 */
  partialIntervalMs?: number
  /** 停顿多久算一句说完。 */
  endSilenceMs?: number
  /** 一句最长多少;到了就硬切。 */
  maxUtteranceMs?: number
}

export interface LocalDictation {
  /** PCM16 小端单声道。 */
  write(pcm: Uint8Array): void
  /** 不再收音:解完剩下的再发 session.finished。 */
  finish(): void
  /** 立刻作废,在途的解码结果丢掉。 */
  close(): void
}

const FRAME_MS = 20
const LEVEL_WINDOW = 1500 // 30 秒的 20ms 电平,给自适应阈值用

/** 只剩标点 / 空白的结果当没说(噪声常被解成一个句号)。 */
export function cleanLocalText(text: string): string {
  const t = (text || '').trim()
  return /^[\p{P}\p{S}\s]*$/u.test(t) ? '' : t
}

export function createLocalDictation(o: LocalDictationOptions): LocalDictation {
  const rate = o.sampleRate ?? 16000
  const frame = Math.max(1, Math.round((rate * FRAME_MS) / 1000))
  const partialEvery = o.partialIntervalMs ?? 400
  const endSilence = Math.round((rate * (o.endSilenceMs ?? 650)) / 1000)
  const maxUtter = Math.round((rate * (o.maxUtteranceMs ?? 20000)) / 1000)
  const preRoll = Math.round(rate * 0.3) // 开口前留 300ms,免得切掉字头
  const minSpeech = Math.round(rate * 0.12) // 少于 120ms 的响动(咔哒、咳一下)不算开口
  const minPartial = Math.round(rate * 0.35) // 开口不到 350ms 先不出未定稿:太短的音会被解成「ち？」「Yeah。」一闪

  let buf = new Float32Array(rate * 4)
  let len = 0
  let speech = 0 // 当前这句里高于阈值的采样数
  let silenceRun = 0 // 句尾连续低于阈值的采样数
  const levels: number[] = []
  let seq = 0
  let item = `local_${++seq}`
  const commits: Array<{ id: string; samples: Float32Array }> = []
  let dirty = false
  let busy = false
  let finished = false
  let closed = false
  let ended = false
  let nextPartialAt = 0
  let timer: ReturnType<typeof setTimeout> | undefined

  const threshold = (): number => {
    if (levels.length < 10) return 0.01
    const s = [...levels].sort((a, b) => a - b)
    const at = (p: number): number => s[Math.min(s.length - 1, Math.floor(p * s.length))]
    // 底噪 × 3 / 两端差的 15%,取大;但不高过响的那头的一半 —— 一直在说话时窗口里没有静音,底噪就是人声,
    // 不封顶阈值会跑到人声之上,整段被当成停顿切碎。最后再兜 0.004:全是静音时别把底噪当开口。
    return Math.max(0.004, Math.min(at(0.9) * 0.5, Math.max(at(0.1) * 3, at(0.1) + 0.15 * (at(0.9) - at(0.1)))))
  }
  const rmsOf = (from: number, to: number): number => {
    let sum = 0
    for (let j = from; j < to; j++) sum += buf[j] * buf[j]
    return Math.sqrt(sum / Math.max(1, to - from))
  }
  /** 从 from 起重新数这句的开口量与句尾静音(切句后余下那段要重数)。 */
  const measure = (from: number, thr: number, record: boolean): void => {
    for (let i = from; i < len; i += frame) {
      const end = Math.min(len, i + frame)
      const rms = rmsOf(i, end)
      if (record) {
        levels.push(rms)
        if (levels.length > LEVEL_WINDOW) levels.shift()
      }
      if (rms >= thr) { speech += end - i; silenceRun = 0 } else silenceRun += end - i
    }
  }
  const append = (x: Float32Array): void => {
    if (len + x.length > buf.length) {
      const grown = new Float32Array(Math.max(buf.length * 2, len + x.length))
      grown.set(buf.subarray(0, len))
      buf = grown
    }
    buf.set(x, len)
    len += x.length
  }
  const keepTail = (n: number): void => {
    if (len <= n) return
    buf.copyWithin(0, len - n, len)
    len = n
    silenceRun = Math.min(silenceRun, len)
  }
  const commitAt = (cut: number, thr: number): void => {
    commits.push({ id: item, samples: buf.slice(0, cut) })
    buf.copyWithin(0, cut, len)
    len -= cut
    item = `local_${++seq}`
    speech = 0
    silenceRun = 0
    dirty = false
    measure(0, thr, false)
    if (!speech) keepTail(preRoll)
  }
  /** 硬切点:最近 1.5 秒里最安静的那一帧的中点。 */
  const quietestCut = (): number => {
    const from = Math.max(frame, len - Math.round(rate * 1.5))
    let best = len
    let bestRms = Infinity
    for (let i = from; i + frame <= len; i += frame) {
      const rms = rmsOf(i, i + frame)
      if (rms < bestRms) { bestRms = rms; best = i + (frame >> 1) }
    }
    return best
  }

  const run = (samples: Float32Array, then: (text: string) => void): void => {
    busy = true
    const started = Date.now()
    let ok = true
    o.decode(samples).then(
      (text) => { if (!closed) then(cleanLocalText(text)) },
      () => { ok = false },
    ).finally(() => {
      busy = false
      if (closed) return
      if (!ok) { closed = true; clearTimeout(timer); o.fail(); return }
      nextPartialAt = Date.now() + Math.max(partialEvery, (Date.now() - started) * 1.5)
      pump()
    })
  }

  const pump = (): void => {
    if (closed || busy) return
    const next = commits.shift()
    if (next) {
      run(next.samples, (text) => o.send({ type: 'conversation.item.input_audio_transcription.completed', item_id: next.id, transcript: text }))
      return
    }
    if (finished) {
      if (!ended) { ended = true; o.send({ type: 'session.finished' }) }
      return
    }
    if (!dirty || speech < minPartial) return
    const wait = nextPartialAt - Date.now()
    if (wait > 0) {
      if (!timer) timer = setTimeout(() => { timer = undefined; pump() }, wait)
      return
    }
    dirty = false
    const id = item
    // 解的过程中这句被切走了就不发:定稿马上跟上,发了反而闪一下旧字
    run(buf.slice(0, len), (text) => {
      if (id === item && text) o.send({ type: 'conversation.item.input_audio_transcription.text', item_id: id, text: '', stash: text })
    })
  }

  return {
    write(pcm) {
      if (closed || finished || pcm.byteLength < 2) return
      const n = pcm.byteLength >> 1
      const view = new DataView(pcm.buffer, pcm.byteOffset, n * 2)
      const x = new Float32Array(n)
      for (let i = 0; i < n; i++) x[i] = view.getInt16(i * 2, true) / 32768
      const thr = threshold()
      const from = len
      append(x)
      measure(from, thr, true)
      dirty = true
      if (speech < minSpeech && silenceRun >= endSilence) speech = 0 // 一下响动后又静下来:不算开口
      if (!speech) keepTail(preRoll)
      else if (speech >= minSpeech && silenceRun >= endSilence) commitAt(len - (silenceRun >> 1), thr)
      else if (len >= maxUtter) commitAt(quietestCut(), thr)
      pump()
    },
    finish() {
      if (closed || finished) return
      finished = true
      clearTimeout(timer)
      timer = undefined
      if (speech >= minSpeech) commitAt(len, threshold())
      pump()
    },
    close() {
      closed = true
      clearTimeout(timer)
      timer = undefined
    },
  }
}
