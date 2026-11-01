/** 共享与发布总览 —— 集中管理用户共享、发布和收到的内容：
 *   1. Amadeus 协作共享的页面（window.amadeusCollab.listAllShares → pageShares，含 30 天内已到期的）
 *   2. 别人共享给我的页面（sharedWithMe），可退出
 *   3. Amadeus 公开发布的笔记只读链接（listAllShares → publishes）
 *   4. Forsion Connect 托管的网页应用（window.tangu.connectList / connectUnpublish）
 *  纯渲染端：每段独立加载，宿主能力缺失（Tangu Web 等）时降级为「不可用」占位，不崩。 */
import { Fragment, useCallback, useEffect, useState, type ReactNode } from 'react'
import { Rocket, Globe, FileText, Users, RotateCw, ExternalLink, Copy, Check, Trash2, Loader2, Store, CircleMinus, LogIn, LogOut, ChevronDown, Share2 } from 'lucide-react'
import type { ViewProps } from '@lcl/engine'
import { askString } from '@amadeus/components/askString'
import { registerMessages, useI18n } from '../i18n'
import { useApp } from '../stores/appStore'
import { EmptyState } from '../components/EmptyState'
import { byExpiry, daysUntil } from '../amadeus/lib/shareState'
import { localPathFor, useEntrySync } from '../stores/entrySyncStore'
import { refreshAfterLeave } from '../stores/sharedVaultStore'
import { usePageStore } from '@amadeus/store/pageStore'
import type { AmadeusPageShare, AmadeusSharedItem } from '../types'

registerMessages({
  'publicview.opFailed': { zh: '操作失败', en: 'Something went wrong' },
  'publicview.unpublishFailed': { zh: '下架失败', en: 'Could not unpublish' },
  'publicview.signedOutTitle': { zh: '登录后，这里列出你发布过的东西', en: 'Sign in to see what you have published' },
  'publicview.signedOutLine': { zh: '发布过的网站和笔记都在这里，可以随时更新或下线。', en: 'Published sites and notes show up here; update or unpublish them any time.' },
  'publicview.signIn': { zh: '登录 Forsion', en: 'Sign in to Forsion' },
  'publicview.tabAll': { zh: '全部 · {n}', en: 'All · {n}' },
  'publicview.tabMine': { zh: '我共享的 · {n}', en: 'Shared by me · {n}' },
  'publicview.tabReceived': { zh: '与我共享 · {n}', en: 'Shared with me · {n}' },
  'publicview.tabPublished': { zh: '已发布 · {n}', en: 'Published · {n}' },
  'publicview.tabExpired': { zh: '已到期 · {n}', en: 'Expired · {n}' },
  'publicview.received': { zh: '与我共享', en: 'Shared with me' },
  'publicview.expired': { zh: '已到期', en: 'Expired' },
  'publicview.expiredDesc': { zh: '保留 30 天，可以续期，不用重新邀请', en: 'Kept for 30 days. Renew without inviting anyone again.' },
  'publicview.noneJoined': { zh: '还没有人加入', en: 'Nobody has joined' },
  'publicview.linkEditor': { zh: '链接可编辑', en: 'Link can edit' },
  'publicview.linkViewer': { zh: '链接只读', en: 'Link is read-only' },
  'publicview.hasPassword': { zh: '带密码', en: 'Password' },
  'publicview.noExpiry': { zh: '长期', en: 'No end date' },
  'publicview.dueToday': { zh: '今天到期', en: 'Ends today' },
  'publicview.dueTomorrow': { zh: '明天到期', en: 'Ends tomorrow' },
  'publicview.dueDays': { zh: '{n} 天后到期', en: 'Ends in {n} days' },
  'publicview.roleEditor': { zh: '可编辑', en: 'Can edit' },
  'publicview.roleViewer': { zh: '只读', en: 'Read-only' },
  'publicview.renew': { zh: '续期 7 天', en: 'Renew 7 days' },
  'publicview.leave': { zh: '退出共享', en: 'Leave share' },
  'publicview.stop': { zh: '停止共享', en: 'Stop sharing' },
  'publicview.members': { zh: '参与者', en: 'Participants' },
  'publicview.removeMember': { zh: '移除', en: 'Remove' },
  'publicview.pageMoved': { zh: '打不开这一页：它在另一个智库里，或已被移动', en: 'Could not open this page. It may be in another vault or may have moved.' },
})

