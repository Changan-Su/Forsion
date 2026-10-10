// 手机上的语音通话(2026-10-10):通话连的是云网关,通话卡和聊天区在同一个页面里。这里钉三件渲染端的事:
//   1. 令牌怎么带 —— 云网关走子协议(登录令牌不进 URL),本机引擎照旧放 query;
//   2. 通话事件在同一个窗口里也送得到(storage 事件只投给别的窗口,手机上没有「别的窗口」);
//   3. 通话条挂不挂由 openCallLayer 说了算。
import { afterEach, describe, expect, it, vi } from 'vitest'
import { realtimeSocket } from './backendService'
import { connectionTarget } from './engine/targets'
import { getCallLayer, onCallEvent, openCallLayer, postCallEvent, sendTextToCall, subscribeCallLayer, type CallEvent } from './realtimeCall'

function page(tangu: Record<string, unknown>, href: string): void {
  vi.stubGlobal('window', { tangu, addEventListener: () => {}, removeEventListener: () => {} })
  vi.stubGlobal('location', { href })
}
afterEach(() => { vi.unstubAllGlobals(); openCallLayer(null) })

describe('通话的 WebSocket:令牌怎么带', () => {
  it('手机(云网关):登录令牌走子协议、不进 URL', async () => {
    page({ mobile: true }, 'https://localhost/')
    const s = await realtimeSocket(connectionTarget({ backendUrl: 'https://forsion.net/api', token: 'login-tok' }))
    expect(s).toEqual({ url: 'wss://forsion.net/api/agent/realtime', protocols: ['forsion.bearer', 'login-tok'] })
    expect(s.url).not.toContain('login-tok')
  })
  it('同源部署的相对基址:按当前页面解析成绝对地址再换协议', async () => {
    page({ mobile: true }, 'http://192.168.1.8:8787/index.html')
    expect((await realtimeSocket(connectionTarget({ backendUrl: '/api', token: 't' }))).url).toBe('ws://192.168.1.8:8787/api/agent/realtime')
  })
  it('桌面(本机引擎):令牌放 query、不带子协议,和以前一样', async () => {
    page({}, 'http://localhost:5173/')
    expect(await realtimeSocket(connectionTarget({ backendUrl: 'http://127.0.0.1:38291', token: 'engine tok' })))
      .toEqual({ url: 'ws://127.0.0.1:38291/agent/realtime?token=engine+tok' })
  })
})

describe('通话事件:同一个窗口里也送得到', () => {
  it('本窗的监听当场收到;退订后不再收;一个监听抛错不拖累别的', () => {
    page({ mobile: true }, 'https://localhost/')
    const got: CallEvent[] = []
    const offBad = onCallEvent(() => { throw new Error('boom') })
    const off = onCallEvent((e) => got.push(e))
    postCallEvent({ kind: 'activity', sessionId: 's1' })
    expect(got).toEqual([{ kind: 'activity', sessionId: 's1' }])
    off(); offBad()
    postCallEvent({ kind: 'activity', sessionId: 's1' })
    expect(got).toHaveLength(1)
  })
  it('通话中打的字:通话那头收下并确认 → true;没人确认 → 超时回 false(调用方改走普通发送,字不丢)', async () => {
    page({ mobile: true }, 'https://localhost/')
    const heard: string[] = []
    // 通话条那一侧的做法(mini/VoiceCallView):收下就回同 id 的 text-ack
    const off = onCallEvent((e) => { if (e.kind === 'text' && e.sessionId === 's1') { heard.push(e.text); postCallEvent({ kind: 'text-ack', id: e.id }) } })
    await expect(sendTextToCall('s1', '帮我查一下明天的日程')).resolves.toBe(true)
    expect(heard).toEqual(['帮我查一下明天的日程'])
    off()
    await expect(sendTextToCall('s1', '再说一遍', 20)).resolves.toBe(false)
    expect(heard).toHaveLength(1)
  })
})

describe('手机上的通话条', () => {
  it('openCallLayer 放进参数就挂、放 null 就撤,订阅方每次都被通知', () => {
    const seen: Array<Record<string, unknown> | null> = []
    const off = subscribeCallLayer(() => seen.push(getCallLayer()))
    expect(getCallLayer()).toBeNull()
    const params = { sessionId: 's1', model: 'pr-0a1b' }
    openCallLayer(params)
    openCallLayer(null)
    off()
    openCallLayer(params)
    expect(seen).toEqual([expect.objectContaining(params), null])
  })
  it('没有在打的电话时再按一次 = 拨新的一通(dial 换号,通话条重挂;上一通报错留着的那条不会把电话键变成哑的)', () => {
    openCallLayer({ sessionId: 's1' })
    const first = getCallLayer()!.dial
    openCallLayer({ sessionId: 's1' })
    expect(getCallLayer()!.dial).not.toBe(first)
  })
})
