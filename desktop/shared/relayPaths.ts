/**
 * 经 hub 隧道打「我的电脑」的 path 语法(`…/units/<id>/proxy` 之后那一段)—— 纯函数,手机原生中继(mobile/src/relayPaths.ts)
 * 与桌面主进程中转口(electron/unitRelay.ts)共用一份。
 *
 * 两类面:
 *   调用方面(checkRelayPath):engine | engine/… | engine?… | unit/remote-access | unit/remote-access/request
 *     —— 只有它们附调用方票(X-Forsion-Caller,INTEGRATION R-06);
 *   设备辅助面(checkUnitSurfacePath):unit/hostfile | hostfile/download | hostdir | hoststat | config,只读、照设计匿名。
 * 其余一律不过(`unit/mcp*` 永远不带票也永不经这里发,方案 §6.2-7)。
 *
 * ⚠️ 调用方面在安卓原生侧有同一套规则 `RelayPaths.check`(mobile/android/…/RelayPaths.java),两侧共用用例表
 *    `mobile/android/app/src/test/resources/relay-paths.json`(node 与 JVM 各跑一遍)。改 checkRelayPath 必须改另一边。
 */

/** 小写 uuid(hub 的 randomUUID();大写一律拒 —— 同一台设备只该有一种写法)。 */
export const UNIT_UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

/** path(含 query)允许的字符:RFC 3986 pchar ∪ `/` `?`。不含 `#`、`\`、空白、控制符、非 ASCII。 */
const ALLOWED = /^[A-Za-z0-9._~!$&'()*+,;=:@/%?-]*$/
const MAX_PATH = 8192

/**
 * 通用形状检查,过了再交给 face 判是不是认得的面。规则:
 *  1. 以 `/` 开头、≤ 8192、只含 ALLOWED 字符;
 *  2. `%` 后必须两位十六进制;路径段(`?` 之前)里不许出现编码的 `/`(%2f)、`\`(%5c)与控制符(%00–%1f、%7f);
 *  3. face(路径段, 有没有 query) 认得;
 *  4. 路径段里没有空段(`//`,末尾一个 `/` 除外),把 %2e 解成 `.` 之后没有 `.` / `..` 段。
 */
function checkProxyPath(path: string, face: (pathPart: string, hasQuery: boolean) => boolean): boolean {
  if (typeof path !== 'string' || !path.startsWith('/') || path.length > MAX_PATH || !ALLOWED.test(path)) return false
  if (/%(?![0-9A-Fa-f]{2})/.test(path)) return false
  const q = path.indexOf('?')
  const pathPart = q < 0 ? path : path.slice(0, q)
  if (/%(2f|5c|0[0-9a-f]|1[0-9a-f]|7f)/i.test(pathPart)) return false
  if (!face(pathPart, q >= 0)) return false
  const segs = pathPart.split('/').slice(1)
  for (let i = 0; i < segs.length; i++) {
    const seg = segs[i]
    if (seg === '' && i !== segs.length - 1) return false
    const dots = seg.replace(/%2e/gi, '.')
    if (dots === '.' || dots === '..') return false
  }
  return true
}

/**
 * 调用方面的 path 是否合法(与 RelayPaths.checkPath 逐条对应):路径段恰为 `/engine`、以 `/engine/` 开头、
 * `/unit/remote-access`、`/unit/remote-access/request` 之一;query 只许跟在 engine 形态后面。
 */
export function checkRelayPath(path: string): boolean {
  return checkProxyPath(path, (p, hasQuery) => {
    if (p === '/engine' || p.startsWith('/engine/')) return true
    return (p === '/unit/remote-access' || p === '/unit/remote-access/request') && !hasQuery
  })
}

const UNIT_SURFACE = new Set(['/unit/hostfile', '/unit/hostfile/download', '/unit/hostdir', '/unit/hoststat', '/unit/config'])

/** 设备辅助面的 path 是否合法(渲染层 services/engine/targets.ts 的 UNIT_SURFACE 同一张表;只读、匿名)。 */
export function checkUnitSurfacePath(path: string): boolean {
  return checkProxyPath(path, (p) => UNIT_SURFACE.has(p))
}
