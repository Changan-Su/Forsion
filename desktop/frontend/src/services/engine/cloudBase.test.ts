// P1-K6 S1:云端 API 基址与引擎基址分家。钉四件事:
//   ① cloudApiBaseOf 的形态表(垫片显式给 / 桌面纯源现算 / 都没有);
//   ② 宿主垫片的 getConfig() 真的给出 cloudApiBase,且与改造前的 backendUrl 同值(今天行为不变);
//   ③ 手机垫片落盘偏好改不动 cloudApiBase;云端读者今天打的 URL 与改造前逐字一致;
//   ④ 垫片**内部**的读者分家(源码守卫)。垫片里两个基址出自同一个 apiBase(),运行期同值 ——
//      ② ③ 的行为断言分不出读者读的是哪个名字,把读者改回 backendUrl 照样全绿(评审实测)。
//      所以 ④ 直接钉源码:每个云端读者都必须写成读 cloudApiBase 的样子。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const cache = vi.hoisted(() => ({ clearCloudAccountCache: vi.fn(), syncCloudAccountCache: vi.fn() }))
vi.mock('../cloudAccountCache', () => cache)
// 手机垫片的原生依赖在 desktop 的 node_modules 里没有:桩掉(web 路径根本不碰它们)
vi.mock('@capacitor/app', () => ({ App: { getInfo: async () => ({ version: '0.0.0-ci.1' }) } }))
vi.mock('@capacitor/browser', () => ({ Browser: { open: async () => {} } }))
vi.mock('@capacitor/inappbrowser', () => ({ InAppBrowser: { openInWebView: async () => {} }, ToolbarPosition: {}, iOSViewStyle: {}, iOSAnimation: {} }))
vi.mock('../../../../../mobile/src/capacitorAuth', () => ({
  isNative: () => false,
  apiBase: () => 'https://forsion.test/api',
  forsionWebOrigin: () => 'https://forsion.test',
  getStoredToken: async () => '', clearStoredToken: async () => {}, startNativeLogin: async () => {},
  bindDeepLinkAuth: () => {}, refreshStoredToken: async () => {},
}))

const { cloudApiBaseOf } = await import('./cloudBase')
const T = await import('./targets')

describe('cloudApiBaseOf 形态表', () => {
  it.each([
    [{ cloudApiBase: 'https://forsion.net/api', cloudUrl: 'https://forsion.net/api' }, 'https://forsion.net/api'], // web / 手机垫片
    [{ cloudApiBase: 'https://forsion.net/api/' }, 'https://forsion.net/api'],
    [{ cloudUrl: 'https://api.forsion.net' }, 'https://api.forsion.net/api'], // 桌面:纯源 → 拼 /api
    [{ cloudUrl: 'https://api.forsion.net//' }, 'https://api.forsion.net/api'],
    [{ cloudUrl: 'http://127.0.0.1:3001/prefix' }, 'http://127.0.0.1:3001/prefix/api'], // 与主进程 `${cloudUrl}/api/…` 同口径
    [{ cloudUrl: '', cloudApiBase: '' }, ''], // 设备页局域网直连
    [{ cloudUrl: 42, cloudApiBase: null }, ''],
    [null, ''],
    [undefined, ''],
  ])('%j → %j', (c, want) => {
    expect(cloudApiBaseOf(c as never)).toBe(want)
  })
})

