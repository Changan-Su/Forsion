// 引擎目标解析层(P1-K6 S0)的契约测试:legacy 折算逐字不变、品牌、engineFetch 的出口闸、会话绑定表。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const authFetch = vi.fn(async (..._args: unknown[]) => new Response('{}', { status: 200 }))
vi.mock('../http', () => ({ authFetch: (...args: unknown[]) => authFetch(...args) }))

const T = await import('./targets')
const { isHomeSession } = await import('../../types')

const cfg = { backendUrl: 'http://127.0.0.1:4100/', token: 'engine-token', modelId: 'm' }

beforeEach(() => { authFetch.mockClear(); T.clearSessionBindings() })
afterEach(() => { vi.unstubAllGlobals() })

describe('legacy cfg → home 目标(Phase A,行为逐字不变)', () => {
  it('base 原样沿用 cfg.backendUrl(连尾斜杠都不削),鉴权头与改造前同形同序', async () => {
    const t = T.asTarget(cfg)
    expect(t.key).toBe('home')
    expect(t.ref).toEqual({ kind: 'home' })
    expect(t.base).toBe('http://127.0.0.1:4100/')
    expect(t.unitBase).toBeNull()
    const h = await t.headers(true)
    expect(Object.entries(h)).toEqual([['Content-Type', 'application/json'], ['Authorization', 'Bearer engine-token']])
    expect(await t.headers()).toEqual(h) // 缺省 = json
    expect(await t.headers(false)).toEqual({ Authorization: 'Bearer engine-token' })
  })

  it('已是目标就原样返回(不二次包装)', () => {
    const t = T.asTarget(cfg)
    expect(T.asTarget(t)).toBe(t)
  })

  it.each([
    [undefined, 'local'],
    [{ tangu: {} }, 'local'],
    [{ tangu: { cloudWeb: true } }, 'cloud'],
    [{ tangu: { cloudWeb: true, mobile: true } }, 'cloud'],
    [{ tangu: { unitPage: true } }, 'unitPage'],
    [{ tangu: { unitPage: true, cloudWeb: true } }, 'unitPage'],
  ])('来路按端现算 %j → %s', (win, via) => {
    if (win) vi.stubGlobal('window', win)
    expect(T.asTarget(cfg).via).toBe(via)
  })

  it('C1:目标的鉴权头只可能含 Authorization / Content-Type / Accept / X-Forsion-Caller', async () => {
    const allowed = new Set(['Authorization', 'Content-Type', 'Accept', 'X-Forsion-Caller'])
    for (const win of [undefined, { tangu: { cloudWeb: true } }, { tangu: { mobile: true, cloudWeb: true } }, { tangu: { unitPage: true } }]) {
      if (win) vi.stubGlobal('window', win)
      for (const json of [true, false]) {
        for (const k of Object.keys(await T.asTarget(cfg).headers(json))) expect(allowed.has(k), k).toBe(true)
      }
      vi.unstubAllGlobals()
    }
  })
})

describe('品牌(运行期)', () => {
  it('只认 mintTarget 铸出来的对象;同形的伪造品不算', () => {
    const real = T.asTarget(cfg)
    expect(T.isEngineTarget(real)).toBe(true)
    expect(T.isEngineTarget({ ...real })).toBe(false)
    expect(T.isEngineTarget(null)).toBe(false)
    expect(Object.isFrozen(real)).toBe(true)
  })

  it('铸造点也校验位置:未知 kind 铸不出目标', async () => {
    const { mintTarget } = await import('./target')
    const init = { key: 'home' as const, via: 'local' as const, base: '', unitBase: null, headers: async () => ({}) }
    expect(() => mintTarget({ ...init, ref: { kind: 'cloud' } as never })).toThrow(TypeError)
    expect(() => mintTarget({ ...init, ref: { kind: 'unit', unitId: '' } })).toThrow(TypeError)
  })
})

describe('homeTarget / knownTargets', () => {
  it('宿主装好后每次现读 appStore 的 cfg(换 token / 换端口立即生效)', async () => {
    let current = { backendUrl: 'http://127.0.0.1:1', token: 'a', modelId: '' }
    T.installEngineHost({ cfg: () => current, desktopConfig: () => null })
    expect(T.homeTarget().base).toBe('http://127.0.0.1:1')
    current = { backendUrl: 'http://127.0.0.1:2', token: 'b', modelId: '' }
    const t = T.homeTarget()
    expect(t.base).toBe('http://127.0.0.1:2')
    expect((await t.headers()).Authorization).toBe('Bearer b')
  })

  it('S0 只有 home 一个已知目标', () => {
    T.installEngineHost({ cfg: () => cfg, desktopConfig: () => null })
    const all = T.knownTargets()
    expect(all.map((t) => t.key)).toEqual(['home'])
    expect(T.isEngineTarget(all[0])).toBe(true)
  })
})

