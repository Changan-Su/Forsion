import { marketplaceCompatibility } from '../../../shared/marketplace'
import { marketPlatform } from './MarketRequirements'
import { useCallback, useEffect, useState } from 'react'
import { registerMessages, useI18n } from '../i18n'
import { formatDateTime } from '../format/time'
import { marketAccountRequest, marketPreferences, readMarketResource, setMarketPreference, type MarketComment, type MarketPreferences } from '../services/marketDiscussion'
import type { MarketDetail } from '../types'
import { MarketRequirements, requirementsText } from './MarketRequirements'
import './MarketUpgrade.css'

registerMessages({
  'market.loading': { zh: '正在加载…', en: 'Loading…' },
  'market.comments': { zh: '评论', en: 'Comments' },
  'market.versions': { zh: '版本', en: 'Versions' },
  'market.commentEmpty': { zh: '还没有评论', en: 'No comments yet' },
  'market.commentPlaceholder': { zh: '分享使用体验，或向作者提问…', en: 'Share your experience or ask the author…' },
  'market.commentPost': { zh: '发布评论', en: 'Post comment' },
  'market.commentReply': { zh: '回复', en: 'Reply' },
  'market.commentEdit': { zh: '编辑', en: 'Edit' },
  'market.commentDelete': { zh: '删除', en: 'Delete' },
  'market.commentDeleted': { zh: '评论已删除', en: 'Comment deleted' },
  'market.commentDeleteConfirm': { zh: '删除这条评论？', en: 'Delete this comment?' },
  'market.commentSave': { zh: '保存', en: 'Save' },
  'market.commentCancel': { zh: '取消', en: 'Cancel' },
  'market.commentAuthor': { zh: '发布者', en: 'Publisher' },
  'market.commentLogin': { zh: '登录 Forsion 后可以评论、回复和管理通知。', en: 'Sign in to Forsion to comment, reply and manage notifications.' },
  'market.commentAllNotify': { zh: '接收商店评论消息', en: 'Receive store comment messages' },
  'market.commentItemNotify': { zh: '接收此插件的评论消息', en: 'Receive comments for this plugin' },
  'market.commentNotifyHint': { zh: '新评论发到发布者收件箱，回复也通知被回复者。关闭后，评论仍公开可见。', en: 'New comments reach the publisher’s inbox; replies also notify the person replied to. Comments remain public when notifications are off.' },
  'market.moreReplies': { zh: '加载更早的回复', en: 'Load earlier replies' },
  'market.moreComments': { zh: '加载更多评论', en: 'Load more comments' },
  'market.versionEmpty': { zh: '还没有版本记录', en: 'No version history yet' },
  'market.installVersion': { zh: '安装此版本', en: 'Install this version' },
  'market.currentVersion': { zh: '当前上架版本', en: 'Current store version' },
  'market.copyId': { zh: '复制插件 ID', en: 'Copy plugin ID' },
  'market.tagAll': { zh: '所有标签', en: 'All tags' },
  'market.compatibleOnly': { zh: '只看适配当前版本', en: 'Compatible with this version' },
})

function MarketNotificationsBody({ itemId }: { itemId?: string }) {
  const { t } = useI18n()
  const [prefs, setPrefs] = useState<MarketPreferences | null>(null)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  useEffect(() => { let alive = true; void marketPreferences().then(p => { if (alive) setPrefs(p) }).catch(e => { if (alive) setError(e.status === 401 ? t('market.commentLogin') : e.message) }); return () => { alive = false } }, [itemId, t])
  const change = async (enabled: boolean, id?: string) => {
    if (!prefs || busy) return
    const previous = prefs
    setPrefs(id ? { ...prefs, mutedItemIds: enabled ? prefs.mutedItemIds.filter(item => item !== id) : [...new Set([...prefs.mutedItemIds, id])] } : { ...prefs, enabled })
    setBusy(true); setError('')
    try { setPrefs(await setMarketPreference(enabled, id)) } catch (e: any) { setPrefs(previous); setError(e.status === 401 ? t('market.commentLogin') : e.message) } finally { setBusy(false) }
  }
  return <div className="mk-notification-settings">
    {prefs && <>
      <label><input type="checkbox" checked={prefs.enabled} disabled={busy} onChange={e => void change(e.target.checked)} />{t('market.commentAllNotify')}</label>
      {itemId && <label><input type="checkbox" checked={!prefs.mutedItemIds.includes(itemId)} disabled={busy || !prefs.enabled} onChange={e => void change(e.target.checked, itemId)} />{t('market.commentItemNotify')}</label>}
      <p className="mk-muted">{t('market.commentNotifyHint')}</p>
    </>}
    {error && <p role="status" className="mk-muted">{error}</p>}
  </div>
}

