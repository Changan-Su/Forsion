/**
 * 拉官网「更新动态」的已发布快照(What's new 弹窗正文)。
 *
 * 走主进程拉而不是渲染层直连:生产渲染层是 file:// 源,跨域请求的 Origin 是 `null`,别把弹窗押在服务端的 CORS 上。
 * 接口只有一个「全部版本」(~340 KB),所以进程内缓存一段时间;拿不到返回 null,渲染层退回打包进来的 CHANGELOG。
 */
import { parseWebsiteReleases, WEBSITE_RELEASES_URL, type WebsiteRelease } from '../shared/websiteReleases'

const TTL_MS = 10 * 60_000 // ponytail: 全量接口 + 进程内缓存;服务端有按版本取的接口时再改成按需拉

let cache: { at: number; list: WebsiteRelease[] } | null = null
let inflight: Promise<WebsiteRelease[] | null> | null = null

export function fetchWebsiteReleases(fetchImpl: typeof fetch = fetch, now = Date.now): Promise<WebsiteRelease[] | null> {
  if (cache && now() - cache.at < TTL_MS) return Promise.resolve(cache.list)
  inflight ??= (async () => {
    try {
      const res = await fetchImpl(WEBSITE_RELEASES_URL, { signal: AbortSignal.timeout(10_000) })
      if (!res.ok) return cache?.list ?? null
      const list = parseWebsiteReleases(await res.json())
      cache = { at: now(), list }
      return list
    } catch {
      return cache?.list ?? null // 断网 / 官网挂了:有旧缓存用旧的,没有就让渲染层回退
    } finally {
      inflight = null
    }
  })()
  return inflight
}
