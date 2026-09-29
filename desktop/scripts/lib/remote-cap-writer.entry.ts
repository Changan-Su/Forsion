/** remote-cap-writer.cjs 要的桌面主进程模块(一个包,共用同一份 mainI18n)。 */
export { createRemoteSessions, registerRemoteSessionsIpc, withRemoteCap, REMOTE_SESSIONS_FILE } from '../../electron/remoteSessions'
export { createSerialQueue, lockedUpdateJson } from '../../electron/configWrite'
export { forsionHomeDir } from '../../electron/forsionHome'
export { normalizeCap } from '../../shared/remoteSessions'
