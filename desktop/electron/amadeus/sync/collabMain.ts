/**
 * 页面级共享+发布的桌面主进程面(token 不下发渲染端,与 market 云调用同纪律)。
 * 渲染端经 preload 的 window.amadeusCollab 调用;HTTP 面与 web/src/amadeus/cloudCollab.ts 同构。
 * 另职责:把「与我共享」翻译成同步引擎的绑定规划(slug 稳定,双方共用)。
 */
import { createHash } from 'node:crypto'
import { loadTanguCreds } from '../../forsionAuth'
import { forsionAccountId } from '../../../shared/forsionAccount'
import { pageScopeOf, inPageScope } from './pageScopeMirror'

export interface SharedItem {
  vaultId: string
  path: string
  title: string
  role: string
  ownerName: string | null
  /** 桌面附加:镜像内 vault 相对路径(点击直接本地打开)。 */
  localPath?: string
}

export interface SharedBindingPlan {
  key: string // vaultId:rootPath 的 hash8(slug 尾缀,shadow 名)
  vaultId: string
  rootPath: string
  title: string
  /** 镜像内相对目录:与我共享/<title>-<hash8> */
  localRelDir: string
  serverDir: string
  inScope: (serverPath: string, kind: string) => boolean
}

const hash8 = (s: string): string => createHash('sha256').update(s).digest('hex').slice(0, 8)
const sanitize = (s: string): string => s.replace(/[\\/:*?"<>|]/g, ' ').trim().slice(0, 40) || 'shared'

export const SHARED_DIR = '与我共享'

export function planOf(item: { vaultId: string; path: string; title: string }): SharedBindingPlan {
  const key = hash8(`${item.vaultId}:${item.path}`)
  const scope = pageScopeOf(item.path)
  const dir = item.path.includes('/') ? item.path.slice(0, item.path.lastIndexOf('/')) : ''
  return {
    key,
    vaultId: item.vaultId,
    rootPath: item.path,
    title: item.title,
    localRelDir: `${SHARED_DIR}/${sanitize(item.title)}-${key}`,
    serverDir: dir,
    inScope: (sp, kind) => inPageScope(scope, sp, kind),
  }
}

export function createCollabMain() {
  const initial = loadTanguCreds()
  const accountId = forsionAccountId(initial.cloudUrl ?? '', initial.token ?? '')
  const controller = new AbortController()
  const sessionCreds = () => {
    const c = loadTanguCreds()
    if (controller.signal.aborted || !accountId || forsionAccountId(c.cloudUrl ?? '', c.token ?? '') !== accountId) {
      throw Object.assign(new Error('Cloud account changed; retry from the current account'), { status: 401 })
    }
    return c
  }
  const base = (): string => {
    const c = sessionCreds()
    if (!c.cloudUrl || !c.token) throw Object.assign(new Error('未登录 Forsion 账号'), { status: 401 })
    return c.cloudUrl.replace(/\/+$/, '')
  }
  const call = async <T>(method: string, path: string, body?: unknown): Promise<T> => {
    const c = sessionCreds()
    if (!c.cloudUrl || !c.token) throw Object.assign(new Error('未登录 Forsion 账号'), { status: 401 })
    const res = await fetch(`${c.cloudUrl.replace(/\/+$/, '')}/api/amadeus${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${c.token}`,
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: AbortSignal.any([controller.signal, AbortSignal.timeout(20_000)]),
    })
    if (!res.ok) {
      let parsed: any = null
      try { parsed = await res.json() } catch { /* non-json */ }
      throw Object.assign(new Error(parsed?.detail || `http ${res.status}`), { status: res.status, code: parsed?.code })
    }
    const result = await res.json() as T
    sessionCreds() // An old response must not repopulate caches after a switch.
    return result
  }

  let ownVaultId: string | null = null
  const ensureOwnVault = async (): Promise<string> => {
    sessionCreds()
    if (ownVaultId) return ownVaultId
    const r = await call<{ vaults: Array<{ id: string }> }>('GET', '/vaults')
    ownVaultId = r.vaults[0]?.id ?? 'default'
    return ownVaultId
  }

  const myUserId = (): string | null => {
    try {
      const payload = (sessionCreds().token ?? '').split('.')[1]
      const json = JSON.parse(Buffer.from(payload.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString())
      return typeof json.userId === 'string' ? json.userId : null
    } catch {
      return null
    }
  }

  const sharedWithMe = async (): Promise<SharedItem[]> => {
    const r = await call<{ items: SharedItem[] }>('GET', '/shared-with-me')
    return r.items.map((it) => {
      const plan = planOf(it)
      const baseName = it.path.split('/').pop() ?? it.path
      return { ...it, localPath: `${plan.localRelDir}/${baseName}` }
    })
  }

  let linkBaseCache: string | null = null

  return {
    stop: () => controller.abort(),
    call,
    ensureOwnVault,
    myUserId,
    sharedWithMe,
    /**
     * 分享/邀请链接的 web 入口基址:/invite /share 页面由 Genesis web 应用提供(与 server 不同源),
     * 取 server 端 AMADEUS_WEB_ORIGIN 配置;未配置时回退 cloudUrl(链接会 404,提示运维补配置)。
     */
    linkBase: async (): Promise<string> => {
      sessionCreds()
      if (linkBaseCache) return linkBaseCache
      try {
        const r = await call<{ webOrigin?: string }>('GET', '/collab/link-base')
        linkBaseCache = (r.webOrigin ?? '').trim().replace(/\/+$/, '') || base()
      } catch {
        linkBaseCache = base()
      }
      return linkBaseCache
    },
    /** presence 心跳:page 为镜像内 vault 相对路径,按绑定翻译到对应库+服务端路径。 */
    async heartbeat(pageRel: string | null, plans: SharedBindingPlan[]): Promise<void> {
      const posix = (pageRel ?? '').replace(/\\/g, '/')
      let vaultId: string
      let page: string | null = null
      const plan = plans.find((pl) => posix.startsWith(`${pl.localRelDir}/`))
      if (plan) {
        vaultId = plan.vaultId
        page = plan.serverDir ? `${plan.serverDir}/${posix.slice(plan.localRelDir.length + 1)}` : posix.slice(plan.localRelDir.length + 1)
      } else {
        vaultId = await ensureOwnVault()
        page = posix || null
      }
      await call('POST', `/vaults/${encodeURIComponent(vaultId)}/presence`, { page })
    },
  }
}

export type CollabMain = ReturnType<typeof createCollabMain>
