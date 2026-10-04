/**
 * tangu CLI 自动安装:桌面 App 启动时把「指向 App 内部资源的薄 shim」写进 ~/.tangu/bin,
 * 并幂等注入 PATH(POSIX shell profile 标记块 / Windows 用户 PATH 注册表)。
 * CLI 自动更新 = 免费:shim 只是一层转发,App 被 electron-updater 原地更新后,
 * resources/tangu-server/dist 即新版;App 被移动/改名 → 下次启动内容比对自愈重写。
 *
 * 硬约束(勿改):
 * - 打包态 better-sqlite3 已被 afterPack 重建为 Electron ABI → shim 必须 ELECTRON_RUN_AS_NODE=1
 *   跑 App 自带的 Electron 二进制,绝不能用系统 node(NODE_MODULE_VERSION 不匹配即崩)。
 * - Linux AppImage 的 process.execPath 是临时挂载点(/tmp/.mount_xxx,每次运行都变)→ shim
 *   必须写 $APPIMAGE 真实路径,并用 `-e` bootstrap 从 process.execPath 自定位 resources;
 *   -e 模式 argv 没有脚本位,须 splice 补回,TUI 才能按 argv[2] 解析子命令。
 * - 模块顶层不 import electron(vitest 直测,marketInstall.ts 同纪律);electron 值全部经参数注入。
 */
import { join } from 'path'
import { existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync } from 'fs'
import { execFile } from 'child_process'

export const CLI_BLOCK_BEGIN = '# >>> Tangu CLI >>>'
export const CLI_BLOCK_END = '# <<< Tangu CLI <<<'

export function posixShimScript(execPath: string, entryPath: string): string {
  return [
    '#!/bin/sh',
    '# Tangu CLI —— 由 Tangu Desktop 自动生成/自愈,请勿手改(App 启动时会按当前安装路径重写)。',
    `exec env ELECTRON_RUN_AS_NODE=1 "${execPath}" "${entryPath}" "$@"`,
    '',
  ].join('\n')
}

export function appImageShimScript(appImagePath: string): string {
  // bootstrap 内只用双引号,整体可安全落在 sh 单引号里。
  const boot =
    'process.argv.splice(1,0,"tangu");' +
    'const p=require("path");const u=require("url");' +
    'import(u.pathToFileURL(p.join(p.dirname(process.execPath),"resources","tangu-server","dist","tui","main.js")).href)' +
    '.catch(e=>{console.error(e);process.exit(1)});'
  return [
    '#!/bin/sh',
    '# Tangu CLI —— 由 Tangu Desktop 自动生成/自愈,请勿手改。',
    `exec env ELECTRON_RUN_AS_NODE=1 "${appImagePath}" -e '${boot}' -- "$@"`,
    '',
  ].join('\n')
}

export function winShimScript(execPath: string, entryPath: string): string {
  return [
    '@echo off',
    'rem Tangu CLI —— 由 Tangu Desktop 自动生成/自愈,请勿手改。',
    'set ELECTRON_RUN_AS_NODE=1',
    `"${execPath}" "${entryPath}" %*`,
    '',
  ].join('\r\n')
}

const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/** 幂等 upsert 标记块:已有 → 原位替换;没有 → 追加。返回新内容与是否变化。 */
export function upsertMarkedBlock(existing: string, body: string): { content: string; changed: boolean } {
  const block = `${CLI_BLOCK_BEGIN}\n${body}\n${CLI_BLOCK_END}`
  const re = new RegExp(`${escapeRe(CLI_BLOCK_BEGIN)}[\\s\\S]*?${escapeRe(CLI_BLOCK_END)}`)
  if (re.test(existing)) {
    const next = existing.replace(re, block)
    return { content: next, changed: next !== existing }
  }
  const sep = existing.length === 0 ? '' : existing.endsWith('\n') ? '\n' : '\n\n'
  return { content: `${existing}${sep}${block}\n`, changed: true }
}

