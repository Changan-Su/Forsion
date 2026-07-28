/** 书签卡(AFFiNE/Notion 对标):纯 URL 块的渲染形态。og 元数据经主进程抓取(fetchLinkMeta,
 *  缺位端降级纯链接卡);YouTube 链接直接 iframe 嵌入(youtube-nocookie)。
 *  md 里就是那行 URL(零私有语法);✎ 就地改 URL 文本。 */
import { useEffect, useState } from 'react'
import type { LinkMeta } from '@amadeus-shared/ipc'
import { amadeus } from '../api'

const metaCache = new Map<string, LinkMeta | null>()

/** youtube.com/watch?v= | youtu.be/ | /shorts/ | /embed/ → 视频 id。 */
export function youtubeId(url: string): string | null {
  try {
    const u = new URL(url)
    const host = u.hostname.replace(/^www\./, '')
    if (host === 'youtu.be') return u.pathname.slice(1).split('/')[0] || null
    if (host.endsWith('youtube.com')) {
      if (u.pathname === '/watch') return u.searchParams.get('v')
      const m = /^\/(?:shorts|embed)\/([\w-]{6,})/.exec(u.pathname)
      if (m) return m[1]
    }
  } catch {
    /* 非法 URL */
  }
  return null
}

export function BookmarkCard({ url, onChangeUrl }: { url: string; onChangeUrl: (next: string) => void }) {
  const [meta, setMeta] = useState<LinkMeta | null | 'loading'>(metaCache.get(url) ?? 'loading')
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(url)
  const yt = youtubeId(url)

  useEffect(() => {
    setDraft(url)
    if (yt || metaCache.has(url)) {
      setMeta(metaCache.get(url) ?? null)
      return
    }
    if (!amadeus.fetchLinkMeta) {
      setMeta(null)
      return
    }
    let live = true
    setMeta('loading')
    void amadeus
      .fetchLinkMeta(url)
      .then((m) => {
        metaCache.set(url, m)
        if (live) setMeta(m)
      })
      .catch(() => {
        metaCache.set(url, null)
        if (live) setMeta(null)
      })
    return () => {
      live = false
    }
  }, [url, yt])

  let host = url
  try {
    host = new URL(url).hostname.replace(/^www\./, '')
  } catch {
    /* keep raw */
  }

  const commitEdit = (): void => {
    setEditing(false)
    const next = draft.trim()
    if (next && next !== url) onChangeUrl(next)
    else setDraft(url)
  }

  const tools = (
    <span className="amx-bm-tools">
      {editing ? null : (
        <button
          className="amx-bm-tool"
          title="编辑链接地址"
          onClick={(e) => {
            e.preventDefault()
            e.stopPropagation()
            setEditing(true)
          }}
        >
          ✎
        </button>
      )}
    </span>
  )

  if (editing) {
    return (
      <div className="amx-bm amx-bm-editing">
        <input
          className="amx-bm-edit"
          autoFocus
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commitEdit}
          onKeyDown={(e) => {
            if (e.key === 'Enter') commitEdit()
            else if (e.key === 'Escape') {
              setDraft(url)
              setEditing(false)
            }
          }}
        />
      </div>
    )
  }

  if (yt) {
    return (
      <div className="amx-bm amx-bm-video">
        {/* webhost-ok: 固定已知嵌入(YouTube 播放器),需要的能力就这几个,已在 allow= 里写全 */}
        <iframe
          className="amx-bm-iframe"
          src={`https://www.youtube-nocookie.com/embed/${yt}`}
          title="YouTube"
          allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
          allowFullScreen
        />
        <div className="amx-bm-videofoot">
          <span className="amx-bm-host">{host}</span>
          <a className="amx-bm-open" href={url} target="_blank" rel="noreferrer">在浏览器打开</a>
          {tools}
        </div>
      </div>
    )
  }

  const m = meta === 'loading' || meta === null ? null : meta
  return (
    <a className="amx-bm" href={url} target="_blank" rel="noreferrer" draggable={false}>
      <span className="amx-bm-main">
        <span className="amx-bm-title">{m?.title || url}</span>
        {m?.description && <span className="amx-bm-desc">{m.description}</span>}
        <span className="amx-bm-meta">
          {m?.favicon && <img className="amx-bm-favicon" src={m.favicon} alt="" onError={(e) => { (e.target as HTMLElement).style.display = 'none' }} />}
          <span className="amx-bm-host">{m?.siteName || host}</span>
          {meta === 'loading' && <span className="amx-bm-loading">…</span>}
        </span>
      </span>
      {m?.image && (
        <span className="amx-bm-thumb">
          <img src={m.image} alt="" onError={(e) => { ((e.target as HTMLElement).parentElement as HTMLElement).style.display = 'none' }} />
        </span>
      )}
      {tools}
    </a>
  )
}
