/**
 * 主进程抛给界面的错误 → 当前语言的文案。
 *
 * 主进程只给语言中立的原因码:`code` 或 `code: <细节>`(细节是路径 / 底层报错,原样带出);文案在这里套,
 * 切语言跟着走。不认识的原样透传 —— 网络 / 引擎 / 系统报错本来就不是我们的句子,不去猜。
 * 顺带剥掉 ipcRenderer.invoke 拒绝时 Electron 包的 "Error invoking remote method '…': Error: " 前缀
 * (同 marketService 的 unwrapIpcError;那边是另一会话未提交的改动,不互相 import)。
 */
import { translate } from './i18n'

// 字面量 key:i18nCoverage 按字面量扫「用到的 key 都在字典里」,别改成拼接。
const KEYS: Record<string, string> = {
  'not-logged-in': 'ipcerr.notLoggedIn',
  'login-expired': 'ipcerr.loginExpired',
  'vault-missing': 'ipcerr.vaultMissing',
  'mirror-missing': 'ipcerr.mirrorMissing',
  'scan-failed': 'ipcerr.scanFailed',
  'invalid-space-id': 'ipcerr.invalidSpaceId',
  'invalid-plugin-id': 'ipcerr.invalidPluginId',
  'not-user-plugin': 'ipcerr.notUserPlugin',
  'plugin-not-found': 'ipcerr.pluginNotFound',
}

export function ipcErrorText(e: unknown): string {
  const raw = typeof e === 'string' ? e : (e as Error)?.message || String(e)
  const msg = raw.replace(/^Error invoking remote method '[^']+': (?:\w*Error: )?/, '')
  const m = /^([a-z-]+)(?:: ([\s\S]*))?$/.exec(msg)
  const key = m && KEYS[m[1]]
  return key ? translate(key, { detail: m![2] ?? '' }) : msg
}
