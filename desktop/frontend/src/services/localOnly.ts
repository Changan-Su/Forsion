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

registerMessages({
  'unitpage.localOnly': {
    zh: '该操作只能在那台设备本机上进行，远程连接不可用',
    en: 'This action is only available on that device itself, not over a remote connection',
  },
  'unitpage.remoteCwd': {
    zh: '远程会话不能使用这个工作目录（文件系统根目录、主目录和存放受保护配置的文件夹都不行），请换一个项目文件夹',
    en: "A remote session can't use this working folder (the filesystem root, the home folder and folders holding protected configuration aren't allowed). Pick a project folder instead",
  },
  'unitpage.remoteArgsOverride': {
    zh: '远程连接下不能修改审批的参数，请原样批准或拒绝；要改命令请在那台设备本机上操作',
    en: "Over a remote connection an approval can't be edited. Approve or reject it as is, or change it on that device itself",
  },
})

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
}

/** 远端拒绝码 → 本地化提示;不是这三种码 → null(调用方照旧用 detail / HTTP 状态)。 */
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
  const mapped = remoteRefusalMessage(code)
  if (mapped) return { message: mapped, code }
  if (typeof j?.detail === 'string' && j.detail) return { message: j.detail, ...(code ? { code } : {}) }
  return { message: text || `HTTP ${r.status}`, ...(code ? { code } : {}) }
}
