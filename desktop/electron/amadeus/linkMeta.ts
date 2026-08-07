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

export async function fetchLinkMeta(url: string): Promise<LinkMeta | null> {
  if (!/^https?:\/\//i.test(url)) return null
  const hit = cache.get(url)
  if (hit !== undefined) return hit
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
    const ct = res.headers.get('content-type') ?? ''
    if (!res.ok || !ct.includes('text/html')) {
      cache.set(url, null)
      return null
    }
    const baseUrl = res.url || target
    // 流式累计至 300KB 即断开:res.text() 会先整体读进内存,截断就不是上限了
    const chunks: Uint8Array[] = []
    let n = 0
    const reader = res.body?.getReader()
    if (reader) {
      for (;;) {
        if (Date.now() > deadline) { void reader.cancel(); break }
        const { done, value } = await reader.read()
        if (done) break
        n += value.byteLength
        chunks.push(value)
        if (n >= 300_000) { void reader.cancel(); break }
      }
    }
    const html = Buffer.concat(chunks).toString('utf8').slice(0, 300_000)
    const pick = (re: RegExp): string | undefined => re.exec(html)?.[1]?.trim() || undefined
    const meta = (name: string): string | undefined =>
      pick(new RegExp(`<meta[^>]+(?:property|name)=["']${name}["'][^>]*content=["']([^"']+)`, 'i')) ??
      pick(new RegExp(`<meta[^>]+content=["']([^"']+)["'][^>]*(?:property|name)=["']${name}["']`, 'i'))
    const abs = (href: string | undefined): string | undefined => {
      if (!href) return undefined
      try {
        return new URL(href, baseUrl).href
      } catch {
        return undefined
      }
    }
    const out: LinkMeta = {
      title: decodeEntities(meta('og:title') ?? pick(/<title[^>]*>([^<]+)<\/title>/i)),
      description: decodeEntities(meta('og:description') ?? meta('description')),
      image: abs(meta('og:image')),
      favicon: abs(pick(/<link[^>]+rel=["'](?:shortcut )?icon["'][^>]*href=["']([^"']+)/i)) ?? abs('/favicon.ico'),
      siteName: decodeEntities(meta('og:site_name')),
    }
    cache.set(url, out)
    return out
  } catch {
    cache.set(url, null)
    return null
  }
}
