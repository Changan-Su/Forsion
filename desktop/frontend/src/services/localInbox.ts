/**
 * 移动端本地收件箱:`window.tangu?.mobile` 下 backendService 的 6 个 inbox 函数改走这里。
 *
 * - 存储 = `localStorage`(WebView 内持久;desktop 源零 Capacitor 依赖——桌面/web 因 mobile 为假永不调用本文件)。
 *   ponytail: 用 localStorage 而非 @capacitor/preferences,免得给 desktop 源引入移动专属依赖;WebView 存储
 *   在存储压力下理论上可能被系统清,但 inbox 可经 pull() 从广播重建,读/归档状态丢失影响很小,够用。
 * - 内容来自云端可达的 `GET /brain/inbox/broadcasts`(JWT,零 server 改);读/归档/删除状态本地。
 * - filter / unread / 软删语义严格对齐 server 的 routes/inbox.ts(load-bearing)。
 *
 * 类型经 `import type` 引自 backendService(仅类型、编译期擦除,无运行时循环依赖)。
 */
import type { InboxMessage, InboxFilter } from './backendService'
import type { TanguDesktopConfig } from '../types'

const KEY = 'tangu_inbox_msgs'

interface StoredMsg extends InboxMessage {
  deleted_at: string | null // 软删:置位后不显示,但保留以维持广播 origin_broadcast_id 去重 + 游标
}

/** UTC 'YYYY-MM-DD HH:MM:SS'(秒精度,与后端无后缀 UTC 串对齐;广播的微秒 created_at 原样保留另算)。 */
function nowStr(): string {
  return new Date().toISOString().slice(0, 19).replace('T', ' ')
}

function loadAll(): StoredMsg[] {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) || '[]')
    return Array.isArray(raw) ? raw : []
  } catch { return [] }
}
function saveAll(msgs: StoredMsg[]): void {
  try { localStorage.setItem(KEY, JSON.stringify(msgs)) } catch { /* quota / private mode */ }
}

/** 已投递:deliver_at 为空 或 <= now(字符串比较,同为 UTC 'YYYY-...' 可比)。 */
function delivered(m: StoredMsg, now: string): boolean {
  return !m.deliver_at || m.deliver_at <= now
}
const cmp = (a: string | null, b: string | null): number => (a || '').localeCompare(b || '')
const byCreatedDesc = (a: StoredMsg, b: StoredMsg): number => cmp(b.created_at, a.created_at)
const byArchivedDesc = (a: StoredMsg, b: StoredMsg): number => cmp(b.archived_at, a.archived_at)
const byDeliverAsc = (a: StoredMsg, b: StoredMsg): number => cmp(a.deliver_at, b.deliver_at)

/** 广播游标 = 本地广播来源(origin_broadcast_id 非空)消息的 max created_at(含软删,微秒原文;对齐后端 pull 语义)。 */
function broadcastCursor(rows: StoredMsg[]): string {
  let max = ''
  for (const m of rows) if (m.origin_broadcast_id && m.created_at && m.created_at > max) max = m.created_at
  return max
}

export const localInbox = {
  /** = listInbox。filter 语义照抄 routes/inbox.ts:60-107。 */
  async list(filter: InboxFilter = 'all'): Promise<InboxMessage[]> {
    const now = nowStr()
    const live = loadAll().filter((m) => !m.deleted_at)
    let rows: StoredMsg[]
    if (filter === 'unread') rows = live.filter((m) => !m.archived_at && delivered(m, now) && !m.read_at).sort(byCreatedDesc)
    else if (filter === 'archived') rows = live.filter((m) => !!m.archived_at).sort(byArchivedDesc)
    else if (filter === 'scheduled') rows = live.filter((m) => m.deliver_at && m.deliver_at > now).sort(byDeliverAsc)
    else rows = live.filter((m) => !m.archived_at && delivered(m, now)).sort(byCreatedDesc) // all
    return rows
  },

  /** = getInboxUnreadCount。count=未读且已投递未归档;latestId=已投递非归档里 created_at 最新(含已读)。 */
  async unreadCount(): Promise<{ count: number; latestId: string | null }> {
    const now = nowStr()
    const visible = loadAll().filter((m) => !m.deleted_at && !m.archived_at && delivered(m, now))
    const count = visible.filter((m) => !m.read_at).length
    const latest = [...visible].sort(byCreatedDesc)[0]
    return { count, latestId: latest?.id ?? null }
  },

  /** = patchInboxMessage。布尔 → 时间戳:read→read_at=now|null、archived→archived_at=now|null。 */
  async patch(id: string, patch: { read?: boolean; archived?: boolean }): Promise<{ ok: boolean }> {
    const now = nowStr()
    const rows = loadAll()
    const m = rows.find((x) => x.id === id)
    if (m) {
      if (patch.read !== undefined) m.read_at = patch.read ? now : null
      if (patch.archived !== undefined) m.archived_at = patch.archived ? now : null
      saveAll(rows)
    }
    return { ok: true }
  },

  /** = readAllInbox。已投递未归档未读全部置已读。 */
  async readAll(): Promise<{ ok: boolean }> {
    const now = nowStr()
    const rows = loadAll()
    for (const m of rows) if (!m.deleted_at && !m.archived_at && delivered(m, now) && !m.read_at) m.read_at = now
    saveAll(rows)
    return { ok: true }
  },

  /** = deleteInboxMessage。软删(置 deleted_at,不真删——保广播去重游标)。 */
  async remove(id: string): Promise<{ ok: boolean }> {
    const rows = loadAll()
    const m = rows.find((x) => x.id === id)
    if (m && !m.deleted_at) { m.deleted_at = nowStr(); saveAll(rows) }
    return { ok: true }
  },

  /** = pullInbox。拉云端可达的 /brain/inbox/broadcasts(JWT,零 server 改)upsert 进本地。 */
  async pull(cfg: TanguDesktopConfig): Promise<{ pulled: boolean; added: number; detail?: string }> {
    const base = (cfg.backendUrl || '').replace(/\/$/, '')
    if (!base || !cfg.token) return { pulled: false, added: 0, detail: 'no backend/token' }
    const cursor = broadcastCursor(loadAll())
    const url = `${base}/brain/inbox/broadcasts${cursor ? `?since=${encodeURIComponent(cursor)}` : ''}`
    let data: { broadcasts?: Array<{ id: string; title: string; body: string; created_at: string }> }
    try {
      const r = await fetch(url, { headers: { Authorization: `Bearer ${cfg.token}` } })
      if (!r.ok) return { pulled: false, added: 0, detail: `broadcasts ${r.status}` }
      data = await r.json()
    } catch (e: any) { return { pulled: false, added: 0, detail: e?.message || 'network' } }

    const rows = loadAll()
    const seen = new Set(rows.map((m) => m.origin_broadcast_id).filter(Boolean) as string[])
    let added = 0
    for (const b of data.broadcasts || []) {
      if (!b?.id || seen.has(b.id)) continue
      rows.push({
        id: `bc:${b.id}`, title: b.title, body: b.body,
        sender_kind: 'server', sender_id: 'forsion', origin_broadcast_id: b.id,
        deliver_at: null, read_at: null, archived_at: null, created_at: b.created_at, deleted_at: null,
      })
      seen.add(b.id)
      added++
    }
    if (added) saveAll(rows)
    return { pulled: true, added }
  },
}
