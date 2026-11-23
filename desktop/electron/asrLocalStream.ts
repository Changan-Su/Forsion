/**
 * 本地听写的准实时转写。SenseVoice 是离线模型(一次解一整句),这里把它包成和云端实时转写同一套事件
 * (Qwen realtime 的 transcription 事件:`session.updated` 由调用方发,这里发 `…transcription.text`(stash = 未定稿)、
 * `…transcription.completed`、`session.finished`),渲染层 services/voiceInputStream.ts 不用改就能边说边出字。
 *
 * 做法:当前这句的音频一直攒着,隔一小段就把整句重解一次当未定稿;停顿够长(endSilenceMs)就在停顿中点切开,
 * 这句再解一次定稿,余下的静音留作下一句的句头。一直不停顿到 maxUtteranceMs 就在最近 1.5 秒里最安静处硬切
 * (SenseVoice 一句过 30 秒就不可用)。没出声的句子不解:静音会被解成噪声 token(常见「그.」)。
 *
 * 有没有出声按底噪判:最近 10 秒 20ms 电平的 5% 分位当底噪,高出 3 倍(约 10dB)算出声。只看底噪、不看响的那头 ——
 * 前一句说得响,后一句轻一点也照样认(11-20 Codex 评审 1);稳定的风扇声自己就是底噪,不会被当成一直在说(评审 5)。
 * 整场一次都没认出声、但确实有音量的,收尾时整段解一次,和原来的整段转写一样,不丢。
 *
 * 同一会话里一次只解一段,定稿排在未定稿前面。未定稿解失败只是少刷新一次;定稿解失败 = 整条结束(fail),
 * 渲染层留下已定稿的句子。积压的定稿音频超过 90 秒(解码卡住)同样结束,不无限攒。
 */

export interface LocalDictationOptions {
  /** 解一段 16 kHz 单声道音频。同一会话里不会并发调用。`wanted()` 变成 false 时(会话关了 / 未定稿已过时)
   *  还没开始解的可以直接回空串,别占着共用的解码器。 */
  decode(samples: Float32Array, wanted: () => boolean): Promise<string>
  /** 发一条事件(调用方序列化成 JSON 交给渲染层)。 */
  send(message: Record<string, unknown>): void
  /** 定稿解码出错 / 积压过多:调用方关掉连接并通知渲染层。 */
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
  /** 立刻作废:在途的解码结果丢掉,排着的定稿清掉。 */
  close(): void
}

