/** 书签卡的链接元数据抓取(主进程,免 CORS):og 标签正则抠取,不整套解析 HTML。
 *  6s 超时 + 300KB 截断 + 进程内缓存;失败/非 HTML 一律 null(渲染端降级纯链接卡)。 */
import type { LinkMeta } from '@amadeus-shared/ipc'
import { privateHostReason } from '../netGuard'

const cache = new Map<string, LinkMeta | null>()

const ENTITIES: Record<string, string> = { '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'", '&#x27;': "'", '&nbsp;': ' ' }
const decodeEntities = (s: string | undefined): string | undefined =>
  s?.replace(/&(?:amp|lt|gt|quot|nbsp|#39|#x27);/g, (m) => ENTITIES[m] ?? m)

/** 封面图搜索:Openverse(WordPress 旗下 CC 图库,公开 API 免 key,2026-07 实测可用)。
 *  此前的 unsplash.com/napi 已改为要求鉴权(307 Authorization required),故弃用。
 *  匿名配额偶发 401/429 → 退避重试一次 + 进程内查询缓存;重试仍失败则抛错
 *  (渲染端据此显示「接口不可达」并回落默认精选;空数组=真没搜到)。 */
type ImageHit = { thumb: string; full: string; author?: string }
const imageCache = new Map<string, ImageHit[]>()

export async function searchImages(query: string): Promise<ImageHit[]> {
  const q = query.trim()
  if (!q) return []
  const hit = imageCache.get(q)
  if (hit) return hit
  let lastErr: unknown = null
  for (let attempt = 0; attempt < 2; attempt++) {
    if (attempt) await new Promise((r) => setTimeout(r, 1200)) // 匿名限流的瞬时抖动:退避一拍再试
    try {
      const ctrl = new AbortController()
      const t = setTimeout(() => ctrl.abort(), 10_000)
      // page_size 上限 20:匿名请求超过即 401(实测 "page_size may not exceed 20 for anonymous requests")。
      const res = await fetch(`https://api.openverse.org/v1/images/?q=${encodeURIComponent(q)}&page_size=20`, {
        signal: ctrl.signal,
        headers: { 'user-agent': 'ForsionAmadeus/1.0 (cover picker)', accept: 'application/json' },
      })
      clearTimeout(t)
      if (!res.ok) throw new Error(`openverse HTTP ${res.status}`)
      const j = (await res.json()) as { results?: Array<{ thumbnail?: string; url?: string; creator?: string }> }
      const out = (j.results ?? [])
        .map((r) => ({ thumb: r.thumbnail ?? '', full: r.url ?? '', author: r.creator }))
        .filter((x) => x.thumb && x.full)
      if (out.length) imageCache.set(q, out) // 空结果不缓存(可能正处限流)
      return out
    } catch (e) {
      lastErr = e
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error('openverse unreachable')
}

/** 从 HTML 抠元数据(纯函数,可单测;网络那半留在 fetchLinkMeta 里)。
 *
 *  封面图的取值链 = **实测定的**(2026-08-29 探了 13 个站):
 *    `og:image` → `twitter:image` → `apple-touch-icon`
 *  - og:image 覆盖约 2/3(github/mdn/notion/x/arxiv/apple/bilibili…);
 *  - twitter:image **单独没有增量**(有 tw 的站无一例外也有 og),留着只为极少数只发 twitter 卡的站;
 *  - 真正的缺口是知乎/掘金/维基/HN 这类**完全不发 og 图**的站 —— 它们几乎都有 apple-touch-icon,
 *    所以拿它兜底,但**标成 `imageKind:'icon'`**:那是 180×180 的方形 logo,拉进照片位就是变形,
 *    渲染端要用 contain 居中。
 *  - **刻意不取 JSON-LD 与 `link[rel=image_src]`**:同一批探测里它们的独占增量是 0,而
 *    `"image":"…"` 这种裸正则扫 300KB 任意 HTML 是误报制造机(内联 JS 里一抓一个准)。
 *  取不到也无所谓 —— 渲染端有生成封面兜底,「每张书签卡都有封面」不靠这里成立。 */
export function pickLinkMeta(html: string, baseUrl: string): LinkMeta {
  const pick = (re: RegExp): string | undefined => re.exec(html)?.[1]?.trim() || undefined
  const meta = (name: string): string | undefined =>
    pick(new RegExp(`<meta[^>]+(?:property|name)=["']${name}["'][^>]*content=["']([^"']+)`, 'i')) ??
    pick(new RegExp(`<meta[^>]+content=["']([^"']+)["'][^>]*(?:property|name)=["']${name}["']`, 'i'))
  const abs = (href: string | undefined): string | undefined => {
    if (!href) return undefined
    try {
      const u = new URL(href, baseUrl)
      // ⚠️ **一律升 https**:渲染层的 CSP 是 `img-src 'self' data: blob: amadeus-asset: https:`,
      // 明文 `http://` 图片会被直接拦掉 → onError → 用户看到的就是「没有封面」。
      // 2026-08-29 实测这正是 B 站封面全灭的原因:og:image / API 的 pic 都下发 `http://i0.hdslb.com/…`,
      // 换成 https 当场 ✓1920x1080。站点若真没有 https 版,那就加载失败 → 生成封面兜底,不更差。
      if (u.protocol === 'http:') u.protocol = 'https:'
      return u.href
    } catch {
      return undefined
    }
  }
  const photo = abs(meta('og:image') ?? meta('twitter:image') ?? meta('twitter:image:src'))
  const icon = abs(pick(/<link[^>]+rel=["'][^"']*apple-touch-icon[^"']*["'][^>]*href=["']([^"']+)/i))
  return {
    title: decodeEntities(meta('og:title') ?? pick(/<title[^>]*>([^<]+)<\/title>/i)),
    description: decodeEntities(meta('og:description') ?? meta('description')),
    image: photo ?? icon,
    imageKind: photo ? 'photo' : icon ? 'icon' : undefined,
    favicon: abs(pick(/<link[^>]+rel=["'](?:shortcut )?icon["'][^>]*href=["']([^"']+)/i)) ?? abs('/favicon.ico'),
    siteName: decodeEntities(meta('og:site_name')),
  }
}

/** B 站视频页**抓不到 og** —— 风控挡爬(412/403),而且拿到的也常是「视频去哪了呢」占位页。
 *  官方公开接口不需要鉴权、主进程(Chromium net 栈)实测 `code:0` 稳定返回封面/标题/UP 主。
 *  这是 YouTube 那条确定性缩略图兜底的对位做法,不是给 B 站开后门。
 *  ⚠️ `pic` 下发的是 `http://i0.hdslb.com/…`,必须升 https,否则被渲染层 CSP 拦掉。 */
async function fetchBilibiliMeta(bvid: string, deadline: number): Promise<LinkMeta | null> {
  try {
    const res = await fetch(`https://api.bilibili.com/x/web-interface/view?bvid=${encodeURIComponent(bvid)}`, {
      signal: AbortSignal.timeout(Math.max(1, deadline - Date.now())),
      headers: { accept: 'application/json' },
    })
    if (!res.ok) return null
    return biliJsonToMeta(await res.json())
  } catch {
    return null
  }
}

/** B 站 view 接口的 JSON → LinkMeta(纯函数,好单测;网络那半留在上面)。
 *  `code !== 0` 是「视频不存在/被删」,必须当没抓到 —— 否则会把一张空卡当成功缓存住。 */
export function biliJsonToMeta(j: unknown): LinkMeta | null {
  const o = j as { code?: number; data?: { pic?: string; title?: string; desc?: string; owner?: { name?: string } } }
  if (!o || o.code !== 0 || !o.data) return null
  const pic = o.data.pic ? o.data.pic.replace(/^http:/, 'https:') : undefined
  if (!pic && !o.data.title) return null
  return {
    title: o.data.title,
    description: o.data.desc?.trim().slice(0, 200) || undefined,
    image: pic,
    imageKind: pic ? 'photo' : undefined,
    favicon: 'https://www.bilibili.com/favicon.ico',
    siteName: o.data.owner?.name ? `哔哩哔哩 · ${o.data.owner.name}` : '哔哩哔哩',
  }
}

export async function fetchLinkMeta(url: string): Promise<LinkMeta | null> {
  if (!/^https?:\/\//i.test(url)) return null
  const hit = cache.get(url)
  if (hit !== undefined) return hit
  const bv = /bilibili\.com\/video\/(BV[0-9A-Za-z]+)/i.exec(url)?.[1]
  if (bv) {
    const m = await fetchBilibiliMeta(bv, Date.now() + 6000)
    if (m) {
      cache.set(url, m)
      return m
    }
    // 拿不到就照走下面的通用 HTML 路(退化成和以前一样,不会更差)
  }
  try {
    // SSRF 闸:书签 URL 来自笔记内容(agent/云同步可写入),属半受控输入。逐跳解析成 IP 再判,
    // redirect 自己跟 —— 只校验首跳等于没校验(公网域名可 302 到内网)。calendar:fetchIcs 同款正典。
    let target = url
    let res: Response | null = null
    const deadline = Date.now() + 6000 // 端到端硬时限:重定向链共用,不是每跳重新计时
    for (let hop = 0; hop < 5; hop++) {
      if (await privateHostReason(new URL(target).hostname)) { cache.set(url, null); return null }
      res = await fetch(target, {
        signal: AbortSignal.timeout(Math.max(1, deadline - Date.now())),
        redirect: 'manual',
        headers: { 'user-agent': 'Mozilla/5.0 (compatible; ForsionAmadeus/1.0; bookmark-preview)', accept: 'text/html,*/*;q=0.5' },
      })
      if (res.status < 300 || res.status >= 400) break
      const loc = res.headers.get('location')
      if (!loc) break
      void res.body?.cancel()
      target = new URL(loc, target).toString()
      if (!/^https?:\/\//i.test(target)) { cache.set(url, null); return null }
      res = null
    }
    if (!res) { cache.set(url, null); return null } // 重定向次数过多
    // content-type 闸:挡二进制就够了。**别只认 `text/html`** —— 有站点回 `application/xhtml+xml`、
    // 有站点干脆不发这个头(实测豆瓣),一刀切等于把它们判成「没有元数据」。
    const ct = (res.headers.get('content-type') ?? '').toLowerCase()
    if (!res.ok || (ct && !/(text\/html|xhtml|text\/plain|^$)/.test(ct))) {
      cache.set(url, null)
      return null
    }
    const baseUrl = res.url || target
    // 流式读,**读到 `</head>` 就断**(og 全在 head 里),硬上限 1MB。
    // ⚠️ 旧版死切 300KB —— YouTube 的 `</head>` 在 **~700KB** 处(实测),于是 og 与 title 一起丢,
    // 卡片只剩一行网址。res.text() 不行:它会先整体读进内存,截断就不是上限了。
    const chunks: Uint8Array[] = []
    let n = 0
    let head = -1
    const reader = res.body?.getReader()
    if (reader) {
      const dec = new TextDecoder('utf8')
      let tail = ''
      for (;;) {
        if (Date.now() > deadline) { void reader.cancel(); break }
        const { done, value } = await reader.read()
        if (done) break
        n += value.byteLength
        chunks.push(value)
        // 逐块找 `</head>`:只在「上一块尾巴 + 本块」里找,不必每次重拼整篇。
        const piece = tail + dec.decode(value, { stream: true })
        if (/<\/head>/i.test(piece)) { head = n; void reader.cancel(); break }
        tail = piece.slice(-16) // `</head>` 最长 7 字节,留 16 够跨块
        if (n >= 1_000_000) { void reader.cancel(); break }
      }
    }
    const out = pickLinkMeta(Buffer.concat(chunks).toString('utf8'), baseUrl)
    void head
    cache.set(url, out)
    return out
  } catch {
    cache.set(url, null)
    return null
  }
}
