/** 书签卡(AFFiNE/Notion 对标):纯 URL 块的渲染形态。og 元数据经主进程抓取(fetchLinkMeta,
 *  缺位端降级纯链接卡)。md 里就是那行 URL(零私有语法);✎ 就地改 URL 文本。
 *
 *  ⚠️ 2026-08-29 用户实报「粘贴视频链接直接就 embed 了」——**裸 URL 一律只渲卡片,视频也不例外**。
 *  播放器(YouTube / B 站 iframe)搬去了 `VideoIframe`,只有嵌入形态 `![[url]]` 才走(WebEmbed 分流)。
 *  两态互转仍是同一行文本的两种字面(▶ 按钮 → `![[url]]`,卡内「转为书签卡」← 反向),可逆无损。 */
import { useEffect, useState, type ReactElement } from 'react'
import type { LinkMeta } from '@amadeus-shared/ipc'
import { amadeus } from '../api'
import { registerMessages, useI18n } from '../../i18n'

registerMessages({
  'bmcard.embedVideo': { zh: '内嵌播放器', en: 'Embed the player' },
  'bmcard.embedPage': { zh: '内嵌这个网页(活页,默认冻结)', en: 'Embed this page (live page, frozen by default)' },
  'bmcard.editUrl': { zh: '编辑链接地址', en: 'Edit link URL' },
  'bmcard.startAt': { zh: '起播时刻', en: 'Start time' },
  'bmcard.openInBrowser': { zh: '在浏览器打开', en: 'Open in browser' },
  'bmcard.toCardTitle': { zh: '改回裸 URL 一行(书签卡)', en: 'Change back to a plain URL line (bookmark card)' },
  'bmcard.toCard': { zh: '转为书签卡', en: 'Convert to bookmark card' },
})

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

/** B 站视频链接 → `{bvid, page, t}`。`t` 兼容 `?t=90` / `?t=1m30s` / `#t=90`。
 *  实测(2026-08-28,player.bilibili.com):`?t=90` 起播准确落在 01:30。**运行期没有 seek 通道**
 *  ——跨源 iframe 且 B 站无官方 postMessage 契约,换时刻只能重挂播放器。 */
export function bilibiliRef(url: string): { bvid: string; page: number; t: number | null } | null {
  const m = /bilibili\.com\/video\/(BV[\w]+)/i.exec(url) || /^\s*(BV[\w]{10})\s*$/.exec(url)
  if (!m) return null
  let page = 1
  let t: number | null = null
  try {
    const u = new URL(url)
    page = parseInt(u.searchParams.get('p') || '1', 10) || 1
    t = timeParam(u)
  } catch { /* 裸 BV 号 */ }
  return { bvid: m[1], page, t }
}

/** URL 里的起播秒:`?t=` / `&start=` / `#t=`。三形:`90` / `1m30s` / `01:30`。
 *  YouTube 官方文档的 `t` 用 `1m30s`,`start` 用纯秒;两者都收。 */
