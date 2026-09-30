/** Shared by Amadeus's editor embeds and the public Markdown renderer. No network or host APIs. */
export function youtubeId(url: string): string | null {
  try {
    const u = new URL(url)
    if (!/^https?:$/.test(u.protocol)) return null
    const host = u.hostname.toLowerCase().replace(/^www\./, '')
    let id: string | null = null
    if (host === 'youtu.be') id = u.pathname.split('/')[1]
    else if (
      [
        'youtube.com',
        'm.youtube.com',
        'music.youtube.com',
        'youtube-nocookie.com',
      ].includes(host)
    ) {
      id =
        u.pathname === '/watch'
          ? u.searchParams.get('v')
          : (/^\/(?:shorts|embed|live)\/([\w-]+)/.exec(u.pathname)?.[1] ?? null)
    }
    return id && /^[\w-]{6,64}$/.test(id) ? id : null
  } catch {
    return null
  }
}
export function timeParam(u: URL): number | null {
  const raw =
    u.searchParams.get('t') ??
    u.searchParams.get('start') ??
    /^#t=(.+)$/.exec(u.hash)?.[1]
  if (raw == null) return null
  const s = raw.trim().replace(/s$/i, '')
  let m: RegExpExecArray | null
  if ((m = /^(?:(\d+)h)?(?:(\d+)m)?(\d+)?$/i.exec(s)) && (m[1] || m[2]))
    return +(m[1] || 0) * 3600 + +(m[2] || 0) * 60 + +(m[3] || 0)
  if ((m = /^(?:(\d+):)?([0-5]?\d):([0-5]\d)$/.exec(s)))
    return +(m[1] || 0) * 3600 + +m[2] * 60 + +m[3]
  return /^\d+$/.test(s) ? +s : null
}
export function bilibiliRef(
  url: string,
): { bvid: string; page: number; t: number | null } | null {
  let bvid = /^\s*(BV[\w]{10})\s*$/.exec(url)?.[1]
  let page = 1,
    t: number | null = null
  try {
    const u = new URL(url)
    if (
      !/^https?:$/.test(u.protocol) ||
      ![
        'bilibili.com',
        'www.bilibili.com',
        'm.bilibili.com',
        'player.bilibili.com',
      ].includes(u.hostname.toLowerCase())
    )
      return null
    bvid =
      /^\/video\/(BV[\w]+)/i.exec(u.pathname)?.[1] ??
      u.searchParams.get('bvid') ??
      undefined
    page = Math.max(
      1,
      parseInt(
        u.searchParams.get('p') || u.searchParams.get('page') || '1',
        10,
      ) || 1,
    )
    t = timeParam(u)
  } catch {
    /* Native Amadeus also accepts a bare BV identifier. */
  }
  return bvid && /^BV[\w]{10}$/i.test(bvid) ? { bvid, page, t } : null
}
export function platformPlayer(
  url: string,
): { provider: 'YouTube' | 'Bilibili'; src: string } | null {
  const yt = youtubeId(url),
    bili = bilibiliRef(url)
  let start: number | null = null
  try {
    start = timeParam(new URL(url))
  } catch {
    /* bare BV */
  }
  if (yt)
    return {
      provider: 'YouTube',
      src: `https://www.youtube-nocookie.com/embed/${yt}?autoplay=0&playsinline=1${start ? `&start=${start}` : ''}`,
    }
  if (bili)
    return {
      provider: 'Bilibili',
      src: `https://player.bilibili.com/player.html?bvid=${bili.bvid}&page=${bili.page}&danmaku=0&autoplay=0${bili.t ? `&t=${bili.t}` : ''}`,
    }
  return null
}
