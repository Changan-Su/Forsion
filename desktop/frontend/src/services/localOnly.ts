/**
 * 「只许本机」提示(设备能力 MCP 方案 §6.6)。设备页 = 别的设备经隧道 / P2P / 局域网打开本机曝出的网页;
 * 它调到远端不许用的引擎路由(装插件、改通道配置…)或不可逆的 vault 删除时,本机 unitWeb 回
 * 403 `{ code: 'LOCAL_ONLY' }`。共享渲染层(backendService.request、设备页 vault 桥)据 code 换成这句本地化提示,
 * 而不是把 unitWeb 那句英文 detail 原样上屏。
 *
 * 引擎对远端请求的另外两种拒绝(契约 C8 / C9,码与 tangu-agent/src/services/remoteOrigin.ts 逐字一致)同样在这里本地化:
 *   REMOTE_CWD_FORBIDDEN —— 远端会话 / run 的工作目录落在根 / 家目录 / 受保护目录(400);
 *   REMOTE_ARGS_OVERRIDE_FORBIDDEN —— 远端答审批时改了参数(400)。
 */
import { registerMessages, translate } from '../i18n'
import { REMOTE_CALLER_UNCONFIRMED, REMOTE_SESSIONS_OFF, type TrustReason } from '../../../shared/remoteSessions' // P1-K4

registerMessages({
  'unitpage.localOnly': {
    zh: '该操作只能在那台设备本机上进行，远程连接不可用',
    en: 'This action is only available on that device itself, not over a remote connection',
  },
  'unitpage.remoteCwd': {
    zh: '远程会话不能使用这个工作目录（文件系统根目录、主目录、存放受保护配置的文件夹，以及应用自己的数据目录都不行；网盘和 iCloud 里的项目可以），请换一个项目文件夹',
    en: "A remote session can't use this working folder (the filesystem root, the home folder, folders holding protected configuration and apps' own data folders aren't allowed; projects in cloud drives and iCloud are fine). Pick a project folder instead",
  },
  'unitpage.remoteArgsOverride': {
    zh: '远程连接下不能修改审批的参数，请原样批准或拒绝；要改命令请在那台设备本机上操作',
    en: "Over a remote connection an approval can't be edited. Approve or reject it as is, or change it on that device itself",
  },
})

// P1-K4 ── 「允许远程会话」的会话档闸(unitWeb /engine,码见 shared/remoteSessions.ts):开关关 / 调用方还没在那台电脑上被允许。
registerMessages({
  'unitpage.remoteSessionsOff': {
    zh: '那台电脑没有开启远程会话。可以查看、回答审批和停止任务；要在上面运行任务，请在那台电脑的「设置 › 远程会话」中开启。',
    en: 'Remote sessions are turned off on that computer. You can still view, answer approvals and stop tasks. To run tasks there, turn on Settings › Remote sessions on that computer.',
  },
  'unitpage.remoteCallerUnconfirmed': {
    zh: '正在等待那台电脑确认。请在那台电脑上点「允许」后再试。',
    en: 'Waiting for that computer to allow this. Choose Allow there, then try again.',
  },
  'unitpage.remoteCallerDenied': {
    zh: '那台电脑拒绝了这次远程会话请求，10 分钟后可以再次请求。',
    en: 'That computer declined this remote session request. You can ask again in 10 minutes.',
  },
  // reason(shared/remoteSessions.ts TrustReason):不是在等人点「允许」的那几种,各说各的出路,不说「正在等待确认」
  'unitpage.remoteCallerStrict': {
    zh: '那台电脑只允许这类连接查看、回答审批和停止任务，不会再弹框询问。要在上面运行任务，请在那台电脑的「设置 › 远程会话」中允许「本账号的浏览器与网页版」。',
    en: 'That computer only lets connections like this one view sessions, answer approvals and stop tasks, and it won\'t ask again. To run tasks there, allow "This account\'s browsers and web app" in Settings › Remote sessions on that computer.',
  },
  'unitpage.remoteCallerNeverPrompts': {
    zh: '那台电脑还没有允许这个连接运行会话，而 P2P 连接不会在那边弹框询问。请在那台电脑的「设置 › 远程会话」中允许「本账号的浏览器与网页版」，或先经「中转」打开一次。',
    en: 'That computer hasn\'t allowed this connection to run sessions, and P2P connections don\'t ask there. Allow "This account\'s browsers and web app" in Settings › Remote sessions on that computer, or open it once through Relay.',
  },
  'unitpage.remoteCallerNotSignedIn': {
    zh: '那台电脑没有登录 Forsion 账号，无法确认这次请求。请先在那台电脑上登录，然后再试。',
    en: "That computer isn't signed in to Forsion, so it can't confirm this request. Sign in there, then try again.",
  },
  // P1-KF:不许诺「10 分钟后可以再次请求」—— 账号对不上时 10 分钟后再请求照样被拒(冷却只是节流),出路是换同一个账号。
  'unitpage.remoteCallerRosterMiss': {
    zh: '那台电脑在它登录的账号里找不到这台设备，不会弹框询问。请确认两台设备登录的是同一个 Forsion 账号，然后稍后再试。',
    en: "That computer can't find this device in the account it's signed in to, so it won't ask. Make sure both devices are signed in to the same Forsion account, then try again later.",
  },
  'unitpage.remoteCallerRosterUnreachable': {
    zh: '那台电脑暂时无法向 Forsion 核对这台设备。请稍后再试。',
    en: "That computer can't check this device with Forsion right now. Try again in a moment.",
  },
  'unitpage.remoteCallerNoAnswer': {
    zh: '那台电脑上没有人回应确认框。请稍后再试。',
    en: 'No one answered the prompt on that computer. Try again in a minute.',
  },
  'unitpage.remoteCallerBusy': {
    zh: '那台电脑上有太多待确认的请求。请稍后再试。',
    en: 'That computer has too many requests waiting for confirmation. Try again shortly.',
  },
})

