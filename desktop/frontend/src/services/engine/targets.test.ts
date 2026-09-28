// 引擎目标解析层(P1-K6 S0)的契约测试:legacy 折算逐字不变、品牌、engineFetch 的出口闸、会话绑定表。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const authFetch = vi.fn(async (..._args: unknown[]) => new Response('{}', { status: 200 }))
vi.mock('../http', () => ({ authFetch: (...args: unknown[]) => authFetch(...args) }))

const T = await import('./targets')
const { isHomeSession } = await import('../../types')

const cfg = { backendUrl: 'http://127.0.0.1:4100/', token: 'engine-token', modelId: 'm' }

beforeEach(() => { authFetch.mockClear(); T.clearSessionBindings(); T.resetFocusForTests() })
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

  it('setFocusTarget:校验 → 焦点 / 已知目标 / 会话目标都跟着变;按账号落盘,restoreFocus 读回', async () => {
    phone()
    const refocus = vi.fn(async () => {})
    T.installEngineHost({ cfg: () => ({ backendUrl: API, token: JWT, modelId: '' }), desktopConfig: () => ({ cloudApiBase: API }), refocus })
    const seen: string[] = []
    const off = T.onFocusChange((next, prev) => seen.push(`${prev.kind}->${next.kind}`))
    await T.setFocusTarget({ kind: 'unit', unitId: U }, { name: '  Mac mini  ' })
    expect(T.focusRef()).toEqual({ kind: 'unit', unitId: U })
    expect(T.focusName()).toBe('Mac mini')
    expect(T.focusTarget().key).toBe(`unit:${U}`)
    expect(T.targetForSession('any-session').key).toBe(`unit:${U}`) // S2 = 焦点(R-19)
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

  it('token 不是 JWT(认不出账号)→ 焦点不落盘,只活在内存', async () => {
    phone({}, 'opaque-token')
    await T.setFocusTarget({ kind: 'unit', unitId: U })
    expect(T.focusRef().kind).toBe('unit')
    expect([...store.keys()].filter((k) => k.startsWith('forsion_engine_focus:'))).toEqual([])
  })

  it('routeSession:焦点在 home / 传来的不是本端 cfg → 与改造前一样折成 home;否则走会话所在的目标', async () => {
    phone()
    const home = { backendUrl: API, token: JWT, modelId: '' }
    expect(T.routeSession(home, 's').key).toBe('home')
    await T.setFocusTarget({ kind: 'unit', unitId: U })
    expect(T.routeSession(home, 's').key).toBe(`unit:${U}`)
    // 设置页外部连接表单现拼的地址:不是本端 cfg,不被改道
    expect(T.routeSession({ backendUrl: 'http://10.0.0.2:4100', token: 't', modelId: '' }, 's').base).toBe('http://10.0.0.2:4100')
    const explicit = T.homeTarget()
    expect(T.routeSession(explicit, 's')).toBe(explicit) // 已是目标:原样
  })
})