describe('engineFetch 出口闸', () => {
  it('拼 base+path,带目标的鉴权头;GET 不带 Content-Type;timeoutMs 透传', async () => {
    const t = T.asTarget({ backendUrl: 'http://127.0.0.1:9', token: 'tk', modelId: '' })
    await T.engineFetch(t, '/agent/approvals/pending?rev=3', {}, { timeoutMs: 5000 })
    const [url, init, opts] = authFetch.mock.calls[0] as [string, RequestInit, unknown]
    expect(url).toBe('http://127.0.0.1:9/agent/approvals/pending?rev=3')
    expect(init.headers).toEqual({ Authorization: 'Bearer tk' })
    expect(opts).toEqual({ timeoutMs: 5000 })
  })

  it('字符串 body → 带 JSON Content-Type;不传超时 = 不设超时', async () => {
    await T.engineFetch(T.asTarget(cfg), '/agent/x', { method: 'POST', body: '{}' })
    const [, init, opts] = authFetch.mock.calls[0] as [string, RequestInit, unknown]
    expect(init.headers).toEqual({ 'Content-Type': 'application/json', Authorization: 'Bearer engine-token' })
    expect(opts).toBeUndefined()
  })

  it('C1:调用方的 Authorization 与 x-forsion-remote* 一律丢弃,只放行 Content-Type / Accept', async () => {
    await T.engineFetch(T.asTarget(cfg), '/agent/approvals/stream', {
      headers: {
        Authorization: 'Bearer stolen', 'x-forsion-remote': '1', 'X-Forsion-Remote-Caller': 'abc',
        'X-Unit-Caller': 'v1.x.y', Accept: 'text/event-stream', 'content-type': 'text/plain',
      },
    })
    const [, init] = authFetch.mock.calls[0] as [string, RequestInit]
    expect(init.headers).toEqual({ Authorization: 'Bearer engine-token', Accept: 'text/event-stream', 'Content-Type': 'text/plain' })
  })

  const UNIT_SHAPED = 'https://forsion.test/api/units/u1/proxy/engine'
  it.each([
    ['http://127.0.0.1:4100/', '//evil.test/agent/x'],
    ['http://127.0.0.1:4100/', 'https://evil.test/agent/x'],
    ['http://127.0.0.1:4100/', 'agent/x'],
    ['http://127.0.0.1:4100/', '/\\evil.test'],
    ['http://127.0.0.1:4100/', '/agent/x?next=http://evil.test'],
    ['http://127.0.0.1:4100/', ''],
    // WHATWG URL 解析器静默剥掉 tab / CR / LF:'/\t/evil.test' 解析成 //evil.test(base 为空时 Bearer 外泄,评审实测)
    ['', '/\t/evil.test/agent/x'],
    ['', '/\n/evil.test'],
    ['', '/\r/evil.test'],
    ['', '/\t\t/evil.test'],
    ['', '/ /evil.test'],
    ['', '/\u0000/evil.test'],
    ['', '/agent/x\u007f'],
    // 点段逃出基址路径:同源,但已经落在云端别的接口上(unit 目标的 Bearer = forsion_token)
    [UNIT_SHAPED, '/../../../../auth/x'],
    [UNIT_SHAPED, '/%2e%2e/%2e%2e/%2e%2e/%2e%2e/auth/x'],
    [UNIT_SHAPED, '/agent/../../../../u2/proxy/engine/agent/x'], // → /api/units/u2/proxy/engine/…(另一台电脑)
  ])(
    'base %j 下拒发 %j(解析后必须仍落在目标基址之下,否则 Bearer 会被送到别的主机 / 接口)',
    async (backendUrl, path) => {
      await expect(T.engineFetch(T.asTarget({ backendUrl, token: 'tk', modelId: '' }), path)).rejects.toThrow(TypeError)
      expect(authFetch).not.toHaveBeenCalled()
    },
  )

  it.each([
    ['', '/agent/x', '/agent/x'],
    ['http://127.0.0.1:4100/', '/agent/x', 'http://127.0.0.1:4100//agent/x'], // legacy 尾斜杠原样(行为逐字不变)
    [UNIT_SHAPED, '/agent/sessions?q=a/../b', `${UNIT_SHAPED}/agent/sessions?q=a/../b`], // 查询串里的点段不算
    [UNIT_SHAPED, '/agent/./x', `${UNIT_SHAPED}/agent/./x`], // 不出基址的点段照发(URL 原样交给 authFetch)
    [UNIT_SHAPED, '/', `${UNIT_SHAPED}/`],
  ])('base %j + %j 照发 → %j', async (backendUrl, path, want) => {
    await T.engineFetch(T.asTarget({ backendUrl, token: 'tk', modelId: '' }), path)
    expect(authFetch.mock.calls[0][0]).toBe(want)
  })

  it('伪造的目标拒发', async () => {
    const forged = { ...T.asTarget(cfg) } as unknown as Parameters<typeof T.engineFetch>[0]
    await expect(T.engineFetch(forged, '/agent/x')).rejects.toThrow(/not minted/)
    expect(authFetch).not.toHaveBeenCalled()
  })

  it('生成的 URL 永不带 token=(凭据只走头)', async () => {
    await T.engineFetch(T.asTarget(cfg), '/agent/sessions')
    expect(String(authFetch.mock.calls[0][0])).not.toMatch(/token=/)
  })
})

