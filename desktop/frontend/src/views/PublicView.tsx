/** Public View —— 集中管理用户「已发布/已分享」的内容：
 *   1. Forsion Connect 托管的网页应用（window.tangu.connectList / connectUnpublish）
 *   2. Amadeus 公开发布的笔记只读链接（window.amadeusCollab.listAllShares → publishes）
 *   3. Amadeus 协作共享的页面（同上 → pageShares）
 *  纯渲染端：每段独立加载，宿主能力缺失（Tangu Web 等）时降级为「不可用」占位，不崩。 */
import { useCallback, useEffect, useState } from 'react'
import { Rocket, Globe, FileText, Users, RotateCw, ExternalLink, Copy, Check, Trash2, Loader2 } from 'lucide-react'
import type { ViewProps } from '@lcl/engine'
import { useI18n } from '../i18n'

interface Row {
  key: string
  title: string
  sub: string
  url: string | null
  disabled?: boolean
  onRemove?: () => Promise<void>
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

function Section(props: {
  icon: React.ReactNode
  title: string
  desc: string
  loading: boolean
  unavailable: boolean
  rows: Row[]
  copiedKey: string | null
  onCopy: (k: string, url: string) => void
}) {
  const { t } = useI18n()
  const [confirm, setConfirm] = useState<string | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [rowErr, setRowErr] = useState<{ key: string; msg: string } | null>(null)
  return (
    <div className="pv-section">
      <div className="pv-sec-head">
        {props.icon}
        <div className="pv-sec-titles">
          <div className="pv-sec-title">{props.title}</div>
          <div className="pv-sec-desc">{props.desc}</div>
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
                  <div className="pv-row" key={r.key}>
                    <div className="pv-row-main">
                      <div className="pv-row-title">{r.title}{r.disabled && <span className="pv-badge">{t('public.disabled')}</span>}</div>
                      <div className="pv-row-sub">{rowErr?.key === r.key ? <span className="pv-rowerr">{rowErr.msg}</span> : r.sub}</div>
                    </div>
                    <div className="pv-row-actions">
                      {r.url && <a className="icon-btn" href={r.url} target="_blank" rel="noreferrer" title={t('public.open')}><ExternalLink size={14} /></a>}
                      {r.url && (
                        <button className="icon-btn" title={t('public.copy')} onClick={() => props.onCopy(r.key, r.url!)}>
                          {props.copiedKey === r.key ? <Check size={14} /> : <Copy size={14} />}
                        </button>
                      )}
                      {r.onRemove && (
                        <button
                          className="icon-btn pv-del" disabled={busy === r.key}
                          title={t('public.unpublish')}
                          onClick={async () => {
                            if (confirm !== r.key) { setConfirm(r.key); setTimeout(() => setConfirm((c) => (c === r.key ? null : c)), 2500); return }
                            setConfirm(null); setBusy(r.key); setRowErr((e) => (e?.key === r.key ? null : e))
                            try { await r.onRemove!() }
                            catch (e) { setRowErr({ key: r.key, msg: (e as Error)?.message || '操作失败' }) }
                            finally { setBusy((b) => (b === r.key ? null : b)) }
                          }}
                        >
                          {busy === r.key ? <Loader2 size={14} className="pv-spin" /> : confirm === r.key ? <span className="pv-confirm">{t('public.confirm')}</span> : <Trash2 size={14} />}
                        </button>
                      )}
                    </div>
                  </div>
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
      setSites((r.apps || []).map((a) => ({
        key: `site:${a.slug}`,
        title: a.name || a.slug,
        sub: `${handle}/${a.slug}`,
        url: base && handle ? `${base}/apps/${handle}/${a.slug}/` : null,
        disabled: a.status !== 'active',
        onRemove: async () => { const rr = await window.tangu!.connectUnpublish?.(a.slug); if (rr && !rr.ok) throw new Error(rr.detail || '下架失败'); await loadSites() },
      })))
    } catch { setSites([]) } finally { setSitesLoading(false) }
  }, [])

  const loadCollab = useCallback(async () => {
    if (!window.amadeusCollab?.listAllShares) { setPubs([]); setShares([]); return }
    setCollabLoading(true)
    try {
      const r = await window.amadeusCollab.listAllShares()
      const linkBase = r.linkBase || ''
      setPubs((r.publishes || []).map((p) => ({
        key: `pub:${p.token}`,
        title: pageTitle(p.path),
        sub: p.vaultName || p.path,
        url: linkBase ? `${linkBase}/share/${p.token}` : null,
        // 跨库撤销：带 p.vaultId（默认 revokePublish 只作用于 own vault，会撤错库）。
        onRemove: async () => { await window.amadeusCollab!.revokePublishIn?.(p.vaultId, p.token); await loadCollab() },
      })))
      setShares((r.pageShares || []).map((s, i) => {
        const token = String((s.invite_token ?? s.inviteToken ?? s.token ?? '') as string)
        const id = String((s.id ?? '') as string)
        const vaultId = String((s.vaultId ?? '') as string)
        const path = String((s.root_path ?? s.rootPath ?? s.path ?? '') as string)
        const role = String((s.invite_role ?? s.role ?? '') as string)
        const vaultName = String((s.vaultName ?? '') as string)
        return {
          key: `share:${id || token || i}`,
          title: pageTitle(path),
          sub: [vaultName, role].filter(Boolean).join(' · ') || path,
          url: token && linkBase ? `${linkBase}/invite/${token}` : null,
          onRemove: id && vaultId ? async () => { await window.amadeusCollab!.revokePageShareIn?.(vaultId, id); await loadCollab() } : undefined,
        }
      }))
    } catch { setPubs([]); setShares([]) } finally { setCollabLoading(false) }
  }, [])

  const refresh = useCallback(() => { setNeedLogin(false); void loadSites(); void loadCollab() }, [loadSites, loadCollab])
  useEffect(() => { refresh() }, [refresh])

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
      {needLogin && sites?.length === 0 && <div className="pv-notice">{t('public.needLogin')}</div>}
      <div className="pv-body">
        <Section
          icon={<Globe size={15} />} title={t('public.sites')} desc={t('public.sitesDesc')}
          loading={sitesLoading} unavailable={!hasConnect} rows={sites || []} copiedKey={copiedKey} onCopy={onCopy}
        />
        <Section
          icon={<FileText size={15} />} title={t('public.published')} desc={t('public.publishedDesc')}
          loading={collabLoading} unavailable={!hasCollab} rows={pubs || []} copiedKey={copiedKey} onCopy={onCopy}
        />
        <Section
          icon={<Users size={15} />} title={t('public.shared')} desc={t('public.sharedDesc')}
          loading={collabLoading} unavailable={!hasCollab} rows={shares || []} copiedKey={copiedKey} onCopy={onCopy}
        />
      </div>
    </div>
  )
}
