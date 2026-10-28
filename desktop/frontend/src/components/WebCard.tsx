/**
 * 网页卡片的卡身(网页卡片方案 A + D、第二轮 1,10-28):缩略图、名字 + 状态、地址行、说明、按钮。
 * 宿主原生的本地网页卡 / 服务卡直接用;Forsion Extend 的发布结果卡、我的网页列表卡经 ctx.ui.mountWebCard 挂同一份。
 * 缩略图走主进程出图(window.tangu.pageThumb,线上页带 X-Frame-Options 嵌不进 iframe);拿不到就画图标占位。
 */
import { useEffect, useState, type ReactNode } from 'react'
import { FileText, Globe, Monitor, MoreHorizontal } from 'lucide-react'
import { registerMessages, useI18n } from '../i18n'
import { openPluginContextMenu, type PluginMenuEntry } from '../amadeus/plugins/contextMenuSurface'
import './WebCard.css'

registerMessages({ 'webcard.more': { zh: '更多', en: 'More' } })

export interface WebCardAction {
  key?: string
  label: string
  icon?: ReactNode
  variant?: 'default' | 'primary' | 'danger'
  disabled?: boolean
  onClick(): void
}

/** ⋯ 菜单的一行(宿主菜单的形状):{ kind: 'item', label, run, icon? } / { kind: 'sep' } / { kind: 'head', label } */
export type WebCardMenuEntry = PluginMenuEntry

export interface WebCardProps {
  layout?: 'card' | 'row'
  name: string
  status?: { label: string; tone?: 'neutral' | 'ok' | 'muted' | 'danger'; dot?: 'running' | 'stopped' | 'failed' }
  address?: { text: string; icon?: 'globe' | 'file'; struck?: boolean; muted?: boolean }
  note?: string
  thumbnail?: { url: string; version?: string } | null
  placeholder?: ReactNode
  actions?: WebCardAction[]
  trailing?: WebCardAction[]
  moreLabel?: string
  /** ⋯ 菜单;空 / 不给 = 不画 ⋯ */
  menu?: WebCardMenuEntry[]
  /** 菜单项怎么跑(插件那份经 guard:停用后不再调它) */
  guard?: (run: () => void) => void
  /** 出图时读到的页面 <title>(本地卡 / 服务卡拿它当名字) */
  onTitle?(title: string): void
}

const DOT = { running: 'running', stopped: 'killed', failed: 'failed' } as const

/** 同一 url + version 只问一次主进程;主进程那边还有自己的缓存。 */
export function usePageThumb(url: string | undefined, version = ''): { dataUrl: string; title: string } | null {
  const [shot, setShot] = useState<{ key: string; v: { dataUrl: string; title: string } | null } | null>(null)
  const key = url ? `${version}\n${url}` : ''
  useEffect(() => {
    if (!url) return
    const cap = window.tangu?.pageThumb
    if (!cap) return
    let live = true
    cap(url, version).then((v) => { if (live) setShot({ key, v }) }, () => { if (live) setShot({ key, v: null }) })
    return () => { live = false }
  }, [key]) // eslint-disable-line react-hooks/exhaustive-deps
  return shot && shot.key === key ? shot.v : null
}

function Btn({ a }: { a: WebCardAction }) {
  return (
    <button type="button" className={`btn sm${a.variant === 'primary' ? ' primary' : a.variant === 'danger' ? ' danger' : ''}`}
      disabled={a.disabled} data-act={a.key} onClick={a.onClick}>
      {a.icon}{a.label}
    </button>
  )
}

export function WebCard(p: WebCardProps) {
  const { t } = useI18n()
  const moreLabel = p.moreLabel ?? t('webcard.more')
  const shot = usePageThumb(p.thumbnail?.url, p.thumbnail?.version)
  const title = shot?.title
  useEffect(() => { if (title) p.onTitle?.(title) }, [title]) // eslint-disable-line react-hooks/exhaustive-deps
  const row = p.layout === 'row'
  const AddrIcon = p.address?.icon === 'file' ? FileText : Globe
  const more = p.menu?.length ? (
    <button type="button" className="btn sm wc-more" data-act="web-card-more" aria-label={moreLabel} title={moreLabel}
      onClick={(e) => { openPluginContextMenu({ anchor: e.currentTarget, align: 'end' }, p.menu!, p.guard ?? ((run) => run())) }}>
      <MoreHorizontal size={14} />
    </button>
  ) : null
  const st = p.status
  return (
    <div className={row ? 'wc-row' : 'wc'} data-web-card={row ? 'row' : 'card'}>
      <div className={`wc-thumb${shot ? '' : ' ph'}`}>
        {shot ? <img src={shot.dataUrl} alt="" draggable={false} /> : (p.placeholder ?? <Monitor size={row ? 16 : 22} strokeWidth={1.6} />)}
      </div>
      <div className="wc-main">
        <div className="wc-top">
          <span className="wc-name" title={p.name}>{p.name}</span>
          {st && (
            <span className={`wc-pill${st.tone && st.tone !== 'neutral' ? ` ${st.tone}` : ''}`}>
              {st.dot && <span className="t2-bg-dot" data-st={DOT[st.dot]} />}{st.label}
            </span>
          )}
        </div>
        {p.address && (
          <div className={`wc-link${p.address.struck ? ' dead' : ''}${p.address.muted ? ' faint' : ''}`}>
            <AddrIcon size={12} /><span title={p.address.text}>{p.address.text}</span>
          </div>
        )}
        {!row && p.note && <div className="wc-meta">{p.note}</div>}
        {!row && (p.actions?.length || p.trailing?.length || more) ? (
          <div className="wc-acts">
            {p.actions?.map((a, i) => <Btn key={a.key ?? i} a={a} />)}
            <span className="sp" />
            {p.trailing?.map((a, i) => <Btn key={a.key ?? i} a={a} />)}
            {more}
          </div>
        ) : null}
      </div>
      {row && more}
    </div>
  )
}
