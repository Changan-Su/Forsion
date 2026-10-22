/**
 * 应用内自动更新封装(electron-updater)——检查 / 下载 / 安装(quitAndInstall)三步全手动流程。
 *
 * **有没有新版看官网,从哪儿下按地区**(2026-10-19 用户定,口径在 shared/updateSource.ts):
 *  - 检查:先拉官网 `/api/website/config` 里本平台安装包的版本;官网答了就以它为准(GitHub 上更新的也不提示),
 *    官网没答上才退回 GitHub API。测试版额外看 GitHub 预发布(官网不放测试版)。
 *  - Windows(NSIS)/ Linux(AppImage):定下版本后,把 electron-updater 的下载源钉到这个版本 ——
 *    GitHub = 该 tag 的 latest*.yml(generic);官网 = WebsiteUpdateProvider(Windows 标准包、官网记录带 sha512 才有)。
 *    一边下不动(出错 / 30 秒没进度)自动换另一边一次;下载中也能手动换。electron-updater 现在只管下载和安装,不再决定有没有新版。
 *  - macOS:未签名应用无法经 Squirrel.Mac 自装(硬性要求 Developer ID 签名+公证+zip 目标),
 *    「下载安装包」在浏览器里直接开这一版 .dmg 的链接,装由用户自己拖。
 *
 * 所有状态广播 'updater:status' 给渲染层;dev 未打包态统一 no-op 返回 phase:'unsupported'。
 */
import { app, BrowserWindow, shell } from 'electron'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import electronUpdater from 'electron-updater'
import { CancellationToken } from 'builder-util-runtime'
import { forsionHomeDir } from './forsionHome'
import { changelogSection, isNewer, isPrerelease, notesToString } from './updaterUtil'
import { BUNDLE_EXTEND } from './distribution'
import { WebsiteUpdateProvider } from './websiteUpdateProvider'
import { checkRevisionUpdate } from './revisionUpdateCheck'
import {
  WEBSITE_API, parseMainland, parseSourcePref, parseWebsiteInstallers, sourceOrder,
  websiteCarries, websiteHas, websitePlatformFor, selectGitHubRelease,
  type UpdateSource, type UpdateSourcePref, type WebsiteInstallers,
} from '../shared/updateSource'

// electron-updater 是 CJS 默认导出对象;ESM 下解构取 autoUpdater 最稳。
const { autoUpdater } = electronUpdater

const GH_OWNER = 'Changan-Su'
const GH_REPO = 'Forsion' // 2026-07-05 GitHub 仓已改名(旧名 Tangu 经重定向仍可达,老客户端不断链)
const GH_API = `https://api.github.com/repos/${GH_OWNER}/${GH_REPO}`
/** 这么久没有新的下载进度就算「下不动」,换另一边。 */
const STALL_MS = 30_000

export type UpdaterPhase =
  | 'idle' | 'checking' | 'available' | 'not-available'
  | 'downloading' | 'downloaded' | 'error' | 'unsupported'

export interface UpdaterStatus {
  phase: UpdaterPhase
  version?: string
  releaseNotes?: string
  /** 同一节的英文版(CHANGELOG.en.md);渲染层英文界面优先用它 */
  releaseNotesEn?: string
  percent?: number
  /** 'unreachable' = 官网和 GitHub 都没答上(渲染层翻译);其余是原始错误信息 */
  error?: string
  /** 这次从哪儿下 */
  source?: UpdateSource
  /** 安装包字节数(知道才有) */
  size?: number
  transferred?: number
  total?: number
  /** 自动换过源:原来那边 */
  fallbackFrom?: UpdateSource
  /** 下载中能手动换到另一边 */
  canSwitch?: boolean
  /** mac:已在浏览器里开了下载链接 */
  opened?: boolean
}

let wired = false
let lastStatus: UpdaterStatus = { phase: 'idle' }
/** 这次要升到的版本与下载顺序;只有检查出新版后才有 */
let target: { version: string; site: WebsiteInstallers | null; order: UpdateSource[] } | null = null
/** electron-updater 现在钉在哪一边 */
let feedSource: UpdateSource | null = null
/** 我们自己 await 的 checkForUpdates 进行中:它的事件(checking / error)由调用处处理,别广播 */
let busy = false
/** 下载进行中:取消令牌、最后一次有进度的时刻、手动要换去的那边 */
type Download = { token: CancellationToken; lastAt: number; manual: UpdateSource | null }
let dl: Download | null = null

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

