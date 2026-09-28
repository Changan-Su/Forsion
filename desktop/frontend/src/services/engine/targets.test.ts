// 引擎目标解析层(P1-K6 S0)的契约测试:legacy 折算逐字不变、品牌、engineFetch 的出口闸、会话绑定表。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const authFetch = vi.fn(async (..._args: unknown[]) => new Response('{}', { status: 200 }))
vi.mock('../http', () => ({ authFetch: (...args: unknown[]) => authFetch(...args) }))

const T = await import('./targets')
const { isHomeSession } = await import('../../types')

const cfg = { backendUrl: 'http://127.0.0.1:4100/', token: 'engine-token', modelId: 'm' }

beforeEach(() => { authFetch.mockClear(); T.clearSessionBindings(); T.resetFocusForTests() })
afterEach(() => { vi.unstubAllGlobals() })

describe('connectionTarget:显式连接 → home 键目标(与改造前的 headers(cfg.token) 逐字同形)', () => {
  it('base 原样沿用 cfg.backendUrl(连尾斜杠都不削),鉴权头与改造前同形同序', async () => {
    const t = T.connectionTarget(cfg)
    expect(t.key).toBe('home')
    expect(t.ref).toEqual({ kind: 'home' })
    expect(t.base).toBe('http://127.0.0.1:4100/')
    expect(t.unitBase).toBeNull()
    const h = await t.headers(true)
    expect(Object.entries(h)).toEqual([['Content-Type', 'application/json'], ['Authorization', 'Bearer engine-token']])
    expect(await t.headers()).toEqual(h) // 缺省 = json
    expect(await t.headers(false)).toEqual({ Authorization: 'Bearer engine-token' })
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
    expect(T.connectionTarget(cfg).via).toBe(via)
  })

  it('C1:目标的鉴权头只可能含 Authorization / Content-Type / Accept / X-Forsion-Caller', async () => {
    const allowed = new Set(['Authorization', 'Content-Type', 'Accept', 'X-Forsion-Caller'])
    for (const win of [undefined, { tangu: { cloudWeb: true } }, { tangu: { mobile: true, cloudWeb: true } }, { tangu: { unitPage: true } }]) {
      if (win) vi.stubGlobal('window', win)
      for (const json of [true, false]) {
        for (const k of Object.keys(await T.connectionTarget(cfg).headers(json))) expect(allowed.has(k), k).toBe(true)
      }
      vi.unstubAllGlobals()
    }
  })
})

