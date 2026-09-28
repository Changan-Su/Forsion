import { describe, expect, it } from 'vitest'
import { capsSaysReady, deviceStatus, SELECTABLE, statusFromError, STICKY_TTL_MS, type ProbeResult, type RosterUnit } from './deviceStatus'

const T0 = 1_790_000_000_000
const online = (extra: Partial<RosterUnit> = {}): RosterUnit => ({ online: true, ...extra })
const live = (engine: 'ready' | 'starting' | 'external' | 'stopped' | null): RosterUnit => online({ capsLive: true, caps: { engine, tools: [] } })
const fail = (status: number, code?: string, state?: string): ProbeResult => ({ ok: false, status, ...(code ? { code } : {}), ...(state ? { state } : {}) })

describe('deviceStatus —— K7 §3.2 表 + R-10', () => {
  it('离线压过一切(探针成功、粘滞拒绝都不看)', () => {
    expect(deviceStatus({ online: false, capsLive: true, caps: { engine: 'ready' } }, { ok: true }, { code: 'REMOTE_SESSIONS_OFF', at: T0 }, T0)).toBe('offline')
  })

  it('capsLive 时按设备自报的引擎态:external → noEngine、stopped → engineStopped、starting → starting', () => {
    expect(deviceStatus(live('external'), null, null, T0)).toBe('noEngine')
    expect(deviceStatus(live('stopped'), null, null, T0)).toBe('engineStopped')
    expect(deviceStatus(live('starting'), { ok: true }, null, T0)).toBe('starting')
  })

  it('capsLive=false 时 caps 不算数:报过 stopped 也当未知,交给探针', () => {
    const stale: RosterUnit = online({ capsLive: false, caps: { engine: 'stopped' } })
    expect(deviceStatus(stale, null, null, T0)).toBe('checking')
    expect(deviceStatus(stale, { ok: true }, null, T0)).toBe('ready')
  })

  it('引擎 ready 或未知(老桌面没 caps)由探针定:ok → ready,没探过 → checking', () => {
    expect(deviceStatus(live('ready'), { ok: true }, null, T0)).toBe('ready')
    expect(deviceStatus(live('ready'), null, null, T0)).toBe('checking')
    expect(deviceStatus(online(), { ok: true }, null, T0)).toBe('ready')
    expect(deviceStatus(online({ caps: null }), null, null, T0)).toBe('checking')
  })

  it('S3:名册自报 ready 但探针 503 ENGINE_NOT_READY → starting(不是 ready)', () => {
    expect(deviceStatus(live('ready'), fail(503, 'ENGINE_NOT_READY'), null, T0)).toBe('starting')
  })

  it('探针失败码:UNIT_OFFLINE / UNIT_DISCONNECTED → offline;UNIT_TIMEOUT、网络错、其余 5xx → unreachable', () => {
    expect(deviceStatus(online(), fail(503, 'UNIT_OFFLINE'), null, T0)).toBe('offline')
    expect(deviceStatus(online(), fail(502, 'UNIT_DISCONNECTED'), null, T0)).toBe('offline')
    expect(deviceStatus(online(), fail(504, 'UNIT_TIMEOUT'), null, T0)).toBe('unreachable')
    expect(deviceStatus(online(), fail(0), null, T0)).toBe('unreachable')
    expect(deviceStatus(online(), fail(502), null, T0)).toBe('unreachable')
  })

  it('R-10:REMOTE_CALLER_UNCONFIRMED 按 state 分 —— pending / unconfirmed → awaitingConfirm,denied → denied', () => {
    expect(deviceStatus(online(), fail(403, 'REMOTE_CALLER_UNCONFIRMED', 'pending'), null, T0)).toBe('awaitingConfirm')
    expect(deviceStatus(online(), fail(403, 'REMOTE_CALLER_UNCONFIRMED', 'unconfirmed'), null, T0)).toBe('awaitingConfirm')
    expect(deviceStatus(online(), fail(403, 'REMOTE_CALLER_UNCONFIRMED', 'denied'), null, T0)).toBe('denied')
    expect(deviceStatus(online(), fail(403, 'REMOTE_SESSIONS_OFF'), null, T0)).toBe('remoteOff')
  })

  it('粘滞拒绝 5 分钟内压过探针成功(读列表是基础档,开关关着也 200),过期即失效', () => {
    const sticky = { code: 'REMOTE_SESSIONS_OFF', at: T0 }
    expect(deviceStatus(online(), { ok: true }, sticky, T0 + 1000)).toBe('remoteOff')
    expect(deviceStatus(online(), { ok: true }, sticky, T0 + STICKY_TTL_MS - 1)).toBe('remoteOff')
    expect(deviceStatus(online(), { ok: true }, sticky, T0 + STICKY_TTL_MS)).toBe('ready')
    expect(deviceStatus(online(), null, { code: 'REMOTE_CALLER_UNCONFIRMED', state: 'pending', at: T0 }, T0)).toBe('awaitingConfirm')
    expect(deviceStatus(online(), null, { code: 'REMOTE_CALLER_UNCONFIRMED', state: 'denied', at: T0 }, T0)).toBe('denied')
  })

  it('粘滞拒绝只认拒绝类码:连不上类的码不粘(那是探针的事)', () => {
    expect(deviceStatus(online(), { ok: true }, { code: 'UNIT_TIMEOUT', at: T0 }, T0)).toBe('ready')
  })

  it('探针失败排在粘滞拒绝前面:连不上时不谈开关', () => {
    expect(deviceStatus(online(), fail(503, 'UNIT_OFFLINE'), { code: 'REMOTE_SESSIONS_OFF', at: T0 }, T0)).toBe('offline')
  })

  it('时钟回拨(at 在未来)的粘滞拒绝不算数', () => {
    expect(deviceStatus(online(), { ok: true }, { code: 'REMOTE_SESSIONS_OFF', at: T0 + 60_000 }, T0)).toBe('ready')
  })
})

