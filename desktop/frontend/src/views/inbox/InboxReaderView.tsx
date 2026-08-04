/**
 * 收件箱阅读面板(Inbox Space 主区 main view):订阅 store 的 selectedId 从缓存取消息渲染——
 * 不读 view params(params 会随 space:inbox 命名布局持久化成陈腐消息 id)。
 * 消息被删/缓存失位 → 空态(禁止 msg! 解引用)。正文 = InboxBody(块切分:文本走 <Markdown/>,
 * 整块 ![[...]] 走 Amadeus 只读嵌入卡片,兼容笔记里的块引用渲染)。
 */
import { Archive, ArchiveRestore, Cloud, Info, Mail, MailOpen, MessageCircle, Trash2 } from 'lucide-react'
import { useI18n } from '../../i18n'
import { useApp } from '../../stores/appStore'
import { useInbox, senderOf, parseUtc } from '../../stores/inboxStore'
import { useWorkspace, setActiveSpace } from '@lcl/engine'
import { InboxBody } from './InboxBody'
import './inbox.css'

/** 物品图标:kind 命中给专属,未知类型兜底 🎁(服务端新增类型零改动)。 */
const ATTACH_ICONS: Record<string, string> = {
  reset_card: '🎟️', reset_card_weekly: '🎟️', points: '⭐', membership: '👑',
}

export function InboxReaderView() {
  const { t, locale } = useI18n()
  const { messages, selectedId, markRead, markArchived, remove, claim, claiming } = useInbox()
  const agentDefs = useApp((s) => s.agentDefs)
  const avatars = useApp((s) => s.agentAvatars)
  const msg = selectedId ? messages.find((m) => m.id === selectedId) : null

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

  // 过期态:展示层判断(真正的领取闸在服务端);label 双语由服务端冻结,按当前语言取,缺则回落 zh → kind。
  const expiresAt = parseUtc(msg.expires_at ?? null)
  const expired = !!expiresAt && expiresAt.getTime() <= Date.now()
  const attach = msg.attachments
  const itemLabel = (it: { kind: string; label?: { zh?: string; en?: string } }) =>
    (locale === 'zh' ? it.label?.zh : it.label?.en) ?? it.label?.zh ?? it.kind

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
          <InboxBody body={msg.body || ''} />
        </div>
        {attach && attach.items.length > 0 && (
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
            <button
              className={`ibx-claim-btn${attach.claimed ? ' done' : ''}`}
              disabled={attach.claimed || expired || claiming === msg.id}
              onClick={() => void claim(msg.id)}
            >
              {attach.claimed ? t('inbox.attach.claimed')
                : expired ? t('inbox.attach.expired')
                : claiming === msg.id ? t('inbox.attach.claiming')
                : t('inbox.attach.claim')}
            </button>
          </div>
        )}
      </div>
    </div>
  )
}
