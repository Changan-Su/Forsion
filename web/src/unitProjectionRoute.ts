/** Resolve only routes owned by this projection, respecting path boundaries. */
export function unitProjectionRoute(url: URL, base: URL): { kind: 'share' | 'invite'; token: string } | null {
  if (url.origin !== base.origin || !url.pathname.startsWith(base.pathname)) return null
  const match = /^(share|invite)\/([^/]+)\/?$/.exec(url.pathname.slice(base.pathname.length))
  if (!match) return null
  return { kind: match[1] as 'share' | 'invite', token: decodeURIComponent(match[2]) }
}
