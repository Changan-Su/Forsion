/**
 * 收件箱(Inbox Space)独立 store:消息缓存/选中/filter/未读数 + 15s 轮询编排 + 系统通知/角标。
 * 与 appStore 单向解耦——只经 getState() 读 cfg/connState/agentDefs/agentAvatars/desktopConfig/tr,零反向依赖。
 * 失败纪律:轮询/列表静默(external 老后端无 /agent/inbox 时 404 不弹错);用户主动操作失败 toast + 刷新回收。
 */
import { inboxCardOf } from '@amadeus/plugins/inboxCards'
import { create } from 'zustand'
import { setActiveSpace } from '@lcl/engine'
import { subscribeLocale, translate } from '../i18n'
import { useApp } from './appStore'
import { homeAgentDefs } from './homeCatalog'
import { notifyApp } from './notificationStore'
import {
  listInbox, getInboxUnreadCount, patchInboxMessage, readAllInbox, deleteInboxMessage, pullInbox, claimInboxAttachment,
  type InboxMessage, type InboxFilter,
} from '../services/backendService'
import { currentClientId } from '../services/agentRunService'
import { homeTarget } from '../services/engine/targets'
import { agentName } from '../agentName'
import { usesClientInbox } from '../services/platform'
import { readInboxChannel, subscribeInboxChannel } from '../services/inboxChannel'

export type { InboxMessage, InboxFilter }

// 模块级轮询簿记(非响应式)。lastLatestId 用 undefined 哨兵区分「从未成功拉过」:
// 首拉只记基准不弹通知(历史未读只上角标,防启动通知轰炸)。
let pollTimer: number | null = null
let unsubConn: (() => void) | null = null
let unsubLocale: (() => void) | null = null
let inboxGeneration = 0
let lastRevision: string | undefined
let unsubChannel: (() => void) | null = null
let stopClientPull: (() => void) | null = null
let lastLatestId: string | null | undefined = undefined
/** 未读轮询单飞(Codex 09-11 P2):挂载刷新、15s 轮询、多个列表实例撞在一起时,并发的 refreshUnread 会在
 *  lastLatestId 更新前都判成「新消息」→ 同一条通知两遍。同一时刻只跑一个,期间再来的合成一次尾随重跑。 */
let unreadRun: Promise<void> | null = null
let unreadAgain = false

/** 自动化通知的 sender_id 是引擎路由标识,不是用户可见的发件人名。 */
export function isAutomationSender(m: Pick<InboxMessage, 'sender_kind' | 'sender_id'>): boolean {
  return m.sender_kind === 'agent' && !!m.sender_id?.startsWith('automation:')
}

/** 发件人显示名(列表/阅读/系统通知三处共用)。内部 sender_id 不得泄漏到 UI。
 *  这是非 React 出口,直接读模块级 translate 快照,冷启动 / 测试期也不会回显裸 key。 */