/** 取一份 JSON;超时 / 断网 / 非 2xx / 坏 JSON 一律 undefined(= 没答上)。 */
async function getJson(url: string, ms: number, headers: Record<string, string> = { Accept: 'application/json' }): Promise<unknown> {
  try {
    const res = await fetch(url, { headers, signal: AbortSignal.timeout(ms) })
    return res.ok ? await res.json() : undefined
  } catch { return undefined }
}

// ── 更新说明的真源:仓库里的 CHANGELOG.md ─────────────────────────────────────
/**
 * 拉目标版本 tag 上的 `desktop/CHANGELOG.md`,抠出那一节当更新说明。
 *
 * ⚠️ 为什么不能用现成的:GitHub Release 的 `body` 是 `--generate-notes` 按提交拼的清单,不是写给用户看的;
 * electron-updater 的 `info.releaseNotes` 来自 latest.yml,默认压根不带。只能回源 CHANGELOG.md。
 * 按 **tag** 取(不是 main):tag 上那份必然含该版本那一节,也不会被后续提交改动影响。
 */
async function sectionFrom(file: string, version: string): Promise<string | undefined> {
  const url = `https://raw.githubusercontent.com/${GH_OWNER}/${GH_REPO}/v${version}/desktop/${file}`
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(8000) })
    if (!res.ok) return undefined
    return changelogSection(await res.text(), version)
  } catch {
    return undefined // 断网 / 私有仓 / tag 不存在:退回原来的说明,不影响升级本身
  }
}
/** 中英两份一起拉(英文 = CHANGELOG.en.md,节标题与中文相同;老 tag 上没有英文版就只有中文)。 */
async function notesFromChangelog(version: string): Promise<{ zh?: string; en?: string }> {
  const [zh, en] = await Promise.all([sectionFrom('CHANGELOG.md', version), sectionFrom('CHANGELOG.en.md', version)])
  return { zh, en }
}

/**
 * 播报「有新版本」:先用手头的说明立刻上屏(UI 不等网),再去拉 CHANGELOG 那一节补上去。
 *
 * ⚠️ 补的时候**只改 releaseNotes 一格**,phase 保持当前值 —— 用户完全可能在拉取回来之前
 * 就点了下载(phase 已是 downloading/downloaded),硬广播 `available` 会把进度条打回去,
 * 而「phase 变了就放弃」又会让下载态永远没有更新说明。版本对不上才丢弃。
 */
function announceAvailable(version: string, fallback: string | undefined, extra: Partial<UpdaterStatus>): void {
  broadcast({ phase: 'available', version, releaseNotes: fallback, ...extra })
  void notesFromChangelog(version).then(({ zh, en }) => {
    if ((!zh || zh === lastStatus.releaseNotes) && (!en || en === lastStatus.releaseNotesEn)) return
    if (lastStatus.version !== version) return // 已经在说另一个版本了
    broadcast({ ...lastStatus, ...(zh ? { releaseNotes: zh } : {}), ...(en ? { releaseNotesEn: en } : {}) })
  })
}

// ── 偏好:测试版通道 + 下载来源 ─────────────────────────────────────────────────
/**
 * 落 `~/.forsion/config.json` 的 `updater` 段(beta / source)。**每次检查都现读**:检查有三条入口
 * (设置页 / 启动自检 / 托盘菜单),现读才保证三条一致,也免去一套「改了要通知主进程」的管线。
 */
async function readUpdaterConfig(): Promise<{ beta: boolean; source: UpdateSourcePref }> {
  try {
    const c = JSON.parse(await readFile(join(forsionHomeDir(), 'config.json'), 'utf8'))
    return { beta: c?.updater?.beta === true, source: parseSourcePref(c?.updater?.source) }
  } catch { return { beta: false, source: 'auto' } } // 缺省 = 只收正式版、按地区选来源
}
export async function betaChannelOn(): Promise<boolean> {
  return (await readUpdaterConfig()).beta
}
export async function updateSourcePref(): Promise<UpdateSourcePref> {
  return (await readUpdaterConfig()).source
}

