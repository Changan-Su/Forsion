/**
 * 远程会话台架(remote-world.cjs)要的桌面主进程模块,**一个入口打成一个包**:各模块共用同一份 mainI18n
 * (defineMainMessages 的登记表与 mt 必须是同一个实例 —— 分开打包,approvalDelivery 的文案登记进 A 包,mt 却查 B 包,只会回键名)。
 */
export { startUnitWeb } from '../../electron/unitWeb'
export { UnitHost } from '../../electron/unitHost'
export { createRemoteSessions, lookupRosterUnit, REMOTE_SESSIONS_FILE } from '../../electron/remoteSessions'
export { createApprovalDelivery } from '../../electron/approvalDelivery'
export { mt, setMainLocale } from '../../electron/mainI18n'
export { forsionAccountId } from '../../shared/forsionAccount'
