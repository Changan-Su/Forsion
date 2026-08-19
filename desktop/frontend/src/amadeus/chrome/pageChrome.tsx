/** 页面 chrome 共用件(2026-08-13 自 amadeusViews.tsx 原样搬出):封面横幅 / 封面选择器 /
 *  emoji 图标选择器。搬家动机:UnifiedPage(v4 统一编辑器)也要用,而 amadeusViews 渲染
 *  UnifiedPage —— 留在原处就是模块环。v3 路径(NoteTitle/编辑器)行为不变:所有新 props 均可缺省,
 *  缺省即原来的 pageStore 写法;unified 传显式 props 走自己的 fm 管线(绝不碰 pageStore)。 */
import { Fragment, useMemo, useState } from 'react'
import { Search } from 'lucide-react'
import { OverlayAt } from '@lcl/engine'
import { amadeus } from '@amadeus/api'
import { getAttachmentPrefs } from '@amadeus/lib/attachments'
import { usePageStore, useScopedPageStore } from '@amadeus/store/pageStore'
import { parseFmObject } from '@amadeus-shared/db/pageFrontmatter'
import { joinRel, toAssetUrl } from '@amadeus-shared/assets'
import { EMOJI_ALL, EMOJI_GROUPS, searchEmoji } from '@amadeus/lib/emoji'

export const UNTITLED_RE = /^(未命名|untitled)(-\d+)?$/i

/** 活动页 fm 的 cover 值(http URL 或 vault 相对路径);无 = null。 */
export function useActiveCover(): string | null {
  const fmExtra = usePageStore((s) => s.manifest?.fmExtra ?? '')
  return useMemo(() => {
    const v = parseFmObject(fmExtra).cover
    return typeof v === 'string' && v.trim() ? v.trim() : null
  }, [fmExtra])
}

/** 活动页封面纵向焦点(fm cover_y,0-100);缺省 50(居中)。 */
export function useActiveCoverY(): number {
  const fmExtra = usePageStore((s) => s.manifest?.fmExtra ?? '')
  return useMemo(() => {
    const v = parseFmObject(fmExtra).cover_y
    const n = typeof v === 'number' ? v : typeof v === 'string' ? parseFloat(v) : NaN
    return Number.isFinite(n) ? Math.max(0, Math.min(100, n)) : 50
  }, [fmExtra])
}

/** Notion/pixel-banner 式封面横幅:收进正文区、四角圆角裁切;上下拖动图片调纵向焦点(存 fm cover_y);
 *  底部柔和渐变逐渐融入页面背景色,与正文自然过渡;悬停出「更换/移除」。 */
export function NoteCover({ page, cover: coverProp, coverY, onSetCover, onSetCoverY }: {
  /** 缺省 = pageStore.activePage(v3 老路径);unified 传显式路径。 */
  page?: string
  cover?: string | null
  coverY?: number
  onSetCover?: (cover: string | null) => void
  onSetCoverY?: (y: number) => void
} = {}) {
  const activePage = usePageStore((s) => s.activePage)
  const storeCover = useActiveCover()
  const storeY = useActiveCoverY()
  // 写操作走**本面板**的 store:插件文件视图(画布文档模式)也挂这套 chrome,活动面板门面
  // (ps())在那里解析到隔壁编辑器面板,封面会写进别人那篇(2026-08-14 scope 化后必须如此)。
  const scoped = useScopedPageStore()
  const [pick, setPick] = useState<{ x: number; y: number } | null>(null)
  const [dragY, setDragY] = useState<number | null>(null)
  const [reposition, setReposition] = useState(false) // 「调整位置」模式:默认图片锁定,点按钮才解锁可拖
  const target = page ?? activePage
  const cover = coverProp !== undefined ? coverProp : storeCover
  const savedY = coverY ?? storeY
  const posY = dragY ?? savedY
  const setCover = onSetCover ?? ((c: string | null) => { if (target) void scoped.getState().setPageCover(target, c) })
  const setY = onSetCoverY ?? ((y: number) => { if (target) void scoped.getState().setPageCoverY(target, y) })
  if (!target || !cover) return null
  const src = /^https?:\/\//i.test(cover) ? cover : toAssetUrl(cover)
  return (
    <div className={`amx-cover${reposition ? ' amx-cover-repo' : ''}`}>
      <img
        src={src}
        alt=""
        draggable={false}
        style={{ objectPosition: `50% ${posY}%` }}
        onMouseDown={(e) => {
          // 仅「调整位置」模式解锁拖拽:鼠标下移 → object-position Y 增大;松手落 fm cover_y。
          if (!reposition || e.button !== 0) return
          e.preventDefault()
          const startClientY = e.clientY
          const h = (e.currentTarget as HTMLElement).offsetHeight || 210
          const base = posY
          const onMove = (ev: MouseEvent): void => setDragY(Math.max(0, Math.min(100, base + ((ev.clientY - startClientY) / h) * 100)))
          const onUp = (): void => {
            window.removeEventListener('mousemove', onMove)
            window.removeEventListener('mouseup', onUp)
            setDragY((cur) => { if (cur != null) setY(Math.round(cur)); return null })
          }
          window.addEventListener('mousemove', onMove)
          window.addEventListener('mouseup', onUp)
        }}
        onError={(e) => { (e.target as HTMLElement).style.opacity = '0.15' }}
      />
      <div className="amx-cover-grad" />
      {reposition && <div className="amx-cover-hint">上下拖动图片调整位置</div>}
      <div className="amx-cover-tools">
        {reposition ? (
          <button onClick={() => setReposition(false)}>完成</button>
        ) : (
          <>
            <button onClick={(e) => { const r = e.currentTarget.getBoundingClientRect(); setPick({ x: r.right, y: r.bottom + 6 }) }}>更换封面</button>
            <button onClick={() => setReposition(true)}>调整位置</button>
            <button onClick={() => setCover(null)}>移除</button>
          </>
        )}
      </div>
      {pick && <CoverPicker page={target} x={pick.x} y={pick.y} onApply={onSetCover ?? undefined} onClose={() => setPick(null)} />}
    </div>
  )
}

