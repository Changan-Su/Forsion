/**
 * 收件箱(Inbox Space)独立 store:消息缓存/选中/filter/未读数 + 15s 轮询编排 + 系统通知/角标。
 * 与 appStore 单向解耦——只经 getState() 读 cfg/connState/agentDefs/agentAvatars/desktopConfig/tr,零反向依赖。
 * 失败纪律:轮询/列表静默(external 老后端无 /agent/inbox 时 404 不弹错);用户主动操作失败 toast + 刷新回收。
 */
import { create } from 'zustand'
import { setActiveSpace } from '@lcl/engine'
import { useApp } from './appStore'
import { notifyApp } from './notificationStore'
import {
  listInbox, getInboxUnreadCount, patchInboxMessage, readAllInbox, deleteInboxMessage, pullInbox, claimInboxAttachment,
  type InboxMessage, type InboxFilter,
} from '../services/backendService'
import { currentClientId } from '../services/agentRunService'

export type { InboxMessage, InboxFilter }

// 模块级轮询簿记(非响应式)。lastLatestId 用 undefined 哨兵区分「从未成功拉过」:
// 首拉只记基准不弹通知(历史未读只上角标,防启动通知轰炸)。
let pollTimer: number | null = null
let unsubConn: (() => void) | null = null
let lastLatestId: string | null | undefined = undefined
let lastServerCount = 0
/** 未读轮询单飞(Codex 09-11 P2):挂载刷新、15s 轮询、多个列表实例撞在一起时,并发的 refreshUnread 会在
 *  lastLatestId 更新前都判成「新消息」→ 同一条通知两遍。同一时刻只跑一个,期间再来的合成一次尾随重跑。 */
let unreadRun: Promise<void> | null = null
let unreadAgain = false

/** 发件人显示名(列表/阅读/系统通知三处共用)。system 文案在调用点求值(防 i18n 早求值)。 */
export function senderOf(m: Pick<InboxMessage, 'sender_kind' | 'sender_id'>): string {
  if (m.sender_kind === 'server') return 'Forsion'
  if (m.sender_kind === 'system') return useApp.getState().tr('inbox.sender.system')
  const a = useApp.getState().agentDefs.find((x) => x.slug === m.sender_id)
  return a?.name || m.sender_id || 'agent'
}

/** 解析后端 UTC 'YYYY-MM-DD HH:MM:SS'(无后缀)为本地 Date;坏值回 null。 */
export function parseUtc(s: string | null): Date | null {
  if (!s) return null
  const d = new Date(`${s.replace(' ', 'T')}Z`)
  return isNaN(+d) ? null : d
}

interface InboxState {
  /** 未归档消息(服务端 filter=all)。 */
  messages: InboxMessage[]
  /** 已归档消息:单独一份,不与 messages 共用一个「当前档」—— 工作区左右栏各选各的分组也不会互相切服务端档
   *  (2026-09-11:旧版全局 filter + 列表源在渲染期切档,两个实例选不同分组会无限互拉)。 */
  archived: InboxMessage[]
  archivedLoaded: boolean
  selectedId: string | null
  unreadCount: number
  loading: boolean
  refreshList(): Promise<void>
  refreshUnread(): Promise<void>
  refreshArchived(): Promise<void>
  select(id: string | null): void
  markRead(id: string, read: boolean): void
  markArchived(id: string, archived: boolean): void
  readAll(): void
  remove(id: string): void
  claim(id: string): Promise<void>
  claiming: string | null
  pull(): Promise<void>
  startPolling(): void
  stopPolling(): void
}

const cfg = () => useApp.getState().cfg
const fail = (e: any) => useApp.getState().toast(useApp.getState().tr('inbox.opFail', { e: e?.message || e }), true)
const setBadge = (n: number) => { void window.tangu?.setInboxBadge?.(n) }
/** 未归档 / 已归档两份里找一封(阅读面板可能开着已归档的那封)。 */
const findAny = (s: Pick<InboxState, 'messages' | 'archived'>, id: string): InboxMessage | undefined =>
  s.messages.find((x) => x.id === id) ?? s.archived.find((x) => x.id === id)