export function senderOf(m: Pick<InboxMessage, 'sender_kind' | 'sender_id'>): string {
  if (m.sender_kind === 'server') return 'Forsion'
  if (m.sender_kind === 'system') return inboxCardOf(m)?.sender?.() || translate('inbox.sender.system')
  if (isAutomationSender(m)) return translate('inbox.sender.automation')
  const a = homeAgentDefs().find((x) => x.slug === m.sender_id) // 收件箱是本端的:焦点在我的电脑时也按本端的 Agent 认发件人
  return agentName(a) || m.sender_id || 'agent'
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
  /** 未归档那份拉成功过一次:「收件箱是空的」只在这之后才说(之前的空数组只是还没拉)。 */
  listLoaded: boolean
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

const fail = (e: any) => useApp.getState().toast(useApp.getState().tr('inbox.opFail', { e: e?.message || e }), true)
const setBadge = (n: number) => { void window.tangu?.setInboxBadge?.(n) }
/** 未归档 / 已归档两份里找一封(阅读面板可能开着已归档的那封)。 */
const findAny = (s: Pick<InboxState, 'messages' | 'archived'>, id: string): InboxMessage | undefined =>
  s.messages.find((x) => x.id === id) ?? s.archived.find((x) => x.id === id)
const mapBoth = (s: Pick<InboxState, 'messages' | 'archived'>, fn: (m: InboxMessage) => InboxMessage) =>
  ({ messages: s.messages.map(fn), archived: s.archived.map(fn) })

/** 收件箱来信要不要弹通知:等你拍板的审批信(别的 Agent 后台排队的;Muse 的进私聊)、用户自己定的自动化提醒。 */
export function inboxLetterPops(m: Pick<InboxMessage, 'sender_id' | 'body'>): boolean {
  return !!m.sender_id?.startsWith('automation:') || /```forsion-approval\b/.test(m.body || '')
}

/** 删除确认:Agent 的审批信多一句 —— 请求还在等批时,Agent 再提出它会回来(引擎 pendingApprovals.resurfaceApprovalLetter),
 *  想让它停得在卡上点「拒绝」。只认 Agent 发的(和审批卡同一道信任闸:服务端广播里的同名围栏不出卡)。 */
export function inboxDeleteConfirm(m: Pick<InboxMessage, 'title' | 'sender_kind' | 'body'>): string {
  const approval = m.sender_kind === 'agent' && /```forsion-approval\b/.test(m.body || '')
  return translate(approval ? 'inbox.deleteConfirmApproval' : 'inbox.deleteConfirm', { title: m.title })
}

export const useInbox = create<InboxState>((set, get) => ({
  messages: [],
  archived: [],
  archivedLoaded: false,
  listLoaded: false,
  selectedId: null,
  unreadCount: 0,
  loading: false,

  refreshList: async () => {
    const generation = inboxGeneration
    set({ loading: true })
    try {
      const messages = await listInbox(homeTarget(), 'all')
      if (generation === inboxGeneration) set({ messages, listLoaded: true })
    } catch { /* 静默:断连/老后端 404 */ } finally {
      set({ loading: false })
    }
  },

  // 轮询体:未读数 + 新消息检测 → 刷列表 + 系统通知 + 角标。
  refreshUnread: () => {
    if (unreadRun) { unreadAgain = true; return unreadRun }
    const once = async (): Promise<void> => {
      const generation = inboxGeneration
      let r: { count: number; latestId: string | null; revision?: string }
      try { r = await getInboxUnreadCount(homeTarget()) } catch { return }
      if (generation !== inboxGeneration) return
      // 服务端和手上的对不上就重拉列表:最新一封换了,或未读数不等于本地这份(本地这份已含「点开即已读」等乐观改动)。
      // 旧判据拿「上一次轮询的未读数」比:读掉一封、同一轮询间隔里又来一封时是 1 → 1,判成没新信 → 红点亮了列表不动。
      const had = get().unreadCount
      const latestChanged = r.latestId !== lastLatestId
      if (lastLatestId !== undefined && (latestChanged || r.count !== had || r.revision !== lastRevision)) {
        try {
          const held = get().messages
          const msgs = await listInbox(homeTarget(), 'all')
          // 拉列表这会儿本地又动过(点开 / 标记 / 删除,或别处刚刷过):这份快照是旧的,盖回去会吃掉那次改动 —— 丢掉,重跑一遍。
          if (generation !== inboxGeneration) return
          if (get().messages !== held) { unreadAgain = true; return }
          set({ messages: msgs, listLoaded: true })
          if (r.revision !== lastRevision && get().archivedLoaded) await get().refreshArchived()
          const m = latestChanged && r.count > had ? msgs.find((x) => x.id === r.latestId) : undefined
          // 收件箱新消息 → 统一通知入口(应用内卡片 + 系统通知由 notifyApp 一并发,受通知设置门控;
          // 不再单发 notifyInbox,避免与统一系统通知重复)。
          // 10-18 Muse 私聊方案 B:收件箱是「慢慢看」的,新信只亮角标;只有等你拍板的审批信与你自己定的自动化提醒还弹。
          if (m && !m.read_at && inboxLetterPops(m)) {
            notifyApp({
              event: 'inbox.message', level: 'info',
              title: senderOf(m), text: m.title,
              action: { label: useApp.getState().tr('ntf.view'), run: () => setActiveSpace('inbox') },
            })
          }
        } catch {
          // Do not acknowledge a revision whose list failed: the next poll must retry it.
          setBadge(r.count)
          set({ unreadCount: r.count })
          return
        }
      }
      setBadge(r.count)
      set({ unreadCount: r.count })
      lastLatestId = r.latestId
      lastRevision = r.revision
    }
    unreadRun = (async () => { do { unreadAgain = false; await once() } while (unreadAgain) })().finally(() => { unreadRun = null })
    return unreadRun
  },

  refreshArchived: async () => {
    const generation = inboxGeneration
    try { const archived = await listInbox(homeTarget(), 'archived'); if (generation === inboxGeneration) set({ archived, archivedLoaded: true }) } catch { /* 静默:同 refreshList */ }
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
      void patchInboxMessage(homeTarget(), id, { read: true }).catch(() => void get().refreshUnread())
    } else if (m?.read_by) {
      // Muse 替你标过的信,你点开就是你读的了:清掉归属,之后 Muse 撤回已读不会动它
      set((s) => mapBoth(s, (x) => (x.id === id ? { ...x, read_by: null } : x)))
      void patchInboxMessage(homeTarget(), id, { read: true }).catch(() => {})
    }
  },

  markRead: (id, read) => {
    const now = new Date().toISOString().slice(0, 19).replace('T', ' ')
    const counted = !findAny(get(), id)?.archived_at
    set((s) => ({
      ...mapBoth(s, (x) => (x.id === id ? { ...x, read_at: read ? now : null, read_by: null } : x)),
      unreadCount: counted ? Math.max(0, s.unreadCount + (read ? -1 : 1)) : s.unreadCount,
    }))
    setBadge(get().unreadCount)
    void patchInboxMessage(homeTarget(), id, { read }).catch((e) => { fail(e); void get().refreshList(); void get().refreshUnread() })
  },

  markArchived: (id, archived) => {
    const now = new Date().toISOString().slice(0, 19).replace('T', ' ')
    // 先就地改字段(列表源按 archived_at 立即挪行),选中保留(reader 可「取消归档」);PATCH 后两份都以服务端为准。
    set((s) => mapBoth(s, (x) => (x.id === id ? { ...x, archived_at: archived ? now : null } : x)))
    void patchInboxMessage(homeTarget(), id, { archived }).catch((e) => { fail(e) }).then(() => {
      void get().refreshList()
      void get().refreshUnread()
      void get().refreshArchived()
    })
  },

  readAll: () => {
    const now = new Date().toISOString().slice(0, 19).replace('T', ' ')
    set((s) => ({ messages: s.messages.map((x) => (x.read_at ? x : { ...x, read_at: now })), unreadCount: 0 }))
    setBadge(0)
    void readAllInbox(homeTarget()).catch((e) => { fail(e); void get().refreshList(); void get().refreshUnread() })
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
    void deleteInboxMessage(homeTarget(), id).catch((e) => { fail(e); void get().refreshList(); void get().refreshUnread() })
  },

  claiming: null,

  // 领取广播附件:非乐观(入账是服务端事实,等响应再翻 claimed);成功/已领过都置 claimed。
  claim: async (id) => {
    if (get().claiming) return
    const t = useApp.getState().tr
    set({ claiming: id })
    try {
      const r = await claimInboxAttachment(homeTarget(), id, currentClientId())
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
      const r = await pullInbox(homeTarget())
      if (!r.pulled && r.detail) { useApp.getState().toast(r.detail, true); return }
      const before = new Set(get().messages.map((m) => m.id))
      if (r.pulled) { await get().refreshList(); await get().refreshUnread() }
      const added = Math.max(r.added, get().messages.filter((m) => !before.has(m.id)).length)
      useApp.getState().toast(added > 0 ? t('inbox.pullOk', { n: added }) : t('inbox.pullNone'))
    } catch (e: any) { fail(e) }
  },

  startPolling: () => {
    if (pollTimer != null) return
    const clientInbox = usesClientInbox()
    // Cloud mail does not depend on the chat worker being healthy. Config/token
    // readiness is enough; the broadcast API verifies the account itself.
    const ready = () => !!readInboxChannel() || (clientInbox ? !!useApp.getState().cfg.token : useApp.getState().connState === 'ok')
    const tickBody = () => {
      if (!ready()) return
      void get().refreshUnread()
    }
    let alive = true
    let pulling = false
    const pull = async () => {
      if (!alive || !clientInbox || !ready() || pulling) return
      pulling = true
      try {
        const r = await pullInbox(homeTarget())
        if (alive && r.pulled) { await get().refreshList(); await get().refreshUnread() }
      } catch { /* Retry at the next tick or when the page becomes visible. */ }
      finally { pulling = false }
    }
    if (clientInbox) {
      const timer = window.setInterval(() => { void pull() }, 5 * 60_000)
      const onVisible = () => { if (!document.hidden) { tickBody(); void pull() } }
      document.addEventListener('visibilitychange', onVisible)
      stopClientPull = () => { alive = false; window.clearInterval(timer); document.removeEventListener('visibilitychange', onVisible) }
      void pull()
    }
    pollTimer = window.setInterval(tickBody, 15_000)
    // 连接从非 ok → ok 立即首拉(角标零等待);boot 已 ok 时下一 tick 也只有 15s。
    let prev = useApp.getState().connState
    let prevToken = useApp.getState().cfg.token
    unsubConn = useApp.subscribe((s) => {
      if (s.connState === 'ok' && prev !== 'ok') void get().refreshUnread()
      if ((s.connState === 'ok' && prev !== 'ok') || s.cfg.token !== prevToken) void pull()
      prev = s.connState
      prevToken = s.cfg.token
    })
    // 广播的中英文在 listInbox 里挑:切界面语言时重拉一遍已载入的列表
    unsubLocale = subscribeLocale(() => {
      void get().refreshList()
      if (get().archivedLoaded) void get().refreshArchived()
    })
    unsubChannel = subscribeInboxChannel(() => {
      inboxGeneration++
      lastLatestId = undefined
      lastRevision = undefined
      set({ messages: [], archived: [], archivedLoaded: false, listLoaded: false, selectedId: null, unreadCount: 0 })
      setBadge(0)
      void get().refreshList()
      void get().refreshUnread()
    })
    tickBody()
  },

  stopPolling: () => {
    unsubChannel?.()
    unsubChannel = null
    stopClientPull?.()
    stopClientPull = null
    if (pollTimer != null) { window.clearInterval(pollTimer); pollTimer = null }
    unsubConn?.()
    unsubConn = null
    unsubLocale?.()
    unsubLocale = null
  },
}))
