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
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, delimiter } from 'node:path'

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
