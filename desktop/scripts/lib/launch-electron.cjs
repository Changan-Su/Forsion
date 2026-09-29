/**
 * 台架启动 Electron 的唯一入口:`const electron = require('./lib/launch-electron.cjs')`,用法同 playwright 的 `_electron`。
 *
 * macOS 上追加 `-ApplePersistenceIgnoreState YES`。台架与用户的 dev 实例共用 node_modules/electron/dist/Electron.app
 * (bundle id com.github.Electron),任何一个实例崩过或被强杀后,之后每次启动都会在 ready 之前弹「重新打开窗口」模态框
 * (NSPersistentUIRestorer → NSAlert runModal)。台架窗口不在前台,没人点,主进程就卡死,表现为 firstWindow 超时、
 * app.isReady() 一直 false。这是 Cocoa 参数域,只作用于本进程,不改系统设置。
 * 必须排在应用路径之后(放在前面 `YES` 会被当成应用路径),所以一律追加到 args 末尾。主进程读 argv 只认 forsion:// 链接。
 * electron/harnessLaunch.test.ts 钉住:scripts/ 里别的脚本不许再直接用 playwright 的 `_electron`。
 */
const { _electron } = require('playwright-core')

const MAC_FLAGS = exports.MAC_FLAGS = process.platform === 'darwin' ? ['-ApplePersistenceIgnoreState', 'YES'] : []

exports.launch = (opts = {}) => _electron.launch({ ...opts, args: [...(opts.args ?? []), ...MAC_FLAGS] })
