/**
 * Unit 的网页投射:设备使用配对身份与远端文件桥;服务端投射使用既有 Account 的
 * tab 会话,按已安装插件声明装配云服务。两种形态共用 desktop renderer。
 * 投射 API 相对 document.baseURI 定位,支持 /web/ 与设备隧道子路径。
 */

import type { UnitCloudCapabilities } from './unitCloudTransport'
import { setContentStorageScope } from '@lcl/engine/contentStorageScope'
import { installScopedStorage } from './scopedStorage'

interface UnitMeta { instanceId: string; name: string; version: string; projection?: 'public' | 'local'; inheritWebAccount?: boolean; localCapabilities?: { vault: boolean; engine: boolean; host: boolean }; browserStorage?: boolean; account?: { apiBase: string; loginPath: string }; capabilities?: UnitCloudCapabilities }

const base = (): URL => new URL('.', document.baseURI)

/** 未配对时的页内配对流:请求 → 双侧展示同一 6 位码 → 轮询 → 拿到令牌。取消/失败返回 null。 */
async function pairFlow(meta: UnitMeta): Promise<string | null> {
  const root = document.createElement('div')
  root.setAttribute('style', 'position:fixed;inset:0;display:flex;align-items:center;justify-content:center;background:#f7f6f4;font-family:system-ui;z-index:99999')
  const card = document.createElement('div')
  card.setAttribute('style', 'max-width:380px;padding:32px;border-radius:16px;background:#fff;box-shadow:0 8px 40px rgba(0,0,0,.08);text-align:center')
  root.appendChild(card)
  document.body.appendChild(root)
  const render = (html: string): void => { card.innerHTML = html }
  const esc = (s: string): string => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c] as string))

  try {
    for (;;) {
      render(`<h3 style="margin:0 0 8px">连接「${esc(meta.name)}」</h3><p style="color:#777;font-size:13px">正在请求配对…</p>`)
      let req: { requestId?: string; code?: string } | null = null
      try {
        const r = await fetch(new URL('unit/pair/request', base()), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: '来访设备' }),
        })
        if (r.status === 429) {
          render(`<h3 style="margin:0 0 8px">稍等一下</h3><p style="color:#777;font-size:13px">对方还有一个待确认的配对请求,请稍后重试。</p><button id="up-retry" style="margin-top:12px;padding:8px 20px;border-radius:999px;border:1px solid #ddd;background:#fff;cursor:pointer">重试</button>`)
          await new Promise<void>((res) => { card.querySelector('#up-retry')?.addEventListener('click', () => res()) })
          continue
        }
        req = await r.json()
      } catch { /* 网络失败落到下面统一重试 */ }
      if (!req?.requestId || !req.code) {
        render(`<h3 style="margin:0 0 8px">连接失败</h3><p style="color:#777;font-size:13px">联系不上对方设备,确认它开着 Forsion 并启用了互联。</p><button id="up-retry" style="margin-top:12px;padding:8px 20px;border-radius:999px;border:1px solid #ddd;background:#fff;cursor:pointer">重试</button>`)
        await new Promise<void>((res) => { card.querySelector('#up-retry')?.addEventListener('click', () => res()) })
        continue
      }
      render(`<h3 style="margin:0 0 8px">在「${esc(meta.name)}」上确认</h3>
        <p style="color:#777;font-size:13px">对方屏幕会弹出同一组配对码,核对一致后点「允许」:</p>
        <div style="font-size:34px;letter-spacing:8px;font-weight:700;margin:16px 0">${esc(req.code)}</div>
        <p style="color:#aaa;font-size:12px">等待对方确认…(2 分钟内有效)</p>`)
      for (;;) {
        await new Promise((r) => setTimeout(r, 1500))
        let st: { status?: string; token?: string } = {}
        try { st = await (await fetch(new URL(`unit/pair/poll?id=${req.requestId}`, base()))).json() } catch { /* 掉线继续轮询 */ }
        if (st.status === 'approved' && st.token) return st.token
        if (st.status === 'denied' || st.status === 'expired') {
          render(`<h3 style="margin:0 0 8px">${st.status === 'denied' ? '对方拒绝了连接' : '配对超时'}</h3><button id="up-retry" style="margin-top:12px;padding:8px 20px;border-radius:999px;border:1px solid #ddd;background:#fff;cursor:pointer">重新配对</button>`)
          await new Promise<void>((res) => { card.querySelector('#up-retry')?.addEventListener('click', () => res()) })
          break
        }
      }
    }
  } finally {
    root.remove()
  }
}

