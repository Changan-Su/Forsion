/**
 * 收件箱列表(Inbox Space 左栏 side view):Gmail 式两行行(发件人+时间 / 标题+摘要)+ 未读点 +
 * filter chips(全部/未读/已归档/定时中)+ 本地搜索 + 右键菜单。容器复用 t2s-side(drag region 纪律自动生效,
 * 交互元素一律 button/input)。选中 → store.select(乐观标已读)+ 打开阅读面板。
 */
import { useEffect, useMemo, useState } from 'react'
import { Archive, ArchiveRestore, CheckCheck, Clock, Cloud, Inbox, Info, Mail, MailOpen, RefreshCw, Search, Trash2 } from 'lucide-react'
import { useI18n } from '../../i18n'
import { useApp } from '../../stores/appStore'
import { useInbox, senderOf, parseUtc, type InboxMessage } from '../../stores/inboxStore'
import { useWorkspace } from '@lcl/engine'
import '../chat2/sidebar2.css'
import './inbox.css'

/** 相对时间(仓内无现成 helper);>7 天转日期。 */
function timeAgo(iso: string | null, t: (k: string, v?: Record<string, string | number>) => string): string {
  const d = parseUtc(iso)
  if (!d) return ''
  const diff = Date.now() - d.getTime()
  if (diff < 60_000) return t('inbox.time.now')
  if (diff < 3600_000) return t('inbox.time.minutes', { n: Math.floor(diff / 60_000) })
  if (diff < 86400_000) return t('inbox.time.hours', { n: Math.floor(diff / 3600_000) })
  if (diff < 7 * 86400_000) return t('inbox.time.days', { n: Math.floor(diff / 86400_000) })
  return d.toLocaleDateString()
}

/** 摘要:粗剥 markdown 标记,单行省略由 CSS 兜底。 */
function snippet(body: string): string {
  return body.replace(/[#>*_[\]()!`~-]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 100)
}

function Avatar({ m }: { m: InboxMessage }) {
  const avatars = useApp((s) => s.agentAvatars)
  if (m.sender_kind === 'server') return <span className="ibx-ava-fallback"><Cloud size={14} /></span>
  if (m.sender_kind === 'system') return <span className="ibx-ava-fallback"><Info size={14} /></span>
  const url = m.sender_id ? avatars[m.sender_id] : undefined
  if (url) return <img className="ibx-ava" src={url} alt="" />
  return <span className="ibx-ava-fallback">{(senderOf(m) || '?').slice(0, 1).toUpperCase()}</span>
}

const FILTERS = ['all', 'unread', 'archived', 'scheduled'] as const

export function InboxListView() {
  const { t } = useI18n()
  const { messages, filter, selectedId, unreadCount, setFilter, select, markRead, markArchived, readAll, remove, pull, refreshList, refreshUnread } = useInbox()
  const [query, setQuery] = useState('')
  const [pulling, setPulling] = useState(false)
  const [menu, setMenu] = useState<{ id: string; x: number; y: number } | null>(null)

  useEffect(() => {
    void refreshList()
    void refreshUnread()
  }, [])

  // 右键菜单:点击任意处关闭(捕获相 pointerdown,防浮层内部 stopPropagation 挡住)。
  useEffect(() => {
    if (!menu) return
    const close = () => setMenu(null)
    window.addEventListener('pointerdown', close, true)
    return () => window.removeEventListener('pointerdown', close, true)
  }, [menu])

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return messages
    return messages.filter((m) => m.title.toLowerCase().includes(q) || m.body.toLowerCase().includes(q))
  }, [messages, query])

  const open = (m: InboxMessage) => {
    select(m.id)
    useWorkspace.getState().openView('inbox-reader', {}, 'main')
  }

  const emptyKey = query.trim() ? 'inbox.empty.search' : `inbox.empty.${filter}`
  const menuMsg = menu ? messages.find((m) => m.id === menu.id) : null

  return (
    <aside className="t2s-side">
      <div className="ibx-head">
        <span className="ibx-head-title">
          {t('space.inbox')}
          {unreadCount > 0 && <span className="t2s-count">{unreadCount}</span>}
        </span>
        <button className="ibx-iconbtn" title={t('inbox.action.readAll')} disabled={unreadCount === 0} onClick={() => readAll()}>
          <CheckCheck size={14} />
        </button>
        <button
          className="ibx-iconbtn"
          title={t('inbox.action.refresh')}
          disabled={pulling}
          onClick={() => { setPulling(true); void pull().finally(() => setPulling(false)) }}
        >
          <RefreshCw size={13} className={pulling ? 'spin' : undefined} />
        </button>
      </div>

      <div className="t2s-search">
        <Search size={13} />
        <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder={t('inbox.searchPlaceholder')} />
      </div>

      <div className="ibx-chips">
        {FILTERS.map((f) => (
          <button key={f} className={`ibx-chip${filter === f ? ' on' : ''}`} onClick={() => setFilter(f)}>
            {t(`inbox.filter.${f}`)}
          </button>
        ))}
      </div>

      <div className="t2s-scroll">
        {filtered.length === 0 ? (
          <div className="ibx-empty"><Inbox size={20} />{t(emptyKey)}</div>
        ) : (
          filtered.map((m) => {
            const unread = !m.read_at
            const scheduled = filter === 'scheduled'
            return (
              <button
                key={m.id}
                className={`ibx-row${m.id === selectedId ? ' active' : ''}${unread ? ' unread' : ''}`}
                onClick={() => open(m)}
                onContextMenu={(e) => { e.preventDefault(); setMenu({ id: m.id, x: e.clientX, y: e.clientY }) }}
              >
                <span className="ibx-dotcol">
                  <span className="t2s-dot unread" style={unread ? undefined : { opacity: 0 }} />
                </span>
                <Avatar m={m} />
                <span className="ibx-main">
                  <span className="ibx-l1">
                    <span className="ibx-sender">{senderOf(m)}</span>
                    <span className="ibx-time">
                      {scheduled && <Clock size={10} />}
                      {scheduled ? (parseUtc(m.deliver_at)?.toLocaleString() ?? '') : timeAgo(m.created_at, t)}
                    </span>
                  </span>
                  <span className="ibx-l2">
                    <span className="ibx-title">{m.title}</span>
                    {m.body && <span className="ibx-snippet"> — {snippet(m.body)}</span>}
                  </span>
                </span>
              </button>
            )
          })
        )}
      </div>

      {menu && menuMsg && (
        <div className="ctx-menu" style={{ left: menu.x, top: menu.y }} onClick={(e) => e.stopPropagation()}>
          <button onClick={() => { markRead(menu.id, !menuMsg.read_at); setMenu(null) }}>
            {menuMsg.read_at ? <Mail size={13} /> : <MailOpen size={13} />}
            {menuMsg.read_at ? t('inbox.action.markUnread') : t('inbox.action.markRead')}
          </button>
          <button onClick={() => { markArchived(menu.id, !menuMsg.archived_at); setMenu(null) }}>
            {menuMsg.archived_at ? <ArchiveRestore size={13} /> : <Archive size={13} />}
            {menuMsg.archived_at ? t('inbox.action.unarchive') : t('inbox.action.archive')}
          </button>
          <button
            className="danger"
            onClick={() => {
              setMenu(null)
              if (window.confirm(t('inbox.deleteConfirm', { title: menuMsg.title }))) remove(menu.id)
            }}
          >
            <Trash2 size={13} /> {t('inbox.action.delete')}
          </button>
        </div>
      )}
    </aside>
  )
}