interface Row {
  key: string
  title: string
  sub: string
  url: string | null
  disabled?: boolean
  /** 笔记在应用里打开;没有它时打开链接。 */
  onOpen?: () => void
  /** 这些行的副标题是句子,不是路径。 */
  plainSub?: boolean
  warn?: string
  avatars?: string[]
  /** 展开后的内容(参与者)。 */
  detail?: ReactNode
  /** 已到期的行:一键续期。 */
  renew?: () => Promise<void>
  removeIcon?: 'leave'
  removeTitle?: string
  onRemove?: () => Promise<void>
  /** 商店上架状态（仅 Connect 站点行）：badge + 一个管理动作（申请上架/重新申请 或 撤回/下架）。 */
  listing?: { label: string; action?: { title: string; kind: 'withdraw' | 'apply'; run: () => Promise<void> } }
}

function useCopied(): [string | null, (k: string, url: string) => void] {
  const [copied, setCopied] = useState<string | null>(null)
  const copy = useCallback((k: string, url: string) => {
    navigator.clipboard.writeText(url).then(() => { setCopied(k); setTimeout(() => setCopied((c) => (c === k ? null : c)), 1500) }).catch(() => {})
  }, [])
  return [copied, copy]
}

function pageTitle(p: string): string {
  const base = String(p || '').replace(/\/+$/, '').split('/').pop() || p
  return base.replace(/\.(md|fd)$/i, '') || p
}

/** 共享行展开后的参与者:改角色、移除、停止共享都就地做,不用回到那一页。 */
function ShareDetail({ share, onChange }: { share: AmadeusPageShare & { vaultId: string }; onChange: () => Promise<void> }) {
  const { t } = useI18n()
  const collab = window.amadeusCollab!
  const act = (p: Promise<unknown>): void => {
    void p.then(onChange).catch(() => useApp.getState().toast(t('publicview.opFailed'), true))
  }
  return (
    <div className="pv-members">
      {share.participants.map((m) => (
        <div className="pv-member" key={m.userId}>
          <span className="pv-member-name">{m.username ?? m.userId.slice(0, 8)}</span>
          <select aria-label={t('publicview.members')} value={m.role} onChange={(e) => act(collab.setParticipantRole(share.id, m.userId, e.target.value as 'editor' | 'viewer', share.vaultId))}>
            <option value="editor">{t('publicview.roleEditor')}</option>
            <option value="viewer">{t('publicview.roleViewer')}</option>
          </select>
          <button className="icon-btn pv-del" title={t('publicview.removeMember')} onClick={() => act(collab.removeParticipant(share.id, m.userId, share.vaultId))}><Trash2 size={13} /></button>
        </div>
      ))}
      <button className="pv-stop" onClick={() => act(collab.revokePageShareIn(share.vaultId, share.id))}>{t('publicview.stop')}</button>
    </div>
  )
}

