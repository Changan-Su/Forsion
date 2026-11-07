/** Dictation transport: mono PCM16 at 16 kHz, Qwen ASR transcript events back. */
export const VOICE_INPUT_RATE = 16000
export const VOICE_INPUT_FRAME_LIMIT = 8192
export type VoiceInputStreamEvent = { type: 'message'; data: string } | { type: 'closed' } | { type: 'supported' }
export interface VoiceInputConnection {
  write(pcm: ArrayBuffer): void
  finish(): void
  close(): void
}
export type OpenVoiceInput = (modelId: string | undefined, listener: (event: VoiceInputStreamEvent) => void) => VoiceInputConnection | null

/** apiBase includes /api. Use the existing realtime upgrade route on hosted installs. */
export function voiceInputCloudUrl(apiBase: string, modelId?: string, client?: string): string {
  const url = new URL(apiBase.replace(/\/+$/, '') + '/brain/realtime')
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
  url.searchParams.set('mode', 'transcription')
  url.searchParams.set('projectSource', 'tangu')
  if (modelId) url.searchParams.set('model', modelId)
  if (client) url.searchParams.set('client', client)
  return url.href
}