describe('cloudApiBase():读宿主配置(appStore.desktopConfig)', () => {
  it('宿主配置未到 → "";到了按形态表现算', () => {
    T.installEngineHost({ cfg: () => ({ backendUrl: 'http://127.0.0.1:1', token: 't', modelId: '' }), desktopConfig: () => null })
    expect(T.cloudApiBase()).toBe('')
    let dc: Record<string, unknown> = { cloudUrl: 'https://api.forsion.net' }
    T.installEngineHost({ cfg: () => ({ backendUrl: 'http://127.0.0.1:1', token: 't', modelId: '' }), desktopConfig: () => dc as never })
    expect(T.cloudApiBase()).toBe('https://api.forsion.net/api')
    dc = { cloudUrl: 'https://forsion.test/api', cloudApiBase: 'https://forsion.test/api' }
    expect(T.cloudApiBase()).toBe('https://forsion.test/api')
  })

  it('云端基址与引擎基址互不牵连(引擎基址是隧道地址时 cloudApiBase 不变)', () => {
    T.installEngineHost({
      cfg: () => ({ backendUrl: 'https://forsion.test/api/units/u1/proxy/engine', token: 't', modelId: '' }),
      desktopConfig: () => ({ cloudApiBase: 'https://forsion.test/api' }) as never,
    })
    expect(T.homeTarget().base).toBe('https://forsion.test/api/units/u1/proxy/engine')
    expect(T.cloudApiBase()).toBe('https://forsion.test/api')
  })
})

// ── 宿主垫片 ──
let values: Map<string, string>
let nativeFetch: ReturnType<typeof vi.fn<typeof fetch>>
let browserWindow: { fetch: typeof fetch; addEventListener: ReturnType<typeof vi.fn>; open: ReturnType<typeof vi.fn>; tangu?: any }
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status })

describe('宿主垫片给出 cloudApiBase(与改造前的 backendUrl 同值)', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.clearAllMocks()
    values = new Map([['forsion_token', 'token-a']])
    nativeFetch = vi.fn<typeof fetch>(async (input) => {
      const url = new URL(String(input), 'https://forsion.test/')
      if (url.pathname.endsWith('/auth/me')) return json({ id: 'a', username: 'user-a', role: 'user' })
      return json({ ok: true })
    })
    browserWindow = { fetch: nativeFetch, addEventListener: vi.fn(), open: vi.fn() }
    vi.stubGlobal('localStorage', { getItem: (k: string) => values.get(k) ?? null, setItem: (k: string, v: string) => { values.set(k, v) }, removeItem: (k: string) => { values.delete(k) } })
    vi.stubGlobal('location', { href: 'https://forsion.test/', origin: 'https://forsion.test', pathname: '/', replace: vi.fn(), reload: vi.fn() })
    vi.stubGlobal('window', browserWindow)
    vi.stubGlobal('history', { replaceState: vi.fn() })
    vi.stubGlobal('fetch', nativeFetch)
  })
  afterEach(() => vi.unstubAllGlobals())

  it('web 垫片:cloudApiBase = backendUrl = cloudUrl = 同源 /api;账号缓存身份键不变', async () => {
    const { installWebShim } = await import('../../../../../web/src/webShim')
    expect(await installWebShim()).toBe(true)
    const c = await browserWindow.tangu.getConfig()
    expect(c).toMatchObject({ backendUrl: 'https://forsion.test/api', cloudUrl: 'https://forsion.test/api', cloudApiBase: 'https://forsion.test/api' })
    expect(cloudApiBaseOf(c)).toBe(c.backendUrl)
    expect(cache.syncCloudAccountCache).toHaveBeenCalledWith('https://forsion.test/api', 'token-a')
  })

  it('手机垫片:config 带 cloudApiBase(= 旧 backendUrl);落盘偏好改不动;额度 / 名册 / 登录态今天打的 URL 逐字不变(读者分家见下方源码守卫)', async () => {
    // 非字面量说明符:别让 desktop 的 tsc 顺着 import 去类型检查 mobile/src(那边依赖 @capacitor/*,desktop 没装)
    const mobileShimPath = '../../../../../mobile/src/mobileShim'
    const { installMobileShim } = await import(/* @vite-ignore */ mobileShimPath) as { installMobileShim: () => Promise<boolean> }
    expect(await installMobileShim()).toBe(true)
    const tangu = browserWindow.tangu
    const c = await tangu.getConfig()
    expect(c).toMatchObject({ backendUrl: 'https://forsion.test/api', cloudUrl: 'https://forsion.test/api', cloudApiBase: 'https://forsion.test/api', token: 'token-a' })
    expect(cache.syncCloudAccountCache).toHaveBeenCalledWith('https://forsion.test/api', 'token-a')

    // 连接身份字段只由垫片现算:被改过的 localStorage 偏好不能把云端调用引到别处
    const after = await tangu.setConfig({ cloudApiBase: 'https://evil.test/api', modelId: 'm1' })
    expect(after).toMatchObject({ cloudApiBase: 'https://forsion.test/api', modelId: 'm1' })
    expect(JSON.parse(values.get('forsion_mobile_config') || '{}')).not.toHaveProperty('cloudApiBase')

    nativeFetch.mockClear()
    await tangu.accountQuota()
    await tangu.unitsList()
    await tangu.authStatus()
    expect(nativeFetch.mock.calls.map((call) => String(call[0]))).toEqual([
      'https://forsion.test/api/token-quota/my',
      'https://forsion.test/api/units',
      'https://forsion.test/api/auth/me',
    ])
  })
})