// P1-KF:state 分句 —— pending = 弹框开着 / 在队里(真的在等);unconfirmed 且没有 reason = 还没问过 / 弹框没等到回答就收了,
// 那台电脑上此刻**没有**弹框,不能说「正在等待确认」(与 shared/remoteSessions.ts 的 TrustReason 注释同口径)。
registerMessages({
  'unitpage.remoteCallerNotAsked': {
    zh: '那台电脑还没有允许这台设备运行会话。再试一次会在那台电脑上弹框询问。',
    en: "That computer hasn't allowed this device to run sessions yet. Try again to ask for permission there.",
  },
})

const REASON_KEYS: Record<TrustReason, string> = {
  strict: 'unitpage.remoteCallerStrict',
  'never-prompts': 'unitpage.remoteCallerNeverPrompts',
  'not-signed-in': 'unitpage.remoteCallerNotSignedIn',
  'roster-miss': 'unitpage.remoteCallerRosterMiss',
  'roster-unreachable': 'unitpage.remoteCallerRosterUnreachable',
  'no-answer': 'unitpage.remoteCallerNoAnswer',
  busy: 'unitpage.remoteCallerBusy',
}

/** 拒绝体里认得的 reason(shared/remoteSessions.ts TrustReason);不认的 / 缺席 = null(按 state 出句)。K8 手机弹层与本文件共用。 */
export function trustReasonOf(body: unknown): TrustReason | null {
  const r = (body as { reason?: unknown } | null | undefined)?.reason
  return typeof r === 'string' && Object.prototype.hasOwnProperty.call(REASON_KEYS, r) ? (r as TrustReason) : null
}

/**
 * REMOTE_CALLER_UNCONFIRMED 的本地化(P1-K4;设备页 / web / 手机共用):**reason 先于 state**(有 reason = 不是在等人点允许);
 * 没有 reason 时 denied = 被拒(10 分钟后可再请求)、unconfirmed = 还没问过(再试会弹框;此刻没有弹框)、
 * 其余(pending / 缺 state 的老体)= 正在等那台电脑确认。K7 / K8 渲染同一个码时照此口径。
 */
export function remoteCallerMessage(body: unknown): string {
  const r = trustReasonOf(body)
  if (r) return translate(REASON_KEYS[r])
  const state = (body as { state?: unknown } | null | undefined)?.state
  return translate(state === 'denied' ? 'unitpage.remoteCallerDenied' : state === 'unconfirmed' ? 'unitpage.remoteCallerNotAsked' : 'unitpage.remoteCallerUnconfirmed')
}

export const LOCAL_ONLY_CODE = 'LOCAL_ONLY'
export const REMOTE_CWD_FORBIDDEN = 'REMOTE_CWD_FORBIDDEN'
export const REMOTE_ARGS_OVERRIDE_FORBIDDEN = 'REMOTE_ARGS_OVERRIDE_FORBIDDEN'

export function localOnlyMessage(): string {
  return translate('unitpage.localOnly')
}

// P1-K3:受保护路径(凭据 / Forsion 本机配置)的审批只能在执行它的电脑上批准 —— 引擎对远端批准回 403 APPROVAL_LOCAL_ONLY
// (运行中审批与收件箱里的异步审批同一个码)。拒绝照常可以。
registerMessages({
  'approval.localOnlyToast': { zh: '只能在执行它的电脑上批准这项操作', en: 'This can only be approved on the computer running it' },
})
export const APPROVAL_LOCAL_ONLY = 'APPROVAL_LOCAL_ONLY'

