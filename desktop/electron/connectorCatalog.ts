/**
 * 连接器目录(连接器方案 2026-10-23「连接器目录」「桌面端怎么用」):后台录入的官方连接器,公开只读 `GET /api/connectors`。
 *   - 拉:启动时与打开商店时;不要 Forsion 登录(第三方令牌本来就和 Forsion 账号无关)。落 <引擎 home>/connector-catalog.json:
 *     离线时用它,引擎也从这里读 alwaysAsk(tangu-agent/src/mcp/connectors.ts;受保护配置,模型写要问)。
 *   - 拉到后对账:mcp 段里带 `connector` 标记的条目,地址 / oauth 跟着目录走(令牌和 Key 按地址绑定,地址一变自然作废、要重新登录);
 *     下线(retired)的不动、不远程删,设置页标「已下线」,等用户自己断开。
 *   - 连接 = 把目录条目写进 mcp 段(名字取 id,带标记);登录 / 填 Key 由渲染层接着调引擎的 login / key 路由。
 * ponytail: 内置工具型(kind: builtin)要等 P3 的引擎 provider,这里只收下来不让连。
 */
import { mkdir, readFile, writeFile, rename } from 'node:fs/promises'
import { dirname } from 'node:path'
import { checkMcpNames, validateMcpEntry, CONNECTOR_ID_RE } from '../shared/mcpConfig'

export interface ConnectorText { zh: string; en: string }
export interface ConnectorEntry {
  id: string
  kind: 'remote-mcp' | 'builtin'
  status: 'published' | 'retired'
  order: number
  name: ConnectorText
  description: ConnectorText
  url?: string
  oauth?: { clientId?: string; scopes?: string[] }
  auth?: { type: 'user-key'; applyUrl: string }
  alwaysAsk?: string[]
  iconUrl?: string
  provider?: string
  minEngineVersion?: string
  updatedAt?: string
}
export interface ConnectorCatalog { connectors: ConnectorEntry[]; fetchedAt: number | null; offline: boolean }

const str = (v: unknown, max = 2000): v is string => typeof v === 'string' && !!v.trim() && v.length <= max
const text = (v: any): ConnectorText | null => (str(v?.zh) && str(v?.en) ? { zh: v.zh, en: v.en } : null)
const LOOPBACK = new Set(['127.0.0.1', 'localhost', '[::1]'])
/** https;本机回环可 http(开发 / 台架的假目录)。 */
function okUrl(v: unknown): v is string {
  if (!str(v)) return false
  try {
    const u = new URL(v)
    return u.protocol === 'https:' || (u.protocol === 'http:' && LOOPBACK.has(u.hostname))
  } catch { return false }
}
const strings = (v: unknown, max: number): string[] | undefined =>
  Array.isArray(v) ? v.filter((x): x is string => str(x, 200)).slice(0, max) : undefined

/** 服务端给什么都只收认识的字段;形状不对的条目整条丢掉(不猜)。 */
export function sanitizeCatalog(raw: unknown): ConnectorEntry[] {
  const list = (raw as any)?.connectors
  if (!Array.isArray(list)) throw new Error('Invalid connector catalog')
  const out: ConnectorEntry[] = []
  for (const c of list) {
    const name = text(c?.name), description = text(c?.description)
    if (!str(c?.id) || !CONNECTOR_ID_RE.test(c.id) || !name || !description) continue
    if (c.kind !== 'remote-mcp' && c.kind !== 'builtin') continue
    if (c.status !== 'published' && c.status !== 'retired') continue
    if (c.kind === 'remote-mcp' && !okUrl(c.url)) continue
    const e: ConnectorEntry = { id: c.id, kind: c.kind, status: c.status, order: Number.isFinite(c.order) ? Number(c.order) : 0, name, description }
    if (c.kind === 'remote-mcp') e.url = c.url
    if (c.oauth && typeof c.oauth === 'object') {
      const scopes = strings(c.oauth.scopes, 50)
      e.oauth = { ...(str(c.oauth.clientId, 512) ? { clientId: c.oauth.clientId } : {}), ...(scopes?.length ? { scopes } : {}) }
    }
    if (c.auth?.type === 'user-key' && okUrl(c.auth.applyUrl)) e.auth = { type: 'user-key', applyUrl: c.auth.applyUrl }
    const ask = strings(c.alwaysAsk, 50)
    if (ask?.length) e.alwaysAsk = ask
    if (okUrl(c.iconUrl)) e.iconUrl = c.iconUrl
    if (str(c.provider, 64)) e.provider = c.provider
    if (str(c.minEngineVersion, 64)) e.minEngineVersion = c.minEngineVersion
    if (str(c.updatedAt, 64)) e.updatedAt = c.updatedAt
    out.push(e)
  }
  return out.sort((a, b) => a.order - b.order || (a.id < b.id ? -1 : 1))
}

/** 目录条目 → mcp 段条目里归目录管的那几个字段。 */
function managedFields(c: ConnectorEntry): Record<string, unknown> {
  const oauth = c.oauth && (c.oauth.clientId || c.oauth.scopes?.length) ? c.oauth : undefined
  return { url: c.url, ...(oauth ? { oauth } : {}) }
}

