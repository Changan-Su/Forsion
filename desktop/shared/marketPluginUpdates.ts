export type MarketPluginType = 'plugin' | 'amadeus-plugin'
export interface MarketPluginUpdate {
  id: string
  name: string
  type: MarketPluginType
  slug: string
  autoUpdate: boolean
  phase: 'idle' | 'checking' | 'downloading' | 'staged' | 'current' | 'error'
  installedVersion?: string
  pendingVersion?: string
  error?: string
}
export interface MarketPluginUpdates { checking: boolean; items: MarketPluginUpdate[] }

/** Unknown/malformed versions never authorize an unattended replacement. */
export function compareMarketVersions(a: string | null | undefined, b: string | null | undefined): number | null {
  const parse = (v: string | null | undefined) => /^v?(\d+)\.(\d+)(?:\.(\d+))?(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(v?.trim() || '')
  const x = parse(a), y = parse(b)
  if (!x || !y) return null
  for (let i = 1; i <= 3; i++) {
    const d = Number(x[i] || 0) - Number(y[i] || 0)
    if (d) return Math.sign(d)
  }
  if (!x[4] || !y[4]) return x[4] === y[4] ? 0 : x[4] ? -1 : 1
  const px = x[4].split('.'), py = y[4].split('.')
  for (let i = 0; i < Math.max(px.length, py.length); i++) {
    if (px[i] === undefined || py[i] === undefined) return px[i] === py[i] ? 0 : px[i] === undefined ? -1 : 1
    if (px[i] === py[i]) continue
    const nx = /^\d+$/.test(px[i]), ny = /^\d+$/.test(py[i])
    if (nx && ny) return Math.sign(Number(px[i]) - Number(py[i]))
    if (nx !== ny) return nx ? -1 : 1
    return px[i] < py[i] ? -1 : 1
  }
  return 0
}
