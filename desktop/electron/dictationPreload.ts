/**
 * 语音胶囊窗口的 preload —— 只给听写用的那几样,不是主窗那份大 window.tangu:
 *   window.tangu = { platform, openVoiceInput, transcribeAudio }(useVoiceInput 要的就这些)
 *   window.forsionDictation = 收状态 + 交这一次听写的文字 / 错误 / 按钮
 * 交回去的东西主进程只认这扇胶囊的 webContents、只认当前会话号(electron/dictation/index.ts)。
 */
import { contextBridge, ipcRenderer } from 'electron'
import type { DictationCapsuleAction, DictationState } from '../shared/dictation'
import type { OpenVoiceInput, VoiceInputStreamEvent } from '../shared/voiceInputStream'

// ⚠️ 只 import 类型:preload 各自打成单文件。跟主窗 preload 共用任何运行时模块,rollup 就会拆出一个共享块,
// 而 orbit-create 之类的检查会把 preload.mjs 单独拷走用(拷走后相对 import 找不到)。通道名和主窗 preload 的转写桥
// 由 dictationPreload.test.ts 钉住和 shared/dictation.ts、preload.ts 一致。
const CH = { state: 'dictation:capsule:state', result: 'dictation:capsule:result', error: 'dictation:capsule:error', action: 'dictation:capsule:action' } as const

const openVoiceInput: OpenVoiceInput = (modelId, listener) => {
  const id = crypto.randomUUID()
  let closed = false
  const receive = (_event: unknown, sessionId: string, message: VoiceInputStreamEvent) => {
    if (id === sessionId && !closed) listener(message)
  }
  ipcRenderer.on('asr:streamEvent', receive)
  void ipcRenderer.invoke('asr:streamStart', id, modelId).then((ok: boolean) => {
    if (!ok && !closed) listener({ type: 'closed' })
  }, () => { if (!closed) listener({ type: 'closed' }) })
  return {
    write: pcm => ipcRenderer.send('asr:streamFrame', id, pcm),
    finish: () => ipcRenderer.send('asr:streamFrame', id, 'finish'),
    close: () => {
      if (closed) return
      closed = true
      ipcRenderer.removeListener('asr:streamEvent', receive)
      ipcRenderer.send('asr:streamFrame', id, 'close')
    },
  }
}

contextBridge.exposeInMainWorld('tangu', {
  platform: process.platform,
  openVoiceInput,
  transcribeAudio: (req: { audioBase64: string; mime?: string; modelId?: string; language?: string }): Promise<string> =>
    ipcRenderer.invoke('asr:transcribe', req),
})

contextBridge.exposeInMainWorld('forsionDictation', {
  onState: (cb: (s: DictationState) => void): (() => void) => {
    const h = (_e: unknown, s: DictationState) => cb(s)
    ipcRenderer.on(CH.state, h)
    return () => { ipcRenderer.removeListener(CH.state, h) }
  },
  result: (sessionId: string, text: string): void => ipcRenderer.send(CH.result, String(sessionId), String(text).slice(0, 20_000)),
  error: (sessionId: string, message: string): void => ipcRenderer.send(CH.error, String(sessionId), String(message).slice(0, 300)),
  action: (sessionId: string, action: DictationCapsuleAction): void => ipcRenderer.send(CH.action, String(sessionId), action),
})
