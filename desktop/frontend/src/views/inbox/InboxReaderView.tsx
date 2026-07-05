/**
 * 收件箱阅读面板(Inbox Space 主区 main view):订阅 store 的 selectedId 从缓存取消息渲染——
 * 不读 view params(params 会随 space:inbox 命名布局持久化成陈腐消息 id)。
 * 消息被删/缓存失位 → 空态(禁止 msg! 解引用)。正文 = 现成 <Markdown/>(gfm/math/高亮零改造)。
 */
import { Archive, ArchiveRestore, Clock, Cloud, Info, Mail, MailOpen, MessageCircle, Trash2, X } from 'lucide-react'
import { useI18n } from '../../i18n'
import { useApp } from '../../stores/appStore'
import { useInbox, senderOf, parseUtc } from '../../stores/inboxStore'
import { useWorkspace, setActiveSpace } from '@lcl/engine'
import { Markdown } from '../../components/Markdown'
import './inbox.css'

export function InboxReaderView() {
  const { t } = useI18n()
  const { messages, selectedId, markRead, markArchived, remove } = useInbox()
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

  const scheduled = !!msg.deliver_at && (parseUtc(msg.deliver_at)?.getTime() ?? 0) > Date.now()
  const senderAgent = msg.sender_kind === 'agent' && msg.sender_id ? agentDefs.find((a) => a.slug === msg.sender_id) : null
  const avatarUrl = senderAgent ? avatars[senderAgent.slug] : undefined

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
            {scheduled && (
              <span className="ibx-sched-pill">
                <Clock size={11} />
                {t('inbox.scheduled.at', { time: parseUtc(msg.deliver_at)?.toLocaleString() ?? '' })}
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
                title={scheduled ? t('inbox.action.cancelSchedule') : t('inbox.action.delete')}
                onClick={() => { if (window.confirm(t('inbox.deleteConfirm', { title: msg.title }))) remove(msg.id) }}
              >
                {scheduled ? <X size={14} /> : <Trash2 size={14} />}
              </button>
            </span>
          </div>
        </div>
        <div className="ibx-reader-body">
          <Markdown content={msg.body || ''} />
        </div>
      </div>
    </div>
  )
}