/** 对账:带标记、目录里有(已发布或已下线)的 remote-mcp 条目,地址 / oauth 跟目录走;enabled 等用户设的原样留。没变 = undefined。 */
export function syncMcpServers(servers: Record<string, any>, catalog: ConnectorEntry[]): Record<string, any> | undefined {
  let next: Record<string, any> | undefined
  for (const [name, cfg] of Object.entries(servers)) {
    const c = typeof cfg?.connector === 'string' ? catalog.find((x) => x.id === cfg.connector && x.kind === 'remote-mcp') : undefined
    if (!c) continue
    const m = managedFields(c)
    if (cfg.url === m.url && JSON.stringify(cfg.oauth) === JSON.stringify(m.oauth)) continue
    const { url: _u, oauth: _o, ...rest } = cfg
    next ??= { ...servers }
    next[name] = validateMcpEntry({ ...m, ...rest }, name)
  }
  return next
}

/** 连接:已连着(带同一标记)就原样返回;名字被用户自己的条目占了就换 `<id>-connector`,再撞就报错(绝不覆盖用户的)。 */
export function addConnector(servers: Record<string, any>, c: ConnectorEntry): { servers: Record<string, any>; name: string; added: boolean } {
  if (c.kind !== 'remote-mcp' || !c.url) throw new Error('This connector needs a newer version of Forsion.')
  const existing = Object.entries(servers).find(([, cfg]) => cfg?.connector === c.id)
  if (existing) return { servers, name: existing[0], added: false }
  if (c.status !== 'published') throw new Error('This connector is no longer available.')
  const name = [c.id, `${c.id}-connector`].find((n) => !Object.hasOwn(servers, n))
  if (!name) throw new Error(`An MCP server named "${c.id}" already exists. Rename it in Settings and try again.`)
  const next = { ...servers, [name]: validateMcpEntry({ ...managedFields(c), connector: c.id }, name) }
  checkMcpNames(next, servers)
  return { servers: next, name, added: true }
}

export interface ConnectorDeps {
  /** Forsion 云端地址(无尾斜杠);没配置时抛。 */
  base(): Promise<string>
  /** <引擎 home>/connector-catalog.json */
  cacheFile(): string
  /** 在 config.json 的写锁里改 mcp 段的 server 表(返回 undefined = 不写);resolve 成写后的表。 */
  updateMcpServers(fn: (servers: Record<string, any>) => Record<string, any> | undefined): Promise<Record<string, any>>
}

export function createConnectorCatalog(deps: ConnectorDeps) {
  let inflight: Promise<ConnectorCatalog> | null = null
  async function readCache(): Promise<ConnectorCatalog> {
    try {
      const raw = JSON.parse(await readFile(deps.cacheFile(), 'utf8'))
      return { connectors: sanitizeCatalog(raw), fetchedAt: Number(raw.fetchedAt) || null, offline: true }
    } catch {
      return { connectors: [], fetchedAt: null, offline: true }
    }
  }
  async function fetchNow(): Promise<ConnectorCatalog> {
    let connectors: ConnectorEntry[]
    try {
      const base = await deps.base()
      const r = await fetch(`${base}/api/connectors`, { signal: AbortSignal.timeout(15_000), headers: { 'User-Agent': 'Forsion-Tangu' } })
      if (!r.ok) throw new Error(`HTTP ${r.status}`)
      connectors = sanitizeCatalog(await r.json())
    } catch (e) {
      console.warn('[connectors] catalog fetch failed, using cache:', (e as Error)?.message || e)
      return readCache()
    }
    const fetchedAt = Date.now()
    const file = deps.cacheFile()
    const tmp = `${file}.${process.pid}.${fetchedAt}.tmp`
    try {
      await mkdir(dirname(file), { recursive: true })
      await writeFile(tmp, JSON.stringify({ fetchedAt, connectors }, null, 2), { mode: 0o600 })
      await rename(tmp, file)
    } catch (e) {
      console.warn('[connectors] cache write failed:', (e as Error)?.message || e)
    }
    await deps.updateMcpServers((servers) => syncMcpServers(servers, connectors)).catch((e) => console.warn('[connectors] sync failed:', e?.message || e))
    return { connectors, fetchedAt, offline: false }
  }
  return {
    /** 拉一次(并发共用);拉不到回缓存(offline: true)。 */
    refresh(): Promise<ConnectorCatalog> {
      inflight ??= fetchNow().finally(() => { inflight = null })
      return inflight
    },
    readCache,
    async connect(id: string): Promise<{ name: string; added: boolean }> {
      if (typeof id !== 'string' || !CONNECTOR_ID_RE.test(id)) throw new Error('Invalid connector')
      const c = (await readCache()).connectors.find((x) => x.id === id)
      if (!c) throw new Error('This connector is no longer available.')
      let result!: { name: string; added: boolean }
      await deps.updateMcpServers((servers) => {
        const r = addConnector(servers, c)
        result = { name: r.name, added: r.added }
        return r.added ? r.servers : undefined
      })
      return result
    },
    /** 断开的最后一步:删掉 mcp 段里这条(令牌 / Key 已由渲染层经引擎 logout 删掉)。只删带连接器标记的。 */
    async remove(name: string): Promise<void> {
      await deps.updateMcpServers((servers) => {
        if (typeof name !== 'string' || !Object.hasOwn(servers, name) || typeof servers[name]?.connector !== 'string') return undefined
        const next = { ...servers }
        delete next[name]
        return next
      })
    },
  }
}