const FRAME_MS = 20
const FLOOR_WINDOW = 500 // 10 秒的 20ms 电平
/** 渲染层整段转写那条路的「没声音」线(hooks/useVoiceInput.ts):峰值低于它就是没录到。 */
const SILENT_PEAK = 0.005

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
  const maxBacklog = rate * 90
  const maxQuiet = rate * 30 // 一次没认出声时最多留 30 秒给收尾整段解

  let buf = new Float32Array(rate * 4)
  let len = 0
  let speech = 0 // 当前这句里高于阈值的采样数
  let silenceRun = 0 // 句尾连续低于阈值的采样数
  const levels: number[] = []
  let seq = 0
  let item = `local_${++seq}`
  let commits: Array<{ id: string; samples: Float32Array }> = []
  let backlog = 0
  let everSpoke = false
  let peak = 0
  let quiet: Float32Array[] = [] // 还没认出过声时的整段音频(收尾兜底用)
  let quietLen = 0
  let dirty = false
  let busy = false
  let finished = false
  let closed = false
  let ended = false
  let nextPartialAt = 0
  let timer: ReturnType<typeof setTimeout> | undefined

  // 刚开麦几帧也按底噪算(那时 5% 分位就是最小值,按下麦克风到开口总有一小段静的),别用固定值:
  // 风扇声本身就高过固定值时,开头半秒会被当成开口。
  const threshold = (): number => {
    if (!levels.length) return 0.01
    const s = [...levels].sort((a, b) => a - b)
    return Math.max(0.004, s[Math.floor(s.length * 0.05)] * 3)
  }
  const rmsOf = (from: number, to: number): number => {
    let sum = 0
    for (let j = from; j < to; j++) sum += buf[j] * buf[j]
    return Math.sqrt(sum / Math.max(1, to - from))
  }
  /** 从 from 起数这句的开口量与句尾静音(切句后余下那段要重数,那次不记电平)。 */
  const measure = (from: number, thr: number, record: boolean): void => {
    for (let i = from; i < len; i += frame) {
      const end = Math.min(len, i + frame)
      const rms = rmsOf(i, end)
      if (record) {
        levels.push(rms)
        if (levels.length > FLOOR_WINDOW) levels.shift()
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
  const queueCommit = (id: string, samples: Float32Array): void => {
    commits.push({ id, samples })
    backlog += samples.length
  }
  const commitAt = (cut: number, thr: number): void => {
    queueCommit(item, buf.slice(0, cut))
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
  const stop = (): void => {
    closed = true
    clearTimeout(timer)
    timer = undefined
    commits = []
    backlog = 0
    quiet = []
    buf = new Float32Array(0)
    len = 0
  }

  const run = (samples: Float32Array, wanted: () => boolean, final: boolean, then: (text: string) => void): void => {
    busy = true
    const started = Date.now()
    let ok = true
    o.decode(samples, () => !closed && wanted()).then(
      (text) => { if (!closed) then(cleanLocalText(text)) },
      () => { ok = false },
    ).finally(() => {
      busy = false
      if (closed) return
      if (!ok && final) { stop(); o.fail(); return }
      nextPartialAt = Date.now() + Math.max(partialEvery, (Date.now() - started) * 1.5)
      pump()
    })
  }

  const pump = (): void => {
    if (closed || busy) return
    const next = commits.shift()
    if (next) {
      backlog -= next.samples.length
      run(next.samples, () => true, true, (text) => o.send({ type: 'conversation.item.input_audio_transcription.completed', item_id: next.id, transcript: text }))
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
    // 解之前 / 解的过程中这句被切走了就不发:定稿马上跟上,发了反而闪一下旧字
    run(buf.slice(0, len), () => id === item, false, (text) => {
      if (id === item && text) o.send({ type: 'conversation.item.input_audio_transcription.text', item_id: id, text: '', stash: text })
    })
  }

  return {
    write(pcm) {
      if (closed || finished || pcm.byteLength < 2) return
      const n = pcm.byteLength >> 1
      const view = new DataView(pcm.buffer, pcm.byteOffset, n * 2)
      const x = new Float32Array(n)
      for (let i = 0; i < n; i++) {
        x[i] = view.getInt16(i * 2, true) / 32768
        const a = Math.abs(x[i])
        if (a > peak) peak = a
      }
      if (!everSpoke) {
        quiet.push(x)
        quietLen += x.length
        while (quietLen > maxQuiet && quiet.length > 1) quietLen -= quiet.shift()!.length
      }
      const thr = threshold()
      const from = len
      append(x)
      measure(from, thr, true)
      dirty = true
      if (speech < minSpeech && silenceRun >= endSilence) speech = 0 // 一下响动后又静下来:不算开口
      if (speech >= minSpeech && !everSpoke) { everSpoke = true; quiet = []; quietLen = 0 }
      if (!speech) keepTail(preRoll)
      else if (speech >= minSpeech && silenceRun >= endSilence) commitAt(len - (silenceRun >> 1), thr)
      else if (len >= maxUtter) commitAt(quietestCut(), thr)
      if (backlog > maxBacklog) { stop(); o.fail(); return }
      pump()
    },
    finish() {
      if (closed || finished) return
      finished = true
      clearTimeout(timer)
      timer = undefined
      if (speech >= minSpeech) commitAt(len, threshold())
      else if (!everSpoke && peak >= SILENT_PEAK && quietLen) {
        // 一次都没认出声,但确实录到了音量:照原来的整段转写解一次(说得很轻 / 底噪很高时不丢字)
        const whole = new Float32Array(quietLen)
        let at = 0
        for (const part of quiet) { whole.set(part, at); at += part.length }
        quiet = []
        queueCommit(item, whole)
      }
      pump()
    },
    close: stop,
  }
}