function Section(props: {
  icon: React.ReactNode
  title: string
  desc?: string
  loading: boolean
  unavailable: boolean
  rows: Row[]
  copiedKey: string | null
  onCopy: (k: string, url: string) => void
}) {
  const { t } = useI18n()
  const [confirm, setConfirm] = useState<string | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [busyL, setBusyL] = useState<string | null>(null)
  const [rowErr, setRowErr] = useState<{ key: string; msg: string } | null>(null)
  const [expanded, setExpanded] = useState<string | null>(null)
  return (
    <div className="pv-section">
      <div className="pv-sec-head">
        {props.icon}
        <div className="pv-sec-titles">
          <div className="pv-sec-title">{props.title}</div>
          {props.desc && <div className="pv-sec-desc">{props.desc}</div>}
        </div>
        <span className="pv-count">{props.unavailable ? '' : props.rows.length}</span>
      </div>
      {props.unavailable
        ? <div className="pv-empty">{t('public.unavailable')}</div>
        : props.loading
          ? <div className="pv-empty"><Loader2 size={14} className="pv-spin" /></div>
          : props.rows.length === 0
            ? <div className="pv-empty">{t('public.empty')}</div>
            : (
              <div className="pv-rows">
                {props.rows.map((r) => (
                  <Fragment key={r.key}>
                  <div className="pv-row">
                    <div className="pv-row-main">
                      <div className="pv-row-title">
                        {r.title}
                        {r.disabled && <span className="pv-badge">{t('public.disabled')}</span>}
                        {r.listing && <span className="pv-badge">{r.listing.label}</span>}
                      </div>
                      <div className={`pv-row-sub${r.plainSub ? ' is-plain' : ''}`}>
                        {rowErr?.key === r.key ? <span className="pv-rowerr">{rowErr.msg}</span> : r.sub}
                        {r.warn && rowErr?.key !== r.key && <> · <span className="pv-warn">{r.warn}</span></>}
                      </div>
                    </div>
                    {r.avatars && r.avatars.length > 0 && <span className="pv-dots">{r.avatars.slice(0, 3).map((a, i) => <span className="pv-dot" key={i}>{a}</span>)}</span>}
                    <div className="pv-row-actions">
                      {r.renew && (
                        <button
                          className="pv-renew" disabled={busyL === r.key}
                          onClick={async () => {
                            setBusyL(r.key); setRowErr((e) => (e?.key === r.key ? null : e))
                            try { await r.renew!() }
                            catch (e) { setRowErr({ key: r.key, msg: (e as Error)?.message || t('publicview.opFailed') }) }
                            finally { setBusyL((b) => (b === r.key ? null : b)) }
                          }}
                        >{t('publicview.renew')}</button>
                      )}
                      {r.listing?.action && (
                        <button
                          className="icon-btn" disabled={busyL === r.key} title={r.listing.action.title}
                          onClick={async () => {
                            setBusyL(r.key); setRowErr((e) => (e?.key === r.key ? null : e))
                            try { await r.listing!.action!.run() }
                            catch (e) { setRowErr({ key: r.key, msg: (e as Error)?.message || t('publicview.opFailed') }) }
                            finally { setBusyL((b) => (b === r.key ? null : b)) }
                          }}
                        >
                          {busyL === r.key ? <Loader2 size={14} className="pv-spin" /> : r.listing.action.kind === 'apply' ? <Store size={14} /> : <CircleMinus size={14} />}
                        </button>
                      )}
                      {r.onOpen
                        ? <button className="icon-btn" title={t('public.open')} onClick={r.onOpen}><ExternalLink size={14} /></button>
                        : r.url && <a className="icon-btn" href={r.url} target="_blank" rel="noreferrer" title={t('public.open')}><ExternalLink size={14} /></a>}
                      {r.url && (
                        <button className="icon-btn" title={t('public.copy')} onClick={() => props.onCopy(r.key, r.url!)}>
                          {props.copiedKey === r.key ? <Check size={14} /> : <Copy size={14} />}
                        </button>
                      )}
                      {r.onRemove && (
                        <button
                          className="icon-btn pv-del" disabled={busy === r.key}
                          title={r.removeTitle ?? t('public.unpublish')}
                          onClick={async () => {
                            if (confirm !== r.key) { setConfirm(r.key); setTimeout(() => setConfirm((c) => (c === r.key ? null : c)), 2500); return }
                            setConfirm(null); setBusy(r.key); setRowErr((e) => (e?.key === r.key ? null : e))
                            try { await r.onRemove!() }
                            catch (e) { setRowErr({ key: r.key, msg: (e as Error)?.message || t('publicview.opFailed') }) }
                            finally { setBusy((b) => (b === r.key ? null : b)) }
                          }}
                        >
                          {busy === r.key ? <Loader2 size={14} className="pv-spin" /> : confirm === r.key ? <span className="pv-confirm">{t('public.confirm')}</span> : r.removeIcon === 'leave' ? <LogOut size={14} /> : <Trash2 size={14} />}
                        </button>
                      )}
                      {r.detail && (
                        <button className="icon-btn" aria-expanded={expanded === r.key} title={t('publicview.members')} onClick={() => setExpanded((k) => (k === r.key ? null : r.key))}>
                          <ChevronDown size={14} />
                        </button>
                      )}
                    </div>
                  </div>
                  {expanded === r.key && r.detail}
                  </Fragment>
                ))}
              </div>
            )}
    </div>
  )
}

