// 手机通话切后台(2026-11-02):宿主起好了保活(安卓 microphone 前台服务)就接着打,没起成照旧挂断;挂断时撤保活。
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('./backendService', () => ({ realtimeSocket: async () => ({ url: 'wss://x/realtime' }) }))
vi.mock('./callVoice', () => ({ CALL_VOICE_BEAT_MS: 1000, CALL_VOICE_TICK_MS: 1000, postCallVoice: () => {} }))

import { CALL_ENDED_BACKGROUND, endCall, getCall, getCallError, setCallKeepHost, startCall } from './realtimeCall'

const node = (): any => ({ connect() {}, disconnect() {} })
function phone(): { hide(): void } {
  const docListeners = new Map<string, () => void>()
  const doc = { hidden: false, addEventListener: (k: string, f: () => void) => docListeners.set(k, f), removeEventListener: (k: string) => docListeners.delete(k) }
  vi.stubGlobal('document', doc)
  vi.stubGlobal('window', { tangu: { mobile: true }, addEventListener() {}, removeEventListener() {}, setInterval: () => 0, clearInterval() {}, setTimeout })
  vi.stubGlobal('navigator', { mediaDevices: { getUserMedia: async () => ({ getTracks: () => [] }) } })
  vi.stubGlobal('AudioContext', class { destination = {}; createAnalyser = () => ({ ...node(), fftSize: 32 }); close = async () => {} })
  vi.stubGlobal('WebSocket', Object.assign(class { readyState = 0; close() {} }, { OPEN: 1 }))
  return { hide: () => { doc.hidden = true; docListeners.get('visibilitychange')?.() } }
}
const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0))
const opts = { sessionId: 's1', model: 'm', title: 't', target: {} as any, run: {} as any }

afterEach(() => { endCall(); setCallKeepHost(null); vi.unstubAllGlobals() })

describe('手机通话切后台', () => {
  it('保活起成:切走不挂断,挂断时撤保活', async () => {
    const p = phone()
    const keep = { start: vi.fn(async () => true), stop: vi.fn() }
    setCallKeepHost(keep)
    await startCall(opts)
    await flush()
    expect(keep.start).toHaveBeenCalledOnce()
    p.hide()
    expect(getCall()).not.toBeNull()
    endCall()
    expect(keep.stop).toHaveBeenCalledOnce()
  })

  it('保活没起成:切走即挂断', async () => {
    const p = phone()
    const keep = { start: vi.fn(async () => false), stop: vi.fn() }
    setCallKeepHost(keep)
    await startCall(opts)
    await flush()
    p.hide()
    expect(getCall()).toBeNull()
    expect(getCallError()).toBe(CALL_ENDED_BACKGROUND)
    expect(keep.stop).not.toHaveBeenCalled()
  })
})

describe('保活回执晚到', () => {
  it('A 起保活未回执就挂断,B 没来得及起保活也结束:A 的回执撤掉保活', async () => {
    phone()
    let resolveA!: (ok: boolean) => void
    const keep = { start: vi.fn(() => new Promise<boolean>((r) => { resolveA = r })), stop: vi.fn() }
    setCallKeepHost(keep)
    await startCall(opts)
    endCall()
    vi.stubGlobal('navigator', { mediaDevices: { getUserMedia: () => new Promise(() => {}) } }) // B 卡在要麦克风
    void startCall({ ...opts, sessionId: 's2' })
    resolveA(true)
    await flush()
    expect(keep.stop).toHaveBeenCalledOnce()
  })

  it('B 已经起了保活:A 的晚到回执不许撤掉 B 的', async () => {
    phone()
    const resolvers: ((ok: boolean) => void)[] = []
    const keep = { start: vi.fn(() => new Promise<boolean>((r) => { resolvers.push(r) })), stop: vi.fn() }
    setCallKeepHost(keep)
    await startCall(opts)
    endCall()
    await startCall({ ...opts, sessionId: 's2' })
    resolvers[0](true)
    await flush()
    expect(keep.stop).not.toHaveBeenCalled()
  })
})
