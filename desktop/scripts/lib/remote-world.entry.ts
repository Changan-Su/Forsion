/**
 * 远程会话台架(remote-world.cjs)要的桌面主进程模块,**一个入口打成一个包**:各模块共用同一份 mainI18n
 * (defineMainMessages 的登记表与 mt 必须是同一个实例 —— 分开打包,approvalDelivery 的文案登记进 A 包,mt 却查 B 包,只会回键名)。
 */
export { startUnitWeb } from '../../electron/unitWeb'
// 隧道客户端与 caps 上报器自 2026-09-28 住在 Forsion Extend(0.6):取已钉的内置包产物(esbuild 一并打进这个包);签名策略仍是宿主的
export { UnitHost, UnitCapsReporter } from '@forsion/extend/dist/desktop.mjs'
export { makeCallerHeaders } from '../../electron/unitCaller'
export { createRemoteSessions, lookupRosterUnit, REMOTE_SESSIONS_FILE } from '../../electron/remoteSessions'
export { createApprovalDelivery } from '../../electron/approvalDelivery'
export { mt, setMainLocale } from '../../electron/mainI18n'
export { forsionAccountId } from '../../shared/forsionAccount'
