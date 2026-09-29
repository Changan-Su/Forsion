/**
 * 调用方断言(设备能力 MCP 方案 P1 · K1 §3.3.1 / INTEGRATION R-07 · R-09):「这次远端请求来自账号下的哪台设备」
 * 从 hub 一路传到本机引擎的那一段。刻意零 electron 依赖 —— unitHost 签、unitWeb 验,两边共用,vitest 直接跑。
 *
 * 逐跳(K1 §3.7):
 *   手机 → hub          X-Forsion-Caller: fuc1…(hub 验票、查库,票本身不转发)
 *   hub → 本机 unitHost 信封字段 proxyCaller(ProxyCaller JSON)
 *   unitHost → unitWeb  头 x-unit-caller: v1.<b64url {pur:'proxy', d, m, t, c, iat}>.<mac>,钥 = unitWeb 的 per-boot proxyCallerKey
 *                        (≠ internalSecret ≠ p2pSecret ≠ 将来 /unit/mcp 的钥);/unit/mcp* 永不签(§6.2-7)
 *   unitWeb → 引擎      头 x-forsion-remote-caller: b64url({u,k,n,p,r}),只在 via==='tunnel' 且验签通过时盖,头表从零重建
 *
 * 为什么 loopback 这一跳还要签:unitWeb 只凭「loopback + internalSecret」认隧道,本机任何拿到 internalSecret 的进程都能自称隧道;
 * 调用方身份是另一件事,绑到这次派发(d = 信封 id,一次性)、方法与**实际发出**的请求目标(t),60s 窗,换一个请求就不能复用。
 *
 * ⚠️ 身份不是信任:这里只回答「是谁」;要不要给会话档由 K4 的 remoteAccess 闸按 unit id + 本机首次确认判(INV-MONO:
 * 没有断言 / 断言验不过的调用方,待遇永不优于一台未受信的已登记设备)。
 */
import { createHmac, timingSafeEqual } from 'node:crypto'

export type UnitKind = 'phone' | 'desktop'

/** hub 验过的调用方设备(与 server unit-hub services/hub.ts 的 ProxyCaller 同形;跨仓各写一份)。 */
export interface ProxyCaller {
  unit: string
  kind: UnitKind
  /** registered_name ?? name(登记后改不动的标签,不作信任依据),≤120 */
  name: string
  platform: string | null
  registeredAt: string | null
}

/** unitHost → unitWeb(loopback)。 */
export const UNIT_CALLER_HEADER = 'x-unit-caller'
/** unitWeb → 引擎。 */
export const ENGINE_CALLER_HEADER = 'x-forsion-remote-caller'

/** 断言有效期(|now - iat|)与重放表条目寿命。表项寿命 > 窗口:窗口内同一个 d 必然还在表里。 */
const ASSERTION_WINDOW_MS = 60_000
const SEEN_TTL_MS = 120_000

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const KINDS: ReadonlySet<string> = new Set<UnitKind>(['phone', 'desktop'])
/** 名字是登记者自选的不可信串:剥控制符、零宽与双向覆写(防在确认框 / 审批卡上伪装成别的名字)。 */
const UNSAFE_CHARS = /[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2060-\u2069\ufeff]/g

const cleanText = (v: unknown, max: number): string | null =>
  typeof v === 'string' ? v.replace(UNSAFE_CHARS, '').trim().slice(0, max) : null

/** 信封里的 proxyCaller 不信形状:uuid / kind 枚举必须过;name 去控制符截 120,platform / registeredAt 截 40。不合格 → null。 */
export function sanitizeProxyCaller(raw: unknown): ProxyCaller | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const r = raw as Record<string, unknown>
  if (typeof r.unit !== 'string' || !UUID_RE.test(r.unit)) return null
  if (typeof r.kind !== 'string' || !KINDS.has(r.kind)) return null
  return {
    unit: r.unit.toLowerCase(),
    kind: r.kind as UnitKind,
    name: cleanText(r.name, 120) ?? '',
    platform: cleanText(r.platform, 40) || null,
    registeredAt: cleanText(r.registeredAt, 40) || null,
  }
}

const b64 = (s: string): string => Buffer.from(s, 'utf8').toString('base64url')
const macOf = (key: string, body: string): Buffer => createHmac('sha256', key).update('v1.' + body).digest()

/** 签 x-unit-caller。target = unitHost **实际发出**的 pathname+search(不是信封原始 path —— URL 解析会规整点段 / 转义空格)。 */
export function signProxyCaller(key: string, a: { dispatchId: string; method: string; target: string; caller: ProxyCaller; nowMs?: number }): string {
  const body = b64(JSON.stringify({ pur: 'proxy', d: a.dispatchId, m: a.method, t: a.target, c: a.caller, iat: a.nowMs ?? Date.now() }))
  return `v1.${body}.${macOf(key, body).toString('base64url')}`
}

export type CallerCheck =
  | { ok: true; caller: ProxyCaller; dispatchId: string }
  | { ok: false; reason: 'malformed' | 'bad-mac' | 'purpose' | 'method' | 'target' | 'stale' | 'replay' }

/**
 * 验 x-unit-caller。req.url = unitWeb 收到的**原始**请求目标(不是去掉投影前缀后的 url)。顺序:格式 → MAC → 用途 → 方法 → 目标 → 时窗 → 重放;
 * 重放表只在全部通过后才记(MAC 之前就记 = 任何人都能往表里灌垃圾)。
 */
