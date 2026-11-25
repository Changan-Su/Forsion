/**
 * 应用内自动更新封装(electron-updater)——检查 / 下载 / 安装(quitAndInstall)三步全手动流程。
 *
 * **有没有新版看官网,从哪儿下按地区**(2026-10-19 用户定,口径在 shared/updateSource.ts):
 *  - 检查:先拉官网 `/api/website/config` 里本平台安装包的版本;官网答了就以它为准(GitHub 上更新的也不提示),
 *    官网没答上才退回 GitHub API。测试版额外看 GitHub 预发布(官网不放测试版)。
 *  - Windows(NSIS)/ Linux(AppImage):定下版本后,把 electron-updater 的下载源钉到这个版本 ——
 *    GitHub = 该 tag 的 latest*.yml(generic);官网 = WebsiteUpdateProvider(Windows 标准包、官网记录带 sha512 才有)。
 *    一边下不动(出错 / 30 秒没进度)自动换另一边一次;下载中也能手动换。electron-updater 现在只管下载和安装,不再决定有没有新版。
 *  - macOS:当前运行的包是 Developer ID 签名、且 .app 所在目录可写(macSelfUpdate.ts 探一次)→ 和 Windows / Linux 一样
 *    electron-updater 下 zip:GitHub = 该 tag 的 latest-mac.yml;官网 = `macos-update` 那条记录(和 dmg 同一版、带 sha512 才用,
 *    没有就说明官网这一版还没收 zip,该先走官网的大陆用户照旧从官网开 .dmg)→「重启并安装」时先让 Squirrel.Mac 取包验签
 *    (prepareInstall),成了才停后端、quitAndInstall。ad-hoc 签名的旧包 / 从 .dmg 里直接跑 / 任何一步失败 →
 *    退回老路:「下载安装包」在浏览器里直接开这一版 .dmg 的链接,装由用户自己拖。
 *
 * 所有状态广播 'updater:status' 给渲染层;dev 未打包态统一 no-op 返回 phase:'unsupported'。
 */
import { app, BrowserWindow, shell, autoUpdater as nativeUpdater } from 'electron'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import electronUpdater from 'electron-updater'
import { CancellationToken } from 'builder-util-runtime'
import { forsionHomeDir } from './forsionHome'
import { changelogSection, isNewer, isPrerelease, notesToString } from './updaterUtil'
import { BUNDLE_EXTEND } from './distribution'
import { WebsiteUpdateProvider } from './websiteUpdateProvider'
import { probeMacSelfInstall } from './macSelfUpdate'
import { checkRevisionUpdate } from './revisionUpdateCheck'
import { dropStaleBlockmapFor } from './differentialCache'
import {
  WEBSITE_API, parseMainland, parseSourcePref, parseWebsiteInstallers, sourceOrder,
  websiteCarries, websiteDownload, websiteHas, websitePlatformFor, selectGitHubRelease,
  type UpdateSource, type UpdateSourcePref, type WebsiteInstallers,
} from '../shared/updateSource'

// electron-updater 是 CJS 默认导出对象;ESM 下解构取 autoUpdater 最稳。
const { autoUpdater } = electronUpdater

const GH_OWNER = 'Changan-Su'
const GH_REPO = 'Forsion' // 2026-07-05 GitHub 仓已改名(旧名 Tangu 经重定向仍可达,老客户端不断链)
const GH_API = `https://api.github.com/repos/${GH_OWNER}/${GH_REPO}`
/** 这么久没有新的下载进度就算「下不动」,换另一边。 */
const STALL_MS = 30_000
/**
 * 官网源的差量下载开头要先取新旧两份 blockmap(各约 0.5 MB),这段 electron-updater 不报进度:第一条进度之前多给些时间,
 * 不然慢网上会在取 blockmap 时被当成下不动取消掉 —— 取消令牌一并带走了它自己的整包回落(Codex 评审)。
 */
const FIRST_PROGRESS_DIFF_MS = 90_000

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
  /** mac:这次只能在浏览器里下 .dmg 手动装(ad-hoc 旧包 / 自装失败);false = 和 Windows 一样应用内下载安装。老主进程不带这格 */
  manualInstall?: boolean
  /** mac:应用内自装没成,已退回下载安装包 */
  selfInstallFailed?: boolean
  /** mac:点了「重启并安装」,Squirrel.Mac 正在取包验签 */
  preparing?: boolean
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
type Download = { token: CancellationToken; lastAt: number; manual: UpdateSource | null; dropped?: boolean; progressed?: boolean }
let dl: Download | null = null
/** mac:当前运行的包能不能自装(探一次记住);自装失败过一次,本次运行不再试;Squirrel 已经取好包 */
let macSelf: Promise<boolean> | null = null
let macSelfOk = false
let macSelfBroken = false
let squirrelReady = false
/** prepareInstall 进行中:Squirrel 的报错由它处理,别广播 */
let staging = false

