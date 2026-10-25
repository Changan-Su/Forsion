import { MarketCommentNotice } from '../../components/MarketCommentNotice'
/**
 * 收件箱阅读面板(Inbox Space 主区 main view):订阅 store 的 selectedId 从缓存取消息渲染——
 * 不读 view params(params 会随 space:inbox 命名布局持久化成陈腐消息 id)。
 * 消息被删/缓存失位 → 空态(禁止 msg! 解引用)。正文 = InboxBody(真 Amadeus 只读页 + 末尾的任务卡 / 审批卡,
 * 2026-09-11 起;见其头注)。
 * 版式(2026-10-13 翻新):头部先说谁发的(SenderGlyph + 名字 + 时间),再是标题;标签页显示信的标题。
 * 正文之后的块(审批 / 任务 / 附带物品 / 反馈线程)是同一种卡:壳、卡头、卡内按钮都用聊天任务卡的 .t2-taskcard 那一套。
 */
import { useEffect, useRef, useState } from 'react'
import { Archive, ArchiveRestore, Check, Crown, Gift, Inbox, Mail, MailOpen, MessageCircle, Star, Ticket, Trash2, X, type LucideIcon } from 'lucide-react'
import { registerMessages, useI18n } from '../../i18n'
import { EmptyState } from '../../components/EmptyState'
import { formatDate, formatDateTime } from '../../format/time'
import { APP_VERSION } from '../../changelog'
import { useApp } from '../../stores/appStore'
import { useHomeAgentDefs } from '../../stores/homeCatalog'
import { useInbox, inboxDeleteConfirm, senderOf, parseUtc, type InboxMessage } from '../../stores/inboxStore'
import { useWorkspace, setActiveSpace, type Leaf } from '@lcl/engine'
import { InboxBody } from './InboxBody'
import { SenderGlyph } from './SenderGlyph'
import { FeedbackThread, feedbackThreadAvailable } from './FeedbackThread'
import { inboxThreadOf } from './feedbackThreadLib'
import { approvalThreadOf } from './approvalThreadLib'
import { openSessionFromApproval } from '../../stores/attentionOpen'
import { openRemoteSession } from '../../stores/deviceSessionsStore' // P1-K7a
import { runLocationsAvailable } from '../../features/runtime'
import { hasUnknownRequirement, tierFromAuth, unmetClaimRequirements } from './claimRequirements'
import './inboxEmptyMessages'
import './inbox.css'

/** 物品图标:kind 命中给专属,未知类型兜底礼物(服务端新增类型零改动)。线性图标,与界面其余部分一套;从前是 emoji。 */
const ATTACH_ICONS: Record<string, LucideIcon> = {
  reset_card: Ticket, reset_card_weekly: Ticket, points: Star, membership: Crown,
}

registerMessages({
  // P1-K3:审批提醒信的「打开会话」
  'inbox.approvalOpen': { zh: '打开会话', en: 'Open session' },
  'inbox.approvalOpenFail': { zh: '这台设备现在连不上那台电脑', en: "Can't reach that computer right now" },
  'inbox.reader.unread': { zh: '{n} 封未读', en: '{n} unread' },
  'inbox.reader.readLatest': { zh: '阅读最新一封', en: 'Read latest' },
  'inbox.reader.caughtUp': { zh: '没有未读消息', en: "You're all caught up" },
})

/** 主区未选中时的空态 = 「状态 + 动作」(U-10),三种说法(2026-10-25 第四轮 4.1):
 *  一封都没有 → 说清这里会收到什么(列表那边就不再重复「暂无内容」,见 inboxListSource 的 quietEmpty);
 *  有未读 → 还有几封没读 + 一键去读最新那封 / 全部已读;有信但都读过 → 「没有未读」+ 选一封读。
 *  「一封都没有」只在列表**拉成功过**之后才说(listLoaded),免得每次打开先闪一下「收件箱是空的」。
 *  数字取服务端全量未读数(列表接口有条数上限,本地数会少报);「阅读最新一封」只在已拉到的列表里找,找不到就不给这颗钮。 */
