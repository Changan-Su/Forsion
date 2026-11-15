/**
 * 插件联网白名单(manifest `network`,2026-11-16+):纯逻辑,主进程(ctx.net 代请求的闸)与渲染层(详情页「会访问」)共用。
 *
 * 只收主机名模式:精确 `api.example.com`,或通配 `*.example.com`(只匹配子域,任意层级;**不含** example.com 本身,
 * 要两个都访问就两条都写)。不带协议、端口、路径;IP 字面量、`localhost`、单标签名、`*` 与 `*.com` 这种只剩一级的通配一律不收。
 * 认不出的条目丢掉并回报给调用方(主进程打一行 warn),不让整份清单作废。
 */

/** 一份清单最多收这么多条:界面要一行列完,也防有人塞几千条拖慢每次请求的匹配。 */
export const MAX_NETWORK_PATTERNS = 32

const LABEL = /^(?!-)[a-z0-9-]{1,63}(?<!-)$/

/** 一个主机名(不带通配)是否像样:ASCII、≥2 个标签、每段合法、末段不是纯数字(挡 IPv4 字面量)、总长 ≤253。 */
function validHostname(host: string): boolean {
  if (!host || host.length > 253) return false
  const labels = host.split('.')
  if (labels.length < 2 || !labels.every((l) => LABEL.test(l))) return false
  return !/^\d+$/.test(labels[labels.length - 1])
}

/** 单条模式 → 规范形(小写、去掉末尾的点);不合法 → null。 */
export function normalizeNetworkPattern(raw: unknown): string | null {
  if (typeof raw !== 'string') return null
  let p = raw.trim().toLowerCase()
  if (p.endsWith('.')) p = p.slice(0, -1)
  if (!p || p.length > 255) return null
  if (p.startsWith('*.')) {
    const base = p.slice(2)
    // `*.com` 只剩一级:等于放行整个顶级域,不收
    return validHostname(base) ? `*.${base}` : null
  }
  return validHostname(p) ? p : null
}

/** 报错用的条目描述。不对对象调 String():第三方 manifest 里的 `{"toString":null}` 会让它抛错,一条坏条目连累整个插件列表。 */
const describeEntry = (v: unknown): string =>
  typeof v === 'string' ? v.slice(0, 80)
    : typeof v === 'number' || typeof v === 'boolean' ? String(v)
      : v === null ? 'null' : Array.isArray(v) ? '[array]' : `[${typeof v}]`

/** manifest `network` → { patterns: 去重后的规范形, invalid: 丢掉的原样条目 }。不是数组 → 空。从不抛错。 */
export function sanitizeNetworkPatterns(raw: unknown): { patterns: string[]; invalid: string[] } {
  const patterns: string[] = []
  const invalid: string[] = []
  if (!Array.isArray(raw)) return { patterns, invalid: raw == null ? [] : [describeEntry(raw)] }
  for (const item of raw) {
    const p = normalizeNetworkPattern(item)
    if (!p) { invalid.push(describeEntry(item)); continue }
    if (patterns.length >= MAX_NETWORK_PATTERNS) { invalid.push(p); continue }
    if (!patterns.includes(p)) patterns.push(p)
  }
  return { patterns, invalid }
}

/** 主机名(URL.hostname 那种:已小写、IDN 已转 punycode)是否落在声明的模式里。通配只认标签边界:`*.example.com` 不匹配 `evilexample.com`。 */
export function hostMatchesNetworkPatterns(hostname: string, patterns: readonly string[]): boolean {
  let host = hostname.toLowerCase()
  if (host.endsWith('.')) host = host.slice(0, -1)
  if (!validHostname(host)) return false
  for (const p of patterns) {
    if (p.startsWith('*.')) {
      if (host.endsWith(p.slice(1)) && host.length > p.length - 1) return true
    } else if (host === p) return true
  }
  return false
}