export function PublicView(_: ViewProps) {
  const { t } = useI18n()
  const [copiedKey, onCopy] = useCopied()

  const hasConnect = !!window.tangu?.connectList
  const hasCollab = !!window.amadeusCollab?.listAllShares

  const [sites, setSites] = useState<Row[] | null>(null)
  const [sitesLoading, setSitesLoading] = useState(false)
  const [pubs, setPubs] = useState<Row[] | null>(null)
  const [shares, setShares] = useState<Row[] | null>(null)
  const [expired, setExpired] = useState<Row[] | null>(null)
  const [received, setReceived] = useState<Row[] | null>(null)
  const [tab, setTab] = useState<'all' | 'mine' | 'received' | 'published' | 'expired'>('all')
  const [collabLoading, setCollabLoading] = useState(false)
  const [needLogin, setNeedLogin] = useState(false)

  const loadSites = useCallback(async () => {
    if (!window.tangu?.connectList) { setSites([]); return }
    setSitesLoading(true)
    try {
      const r = await window.tangu.connectList()
      if (!r.ok) { if (r.code === 'not_logged_in') setNeedLogin(true); setSites([]); return }
      const base = r.base || ''
      const handle = r.handle || ''
      // askString 的 Host 挂在 AmadeusOverlays 里，没有 window.amadeus 的宿主（Web/移动端）不给上架入口，免得弹窗永不返回。
      const canList = !!window.tangu?.connectListingApply && !!window.amadeus
      setSites((r.apps || []).map((a) => {
        // 商店上架状态：未上架/已驳回 → 填简介申请（驳回时预填原简介）；审核中/已上架 → 撤回·下架。
        const ls = a.listing_status || null
        const listing: Row['listing'] = canList
          ? {
              label: ls === 'pending' ? t('coding.listingPending') : ls === 'approved' ? t('coding.listingApproved') : ls === 'rejected' ? t('coding.listingRejected') : t('coding.listingNone'),
              action: ls === 'pending' || ls === 'approved'
                ? {
                    title: ls === 'approved' ? t('coding.listingDelist') : t('coding.listingWithdraw'), kind: 'withdraw',
                    run: async () => {
                      const rr = await window.tangu!.connectListingWithdraw?.(a.slug)
                      if (rr && !rr.ok) throw new Error(rr.detail || t('publicview.opFailed'))
                      await loadSites()
                    },
                  }
                : {
                    title: ls === 'rejected' ? t('coding.listingReapply') : t('coding.listingApply'), kind: 'apply',
                    run: async () => {
                      const summary = await askString(
                        ls === 'rejected' ? t('coding.listingReapply') : t('coding.listingApply'),
                        a.listing_summary || '',
                        { label: t('coding.listingSummaryPh'), confirmLabel: t('coding.listingSubmit') },
                      )
                      if (!summary) return
                      const rr = await window.tangu!.connectListingApply?.({ slug: a.slug, summary })
                      if (rr && !rr.ok) throw new Error(rr.detail || t('publicview.opFailed'))
                      await loadSites()
                    },
                  },
            }
          : undefined
        return {
          key: `site:${a.slug}`,
          title: a.name || a.slug,
          sub: ls === 'rejected' && a.listing_note ? `${handle}/${a.slug} · ${t('coding.listingNoteLabel', { note: a.listing_note })}` : `${handle}/${a.slug}`,
          url: base && handle ? `${base}/apps/${handle}/${a.slug}/` : null,
          disabled: a.status !== 'active',
          listing,
          onRemove: async () => { const rr = await window.tangu!.connectUnpublish?.(a.slug); if (rr && !rr.ok) throw new Error(rr.detail || t('publicview.unpublishFailed')); await loadSites() },
        }
      }))
    } catch { setSites([]) } finally { setSitesLoading(false) }
  }, [t])

  const loadCollab = useCallback(async () => {
    if (!window.amadeusCollab?.listAllShares) { setPubs([]); setShares([]); setExpired([]); setReceived([]); return }
    setCollabLoading(true)
    try {
      const collab = window.amadeusCollab
      const [r, mine, active] = await Promise.all([collab.listAllShares(), collab.sharedWithMe().catch(() => [] as AmadeusSharedItem[]), collab.activeVaultId().catch(() => '')])
      window.dispatchEvent(new Event('amadeus:shares-changed'))
      const linkBase = r.linkBase || ''
      // 笔记在应用里打开:Web 上别的库切过去直达,桌面按同步映射找到当前库里的文件。
      const openPage = async (vaultId: string, path: string, localPath?: string): Promise<void> => {
        if (!localPath && active && vaultId !== active) {
          if (window.amadeusSync) useApp.getState().toast(t('publicview.pageMoved'))
          else collab.switchVault(vaultId, path)
          return
        }
        if (localPath) await usePageStore.getState().switchVaultSide('cloud') // 共享镜像在云端侧
        const { vaultRoot, vaultSide } = usePageStore.getState()
        const target = localPath ?? localPathFor(useEntrySync.getState().vaults, vaultRoot, vaultSide, path)
        const { resolveDeepLink } = await import('../deepLinkInstall')
        await resolveDeepLink({ kind: 'space', ref: 'amadeus', params: {} })
        if (!target || !(await resolveDeepLink({ kind: 'note', ref: target, params: {} }))) useApp.getState().toast(t('publicview.pageMoved'))
      }
      const peopleOf = (s: AmadeusPageShare): string => s.participants.map((p) => p.username ?? p.userId.slice(0, 8)).join(', ') || t('publicview.noneJoined')
      const roleOf = (s: AmadeusPageShare): string => t(s.inviteRole === 'viewer' ? 'publicview.linkViewer' : 'publicview.linkEditor')
      const dueOf = (expiresAt: string | null | undefined): { text: string; soon: boolean } => {
        const days = daysUntil(expiresAt)
        if (days === null) return { text: t('publicview.noExpiry'), soon: false }
        if (days <= 1) return { text: t(days <= 0 ? 'publicview.dueToday' : 'publicview.dueTomorrow'), soon: true }
        return { text: t('publicview.dueDays', { n: days }), soon: days <= 2 }
      }
      const rowOf = (s: AmadeusPageShare & { vaultId: string }): Pick<Row, 'key' | 'title' | 'plainSub' | 'avatars' | 'onOpen' | 'detail'> => ({
        key: `share:${s.id}`,
        title: pageTitle(s.path),
        plainSub: true,
        avatars: s.participants.map((p) => (p.username ?? '?').slice(0, 1)),
        onOpen: () => void openPage(s.vaultId, s.path),
        detail: <ShareDetail share={s} onChange={loadCollab} />,
      })
      setPubs((r.publishes || []).map((p) => ({
        key: `pub:${p.token}`,
        title: pageTitle(p.path),
        sub: p.vaultName || p.path,
        url: linkBase ? `${linkBase}/share/${p.token}` : null,
        // 跨库撤销：带 p.vaultId（默认 revokePublish 只作用于 own vault，会撤错库）。
        onRemove: async () => { await window.amadeusCollab!.revokePublishIn?.(p.vaultId, p.token); await loadCollab() },
      })))
      const pageShares = r.pageShares || []
      setShares(pageShares.filter((s) => !s.expired).sort(byExpiry).map((s) => {
        const due = dueOf(s.expiresAt)
        return {
          ...rowOf(s),
          sub: [peopleOf(s), roleOf(s), s.hasPassword && t('publicview.hasPassword'), !due.soon && due.text].filter(Boolean).join(' · '),
          warn: due.soon ? due.text : undefined,
          url: linkBase ? `${linkBase}/invite/${s.inviteToken}` : null,
        }
      }))
      setExpired(pageShares.filter((s) => s.expired).map((s) => ({
        ...rowOf(s),
        sub: [peopleOf(s), roleOf(s)].join(' · '),
        url: null,
        renew: async () => { await collab.updatePageShare(s.id, { expiresDays: 7 }, s.vaultId); await loadCollab() },
      })))
      setReceived(mine.map((s) => ({
        key: `received:${s.vaultId}:${s.path}`,
        title: s.title,
        plainSub: true,
        sub: [s.ownerName, t(s.role === 'viewer' ? 'publicview.roleViewer' : 'publicview.roleEditor')].filter(Boolean).join(' · '),
        url: null,
        onOpen: () => void openPage(s.vaultId, s.path, s.localPath),
        removeIcon: 'leave' as const,
        removeTitle: t('publicview.leave'),
        onRemove: s.shareId ? async () => { await collab.leaveShare(s.shareId!, s.vaultId); await refreshAfterLeave(s.vaultId); await loadCollab() } : undefined,
      })))
    } catch { setPubs([]); setShares([]); setExpired([]); setReceived([]) } finally { setCollabLoading(false) }
  }, [t])

  const refresh = useCallback(() => { setNeedLogin(false); void loadSites(); void loadCollab() }, [loadSites, loadCollab])
  useEffect(() => { refresh() }, [refresh])

  const mineN = shares?.length ?? 0, receivedN = received?.length ?? 0, pubN = (pubs?.length ?? 0) + (sites?.length ?? 0), expiredN = expired?.length ?? 0
  const tabs = [
    ['all', 'publicview.tabAll', mineN + receivedN + pubN],
    ['mine', 'publicview.tabMine', mineN],
    ['received', 'publicview.tabReceived', receivedN],
    ['published', 'publicview.tabPublished', pubN],
    ['expired', 'publicview.tabExpired', expiredN],
  ] as const

  return (
    <div className="pv">
      <div className="pv-head">
        <Rocket size={16} />
        <div className="pv-titles">
          <div className="pv-title">{t('public.title')}</div>
          <div className="pv-subtitle">{t('public.subtitle')}</div>
        </div>
        <button className="icon-btn" title={t('public.refresh')} onClick={refresh}><RotateCw size={15} /></button>
      </div>
      {/* 没登录 = 不知道有没有发布过:别把三个分区画成「0 · 暂无内容」,给一个登录入口(W-02) */}
      {needLogin && sites?.length === 0 && <EmptyState icon={Rocket} title={t('publicview.signedOutTitle')} line={t('publicview.signedOutLine')} data-state="signed-out"
        action={window.tangu?.forsionLogin ? { label: t('publicview.signIn'), icon: LogIn, action: 'sign-in', onClick: () => useApp.getState().openSettings('forsion') } : null} />}
      {!(needLogin && sites?.length === 0) && <>
        <div className="pv-tabs" role="tablist">
          {tabs.map(([id, label, n]) => (id === 'expired' && n === 0 ? null : (
            <button key={id} role="tab" aria-selected={tab === id} className={`pv-tab${tab === id ? ' on' : ''}`} onClick={() => setTab(id)}>{t(label, { n })}</button>
          )))}
        </div>
        <div className="pv-body">
          {tab === 'expired' ? (
            <Section icon={<Users size={15} />} title={t('publicview.expired')} desc={t('publicview.expiredDesc')}
              loading={collabLoading} unavailable={!hasCollab} rows={expired || []} copiedKey={copiedKey} onCopy={onCopy} />
          ) : <>
            {(tab === 'all' || tab === 'mine') && (tab === 'mine' || (shares?.length ?? 0) > 0) && (
              <Section icon={<Users size={15} />} title={t('public.shared')} desc={t('public.sharedDesc')}
                loading={collabLoading} unavailable={!hasCollab} rows={shares || []} copiedKey={copiedKey} onCopy={onCopy} />
            )}
            {(tab === 'all' || tab === 'received') && (tab === 'received' || (received?.length ?? 0) > 0) && (
              <Section icon={<Share2 size={15} />} title={t('publicview.received')}
                loading={collabLoading} unavailable={!hasCollab} rows={received || []} copiedKey={copiedKey} onCopy={onCopy} />
            )}
            {(tab === 'all' || tab === 'published') && <>
              <Section icon={<FileText size={15} />} title={t('public.published')} desc={t('public.publishedDesc')}
                loading={collabLoading} unavailable={!hasCollab} rows={pubs || []} copiedKey={copiedKey} onCopy={onCopy} />
              <Section icon={<Globe size={15} />} title={t('public.sites')} desc={t('public.sitesDesc')}
                loading={sitesLoading} unavailable={!hasConnect} rows={sites || []} copiedKey={copiedKey} onCopy={onCopy} />
            </>}
          </>}
        </div>
      </>}
    </div>
  )
}
