// Asset path transforms (pure, shared by main & renderer).
//
// On disk a block stores PORTABLE, page-folder-relative image links, e.g.
//   ![](.amadeus/img-xyz.png)
// The renderer can't load those directly (its base URL isn't the vault), so for DISPLAY
// we rewrite them to a custom protocol URL that the main process resolves against the vault:
//   ![](amadeus-asset://v/<encoded vault-relative path>)
// …and rewrite back to the relative form before persisting, keeping main.md Obsidian-clean.

export const ASSET_SCHEME = 'amadeus-asset'

/** Join a vault-relative dir with a page-relative path (always '/'-separated). */
export function joinRel(dir: string, rel: string): string {
  const d = dir.replace(/\\/g, '/').replace(/\/+$/, '')
  const r = rel.replace(/\\/g, '/')
  return !d || d === '.' ? r : `${d}/${r}`.replace(/\/{2,}/g, '/')
}

/** Make `vaultRel` relative to a vault-relative dir (inverse of joinRel). */
export function relFrom(dir: string, vaultRel: string): string {
  const d = dir.replace(/\\/g, '/').replace(/\/+$/, '')
  if (!d || d === '.') return vaultRel
  const prefix = `${d}/`
  return vaultRel.startsWith(prefix) ? vaultRel.slice(prefix.length) : vaultRel
}

/** 可替换的资源 URL 构建器(接缝):默认 = amadeus-asset:// 自定义协议(桌面主进程解析,
 *  移动端由原生 WebView 拦截)。Tangu Web 无 host 协议,启动时经 setAssetUrlBuilder 注入
 *  HTTP 版(→ /api/amadeus/vaults/:v/asset?ref=…)。桌面/移动不调用注入,零影响。 */
let assetUrlBuilder: (ref: string) => string = (ref) =>
  `${ASSET_SCHEME}://v/${encodeURIComponent(ref)}`

/** Install a custom display-URL builder for vault assets (web cloud bridge). */
export function setAssetUrlBuilder(fn: (ref: string) => string): void {
  assetUrlBuilder = fn
}

export function toAssetUrl(vaultRelPath: string): string {
  return assetUrlBuilder(vaultRelPath)
}

export function fromAssetUrl(url: string): string | null {
  const prefix = `${ASSET_SCHEME}://v/`
  if (!url.startsWith(prefix)) return null
  try {
    return decodeURIComponent(url.slice(prefix.length))
  } catch {
    return null
  }
}

// ![alt](path) or ![alt](path "title") — captures alt-wrapper, the URL token, then the rest.
const IMG_RE = /(!\[[^\]]*\]\()([^)\s]+)((?:\s+"[^"]*")?\))/g

function isExternal(url: string): boolean {
  return /^(https?:|data:|amadeus-asset:|blob:|\/)/.test(url)
}

/** Stored (page-relative) markdown → display markdown (protocol URLs for local images). */
export function toDisplayMarkdown(md: string, pageDir: string): string {
  return md.replace(IMG_RE, (full, pre: string, url: string, rest: string) => {
    const u = url.trim()
    if (isExternal(u)) return full
    return pre + toAssetUrl(joinRel(pageDir, u)) + rest
  })
}

/** Display markdown (protocol URLs) → stored (page-relative) markdown. */
export function toStoredMarkdown(md: string, pageDir: string): string {
  return md.replace(IMG_RE, (full, pre: string, url: string, rest: string) => {
    const vaultRel = fromAssetUrl(url.trim())
    if (vaultRel == null) return full
    return pre + relFrom(pageDir, vaultRel) + rest
  })
}