/** whoami 的请求与读回包体合计的上限:超时 = 身份不知道,停在启动失败页。 */
export const WHOAMI_TIMEOUT_MS = 15_000

/**
 * 非公开投射上 whoami 的结论。身份「不知道」≠「不是管理员」:
 *   · 401 → unpaired(配对 / 主人进入,与改动前一样);
 *   · 200 且回包是 `{ ok: true }`、不带 role → owner(原路径,与改动前一样);
 *   · 200 且 role === 'delegated-admin'、operator.name 是字符串 → delegated;
 *   · 其余(网络失败 / 超时 / 别的状态码 / 回包不是 JSON / role 不认识 / 形状不对)→ unknown:不装载应用、不碰本地存储。
 */
export type WhoamiVerdict = { kind: 'unpaired' } | { kind: 'owner' } | { kind: 'delegated'; name: string } | { kind: 'unknown' }
export function whoamiVerdict(status: number | null, body: unknown): WhoamiVerdict {
  if (status === 401) return { kind: 'unpaired' }
  if (status !== 200 || !body || typeof body !== 'object' || Array.isArray(body)) return { kind: 'unknown' }
  const b = body as { ok?: unknown; role?: unknown; operator?: unknown }
  if (b.ok !== true) return { kind: 'unknown' }
  if (b.role === undefined) return { kind: 'owner' }
  const op = b.operator as { name?: unknown } | null | undefined
  if (b.role === 'delegated-admin' && op && typeof op === 'object' && typeof op.name === 'string') return { kind: 'delegated', name: op.name.slice(0, 120) }
  return { kind: 'unknown' }
}

/** 带总超时的 whoami:请求与读回包体共用一个计时器(只在 200 时读体)。 */
async function fetchWhoami(token: string): Promise<{ probe: Response | null; status: number | null; body: unknown }> {
  const ctl = typeof AbortController === 'function' ? new AbortController() : null
  let timer: ReturnType<typeof setTimeout> | undefined
  const deadline = new Promise<never>((_, reject) => { timer = setTimeout(() => { ctl?.abort(); reject(new Error('whoami timeout')) }, WHOAMI_TIMEOUT_MS) })
  try {
    return await Promise.race([deadline, (async () => {
      const probe = await fetch(new URL('unit/whoami', base()), {
        headers: token ? { Authorization: `Bearer ${token}` } : undefined,
        signal: ctl?.signal,
      })
      if (probe.status !== 200) return { probe, status: probe.status, body: null }
      const body = await probe.clone().json().catch(() => undefined)
      return { probe, status: probe.status, body }
    })()])
  } catch {
    return { probe: null, status: null, body: null }
  } finally { clearTimeout(timer) }
}