/** 无关键词时的默认精选封面(Notion 式):picsum 固定 seed 免 key、图随 seed 稳定,
 *  纯 <img> 直载不走主进程(须 index.html CSP img-src 放行 https:),故三端(含 web)都可用。 */
const FEATURED_COVERS: Array<{ thumb: string; full: string; author?: string; source?: string }> = [
  'aurora', 'forest', 'ocean', 'alpine', 'metro', 'night', 'coast', 'mist', 'valley', 'dune', 'lake', 'bloom',
].map((s) => ({ thumb: `https://picsum.photos/seed/${s}/320/180`, full: `https://picsum.photos/seed/${s}/1600/900`, source: 'Picsum' }))

/** 封面选择器:锚定 popover(骑 amx-db-pop 壳,融入页面非全屏模态)。
 *  tab = 图库(打开即精选,可搜 Openverse)/ 链接 / 上传;点缩略图即换封面但**不关闭**(可连选),点浮层外关闭。 */
export function CoverPicker({ page, x, y, onClose, onApply }: {
  page: string
  x: number
  y: number
  onClose: () => void
  /** 缺省 = pageStore.setPageCover(v3);unified 传自己的 fm 管线写法。 */
  onApply?: (cover: string) => void
}) {
  const hasSearch = !!amadeus.searchImages
  const scoped = useScopedPageStore() // 写本面板的 store(理由同 NoteCover:插件视图里 ps() 会写到隔壁)
  const [tab, setTab] = useState<'gallery' | 'url' | 'upload'>('gallery')
  const [q, setQ] = useState('')
  const [hits, setHits] = useState<Array<{ thumb: string; full: string; author?: string }> | null>(null)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState(false)
  const [url, setUrl] = useState('')
  const apply = (cover: string): void => {
    if (onApply) onApply(cover)
    else void scoped.getState().setPageCover(page, cover) // 不自动关闭:用户可连选换图,点浮层外才关
  }
  const search = (): void => {
    const query = q.trim()
    if (!query || !amadeus.searchImages) return
    setBusy(true)
    setErr(false)
    void amadeus.searchImages(query)
      .then((r) => { setHits(r); setBusy(false) })
      .catch(() => { setHits(null); setErr(true); setBusy(false) }) // 失败显式提示,不静默
  }
  const upload = (): void => {
    const input = document.createElement('input')
    input.type = 'file'
    input.accept = 'image/*'
    input.onchange = () => {
      const f = input.files?.[0]
      if (!f) return
      void (async () => {
        try {
          const bytes = new Uint8Array(await f.arrayBuffer())
          const { opts } = await getAttachmentPrefs()
          const { pageRel } = await amadeus.saveAttachment(page, f.name || 'cover.png', bytes, opts)
          apply(joinRel(page.split('/').slice(0, -1).join('/'), pageRel))
        } catch { /* 保存失败静默 */ }
      })()
    }
    input.click()
  }
  // 缩略图网格:统一 3:2 比例 + 小圆角,图下方一行作者/来源;点击即用即关。
  const grid = (items: Array<{ thumb: string; full: string; author?: string; source?: string }>) => (
    <div className="amx-coverpick-grid">
      {items.map((h) => (
        <button key={h.full} className="amx-coverpick-item" onClick={() => apply(h.full)}>
          <span className="amx-coverpick-thumb">
            <img src={h.thumb} alt="" loading="lazy" onError={(e) => { const b = e.currentTarget.closest('.amx-coverpick-item') as HTMLElement | null; if (b) b.style.display = 'none' }} />
          </span>
          <span className="amx-coverpick-cap">{h.author ? `by ${h.author}` : (h.source ?? '')}</span>
        </button>
      ))}
    </div>
  )
  return (
    <div className="amx-db-popwrap am-app" onMouseDown={onClose}>
      <OverlayAt
        className="amx-db-pop amx-coverpick"
        x={x - 420}
        y={y}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="amx-coverpick-tabs">
          <button data-on={tab === 'gallery' || undefined} onClick={() => setTab('gallery')}>图库</button>
          <button data-on={tab === 'url' || undefined} onClick={() => setTab('url')}>链接</button>
          <button data-on={tab === 'upload' || undefined} onClick={() => setTab('upload')}>上传</button>
        </div>
        {tab === 'gallery' && (
          <div className="amx-coverpick-body">
            {hasSearch && (
              <div className="amx-coverpick-search">
                <Search size={13} className="t2s-dim" />
                <input autoFocus placeholder="搜索在线图库(Openverse),或从下方精选挑…" value={q} onChange={(e) => setQ(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') search() }} />
                <button className="amx-coverpick-go" onClick={search}>{busy ? '…' : '搜索'}</button>
              </div>
            )}
            {grid(hits && hits.length > 0 ? hits : FEATURED_COVERS)}
            {!busy && err && <div className="amx-coverpick-hint">图库接口暂不可达,可从上方精选挑,或用「链接/上传」。</div>}
            {!busy && !err && hits?.length === 0 && <div className="amx-coverpick-hint">没搜到结果,上方为精选封面。</div>}
          </div>
        )}
        {tab === 'url' && (
          <div className="amx-coverpick-body amx-coverpick-url">
            <input autoFocus placeholder="粘贴图片地址(https://…)" value={url} onChange={(e) => setUrl(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter' && /^https?:\/\//i.test(url.trim())) apply(url.trim()) }} />
            <button className="amx-coverpick-go" onClick={() => { if (/^https?:\/\//i.test(url.trim())) apply(url.trim()) }}>设为封面</button>
          </div>
        )}
        {tab === 'upload' && (
          <div className="amx-coverpick-body">
            <button className="amx-coverpick-go amx-coverpick-upload" onClick={upload}>选择本地图片…</button>
            <div className="amx-coverpick-hint">按「设置 → 笔记」的附件位置存入 vault。</div>
          </div>
        )}
      </OverlayAt>
    </div>
  )
}

/** Notion 行为:「添加图标」先随机给一个,再点可换。 */
export const randomEmoji = (): string => EMOJI_ALL[Math.floor(Math.random() * EMOJI_ALL.length)]

/** 页面图标 picker:分组 emoji 网格 + 中英关键词搜索 + 任意输入(系统 emoji 面板贴进来也行)。
 *  库在 amadeus/lib/emoji.ts。 */
export function IconPicker({ x, y, current, onPick, onClose }: {
  x: number
  y: number
  current: string | null
  onPick: (icon: string | null) => void
  onClose: () => void
}) {
  const [draft, setDraft] = useState('')
  // 输入框一框两用:命中关键词 → 当搜索;一个字都搜不到(如直接粘贴 emoji)→ 回车按原样采用。
  const hits = searchEmoji(draft)
  return (
    <div className="amx-db-popwrap" onMouseDown={onClose}>
      <OverlayAt className="amx-db-pop amx-iconpick" x={x} y={y} onMouseDown={(e) => e.stopPropagation()}>
        <input
          className="amx-db-pop-input"
          autoFocus
          placeholder="搜索 emoji(中/英),或粘贴任意字符后回车…"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Escape') { onClose(); return }
            if (e.key !== 'Enter' || !draft.trim()) return
            // 有搜索结果 → 回车取第一个;没有 → 把输入本身当图标(保留「粘贴任意 emoji」的老用法)。
            onPick(hits && hits.length ? hits[0] : draft.trim())
          }}
        />
        <div className="amx-iconpick-grid">
          {hits
            ? hits.map((em) => (
                <button key={em} className={`amx-iconpick-item${current === em ? ' active' : ''}`} onClick={() => onPick(em)}>
                  {em}
                </button>
              ))
            : EMOJI_GROUPS.map((g) => (
                <Fragment key={g.name}>
                  <div className="amx-iconpick-group">{g.name}</div>
                  {g.items.map(([em, kw]) => (
                    <button key={`${g.name}-${em}`} className={`amx-iconpick-item${current === em ? ' active' : ''}`} title={kw} onClick={() => onPick(em)}>
                      {em}
                    </button>
                  ))}
                </Fragment>
              ))}
          {hits && hits.length === 0 && <div className="amx-iconpick-empty">没有匹配的 emoji —— 回车可直接用你输入的字符</div>}
        </div>
        {current && (
          <button className="amx-db-opt amx-db-opt-clear" onClick={() => onPick(null)}>移除图标</button>
        )}
      </OverlayAt>
    </div>
  )
}