function InboxReaderEmpty() {
  const { t } = useI18n()
  const messages = useInbox((s) => s.messages)
  const listLoaded = useInbox((s) => s.listLoaded)
  const serverUnread = useInbox((s) => s.unreadCount)
  const unread = messages.filter((m) => !m.read_at && !m.archived_at)
  const count = Math.max(serverUnread, unread.length)
  const stamp = (m: InboxMessage): number => parseUtc(m.created_at)?.getTime() ?? 0
  const latest = unread.reduce<InboxMessage | null>((best, m) => (!best || stamp(m) > stamp(best) ? m : best), null)
  const readLatest = (): void => {
    if (!latest) return
    useInbox.getState().select(latest.id)
    useWorkspace.getState().openView('inbox-reader', {}, 'main')
  }
  const readAll = (): void => useInbox.getState().readAll()
  const state = count ? 'unread' : listLoaded && !messages.length ? 'empty' : 'caught-up'
  return (
    <div className="ibx-reader ibx-reader--empty">
      {state === 'unread' ? <EmptyState icon={Mail} className="ibx-reader-empty" data-unread={count} data-state={state} title={t('inbox.reader.unread', { n: count })}
        action={latest ? { label: t('inbox.reader.readLatest'), action: 'read-latest', onClick: readLatest } : { label: t('inbox.action.readAll'), action: 'read-all', onClick: readAll }}
        secondary={latest ? <button type="button" className="btn ghost sm" data-action="read-all" onClick={readAll}>{t('inbox.action.readAll')}</button> : undefined} />
        : state === 'empty' ? <EmptyState icon={Inbox} className="ibx-reader-empty" data-unread={0} data-state={state} title={t('inbox.reader.emptyTitle')} line={t('inbox.reader.emptyLine')} />
          : <EmptyState icon={MailOpen} className="ibx-reader-empty" data-unread={0} data-state={state} title={t('inbox.reader.caughtUp')} line={t('inbox.reader.empty')} />}
    </div>
  )
}

