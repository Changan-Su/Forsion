/**
 * 手机原生中继的 URL 语法(P1-K8,INTEGRATION R-06)—— 纯函数,无 capacitor 依赖(web 手机形态也 import 得到)。
 *
 * 只有这几种请求由原生附上调用方票(X-Forsion-Caller):
 *   `${apiBase}/units/<小写 uuid>/proxy/` 之后恰为
 *     engine | engine/… | engine?… | unit/remote-access | unit/remote-access/request
 *   `unit/mcp*` 永远不带(方案 §6.2-7);`unit/hostfile` 等设备辅助面照旧匿名直发(P0 现状)。
 *
 * ⚠️ 原生侧 `RelayPaths.check`(mobile/android/app/src/main/java/com/forsion/tangu/RelayPaths.java)是同一套规则,
 *    两侧共用一张用例表 `mobile/android/app/src/test/resources/relay-paths.json`(node 与 JVM 各跑一遍)。改一边必须改另一边。
 *
 * 三种结果:
 *   - relay:交给原生中继(原生只往构建期烤死的 apiBase 发,JS 改不了主机);
 *   - reject:**看起来是冲着中继面去的**(proxy 之后以 engine / unit/remote-access 开头,大小写、编码、前导斜杠都算),
 *     但语法不过 → 失败关闭,一个字节都不发。绝不能落回普通 fetch:那等于把手机静默降级成「账号级未识别调用方」,
 *     执行设备上还会因此弹「本账号的浏览器」确认框(INTEGRATION §4.2 / G1);
 *   - null:与中继无关,调用方走原 fetch。
 */

// 语法本体(UNIT_UUID_RE / checkRelayPath)与桌面主进程的中转口共用一份,住在 desktop/shared/relayPaths.ts。
import { checkRelayPath, UNIT_UUID_RE } from '../../desktop/shared/relayPaths'
export { checkRelayPath, UNIT_UUID_RE }

export type RelayParse =
  | { kind: 'relay'; unitId: string; path: string }
  | { kind: 'reject'; reason: string }
  | null

function safeDecode(s: string): string | null {
  try { return decodeURIComponent(s) } catch { return null }
}

/**
 * 判定一个 fetch URL。apiBase = 云端 API 基址(含 /api、无尾斜杠;与原生 NativeConfig.apiBase 逐字相等 —— mobileShim 启动时断言)。
 * 相对 URL(以单个 `/` 开头)按 origin 拼成绝对再判。
 *
 * 两道:
 *  ① 原样判(不经 URL 解析 —— 解析会先把 `..` 规范化掉,判的就不是 JS 递过来的东西了);
 *  ② 原样判为「无关」时再按 WHATWG 规范化复核:浏览器 fetch 发出去之前会把 `…/proxy/unit/../engine`、
 *     `…/units/<a>/../<b>/proxy/engine`、`%2e%2e`、大写主机、夹带的 tab 统统规范化掉 —— 规范化后落在中继面上的,
 *     原样放过去就是**匿名**打到引擎(静默降级),一律按 reject 失败关闭。
 */
export function parseRelayUrl(apiBase: string, url: string, origin?: string): RelayParse {
  if (typeof url !== 'string' || !apiBase) return null
  let abs = url
  if (url.startsWith('/') && !url.startsWith('//') && origin) abs = origin + url
  const raw = parseAbsolute(apiBase, abs)
  if (raw) return raw
  let normalized: string
  try { normalized = new URL(abs).href } catch { return null }
  if (normalized !== abs && parseAbsolute(apiBase, normalized)) return { kind: 'reject', reason: 'url normalizes onto the relay surface' }
  return null
}

function parseAbsolute(apiBase: string, abs: string): RelayParse {
  const prefix = `${apiBase}/units/`
  if (!abs.startsWith(prefix)) return null
  const rest = abs.slice(prefix.length)
  const slash = rest.indexOf('/')
  if (slash < 0) return null
  const unitId = rest.slice(0, slash)
  const after = rest.slice(slash)
  if (!after.startsWith('/proxy/')) return null
  const sub = after.slice('/proxy/'.length)
  // 意图判定:proxy 之后(去掉前导的斜杠 / 反斜杠 / 点,解码、小写)是不是 engine / unit/remote-access。
  const cut = sub.search(/[?#]/)
  const head = cut < 0 ? sub : sub.slice(0, cut)
  const decoded = safeDecode(head)
  const norm = (decoded ?? head).replace(/\\/g, '/').replace(/^[/.]+/, '').toLowerCase()
  const intended = decoded === null || norm.startsWith('engine') || norm.startsWith('unit/remote-access')
  if (!intended) return null
  if (!UNIT_UUID_RE.test(unitId)) return { kind: 'reject', reason: 'unit id must be a lowercase uuid' }
  const path = `/${sub}`
  if (!checkRelayPath(path)) return { kind: 'reject', reason: 'path outside the relay grammar' }
  return { kind: 'relay', unitId, path }
}
