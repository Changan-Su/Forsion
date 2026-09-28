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
  'unitpage.remoteCallerRosterMiss': {
    zh: '那台电脑在它登录的账号里找不到这台设备。请确认两台设备登录的是同一个账号，10 分钟后可以再次请求。',
    en: "That computer can't find this device in the account it's signed in to. Make sure both devices use the same account. You can ask again in 10 minutes.",
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

const REASON_KEYS: Record<TrustReason, string> = {
  strict: 'unitpage.remoteCallerStrict',
  'never-prompts': 'unitpage.remoteCallerNeverPrompts',
  'not-signed-in': 'unitpage.remoteCallerNotSignedIn',
  'roster-miss': 'unitpage.remoteCallerRosterMiss',
  'roster-unreachable': 'unitpage.remoteCallerRosterUnreachable',
  'no-answer': 'unitpage.remoteCallerNoAnswer',
  busy: 'unitpage.remoteCallerBusy',
}

/**
 * REMOTE_CALLER_UNCONFIRMED 的本地化(P1-K4;设备页 / web / 手机共用):**reason 先于 state**(有 reason = 不是在等人点允许);
 * 没有 reason 时 denied = 被拒(10 分钟后可再请求),其余 = 正在等那台电脑确认。K7 / K8 渲染同一个码时照此口径。
 */
export function remoteCallerMessage(body: { state?: unknown; reason?: unknown }): string {
  const r = typeof body.reason === 'string' && Object.prototype.hasOwnProperty.call(REASON_KEYS, body.reason) ? REASON_KEYS[body.reason as TrustReason] : null
  if (r) return translate(r)
  return translate(body.state === 'denied' ? 'unitpage.remoteCallerDenied' : 'unitpage.remoteCallerUnconfirmed')
}

export const LOCAL_ONLY_CODE = 'LOCAL_ONLY'
export const REMOTE_CWD_FORBIDDEN = 'REMOTE_CWD_FORBIDDEN'
export const REMOTE_ARGS_OVERRIDE_FORBIDDEN = 'REMOTE_ARGS_OVERRIDE_FORBIDDEN'

export function localOnlyMessage(): string {
  return translate('unitpage.localOnly')
}

const REFUSAL_KEYS: Record<string, string> = {
  [LOCAL_ONLY_CODE]: 'unitpage.localOnly',
  [REMOTE_CWD_FORBIDDEN]: 'unitpage.remoteCwd',
  [REMOTE_ARGS_OVERRIDE_FORBIDDEN]: 'unitpage.remoteArgsOverride',
  // P1-K4
  [REMOTE_SESSIONS_OFF]: 'unitpage.remoteSessionsOff',
  [REMOTE_CALLER_UNCONFIRMED]: 'unitpage.remoteCallerUnconfirmed',
}

/** 远端拒绝码 → 本地化提示;不认得的码 → null(调用方照旧用 detail / HTTP 状态)。 */
export function remoteRefusalMessage(code: unknown): string | null {
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
  const mapped = code === REMOTE_CALLER_UNCONFIRMED ? remoteCallerMessage(j as { state?: unknown; reason?: unknown }) : remoteRefusalMessage(code) // P1-K4:按 reason / state 分句
  if (mapped) return { message: mapped, code }
  if (typeof j?.detail === 'string' && j.detail) return { message: j.detail, ...(code ? { code } : {}) }
  return { message: text || `HTTP ${r.status}`, ...(code ? { code } : {}) }
}
