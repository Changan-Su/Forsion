/**
 * 收件箱阅读面板(Inbox Space 主区 main view):订阅 store 的 selectedId 从缓存取消息渲染——
 * 不读 view params(params 会随 space:inbox 命名布局持久化成陈腐消息 id)。
 * 消息被删/缓存失位 → 空态(禁止 msg! 解引用)。正文 = InboxBody(真 Amadeus 只读页 + 末尾的任务卡 / 审批卡,
 * 2026-09-11 起;见其头注)。
 */
import { useEffect, useState } from 'react'
import { Archive, ArchiveRestore, Cloud, Info, Mail, MailOpen, MessageCircle, Trash2 } from 'lucide-react'
import { useI18n } from '../../i18n'
import { APP_VERSION } from '../../changelog'
import { useApp } from '../../stores/appStore'
import { useInbox, senderOf, parseUtc, type InboxMessage } from '../../stores/inboxStore'
import { useWorkspace, setActiveSpace } from '@lcl/engine'
import { InboxBody } from './InboxBody'
import { hasUnknownRequirement, tierFromAuth, unmetClaimRequirements } from './claimRequirements'
import './inbox.css'

/** 物品图标:kind 命中给专属,未知类型兜底 🎁(服务端新增类型零改动)。 */
const ATTACH_ICONS: Record<string, string> = {
  reset_card: '🎟️', reset_card_weekly: '🎟️', points: '⭐', membership: '👑',
}

export function InboxReaderView() {
  const { t } = useI18n()
  const { messages, archived, selectedId, markRead, markArchived, remove } = useInbox()
  const agentDefs = useApp((s) => s.agentDefs)
  const avatars = useApp((s) => s.agentAvatars)
  // 工作区里点开的可能是「已归档」文件夹里的一封 —— 两份都找。
  const msg = selectedId ? (messages.find((m) => m.id === selectedId) ?? archived.find((m) => m.id === selectedId)) : null

  if (!msg) {
    return (
      <div className="ibx-reader">
        <div className="ibx-reader-empty">
          <Mail size={26} strokeWidth={1.5} />
          {t('inbox.reader.empty')}
        </div>
      </div>
    )
  }

  const senderAgent = msg.sender_kind === 'agent' && msg.sender_id ? agentDefs.find((a) => a.slug === msg.sender_id) : null
  const avatarUrl = senderAgent ? avatars[senderAgent.slug] : undefined

  // 过期态:展示层判断(真正的领取闸在服务端)。
  const expiresAt = parseUtc(msg.expires_at ?? null)
  const expired = !!expiresAt && expiresAt.getTime() <= Date.now()

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
          <h1 className="ibx-reader-title">{msg.title}</h1>
          <div className="ibx-reader-meta">
            {avatarUrl ? (
              <img className="ibx-ava" src={avatarUrl} alt="" />
            ) : (
              <span className="ibx-ava-fallback">
                {msg.sender_kind === 'server' ? <Cloud size={14} /> : msg.sender_kind === 'system' ? <Info size={14} /> : (senderOf(msg) || '?').slice(0, 1).toUpperCase()}
              </span>
            )}
            <span className="ibx-sender">{senderOf(msg)}</span>
            <span className="ibx-time">{parseUtc(msg.created_at)?.toLocaleString() ?? ''}</span>
            {expiresAt && (
              <span className={`ibx-expire${expired ? ' expired' : ''}`}>
                {expired ? t('inbox.expired') : t('inbox.expiresAt', { d: expiresAt.toLocaleDateString() })}
              </span>
            )}
            <span className="ibx-reader-actions">
              {senderAgent && (
                <button className="ibx-iconbtn" style={{ width: 'auto', padding: '0 8px', gap: 5 }} title={t('inbox.action.chat', { name: senderAgent.name })} onClick={chatWithSender}>
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
                onClick={() => { if (window.confirm(t('inbox.deleteConfirm', { title: msg.title }))) remove(msg.id) }}
              >
                <Trash2 size={14} />
              </button>
            </span>
          </div>
        </div>
        <div className="ibx-reader-body">
          <InboxBody msg={msg} />
        </div>
        <InboxAttachments msg={msg} expired={expired} />
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
    <div className="ibx-attach">
      <div className="ibx-attach-title">{t('inbox.attach.title')}</div>
      <div className="ibx-attach-items">
        {attach.items.map((it, i) => (
          <span key={i} className="ibx-attach-chip">
            <span aria-hidden>{ATTACH_ICONS[it.kind] ?? '🎁'}</span>
            <span>{itemLabel(it)}</span>
          </span>
        ))}
      </div>
      {req && (
        <div className="ibx-req">
          <span className="ibx-req-label">{t('inbox.req.title')}</span>
          {req.minVersion && (
            <span className={`ibx-req-chip ${unmet.includes('minVersion') ? 'bad' : 'ok'}`} title={t('inbox.req.currentVersion', { v: APP_VERSION })}>
              {t('inbox.req.version', { v: String(req.minVersion) })}
            </span>
          )}
          {!!req.tiers?.length && (
            <span
              className={`ibx-req-chip${tier == null ? '' : unmet.includes('tiers') ? ' bad' : ' ok'}`}
              title={tier ? t('inbox.req.currentTier', { tier: tierName(tier) }) : undefined}
            >
              {t('inbox.req.tiers', { tiers: req.tiers.map(tierName).join(' / ') })}
            </span>
          )}
          {hasUnknownRequirement(req) && <span className="ibx-req-chip">{t('inbox.req.other')}</span>}
        </div>
      )}
      <button
        className={`ibx-claim-btn${attach.claimed ? ' done' : ''}`}
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
  )
}
