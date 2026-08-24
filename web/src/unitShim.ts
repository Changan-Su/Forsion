/**
 * unitShim —— 「设备页」垫片(方案 §11.4):本页面 = 某台设备(unitWeb)曝出来的 Forsion。
 *
 * 与 webShim 的三点不同:
 *   1. 不是 Forsion 账号态:局域网直连(T1)靠**配对令牌**(6 位码双侧比对,unitWeb 发放,
 *      localStorage 按对方 instanceId 存);server 隧道(T2)由桌面壳在浏览器分区注入
 *      Authorization,页面自身无需令牌(unit/whoami 探针直接过)。
 *   2. API 基址是**相对 base**(new URL('.', location.href)):局域网 `http://ip:port/` 与
 *      隧道子路径 `…/api/units/<id>/proxy/` 同一套写法 —— 构建必须 `--base=./`。
 *   3. 绝不跳 Forsion 登录页;未配对时页内走配对流(纯 DOM,先于 React 挂载)。
 */

interface UnitMeta { instanceId: string; name: string; version: string }

const base = (): URL => new URL('.', location.href)

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

/** 装载设备页垫片。false = 用户中止(不挂载应用)。 */
export async function installUnitShim(): Promise<boolean> {
  const meta = (window as unknown as { __FORSION_UNIT_PAGE__?: UnitMeta }).__FORSION_UNIT_PAGE__
  if (!meta) return false
  const tokenKey = `unit_pair_${meta.instanceId}`
  let token = ''
  try { token = localStorage.getItem(tokenKey) || '' } catch { /* private mode */ }

  // 探针:隧道来的(桌面壳分区注入,unitHost 加内部密钥)直接 200;局域网未配对 → 401 → 配对流。
  const probe = await fetch(new URL('unit/whoami', base()), {
    headers: token ? { Authorization: `Bearer ${token}` } : undefined,
  }).catch(() => null)
  if (!probe || probe.status === 401) {
    const fresh = await pairFlow(meta)
    if (!fresh) return false
    token = fresh
    try { localStorage.setItem(tokenKey, token) } catch { /* ignore */ }
  }
  // T2 隧道:whoami 靠壳注入的 Authorization + 内部密钥豁免过闸,本页无配对令牌 ——
  // 但 appStore.boot 只在 token 非空时才 connect(空 token = 未配置形态),给一枚非机密哨兵;
  // 隧道请求的 Authorization 反正会被桌面壳在分区层整个换成 forsion token(unitWeb 不看它)。
  if (!token) token = 'tunnel'
  ;(window as unknown as { __FORSION_UNIT_TOKEN__?: string }).__FORSION_UNIT_TOKEN__ = token

  // 本地 vault 面(v2.1):设备页里的 Amadeus = 对方的本地笔记库。必须先于 '@/main' 挂上
  // window.amadeus(amadeus/api.ts 模块求值时捕获,dbStore 等也在模块级订阅事件);
  // 工厂是 async 的:首枚资源令牌等到手才交桥,首屏资源 URL 不缺 at。
  const { createUnitAmadeusBridge } = await import('./amadeus/unitBridge')
  const fixedToken = token
  window.amadeus = await createUnitAmadeusBridge({
    base: base().href,
    getToken: () => fixedToken,
    onAuthError: () => {
      // 配对被对方回收:清本地令牌,重进配对流(T1);隧道形态不会 401 到这。
      try { localStorage.removeItem(tokenKey) } catch { /* private mode */ }
      location.reload()
    },
  })

  const engineBase = new URL('engine', base()).href
  // 连接键恒为本页值(对方的 mode/backendUrl/token 绝不进来 —— 服务端白名单也不会下发它们)。
  const cfg = { mode: 'external' as const, backendUrl: engineBase, token, cloudUrl: '', sandbox: 'none' as const }
  const authHeaders = (): Record<string, string> | undefined =>
    fixedToken && fixedToken !== 'tunnel' ? { Authorization: `Bearer ${fixedToken}` } : undefined
  /** 对方设备的 UI 偏好(unit/config 白名单子集):Agent Desk/朗读/笔记偏好等按 desktopConfig
   *  门控的功能靠它长出来 —— 体验跟随对方设置(2026-08-24 拍板);写回走同一张白名单。 */
  let remotePrefs: Record<string, unknown> = {}
  const pullConfig = async (): Promise<void> => {
    const r = await fetch(new URL('unit/config', base()), { headers: authHeaders() })
    if (r.ok) remotePrefs = ((await r.json()) as { config?: Record<string, unknown> }).config || {}
  }
  try { await pullConfig() } catch { /* 首拉失败:偏好按缺省,连接面不受影响 */ }
  const mergedConfig = (): Record<string, unknown> => ({ modelId: '', ...remotePrefs, ...cfg })
  const w = window as unknown as { tangu?: Record<string, unknown> }
  w.tangu = {
    /** 设备页标志:共享层据此知道「这是别的设备曝出来的面」(插件清单走 unit/plugins)。 */
    unitPage: true,
    platform: undefined,
    getConfig: async () => {
      try { await pullConfig() } catch { /* 掉线用上次值 */ }
      return mergedConfig()
    },
    setConfig: async (patch: Record<string, unknown>) => {
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
    authStatus: async () => ({ loggedIn: false, cloudUrl: '', username: meta.name, nickname: meta.name, tokenSource: null }),
    // 直连 provider 元数据(对方已剥 apiKey/baseUrl):模型选择器据此认出直连模型 ——
    // 缺了它直连模型不进清单,选择器显示「选择模型」(2026-08-24 用户实报)。
    listProviders: async () => {
      const r = await fetch(new URL('unit/providers', base()), { headers: authHeaders() })
      if (!r.ok) throw new Error(`unit providers HTTP ${r.status}`)
      return ((await r.json()) as { providers?: unknown[] }).providers || []
    },
    // 主机文件只读(对方侧 realpath 钳制工作区根∪vault 根):Desk 文件卡/Pin Summary 产物/
    // 文件预览的数据源 —— 缺了它 desk_present 的文件视图整个空白。契约与桌面 fs:readFile 同形。
    readHostFile: async (p: string) => {
      const r = await fetch(new URL(`unit/hostfile?path=${encodeURIComponent(p)}`, base()), { headers: authHeaders() })
      if (!r.ok) throw new Error(`hostfile HTTP ${r.status}`)
      return r.json()
    },
    // Space 配方(只读):loadUserSpaces 按本方法存在性门控 —— 缺了它插件 Space 全不装,
    // Ribbon 上一个插件图标都没有(2026-08-24 实测)。spacesSave/Delete 刻意不给:设备页不写对方布局。
    spacesList: async () => {
      const r = await fetch(new URL('unit/spaces', base()), {
        headers: fixedToken && fixedToken !== 'tunnel' ? { Authorization: `Bearer ${fixedToken}` } : undefined,
      })
      if (!r.ok) throw new Error(`unit spaces HTTP ${r.status}`)
      return ((await r.json()) as { spaces?: unknown[] }).spaces || []
    },
  }
  document.title = `${meta.name} · Forsion`
  return true
}