export function InboxReaderView({ leaf }: { leaf?: Leaf }) {
  const { t, locale } = useI18n()
  const { messages, archived, selectedId, markRead, markArchived, remove } = useInbox()
  const agentDefs = useHomeAgentDefs() // 收件箱是本端的(P1-K6:焦点在我的电脑时也按本端的 Agent)
  // 工作区里点开的可能是「已归档」文件夹里的一封 —— 两份都找。
  const msg = selectedId ? (messages.find((m) => m.id === selectedId) ?? archived.find((m) => m.id === selectedId)) : null

  // 标签页显示信的标题;没选中 / 信被删了退回「消息阅读」。这个视图是单例,标题会随布局存下来 ——
  // 所以没选中时也要写回去,不然重启后标签上挂着一封已经不在眼前的信的标题。放在 effect 里:渲染期调 setTitle 会回环。
  // 只跟标题走:宿主每次渲染都新造一个 leaf 对象,拿它当依赖等于每次渲染都改一遍标题。
  const tabTitle = msg?.title || t('inbox.reader')
  const leafRef = useRef(leaf)
  leafRef.current = leaf
  useEffect(() => { leafRef.current?.setTitle(tabTitle) }, [tabTitle])

  if (!msg) return <InboxReaderEmpty />

  const senderAgent = msg.sender_kind === 'agent' && msg.sender_id ? agentDefs.find((a) => a.slug === msg.sender_id) : null

  // 过期态:展示层判断(真正的领取闸在服务端)。
  const expiresAt = parseUtc(msg.expires_at ?? null)
  const expired = !!expiresAt && expiresAt.getTime() <= Date.now()
  // 反馈线程:服务端投递的定向信(thread 判别列)+ 桌面壳有云端接缝才挂;Web / 移动端只看正文。
  const thread = feedbackThreadAvailable() ? inboxThreadOf(msg) : null
  // P1-K3:电脑上的远程会话在等人 → 一键打开那条会话。
  // P1-K7a(R-20):手机上按 (那台电脑, 会话 id) 打开 —— 设备分组里列着就注入,没列出来就经那台拉一次 /detail 再注入(openRemoteSession);
  // 那个 id 其实是本端会话 / 这一端不能连别的电脑 → 退回本端已知会话的打开方式。
  const approvalThread = approvalThreadOf(msg)
  const openApprovalSession = async (): Promise<void> => {
    if (!approvalThread) return
    const opened = (runLocationsAvailable() && await openRemoteSession(approvalThread.unitId, approvalThread.sessionId))
      || await openSessionFromApproval(approvalThread.sessionId)
    if (!opened) useApp.getState().toast(t('inbox.approvalOpenFail'), true)
  }

  /** 与发件 agent 开新聊天:切 Tangu Space + blankNewChat 等价序列(不 import bootstrapEngine 防环)+ 选中该 agent。 */
  const chatWithSender = () => {
    if (!senderAgent) return
    const s = useApp.getState()
    setActiveSpace('tangu')
    s.setActiveId(null)
    s.setNewChatWs(null)
    s.setNewChatCfg(() => ({}))
    s.setNewChatModel(null)
    s.selectNewChatAgent(senderAgent.slug)
    useWorkspace.getState().openView('chat', { followActive: true, reuseKey: 'primary' }, 'main')
  }

  return (
    <div className="ibx-reader">
      <div className="ibx-reader-wrap">
        <div className="ibx-reader-head">
          <div className="ibx-reader-meta">
            <SenderGlyph msg={msg} size={36} />
            <span className="ibx-reader-from">
              <span className="ibx-sender">{senderOf(msg)}</span>
              <span className="ibx-time">
                {formatDateTime(parseUtc(msg.created_at), { locale })}
                {expiresAt && (
                  <span className={`ibx-expire${expired ? ' expired' : ''}`}>
                    {' · '}{expired ? t('inbox.expired') : t('inbox.expiresAt', { d: formatDate(expiresAt, { locale }) })}
                  </span>
                )}
              </span>
            </span>
            <span className="ibx-reader-actions">
              {senderAgent && (
                <button className="ibx-iconbtn" title={t('inbox.action.chat', { name: senderAgent.name })} onClick={chatWithSender}>
                  <MessageCircle size={14} />
                </button>
              )}
              <button
                className="ibx-iconbtn"
                title={msg.read_at ? t('inbox.action.markUnread') : t('inbox.action.markRead')}
                onClick={() => markRead(msg.id, !msg.read_at)}
              >
                {msg.read_at ? <Mail size={14} /> : <MailOpen size={14} />}
              </button>
              <button
                className="ibx-iconbtn"
                title={msg.archived_at ? t('inbox.action.unarchive') : t('inbox.action.archive')}
                onClick={() => markArchived(msg.id, !msg.archived_at)}
              >
                {msg.archived_at ? <ArchiveRestore size={14} /> : <Archive size={14} />}
              </button>
              <button
                className="ibx-iconbtn"
                title={t('inbox.action.delete')}
                onClick={() => { if (window.confirm(inboxDeleteConfirm(msg))) remove(msg.id) }}
              >
                <Trash2 size={14} />
              </button>
            </span>
          </div>
          <h1 className="ibx-reader-title">{msg.title}</h1>
        </div>
        <div className="ibx-reader-body">
          <InboxBody msg={msg} />
        </div>
        <InboxAttachments msg={msg} expired={expired} />
        {approvalThread && !expired && (
          <div className="ibx-approval-open">
            <button type="button" className="btn primary sm" data-action="approval-open" onClick={() => { void openApprovalSession() }}>{t('inbox.approvalOpen')}</button>
          </div>
        )}
        <MarketCommentNotice message={msg} />
        {thread && <FeedbackThread key={thread.ticketId} ticketId={thread.ticketId} event={thread.event} />}
      </div>
    </div>
  )
}

const TIER_KEYS: Record<string, string> = { free: 'inbox.tier.free', plus: 'inbox.tier.plus', pro: 'inbox.tier.pro' }

/**
 * 附带物品 + 领取条件 + 领取按钮。条件的本地预判只为「看得到、点不了」:版本是定论;会员档位现拉
 * (authStatus → /brain/users/me,与服务端领取闸同源 —— store 的 authInfo 只在启动 / 登录时刷新,开完会员是陈的),
 * 拉不到就不拦。真闸在服务端 claim 端点。label 双语由服务端冻结,按当前语言取,缺则回落 zh → kind。
 */
