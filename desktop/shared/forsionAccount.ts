/** Stable account identity for local cloud state. JWT decoding is identification only;
 * the server remains responsible for verifying the token before granting access. */
export function forsionAccountId(cloudUrl: string, token: string): string | null {
  try {
    const url = new URL(cloudUrl)
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return null
    const encoded = token.split('.')[1]
    if (!encoded) return null
    const base64 = encoded.replace(/-/g, '+').replace(/_/g, '/')
    const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0))
    const claims = JSON.parse(new TextDecoder().decode(bytes))
    const userId = claims.userId ?? claims.sub
    if ((typeof userId !== 'string' && typeof userId !== 'number') || !String(userId).trim()) return null
    return `${url.origin}${url.pathname.replace(/\/+$/, '')}::${String(userId)}`
  } catch {
    return null
  }
}