const REFUSAL_KEYS: Record<string, string> = {
  [LOCAL_ONLY_CODE]: 'unitpage.localOnly',
  [REMOTE_CWD_FORBIDDEN]: 'unitpage.remoteCwd',
  [REMOTE_ARGS_OVERRIDE_FORBIDDEN]: 'unitpage.remoteArgsOverride',
  // P1-K4
  [REMOTE_SESSIONS_OFF]: 'unitpage.remoteSessionsOff',
  [REMOTE_CALLER_UNCONFIRMED]: 'unitpage.remoteCallerUnconfirmed',
  // P1-K3
  [APPROVAL_LOCAL_ONLY]: 'approval.localOnlyToast',
}

/**
 * 远端拒绝码 → 本地化提示;不认得的码 → null(调用方照旧用 detail / HTTP 状态)。
 * body = 同一个拒绝响应体(P1-KF):REMOTE_CALLER_UNCONFIRMED 必须带上它 —— 只凭码只能出「正在等待确认」,
 * 而 reason(严格档 / 名册缺失 / 未登录 / 没人答 / 排满 …)时那台电脑上根本没有弹框。
 */
export function remoteRefusalMessage(code: unknown, body?: unknown): string | null {
  if (code === REMOTE_CALLER_UNCONFIRMED) return remoteCallerMessage(body)
  const key = typeof code === 'string' && Object.prototype.hasOwnProperty.call(REFUSAL_KEYS, code) ? REFUSAL_KEYS[code] : null
  return key ? translate(key) : null
}

/**
 * 非 2xx 响应体 → 给用户看的一句话:认得的远端拒绝码换成本地化提示,否则取 `detail`,再否则原文 / HTTP 状态。
 * 只读一次 body(调用方之后不能再读)。
 */
export async function httpErrorMessage(r: Response): Promise<{ message: string; code?: string }> {
  const text = await r.text().catch(() => '')
  let j: { code?: unknown; detail?: unknown } | null = null
  try { j = text ? JSON.parse(text) : null } catch { /* 非 JSON */ }
  const code = typeof j?.code === 'string' ? j.code : undefined
  const mapped = remoteRefusalMessage(code, j) // P1-K4 / P1-KF:REMOTE_CALLER_UNCONFIRMED 按 reason / state 分句
  if (mapped) return { message: mapped, code }
  if (typeof j?.detail === 'string' && j.detail) return { message: j.detail, ...(code ? { code } : {}) }
  return { message: text || `HTTP ${r.status}`, ...(code ? { code } : {}) }
}

// P1-K6 ── 调用方身份相关的拒绝(INTEGRATION R-32 / R-04 / R-08)──
// 手机经 hub 打「我的电脑」:原生层取不到 / 不支持调用方凭据时,K8 中继合成 503 CALLER_UNAVAILABLE / CALLER_UNSUPPORTED
// (失败关闭,请求没发出);hub 验票失败回 403 UNIT_CALLER_INVALID / UNIT_CALLER_EXPIRED;unitWeb 验断言失败回
// 403 BAD_CALLER_ASSERTION。都是终局:services/engine/health.ts 的 classify 判 caller-unavailable,不重试。
// 用 Object.assign 追加(不改上面的对象字面量),与别的包的分块互不相撞。
registerMessages({
  'engine.refusal.callerUnavailable': {
    zh: '这台设备暂时拿不到自己的设备身份，请求没有发出。请稍后重试',
    en: "This device couldn't get its device identity right now, so the request wasn't sent. Try again in a moment",
  },
  'engine.refusal.callerUnsupported': {
    zh: '当前版本的 App 不能以已登记设备的身份连接你的电脑，请更新 App',
    en: "This version of the app can't connect to your computer as a registered device. Update the app",
  },
  'engine.refusal.callerExpired': {
    zh: '设备身份凭据已失效，请重试；仍不行请在互联设备里重新登记这台设备',
    en: "This device's identity has expired. Try again, or register this device again under connected devices",
  },
  'engine.refusal.badCallerAssertion': {
    zh: '那台电脑没能验证这次请求的来源，已拒绝。请重试',
    en: "That computer couldn't verify where this request came from and refused it. Try again",
  },
})

Object.assign(REFUSAL_KEYS, {
  CALLER_UNAVAILABLE: 'engine.refusal.callerUnavailable',
  CALLER_UNSUPPORTED: 'engine.refusal.callerUnsupported',
  UNIT_CALLER_INVALID: 'engine.refusal.callerExpired',
  UNIT_CALLER_EXPIRED: 'engine.refusal.callerExpired',
  BAD_CALLER_ASSERTION: 'engine.refusal.badCallerAssertion',
})
