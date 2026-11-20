import { randomUUID } from 'node:crypto'
import { ipcMain, type IpcMainEvent, type IpcMainInvokeEvent } from 'electron'
import WebSocket from 'ws'
import { VOICE_INPUT_FRAME_LIMIT, VOICE_INPUT_RATE, type VoiceInputStreamEvent } from '../shared/voiceInputStream'
import { createLocalDictation, type LocalDictation } from './asrLocalStream'

export interface VoiceInputEndpoint {
  url: string
  token: string
  direct?: true
}

/** 本机离线模型(SenseVoice):不连网,主进程自己边收边解(asrLocalStream.ts)。`decoder()` 备好模型后交出解码函数。 */
export interface LocalVoiceInputEndpoint {
  local: true
  decoder(): Promise<(samples: Float32Array) => Promise<string>>
}

/** Only match the documented vendor protocol on vendor hosts. */
export function qwenVoiceInputUrl(baseUrl: string, model: string): string | null {
  let url: URL
  try { url = new URL(baseUrl) } catch { return null }
  if (url.protocol !== 'https:' || !url.hostname.endsWith('.aliyuncs.com') ||
      !/^qwen3-asr-flash-realtime(?:-\d{4}-\d{2}-\d{2})?$/.test(model)) return null
  return `wss://${url.host}/api-ws/v1/realtime?model=${encodeURIComponent(model)}`
}

export function registerVoiceInputStream(
  trusted: (event: IpcMainEvent | IpcMainInvokeEvent) => boolean,
  resolveEndpoint: (modelId?: string) => Promise<VoiceInputEndpoint | LocalVoiceInputEndpoint | null>,
): void {
  interface Connection {
    id: string
    send(pcm: Buffer | 'finish'): void
    close(notify?: boolean): void
  }
  const connections = new Map<number, Connection>()
  ipcMain.handle('asr:streamStart', async (event, id: string, modelId?: string) => {
    if (!trusted(event) || !/^[\w-]{1,64}$/.test(id) || (modelId !== undefined && typeof modelId !== 'string')) return false
    const sender = event.sender
    const senderId = sender.id
    connections.get(senderId)?.close(true)
    let socket: WebSocket | undefined
    let local: LocalDictation | undefined
    let direct = false
    let finished = false
    let closed = false
    const emit = (message: VoiceInputStreamEvent) => {
      if (!sender.isDestroyed()) sender.send('asr:streamEvent', id, message)
    }
    const navigating = (_e: unknown, _url: string, inPlace: boolean, mainFrame: boolean) => {
      if (!inPlace && mainFrame) connection.close()
    }
    const destroyed = () => connection.close()
    const connection: Connection = {
      id,
      send(pcm) {
        if (local) {
          if (finished) return
          finished = pcm === 'finish'
          if (pcm === 'finish') local.finish()
          else local.write(pcm)
          return
        }
        if (finished || socket?.readyState !== WebSocket.OPEN) return
        if (socket.bufferedAmount > 256 * 1024) { connection.close(true); return }
        finished = pcm === 'finish'
        if (!direct) socket.send(pcm)
        else socket.send(JSON.stringify(pcm === 'finish'
          ? { type: 'session.finish', event_id: randomUUID() }
          : { type: 'input_audio_buffer.append', event_id: randomUUID(), audio: pcm.toString('base64') }))
      },
      close(notify = false) {
        if (closed) return
        closed = true
        if (connections.get(senderId) === connection) connections.delete(senderId)
        sender.removeListener('did-start-navigation', navigating)
        sender.removeListener('destroyed', destroyed)
        local?.close()
        if (socket?.readyState === WebSocket.CONNECTING) socket.terminate()
        else socket?.close()
        if (notify) emit({ type: 'closed' })
      },
    }
    connections.set(senderId, connection)
    sender.on('did-start-navigation', navigating)
    sender.once('destroyed', destroyed)
    try {
      const endpoint = await resolveEndpoint(modelId)
      if (closed || !endpoint) { connection.close(); return false }
      if ('local' in endpoint) {
        // 不发 'supported':本地不是「只能实时」的模型,模型加载慢过渲染层的握手等待时它照旧退回整段转写。
        const decode = await endpoint.decoder()
        if (closed) return false
        local = createLocalDictation({
          decode,
          send: (message) => { if (!closed) emit({ type: 'message', data: JSON.stringify(message) }) },
          fail: () => connection.close(true),
        })
        emit({ type: 'message', data: JSON.stringify({ type: 'session.updated' }) })
        return true
      }
      direct = !!endpoint.direct
      if (direct) emit({ type: 'supported' })
      socket = new WebSocket(endpoint.url, { headers: { Authorization: `Bearer ${endpoint.token}` }, handshakeTimeout: 5000, maxPayload: 64 * 1024 })
      socket.on('error', () => connection.close(true))
      socket.on('close', () => connection.close(true))
      socket.on('message', (data, binary) => {
        if (!closed && !binary) emit({ type: 'message', data: data.toString() })
      })
      if (direct) socket.once('open', () => socket?.send(JSON.stringify({
        type: 'session.update', event_id: randomUUID(),
        session: { input_audio_format: 'pcm', sample_rate: VOICE_INPUT_RATE, turn_detection: { type: 'server_vad' } },
      })))
      return true
    } catch {
      connection.close()
      return false
    }
  })
  ipcMain.on('asr:streamFrame', (event, id: string, frame: unknown) => {
    if (!trusted(event)) return
    const connection = connections.get(event.sender.id)
    if (!connection || connection.id !== id) return
    if (frame === 'close') connection.close()
    else if (frame === 'finish') connection.send(frame)
    else if (frame instanceof ArrayBuffer && frame.byteLength > 0 && frame.byteLength <= VOICE_INPUT_FRAME_LIMIT && frame.byteLength % 2 === 0) {
      connection.send(Buffer.from(frame))
    }
  })
}