/**
 * 这台电脑在不在中国大陆(官网 `/api/auth/region`,按出口 IP)。每次启动探一次、只记内存:
 * 出差 / 换网 / 开关 VPN 后下次启动就按新的走。没探出来(null)不记,下次再探。
 */
let mainlandMemo: boolean | null = null
export async function detectMainland(): Promise<boolean | null> {
  // 服务端要现查 IP 归属(ip-api,自带 2.5s 超时),实测 0.6–3s+,给足 8 秒;只影响先走哪边。
  if (mainlandMemo === null) mainlandMemo = parseMainland(await getJson(`${WEBSITE_API}/auth/region`, 8000))
  return mainlandMemo
}

// ── 检查:官网定版本 ───────────────────────────────────────────────────────────
/**
 * GitHub 上最新的 release(草稿不算;列表按 semver 取最高 —— GitHub 按发布时间排,补发老版本的热修会排最前)。
 * beta = 列全部(含预发布);onlyPre = 只看预发布。undefined = 没答上,null = 答了但没有。
 */
async function githubRelease(beta: boolean, onlyPre = false): Promise<{ tag: string; body?: string } | null | undefined> {
  const data: any = await getJson(beta ? `${GH_API}/releases?per_page=20` : `${GH_API}/releases/latest`, 10_000,
    { Accept: 'application/vnd.github+json' })
  if (data === undefined) return undefined
  const best = selectGitHubRelease(data, beta, onlyPre)
  return best ? { tag: best.version, body: best.body } : null
}

/** 定下「最新版本」:官网答了以官网为准(测试版再看 GitHub 预发布);官网没答上才看 GitHub。两边都没答上抛 unreachable。 */
async function findLatest(beta: boolean): Promise<{ version: string; notes?: string; site: WebsiteInstallers | null } | null> {
  const site = parseWebsiteInstallers(await getJson(`${WEBSITE_API}/website/config`, 10_000))
  if (site) {
    let version = site[websitePlatformFor(process.platform)]?.version || ''
    if (!beta && isPrerelease(version)) version = ''
    let notes: string | undefined
    if (beta) {
      const pre = await githubRelease(true, true)
      if (pre && (!version || isNewer(pre.tag, version))) ({ tag: version, body: notes } = pre)
    }
    return version ? { version, notes, site } : null
  }
  const gh = await githubRelease(beta)
  if (gh === undefined) throw new Error('unreachable')
  return gh ? { version: gh.tag, notes: gh.body, site: null } : null
}

// ── 下载源:钉到这个版本 ───────────────────────────────────────────────────────
/** 这一边能不能给这个版本;能就返回 electron-updater 的 feed 配置。 */
function feedFor(src: UpdateSource): Parameters<typeof autoUpdater.setFeedURL>[0] | null {
  if (!target) return null
  if (src === 'github') return { provider: 'generic', url: `https://github.com/${GH_OWNER}/${GH_REPO}/releases/download/v${target.version}` }
  const it = target.site?.windows
  if (process.platform !== 'win32' || !websiteCarries('win32', BUNDLE_EXTEND) || !websiteHas(it, target.version) || !it.sha512) return null
  return { provider: 'custom', updateProvider: WebsiteUpdateProvider, installer: it, downloadUrl: `${WEBSITE_API}/website/download/windows` }
}

/** 下载顺序里、除当前这边以外第一个能用的。 */
function otherSource(): UpdateSource | null {
  return target?.order.find((s) => s !== feedSource && feedFor(s)) ?? null
}

/**
 * 把 electron-updater 钉到这一边,并确认它答出来的就是这个版本。
 * 'rejected' = 版本对得上,但 electron-updater 自己不认(minimumSystemVersion 高过这台电脑等),不会再发 update-available。
 */