/** 阶段变了才回调(匿名遥测的 update 事件:见 telemetryHost.appUpdateProps);下载进度那种同阶段的刷新不回调。返回退订。 */
const phaseListeners = new Set<(status: UpdaterStatus) => void>()
export function onUpdaterPhase(cb: (status: UpdaterStatus) => void): () => void {
  phaseListeners.add(cb)
  return () => { phaseListeners.delete(cb) }
}

/** 下载失败的常见本机原因换成稳定代码,界面按代码出文案(D27);其余照原文。 */
export function downloadErrorCode(err: any): string {
  const code = String(err?.code ?? '')
  if (code === 'ENOSPC') return 'disk-full'
  if (code === 'EACCES' || code === 'EPERM') return 'no-permission'
  if (code === 'EBUSY' || code === 'ETXTBSY') return 'file-busy'
  return err?.message || String(err)
}

function broadcast(status: UpdaterStatus): void {
  const phaseChanged = status.phase !== lastStatus.phase
  lastStatus = status
  if (phaseChanged) for (const cb of phaseListeners) { try { cb(status) } catch { /* 遥测不影响更新 */ } }
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
  // Windows 用官网的 exe;mac 用官网的 `macos-update`(自动更新专用的 zip,Squirrel.Mac 只吃 zip,`macos` 那份 dmg 换不了包)。
  // 官网要正好有这一版、带 sha512、是标准包才用;对不上(还没收 zip / 后台把 dmg 回退了)就当官网给不了。
  const mac = process.platform === 'darwin'
  if (!mac && process.platform !== 'win32') return null
  const key = mac ? 'macos-update' : 'windows'
  const it = target.site?.[key]
  if (!websiteCarries(process.platform, BUNDLE_EXTEND) || !websiteHas(it, target.version) || !it.sha512) return null
  if (mac && !/\.zip$/i.test(it.filename)) return null
  // 记录带 blockmap(新 server 从 GitHub 导入的)走带版本号的地址、开差量;否则照旧整包(见 websiteDownload)
  const { url, differential } = websiteDownload(WEBSITE_API, key, it)
  return { provider: 'custom', updateProvider: WebsiteUpdateProvider, installer: it, downloadUrl: url, differential }
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
  // 官网只有带 blockmap 的记录能差量(feedFor 标好了);差量失败 electron-updater 自己回落整包
  autoUpdater.disableDifferentialDownload = src === 'website' && !(feed as { differential?: boolean }).differential
  // 官网源开差量前,缓存里和旧文件对不上的 current.blockmap 删掉(原因见 differentialCache.ts)
  if (src === 'website' && !autoUpdater.disableDifferentialDownload) await dropStaleBlockmapFor(autoUpdater, process.platform)
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
      { source: feedSource ?? undefined, size: info.files?.[0]?.size, manualInstall: false })
  })
  // 下载中/下载完仍要带着版本号与更新说明:UI 的「更新内容」区在 available/downloaded 两态都渲染,
  // 只发 phase 会让用户一点「下载」说明就整段消失(Codex 评审实证)。
  autoUpdater.on('download-progress', (p) => {
    if (dl?.dropped) return // 关了测试版、作废中的那份:迟到的进度别把状态翻回 downloading
    if (dl) { dl.lastAt = Date.now(); dl.progressed = true }
    broadcast({ ...lastStatus, phase: 'downloading', percent: Math.round(p.percent), transferred: p.transferred, total: p.total })
  })
  autoUpdater.on('update-downloaded', (info) => {
    // 取消赶不上收尾(校验 / 改名)时 electron-updater 仍会报完成:作废了的(target 已清 / 版本对不上)不认
    if (dl?.dropped || !target || info.version !== target.version) return
    broadcast({ ...lastStatus, phase: 'downloaded', version: info.version, source: feedSource ?? undefined, fallbackFrom: undefined, canSwitch: false })
  })
  autoUpdater.on('error', (err) => {
    if (busy || dl || staging) return // 调用处自己处理(换源 / 报错 / mac 退回 .dmg)
    broadcast({ phase: 'error', error: err?.message || String(err) })
  })
}