const mapBoth = (s: Pick<InboxState, 'messages' | 'archived'>, fn: (m: InboxMessage) => InboxMessage) =>
  ({ messages: s.messages.map(fn), archived: s.archived.map(fn) })

export const useInbox = create<InboxState>((set, get) => ({
  messages: [],
  archived: [],
  archivedLoaded: false,
  selectedId: null,
  unreadCount: 0,
  loading: false,

  refreshList: async () => {
    set({ loading: true })
    try {
      const messages = await listInbox(cfg(), 'all')
      set({ messages })
    } catch { /* 静默:断连/老后端 404 */ } finally {
      set({ loading: false })
    }
  },

  // 轮询体:未读数 + 新消息检测 → 刷列表 + 系统通知 + 角标。
  refreshUnread: () => {
    if (unreadRun) { unreadAgain = true; return unreadRun }
    const once = async (): Promise<void> => {
      let r: { count: number; latestId: string | null }
      try { r = await getInboxUnreadCount(cfg()) } catch { return }
      const isNew = lastLatestId !== undefined && r.latestId && r.latestId !== lastLatestId && r.count > lastServerCount
      if (isNew) {
        try {
          const msgs = await listInbox(cfg(), 'all')
          set({ messages: msgs })
          const m = msgs.find((x) => x.id === r.latestId)
          // 收件箱新消息 → 统一通知入口(应用内卡片 + 系统通知由 notifyApp 一并发,受通知设置门控;
          // 不再单发 notifyInbox,避免与统一系统通知重复)。
          if (m) {
            notifyApp({
              event: 'inbox.message', level: 'info',
              title: senderOf(m), text: m.title,
              action: { label: useApp.getState().tr('ntf.view'), run: () => setActiveSpace('inbox') },
            })
          }
        } catch { /* 静默 */ }
      }
      setBadge(r.count)
      set({ unreadCount: r.count })
      lastLatestId = r.latestId
      lastServerCount = r.count
    }
    unreadRun = (async () => { do { unreadAgain = false; await once() } while (unreadAgain) })().finally(() => { unreadRun = null })
    return unreadRun
  },

  refreshArchived: async () => {
    try { set({ archived: await listInbox(cfg(), 'archived'), archivedLoaded: true }) } catch { /* 静默:同 refreshList */ }
  },

  // 选中即乐观标已读(Gmail 语义);PATCH 失败以服务器为准回收。
  select: (id) => {
    set({ selectedId: id })
    if (!id) return
    const m = findAny(get(), id)
    if (m && !m.read_at) {
      const now = new Date().toISOString().slice(0, 19).replace('T', ' ')
      set((s) => ({
        ...mapBoth(s, (x) => (x.id === id ? { ...x, read_at: now } : x)),
        // 未读数 = 服务端「未归档且未读」:读一封已归档的不动它
        unreadCount: m.archived_at ? s.unreadCount : Math.max(0, s.unreadCount - 1),
      }))
      setBadge(get().unreadCount)
      void patchInboxMessage(cfg(), id, { read: true }).catch(() => void get().refreshUnread())
    }
  },

  markRead: (id, read) => {
    const now = new Date().toISOString().slice(0, 19).replace('T', ' ')
    const counted = !findAny(get(), id)?.archived_at
    set((s) => ({
      ...mapBoth(s, (x) => (x.id === id ? { ...x, read_at: read ? now : null } : x)),
      unreadCount: counted ? Math.max(0, s.unreadCount + (read ? -1 : 1)) : s.unreadCount,
    }))
    setBadge(get().unreadCount)
    void patchInboxMessage(cfg(), id, { read }).catch((e) => { fail(e); void get().refreshList(); void get().refreshUnread() })
  },

  markArchived: (id, archived) => {
    const now = new Date().toISOString().slice(0, 19).replace('T', ' ')
    // 先就地改字段(列表源按 archived_at 立即挪行),选中保留(reader 可「取消归档」);PATCH 后两份都以服务端为准。
    set((s) => mapBoth(s, (x) => (x.id === id ? { ...x, archived_at: archived ? now : null } : x)))
    void patchInboxMessage(cfg(), id, { archived }).catch((e) => { fail(e) }).then(() => {
      void get().refreshList()
      void get().refreshUnread()
      void get().refreshArchived()
    })
  },

  readAll: () => {
    const now = new Date().toISOString().slice(0, 19).replace('T', ' ')
    set((s) => ({ messages: s.messages.map((x) => (x.read_at ? x : { ...x, read_at: now })), unreadCount: 0 }))
    setBadge(0)
    void readAllInbox(cfg()).catch((e) => { fail(e); void get().refreshList(); void get().refreshUnread() })
  },

  remove: (id) => {
    const wasUnread = !!get().messages.find((x) => x.id === id && !x.read_at)
    set((s) => ({
      messages: s.messages.filter((x) => x.id !== id),
      archived: s.archived.filter((x) => x.id !== id),
      selectedId: s.selectedId === id ? null : s.selectedId,
      unreadCount: Math.max(0, s.unreadCount - (wasUnread ? 1 : 0)),
    }))
    setBadge(get().unreadCount)
    void deleteInboxMessage(cfg(), id).catch((e) => { fail(e); void get().refreshList(); void get().refreshUnread() })
  },

  claiming: null,

  // 领取广播附件:非乐观(入账是服务端事实,等响应再翻 claimed);成功/已领过都置 claimed。
  claim: async (id) => {
    if (get().claiming) return
    const t = useApp.getState().tr
    set({ claiming: id })
    try {
      const r = await claimInboxAttachment(cfg(), id, currentClientId())
      set((s) => mapBoth(s, (x) =>
        x.id === id && x.attachments ? { ...x, attachments: { ...x.attachments, claimed: true } } : x))
      useApp.getState().toast(r.alreadyClaimed ? t('inbox.claim.already') : t('inbox.claim.ok'))
    } catch (e: any) {
      useApp.getState().toast(e?.code === 'claim_requirements_unmet' ? t('inbox.claim.unmet') : e?.message || t('inbox.claim.fail'), true)
      void get().refreshList() // 过期/已领等由服务端裁决,刷新拿真相
    } finally {
      set({ claiming: null })
    }
  },

  pull: async () => {
    const t = useApp.getState().tr
    try {
      const r = await pullInbox(cfg())
      if (!r.pulled && r.detail) { useApp.getState().toast(r.detail, true); return }
      useApp.getState().toast(r.added > 0 ? t('inbox.pullOk', { n: r.added }) : t('inbox.pullNone'))
      if (r.added > 0) { void get().refreshList(); void get().refreshUnread() }
    } catch (e: any) { fail(e) }
  },

  startPolling: () => {
    if (pollTimer != null) return
    const tickBody = () => {
      if (useApp.getState().connState !== 'ok') return
      void get().refreshUnread()
    }
    pollTimer = window.setInterval(tickBody, 15_000)
    // 连接从非 ok → ok 立即首拉(角标零等待);boot 已 ok 时下一 tick 也只有 15s。
    let prev = useApp.getState().connState
    unsubConn = useApp.subscribe((s) => {
      if (s.connState === 'ok' && prev !== 'ok') void get().refreshUnread()
      prev = s.connState
    })
    tickBody()
  },

  stopPolling: () => {
    if (pollTimer != null) { window.clearInterval(pollTimer); pollTimer = null }
    unsubConn?.()
    unsubConn = null
  },
}))