async function useSource(src: UpdateSource): Promise<'ok' | 'rejected' | 'fail'> {
  const feed = feedFor(src)
  if (!feed || !target) return 'fail'
  // generic 按 channel 拼 yml 名(Linux 自动加 -linux):标准包 latest*.yml,NoExtend latest-no-extend*.yml;
  // 测试版 tag 上也是 latest*.yml(见 electron-builder.config.cjs 的说明)。
  autoUpdater.channel = BUNDLE_EXTEND ? 'latest' : 'latest-no-extend'
  autoUpdater.disableDifferentialDownload = src === 'website' // 官网没有 blockmap
  autoUpdater.setFeedURL(feed)
  feedSource = src
  busy = true
  try {
    const r = await checkRevisionUpdate(autoUpdater, app.getVersion(), target.version)
    if (r?.updateInfo?.version !== target.version) return 'fail'
    return r.isUpdateAvailable === false ? 'rejected' : 'ok'
  } catch { return 'fail' } finally { busy = false }
}

function ensureWired(): void {
  if (wired) return
  wired = true
  autoUpdater.autoDownload = false // 手动下载
  autoUpdater.autoInstallOnAppQuit = false // 全程手动:下完不主动在退出时装
  // 有没有新版由 findLatest 定,electron-updater 的 checking / not-available 只是钉源时的回声,不广播。
  autoUpdater.on('update-available', (info) => {
    if (dl || !target || info.version !== target.version) return // 下载中换源时的回声
    announceAvailable(info.version, notesToString(info.releaseNotes),
      { source: feedSource ?? undefined, size: info.files?.[0]?.size })
  })
  // 下载中/下载完仍要带着版本号与更新说明:UI 的「更新内容」区在 available/downloaded 两态都渲染,
  // 只发 phase 会让用户一点「下载」说明就整段消失(Codex 评审实证)。
  autoUpdater.on('download-progress', (p) => {
    if (dl) dl.lastAt = Date.now()
    broadcast({ ...lastStatus, phase: 'downloading', percent: Math.round(p.percent), transferred: p.transferred, total: p.total })
  })
  autoUpdater.on('update-downloaded', (info) =>
    broadcast({ ...lastStatus, phase: 'downloaded', version: info.version, source: feedSource ?? undefined, fallbackFrom: undefined, canSwitch: false }))
  autoUpdater.on('error', (err) => {
    if (busy || dl) return // 调用处自己处理(换源或报错)
    broadcast({ phase: 'error', error: err?.message || String(err) })
  })
}

export function getUpdaterStatus(): UpdaterStatus {
  return lastStatus
}

/**
 * 启动、6 小时定时、唤醒、手动四条入口会撞在一起:共用在途的那一次。不然后结束的那次会在用户已经点了下载之后
 * 重新钉 feed,或把 downloaded 盖回 available(Codex 评审 P2)。
 */
let inflight: Promise<UpdaterStatus> | null = null
export function checkForUpdates(): Promise<UpdaterStatus> {
  if (!inflight) inflight = runCheck().finally(() => { inflight = null })
  return inflight
}

async function runCheck(): Promise<UpdaterStatus> {
  // A verified installer is waiting for the user's restart, or one is downloading; a timer/manual recheck must not reset it.
  if (lastStatus.phase === 'downloaded' || dl) return lastStatus
  if (unsupported()) {
    const s: UpdaterStatus = { phase: 'unsupported' }
    broadcast(s)
    return s
  }
  broadcast({ phase: 'checking' })
  try {
    const { beta, source } = await readUpdaterConfig()
    const latest = await findLatest(beta)
    if (!latest || !isNewer(latest.version, app.getVersion())) {
      target = null
      broadcast({ phase: 'not-available' })
      return lastStatus
    }
    target = { version: latest.version, site: latest.site, order: sourceOrder(source, source === 'auto' ? await detectMainland() : null) }
    if (process.platform === 'darwin') {
      const src = target.order.find((s) => s === 'github' || (websiteCarries('darwin', BUNDLE_EXTEND) && websiteHas(target!.site?.macos, latest.version))) ?? 'github'
      announceAvailable(latest.version, latest.notes, { source: src, size: src === 'website' ? latest.site?.macos?.size : undefined })
      return lastStatus
    }
    ensureWired()
    autoUpdater.allowPrerelease = beta
    feedSource = null
    for (const src of target.order) {
      const res = await useSource(src)
      if (res === 'ok') return lastStatus // update-available 已广播
      if (res === 'rejected') { target = null; broadcast({ phase: 'not-available' }); return lastStatus }
    }
    broadcast({ phase: 'error', error: 'unreachable' })
  } catch (err: any) {
    broadcast({ phase: 'error', error: err?.message || String(err) })
  }
  return lastStatus
}