describe('品牌(运行期)', () => {
  it('只认 mintTarget 铸出来的对象;同形的伪造品不算', () => {
    const real = T.connectionTarget(cfg)
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

  it('活目标:持有的 knownTargets()[0] 跨引擎重启(换端口 / 换 token)照样打新地址、带新 token', async () => {
    let current = { backendUrl: 'http://127.0.0.1:1', token: 'old', modelId: '' }
    T.installEngineHost({ cfg: () => current, desktopConfig: () => null })
    const held = T.knownTargets()[0]
    await T.engineFetch(held, '/agent/approvals/pending')
    current = { backendUrl: 'http://127.0.0.1:2', token: 'new', modelId: '' } // managed 引擎重启:新端口 + 新 token
    await T.engineFetch(held, '/agent/approvals/pending')
    expect(authFetch.mock.calls.map((c) => [c[0], (c[1] as RequestInit).headers])).toEqual([
      ['http://127.0.0.1:1/agent/approvals/pending', { Authorization: 'Bearer old' }],
      ['http://127.0.0.1:2/agent/approvals/pending', { Authorization: 'Bearer new' }],
    ])
    expect(T.homeTarget()).toBe(held) // 恒为同一个对象(消费方可以按对象身份做键)
    // 重装宿主(测试 / 未来的宿主热换)也跟上;来路同样现算
    T.installEngineHost({ cfg: () => ({ backendUrl: 'https://forsion.test/api', token: 'c', modelId: '' }), desktopConfig: () => null })
    expect(held.base).toBe('https://forsion.test/api')
    expect((await held.headers(false))).toEqual({ Authorization: 'Bearer c' })
    vi.stubGlobal('window', { tangu: { cloudWeb: true } })
    expect(held.via).toBe('cloud')
    // 活目标照样冻结、照样是登记过的真目标;展开出来的快照不是
    expect(Object.isFrozen(held)).toBe(true)
    expect(() => { (held as { base: string }).base = 'http://evil.test' }).toThrow(TypeError)
    expect(T.isEngineTarget(held)).toBe(true)
    expect(T.isEngineTarget({ ...held })).toBe(false)
  })

  it('焦点在 home 时只有 home 一个已知目标(S2 起焦点在 unit 时再加上它,见下)', () => {
    T.installEngineHost({ cfg: () => cfg, desktopConfig: () => null })
    const all = T.knownTargets()
    expect(all.map((t) => t.key)).toEqual(['home'])
    expect(T.isEngineTarget(all[0])).toBe(true)
  })
})

describe('engineFetch 出口闸', () => {
  it('拼 base+path,带目标的鉴权头;GET 不带 Content-Type;timeoutMs 透传', async () => {
    const t = T.connectionTarget({ backendUrl: 'http://127.0.0.1:9', token: 'tk', modelId: '' })
    await T.engineFetch(t, '/agent/approvals/pending?rev=3', {}, { timeoutMs: 5000 })
    const [url, init, opts] = authFetch.mock.calls[0] as [string, RequestInit, unknown]
    expect(url).toBe('http://127.0.0.1:9/agent/approvals/pending?rev=3')
    expect(init.headers).toEqual({ Authorization: 'Bearer tk' })
    expect(opts).toEqual({ timeoutMs: 5000 })
  })

  it('字符串 body → 带 JSON Content-Type;不传超时 = 不设超时', async () => {
    await T.engineFetch(T.connectionTarget(cfg), '/agent/x', { method: 'POST', body: '{}' })
    const [, init, opts] = authFetch.mock.calls[0] as [string, RequestInit, unknown]
    expect(init.headers).toEqual({ 'Content-Type': 'application/json', Authorization: 'Bearer engine-token' })
    expect(opts).toBeUndefined()
  })

  it('C1:调用方的 Authorization 与 x-forsion-remote* 一律丢弃,只放行 Content-Type / Accept', async () => {
    await T.engineFetch(T.connectionTarget(cfg), '/agent/approvals/stream', {
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
      await expect(T.engineFetch(T.connectionTarget({ backendUrl, token: 'tk', modelId: '' }), path)).rejects.toThrow(TypeError)
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
    await T.engineFetch(T.connectionTarget({ backendUrl, token: 'tk', modelId: '' }), path)
    expect(authFetch.mock.calls[0][0]).toBe(want)
  })

  it('伪造的目标拒发', async () => {
    const forged = { ...T.connectionTarget(cfg) } as unknown as Parameters<typeof T.engineFetch>[0]
    await expect(T.engineFetch(forged, '/agent/x')).rejects.toThrow(/not minted/)
    expect(authFetch).not.toHaveBeenCalled()
  })

  it('生成的 URL 永不带 token=(凭据只走头)', async () => {
    await T.engineFetch(T.connectionTarget(cfg), '/agent/sessions')
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

// ═══ S2:unit 目标 + 焦点 ═══
describe('S2 · unit 目标与焦点', () => {
  const U = '7f0e8a52-0000-4000-8000-00000000000a'
  const API = 'https://api.forsion.test/api'
  const b64 = (o: object): string => Buffer.from(JSON.stringify(o)).toString('base64').replace(/=+$/, '')
  const JWT = `${b64({ alg: 'none' })}.${b64({ userId: 'u-42' })}.sig`
  const store = new Map<string, string>()
  const phone = (tangu: Record<string, unknown> = {}, token = JWT): void => {
    vi.stubGlobal('window', { tangu: { mobile: true, ...tangu } })
    vi.stubGlobal('localStorage', {
      getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
      setItem: (k: string, v: string) => { store.set(k, String(v)) },
      removeItem: (k: string) => { store.delete(k) },
    })
    T.installEngineHost({ cfg: () => ({ backendUrl: API, token, modelId: '' }), desktopConfig: () => ({ cloudApiBase: API }) })
  }
  beforeEach(() => { store.clear() })

  it('unit 目标 = {cloudApiBase}/units/<id>/proxy/engine;辅助面基址 …/proxy;同一台恒为同一个对象', async () => {
    phone()
    const t = T.targetForRef({ kind: 'unit', unitId: U })!
    expect(t.key).toBe(`unit:${U}`)
    expect(t.via).toBe('unit')
    expect(t.base).toBe(`${API}/units/${U}/proxy/engine`)
    expect(t.unitBase).toBe(`${API}/units/${U}/proxy`)
    expect(T.targetForRef({ kind: 'unit', unitId: U.toUpperCase() })).toBe(t) // 大小写归一
    expect(await t.headers(true)).toEqual({ 'Content-Type': 'application/json', Authorization: `Bearer ${JWT}` })
    expect(await t.headers(false)).toEqual({ Authorization: `Bearer ${JWT}` })
  })

  it.each([
    ['桌面主窗口(K6 U1:渲染层不持 forsion_token)', {}],
    ['设备页(§4.7:不得经 A 再驱动 B)', { unitPage: true, cloudWeb: true }],
  ])('%s → targetForRef(unit) === null', (_label, tangu) => {
    vi.stubGlobal('window', { tangu })
    T.installEngineHost({ cfg: () => ({ backendUrl: API, token: JWT, modelId: '' }), desktopConfig: () => ({ cloudApiBase: API }) })
    expect(T.remoteTargetsSupported()).toBe(false)
    expect(T.targetForRef({ kind: 'unit', unitId: U })).toBeNull()
  })

  it('没登录 / 没云端基址 / id 不是 uuid → null(绝不回落 home 静默发出去)', () => {
    phone({}, '')
    expect(T.targetForRef({ kind: 'unit', unitId: U })).toBeNull()
    phone()
    T.installEngineHost({ cfg: () => ({ backendUrl: API, token: JWT, modelId: '' }), desktopConfig: () => null })
    expect(T.targetForRef({ kind: 'unit', unitId: U })).toBeNull()
    phone()
    for (const bad of ['u1', '../x', `${U}/../x`, 'a'.repeat(36)]) expect(T.targetForRef({ kind: 'unit', unitId: bad }), bad).toBeNull()
    expect(() => T.targetForRef({ kind: 'cloud' } as never)).toThrow(TypeError)
  })

  it('网页版(cloudWeb)同样支持远端目标', () => {
    vi.stubGlobal('window', { tangu: { cloudWeb: true } })
    T.installEngineHost({ cfg: () => ({ backendUrl: API, token: JWT, modelId: '' }), desktopConfig: () => ({ cloudApiBase: API }) })
    expect(T.targetForRef({ kind: 'unit', unitId: U })?.base).toBe(`${API}/units/${U}/proxy/engine`)
  })

  it('C1:unit 目标的头只可能含 Authorization / Content-Type / X-Forsion-Caller;调用方头每请求现取', async () => {
    let n = 0
    phone({ unitCallerHeaders: async (id: string) => ({ 'X-Forsion-Caller': `fuc1.${id}.${++n}`, 'x-forsion-remote': '1', Authorization: 'Bearer evil', 'X-Other': 'y' }) })
    const t = T.targetForRef({ kind: 'unit', unitId: U })!
    const a = await t.headers(true)
    const b = await t.headers(true)
    expect(Object.keys(a).sort()).toEqual(['Authorization', 'Content-Type', 'X-Forsion-Caller'])
    expect(a.Authorization).toBe(`Bearer ${JWT}`)
    expect(a['X-Forsion-Caller']).toBe(`fuc1.${U}.1`)
    expect(b['X-Forsion-Caller']).toBe(`fuc1.${U}.2`) // 轮换的 caller token 不缓存
  })

  it('桥抛错 → 失败关闭(CALLER_UNAVAILABLE),不带头也不发', async () => {
    phone({ unitCallerHeaders: async () => { throw new Error('keystore locked') } })
    const t = T.targetForRef({ kind: 'unit', unitId: U })!
    await expect(t.headers()).rejects.toMatchObject({ code: 'CALLER_UNAVAILABLE', status: 503 })
    await expect(T.engineFetch(t, '/agent/sessions')).rejects.toMatchObject({ code: 'CALLER_UNAVAILABLE' })
    expect(authFetch).not.toHaveBeenCalled()
  })

  // 评审 F4:桥装了(K8 桥模式)却给不出一个有效的 X-Forsion-Caller —— 原先照发只带 Bearer 的请求,
  // 已登记的手机被静默降级成「账号级未识别调用方」,绕开那台电脑按调用方的信任 / 确认。缺席(没装桥)才是「不带头」。
  it.each([
    ['空对象(原生层还没登记完)', async () => ({})],
    ['null', async () => null],
    ['非对象', async () => 'fuc1.x.y'],
    ['空串', async () => ({ 'X-Forsion-Caller': '' })],
    ['错键', async () => ({ 'X-Caller': 'fuc1.x.y' })],
    ['值带换行(头注入)', async () => ({ 'X-Forsion-Caller': 'a\r\nX-Evil: 1' })],
  ])('桥给不出有效调用方头(%s)→ 同样失败关闭,绝不降级成匿名', async (_label, bridge) => {
    phone({ unitCallerHeaders: bridge })
    const t = T.targetForRef({ kind: 'unit', unitId: U })!
    await expect(t.headers()).rejects.toMatchObject({ code: 'CALLER_UNAVAILABLE', status: 503 })
    await expect(T.engineFetch(t, '/agent/sessions')).rejects.toMatchObject({ code: 'CALLER_UNAVAILABLE' })
    expect(authFetch).not.toHaveBeenCalled()
  })

  it('engineFetch 对 unit 目标带目标键(401 分流),home 的第三参与改造前一致', async () => {
    phone()
    const t = T.targetForRef({ kind: 'unit', unitId: U })!
    await T.engineFetch(t, '/agent/sessions')
    await T.engineFetch(t, '/agent/sessions', {}, { timeoutMs: 5000 })
    await T.engineFetch(T.homeTarget(), '/agent/sessions')
    expect(authFetch.mock.calls.map((c) => c[2])).toEqual([{ target: `unit:${U}` }, { timeoutMs: 5000, target: `unit:${U}` }, undefined])
  })

  it('unitFetch:只许设备辅助面的四条只读路径、只带 Bearer(不带调用方头);/unit/mcp 永不经它发', async () => {
    phone({ unitCallerHeaders: async () => ({ 'X-Forsion-Caller': 'fuc1.x.y' }) })
    const t = T.targetForRef({ kind: 'unit', unitId: U })!
    await T.unitFetch(t, '/unit/hostfile?path=%2Ftmp%2Fa.png')
    const [url, init] = authFetch.mock.calls[0] as [string, RequestInit]
    expect(url).toBe(`${API}/units/${U}/proxy/unit/hostfile?path=%2Ftmp%2Fa.png`)
    expect(init.headers).toEqual({ Authorization: `Bearer ${JWT}` })
    for (const bad of ['/unit/mcp', '/unit/mcp/x', '/unit/remote-access', '/unit/hostfile/../mcp', '/engine/agent/x', '/unit/config/../../engine']) {
      await expect(T.unitFetch(t, bad), bad).rejects.toThrow(TypeError)
    }
    await expect(T.unitFetch(T.homeTarget(), '/unit/hostfile?path=a')).rejects.toThrow(TypeError)
  })

  it('setFocusTarget:校验 → 焦点 / 已知目标跟着变(会话目标不跟:S4 = 绑定 ?? home);按账号落盘,restoreFocus 读回', async () => {
    phone()
    const refocus = vi.fn(async () => {})
    T.installEngineHost({ cfg: () => ({ backendUrl: API, token: JWT, modelId: '' }), desktopConfig: () => ({ cloudApiBase: API }), refocus })
    const seen: string[] = []
    const off = T.onFocusChange((next, prev) => seen.push(`${prev.kind}->${next.kind}`))
    await T.setFocusTarget({ kind: 'unit', unitId: U }, { name: '  Mac mini  ' })
    expect(T.focusRef()).toEqual({ kind: 'unit', unitId: U })
    expect(T.focusName()).toBe('Mac mini')
    expect(T.focusTarget().key).toBe(`unit:${U}`)
    expect(T.targetForSession('any-session').key).toBe('home') // S4(R-19):没绑过的会话永不回落焦点
    expect(T.knownTargets().map((t) => t.key)).toEqual(['home', `unit:${U}`])
    expect(refocus).toHaveBeenCalledTimes(1)
    await T.setFocusTarget({ kind: 'unit', unitId: U }) // 同一处幂等:不再 refocus
    expect(refocus).toHaveBeenCalledTimes(1)
    const key = [...store.keys()].find((k) => k.startsWith('forsion_engine_focus:'))!
    expect(key).toContain('u-42')
    expect(JSON.parse(store.get(key)!)).toEqual({ kind: 'unit', unitId: U, name: 'Mac mini' })
    // 模拟重启:内存态丢了,从落盘恢复
    T.resetFocusForTests()
    expect(T.restoreFocus()).toEqual({ kind: 'unit', unitId: U })
    expect(T.focusName()).toBe('Mac mini')
    await T.setFocusTarget({ kind: 'home' })
    expect(store.has(key)).toBe(false)
    expect(T.knownTargets().map((t) => t.key)).toEqual(['home'])
    expect(seen).toEqual(['home->unit', 'unit->home'])
    off()
  })

  it('setFocusTarget 拒绝:未知 kind 抛 TypeError;这端不支持 / id 形状不对 → TARGET_UNSUPPORTED,焦点不动', async () => {
    phone()
    await expect(T.setFocusTarget({ kind: 'cloud' } as never)).rejects.toThrow(TypeError)
    await expect(T.setFocusTarget({ kind: 'unit', unitId: 'u1' })).rejects.toMatchObject({ code: 'TARGET_UNSUPPORTED' })
    vi.stubGlobal('window', { tangu: {} })
    await expect(T.setFocusTarget({ kind: 'unit', unitId: U })).rejects.toMatchObject({ code: 'TARGET_UNSUPPORTED' })
    expect(T.focusRef()).toEqual({ kind: 'home' })
  })

  it('持久化的焦点只是提示:坏形状 / 换到桌面 / 别的账号 → 一律 home', () => {
    phone()
    const key = `forsion_engine_focus:${new URL(API).origin}/api::u-42`
    for (const bad of ['{', 'null', '{"kind":"cloud"}', '{"kind":"unit"}', '{"kind":"unit","unitId":"u1"}', '{"kind":"unit","unitId":42}']) {
      store.set(key, bad)
      expect(T.restoreFocus(), bad).toEqual({ kind: 'home' })
    }
    store.set(key, JSON.stringify({ kind: 'unit', unitId: U }))
    expect(T.restoreFocus()).toEqual({ kind: 'unit', unitId: U })
    // 同一份落盘,换一个账号读 → 读不到
    phone({}, `${b64({ alg: 'none' })}.${b64({ userId: 'someone-else' })}.sig`)
    expect(T.restoreFocus()).toEqual({ kind: 'home' })
    // 桌面读同一个键也不认(不支持远端目标)
    phone()
    vi.stubGlobal('window', { tangu: {} })
    expect(T.restoreFocus()).toEqual({ kind: 'home' })
  })

  // ═══ S4:按会话绑定 ═══
  const U2 = '7f0e8a52-0000-4000-8000-00000000000b'
  const bindingsKey = `forsion_session_targets:${new URL(API).origin}/api::u-42`

  it('S4 · targetForSession = 绑定 ?? home,永不回落焦点(R-19);knownTargets = home + 焦点 + 有绑定会话的 unit(R-20)', async () => {
    phone()
    T.clearSessionBindings()
    await T.setFocusTarget({ kind: 'unit', unitId: U })
    expect(T.targetForSession('unbound').key).toBe('home')
    expect(T.refForSession('unbound')).toEqual({ kind: 'home' })
    expect(T.bindSession('on-a', { kind: 'unit', unitId: U })).toBe('bound')
    expect(T.targetForSession('on-a')).toBe(T.targetForRef({ kind: 'unit', unitId: U }))
    // 焦点换到另一台:绑在 A 上的会话仍打 A;焦点是 B,B 也进已知目标
    await T.setFocusTarget({ kind: 'unit', unitId: U2 })
    expect(T.targetForSession('on-a').key).toBe(`unit:${U}`)
    expect(T.knownTargets().map((t) => t.key)).toEqual(['home', `unit:${U2}`, `unit:${U}`])
    // 焦点回本端:A 仍因有绑定会话而是已知目标;忘掉那条会话之后才不是
    await T.setFocusTarget({ kind: 'home' })
    expect(T.targetForSession('on-a').key).toBe(`unit:${U}`)
    expect(T.knownTargets().map((t) => t.key)).toEqual(['home', `unit:${U}`])
    T.forgetSession('on-a')
    expect(T.knownTargets().map((t) => t.key)).toEqual(['home'])
    expect(T.targetForSession('on-a').key).toBe('home')
  })

  it('S4 · inheritBinding:子会话跟父会话走;父在本端 → 子不必绑;子已绑到别处 → conflict', () => {
    phone()
    T.clearSessionBindings()
    T.bindSession('parent', { kind: 'unit', unitId: U })
    expect(T.inheritBinding('child', 'parent')).toBe('bound')
    expect(T.locationOf('child')).toEqual({ kind: 'unit', unitId: U })
    expect(T.inheritBinding('home-child', 'home-parent')).toBe('bound')
    expect(T.locationOf('home-child')).toEqual({ kind: 'home' })
    T.bindSession('squatter', { kind: 'unit', unitId: U2 })
    expect(T.inheritBinding('squatter', 'parent')).toBe('conflict')
    expect(T.inheritBinding('squatter', 'home-parent')).toBe('conflict')
    expect(T.locationOf('squatter')).toEqual({ kind: 'unit', unitId: U2 })
  })

  // 评审(K6-S4 P1):本端列出来的会话缺省即 home、从不进绑定表 —— 只看绑定表的撞 id 闸对它们形同虚设。
  it('S4 · 宿主认得的本端会话(从没绑过)往 unit 绑 → conflict,不写表、不落盘;子会话行撞上它就丢;宿主不认得的照常绑', () => {
    phone()
    const homeIds = new Set(['listed'])
    T.installEngineHost({ cfg: () => ({ backendUrl: API, token: JWT, modelId: '' }), desktopConfig: () => ({ cloudApiBase: API }), isHomeSession: (sid) => homeIds.has(sid) })
    T.clearSessionBindings()
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    expect(T.bindSession('listed', { kind: 'unit', unitId: U })).toBe('conflict')
    expect(T.locationOf('listed')).toEqual({ kind: 'home' })
    expect(store.has(bindingsKey)).toBe(false)
    expect(T.bindSession('listed', { kind: 'home' })).toBe('bound') // 往本端绑照旧幂等
    expect(T.bindSession('fresh', { kind: 'unit', unitId: U })).toBe('bound')
    homeIds.add('fresh') // 已经绑在那台的,宿主后来也列出它 → 这道问询不改它(改不改由 yieldToHomeListing 决定)
    expect(T.bindSession('fresh', { kind: 'unit', unitId: U })).toBe('bound')
    T.bindSession('parent', { kind: 'unit', unitId: U })
    const rows = [{ sessionId: 'listed', n: 1 }, { sessionId: 'kid', n: 2 }, { sessionId: null, n: 3 }]
    expect(T.inheritChildRows(rows, 'parent').map((r) => r.n)).toEqual([2, 3])
    expect(T.locationOf('kid')).toEqual({ kind: 'unit', unitId: U })
    expect(T.locationOf('listed')).toEqual({ kind: 'home' })
    expect(warn).toHaveBeenCalledTimes(1)
    warn.mockRestore()
  })

  it('S4 · yieldToHomeListing:本端列表里被 unit 抢绑的 id 撤回本端(只许 unit → home),别的不动,盘上同步', () => {
    phone()
    T.clearSessionBindings()
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    T.bindSession('squatted', { kind: 'unit', unitId: U })
    T.bindSession('mac-only', { kind: 'unit', unitId: U2 })
    T.bindSession('home-bound', { kind: 'home' })
    const seen = T.useSessionBindings.getState().version
    expect(T.yieldToHomeListing(['squatted', 'home-bound', 'never-bound'])).toEqual(['squatted'])
    expect(T.locationOf('squatted')).toEqual({ kind: 'home' })
    expect(T.locationOf('mac-only')).toEqual({ kind: 'unit', unitId: U2 })
    expect(T.locationOf('home-bound')).toEqual({ kind: 'home' })
    expect(JSON.parse(store.get(bindingsKey)!)).toEqual({ 'mac-only': `unit:${U2}` })
    expect(T.useSessionBindings.getState().version).toBeGreaterThan(seen)
    const after = T.useSessionBindings.getState().version
    expect(T.yieldToHomeListing(['mac-other'])).toEqual([]) // 没撞的:不打扰订阅者
    expect(T.useSessionBindings.getState().version).toBe(after)
    warn.mockRestore()
  })

  it('S4 · 绑定按账号落盘:只存 unit 条;读回逐条过 isTargetKey + 设备 id 形状;别的账号读不到', () => {
    phone()
    T.clearSessionBindings()
    T.bindSession('m1', { kind: 'unit', unitId: U })
    T.bindSession('h1', { kind: 'home' })
    expect(JSON.parse(store.get(bindingsKey)!)).toEqual({ m1: `unit:${U}` })
    // 盘上被篡改 / 旧形状混进来:坏条逐条丢,好条留下
    store.set(bindingsKey, JSON.stringify({ m1: `unit:${U}`, m2: 'cloud', m3: 'unit:', m4: 'unit:not-a-uuid', m5: 'home', m6: 42, '': `unit:${U}` }))
    T.clearSessionBindings()
    expect(T.restoreSessionBindings()).toBe(1)
    expect(T.locationOf('m1')).toEqual({ kind: 'unit', unitId: U })
    for (const sid of ['m2', 'm3', 'm4', 'm5', 'm6']) expect(T.locationOf(sid), sid).toEqual({ kind: 'home' })
    // 坏 JSON / 不是对象 → 空
    for (const bad of ['{', 'null', '[]', '"x"']) {
      store.set(bindingsKey, bad)
      T.clearSessionBindings()
      expect(T.restoreSessionBindings(), bad).toBe(0)
    }
    // 别的账号:读不到这份
    store.set(bindingsKey, JSON.stringify({ m1: `unit:${U}` }))
    phone({}, `${b64({ alg: 'none' })}.${b64({ userId: 'someone-else' })}.sig`)
    T.clearSessionBindings()
    expect(T.restoreSessionBindings()).toBe(0)
    expect(T.locationOf('m1')).toEqual({ kind: 'home' })
  })

  it('S4 · 读盘之前的第一条新绑定不会盖掉盘上那些(先读后写);上限 500 条,淘汰最久没绑的,重绑刷新次序', () => {
    phone()
    store.set(bindingsKey, JSON.stringify({ old1: `unit:${U}`, old2: `unit:${U2}` }))
    T.clearSessionBindings() // 内存空、还没读盘
    T.bindSession('new1', { kind: 'unit', unitId: U })
    expect(Object.keys(JSON.parse(store.get(bindingsKey)!))).toEqual(['old1', 'old2', 'new1'])
    expect(T.locationOf('old2')).toEqual({ kind: 'unit', unitId: U2 })
    T.clearSessionBindings()
    store.delete(bindingsKey)
    for (let i = 0; i < T.MAX_SESSION_BINDINGS; i++) T.bindSession(`s${i}`, { kind: 'unit', unitId: U })
    T.bindSession('s0', { kind: 'unit', unitId: U }) // 重绑:s0 挪到最新,淘汰的变成 s1
    T.bindSession('overflow', { kind: 'unit', unitId: U2 })
    const saved = Object.keys(JSON.parse(store.get(bindingsKey)!))
    expect(saved.length).toBe(T.MAX_SESSION_BINDINGS)
    expect(saved.includes('s1')).toBe(false)
    expect(saved.slice(-2)).toEqual(['s0', 'overflow'])
    expect(T.locationOf('s1')).toEqual({ kind: 'home' })
  })

  it('S4 · 绑在那台电脑上、此刻解析不出目标(换到不支持远端的宿主 / 登出)→ 失败关闭:键照旧,不发任何请求,绝不改道 home', async () => {
    phone()
    T.clearSessionBindings()
    T.bindSession('on-a', { kind: 'unit', unitId: U })
    vi.stubGlobal('window', { tangu: {} }) // 桌面:不支持远端目标
    const t = T.targetForSession('on-a')
    expect(t.key).toBe(`unit:${U}`)
    expect(t.via).toBe('unit')
    await expect(t.headers()).rejects.toMatchObject({ code: 'TARGET_UNSUPPORTED' })
    authFetch.mockClear()
    await expect(T.engineFetch(t, '/agent/sessions/on-a/messages')).rejects.toMatchObject({ code: 'TARGET_UNSUPPORTED' })
    expect(authFetch).not.toHaveBeenCalled()
  })

  it('token 不是 JWT(认不出账号)→ 焦点不落盘,只活在内存', async () => {
    phone({}, 'opaque-token')
    await T.setFocusTarget({ kind: 'unit', unitId: U })
    expect(T.focusRef().kind).toBe('unit')
    expect([...store.keys()].filter((k) => k.startsWith('forsion_engine_focus:'))).toEqual([])
  })
})