function MarketDiscussionBody({ item }: { item: MarketDetail }) {
  const { t } = useI18n()
  const [comments, setComments] = useState<MarketComment[]>([])
  const [hasMore, setHasMore] = useState(false)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [accountId, setAccountId] = useState<string | null>(null)
  const [signedIn, setSignedIn] = useState(false)
  const [draft, setDraft] = useState('')
  const [reply, setReply] = useState<MarketComment | null>(null)
  const [editing, setEditing] = useState<MarketComment | null>(null)
  const [busy, setBusy] = useState(false)
  const reload = useCallback(async (offset = 0) => {
    setLoading(true); setError('')
    try {
      const data = await readMarketResource<{ comments: MarketComment[]; hasMore: boolean }>(item.id, 'comments', offset)
      setComments(old => offset ? [...old, ...data.comments.filter(c => !old.some(x => x.id === c.id))] : data.comments)
      setHasMore(data.hasMore)
    } catch (e: any) { setError(e.status === 401 ? t('market.commentLogin') : e.message) } finally { setLoading(false) }
  }, [item.id, t])
  useEffect(() => { let alive = true; void reload(); void marketAccountRequest<{ id: string }>('/auth/me').then(user => { if (alive) { setSignedIn(true); setAccountId(user.id) } }).catch(() => { if (alive) setSignedIn(false) }); return () => { alive = false } }, [reload])
  const send = async () => {
    if (busy || !draft.trim()) return
    setBusy(true); setError('')
    try {
      await marketAccountRequest(`/market/items/${encodeURIComponent(item.id)}/comments${editing ? `/${encodeURIComponent(editing.id)}` : ''}`, editing ? 'PATCH' : 'POST',
        { content: draft, ...(!editing ? { parentId: reply?.id || null, pluginVersion: item.latestVersion } : {}) })
      setDraft(''); setReply(null); setEditing(null); await reload()
    } catch (e: any) { setError(e.status === 401 ? t('market.commentLogin') : e.message) } finally { setBusy(false) }
  }
  const remove = async (comment: MarketComment) => {
    if (busy || !window.confirm(t('market.commentDeleteConfirm'))) return
    setBusy(true)
    try { await marketAccountRequest(`/market/items/${item.id}/comments/${comment.id}`, 'DELETE'); await reload() } catch (e: any) { setError(e.message) } finally { setBusy(false) }
  }
  const earlierReplies = async (root: MarketComment) => {
    if (busy) return
    setBusy(true)
    try {
      const data = await readMarketResource<{ replies: MarketComment[]; hasMore: boolean }>(item.id, `comments/${root.id}/replies`, root.replies?.length || 0)
      setComments(rows => rows.map(row => row.id === root.id ? { ...row, replies: [...data.replies.filter(reply => !row.replies?.some(old => old.id === reply.id)), ...(row.replies || [])], repliesHasMore: data.hasMore } : row))
    } catch (e: any) { setError(e.message) } finally { setBusy(false) }
  }
  const cancel = () => { setReply(null); setEditing(null); setDraft('') }
  const render = (comment: MarketComment) => <article key={comment.id} className="mk-comment" data-comment-id={comment.id}>
    <div className="mk-comment-meta"><strong>{comment.username}</strong>{comment.isAuthor && <span className="mk-compat">{t('market.commentAuthor')}</span>}{comment.pluginVersion && <span>v{comment.pluginVersion}</span>}<time>{formatDateTime(comment.createdAt)}</time></div>
    <p className={comment.deleted ? 'mk-muted' : ''}>{comment.deleted ? t('market.commentDeleted') : comment.content}</p>
    {!comment.deleted && signedIn && <div className="mk-comment-actions">
      <button className="btn sm ghost" disabled={busy} onClick={() => { setReply(comment); setEditing(null); setDraft('') }}>{t('market.commentReply')}</button>
      {accountId === comment.userId && <><button className="btn sm ghost" disabled={busy} onClick={() => { setEditing(comment); setReply(null); setDraft(comment.content) }}>{t('market.commentEdit')}</button><button className="btn sm ghost" disabled={busy} onClick={() => void remove(comment)}>{t('market.commentDelete')}</button></>}
    </div>}
  </article>
  return <section className="mk-discussion">
    <MarketNotifications itemId={item.id} />
    {error && <p role="alert">{error} <button className="btn sm" onClick={() => void reload()}>{t('market.retry')}</button></p>}
    {!loading && !comments.length && !error && <p className="mk-muted">{t('market.commentEmpty')}</p>}
    {comments.map(comment => <div key={comment.id} className="mk-comment-thread">{render(comment)}<div className="mk-comment-replies">{comment.repliesHasMore && <button className="btn sm" disabled={busy} onClick={() => void earlierReplies(comment)}>{t('market.moreReplies')}</button>}{comment.replies?.map(render)}</div></div>)}
    {loading && <p role="status">{t('market.loading')}</p>}
    {hasMore && <button className="btn sm" disabled={loading} onClick={() => void reload(comments.length)}>{t('market.moreComments')}</button>}
    {signedIn ? <form className="mk-comment-compose" onSubmit={e => { e.preventDefault(); void send() }}>
      {(reply || editing) && <div>{t(editing ? 'market.commentEdit' : 'market.commentReply')} · {(reply || editing)?.username}<button type="button" className="btn sm ghost" onClick={cancel}>{t('market.commentCancel')}</button></div>}
      <textarea aria-label={t('market.comments')} placeholder={t('market.commentPlaceholder')} value={draft} maxLength={2000} rows={3} disabled={busy} onChange={e => setDraft(e.target.value)} />
      <div><span className="mk-muted">{draft.length}/2000</span><button className="btn sm primary" disabled={busy || !draft.trim()}>{t(editing ? 'market.commentSave' : 'market.commentPost')}</button></div>
    </form> : <p className="mk-muted">{t('market.commentLogin')}</p>}
  </section>
}