/** 装载设备页垫片。false = 用户中止(不挂载应用)。 */
export async function installUnitShim(): Promise<boolean> {
  const meta = (window as unknown as { __FORSION_UNIT_PAGE__?: UnitMeta }).__FORSION_UNIT_PAGE__
  if (!meta) return false
  const local = meta.projection === 'local'
  const tokenKey = local ? `unit_owner_${meta.instanceId}` : `unit_pair_${meta.instanceId}`
  let tokenStorage: Storage | undefined
  try { tokenStorage = local ? sessionStorage : localStorage } catch { /* Memory-only access remains usable. */ }
  const published = meta.projection === 'public'
  const visitor = published && meta.account
    ? await (await import('./unitAccount')).installUnitAccount({ ...meta, account: meta.account }, base()) : null
  const hasCloud = published && !!(meta.capabilities?.amadeus || meta.capabilities?.tangu)
  if (hasCloud && !visitor) throw new Error('Cloud services require the Unit account provider')
  if (hasCloud && !visitor!.account.getIdentity()) { await visitor!.login(); return false }
  let token = ''
  try { token = tokenStorage?.getItem(tokenKey) || '' } catch { /* private mode */ }

  if (local && location.hash.startsWith('#unit-owner=')) {
    token = new URLSearchParams(location.hash.slice(1)).get('unit-owner') || ''
    history.replaceState(null, '', location.pathname + location.search)
  }

  // 探针:隧道来的(桌面壳分区注入,unitHost 加内部密钥)直接 200;局域网未配对 → 401 → 配对流。
  const { probe, status, body } = await fetchWhoami(token)
  if (published && !probe?.ok) throw new Error('Unit projection is unavailable')
  // 委托管理员(经中转进来的管理员,只管 Agent):那台设备在 whoami 里带 role。壳在这个角色下不发白名单外的请求、只露 Agent 管理
  // (门控统一问 desktop 的 services/delegatedAdmin.ts)。身份读不准(失败 / 超时 / 回包畸形 / role 不认识)就停在启动失败页:
  // 按普通身份往下走会读写这个浏览器里设备主人的布局等存储(管理员的存储作用域只在认出角色后才设)。
  const verdict: WhoamiVerdict = published ? { kind: 'owner' } : whoamiVerdict(status, body)
  if (verdict.kind === 'unknown') throw new Error('Unit identity is unavailable')
  const delegated = verdict.kind === 'delegated' ? { name: verdict.name } : null
  // 委托管理员:这个页面里所有 Web Storage 读写都落在本角色的前缀下(布局、Ribbon、主位槽、主题偏好、提醒存档……一律),
  // 同一浏览器里设备主人存下的键既读不到也写不着。换不上就当失败(不往下走成「读写主人存储」的样子)。
  if (delegated && !installScopedStorage(`delegated-admin:${meta.instanceId}:`)) throw new Error('Unit identity storage is unavailable')
  if (verdict.kind === 'unpaired') {
    const fresh = local ? await (await import('./unitOwnerAccess')).ownerAccess(meta.name, base()) : await pairFlow(meta)
    if (!fresh) return false
    token = fresh
    try { tokenStorage?.setItem(tokenKey, token) } catch { /* ignore */ }
  }
  if (local && token) { try { tokenStorage?.setItem(tokenKey, token) } catch { /* Keep the validated key in memory. */ } }
  // T2 隧道:whoami 靠壳注入的 Authorization + 内部密钥豁免过闸,本页无配对令牌 ——
  // 但 appStore.boot 只在 token 非空时才 connect(空 token = 未配置形态),给一枚非机密哨兵;
  // 隧道请求的 Authorization 反正会被桌面壳在分区层整个换成 forsion token(unitWeb 不看它)。
  if (!token) token = 'tunnel'
  ;(window as unknown as { __FORSION_UNIT_TOKEN__?: string }).__FORSION_UNIT_TOKEN__ = token

  // 桥必须先于 '@/main' 挂载:amadeus/api.ts 与 dbStore 在模块求值时捕获它。
  const fixedToken = token
  const pluginData = visitor ? {
    read: async (id: string) => {
      if (!visitor.account.getIdentity()) return null
      const response = await visitor.request(`unit/plugin-data/${encodeURIComponent(id)}`)
      if (!response.ok) throw new Error(`Plugin data HTTP ${response.status}`)
      return (await response.json()).data
    },
    write: async (id: string, data: string) => {
      if (!visitor.account.getIdentity()) throw new Error('Sign in to save plugin data')
      const response = await visitor.request(`unit/plugin-data/${encodeURIComponent(id)}`, {
        method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ data }),
      })
      if (!response.ok) throw new Error(`Plugin data HTTP ${response.status}`)
      await response.json()
    },
  } : undefined
  const cloud = hasCloud ? (await import('./unitCloudTransport')).installUnitCloudTransport({
    capabilities: meta.capabilities!, accountApiBase: meta.account!.apiBase, projectionBase: base().href,
    visitor: visitor!, pluginData: pluginData!,
  }) : null
  // 委托管理员的布局另存一处(同一浏览器里设备主人存下的会话 / 笔记标签不会被还原进来,管理员摆的也不会盖掉主人的)。
  // 必须先于 workspace 模块加载(它们在求值时定下布局键),loadApp 在本函数返回之后。
  if (delegated) setContentStorageScope(`delegated-admin:${meta.instanceId}`)
  if (cloud?.amadeus) window.amadeus = cloud.amadeus
  else if (delegated) {
    // 笔记库整个在白名单外(vault/*、asset-token、events 都 403):不挂文件桥,笔记 / 日历 / 插件这些面也就不长出来。
  } else {
    const { createUnitAmadeusBridge } = await import('./amadeus/unitBridge')
    window.amadeus = await createUnitAmadeusBridge({
      base: base().href,
      browserStorage: published || (local && !meta.localCapabilities?.vault) ? visitor?.scope || meta.instanceId : undefined,
      pluginData,
      getToken: () => fixedToken,
      onAuthError: () => {
        // Paired-device tokens and visitor accounts stay separate.
        try { tokenStorage?.removeItem(tokenKey) } catch { /* private mode */ }
        location.reload()
      },
    })
  }

  const engineBase = new URL('engine', base()).href
  // 连接键恒为本页值(对方的 mode/backendUrl/token 绝不进来 —— 服务端白名单也不会下发它们)。
  // cloudApiBase 显式置空(P1-K6 S1):局域网直连的设备页没有云端 API;连接键压在对方偏好之后,对方也写不进来。
  const cfg = cloud?.config ?? { mode: 'external' as const, backendUrl: engineBase, token: published ? '' : token, cloudUrl: '', cloudApiBase: '', sandbox: 'none' as const }
  const authHeaders = (): Record<string, string> | undefined =>
    fixedToken && fixedToken !== 'tunnel' ? { Authorization: `Bearer ${fixedToken}` } : undefined
  /** 对方设备的 UI 偏好(unit/config 白名单子集):Agent Desk/朗读/笔记偏好等按 desktopConfig
   *  门控的功能靠它长出来 —— 体验跟随对方设置(2026-08-24 拍板);写回走同一张白名单。 */
  let remotePrefs: Record<string, unknown> = {}
  const pullConfig = async (): Promise<void> => {
    if (visitor) {
      if (!visitor.account.getIdentity()) { remotePrefs = {}; return }
      const response = await visitor.request('unit/config')
      if (!response.ok) throw new Error(`Preferences HTTP ${response.status}`)
      remotePrefs = (await response.json()).config || {}
      return
    }
    if (published) {
      remotePrefs = JSON.parse(sessionStorage.getItem(`unit:${meta.instanceId}:preferences`) || '{}')
      return
    }
    const r = await fetch(new URL('unit/config', base()), { headers: authHeaders() })
    if (r.ok) remotePrefs = ((await r.json()) as { config?: Record<string, unknown> }).config || {}
  }
  try { await pullConfig() } catch { /* 首拉失败:偏好按缺省,连接面不受影响 */ }
  const mergedConfig = (): Record<string, unknown> => ({ modelId: '', ...remotePrefs, ...cfg })
  const w = window as unknown as { tangu?: Record<string, unknown>; __FORSION_PRODUCT_RUNTIME__?: { market?: boolean } }
  // 服务器 Unit 装了首方包(Forsion Extend)才有商店可开(host.ts refreshProduct 按已装的包写 market)
  const storePages = !!visitor && w.__FORSION_PRODUCT_RUNTIME__?.market === true
  w.tangu = {
    /** 设备页标志:共享层据此知道「这是别的设备曝出来的面」(插件清单走 unit/plugins)。 */
    unitPage: true,
    /** 服务器 Unit 的网页主入口(不是看别的设备):页面账号 = 来访者本人,Extend 的账号 / 商店页据此放行。 */
    ...(published ? { unitPublicEntry: true } : {}),
    /** 远端身份:unitWeb 给本页的 /engine 请求盖 x-forsion-remote(工作区主人的本地投影除外,那是直通)。
     *  审批卡据此不给改命令 / 总允许(引擎对远端不兑现这两样)。 */
    remoteCaller: !local || !!delegated,
    hostFiles: !published && !delegated,
    executionCapabilities: { host: delegated ? false : local ? !!meta.localCapabilities?.host : !published },
    ...(delegated ? { delegatedAdmin: delegated } : {}),
    ...(cloud ? { cloudWeb: true } : {}),
    initialConfig: mergedConfig(),
    // 商店:网页版装不了插件(marketTypes 空 → 不列目录、不给安装),只开插件提供的页(Extend 的会员 / 积分 / 道具)和投稿。
    // marketList 在这里只当商店入口(rb-market / open-market)的门控键,恒空。
    ...(storePages ? { marketTypes: [], marketList: async () => ({ items: [] }) } : {}),
    ...(visitor ? {
      account: visitor.capability,
      forsionLogin: visitor.login,
      forsionLogout: async () => { await visitor.account.logout(); return { ok: true } },
      onAuthChanged: visitor.capability.subscribe,
      onAuthWillChange: visitor.onAuthWillChange,
    } : {}),
    ...(local && !delegated ? { backendStatus: async () => {
      const response = await fetch(new URL('unit/meta', base()))
      if (!response.ok) throw new Error('Unit status unavailable')
      const live = await response.json()
      return { state: live.localCapabilities?.engine ? 'ready' : 'stopped', url: live.localCapabilities?.engine ? engineBase : null, pid: null, lastError: null }
    } } : {}),
    appVersion: async () => meta.version,
    platform: undefined,
    getConfig: async () => {
      try { await pullConfig() } catch { /* 掉线用上次值 */ }
      return mergedConfig()
    },
    setConfig: async (patch: Record<string, unknown>) => {
      if (visitor) {
        if (!visitor.account.getIdentity()) return mergedConfig()
        const response = await visitor.request('unit/config', {
          method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(patch),
        })
        if (!response.ok) throw new Error(`Preferences HTTP ${response.status}`)
        remotePrefs = (await response.json()).config || {}
        return mergedConfig()
      }
      if (published) {
        remotePrefs = { ...remotePrefs, ...patch }
        sessionStorage.setItem(`unit:${meta.instanceId}:preferences`, JSON.stringify(remotePrefs))
        return mergedConfig()
      }
      // 委托管理员只读得到 unit/config(写在白名单外):偏好改动只留在这一页。
      if (delegated) { remotePrefs = { ...remotePrefs, ...patch }; return mergedConfig() }
      try {
        const r = await fetch(new URL('unit/config', base()), {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json', ...(authHeaders() || {}) },
          body: JSON.stringify(patch || {}),
        })
        if (r.ok) remotePrefs = ((await r.json()) as { config?: Record<string, unknown> }).config || remotePrefs
      } catch { remotePrefs = { ...remotePrefs, ...patch } } // 掉线:本地先并,下次 getConfig 对齐
      return mergedConfig()
    },
    authStatus: visitor?.account.authStatus || (async () => ({ loggedIn: false, cloudUrl: '', username: meta.name, nickname: meta.name, tokenSource: null })),
    ...visitor?.accountPresentation,
    ...(!published && !delegated ? {
    // 直连 provider 元数据(对方已剥 apiKey/baseUrl):模型选择器据此认出直连模型 ——
    // 缺了它直连模型不进清单,选择器显示「选择模型」(2026-08-24 用户实报)。
    listProviders: async () => {
      const r = await fetch(new URL('unit/providers', base()), { headers: authHeaders() })
      if (!r.ok) throw new Error(`unit providers HTTP ${r.status}`)
      return ((await r.json()) as { providers?: unknown[] }).providers || []
    },
    // 主机文件只读(对方侧 realpath 钳制工作区根∪vault 根∪host 会话根):Desk 文件卡/Pin Summary
    // 产物/文件预览的数据源 —— 缺了它 desk_present 的文件视图整个空白。契约与桌面 fs:readFile 同形。
    readHostFile: async (p: string) => {
      const r = await fetch(new URL(`unit/hostfile?path=${encodeURIComponent(p)}`, base()), { headers: authHeaders() })
      if (!r.ok) throw new Error(`hostfile HTTP ${r.status}`)
      return r.json()
    },
    // 下载对方电脑上的原文件(P1-DL):/unit/hostfile/download 流式回原字节(钳制与 hostfile 同一个解析,不受预览的 4MB 隧道上限),
    // 存成文件走与工作区下载同一个出口。设备页没有 revealHostPath —— 没有它,display_file 的卡片在这里就没有下载位。
    downloadHostFile: async (p: string, name: string) => {
      const r = await fetch(new URL(`unit/hostfile/download?path=${encodeURIComponent(p)}`, base()), { headers: authHeaders() })
      const { hostDownloadError, saveResponseAs } = await import('@/services/nativeDownload')
      if (!r.ok) throw await hostDownloadError(r)
      await saveResponseAs(name, r)
    },
    // 主机目录列表/条目 stat(工作台文件面板/悬停提示):错误语义与桌面契约同形 —— listDir 失败=[],
    // statPath 失败=null(消费端按 null 省略提示行,不是 throw)。
    listDir: async (p: string) => {
      try {
        const r = await fetch(new URL(`unit/hostdir?path=${encodeURIComponent(p)}`, base()), { headers: authHeaders() })
        if (!r.ok) return []
        return ((await r.json()) as { entries?: unknown[] }).entries || []
      } catch { return [] }
    },
    statPath: async (p: string) => {
      try {
        const r = await fetch(new URL(`unit/hoststat?path=${encodeURIComponent(p)}`, base()), { headers: authHeaders() })
        if (!r.ok) return null
        return r.json()
      } catch { return null }
    },
    } : {}),
    // Space 配方(只读):loadUserSpaces 按本方法存在性门控 —— 缺了它插件 Space 全不装,
    // Ribbon 上一个插件图标都没有(2026-08-24 实测)。spacesSave/Delete 刻意不给:设备页不写对方布局。
    ...(delegated ? {} : { spacesList: async () => {
      const r = await fetch(new URL('unit/spaces', base()), {
        headers: fixedToken && fixedToken !== 'tunnel' ? { Authorization: `Bearer ${fixedToken}` } : undefined,
      })
      if (!r.ok) throw new Error(`unit spaces HTTP ${r.status}`)
      return ((await r.json()) as { spaces?: unknown[] }).spaces || []
    } }),
  }
  document.title = `${meta.name} · Forsion`
  return true
}