describe('statusFromError', () => {
  it('K8 中继合成码与坏票码 → unreachable(手机全局状况,不给消费方未知码)', () => {
    for (const code of ['CALLER_UNAVAILABLE', 'CALLER_UNSUPPORTED', 'UNIT_CALLER_INVALID', 'UNIT_CALLER_EXPIRED']) {
      expect(statusFromError({ status: code.startsWith('CALLER') ? 503 : 403, code }), code).toBe('unreachable')
    }
  })

  it('裸网络错 / 中止 → unreachable;null 与判不出的 4xx → null', () => {
    expect(statusFromError(new TypeError('Failed to fetch'))).toBe('unreachable')
    expect(statusFromError(Object.assign(new Error('aborted'), { name: 'AbortError' }))).toBe('unreachable')
    expect(statusFromError(null)).toBeNull()
    expect(statusFromError({ status: 403, code: 'LOCAL_ONLY' })).toBeNull()
    expect(statusFromError({ status: 404 })).toBeNull()
    expect(statusFromError({ status: 413, code: 'UNIT_BODY_TOO_LARGE' })).toBeNull()
  })

  it('带码的 5xx 未知码 → unreachable', () => {
    expect(statusFromError({ status: 503, code: 'SOMETHING_NEW' })).toBe('unreachable')
  })
})

describe('SELECTABLE / capsSaysReady', () => {
  it('可选 = ready + awaitingConfirm', () => {
    expect([...SELECTABLE].sort()).toEqual(['awaitingConfirm', 'ready'])
  })

  it('capsSaysReady 只认在线 + capsLive + engine==="ready"', () => {
    expect(capsSaysReady(live('ready'))).toBe(true)
    expect(capsSaysReady({ online: false, capsLive: true, caps: { engine: 'ready' } })).toBe(false)
    expect(capsSaysReady(online({ capsLive: false, caps: { engine: 'ready' } }))).toBe(false)
    expect(capsSaysReady(live('starting'))).toBe(false)
  })
})