/** mac:这次运行能不能走应用内自装。非 mac 恒 true;判不出来当不能。 */
async function selfInstallable(): Promise<boolean> {
  if (process.platform !== 'darwin') return true
  if (macSelfBroken) return false
  if (!macSelf) {
    macSelf = probeMacSelfInstall(app.getPath('exe')).then((r) => {
      console.log(`[updater] mac self-install: ${r.reason}`)
      macSelfOk = r.ok
      return r.ok
    })
  }
  return macSelf
}

/** mac 手动装时 .dmg 从哪边下:按下载顺序,官网要正好有这一版标准包才算。 */
function manualMacSource(version: string): { source: UpdateSource; size?: number } {
  const site = target?.site?.macos
  const source = target?.order.find((s) => s === 'github' || (websiteCarries('darwin', BUNDLE_EXTEND) && websiteHas(site, version))) ?? 'github'
  return { source, size: source === 'website' ? site?.size : undefined }
}

/** mac 应用内自装这条路走不通(下不动 / Squirrel 验签失败):退回浏览器开 .dmg,本次运行不再试。 */
function degradeToManual(): void {
  macSelfBroken = true
  squirrelReady = false
  if (!target) return
  const { version } = target
  const notes = lastStatus.version === version ? { releaseNotes: lastStatus.releaseNotes, releaseNotesEn: lastStatus.releaseNotesEn } : {}
  broadcast({ phase: 'available', version, ...notes, ...manualMacSource(version), manualInstall: true, selfInstallFailed: true })
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
    // mac 只能手动装(ad-hoc 旧包等);或者这次该先走官网(大陆 / 选了官网 / 地区没探出来)而官网给不了 zip ——
    // 官网只收 .dmg,那就照旧从官网开 .dmg,不为了自装绕去 GitHub(下载源按地区是 10-19 定的口径)。
    if (!(await selfInstallable()) || (process.platform === 'darwin' && target.order[0] === 'website' && !feedFor('website'))) {
      announceAvailable(latest.version, latest.notes, { ...manualMacSource(latest.version), manualInstall: true })
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
    // mac:GitHub 上这一版没有 latest-mac.yml(zip 之前发的版本)或连不上 → 还能在浏览器里下 .dmg(官网那份也算)
    if (process.platform === 'darwin') {
      announceAvailable(latest.version, latest.notes, { ...manualMacSource(latest.version), manualInstall: true })
      return lastStatus
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
  if (unsupported() || lastStatus.manualInstall || !target || dl || lastStatus.phase !== 'available') return
  ensureWired()
  // 先把阶段钉成 downloading:第一条进度事件要等一会儿,这段空档里定时 / 唤醒检查会当成「还没下载」
  // 照常去查,查回来晚于下载完成就把 downloaded 盖回 available(Codex 评审 P2)。
  broadcast({ ...lastStatus, phase: 'downloading', percent: 0, transferred: 0, total: lastStatus.size, canSwitch: !!otherSource() })
  let autoSwitched = false
  for (;;) {
    const cur: Download = { token: new CancellationToken(), lastAt: Date.now(), manual: null }
    dl = cur
    const watchdog = setInterval(() => {
      // 只给官网源的差量放宽:GitHub 源的看门狗保持原样
      const limit = !cur.progressed && feedSource === 'website' && !autoUpdater.disableDifferentialDownload ? FIRST_PROGRESS_DIFF_MS : STALL_MS
      if (Date.now() - cur.lastAt > limit) cur.token.cancel()
    }, 5000)
    try {
      await autoUpdater.downloadUpdate(cur.token)
      return // update-downloaded 事件负责广播
    } catch (err: any) {
      if (cur.dropped) return // 关了测试版,这份测试包不要了(channelChanged 已重置状态)
      const from = feedSource
      const manual = cur.manual
      const next = manual ?? (autoSwitched ? null : otherSource())
      const switched = !!next && (await useSource(next)) === 'ok'
      if (cur.dropped) return // 换源那一下 await 期间关了测试版
      if (!switched) {
        const code = downloadErrorCode(err)
        // mac 下不动还有 .dmg 这条路(大陆可走官网);磁盘满换哪条路都一样,照常报
        if (process.platform === 'darwin' && code !== 'disk-full') degradeToManual()
        else broadcast({ ...lastStatus, phase: 'error', error: code })
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

/**
 * 关掉测试版时,还在下 / 已下好 / 正提示的测试包作废,回到空闲,调用方随后重查一次正式版(D27)。
 * 不然 runCheck 见到 downloaded 会原样返回,用户关了测试版还被提示「重启安装」那个测试包。
 * 打开测试版不动:手上那份正式版照样能装。
 */
export function channelChanged(beta: boolean): void {
  // mac 已经点了安装、Squirrel 在取 / 已取好:它一取好就会在退出时装上,这时作废只会让界面和实际装的对不上(Codex 评审)
  if (beta || !target || !isPrerelease(target.version) || staging || squirrelReady) return
  if (dl) { dl.dropped = true; dl.token.cancel() }
  target = null
  broadcast({ phase: 'idle' })
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
  if (process.platform !== 'darwin' || !target || lastStatus.phase !== 'available' || !lastStatus.manualInstall) return false
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
/** installUpdate() 会不会真的退出去装(未打包 / 只能手动装的 mac 是 no-op)。调用方据此决定要不要先封住后端拉起。 */
export function canInstallUpdate(): boolean {
  return !unsupported() && (process.platform !== 'darwin' || (macSelfOk && !macSelfBroken))
}

/**
 * 装之前的准备,调用方在**停后端之前** await 它,false 就别往下走(状态已退回「下载安装包」)。
 *
 * 只有 mac 有事做:electron-updater 下完 zip 只是在本机起了个代理、把 Squirrel.Mac 的 feed 指过去;
 * 不让它提前取(autoInstallOnAppQuit=false),quitAndInstall 才去取包、解包、核签名 —— 那时后端早停了,
 * 验签一失败应用就卡在半退出。所以这里先让 Squirrel 取完验完(原生 update-downloaded),quitAndInstall 就是当场退出去装。
 * ⚠️ 取好之后 Squirrel 会在下次退出时自己装上(它的固有行为),所以只在用户点了「重启并安装」、确认过之后才取。
 */
export async function prepareInstall(): Promise<boolean> {
  if (process.platform !== 'darwin') return true
  if (!canInstallUpdate() || lastStatus.phase !== 'downloaded') return false
  if (squirrelReady) return true
  staging = true
  broadcast({ ...lastStatus, preparing: true })
  try {
    // 检查时探的结果可能过时了(装好后被改成只读 / 挪进没权限的地方):Squirrel 遇到不可写会改走提权 ShipIt,我们只走普通用户这条
    const now = await probeMacSelfInstall(app.getPath('exe'))
    if (!now.ok) throw new Error(`mac self-install no longer possible: ${now.reason}`)
    // 不设超时:Squirrel 取包验签解包这一步没法取消,超时后它照样可能取好(下次退出就装)或报错,界面会对不上。
    // 等它给出结果,期间应用照常可用(后端没停),按钮显示「准备安装…」(Codex 评审)。
    await new Promise<void>((ok, fail) => {
      const done = (err?: unknown): void => {
        nativeUpdater.removeListener('update-downloaded', onReady)
        nativeUpdater.removeListener('update-not-available', onNone)
        nativeUpdater.removeListener('error', onError)
        if (err) fail(err)
        else ok()
      }
      const onReady = (): void => done()
      const onNone = (): void => done(new Error('Squirrel.Mac found no update'))
      const onError = (err: Error): void => done(err)
      nativeUpdater.on('update-downloaded', onReady)
      nativeUpdater.on('update-not-available', onNone)
      nativeUpdater.on('error', onError)
      try { nativeUpdater.checkForUpdates() } catch (err) { done(err) }
    })
    squirrelReady = true
    broadcast({ ...lastStatus, preparing: false })
    return true
  } catch (err) {
    console.warn('[updater] Squirrel.Mac could not stage the update, falling back to the installer download:', err)
    degradeToManual()
    return false
  } finally {
    staging = false
  }
}

export function installUpdate(): void {
  if (!canInstallUpdate()) return
  if (process.platform === 'darwin') {
    // 走到这儿后端已停、窗口马上全关:Squirrel 交接(写 ShipItState、拉 ShipIt)再出错,应用就成了无窗口、无后端的空壳。
    // 那就直接重开(旧版本照常起来,下次检查退回 .dmg 也行),不留半退出状态(Codex 评审 P1)。
    const onError = (err: Error): void => {
      nativeUpdater.removeListener('error', onError)
      console.warn('[updater] Squirrel.Mac failed during quitAndInstall, relaunching the current version:', err)
      app.relaunch()
      app.exit(0)
    }
    nativeUpdater.on('error', onError)
  }
  autoUpdater.quitAndInstall(process.platform !== 'win32', true)
}
