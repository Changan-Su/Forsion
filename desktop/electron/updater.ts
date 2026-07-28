/**
 * 应用内自动更新封装(electron-updater)——检查 / 下载 / 安装(quitAndInstall)三步全手动流程。
 *
 *  - Windows(NSIS)/ Linux(AppImage):走 electron-updater 完整应用内更新(检测→下载→重启安装)。
 *  - macOS:未签名应用无法经 Squirrel.Mac 自装(硬性要求 Developer ID 签名+公证+zip 目标),
 *    因此 mac 仅经 GitHub API 比对最新 release 版本做「检测」,UI 引导用户去 Releases 页手动下载。
 *
 * 所有状态经主窗口 webContents 广播 'updater:status' 给渲染层;dev 未打包态 electron-updater
 * 无 app-update.yml 会抛 → 统一 no-op 返回 phase:'unsupported'。
 */
import { app, BrowserWindow } from 'electron'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import electronUpdater from 'electron-updater'
import { forsionHomeDir } from './forsionHome'
import { isNewer, notesToString } from './updaterUtil'

// electron-updater 是 CJS 默认导出对象;ESM 下解构取 autoUpdater 最稳。
const { autoUpdater } = electronUpdater

const GH_OWNER = 'Changan-Su'
const GH_REPO = 'Forsion' // 2026-07-05 GitHub 仓已改名(旧名 Tangu 经重定向仍可达,老客户端不断链)

export type UpdaterPhase =
  | 'idle' | 'checking' | 'available' | 'not-available'
  | 'downloading' | 'downloaded' | 'error' | 'unsupported'

export interface UpdaterStatus {
  phase: UpdaterPhase
  version?: string
  releaseNotes?: string
  percent?: number
  error?: string
}

let wired = false
let lastStatus: UpdaterStatus = { phase: 'idle' }

function broadcast(status: UpdaterStatus): void {
  lastStatus = status
  for (const w of BrowserWindow.getAllWindows()) {
    if (!w.isDestroyed()) w.webContents.send('updater:status', status)
  }
}

/** dev/未打包态:electron-updater 无 app-update.yml 会抛 → 统一 no-op。 */
function unsupported(): boolean {
  return !app.isPackaged
}

// ── 测试版通道 ──────────────────────────────────────────────────────────────
/**
 * 偏好落 `~/.forsion/config.json` 的 `updater.beta`(与 providers/browser 等段同一份真源)。
 * **每次检查都现读**,而不是启动时缓存进内存 —— 检查有三条入口(渲染层设置页 / 启动自检 /
 * 托盘菜单 checkUpdates),现读才保证三条一致,也免去一套「改了要通知主进程」的管线。
 */
export async function betaChannelOn(): Promise<boolean> {
  try {
    const c = JSON.parse(await readFile(join(forsionHomeDir(), 'config.json'), 'utf8'))
    return c?.updater?.beta === true
  } catch { return false } // 缺省=只收正式版
}

/**
 * 把通道意图交给 electron-updater(Win/Linux 走它)。
 *
 * ⚠️ **`channel` 与 `allowPrerelease` 要一起设**:前者决定读哪份 feed(`beta.yml` vs `latest.yml`),
 * 后者决定 electron-updater 是否愿意接受带 `-beta.x` 的版本号。只设 channel 会被版本号那关拦下。
 * ⚠️ 关掉时必须显式设回 `latest`/false —— 用户关了开关又没重启 app 的话,进程里还留着上次的值。
 */
function applyChannel(beta: boolean): void {
  autoUpdater.channel = beta ? 'beta' : 'latest'
  autoUpdater.allowPrerelease = beta
}