// ── ④ 源码守卫:垫片内部的云端读者读 cloudApiBase ──
// 为什么是源码而不是行为:垫片的 setWindowTangu(backendUrl, …) 签名归 K8(INTEGRATION §2.2,K6-S1 只许动
// 基址那一块),体内 `const cloudApiBase = backendUrl` —— 运行期没有能把两者拆成不同值的接缝。
// 只写**正向**样式(每个读者必须读 cloudApiBase),不禁 backendUrl:K8 的中继会合法地读引擎基址。
// K8 重构某个读者时,把对应样式一起改掉(改成新写法,别删)。
const GENESIS = join(__dirname, '../../../../..')
const code = (rel: string): string => readFileSync(join(GENESIS, rel), 'utf8')
  .split('\n').filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line)).join('\n') // 独占整行的注释不算

describe('宿主垫片的云端读者读 cloudApiBase(源码守卫)', () => {
  it.each([
    ['登录态 /auth/me', /origFetch\(`\$\{cloudApiBase\}\/auth\/me`/],
    ['额度 / 名册 / 重置卡(cloudJson)', /origFetch\(`\$\{cloudApiBase\}\$\{path\}`/],
    ['账号缓存身份键(装垫片时)', /syncCloudAccountCache\(cloudApiBase,\s*token\)/],
    ['账号缓存身份键(别的标签页换号)', /syncCloudAccountCache\(cloudApiBase,\s*readWebToken\(\)\)/],
    ['更新源 /website/config', /getJson\(`\$\{cloudApiBase\}\/website\/config`\)/],
    ['更新包 /website/download/android', /`\$\{cloudApiBase\}\/website\/download\/android`/],
    ['应用内浏览器地址栏', /showURL:\s*!url\.startsWith\(cloudApiBase\)/],
    ['config() 暴露 cloudUrl / cloudApiBase', /cloudUrl:\s*cloudApiBase,\s*cloudApiBase\b/],
  ])('手机垫片 · %s', (_what, re) => {
    expect(code('mobile/src/mobileShim.ts')).toMatch(re)
  })

  it.each([
    ['账号缓存身份键(装垫片时)', /syncCloudAccountCache\(cloudApiBase,\s*token\)/],
    ['账号缓存身份键(别的标签页换号)', /syncCloudAccountCache\(cloudApiBase,\s*readToken\(\)\)/],
    ['云端 fetch 守卫的 API 基址', /apiBase:\s*cloudApiBase\b/],
    ['云端 fetch 守卫的路径前缀', /new URL\(cloudApiBase\)/],
    ['getConfig() 暴露 cloudUrl / cloudApiBase', /cloudUrl:\s*cloudApiBase,\s*cloudApiBase\b/],
  ])('web 垫片 · %s', (_what, re) => {
    expect(code('web/src/webShim.ts')).toMatch(re)
  })
})