describe('会话绑定表(R-15 / R-16)', () => {
  const unitA = { kind: 'unit', unitId: '7f0e8a52-0000-4000-8000-00000000000a' } as const
  const unitB = { kind: 'unit', unitId: '7f0e8a52-0000-4000-8000-00000000000b' } as const

  it('未绑 = home;withLocation 从绑定表派生标签', () => {
    expect(T.locationOf('s1')).toEqual({ kind: 'home' })
    expect(T.withLocation({ id: 's1', title: 't' })).toEqual({ id: 's1', title: 't', location: { kind: 'home' } })
    expect(T.bindSession('s1', unitA)).toBe('bound')
    expect(T.withLocation({ id: 's1' }).location).toEqual(unitA)
  })

  it('先到先得、永不改绑:撞 id 的第二个位置得 conflict,路由不被劫持', () => {
    expect(T.bindSession('s1', unitA)).toBe('bound')
    expect(T.bindSession('s1', unitA)).toBe('bound') // 同一处幂等
    expect(T.bindSession('s1', unitB)).toBe('conflict')
    expect(T.bindSession('s1', { kind: 'home' })).toBe('conflict')
    expect(T.locationOf('s1')).toEqual(unitA)
  })

  it('home 也是一次绑定:之后 unit 自报同 id 同样 conflict', () => {
    expect(T.bindSession('s2', { kind: 'home' })).toBe('bound')
    expect(T.bindSession('s2', unitA)).toBe('conflict')
    expect(T.locationOf('s2')).toEqual({ kind: 'home' })
  })

  it('forgetSession 之后才能绑到别处;clearSessionBindings 全清', () => {
    T.bindSession('s3', unitA)
    T.forgetSession('s3')
    expect(T.locationOf('s3')).toEqual({ kind: 'home' })
    expect(T.bindSession('s3', unitB)).toBe('bound')
    T.clearSessionBindings()
    expect(T.locationOf('s3')).toEqual({ kind: 'home' })
  })

  it('空会话 id / 空 unit id 直接抛', () => {
    expect(() => T.bindSession('', unitA)).toThrow(TypeError)
    expect(() => T.bindSession('s4', { kind: 'unit', unitId: '' })).toThrow(TypeError)
  })

  it('未知 kind(旧形状 {kind:"cloud"} / 坏掉的持久化提示)抛,绝不落成 unit:undefined 占住会话', () => {
    // 评审复现序列:不校验时 → 'bound',locationOf = {kind:'unit',unitId:'undefined'},之后正确的 home 绑定 = 'conflict'
    expect(() => T.bindSession('s5', { kind: 'cloud' } as never)).toThrow(TypeError)
    expect(T.locationOf('s5')).toEqual({ kind: 'home' })
    expect(T.bindSession('s5', { kind: 'home' })).toBe('bound')
    for (const bad of [null, undefined, {}, { kind: 'unit' }, { kind: 'unit', unitId: 42 }, { kind: 'Home' }, 'home']) {
      expect(() => T.bindSession('s6', bad as never), JSON.stringify(bad)).toThrow(TypeError)
    }
    expect(T.locationOf('s6')).toEqual({ kind: 'home' })
  })

  it('targetKeyOf 穷举、sameRef 不把未知 kind 当相等、isTargetKey 只认 home 与 unit:<非空>', () => {
    expect(T.targetKeyOf({ kind: 'home' })).toBe('home')
    expect(T.targetKeyOf(unitA)).toBe(`unit:${unitA.unitId}`)
    expect(() => T.targetKeyOf({ kind: 'cloud' } as never)).toThrow(TypeError)
    expect(() => T.targetKeyOf({ kind: 'unit' } as never)).toThrow(TypeError)
    expect(T.sameRef({ kind: 'cloud' } as never, { kind: 'cloud' } as never)).toBe(false)
    expect(T.sameRef({ kind: 'unit' } as never, { kind: 'unit' } as never)).toBe(false)
    expect(T.sameRef(unitA, { ...unitA })).toBe(true)
    expect(T.sameRef(unitA, unitB)).toBe(false)
    expect(T.sameRef({ kind: 'home' }, { kind: 'home' })).toBe(true)
    expect(T.sameRef(null as never, null as never)).toBe(false)
    for (const k of ['home', 'unit:a']) expect(T.isTargetKey(k), k).toBe(true)
    for (const k of ['unit:', 'cloud', 'unit', '', null, 1, 'Home']) expect(T.isTargetKey(k), String(k)).toBe(false)
  })

  it('isHomeSession:未打标 / home = true,unit = false', () => {
    expect(isHomeSession({})).toBe(true)
    expect(isHomeSession({ location: { kind: 'home' } })).toBe(true)
    expect(isHomeSession({ location: unitA })).toBe(false)
    expect(T.isHomeSession).toBe(isHomeSession)
  })
})