/** POSIX:往 shell profile 写 PATH 标记块(binDir 前置,压过旧的 npm 全局 tangu)。 */
function ensurePosixPath(binDir: string, homeDir: string, platform: NodeJS.Platform, log: (m: string) => void): void {
  const line = `export PATH="${binDir}:$PATH"`
  const profiles = platform === 'darwin' ? ['.zprofile', '.bash_profile'] : ['.zprofile', '.bashrc', '.profile']
  for (const name of profiles) {
    const file = join(homeDir, name)
    // linux 的 .zprofile 只在已存在时维护(别给纯 bash 用户凭空造文件);mac 默认 zsh,恒写 .zprofile。
    if (name === '.zprofile' && platform !== 'darwin' && !existsSync(file)) continue
    try {
      const cur = existsSync(file) ? readFileSync(file, 'utf-8') : ''
      const { content, changed } = upsertMarkedBlock(cur, line)
      if (changed) {
        writeFileSync(file, content, 'utf-8')
        log(`[cli] PATH 块已写入 ${file}`)
      }
    } catch (e: any) {
      log(`[cli] 写 ${file} 失败:${e?.message || e}`)
    }
  }
  // fish:conf.d 单文件整体归我们所有,直接比对覆盖(仅当用户确实用 fish)。
  const fishDir = join(homeDir, '.config', 'fish')
  if (existsSync(fishDir)) {
    try {
      const confDir = join(fishDir, 'conf.d')
      mkdirSync(confDir, { recursive: true })
      const f = join(confDir, 'tangu.fish')
      const want = `# Tangu CLI(由 Tangu Desktop 自动生成)\nif test -d "${binDir}"\n  set -gx PATH "${binDir}" $PATH\nend\n`
      if (!existsSync(f) || readFileSync(f, 'utf-8') !== want) {
        writeFileSync(f, want, 'utf-8')
        log(`[cli] PATH 已写入 ${f}`)
      }
    } catch (e: any) {
      log(`[cli] 写 fish 配置失败:${e?.message || e}`)
    }
  }
}

/** Windows:HKCU 用户 PATH 前置 binDir(PowerShell SetEnvironmentVariable 自带 WM_SETTINGCHANGE 广播,新终端生效)。 */
function ensureWindowsUserPath(binDir: string, log: (m: string) => void): Promise<void> {
  const d = binDir.replace(/'/g, "''")
  const cmd =
    `$d='${d}';` +
    `$p=[Environment]::GetEnvironmentVariable('Path','User');if($null -eq $p){$p=''};` +
    `$parts=$p -split ';' | Where-Object {$_ -ne ''};` +
    `if($parts -notcontains $d){[Environment]::SetEnvironmentVariable('Path', (($d + ';' + $p).Trim(';')), 'User')}`
  return new Promise((resolve) => {
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', cmd], { timeout: 15000, windowsHide: true }, (err) => {
      if (err) log(`[cli] 写用户 PATH 失败:${err.message}`)
      resolve()
    })
  })
}

export interface CliInstallInput {
  isPackaged: boolean
  platform: NodeJS.Platform
  execPath: string
  resourcesPath: string
  /** Linux AppImage 真实文件路径(process.env.APPIMAGE);非 AppImage 传 null。 */
  appImagePath?: string | null
  homeDir: string
  tanguHome: string
  log?: (m: string) => void
}

export interface CliInstallResult {
  ok: boolean
  reason?: string
  binDir?: string
  shimPath?: string
}

/** 幂等安装/自愈 tangu CLI(吞错不阻塞启动;dev 态跳过)。 */
export async function ensureCliInstalled(i: CliInstallInput): Promise<CliInstallResult> {
  const log = i.log ?? ((): void => {})
  try {
    if (!i.isPackaged) return { ok: false, reason: 'dev 态跳过(开发用 node dist/tui/main.js)' }
    const entry = join(i.resourcesPath, 'tangu-server', 'dist', 'tui', 'main.js')
    if (!existsSync(entry)) return { ok: false, reason: `CLI 入口不存在:${entry}` }
    const binDir = join(i.tanguHome, 'bin')
    mkdirSync(binDir, { recursive: true })
    const isWin = i.platform === 'win32'
    const shimPath = join(binDir, isWin ? 'tangu.cmd' : 'tangu')
    const desired = isWin
      ? winShimScript(i.execPath, entry)
      : i.platform === 'linux' && i.appImagePath
        ? appImageShimScript(i.appImagePath)
        : posixShimScript(i.execPath, entry)
    const cur = existsSync(shimPath) ? readFileSync(shimPath, 'utf-8') : ''
    if (cur !== desired) {
      writeFileSync(shimPath, desired, 'utf-8')
      if (!isWin) chmodSync(shimPath, 0o755)
      log(`[cli] shim 已写入 ${shimPath}`)
    }
    if (isWin) await ensureWindowsUserPath(binDir, log)
    else ensurePosixPath(binDir, i.homeDir, i.platform, log)
    return { ok: true, binDir, shimPath }
  } catch (e: any) {
    log(`[cli] 安装失败(不阻塞启动):${e?.message || e}`)
    return { ok: false, reason: String(e?.message || e) }
  }
}
