/**
 * unitWeb `/engine/*` 的第二道闸(设备能力 MCP 方案 P1 · K4 §3.3):在 P0 default-deny 允许清单之上再分两档。
 *   基础档 —— 查看(GET / HEAD)、答审批 / 询问、停止、Agent Desk 截图回传、少量不起执行也不建 / 改会话的杂务;
 *   会话档 —— 其余 allow 行(起 run、steer、建 / 改会话、上传附件、朗读、识图、把 Muse TODO 交给 Muse 执行…)。
 * 只会更严、绝不放宽:只对 engineRouteAccess === 'allow' 的请求判;新 allow 路由缺省落会话档(更严的一档)。
 * 刻意零 electron 依赖(vitest 直测)。
 */
import { ENGINE_ROUTES } from './engineRoutes.generated'
import type { UnitCaller } from './unitCaller'
import { REMOTE_CALLER_UNCONFIRMED, REMOTE_SESSIONS_OFF, type GateResult, type TrustReason, type TrustState } from '../shared/remoteSessions'

export type RemoteEngineTier = 'base' | 'session'

/**
 * 非 GET 的基础档(显式表,模板与 engineRoutes.generated.ts 逐字一致 —— remoteSessionGate.test 钉住每行都在表里且为 allow)。
 * GET / HEAD 的 allow 行一律基础档。
 */
export const REMOTE_BASE_TIER_NON_GET: ReadonlyArray<readonly [method: string, path: string]> = [
  ['POST', '/agent/runs/:runId/approvals/:approvalId'], // 答审批(D1 / D2)
  ['POST', '/agent/runs/:runId/inquiries/:inquiryId'], // 答询问(D1)
  ['POST', '/agent/special/approvals/:id/approve'], // 异步审批(D2)
  ['POST', '/agent/special/approvals/:id/reject'],
  ['POST', '/agent/runs/:id/abort'], // 远端停止(§6.1 急停「远端停止额外允许」)
  // Agent Desk 截图回传:回应本机 run 的 desk_screenshot,shotId 随机且绑 run(P0 ②),与答审批同类;
  // 放进会话档会让开关关时看着本机 run 的设备页把这个工具拖到超时。
  ['POST', '/agent/runs/:runId/captures/:shotId'],
  // 不起执行、不建 / 改会话的杂务(K4 §8 设计文档修正 1;开关关时设备页的收件箱照常可用):
  ['PATCH', '/agent/inbox/:id'],
  ['DELETE', '/agent/inbox/:id'],
  ['POST', '/agent/inbox/:id/claim'],
  ['POST', '/agent/inbox/pull'],
  ['POST', '/agent/inbox/read-all'],
  ['PATCH', '/agent/special/muse/todos/:id'], // 只改卡片状态(落点 / 忽略);`…/approve` 起自主执行,在会话档
  ['POST', '/agent/reply-segments'], // 只读辅助
  ['POST', '/agent/commands/:name/expand'],
]

const escapeRe = (x: string): string => x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
const compile = (path: string): RegExp =>
  new RegExp('^' + path.split('/').map((seg) => (seg.startsWith(':') ? '[^/]+' : escapeRe(seg.toLowerCase()))).join('/') + '$')
const BASE_KEYS = new Set(REMOTE_BASE_TIER_NON_GET.map(([m, p]) => `${m} ${p.toLowerCase()}`))
/** 与 unitWeb 允许清单同一套编译方式(小写、`:param` → `[^/]+`)。只收 allow 行:闸只对它们判。 */
const ALLOW_ROWS = ENGINE_ROUTES.filter((r) => r.access === 'allow').map((r) => ({
  method: r.method,
  base: BASE_KEYS.has(`${r.method} ${r.path.toLowerCase()}`),
  re: compile(r.path),
}))

/**
 * 规整后路径(unitWeb engineTarget 的输出)的档位。HEAD 按 GET;GET 一律基础档。
 * 同一请求命中多行时**任一行是会话档即会话档**;一行都没命中(调用方本不该把非 allow 请求交进来)→ 会话档(失败偏严)。
 */
export function remoteEngineTier(method: string, normPath: string): RemoteEngineTier {
  const m = method.toUpperCase() === 'HEAD' ? 'GET' : method.toUpperCase()
  if (m === 'GET') return 'base'
  const p = normPath.toLowerCase()
  let hit = false
  for (const r of ALLOW_ROWS) {
    if (r.method !== m || !r.re.test(p)) continue
    if (!r.base) return 'session'
    hit = true
  }
  return hit ? 'base' : 'session'
}

/** detail 英文(同 LOCAL_ONLY_BODY 口径),本地化在渲染层按 code 换。 */
export const REMOTE_SESSIONS_OFF_DETAIL = 'Remote sessions are turned off on this device'
export const REMOTE_CALLER_UNCONFIRMED_DETAIL = 'This caller has not been allowed on this device yet'

export const offResult = (): GateResult => ({ ok: false, status: 403, body: { code: REMOTE_SESSIONS_OFF, detail: REMOTE_SESSIONS_OFF_DETAIL } })
export const unconfirmedResult = (state: TrustState, reason?: TrustReason): GateResult =>
  ({ ok: false, status: 403, body: { code: REMOTE_CALLER_UNCONFIRMED, detail: REMOTE_CALLER_UNCONFIRMED_DETAIL, state, ...(reason ? { reason } : {}) } })

/**
 * 纯判定(K4 §3.3 真值表 + U1 缺省):
 *   base              → 放行
 *   session, 开关关   → 403 REMOTE_SESSIONS_OFF
 *   session, paired   → 放行(配对时已在本机核对 6 位码;最低信任档)
 *   session, unit / account / p2p → trust === 'trusted' 才放行,否则 403 REMOTE_CALLER_UNCONFIRMED{state}
 * p2p 的 trust 由调用方按 account 条目给(R-09);它只在开关开时拿会话档,永不高于 paired。
 * INV-MONO:没有断言的调用方(account)与未受信的已登记设备拿到同一个 403,待遇不更好。
 */
export function decideRemoteEngine(tier: RemoteEngineTier, enabled: boolean, caller: UnitCaller, trust: TrustState | null, reason?: TrustReason): GateResult {
  if (tier === 'base') return { ok: true }
  if (!enabled) return offResult()
  if (caller.kind === 'paired') return { ok: true }
  if (trust === 'trusted') return { ok: true }
  return unconfirmedResult(trust ?? 'unconfirmed', reason) // reason 只描述「为什么不是在等人确认」,不影响放不放行
}

/** unitWeb 没拿到 remoteAccess 依赖(便携 Unit 的 public 投影之外的别的调用方、e2e 漏传)时的缺省:只放基础档(fail closed)。 */
export function baseTierOnly(method: string, normPath: string): GateResult {
  return remoteEngineTier(method, normPath) === 'base' ? { ok: true } : offResult()
}
