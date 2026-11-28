/**
 * 页面级共享(P2)+ 发布(P3)的浏览器端 API 面:挂 window.amadeusCollab(web 专属)。
 * 模型:同步共享=页+子页面,参与者须登录+同意邀请(可设密码/有效期/角色);发布=公开只读链接。
 * 活动 vault id 与 cloudBridge 同源;切库 = localStorage + reload(干净重建)。
 * 库清单(智库同步第 3 步 E1):listLibraries 读 /libraries(原位置库也是一项),老服务端 404 退回 GET /vaults;
 * listVaults 语义不变(真 vault id,ownVaults / 跨库汇总要它)。
 * 原位置库以 `X/` 为根打开时,发给服务端的页面路径(共享 / 发布 / 在场 / 文件地址)经 activeCloudWirePath 补上前缀。
 */
import { subscribePresence, type PresenceUser } from './cloudPresence'
import { activeCloudViewPath, activeCloudWirePath, ensureActiveLibrary, ensureActiveVault } from './cloudBridge'
import { CLOUD_CONTENT_CAPS, cloudLibraryKeys, rememberCloudLibrary, type LibraryDto } from './cloudScope'
import { cloudAccountIdentity } from '@/services/cloudAccountCache'
import { fileAddress } from '../openTarget'

export interface CollabCfg {
  apiBase: string
  getToken(): string
  request?(path: string, init?: RequestInit): Promise<Response>
  getUserId?(): string
  signal?: AbortSignal
  /** Unit projections own share/invite routes below their projection base. */
  linkBase?: string
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

/** 面板用的一行库(/libraries 的一项,或老服务端 GET /vaults 换算的)。 */
export interface CloudLibraryRow { id: string; name: string; kind: 'default' | 'own' | 'legacy'; vaultId: string; isDefault: boolean }

export function installCloudCollab(cfg: CollabCfg): void {
  const libraryKeys = cloudLibraryKeys() // 装的时候取一次:换号以后旧账号的 UI 只写回旧账号的键
  const initialToken = cfg.getToken()
  const owner = cloudAccountIdentity(cfg.apiBase, initialToken)
  const assertActive = () => {
    const token = cfg.getToken()
    if (cfg.signal?.aborted || !token || (owner ? cloudAccountIdentity(cfg.apiBase, token) !== owner : token !== initialToken)) {
      throw new Error('Cloud account changed')
    }
    return token
  }
  const call = async <T>(method: string, path: string, body?: unknown, extraHeaders?: Record<string, string>): Promise<T> => {
    const token = assertActive()
    const controller = new AbortController()
    const cancel = () => controller.abort(cfg.signal?.reason)
    cfg.signal?.addEventListener('abort', cancel, { once: true })
    const timer = setTimeout(() => controller.abort(), 20_000)
    try {
      const result = await j<T>(await (cfg.request ?? fetch)(`${cfg.apiBase}/amadeus${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        ...extraHeaders,
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      // 桌面端 collabMain 每个请求都挂 20s 超时;这里对齐 —— 否则某个 vault 的连接建起来却不回,
      // listAllShares 的串行循环会永远卡在那一库,Public View 一直转圈。
      signal: controller.signal,
    }))
      assertActive()
      return result
    } finally {
      clearTimeout(timer)
      cfg.signal?.removeEventListener('abort', cancel)
    }
  }

  const vid = (): Promise<string> => ensureActiveVault()
  /** 视图路径 → 服务端路径(原位置库视图里补 X/);共享 / 发布在别的库(带了 vaultId)时原样。 */
  const wp = (path: string): string => activeCloudWirePath(path)
  /** 服务端回的当前库里的路径 → 视图路径;视图外的原样留着(只用于显示,不再发回去)。 */
  const vp = (path: string): string => activeCloudViewPath(path) ?? path

  /**
   * 分享/邀请链接的 web 入口基址。
   * ⚠️ **不能一律用 `location.origin`**:本文件被 mobile 经 alias 复用,而 Capacitor 原生 WebView 的
   * origin 是 `https://localhost` —— 那样发出去的链接是 `https://localhost/share/xxx`,别人打不开。
   * 取服务端 AMADEUS_WEB_ORIGIN(desktop collabMain.linkBase 同款端点),失败才回落同源。
   * 同步 API(inviteUrl/publishUrl)读缓存,故装配时就预热一次。
   */
  let linkBaseCache: string | null = cfg.linkBase?.replace(/\/+$/, '') || null
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
  if (!cfg.signal?.aborted) void primeLinkBase() // 预热:同步的 inviteUrl/publishUrl 只能读缓存

  const myUserId = (): string | null => {
    assertActive()
    if (cfg.getUserId) return cfg.getUserId()
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
  const stopHeartbeat = () => {
    if (hbTimer) { clearInterval(hbTimer); hbTimer = null }
  }
  cfg.signal?.addEventListener('abort', stopHeartbeat, { once: true })
  const beat = (): void => {
    if (cfg.signal?.aborted) return
    void vid().then((v) =>
      call('POST', `/vaults/${encodeURIComponent(v)}/presence`, { page: hbPage === null ? null : wp(hbPage) }),
    ).catch(() => {})
  }

  window.amadeusCollab = {
    listVaults: () => call<{ vaults: any[] }>('GET', '/vaults').then((r) => r.vaults),
    // 只有 404 才是老服务端(退回 /vaults);别的失败照抛,不当空清单
    listLibraries: async (): Promise<CloudLibraryRow[]> => {
      try {
        const r = await call<{ libraries: LibraryDto[] }>('GET', '/libraries', undefined, { 'X-Content-Caps': CLOUD_CONTENT_CAPS })
        return (r.libraries || []).filter((l) => !l.deleted).map((l) => ({ id: l.id, name: l.name, kind: l.kind, vaultId: l.vaultId, isDefault: l.kind === 'default' }))
      } catch (e) {
        if ((e as { status?: number }).status !== 404) throw e
        const { vaults } = await call<{ vaults: Array<{ id: string; name: string; isDefault?: unknown }> }>('GET', '/vaults')
        return vaults.map((v) => {
          const isDefault = typeof v.isDefault === 'boolean' ? v.isDefault : v.name === 'My Vault'
          return { id: v.id, name: v.name, kind: isDefault ? 'default' as const : 'own' as const, vaultId: v.id, isDefault }
        })
      }
    },
    activeVaultId: vid,
    activeLibraryId: () => ensureActiveLibrary(),
    switchVault(id: string, path?: string) {
      assertActive()
      rememberCloudLibrary(id, libraryKeys)
      if (path) location.assign(fileAddress(location.href, id, path))
      else location.reload()
    },
    // 切库照旧整页刷新(契约 §3.9)
    switchLibrary(id: string) {
      assertActive()
      rememberCloudLibrary(id, libraryKeys)
      location.reload()
    },
    fileUrl: (vaultId: string, path: string) => fileAddress(`${linkBase()}/`, vaultId, wp(path)),
    // ── 同步共享(owner)──
    pageShare: async (path: string) =>
      call<{ share: any; quota: { collab: number; publish: number } }>('GET', `/vaults/${encodeURIComponent(await vid())}/page-shares?path=${encodeURIComponent(wp(path))}`),
    createPageShare: async (path: string, opts: { role?: 'editor' | 'viewer'; expiresDays?: number | null; password?: string | null; attachments?: boolean }) =>
      call<any>('POST', `/vaults/${encodeURIComponent(await vid())}/page-shares`, { path: wp(path), ...opts }),
    updatePageShare: async (id: string, patch: { role?: 'editor' | 'viewer'; password?: string | null; expiresDays?: number | null; rotate?: boolean }, vaultId?: string) =>
      call<any>('PATCH', `/vaults/${encodeURIComponent(vaultId ?? await vid())}/page-shares/${encodeURIComponent(id)}`, patch),
    revokePageShare: async (id: string) => { await call('DELETE', `/vaults/${encodeURIComponent(await vid())}/page-shares/${encodeURIComponent(id)}`) },
    setParticipantRole: async (id: string, userId: string, role: 'editor' | 'viewer', vaultId?: string) => {
      await call('PATCH', `/vaults/${encodeURIComponent(vaultId ?? await vid())}/page-shares/${encodeURIComponent(id)}/members/${encodeURIComponent(userId)}`, { role })
    },
    removeParticipant: async (id: string, userId: string, vaultId?: string) => {
      await call('DELETE', `/vaults/${encodeURIComponent(vaultId ?? await vid())}/page-shares/${encodeURIComponent(id)}/members/${encodeURIComponent(userId)}`)
    },
    relatedItems: async (id: string) => {
      const r = await call<{ items: Array<{ path: string; title: string; kind: 'page' | 'file'; included: boolean }>; subpages: number }>('GET', `/vaults/${encodeURIComponent(await vid())}/page-shares/${encodeURIComponent(id)}/related`)
      return { ...r, items: (r.items || []).map((it) => ({ ...it, path: vp(it.path) })) } // 回到视图路径:setShareItem 再补前缀发出去
    },
    setShareItem: async (id: string, path: string, included: boolean) => {
      await call('POST', `/vaults/${encodeURIComponent(await vid())}/page-shares/${encodeURIComponent(id)}/items`, { path: wp(path), included })
    },
    // ── 参与者 ──
    sharedWithMe: () => call<{ items: Array<{ shareId: string; vaultId: string; path: string; title: string; role: string; ownerName: string | null; expiresAt: string | null; items: string[] }> }>('GET', '/shared-with-me').then((r) => r.items),
    // 退出的是别人的库,不能取当前活动库。
    leaveShare: async (id: string, vaultId?: string) => {
      const me = myUserId()
      if (me) await call('DELETE', `/vaults/${encodeURIComponent(vaultId ?? await vid())}/page-shares/${encodeURIComponent(id)}/members/${encodeURIComponent(me)}`)
    },
    inviteUrl: (token: string) => `${linkBase()}/invite/${token}`,
    // ── 发布(公开链接)──
    publishes: async () => call<{ shares: Array<{ token: string; mode: string; path: string; createdAt: string }>; quota: { collab: number; publish: number } }>('GET', `/vaults/${encodeURIComponent(await vid())}/shares`),
    createPublish: async (mode: 'page' | 'subtree', path: string) => {
      const r = await call<{ token: string; mode: string; path: string }>('POST', `/vaults/${encodeURIComponent(await vid())}/shares`, { mode, path: wp(path) })
      return { ...r, path: vp(r.path), url: `${linkBase()}/share/${r.token}` }
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
      const pageShares: any[] = []
      for (const vt of vaults) {
        try {
          const pr = await call<{ shares?: Array<Record<string, unknown>> }>('GET', `/vaults/${encodeURIComponent(vt.id)}/shares`)
          for (const s of pr.shares || []) publishes.push({ ...(s as any), vaultId: vt.id, vaultName: vt.name || '' })
        } catch { /* 某库不可达则跳过 */ }
        try {
          const ps = await call<any>('GET', `/vaults/${encodeURIComponent(vt.id)}/page-shares?expired=1`)
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
      assertActive()
      hbPage = page
      beat()
      if (!hbTimer) hbTimer = setInterval(beat, 30_000)
    },
    stopHeartbeat,
    onPresence: (cb: (list: PresenceUser[]) => void) => subscribePresence(cb),
    myUserId,
  }
}
