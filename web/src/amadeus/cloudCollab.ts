/**
 * 页面级共享(P2)+ 发布(P3)的浏览器端 API 面:挂 window.amadeusCollab(web 专属)。
 * 模型:同步共享=页+子页面,参与者须登录+同意邀请(可设密码/有效期/角色);发布=公开只读链接。
 * 活动 vault id 与 cloudBridge 同源;切库 = localStorage + reload(干净重建)。
 */
import { subscribePresence, type PresenceUser } from './cloudPresence'
import { ensureActiveVault, ACTIVE_VAULT_KEY } from './cloudBridge'

export interface CollabCfg {
  apiBase: string
  getToken(): string
}

const j = async <T>(res: Response): Promise<T> => {
  if (!res.ok) {
    let body: any = null
    try { body = await res.json() } catch { /* non-json */ }
    const err = new Error(body?.detail || `http ${res.status}`) as Error & { status?: number; code?: string }
    err.status = res.status
    err.code = body?.code
    throw err
  }
  return res.json() as Promise<T>
}

export function installCloudCollab(cfg: CollabCfg): void {
  const call = async <T>(method: string, path: string, body?: unknown): Promise<T> =>
    j<T>(await fetch(`${cfg.apiBase}/amadeus${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${cfg.getToken()}`,
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      // 桌面端 collabMain 每个请求都挂 20s 超时;这里对齐 —— 否则某个 vault 的连接建起来却不回,
      // listAllShares 的串行循环会永远卡在那一库,Public View 一直转圈。
      signal: AbortSignal.timeout(20_000),
    }))

  const vid = (): Promise<string> => ensureActiveVault()

  /**
   * 分享/邀请链接的 web 入口基址。
   * ⚠️ **不能一律用 `location.origin`**:本文件被 mobile 经 alias 复用,而 Capacitor 原生 WebView 的
   * origin 是 `https://localhost` —— 那样发出去的链接是 `https://localhost/share/xxx`,别人打不开。
   * 取服务端 AMADEUS_WEB_ORIGIN(desktop collabMain.linkBase 同款端点),失败才回落同源。
   * 同步 API(inviteUrl/publishUrl)读缓存,故装配时就预热一次。
   */
  let linkBaseCache: string | null = null
  const primeLinkBase = async (): Promise<string> => {
    if (linkBaseCache) return linkBaseCache
    try {
      const r = await call<{ webOrigin?: string }>('GET', '/collab/link-base')
      linkBaseCache = (r.webOrigin ?? '').trim().replace(/\/+$/, '') || location.origin
    } catch {
      linkBaseCache = location.origin
    }
    return linkBaseCache
  }
  const linkBase = (): string => linkBaseCache ?? location.origin
  void primeLinkBase() // 预热:同步的 inviteUrl/publishUrl 只能读缓存

  const myUserId = (): string | null => {
    try {
      const payload = cfg.getToken().split('.')[1]
      const json = JSON.parse(atob(payload.replace(/-/g, '+').replace(/_/g, '/')))
      return typeof json.userId === 'string' ? json.userId : null
    } catch {
      return null
    }
  }

  let hbTimer: ReturnType<typeof setInterval> | null = null
  let hbPage: string | null = null
  const beat = (): void => {
    void vid().then((v) =>
      fetch(`${cfg.apiBase}/amadeus/vaults/${encodeURIComponent(v)}/presence`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${cfg.getToken()}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ page: hbPage }),
      }),
    ).catch(() => {})
  }

  window.amadeusCollab = {
    listVaults: () => call<{ vaults: any[] }>('GET', '/vaults').then((r) => r.vaults),
    activeVaultId: vid,
    switchVault(id: string) {
      try { localStorage.setItem(ACTIVE_VAULT_KEY, id) } catch { /* ignore */ }
      location.reload()
    },
    // ── 同步共享(owner)──
    pageShare: async (path: string) =>
      call<{ share: any; quota: { collab: number; publish: number } }>('GET', `/vaults/${encodeURIComponent(await vid())}/page-shares?path=${encodeURIComponent(path)}`),
    createPageShare: async (path: string, opts: { role?: 'editor' | 'viewer'; expiresDays?: number | null; password?: string | null }) =>
      call<any>('POST', `/vaults/${encodeURIComponent(await vid())}/page-shares`, { path, ...opts }),
    updatePageShare: async (id: string, patch: { role?: 'editor' | 'viewer'; password?: string | null; expiresDays?: number | null; rotate?: boolean }) =>
      call<any>('PATCH', `/vaults/${encodeURIComponent(await vid())}/page-shares/${encodeURIComponent(id)}`, patch),
    revokePageShare: async (id: string) => { await call('DELETE', `/vaults/${encodeURIComponent(await vid())}/page-shares/${encodeURIComponent(id)}`) },
    setParticipantRole: async (id: string, userId: string, role: 'editor' | 'viewer') => {
      await call('PATCH', `/vaults/${encodeURIComponent(await vid())}/page-shares/${encodeURIComponent(id)}/members/${encodeURIComponent(userId)}`, { role })
    },
    removeParticipant: async (id: string, userId: string) => {
      await call('DELETE', `/vaults/${encodeURIComponent(await vid())}/page-shares/${encodeURIComponent(id)}/members/${encodeURIComponent(userId)}`)
    },
    // ── 参与者 ──
    sharedWithMe: () => call<{ items: Array<{ vaultId: string; path: string; title: string; role: string; ownerName: string | null }> }>('GET', '/shared-with-me').then((r) => r.items),
    leaveShare: async (id: string) => {
      const me = myUserId()
      if (me) await call('DELETE', `/vaults/${encodeURIComponent(await vid())}/page-shares/${encodeURIComponent(id)}/members/${encodeURIComponent(me)}`)
    },
    inviteUrl: (token: string) => `${linkBase()}/invite/${token}`,
    // ── 发布(公开链接)──
    publishes: async () => call<{ shares: Array<{ token: string; mode: string; path: string; createdAt: string }>; quota: { collab: number; publish: number } }>('GET', `/vaults/${encodeURIComponent(await vid())}/shares`),
    createPublish: async (mode: 'page' | 'subtree', path: string) => {
      const r = await call<{ token: string; mode: string; path: string }>('POST', `/vaults/${encodeURIComponent(await vid())}/shares`, { mode, path })
      return { ...r, url: `${linkBase()}/share/${r.token}` }
    },
    revokePublish: async (token: string) => { await call('DELETE', `/vaults/${encodeURIComponent(await vid())}/shares/${encodeURIComponent(token)}`) },
    publishUrl: (token: string) => `${linkBase()}/share/${token}`,
    // Public View 跨库撤销:必须显式带 vaultId —— 上面两个默认变体只作用于当前 vault,
    // 拿别的库的 token 去撤会零行更新还假成功(desktop ipc.ts 同款注释)。
    revokePublishIn: async (vaultId: string, token: string) => {
      await call('DELETE', `/vaults/${encodeURIComponent(vaultId)}/shares/${encodeURIComponent(token)}`)
    },
    revokePageShareIn: async (vaultId: string, id: string) => {
      await call('DELETE', `/vaults/${encodeURIComponent(vaultId)}/page-shares/${encodeURIComponent(id)}`)
    },
    // Public View:跨全部 vault 汇总「我发布的公开链接 + 我创建的页面协作共享」。
    // publishes/pageShare 都只覆盖当前 vault,这里遍历 listVaults 聚合(desktop ipc.ts listAllShares 同款)。
    listAllShares: async () => {
      const vaults = (await call<{ vaults: Array<{ id: string; name?: string }> }>('GET', '/vaults')).vaults || []
      const myId = myUserId()
      const publishes: Array<{ token: string; mode: string; path: string; createdAt?: string; vaultId: string; vaultName: string }> = []
      const pageShares: Array<Record<string, unknown>> = []
      for (const vt of vaults) {
        try {
          const pr = await call<{ shares?: Array<Record<string, unknown>> }>('GET', `/vaults/${encodeURIComponent(vt.id)}/shares`)
          for (const s of pr.shares || []) publishes.push({ ...(s as any), vaultId: vt.id, vaultName: vt.name || '' })
        } catch { /* 某库不可达则跳过 */ }
        try {
          const ps = await call<any>('GET', `/vaults/${encodeURIComponent(vt.id)}/page-shares`)
          const list = ps?.shares || ps?.pageShares || (Array.isArray(ps) ? ps : [])
          for (const s of list) {
            const owner = s.created_by ?? s.createdBy
            // 该端点已要求调用者是 vault owner → 缺 owner 字段时视为「我的」,别误丢(否则协作区恒空)。
            if (!myId || !owner || owner === myId) pageShares.push({ ...s, vaultId: vt.id, vaultName: vt.name || '' })
          }
        } catch { /* 某库不可达则跳过 */ }
      }
      return { publishes, pageShares, linkBase: await primeLinkBase() }
    },
    // ── presence ──
    heartbeat(page: string | null) {
      hbPage = page
      beat()
      if (!hbTimer) hbTimer = setInterval(beat, 30_000)
    },
    stopHeartbeat() {
      if (hbTimer) { clearInterval(hbTimer); hbTimer = null }
    },
    onPresence: (cb: (list: PresenceUser[]) => void) => subscribePresence(cb),
    myUserId,
  }
}
