import { VOICE_INPUT_RATE, voiceInputCloudUrl, type OpenVoiceInput, type VoiceInputConnection, type VoiceInputStreamEvent } from '../../../shared/voiceInputStream'
import { REALTIME_BEARER_PROTOCOL } from './backendService'

export interface VoicePreview { text: string; pending: string }

export function joinVoiceText(before: string, after: string): string {
  if (!before || !after || /\s$/.test(before) || /^\s/u.test(after)) return before + after
  if (/^[,.;:!?，。；：！？、]/u.test(after) || /[，。；：！？、]$/u.test(before)
      || /\p{Script=Han}$/u.test(before) && /^\p{Script=Han}/u.test(after)) return before + after
  return before + ' ' + after
}

export function cloudVoiceInput(apiBase: string, token: string, client?: string): OpenVoiceInput {
  return (modelId, listener) => {
    if (!token) return null
    const ws = new WebSocket(voiceInputCloudUrl(apiBase, modelId, client), [REALTIME_BEARER_PROTOCOL, token])
    ws.onmessage = ({ data }) => { if (typeof data === 'string') listener({ type: 'message', data }) }
    ws.onclose = ws.onerror = () => listener({ type: 'closed' })
    return {
      write: pcm => {
        if (ws.readyState !== WebSocket.OPEN || ws.bufferedAmount > 256 * 1024) throw new Error('dictation connection unavailable')
        ws.send(pcm)
      },
      finish: () => ws.send('finish'),
      close: () => {
        ws.onmessage = ws.onclose = ws.onerror = null
        ws.close()
      },
    }
  }
}

interface DictationResult { text: string; interrupted?: true }

interface Dictation {
  result: Promise<DictationResult | null>
  finish(): Promise<DictationResult | null>
  close(): void
}

/** Start audio capture before the handshake completes so the opening words are included. */
export function startStreamingDictation(
  source: MediaStreamAudioSourceNode,
  context: AudioContext,
  open: OpenVoiceInput,
  modelId: string | undefined,
  onPreview: (preview: VoicePreview | null) => void,
): Dictation {
  if (context.sampleRate !== VOICE_INPUT_RATE) throw new Error('16 kHz capture unavailable')
  const process = context.createScriptProcessor(1024, 1, 1)
  let finished = false
  let closed = false
  let ready = false
  let sentAudio = false
  let streamOnly = false
  let attempt = 0
  let connection: VoiceInputConnection | null
  let timer: ReturnType<typeof setTimeout>
  const buffered: ArrayBuffer[] = []
  const items = new Map<string, VoicePreview & { done?: true }>()
  let resolve!: (result: DictationResult | null) => void
  const result = new Promise<DictationResult | null>(r => { resolve = r })

  const textOf = (values: VoicePreview[]) => values.reduce((text, item) => joinVoiceText(text, item.text + item.pending), '')
  const closeCapture = () => {
    if (!process.onaudioprocess) return
    process.onaudioprocess = null
    source.disconnect(process)
    process.disconnect()
  }
  const settle = (final: DictationResult | null) => {
    if (closed) return
    closed = true
    clearTimeout(timer)
    closeCapture()
    buffered.length = 0
    connection?.close()
    resolve(final)
  }
  const confirmed = () => textOf([...items.values()].filter(item => item.done))
  const fail = () => {
    if (closed) return
    if (streamOnly && !sentAudio && attempt === 1) {
      connection?.close()
      connect()
      return
    }
    onPreview(null)
    // Once audio has been accepted, a second upload can bill again and cannot
    // recover a streaming-only model. Keep the finished sentences from this run.
    settle(sentAudio || streamOnly ? { text: confirmed(), interrupted: true } : null)
  }
  const write = (pcm: ArrayBuffer) => {
    connection?.write(pcm)
    sentAudio = true
  }
  const flushFinish = () => {
    clearTimeout(timer)
    timer = setTimeout(fail, 6500)
    connection?.finish()
  }

  const receive = (event: VoiceInputStreamEvent) => {
    if (event.type === 'supported') { acceptCapability(); return }
    if (event.type === 'closed') { fail(); return }
    try {
      const m = JSON.parse(event.data)
      if (m.type === 'dictation.supported') acceptCapability()
      else if (m.type === 'session.updated' && !ready) {
        ready = true
        clearTimeout(timer)
        for (const pcm of buffered) write(pcm)
        buffered.length = 0
        onPreview({ text: '', pending: '' })
        if (finished) flushFinish()
      } else if (m.type === 'session.finished' && finished) {
        settle(sentAudio ? { text: confirmed() } : null)
      } else if (m.type === 'error' || m.type === 'conversation.item.input_audio_transcription.failed') {
        fail()
      } else if (typeof m.item_id === 'string') {
        const item = items.get(m.item_id)
        if (item?.done) return
        if (m.type === 'input_audio_buffer.committed') {
          if (!item) items.set(m.item_id, { text: '', pending: '' })
          return
        }
        if (m.type === 'conversation.item.input_audio_transcription.completed' && typeof m.transcript === 'string') {
          items.set(m.item_id, { text: m.transcript, pending: '', done: true })
        } else if (m.type === 'conversation.item.input_audio_transcription.text' && typeof m.text === 'string') {
          items.set(m.item_id, { text: m.text, pending: typeof m.stash === 'string' ? m.stash : '' })
        } else return
        const current = [...items.values()].filter(entry => entry.text || entry.pending)
        const last = current.pop()
        const pending = last?.pending ?? ''
        const full = last ? joinVoiceText(textOf(current), last.text + pending) : ''
        onPreview({ text: pending ? full.slice(0, -pending.length) : full, pending })
      }
    } catch { fail() }
  }
  const acceptCapability = () => {
    if (streamOnly || ready) return
    streamOnly = true
  }
  const connect = () => {
    ready = false
    const generation = ++attempt
    clearTimeout(timer)
    timer = setTimeout(fail, streamOnly ? 8000 : 4000)
    try {
      connection = open(modelId, event => queueMicrotask(() => {
        if (!closed && attempt === generation) receive(event)
      }))
      if (!connection) fail()
    } catch {
      connection = null
      fail()
    }
  }
  connect()
  if (closed) return { result, finish: () => result, close: () => {} }

  process.onaudioprocess = ({ inputBuffer }) => {
    const samples = inputBuffer.getChannelData(0)
    const pcm = new Int16Array(samples.length)
    for (let i = 0; i < samples.length; i++) {
      pcm[i] = Math.max(-32768, Math.min(32767, Math.round(samples[i] * 32767)))
    }
    try {
      if (ready) write(pcm.buffer)
      else if (buffered.length < 256) buffered.push(pcm.buffer)
      else fail()
    } catch { fail() }
  }
  source.connect(process)
  process.connect(context.destination) // The output buffer stays silent.
  return {
    result,
    finish() {
      if (!closed && !finished) {
        finished = true
        closeCapture()
        if (ready) {
          try { flushFinish() } catch { fail() }
        }
      }
      return result
    },
    close: () => settle(null),
  }
}