export function timeParam(u: URL): number | null {
  const raw = u.searchParams.get('t') ?? u.searchParams.get('start') ?? (/^#t=(.+)$/.exec(u.hash)?.[1] ?? null)
  if (raw == null) return null
  const s = raw.trim().replace(/s$/i, '')
  let m: RegExpExecArray | null
  if ((m = /^(?:(\d+)h)?(?:(\d+)m)?(\d+)?$/i.exec(s)) && (m[1] || m[2])) {
    return (+(m[1] || 0)) * 3600 + (+(m[2] || 0)) * 60 + (+(m[3] || 0))
  }
  if ((m = /^(?:(\d+):)?([0-5]?\d):([0-5]\d)$/.exec(s))) return (+(m[1] || 0)) * 3600 + +m[2] * 60 + +m[3]
  if (/^\d+$/.test(s)) return +s
  return null
}

/** 站点不发预览图时的**生成封面**:主机名哈希 → 固定色相 + 首字母。
 *  纯 DOM/CSS,不联网、不会再失败 —— 「每张书签卡都有封面」这句话是靠它成立的,不是靠抓图
 *  (实测 13 个站有 1/3 完全不发 og:image;Notion 在这些站上是**没有**封面的)。
 *  同一域名恒定同一张:哈希只吃主机名,不吃路径,同站的多条书签看着是一家。 */
export function genCover(url: string): { c1: string; c2: string; letter: string } {
  let host = url
  try { host = new URL(url).hostname.replace(/^www\./, '') } catch { /* 非法 URL:拿原串当种子 */ }
  let h = 0
  for (let i = 0; i < host.length; i++) h = (h * 31 + host.charCodeAt(i)) % 360
  return {
    c1: `hsl(${h} 58% 62%)`,
    c2: `hsl(${(h + 42) % 360} 54% 46%)`,
    letter: (host.replace(/^[^a-z0-9\u4e00-\u9fa5]+/i, '')[0] || host[0] || '?').toUpperCase(),
  }
}

export function startOf(url: string): number | null {
  try { return timeParam(new URL(url)) } catch { return null }
}

export function BookmarkCard({ url, onChangeUrl, onEmbed }: {
  url: string
  /** 不传 = **只读语境**(冻结的网页嵌入、收件箱流):连 ✎ 都不显示。
   *  ⚠️ 别再传 `noop` —— 那是「铅笔照给、改完回车静默丢弃」的确定性输入丢失(Codex 2026-08-29)。 */
  onChangeUrl?: (next: string) => void
  /** 「内嵌」按钮:把这一行改写成 `![[url]]`(活网页形态)。不传 = 不显示该按钮(只读语境)。 */
  onEmbed?: () => void
}) {
  const { t } = useI18n()
  const [meta, setMeta] = useState<LinkMeta | null | 'loading'>(metaCache.get(url) ?? 'loading')
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(url)
  const [broken, setBroken] = useState(false) // 封面图加载失败 → 换生成封面(绝不藏掉封面位)
  const yt = youtubeId(url)
  const isVideo = !!yt || !!bilibiliRef(url)

  useEffect(() => {
    setDraft(url)
    setBroken(false)
    // ⚠️ 视频链接**也要**抓 og:元数据。原先这里跳过 yt/bili(反正渲的是播放器),降级成卡片后
    // 再跳过就是「视频链接变成一行光秃秃的 URL」——比自动 embed 更糟。
    if (metaCache.has(url)) {
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
  }, [url])

  let host = url
  try {
    host = new URL(url).hostname.replace(/^www\./, '')
  } catch {
    /* keep raw */
  }

  const commitEdit = (): void => {
    setEditing(false)
    const next = draft.trim()
    if (onChangeUrl && next && next !== url) onChangeUrl(next)
    else setDraft(url)
  }

  const tools = (
    <span className="amx-bm-tools">
      {editing ? null : (
        <>
          {onEmbed && (
            <button
              className="amx-bm-tool"
              title={isVideo ? t('bmcard.embedVideo') : t('bmcard.embedPage')}
              onClick={(e) => {
                e.preventDefault()
                e.stopPropagation()
                onEmbed()
              }}
            >
              {isVideo ? '▶' : '⤢'}
            </button>
          )}
          {onChangeUrl && (
            <button
              className="amx-bm-tool"
              title={t('bmcard.editUrl')}
              onClick={(e) => {
                e.preventDefault()
                e.stopPropagation()
                setEditing(true)
              }}
            >
              ✎
            </button>
          )}
        </>
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

  const m = meta === 'loading' || meta === null ? null : meta
  // og 抓取常被反爬挡掉;YouTube 的缩略图地址是确定性的,兜一手(B 站没有同类确定地址,只能靠 og)。
  const thumb = broken ? null : m?.image || (yt ? `https://i.ytimg.com/vi/${yt}/hqdefault.jpg` : null)
  // apple-touch-icon 是 180×180 的方形 logo,不是配图 —— 拉进照片位会变形,得 contain 居中垫在
  // 生成封面上。YouTube 那张兜底是真截图,算 photo。
  const iconish = !!thumb && m?.imageKind === 'icon'
  const gen = genCover(url)
  return (
    <a className="amx-bm" href={url} target="_blank" rel="noreferrer" draggable={false}>
      {/* ⚠️ **封面位永远在**:抓不到图、或图加载失败(反盗链/需要 Referer,Electron 里很常见)都
          落到生成封面,而不是把整块藏掉 —— 原先 onError 直接 display:none,用户看到的就是「没有封面」。 */}
      <span
        className={[
          'amx-bm-thumb',
          isVideo ? 'amx-bm-thumb-video' : '',
          thumb ? (iconish ? 'amx-bm-thumb-icon' : '') : 'amx-bm-thumb-gen',
        ].filter(Boolean).join(' ')}
        style={thumb && !iconish ? undefined : { backgroundImage: `linear-gradient(135deg, ${gen.c1}, ${gen.c2})` }}
      >
        {thumb
          ? <img src={thumb} alt="" onError={() => setBroken(true)} />
          : <span className="amx-bm-gen-letter" aria-hidden>{gen.letter}</span>}
      </span>
      <span className="amx-bm-main">
        <span className="amx-bm-title">{m?.title || url}</span>
        {m?.description && <span className="amx-bm-desc">{m.description}</span>}
        <span className="amx-bm-meta">
          {m?.favicon && <img className="amx-bm-favicon" src={m.favicon} alt="" onError={(e) => { (e.target as HTMLElement).style.display = 'none' }} />}
          <span className="amx-bm-host">{m?.siteName || host}</span>
          {meta === 'loading' && <span className="amx-bm-loading">…</span>}
        </span>
      </span>
      {tools}
    </a>
  )
}

/** 嵌入形态 `![[https://youtu.be/…]]` 的播放器。**裸 URL 走不到这里**(那是书签卡)。
 *
 *  ⚠️ frame-src 是**死白名单**(desktop index.html),这两个域已在册。再加平台 = 一次桌面发版,
 *  且旧安装版会是静默黑框(1.4.1 的 B 站前科)。别顺手加 Vimeo/抖音。
 *  非这两家的网页嵌入一律 <webview>(WebEmbed),见 webhost.test.ts。 */
export function VideoIframe({ url, toCard }: { url: string; toCard?: () => void }): ReactElement | null {
  const { t } = useI18n()
  const yt = youtubeId(url)
  const bili = yt ? null : bilibiliRef(url)
  if (!yt && !bili) return null
  const start = startOf(url)
  const src = yt
    ? `https://www.youtube-nocookie.com/embed/${yt}?rel=0${start ? `&start=${start}` : ''}`
    : `https://player.bilibili.com/player.html?bvid=${bili!.bvid}&page=${bili!.page}&high_quality=1&danmaku=0&autoplay=0${start ? `&t=${start}` : ''}`
  let host = url
  try { host = new URL(url).hostname.replace(/^www\./, '') } catch { /* keep raw */ }
  return (
    <div className="amx-bm amx-bm-video">
      {/* webhost-ok: 固定已知嵌入(YouTube / B 站官方外链播放器),需要的能力就这几个,已在 allow= 里写全 */}
      <iframe
        key={src} /* 换时刻只能重挂:两家都没有可用的运行期 seek 通道 */
        className="amx-bm-iframe"
        src={src}
        title={yt ? 'YouTube' : 'Bilibili'}
        allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
        allowFullScreen
      />
      <div className="amx-bm-videofoot">
        <span className="amx-bm-host">{host}</span>
        {start != null && <span className="amx-bm-at" title={t('bmcard.startAt')}>@{Math.floor(start / 60)}:{String(start % 60).padStart(2, '0')}</span>}
        <a className="amx-bm-open" href={url} target="_blank" rel="noreferrer">{t('bmcard.openInBrowser')}</a>
        {toCard && <button className="embed-media-btn amx-bm-tocard" onClick={toCard} title={t('bmcard.toCardTitle')}>{t('bmcard.toCard')}</button>}
      </div>
    </div>
  )
}