function InboxAttachments({ msg, expired }: { msg: InboxMessage; expired: boolean }) {
  const { t, locale } = useI18n()
  const { claim, claiming } = useInbox()
  const attach = msg.attachments
  const req = attach?.requires
  const needTier = !!req?.tiers?.length && !attach?.claimed
  // undefined = 还没拉到;null = 拉不到(未登录 / 离线 / 移动端)。两种都不拦。
  const [tier, setTier] = useState<string | null | undefined>(undefined)
  const [recheck, setRecheck] = useState(0)
  useEffect(() => {
    if (!needTier) return
    let alive = true
    setTier(undefined) // 换了一封 / 领取后重查:拉到之前不沿用上一次的结果
    void (async () => {
      try {
        const a = await window.tangu?.authStatus?.()
        if (alive) setTier(tierFromAuth(a)) // 只认这次现拉成功的;离线回的是缓存旧档位 → 不知道
      } catch { if (alive) setTier(null) }
    })()
    return () => { alive = false }
  }, [msg.id, needTier, recheck])

  if (!attach || attach.items.length === 0) return null
  const unmet = req ? unmetClaimRequirements(req, { version: APP_VERSION, tier }) : []
  const itemLabel = (it: { kind: string; label?: { zh?: string; en?: string } }) =>
    (locale === 'zh' ? it.label?.zh : it.label?.en) ?? it.label?.zh ?? it.kind
  const tierName = (k: string) => (TIER_KEYS[k] ? t(TIER_KEYS[k]) : k)
  return (
    <div className="t2-taskcard ibx-attach">
      <div className="t2-taskcard-head"><Gift size={13} /> <b>{t('inbox.attach.title')}</b></div>
      <div className="ibx-attach-items">
        {attach.items.map((it, i) => {
          const Icon = ATTACH_ICONS[it.kind] ?? Gift
          return <span key={i} className="ibx-attach-chip"><Icon size={12} aria-hidden /><span>{itemLabel(it)}</span></span>
        })}
      </div>
      {req && (
        <div className="ibx-req">
          <span className="ibx-req-label">{t('inbox.req.title')}</span>
          {req.minVersion && (
            <span className={`ibx-req-chip ${unmet.includes('minVersion') ? 'bad' : 'ok'}`} title={t('inbox.req.currentVersion', { v: APP_VERSION })}>
              {unmet.includes('minVersion') ? <X size={11} aria-hidden /> : <Check size={11} aria-hidden />}
              {t('inbox.req.version', { v: String(req.minVersion) })}
            </span>
          )}
          {!!req.tiers?.length && (
            <span
              className={`ibx-req-chip${tier == null ? '' : unmet.includes('tiers') ? ' bad' : ' ok'}`}
              title={tier ? t('inbox.req.currentTier', { tier: tierName(tier) }) : undefined}
            >
              {tier == null ? null : unmet.includes('tiers') ? <X size={11} aria-hidden /> : <Check size={11} aria-hidden />}
              {t('inbox.req.tiers', { tiers: req.tiers.map(tierName).join(' / ') })}
            </span>
          )}
          {hasUnknownRequirement(req) && <span className="ibx-req-chip">{t('inbox.req.other')}</span>}
        </div>
      )}
      <div className="t2-taskcard-actions">
        <button
          className={`ibx-claim-btn${attach.claimed ? ' done' : ' primary'}`}
          disabled={attach.claimed || expired || unmet.length > 0 || claiming === msg.id}
          onClick={async () => { await claim(msg.id); if (needTier) setRecheck((n) => n + 1) }}
        >
          {attach.claimed ? t('inbox.attach.claimed')
            : expired ? t('inbox.attach.expired')
            : unmet.length > 0 ? t('inbox.attach.unmet')
            : claiming === msg.id ? t('inbox.attach.claiming')
            : t('inbox.attach.claim')}
        </button>
      </div>
    </div>
  )
}