/**
 * 下载:当前这边出错或 30 秒没进度 → 自动换另一边从头下一次(两边是同一个文件,electron-updater 不跨源续传);
 * 换过去还不行就报错,不来回切。手动换源(switchUpdateSource)随时可以,不占这一次。
 */
export async function downloadUpdate(): Promise<void> {
  if (unsupported() || process.platform === 'darwin' || !target || dl || lastStatus.phase !== 'available') return
  ensureWired()
  // 先把阶段钉成 downloading:第一条进度事件要等一会儿,这段空档里定时 / 唤醒检查会当成「还没下载」
  // 照常去查,查回来晚于下载完成就把 downloaded 盖回 available(Codex 评审 P2)。
  broadcast({ ...lastStatus, phase: 'downloading', percent: 0, transferred: 0, total: lastStatus.size, canSwitch: !!otherSource() })
  let autoSwitched = false
  for (;;) {
    const cur: Download = { token: new CancellationToken(), lastAt: Date.now(), manual: null }
    dl = cur
    const watchdog = setInterval(() => { if (Date.now() - cur.lastAt > STALL_MS) cur.token.cancel() }, 5000)
    try {
      await autoUpdater.downloadUpdate(cur.token)
      return // update-downloaded 事件负责广播
    } catch (err: any) {
      const from = feedSource
      const manual = cur.manual
      const next = manual ?? (autoSwitched ? null : otherSource())
      if (!next || (await useSource(next)) !== 'ok') {
        broadcast({ ...lastStatus, phase: 'error', error: err?.message || String(err) })
        return
      }
      if (!manual) autoSwitched = true
      broadcast({
        ...lastStatus, phase: 'downloading', percent: 0, transferred: 0, total: undefined, source: next,
        fallbackFrom: manual ? undefined : (from ?? undefined), canSwitch: !!otherSource(),
      })
    } finally {
      clearInterval(watchdog)
      dl = null
    }
  }
}

/** 下载中手动换到另一边(底栏的「换 GitHub / 换官网」)。 */
export function switchUpdateSource(): boolean {
  const next = dl ? otherSource() : null
  if (!dl || !next) return false
  dl.manual = next
  dl.token.cancel()
  return true
}

/** mac:在浏览器里直接开这一版 .dmg 的下载链接(官网 = 官网下载接口;GitHub = 同一 tag 的资产)。 */
export async function openUpdateInstaller(): Promise<boolean> {
  if (process.platform !== 'darwin' || !target || lastStatus.phase !== 'available') return false
  const v = target.version
  const url = lastStatus.source === 'website'
    ? `${WEBSITE_API}/website/download/macos`
    : `https://github.com/${GH_OWNER}/${GH_REPO}/releases/download/v${v}/Forsion${BUNDLE_EXTEND ? '' : '-NoExtend'}-${v}-arm64.dmg`
  await shell.openExternal(url)
  broadcast({ ...lastStatus, opened: true })
  return true
}

/**
 * Windows 显示独立安装进度,避免旧程序退出后长时间无窗口;Linux 保持原来的静默更新。
 * 安装器凭 --updated 跳过选择页,完成后自动启动,见 build/installer.nsh。
 * 更新途中旧卸载器的「是否保留数据」也一并闭嘴,见 build/installer.nsh 的 ${isUpdated} 闸。
 * 调用方(main 的 updater:install 处理器)须先优雅停后端,避免 before-quit 的 app.exit(0)
 * 截断 electron-updater 的退出安装路径。
 */
/** installUpdate() 会不会真的退出去装(mac / 未打包是 no-op)。调用方据此决定要不要先封住后端拉起。 */
export function canInstallUpdate(): boolean {
  return !unsupported() && process.platform !== 'darwin'
}

export function installUpdate(): void {
  if (!canInstallUpdate()) return
  autoUpdater.quitAndInstall(process.platform !== 'win32', true)
}
