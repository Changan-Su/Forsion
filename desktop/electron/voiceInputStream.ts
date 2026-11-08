import { randomUUID } from 'node:crypto'
import { ipcMain, type IpcMainEvent, type IpcMainInvokeEvent } from 'electron'
import WebSocket from 'ws'
import { VOICE_INPUT_FRAME_LIMIT, VOICE_INPUT_RATE, type VoiceInputStreamEvent } from '../shared/voiceInputStream'

export interface VoiceInputEndpoint {
  url: string
  token: string
  direct?: true
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
  resolveEndpoint: (modelId?: string) => Promise<VoiceInputEndpoint | null>,
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