function ensureWired(): void {
  if (wired) return
  wired = true
  autoUpdater.autoDownload = false // 手动下载
  autoUpdater.autoInstallOnAppQuit = false // 全程手动:下完不主动在退出时装
  autoUpdater.on('checking-for-update', () => broadcast({ phase: 'checking' }))
  autoUpdater.on('update-available', (info) =>
    broadcast({ phase: 'available', version: info.version, releaseNotes: notesToString(info.releaseNotes) }))
  autoUpdater.on('update-not-available', () => broadcast({ phase: 'not-available' }))
  autoUpdater.on('download-progress', (p) =>
    broadcast({ phase: 'downloading', percent: Math.round(p.percent) }))
  autoUpdater.on('update-downloaded', (info) =>
    broadcast({ phase: 'downloaded', version: info.version }))
  autoUpdater.on('error', (err) =>
    broadcast({ phase: 'error', error: err?.message || String(err) }))
}

/**
 * macOS:仅经 GitHub API 检测最新 release 版本(不下载/不自装)。
 *
 * 通道语义天然由端点承担:`/releases/latest` **按 GitHub 定义就排除 prerelease**,
 * 所以正式通道什么都不用做,beta 包发出去也照不到。开了测试版才改列 `/releases`
 * (含 prerelease、草稿要自己滤),再按 semver 挑最高的一个。
 */
async function checkMac(): Promise<UpdaterStatus> {
  broadcast({ phase: 'checking' })
  try {
    const beta = await betaChannelOn()
    const url = beta
      ? `https://api.github.com/repos/${GH_OWNER}/${GH_REPO}/releases?per_page=20`
      : `https://api.github.com/repos/${GH_OWNER}/${GH_REPO}/releases/latest`
    const res = await fetch(url, { headers: { Accept: 'application/vnd.github+json' } })
    if (!res.ok) throw new Error(`GitHub API ${res.status}`)
    const data: any = await res.json()
    // 列表形态:滤掉草稿,按 semver 取最高(GitHub 按发布时间排,时间序 ≠ 版本序 ——
    // 补发一个老版本的热修就会排在最前,直接取 [0] 会把用户往回降级)。
    const pick = (): { tag: string; body?: unknown } | null => {
      if (!Array.isArray(data)) return data?.tag_name ? { tag: String(data.tag_name), body: data.body } : null
      let best: { tag: string; body?: unknown } | null = null
      for (const r of data) {
        if (r?.draft) continue
        const tag = String(r?.tag_name || '').replace(/^v/i, '')
        if (!tag) continue
        if (!best || isNewer(tag, best.tag)) best = { tag, body: r.body }
      }
      return best
    }
    const top = pick()
    const remote = top?.tag || ''
    if (remote && isNewer(remote, app.getVersion())) {
      broadcast({ phase: 'available', version: remote, releaseNotes: typeof top?.body === 'string' ? top.body : undefined })
    } else {
      broadcast({ phase: 'not-available' })
    }
  } catch (err: any) {
    broadcast({ phase: 'error', error: err?.message || String(err) })
  }
  return lastStatus
}

export function getUpdaterStatus(): UpdaterStatus {
  return lastStatus
}

export async function checkForUpdates(): Promise<UpdaterStatus> {
  if (unsupported()) {
    const s: UpdaterStatus = { phase: 'unsupported' }
    broadcast(s)
    return s
  }
  if (process.platform === 'darwin') return checkMac()
  ensureWired()
  applyChannel(await betaChannelOn()) // 每次检查前现读,设置页改完不必重启
  try {
    await autoUpdater.checkForUpdates() // 事件流驱动 UI,不依赖返回值
  } catch (err: any) {
    broadcast({ phase: 'error', error: err?.message || String(err) })
  }
  return lastStatus
}

export async function downloadUpdate(): Promise<void> {
  if (unsupported() || process.platform === 'darwin') return
  ensureWired()
  try {
    await autoUpdater.downloadUpdate()
  } catch (err: any) {
    broadcast({ phase: 'error', error: err?.message || String(err) })
  }
}

/**
 * Win/Linux:退出并安装(isSilent=false 显示安装器,isForceRunAfter=true 装完重启 app)。
 * 调用方(main 的 updater:install 处理器)须先优雅停后端,避免 before-quit 的 app.exit(0)
 * 截断 electron-updater 的退出安装路径。
 */
export function installUpdate(): void {
  if (unsupported() || process.platform === 'darwin') return
  autoUpdater.quitAndInstall(false, true)
}
