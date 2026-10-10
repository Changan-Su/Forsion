/**
 * 台架启动 Electron 的唯一入口:`const electron = require('./lib/launch-electron.cjs')`,用法同 playwright 的 `_electron`。
 *
 * macOS 上追加 `-ApplePersistenceIgnoreState YES`。台架与用户的 dev 实例共用 node_modules/electron/dist/Electron.app
 * (bundle id com.github.Electron),任何一个实例崩过或被强杀后,之后每次启动都会在 ready 之前弹「重新打开窗口」模态框
 * (NSPersistentUIRestorer → NSAlert runModal)。台架窗口不在前台,没人点,主进程就卡死,表现为 firstWindow 超时、
 * app.isReady() 一直 false。这是 Cocoa 参数域,只作用于本进程,不改系统设置。
 * 必须排在应用路径之后(放在前面 `YES` 会被当成应用路径),所以一律追加到 args 末尾。主进程读 argv 只认 forsion:// 链接。
 * electron/harnessLaunch.test.ts 钉住:scripts/ 里别的脚本不许再直接用 playwright 的 `_electron`。
 *
 * 默认工作区跟着临时 TANGU_HOME 走(`workspaceEnv`)。主进程的默认工作区按系统用户目录算(dev = ~/Forsion-Dev,
 * 下面有默认笔记库 Amadeus/ 和 Project/),临时 TANGU_HOME 管不到它:没预置库配置的台架一恢复库(进笔记 / 日历 / Tangu,
 * 或点 ＋),打开的就是开发者真实的库。这里补上 FORSION_WORKSPACE_DIR(electron/forsionHome.ts 的 defaultWorkspaceDir 认它),
 * 主进程照「全新用户」那条路在临时目录里建默认库。
 */
const fs = require('fs')
const os = require('os')
const path = require('path')
const { _electron } = require('playwright-core')

const MAC_FLAGS = exports.MAC_FLAGS = process.platform === 'darwin' ? ['-ApplePersistenceIgnoreState', 'YES'] : []

/** 给台架的 env 补上临时默认工作区;下面三种情况原样返回:
 *   · 没给 TANGU_HOME,或它不在系统临时目录下 —— 只认得临时夹具这一种形态,别的不替它拿主意;
 *   · 调用方自己设了 FORSION_WORKSPACE_DIR;
 *   · 调用方自己覆写了 HOME(check:artificial / check:sandbox / e2e:computerhistory:夹具就摆在 <HOME>/Forsion-Dev 下)。
 *  放在 Forsion 根的**旁边**而不是里面:和真机的 ~/.forsion-dev ↔ ~/Forsion-Dev 一样 —— Forsion 根是受保护目录,
 *  库落在它里面的话,设备页读文件那条路(unitHostScope)会一律拒掉,台架量到的就不是真机的行为了。
 *  根的算法同 forsionHomeDir():TANGU_HOME 的目录名叫 tangu → 根是它的父目录,否则就是它自己。 */
const real = (p) => { try { return fs.realpathSync(p) } catch { return path.resolve(p) } }
/** 在系统临时目录下?字面路径和 realpath 两种写法都认(macOS 的 /var/folders ↔ /private/var/folders):
 *  认漏了不会报错,只会悄悄回落到真实的 ~/Forsion-Dev。 */
const underTmp = (p) => [p, real(p)].some((x) => [path.resolve(os.tmpdir()), real(os.tmpdir())].some((t) => x.startsWith(t + path.sep)))

const workspaceEnv = exports.workspaceEnv = (env) => {
  const home = env && env.TANGU_HOME && path.resolve(env.TANGU_HOME)
  // 空白值按没设算:主进程那头是 trim 之后判空的,这里放过去就等于没隔离。
  if (!home || (env.FORSION_WORKSPACE_DIR || '').trim() || (env.HOME !== undefined && env.HOME !== process.env.HOME)) return env
  const root = path.basename(home) === 'tangu' ? path.dirname(home) : home
  if (!underTmp(root)) return env
  return { ...env, FORSION_WORKSPACE_DIR: `${root}-workspace` }
}

exports.launch = (opts = {}) => _electron.launch({ ...opts, env: workspaceEnv(opts.env), args: [...(opts.args ?? []), ...MAC_FLAGS] })