export function verifyProxyCaller(key: string, header: string, req: { method: string; url: string }, seen: Map<string, number>, nowMs = Date.now()): CallerCheck {
  if (!key || typeof header !== 'string' || header.length > 8192) return { ok: false, reason: 'malformed' }
  const m = /^v1\.([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]+)$/.exec(header)
  if (!m) return { ok: false, reason: 'malformed' }
  const given = Buffer.from(m[2], 'base64url')
  const want = macOf(key, m[1])
  if (given.length !== want.length || !timingSafeEqual(given, want)) return { ok: false, reason: 'bad-mac' }
  let p: Record<string, unknown>
  try { p = JSON.parse(Buffer.from(m[1], 'base64url').toString('utf8')) as Record<string, unknown> } catch { return { ok: false, reason: 'malformed' } }
  if (!p || typeof p !== 'object' || Array.isArray(p)) return { ok: false, reason: 'malformed' }
  if (p.pur !== 'proxy') return { ok: false, reason: 'purpose' }
  if (p.m !== req.method) return { ok: false, reason: 'method' }
  if (p.t !== req.url) return { ok: false, reason: 'target' }
  if (typeof p.iat !== 'number' || !Number.isFinite(p.iat) || Math.abs(nowMs - p.iat) > ASSERTION_WINDOW_MS) return { ok: false, reason: 'stale' }
  const d = p.d
  if (typeof d !== 'string' || !d || d.length > 128) return { ok: false, reason: 'malformed' }
  const caller = sanitizeProxyCaller(p.c)
  if (!caller) return { ok: false, reason: 'malformed' }
  const exp = seen.get(d)
  if (exp !== undefined && exp > nowMs) return { ok: false, reason: 'replay' }
  seen.set(d, nowMs + SEEN_TTL_MS)
  return { ok: true, caller, dispatchId: d }
}

/** 重放表清理(unitWeb 的 gc() 每请求调)。 */
export function gcSeenCallers(seen: Map<string, number>, nowMs = Date.now()): void {
  for (const [d, exp] of seen) if (exp <= nowMs) seen.delete(d)
}

/** unitHost 该不该给这条路径签 proxy 断言:/unit/mcp* 永不(P2 的设备 MCP 用另一把钥 + pur:'mcp',两种断言互不可替,方案 §6.2-6/7)。
 *  判前先规整(解百分号、折叠斜杠、小写),`/unit//mcp`、`/UNIT/%6dcp` 之类绕不过去。 */
export function proxyAssertionAllowed(pathname: string): boolean {
  let p = pathname
  try { p = decodeURIComponent(pathname) } catch { /* 坏百分号:按原串判 */ }
  p = p.replace(/[\\/]+/g, '/').toLowerCase()
  return !/^\/unit\/mcp(?:\/|$)/.test(p)
}

/** unitWeb → 引擎的调用方头:b64url(JSON {u,k,n,p,r}),ASCII 安全(名字可能是中文)。 */
export function encodeEngineCaller(c: ProxyCaller): string {
  return b64(JSON.stringify({ u: c.unit, k: c.kind, n: c.name, p: c.platform, r: c.registeredAt }))
}

// ── 调用方分类(R-09,K1 所有;K4 的会话档闸与 K2 的托盘标签消费) ───────────────────────────────

/**
 * 执行设备眼里的调用方。只由 unitWeb 按来路 + 验过的断言判定,绝不由请求自报:
 *   unit    —— 隧道 + hub 盖章 + unitHost 签名 + unitWeb 验签通过(已登记设备,手机;以后桌面)
 *   account —— 隧道、无断言(设备页浏览器 / Genesis web / 老 App / 老 hub)
 *   paired  —— 局域网配对 Bearer(无账号身份,最低档)
 *   p2p     —— P2P 执行器来路。/unit/p2p/offer 收局域网配对 Bearer(unitWeb.ts `authed`),信道可能由配对设备开出:
 *              **永不高于 paired**;信任按 account 的条目判(INTEGRATION R-09 / K4)
 */
export type UnitCaller =
  | { kind: 'unit'; caller: ProxyCaller }
  | { kind: 'account' }
  | { kind: 'paired'; pairId: string; name: string }
  | { kind: 'p2p' }

export type CallerVia = 'tunnel' | 'p2p' | 'lan'

/** 来路 + 配对记录 + 验过的断言 → 调用方。caller 只在隧道来路生效(resolveCaller 对别的来路本就回 null,这里再守一道)。
 *  来路缺失 / 局域网却查不到配对记录(回收竞态)→ 按 paired(最低档)处理,失败偏严。 */
export function callerOf(via: CallerVia | null | undefined, pair: { pairId: string; name: string } | null | undefined, caller: ProxyCaller | null | undefined): UnitCaller {
  if (via === 'tunnel') return caller ? { kind: 'unit', caller } : { kind: 'account' }
  if (via === 'p2p') return { kind: 'p2p' }
  return { kind: 'paired', pairId: pair?.pairId ?? '', name: pair?.name ?? '' }
}

export type CallerPrincipal = `unit:${string}` | 'account' | 'lan' | 'p2p'

export function callerPrincipal(c: UnitCaller): CallerPrincipal {
  switch (c.kind) {
    case 'unit': return `unit:${c.caller.unit}`
    case 'account': return 'account'
    case 'p2p': return 'p2p'
    default: return 'lan'
  }
}
