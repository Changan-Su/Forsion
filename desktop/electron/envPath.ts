/**
 * GUI 启动的 Electron 只拿到 launchd/桌面会话的**精简 PATH**(mac 上 `/usr/bin:/bin:/usr/sbin:/sbin`,
 * 不含 `/opt/homebrew/bin`)。终端里 `npm run dev` 起的 app 继承的是登录 shell 的完整 PATH ——
 * 于是这类问题**只在安装版复现,dev 永远绿**。
 *
 * 2026-09-06 实测事故:青鸟收藏夹转录无字幕视频时 yt-dlp 报
 * `Postprocessing: ffprobe and ffmpeg not found`,而设置页的环境探测显示 ffmpeg 已安装 ——
 * 因为探测(main.ts `env:check`)补了 PATH,托管引擎 spawn(backendManager)没补,
 * agent 的 run_bash 继承的就是没补的那份。补全逻辑集中在这里,三处共用一份清单。
 */
import { accessSync, constants as fsConstants, existsSync, readlinkSync, realpathSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { delimiter, dirname, join } from 'node:path'

/** 用户态包管理器/版本管理器最常见的安装位置(存在才补)。 */
export function userBinDirs(): string[] {
  const home = homedir()
  // Windows 上 GUI Electron 拿到的 PATH 常缺 nvm/scoop/winget/npm-global 等 per-user 目录 → node/npm/docker 误判未装。
  // 真正让 npm.cmd 等 .cmd shim 能被探测到的是 probeVersion 的 shell:true。
  return process.platform === 'win32'
    ? [
        join(process.env.APPDATA || join(home, 'AppData', 'Roaming'), 'npm'),
        join(home, 'scoop', 'shims'),
        join(process.env.LOCALAPPDATA || join(home, 'AppData', 'Local'), 'Microsoft', 'WindowsApps'),
        join(process.env.ProgramFiles || 'C:\\Program Files', 'nodejs'),
        join(process.env.ProgramFiles || 'C:\\Program Files', 'Git', 'cmd'),
        // Docker Desktop 的 CLI 在这里;装完不重启 app 也找得到(winget 改的是注册表 PATH,本进程的 env 不会跟着变)。
        join(process.env.ProgramFiles || 'C:\\Program Files', 'Docker', 'Docker', 'resources', 'bin'),
      ]
    : [
        '/opt/homebrew/bin', '/usr/local/bin', '/usr/local/sbin',
        join(home, '.local', 'bin'), join(home, '.volta', 'bin'),
        join(home, '.pyenv', 'shims'), join(home, '.cargo', 'bin'),
      ]
}

/** 把真实存在且尚不在 PATH 上的 userBinDirs() **追加**在末尾。
 *  追加而非前置:用户 PATH 里靠前的那份(nvm/volta 钉的版本)仍然优先,这里只负责「找得到」。 */
export function appendUserBinDirs(base: string): string {
  const cur = base.split(delimiter).filter(Boolean)
  const add = userBinDirs().filter((d) => !cur.includes(d) && existsSync(d))
  return [...cur, ...add].join(delimiter)
}

/** Windows 上 env 键可能是 `Path`,按大小写不敏感找回真实键,避免同时出现 Path/PATH 两份。 */
export function pathKeyOf(env: NodeJS.ProcessEnv): string {
  return Object.keys(env).find((k) => k.toUpperCase() === 'PATH') || 'PATH'
}

/** 探测/引导安装子进程用:在 env 副本上补全 PATH。 */
export function envWithFullPath(extra?: Record<string, string>): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env }
  const key = pathKeyOf(env)
  env[key] = appendUserBinDirs(env[key] || '')
  return { ...env, ...(extra || {}) }
}

/**
 * 托管引擎的 PATH 装配 —— **顺序即策略**,单测钉死:
 *   内置 Python(前置,接管:免装、不与用户 python 冲突)
 *   → GUI 继承的 PATH
 *   → 用户 bin 目录(补全,让 ffmpeg/git/brew 装的东西在 run_bash 里找得到)
 *   → 内置 Node(末尾兜底,系统/nvm 有 node 就用系统的,不悄悄换版本)
 */
export function composeEnginePath(base: string, pythonDirs: string[], nodeDirs: string[]): string {
  return [...pythonDirs, appendUserBinDirs(base), ...nodeDirs].filter(Boolean).join(delimiter)
}

/** 没选过开发者目录时 xcrun 的缺省查找:Xcode.app → CLT。 */
const DARWIN_DEVTOOLS_GIT = ['/Applications/Xcode.app/Contents/Developer/usr/bin/git', '/Library/Developer/CommandLineTools/usr/bin/git']

function isExecutableFile(file: string): boolean {
  try {
    if (!statSync(file).isFile()) return false
    accessSync(file, fsConstants.X_OK)
    return true
  } catch { return false }
}

const readlinkOrNull = (file: string): string | null => { try { return readlinkSync(file) } catch { return null } }

/** Apple 的 /usr/bin/git shim 实际会转去的 git:DEVELOPER_DIR > `xcode-select -s` 选中的目录(新旧两代系统
 *  各存一处)> 缺省位置。只读链接、不起 xcode-select 子进程。 */
export function darwinShimTargets(env: NodeJS.ProcessEnv = process.env): string[] {
  const selected = env.DEVELOPER_DIR || ['/var/select/developer_dir', '/var/db/xcode_select_link'].map(readlinkOrNull).find(Boolean)
  return selected ? [join(selected, 'usr', 'bin', 'git')] : DARWIN_DEVTOOLS_GIT
}

/** darwin:按 PATH 查 `git` **实际会命中**的那份能不能用。命中的是 /usr/bin/git shim(含软链到它的)时,
 *  看它转去的那份在不在 —— 光问「机器上有没有真 git」不够:Homebrew 的 git 排在 /usr/bin 后面,
 *  run_bash 里照样先撞上 shim 弹「安装开发者工具」。 */
export function darwinPathGitWorks(pathValue: string, shimTargets: string[] = darwinShimTargets()): boolean {
  const hit = pathValue.split(delimiter).filter(Boolean).map((dir) => join(dir, 'git')).find(isExecutableFile)
  if (!hit) return false
  let real = hit
  try { real = realpathSync(hit) } catch { /* 刚查到又没了:按原路径判 */ }
  return dirname(real) !== '/usr/bin' || shimTargets.some(isExecutableFile)
}

/**
 * 内置 git 挂到 PATH 上 —— 只当兜底,绝不抢用户自己的 git(他的凭据助手、配置、更新的版本都挂在那份上):
 *   - 非 darwin:追加在末尾,用户装的 Git for Windows 排在前面自然先命中。
 *   - darwin:只在 PATH 查到的 git 不能用时**前置**(见 darwinPathGitWorks)。/usr/bin/git 恒在 PATH 上且靠前,
 *     内置那份追加在后面等于没装,没 CLT 的机器一跑 git 就弹「安装开发者工具」。
 */
export function withBundledGit(
  pathValue: string,
  gitDirs: string[],
  platform: NodeJS.Platform = process.platform,
  pathGitWorks: (pathValue: string) => boolean = darwinPathGitWorks,
): string {
  if (!gitDirs.length) return pathValue
  if (platform !== 'darwin') return [pathValue, ...gitDirs].filter(Boolean).join(delimiter)
  return pathGitWorks(pathValue) ? pathValue : [...gitDirs, pathValue].filter(Boolean).join(delimiter)
}