export function MarketVersions({ item, appVersion, onInstall, installing }: { item: MarketDetail; appVersion: string; onInstall(version: string): void; installing?: boolean }) {
  const { t } = useI18n()
  const [versions, setVersions] = useState<Array<MarketDetail & { version: string; createdAt: string }>>([])
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(true)
  useEffect(() => { let alive = true; void readMarketResource<{ versions: typeof versions }>(item.id, 'versions').then(r => { if (alive) setVersions(r.versions) }).catch(e => { if (alive) setError(e.message) }).finally(() => { if (alive) setLoading(false) }); return () => { alive = false } }, [item.id])
  return <section className="mk-version-list">{loading && <p role="status">{t('market.loading')}</p>}{error && <p role="alert">{error}</p>}{!loading && !error && !versions.length && <p className="mk-muted">{t('market.versionEmpty')}</p>}
    {versions.map(version => <article key={version.version} className="mk-version-row"><div><strong>v{version.version}</strong>{version.version === item.latestVersion && <span className="mk-muted"> · {t('market.currentVersion')}</span>}<p>{formatDateTime(version.createdAt)} · Forsion {requirementsText(version)}</p><MarketRequirements item={version} version={appVersion} /></div><button className="btn sm" disabled={installing || ['version', 'platform'].includes(marketplaceCompatibility(version, appVersion, marketPlatform()))} onClick={() => onInstall(version.version)}>{t('market.installVersion')}</button></article>)}
  </section>
}

function useMarketAccountEpoch() {
  const [epoch, setEpoch] = useState(0)
  useEffect(() => { const reset = () => setEpoch(e => e + 1); const off = window.tangu?.onAuthChanged?.(reset); const before = window.tangu?.onAuthWillChange?.(async () => { reset() }); return () => { off?.(); before?.() } }, [])
  return epoch
}
export function MarketNotifications({ itemId }: { itemId?: string }) { const epoch = useMarketAccountEpoch(); return <MarketNotificationsBody key={epoch} itemId={itemId} /> }
export function MarketDiscussion({ item }: { item: MarketDetail }) { const epoch = useMarketAccountEpoch(); return <MarketDiscussionBody key={`${item.id}:${epoch}`} item={item} /> }
