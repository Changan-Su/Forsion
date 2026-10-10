import { installAmbientPalette } from './ambientPalette'
import { unitConfigFace } from './unitConfigFace'
import { registerStartupAppearance } from './startupAppearance'
import { MCP_NAME_RESERVED, newReservedMcpNames } from '../shared/mcpNames'
import { buildUnitScopeGuard, openUnitHostRegularFile, withVerifiedUnitPath } from './unitHostScope'
import { composeUnitRoots, createFileProjectRegistry, createUnitSessionRoots, registerPickedDirectory, seedGatedEngine, type LocalProjectRegistry, type UnitSessionRootsSource } from './unitLocalRoots'
import { normalizeHostSandboxConfig, type HostSandboxConfig } from '../shared/hostSandboxConfig'
import { startMiniPassThrough, readComputerUseForeground, topRightPosition } from './miniForeground'
import { startMiniAutoPanel } from './miniAutoPanel'
import { normalizeMiniOpenOptions, normalizeMiniSessionContext, type MiniSessionContext, type MiniOpenOptions, type MainPanelTarget } from '../shared/miniPanel'
import { normalizeFloatingPanelOpenOptions, normalizeMainAction, type FloatingPanelOpenOptions } from '../shared/floatingPanel'
import { normalizeUiSync, UI_LOCALE_CHANNEL } from '../shared/uiSync'
/**
 * Tangu 桌面 GUI — Electron 主进程。
 * 负责:建窗 + 配置持久化(IPC)+ 托管内置 tangu-server(managed 模式,backendManager)。
 * agent 调用由 renderer 直连 HTTP/SSE(localhost),不经主进程代理。
 */
import { app, BrowserWindow, desktopCapturer, dialog, ipcMain, Menu, net, powerMonitor, powerSaveBlocker, screen, globalShortcut, session, shell, nativeImage, Notification, systemPreferences, webContents } from 'electron'
import { basename, dirname, isAbsolute, join, relative } from 'path'
import { pathToFileURL } from 'url'
import { readFile, writeFile, mkdir, readdir, stat, lstat, rename, cp, rm } from 'fs/promises'
import { writeHostTextFile } from './hostTextWrite'
import { createSerialQueue, lockedUpdateJson, writePrivateJson } from './configWrite'
import { existsSync, mkdirSync, realpathSync, writeFileSync, renameSync, rmSync, watch as fsWatch } from 'fs'
import { ensureCliInstalled } from './cliInstall'
import { PRODUCT } from './product'
import { readSpaceIconDataUrl } from './spaceIcon'
import { bindDevTanguHome, forsionHomeDir, tanguDataDir, migrateForsionHome, migrateEngineData, migratePair, setDevMode, defaultWorkspaceDir as forsionWorkspaceDir } from './forsionHome'
import { privateHostReason } from './netGuard'
import { execFile, execFileSync, spawn } from 'child_process'
import { homedir, hostname, networkInterfaces } from 'os'
import { randomUUID } from 'crypto'
import { BackendManager, bundledPythonBin, resolveBundledGit, resolveBundledNode, type BackendStatus } from './backendManager'
import { envWithFullPath, pathKeyOf, withBundledGit } from './envPath'
import { findGit } from './gitHistory'
import { downloadUrlFor, installCommandFor, requiredProgram } from './envInstall'
import { createKeepAwake } from './keepAwake'
import { createMcpLifecycle, startForsionMcp } from './mcpServer'
import { randomBytes } from 'node:crypto'
import { loadTanguCreds, saveTanguCreds, forsionAccountId, loadAccountCloudSettings, saveAccountCloudSettings } from './forsionAuth'
import { createAccountCore } from './accountCore'
import { importMcp, importSkills, scanAll } from './discovery'
import { checkForUpdates, downloadUpdate, installUpdate, canInstallUpdate, betaChannelOn, getUpdaterStatus } from './updater'
import { createRestartGuard, readRestartActivity } from './restartGuard'
import { createTray, refreshTrayMenu, setTrayIndicator, trayLang } from './tray'
import { initMainLocale, mt } from './mainI18n'
import { createUiLocaleSync, UI_LOCALE_FILE } from './uiLocaleSync' // P1-KF:主进程文案跟渲染层的生效语言
import { createApprovalDelivery, engineFromBackend } from './approvalDelivery' // P1-K3
import { APPROVAL_OPEN_CHANNEL } from '../shared/approvalOpen' // P1-K3
import './mainMessages' // P1-K5:登记 main.* 原生界面文案(配对框 / 崩溃框 / 下载通知 / 选择框标题)
import * as deviceSecrets from './deviceSecrets' // P1-K5:设备凭据(配对 / external token)进 safeStorage
import './editContextMenu' // 编辑区系统右键菜单(评审 G4-08):导入即给每个应用窗口挂 context-menu,逻辑全在模块里
import { readThemesDir, seedDefaultThemes } from './themes'
import { builtinBundleSources, builtinPluginIds, bundleOff, bundleRestartPending, initBundleSwitches, lockedPluginIds, seedBuiltinBundles, setBundleOff } from './builtinPlugins'
import { createCorePluginUpdater } from './corePluginUpdates'
import { createMarketPluginUpdater, type MarketUpdateItem } from './marketPluginUpdates'
import { BUILTIN_BUNDLES } from './builtinPlugins'
import { checkBuiltinUpdates, NPM_OFFICIAL, registryOrder } from './builtinUpdates'
import { loadBuiltinDesktopEntries, type CloudHost } from './cloudHost'
import { npmDownloadCandidates, npmTarballToZip, type NpmInstallSnapshot } from './npmMarketInstall'
import { extractZipToDir, detectMarketType, MARKET_SUBDIR, MARKET_MANIFEST, isSafeSlug, readInstalledVersion, readInstalledPluginId, readUserPluginDirs, marketItemDir, downloadCandidates, downloadZip, GZIP_MAGIC, ZIP_MAGIC, type DownloadProgress } from './marketInstall'
import { servePathRoot, serveInlineHtml, stopCodePreview, setForsionPreviewHooks, transpileForServe, MIME } from './codePreview'
import { createCodeStudioProjectWatcher, createCodeStudioSnapshot, listCodeStudioSnapshots, restoreCodeStudioSnapshot } from './codeStudioProjects'
import { installPreviewPersistence, previewOriginFor, registerProductsIpc } from './productsIpc'
import { transcribeViaOpenAI, transcribeViaForsion } from './asr'
import { localModelReady, localModelSize, downloadLocalModel, removeLocalModel, transcribeLocal } from './asrLocal'
import { computerUseLiveView, helperSocketPath, askHelper, ensureHelperRunning, HelperLink } from './computerUse'
import { chooseSide, makeRoom, panelRectFor, startDockFollow, DOCK_PANEL_WIDTH, DOCK_PANEL_MIN_WIDTH, DOCK_PANEL_MIN_HEIGHT, normalizeProbe } from './appDock'
import { normalizeDockCandidates, normalizeDockSelection, normalizeDockWindow, type DockState, type DockWindow } from '../shared/appDock'
import { permissionHelperAppPath, registerDesktopPermissions } from './desktopPermissions'
import { ComputerHistory, readSelfBundleId, registerComputerHistoryIpc, stopComputerHistoryForWipe, type ComputerHistoryConfig } from './computerHistory'
import { createWindowsRecorderResolver, recorderBinDir, windowsRecorderSource } from './computerHistoryWin'
import { COMPUTER_HISTORY_DESKTOP_CONFIG_FILE } from '../shared/computerHistory'
// Amadeus Space:vendored 笔记后端(vault IPC + 资产协议)。renderImport 别名后保持 verbatim。
import { registerIpc as registerAmadeusIpc } from './amadeus/ipc'
import type { AmadeusSyncFactory } from './amadeus/cloudSeam'
import { engineCapsState, pairingWriters, type UnitHubFactory, type UnitHubInstance } from './unitHubSeam' // 设备互联云端通道的接缝(Forsion Extend 0.6 起)
import { makeCallerHeaders } from './unitCaller'
import { startUnitWeb, type UnitWebHandle, type PairedDevice } from './unitWeb'
import { createRemoteSessions, lookupRosterUnit, registerRemoteSessionsIpc, REMOTE_SESSIONS_FILE, withRemoteCap } from './remoteSessions' // P1-K4
import { normalizeCap } from '../shared/remoteSessions' // P1-K4
import { createRemoteSafety } from './remoteSafety' // P1-K2
import { registerRemoteSafetyIpc } from './remoteSafetyIpc' // P1-K2
import { registerDocumentTaskIpc } from './documentTaskIpc'
import { createSystemAuth } from './remoteSafetyAuth' // P1-K2
import { REMOTE_LOCK_FILE } from '../shared/remoteSafety' // P1-K2
import { attachHostChannel, startP2pProxy, type P2pProxyHandle } from './unitP2p'
import { P2pManager, DEFAULT_STUN } from './p2pWindow'
import type { ExternalPluginSource } from '@amadeus-shared/ipc'
import { readConfig as readAmadeusConfig } from './amadeus/settings'
import { registerRemoteSync } from './remotesyncIpc'
import { registerRemoteSyncBackend } from './remotesync/backends'
import { logActivity, setActivityLogEnabled, pruneActivity, exportActivity, flushAllNoteEdits } from './activityLog'
import { createSampler, nativeProbe } from './activeWindow'
import { KNOWN_APPS } from '../shared/knownApps'
import { effectivePluginId } from '../shared/products'
import { BROWSER_PARTITION, GUEST_ALLOWED_PERMISSIONS } from '../shared/browser'
import { registerPtyIpc } from './pty'
import { registerAssetSchemes as registerAmadeusAssetSchemes, registerAssetProtocol as registerAmadeusAssetProtocol } from './amadeus/assetProtocol'
import { nearestEdge, collapsedBounds, expandedBounds, visibleRect, pointInRect, growRect, type Rect, type Edge } from './windowGeometry'
import { applyWindowMaterial, parseWindowMaterialRequest } from './windowMaterial'
import { isForsionUrl, pushDeepLink, drainDeepLinks } from './deepLink'

/** ~/.tangu(与包内 core/tanguHome.ts 同约定;TANGU_HOME 可整体重定向)。 */
setDevMode(!app.isPackaged) // dev 数据目录 ~/.forsion-dev,与正式版隔离(模块装载即定,先于一切路径解析)
// dev 与安装版的 Electron userData 默认共用同一目录 appData/forsion-desktop(app.getName() 取 package.json
// name="forsion-desktop";electron-builder 的 productName 只改 .app 包名/CFBundleName「Forsion」,不动 userData)。
// → 二者抢同一把 userData/SingletonLock,后启者 requestSingleInstanceLock() 返 false 被下方 app.exit(0)(即
// 「安装版在跑时 npm run dev 静默退出」)。dev 重定向 userData 到独立目录,彻底隔离(锁 + 壳层配置 + 窗口状态)→ 可同开。
if (!app.isPackaged) app.setPath('userData', app.getPath('userData') + '-dev')
// productName 改名(Tangu Agent 2.0 → Forsion)→ userData 目录随名走:一次性迁移壳层配置(打包态才有产品名目录)。
if (app.isPackaged) migratePair(join(app.getPath('appData'), 'Tangu Agent 2.0'), join(app.getPath('appData'), 'Forsion'))
const tanguHomeDir = forsionHomeDir // 品牌迁移后真身在 ~/.forsion(名字保留,少动 20+ 调用点)
/** ~/.tangu/themes:拖入式主题目录(每主题一子目录:theme.json + theme.css)。 */
const themesDir = (): string => join(tanguHomeDir(), 'themes')

// 单实例锁:托盘常驻语义下,再次启动只唤起已开的窗口后立即退出(app.exit 同步,不再往下建二号窗)。
if (!app.requestSingleInstanceLock()) app.exit(0)
app.on('second-instance', (_e, argv) => {
  showMainWindow()
  for (const a of argv) if (isForsionUrl(a)) deliverDeepLink(a) // win/linux:二启的 forsion:// 在 argv 里
})

// ── forsion:// deep link(入站;与出站外链回投的 app:open-url 无关)────────────────────────
// 正典:docs/ToBeImproved/View基座统一化方案_2026-08-25.md §4。只导航不执行;白名单在渲染层 resolver。
// 系统 handler 仅打包版注册:dev 注册会把裸 electron 二进制写进 LaunchServices/注册表,污染整机。
if (app.isPackaged) app.setAsDefaultProtocolClient('forsion')
/** 渲染层已 drain 过 → 之后直推;窗口 reload/重建把它翻回 false(Cmd+R 会换掉监听者,推进虚空)。 */
let deepLinkReady = false
function deliverDeepLink(url: string): void {
  pushDeepLink(url)
  if (!app.isReady()) return // 冷启动:窗口未建;whenReady 建窗后渲染层自会来 drain
  showMainWindow()
  if (deepLinkReady && mainWindow && !mainWindow.isDestroyed()) {
    for (const u of drainDeepLinks()) mainWindow.webContents.send('app:deep-link', u)
  }
}
// mac:open-url 必须在 whenReady 之前挂上,冷启动经 Dock/浏览器唤起的 URL 才接得到。
app.on('open-url', (e, url) => { e.preventDefault(); if (isForsionUrl(url)) deliverDeepLink(url) })
// win/linux 首启:URL 直接躺在 process.argv(mac 走 open-url,不经 argv)。
for (const a of process.argv.slice(1)) if (isForsionUrl(a)) pushDeepLink(a)

/**
 * 加载 ~/.tangu/.env 进 process.env(不覆盖真实环境;与包内 tanguHome.loadTanguEnv 同语义)。
 * 打包 Electron 不继承 shell 环境,.env 文件是 TANGU_CLOUD_URL 等预配置的标准载体(模板:包根 example.env)。
 */
async function loadTanguEnvFile(): Promise<void> {
  let raw: string
  try {
    raw = await readFile(join(tanguDataDir(), '.env'), 'utf8') // .env 属引擎域(loadTanguEnv 同位)
  } catch {
    return
  }
  for (const line of raw.split('\n')) {
    const t = line.trim()
    if (!t || t.startsWith('#')) continue
    const i = t.indexOf('=')
    if (i <= 0) continue
    const k = t.slice(0, i).trim()
    let v = t.slice(i + 1).trim()
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1)
    if (k && process.env[k] === undefined) process.env[k] = v
  }
}

// ── ~/.tangu/config.json:与包内 core/config.ts 同格式的「唯一真源」。桌面读写各段(providers/mcp/
//    cloud/browser/wechat/sandbox/workspace)落此文件;后端(standalone)同读。段存在即权威,缺失回落 legacy。
const homeConfigPath = (): string => join(tanguHomeDir(), 'config.json')
async function readHomeConfig(): Promise<Record<string, any>> {
  try {
    const p = JSON.parse(await readFile(homeConfigPath(), 'utf8'))
    if (!p || typeof p !== 'object' || Array.isArray(p)) throw new Error('Invalid config.json: expected an object')
    return p
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {}
    throw error // Never overwrite an unreadable security configuration with defaults.
  }
}
/** config.json 的读改写:引擎 / CLI 同写这份,持跨进程写锁在写入那一刻的内容上改(configWrite.ts 的 lockedUpdateJson;
 *  mutate 必须同步,返回 undefined = 不写)。原子落位(唯一临时名 + rename,0600 含 token/apiKey):截断直写或共用 .tmp 名
 *  在中断/并发时会写出半截 JSON —— 之后 readHomeConfig 每次都抛,设置整片存不进去。 */
function updateHomeConfig(mutate: (c: Record<string, any>) => Record<string, any> | undefined): Promise<void> {
  return lockedUpdateJson(homeConfigPath(), mutate)
}
/** 两份配置文件(userData 的 shell json、config.json)的读改写在本进程内排同一条队:saveConfig / saveHomeSection 都是
 *  「读整份 → 改 → 写整份」,并发交错 = 后写者拿旧读数盖掉前者(跨进程那一半由 updateHomeConfig 的写锁管)。
 *  ⚠️ 队里的任务别再调 saveConfig / saveHomeSection:会排到自己后面,自等死锁。 */
const configQueue = createSerialQueue()
/** value 可以是 (当前段) => 新段:基于当前值算新值(列表增删、段内改一个键)必须用函数形态,锁内拿当前段算;
 *  在外面先读再整段写回,会盖掉引擎 / 并发 IPC 在这之间写进同一段的改动。 */
function saveHomeSection(name: string, value: unknown): Promise<void> {
  return configQueue(() => updateHomeConfig((c) => {
    c[name] = typeof value === 'function' ? value(c[name]) : value
    return c
  }))
}

/** 直连 provider 配置。读 config.json 的 providers 段优先,缺失回落 legacy ~/.tangu/providers.json。 */
interface DirectProviderConfig {
  providerId: string
  baseUrl: string
  apiKey?: string
  modelIds?: string[]
  imageModelIds?: string[]
  ttsModelIds?: string[]
  asrModelIds?: string[]
  /** 该 provider 里**没有**多模态的模型(黑名单;默认认为都能看图)。命中的模型遇图会转交辅助视觉模型。 */
  noVisionModelIds?: string[]
}

async function readProvidersFile(): Promise<DirectProviderConfig[]> {
  const sec = (await readHomeConfig()).providers
  if (sec !== undefined) return Array.isArray(sec) ? sec : []
  return readLegacyProviders()
}
/** providers 段缺失时回落的 legacy providers.json(引擎首启迁移进 config.json 后就改名 .bak 了)。 */
async function readLegacyProviders(): Promise<DirectProviderConfig[]> {
  try {
    const parsed = JSON.parse(await readFile(join(tanguDataDir(), 'providers.json'), 'utf8')) // legacy 文件在引擎域
    return Array.isArray(parsed) ? parsed : Array.isArray(parsed?.providers) ? parsed.providers : []
  } catch {
    return []
  }
}

/** 读改写 providers 段:锁内拿写入那一刻的列表算新列表,返回写入后的列表。legacy 回落文件只读、没有并发写者,锁外先读好。 */
async function updateProvidersFile(fn: (list: DirectProviderConfig[]) => DirectProviderConfig[]): Promise<DirectProviderConfig[]> {
  const legacy = await readLegacyProviders()
  let next: DirectProviderConfig[] = []
  await saveHomeSection('providers', (sec: unknown) => { // 唯一真源:落 config.json providers 段(0600)
    next = fn(sec === undefined ? legacy : Array.isArray(sec) ? sec : [])
    return next
  })
  return next
}

// ── 环境检测 + 引导安装(首启向导;检测+用户确认后执行,绝不静默自动装)──────────────
interface EnvProbe {
  tool: string
  found: boolean
  version: string | null
  /** 缺失时的安装命令(按平台);经 env:check 登记,env:run 只认 opaque id——renderer 不能传任意命令。 */
  installId: string | null
  installCommand: string | null
  /** 缺失时的手动下载页(包管理器不在 / 一键装得慢时的退路)。 */
  downloadUrl: string | null
}

/** env:check 登记的可执行安装命令(id → command);env:run 仅从此表取,防 renderer 注入任意命令。 */
const pendingInstallCommands = new Map<string, string>()

/** 「中国大陆」网络下给引导安装子进程注入的镜像 env(brew/pip/npm;不写用户 dotfile,可逆)。 */
function chinaInstallEnv(): Record<string, string> {
  return {
    HOMEBREW_BOTTLE_DOMAIN: 'https://mirrors.tuna.tsinghua.edu.cn/homebrew-bottles',
    HOMEBREW_API_DOMAIN: 'https://mirrors.tuna.tsinghua.edu.cn/homebrew-bottles/api',
    HOMEBREW_BREW_GIT_REMOTE: 'https://mirrors.tuna.tsinghua.edu.cn/git/homebrew/brew.git',
    HOMEBREW_CORE_GIT_REMOTE: 'https://mirrors.tuna.tsinghua.edu.cn/git/homebrew/homebrew-core.git',
    PIP_INDEX_URL: 'https://pypi.tuna.tsinghua.edu.cn/simple',
    npm_config_registry: 'https://registry.npmmirror.com',
  }
}

/** 命令依赖的程序(winget/brew/apt-get/curl)在不在。只认「确实找不到」;超时、非零退出这类含糊情况一律当在 ——
 *  宁可让「安装」跑出一条错误日志,也别因为机器一时卡顿把能用的按钮藏掉(评审指出 probeVersion 是失败即判无)。
 *  Windows 用 where.exe:exit 1 = PATH 上没有;cmd /c 对缺失程序也只回 1,和程序自身报错分不开,所以不走 shell。 */
function programExists(prog: string): Promise<boolean> {
  const win = process.platform === 'win32'
  return new Promise((resolve) => {
    execFile(win ? 'where.exe' : prog, win ? [prog] : ['--version'], { timeout: 8000, env: envWithFullPath(), windowsHide: true },
      (err) => resolve(!err || (win ? (err as { code?: unknown }).code !== 1 : (err as { code?: unknown }).code !== 'ENOENT')))
  })
}

function probeVersion(cmd: string, args: string[], shell = process.platform === 'win32'): Promise<string | null> {
  return new Promise((resolve) => {
    // Windows:npm/docker/python 等多为 .cmd/.bat shim,execFile 不带 shell 无法执行(npm 根本没有 npm.exe)→ 一律
    // 误判「未装」。shell:true 交 cmd.exe 解析。args 全为硬编码常量(--version 等),无注入面。windowsHide 免弹窗。
    // 已知是 .exe 的绝对路径传 shell=false:cmd.exe 拼串会拆开带空格的安装路径、展开路径里的 %VAR%。
    const p = execFile(cmd, args, { timeout: 8000, env: envWithFullPath(), shell, windowsHide: true }, (err, stdout, stderr) => {
      if (err) return resolve(null)
      resolve(String(stdout || stderr).trim().split('\n')[0].slice(0, 80) || '(ok)')
    })
    p.on('error', () => resolve(null))
  })
}

async function runEnvCheck(): Promise<EnvProbe[]> {
  pendingInstallCommands.clear()
  const mirror = (await loadConfig()).mirror
  const probes: Array<{ tool: string; cmd: string; args: string[] }> = [
    { tool: 'node', cmd: 'node', args: ['--version'] },
    { tool: 'npm', cmd: 'npm', args: ['--version'] },
    { tool: 'python3', cmd: process.platform === 'win32' ? 'python' : 'python3', args: ['--version'] },
    // mac 不探 PATH 上的 git:那是 Apple 的 /usr/bin/git shim,没装 CLT 时一跑就弹「安装开发者工具」系统框。
    // 按 findGit 的口径找真 git(homebrew/CLT/Xcode),找不到就当没装(内置那份在下面顶上)。
    { tool: 'git', cmd: process.platform === 'darwin' ? findGit(envWithFullPath()) ?? '' : 'git', args: ['--version'] },
    // `--version` 只问客户端(docker.exe),不连 daemon:原来的 `version --format {{.Server.Version}}` 要查
    // daemon,Docker Desktop 没开/慢启动时会卡满 8s 超时并误报「未装」。检测存在性用客户端版本即可。
    { tool: 'docker', cmd: 'docker', args: ['--version'] },
  ]
  const out: EnvProbe[] = []
  // 命令依赖的程序(winget/brew/apt-get/curl)本身不在,就不给「安装」—— 只给下载页。每次检测只探一次。
  const programOk = new Map<string, Promise<boolean>>()
  const programAvailable = (command: string): Promise<boolean> => {
    const prog = requiredProgram(command)
    if (!programOk.has(prog)) programOk.set(prog, programExists(prog))
    return programOk.get(prog)!
  }
  for (const p of probes) {
    const version = p.cmd ? await probeVersion(p.cmd, p.args) : null
    // npm 跟随 node 装,无独立安装命令
    let installCommand = version === null && p.tool !== 'npm' ? installCommandFor(p.tool, process.platform, mirror) : null
    if (installCommand && !(await programAvailable(installCommand))) installCommand = null
    let installId: string | null = null
    if (installCommand) {
      installId = `env_${p.tool}_${Date.now().toString(36)}`
      pendingInstallCommands.set(installId, installCommand)
    }
    const downloadUrl = version === null ? downloadUrlFor(p.tool, process.platform, mirror) : null
    out.push({ tool: p.tool, found: version !== null, version, installId, installCommand, downloadUrl })
  }
  // 内置 Python:默认 pythonMode=bundled 时 agent 用内置解释器,故 python 视为已满足(展示内置版本、无需系统安装)。
  const pyBin = bundledPythonBin()
  if (pyBin) {
    const v = await probeVersion(pyBin, ['--version'])
    const idx = out.findIndex((o) => o.tool === 'python3')
    const entry: EnvProbe = { tool: 'python3', found: true, version: `${v || 'Python'} · bundled`, installId: null, installCommand: null, downloadUrl: null }
    if (idx >= 0) out[idx] = entry; else out.push(entry)
  }
  /** 系统那份没探到才用内置顶上(系统已有 → 保留它的版本号,内置只是兜底)。 */
  const useBundled = async (tool: string, bin: string): Promise<void> => {
    const idx = out.findIndex((o) => o.tool === tool)
    if (idx < 0 || out[idx].found || !existsSync(bin)) return
    const v = await probeVersion(bin, ['--version'])
    out[idx] = { tool, found: true, version: `${v || tool} · bundled`, installId: null, installCommand: null, downloadUrl: null }
  }
  // 内置 Node:系统没装时 agent 的 PATH 里仍有这份内置 node/npm(backendManager 追加在 PATH 末尾),
  // 所以「未检测到」是谎报。系统装了就照旧显示系统那份 —— 内置只是兜底,不抢版本。
  const nodeRt = resolveBundledNode()
  if (nodeRt) {
    await useBundled('node', nodeRt.nodeBin)
    await useBundled('npm', nodeRt.npmBin)
  }
  // 内置 git:同上只兜底(Windows 追加在 PATH 末尾;mac 只在 PATH 查到的 git 不能用时前置,见 withBundledGit)。
  // 比 Node 严一格:得真跑通 --version 才算有 —— 文件在、起不来(权限丢了 / 被拦)时照旧报未装、留着安装建议。
  const gitRt = resolveBundledGit()
  const gitIdx = out.findIndex((o) => o.tool === 'git')
  if (gitRt && gitIdx >= 0 && !out[gitIdx].found) {
    // 不走 shell:Windows 上它是确定的 git.exe,mac 上是带 shebang 的包装脚本,都能直接 execFile
    const v = await probeVersion(gitRt.gitBin, ['--version'], false)
    if (v) out[gitIdx] = { tool: 'git', found: true, version: `${v} · bundled`, installId: null, installCommand: null, downloadUrl: null }
  }
  // tangu CLI:App 启动时自装的终端命令(report-only,无安装按钮——ensureCliInstalled 每次启动自愈)。
  const shim = join(tanguHomeDir(), 'bin', process.platform === 'win32' ? 'tangu.cmd' : 'tangu')
  out.push({
    tool: 'tangu',
    found: existsSync(shim),
    version: existsSync(shim) ? `CLI · v${app.getVersion()}` : null,
    installId: null,
    installCommand: null,
    downloadUrl: null,
  })
  return out
}

/** 持久化配置(userData/tangu-desktop-config.json)。 */
interface TanguStoredConfig {
  /** managed=自动托管内置后端;external=连接外部 tangu-server。
   *  (历史:v1 曾有 mode='unit' attach 远端;v2 换成 B 端渲染后废除,loadConfig 把遗留值迁回 managed。) */
  mode: 'managed' | 'external'
  backendUrl: string // external 模式
  /** external 模式的 bearer。P1-K5 起落盘在 device-secrets.json(safeStorage),不在 shell 文件里;loadConfig 解密回填。 */
  token: string
  /** 「允许其他设备连接本机」:开=起 unitWeb(局域网面)+ 云端设备通道(需登录;住在 Forsion Extend)。
   *  本机在名册里的设备配对凭据(unitHostId + unitHostSecret)P1-K5 起只在 device-secrets.json 的 unitPairing 槽里,
   *  不进这份配置 —— 渲染层读不到、写不进。 */
  unitHostEnabled: boolean
  /** unitWeb 服务端口(0=未定;首次启动选定后回写,保持稳定便于手输 IP 直连)。 */
  unitWebPort: number
  /** 本机安装实例 id(/unit/meta 自证身份,防 DHCP 换主后把别人的 Forsion 当成这台)。 */
  unitInstanceId: string
  /** 已配对设备(T1 局域网直连;令牌只存 hash,可在切换器里回收)。 */
  unitPairedDevices: PairedDevice[]
  /** P2P 直连的 STUN 服务器(空=内置国内可达缺省)。纯连接基建,刻意不进 UNIT_CONFIG_RW(unitConfigFace.ts)。 */
  unitP2pStun: string[]
  modelId: string
  /** 辅助模型 · LLM(后台/特殊 agent 用;落 config.json models.background;缺省=跟随 app 级槽)。 */
  backgroundModelId: string
  /** 辅助模型 · 图像识别(主模型无原生视觉时的看图兜底 + 非聊天识图;落 config.json models.vision)。 */
  visionModelId: string
  /** 图像识别何时介入:auto(仅主模型无视觉)/ always(所有图先转文字)/ off。落 config.json models.visionMode。 */
  visionMode: 'auto' | 'always' | 'off'
  /** 默认语音识别模型 id(语音输入转写用;持久化到 config.json asr.modelId;缺省=跟随 app 级 asr 默认)。 */
  asrModelId: string
  /** 语音输入偏好后端:local=本地 SenseVoice(需下载);cloud=自带-key/Forsion 云端。缺省 cloud。 */
  asrBackend: 'local' | 'cloud'
  /** 上次用的审批档 / 思考档:渲染层新建会话时据此起步(纯 UI 记忆,不进 config.json 段)。 */
  lastApprovalMode: 'readonly' | 'auto-edit' | 'full-auto' | 'custom'
  lastThinkingLevel: 'off' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max' | ''
  /** chat 模式的思考档记忆(按 preset 分槽,与 lastThinkingLevel 互不污染)。 */
  lastChatThinkingLevel: 'off' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max' | ''
  /** 上次在 work 会话里停在 Ultra 档(与 lastThinkingLevel='max' 同写;纯渲染层 UI 记忆)。 */
  lastUltra: boolean
  cloudUrl: string // managed:传给 tangu-server 的 Forsion 云端
  sandbox: 'auto' | 'docker' | 'none'
  hostSandbox?: HostSandboxConfig
  /** Python 来源:bundled=内置解释器(默认,免装/隔离);system=用系统已装 python。 */
  pythonMode: 'bundled' | 'system'
  /** 网络镜像:china=中国大陆镜像源(pip/npm/git + 市场 github 下载);default=直连。 */
  mirror: 'default' | 'china'
  /** 「Tangu 默认工作区」本地目录(空=按 ~/Tangu 兜底);新建本机会话默认 cwd。 */
  defaultWorkspaceDir: string
  browserEnabled: boolean
  browserEngine: 'auto' | 'chrome' | 'lightpanda'
  browserSearchEngine: 'duckduckgo' | 'bing' | 'google' | 'baidu'
  browserAllowPrivateUrls: boolean
  browserCommandTimeoutMs: number
  /** 本地记忆/日志是否自动同步 Forsion Brain(默认 false=仅手动)。 */
  forsionSyncEnabled: boolean
  /** 上次成功同步时刻(epoch ms)。 */
  forsionLastSyncedAt: number
  forsionSyncAccountId?: string | null
  /** 笔记(Amadeus)拖入附件存放方式:attachments=同目录 attachments/;same=与笔记同目录;vault=固定文件夹。 */
  notesAttachmentMode: 'attachments' | 'same' | 'vault'
  /** notesAttachmentMode==='vault' 时的 vault 相对文件夹(如 "assets")。 */
  notesAttachmentFolder: string
  /** 导入文件是否默认开启预览(![[file]] 形式);false=插入 [名](路径) 链接。 */
  notesImportPreview: boolean
  /** 日记(每日笔记)所在 vault 相对文件夹;'' = vault 根。 */
  notesDailyFolder: string
  /** 打开 v3 笔记时是否升级为 v4 纯 md 格式(默认关:手机端装机闸未确认前不写出 v4)。 */
  notesUpgradeV4: boolean
  /** `[[ ]]` 补全是否收录附件与数据库;关=只补全笔记。默认开。 */
  notesWikiIncludeFiles: boolean
  /** 朗读(TTS)模型 id(<providerId>/<model> 或某 provider ttsModelIds 命中);'' = 未启用,聊天不显示朗读按钮。 */
  ttsModelId: string
  /** 朗读音色 id(provider 特定,如 'alloy');'' = 不传该参数(OpenAI 等部分服务必填音色)。 */
  ttsVoice: string
  /** 朗读语速 0.5–2。 */
  ttsSpeed: number
  /** 新回复完成后自动朗读(仅当前活跃会话)。 */
  ttsAutoSpeak: boolean
  /** 实时语音通话模型:<providerId>/<model>(自带百炼 key)或 Forsion 云端的实时模型 id;'' = 未启用。存 config.json tts.realtimeModel。 */
  realtimeModelId: string
  /** 只读、不落盘:用户从没动过「语音通话」(config.json 里没有 tts.realtimeModel 这个键)。这时界面替他定缺省 ——
   *  装了 Forsion Extend 且已登录就默认开、用云端模型;一旦开关 / 选过模型(含关掉 → 写 ''),就按他选的来。 */
  realtimeModelUnset: boolean
  /** 实时通话音色;'' = 引擎按模型家族给缺省(Omni=Tina,Qwen-Audio=longanqian)。存 tts.realtimeVoice。 */
  realtimeVoice: string
  /** 记录应用内活动日志(~/.forsion/activity;Muse 数据源+bug 排查导出);关=停止新记录。 */
  activityLogEnabled: boolean
  /** 电脑历史(electron/computerHistory.ts):订阅 CU helper 记录全机 App / 标题 / URL / 输入差分,落 <forsionHome>/computer-history。
   *  默认关(显式同意才开);不在开发者选项里。 */
  computerHistoryEnabled: boolean
  /** 暂停到的时刻(epoch ms);null = 没暂停。到点自动恢复。 */
  computerHistoryPausedUntil: number | null
  /** 用户排除表:bundle id + 域名(含子域)。随订阅下发给 helper。 */
  computerHistoryExclude: { apps: string[]; domains: string[] }
  /** 对外 MCP 端点:开=主进程起本地 HTTP MCP server,外部 agent(Claude Code)可调桌面能力。默认关(信任边界,显式开启)。 */
  mcpEnabled: boolean
  /** 前台窗口采样接缝(electron/activeWindow.ts):开=插件可读「现在焦点在哪个 app」。
   *  默认关,且入口只在开发者选项 —— 同 mcpEnabled 的信任边界纪律,必须用户显式开启。 */
  activeWindowEnabled: boolean
  /** 有会话运行时阻止电脑闲置休眠(electron/keepAwake.ts)。默认关。 */
  keepAwakeWhileRunning: boolean
  /** Agent Desk 演出面板:聊天右侧 agent 展示区(编辑自动上台 + desk_present/desk_screenshot 工具)。
   *  2026-07-26 转正,默认**开**——只有显式关过的人才有 false 落盘(saveConfig 只写 patch 里出现的键,
   *  没碰过开关的装机读的是这里的默认值,改默认即生效,不需要迁移)。 */
  agentDeskEnabled: boolean
  /** 任务概览里点来源/产物文件时开在哪:新标签页(默认)或 Agent Desk 演出格。 */
  summaryOpenIn: 'tab' | 'desk'
  /** 在插件页停用的内置包主进程半身(Forsion Extend):开机装载前读,改了要重启才生效(builtinPlugins.ts 的开关名单)。 */
  disabledBundles: string[]
}

/**
 * 内置默认 Forsion 云端(大脑 brain API)。全新安装(无保存配置/无登录凭证/无 env)即指向生产环境,
 * 无需任何 .env 或环境变量。覆盖优先级见 loadConfig:
 *   已存配置 cloudUrl > 环境变量 TANGU_CLOUD_URL(含 ~/.tangu/.env)> 上次登录记忆 > 此默认。
 * 自建/私有部署改 ~/.tangu/.env 的 TANGU_CLOUD_URL 即可覆盖(打包二进制不读仓库里的 .env)。
 */
const DEFAULT_CLOUD_URL = 'https://api.forsion.net'

const DEFAULT_CONFIG: TanguStoredConfig = {
  mode: 'external',
  backendUrl: 'http://localhost:8787',
  token: '',
  unitHostEnabled: false,
  unitWebPort: 0,
  unitInstanceId: '',
  unitPairedDevices: [],
  unitP2pStun: [],
  modelId: '',
  backgroundModelId: '',
  visionModelId: '',
  visionMode: 'auto',
  asrModelId: '',
  asrBackend: 'cloud',
  lastApprovalMode: 'auto-edit',
  lastThinkingLevel: '',
  lastChatThinkingLevel: '',
  lastUltra: false,
  cloudUrl: '',
  sandbox: 'auto',
  hostSandbox: { mode: 'off', network: 'deny' },
  pythonMode: 'bundled',
  mirror: 'default',
  defaultWorkspaceDir: '',
  browserEnabled: true,
  browserEngine: 'auto',
  browserSearchEngine: 'duckduckgo',
  browserAllowPrivateUrls: false,
  browserCommandTimeoutMs: 30000,
  forsionSyncEnabled: false,
  forsionLastSyncedAt: 0,
  notesAttachmentMode: 'attachments',
  notesAttachmentFolder: 'assets',
  notesImportPreview: true,
  notesDailyFolder: '',
  notesUpgradeV4: true, // 2026-08-14 默认开(用户拍板);显式 false 才关
  notesWikiIncludeFiles: true,
  ttsModelId: '',
  ttsVoice: '',
  ttsSpeed: 1,
  ttsAutoSpeak: false,
  realtimeModelId: '',
  realtimeModelUnset: true,
  realtimeVoice: '',
  activityLogEnabled: true,
  computerHistoryEnabled: false,
  computerHistoryPausedUntil: null,
  computerHistoryExclude: { apps: [], domains: [] },
  mcpEnabled: false,
  activeWindowEnabled: false,
  keepAwakeWhileRunning: false,
  agentDeskEnabled: true,
  summaryOpenIn: 'tab',
  disabledBundles: [],
}

/** 默认工作区目录(配置未填时兜底):优先落在本地笔记库(Vault)内的 Sessions/ ——
 *  会话工作区与笔记同库,agent 产物可直接被笔记引用(2026-08-03 起)。没有本地库时维持旧口径:
 *  新用户 ~/Forsion(dev→~/Forsion-Dev),仅当存在**真实** ~/Tangu 目录(老用户,迁移软链不算)
 *  才沿用 ~/Tangu。best-effort 创建。 */
async function ensureDefaultWorkspaceDir(stored: TanguStoredConfig): Promise<string> {
  let dir = stored.defaultWorkspaceDir?.trim()
  if (!dir) {
    // 取 localVault 而非 lastVault:活动侧可能是云镜像,Sessions 落进去会整个被当笔记同步上云。
    const vault = (await readAmadeusConfig()).localVault
    if (vault && (await stat(vault).then((s) => s.isDirectory()).catch(() => false))) dir = join(vault, 'Sessions')
  }
  if (!dir) {
    const legacy = join(app.getPath('home'), 'Tangu')
    const isRealLegacyDir = await lstat(legacy).then((s) => s.isDirectory() && !s.isSymbolicLink()).catch(() => false)
    dir = isRealLegacyDir ? legacy : forsionWorkspaceDir()
  }
  await mkdir(dir, { recursive: true }).catch(() => {})
  return dir
}

// desktop-shell 专属键(留 userData/tangu-desktop-config.json):连哪个后端 + 同步开关。CLI 无此概念。
// 其余键(cloud/sandbox/workspace/browser/wechat)以 ~/.tangu/config.json 各段为权威,落盘亦写那里。
const SHELL_KEYS: Array<keyof TanguStoredConfig> = [
  'mode', 'backendUrl', // token 不在这里(P1-K5):进 device-secrets.json,见 writeConfigPatch
  'unitHostEnabled', 'unitWebPort', 'unitInstanceId', 'unitPairedDevices', 'unitP2pStun', // 设备互联(本机 Unit 侧状态;配对密钥在 device-secrets.json)

  'pythonMode', 'mirror', // 桌面专属(内置 python 是桌面才有的能力;镜像经后端 env 注入,不落 config.json 段)
  'activityLogEnabled', // 桌面专属(活动日志由 main 落盘)
  'computerHistoryEnabled', 'computerHistoryPausedUntil', 'computerHistoryExclude', // 桌面专属(电脑历史由 main 订阅 helper 并落盘)
  'mcpEnabled', // 桌面专属(对外 MCP 端点由 main 起停)
  'activeWindowEnabled', // 桌面专属(前台窗口采样由 main 探)
  'keepAwakeWhileRunning', // 桌面专属(powerSaveBlocker 由 main 持有)
  'agentDeskEnabled', // 桌面专属(Agent Desk 演出面板开关,纯渲染层 UI)
  'summaryOpenIn', // 桌面专属(任务概览的文件打开去处,纯渲染层 UI)
  'disabledBundles', // 桌面专属(内置包主进程半身由 main 开机装载)
  'lastApprovalMode', 'lastThinkingLevel', 'lastChatThinkingLevel', 'lastUltra', // 桌面专属(新会话起步档位的记忆,纯渲染层 UI;chat 单独一槽)
]
// 文件名是与引擎的契约(电脑历史第二道闸经 FORSION_DESKTOP_CONFIG 读它,见 shared/computerHistory.ts),改名三处同步
const configPath = (): string => join(app.getPath('userData'), COMPUTER_HISTORY_DESKTOP_CONFIG_FILE)

/** 前台窗口采样开关的**内存镜像**(真源 = config.activeWindowEnabled;启动时读一次,config:set 里跟着刷)。
 *  默认 false:配置读失败、或这行还没跑到,都必须是「关」。 */
let activeWindowOn = false
/** 采样门面:开关 + 缓存下限 + idle 都在 activeWindow.ts 里,这里只把宿主能力喂进去。 */
const sampleActiveWindow = createSampler({
  isEnabled: () => activeWindowOn,
  probe: nativeProbe,
  // getSystemIdleTime 在某些 linux 会话下会抛;拿不到就当「没挂机」(0),不让它拖垮采样。
  idleSeconds: () => { try { return powerMonitor.getSystemIdleTime() } catch { return 0 } },
  now: () => Date.now(),
  platform: process.platform,
})

/** 「有会话运行时不休眠」开关的内存镜像(真源 = config.keepAwakeWhileRunning),同 activeWindowOn 默认关。 */
let keepAwakeOn = false
const keepAwake = createKeepAwake({
  isEnabled: () => keepAwakeOn,
  start: () => powerSaveBlocker.start('prevent-app-suspension'),
  stop: (id) => powerSaveBlocker.stop(id),
})

// P1-K4 ── 「允许远程会话」开关 / 调用方首次本机确认 / 远程会话最高审批档(electron/remoteSessions.ts)。
// 只管 unitWeb 的 /engine(G9);开关与信任落 userData/remote-sessions.json,审批档只写 config.json 的 remote.maxApprovalMode。
// init 在 deviceSecrets.init 之后(K5 门控要有状态);isLocked 接 K2 的 remoteSafety(R-26:锁定时不弹首次确认)。
const remoteSessions = createRemoteSessions({
  file: () => join(app.getPath('userData'), REMOTE_SESSIONS_FILE),
  unitHostEnabled: async () => (await readShellConfig()).unitHostEnabled === true,
  readCap: async () => normalizeCap((await readHomeConfig()).remote?.maxApprovalMode),
  writeCap: (m) => configQueue(() => updateHomeConfig((home) => withRemoteCap(home, m))),
  accountId: () => { const c = loadTanguCreds(); return forsionAccountId(c.cloudUrl || '', c.token || '') },
  lookupUnit: async (unitId) => lookupRosterUnit({ base: (await loadConfig()).cloudUrl, token: loadTanguCreds().token || '' }, unitId),
  confirm: async (opts, signal) => {
    showMainWindow()
    // ⚠️ 必须挂父窗(同 confirmPair):无父的 showMessageBox 在 mac 上冻住主循环 → unitWeb / 引擎代理全挂;拿不到窗就不弹
    const win = mainWindow && !mainWindow.isDestroyed() ? mainWindow : null
    if (!win) return null
    const r = await dialog.showMessageBox(win, { ...opts, signal })
    return signal.aborted ? null : r.response === 0
  },
  permitted: () => deviceSecrets.remoteSessionsPermitted(),
  // P1-K2(R-26):remoteSafety 在下方定义,经 thunk 互引(不成环);K4 自己 try/catch → 读不出按锁定
  isLocked: () => (PRODUCT.agentBackend ? remoteSafety.isLocked() : false),
  onChanged: (view) => {
    for (const w of BrowserWindow.getAllWindows()) if (!w.isDestroyed() && !w.webContents.isDestroyed()) w.webContents.send('remoteSessions:changed', view)
  },
  log: (m) => console.log(m),
})

// P1-K2 ── 急停 + 远程锁定 + 远程活动指示(electron/remoteSafety.ts)。锁状态独占 userData/remote-lock.json(引擎经
// FORSION_REMOTE_LOCK_FILE 每次现读);unitWeb 读内存镜像。backend / mainWindow 在下方定义 → 这里一律惰性 thunk。
const remoteSafety = createRemoteSafety({
  file: () => join(app.getPath('userData'), REMOTE_LOCK_FILE),
  engine: () => { const st = backend.getStatus(); return { url: st.state === 'ready' ? st.url : null, token: backend.getToken() } },
  shortcuts: { register: (acc, cb) => globalShortcut.register(acc, cb), unregister: (acc) => globalShortcut.unregister(acc) },
  notify: (title, body) => { if (Notification.isSupported()) new Notification({ title: title.slice(0, 200), body: body.slice(0, 300) }).show() },
  refreshTray: (ind) => { refreshTrayMenu(); setTrayIndicator(ind.title, ind.tooltip) },
  keepAwake,
  systemAuth: createSystemAuth({
    platform: process.platform,
    touchId: { can: () => systemPreferences.canPromptTouchID(), prompt: (reason) => systemPreferences.promptTouchID(reason) },
    isAdmin: () => new Promise((res) => execFile('id', ['-Gn'], (err, out) => res(!err && /(^|\s)admin(\s|$)/.test(String(out))))),
    osascript: (script) => new Promise((res) => execFile('osascript', ['-e', script], (err, _out, stderr) => res(err
      ? { ok: false, spawnError: (err as NodeJS.ErrnoException).code === 'ENOENT', stderr: String(stderr || err.message) }
      : { ok: true }))),
    confirm: async () => {
      showMainWindow()
      // ⚠️ 必须挂父窗(同 confirmPair / K4 confirm):无父的 showMessageBox 在 mac 上冻住主循环;拿不到窗就不弹(= 取消)
      const win = mainWindow && !mainWindow.isDestroyed() ? mainWindow : null
      if (!win) return null
      const r = await dialog.showMessageBox(win, {
        type: 'warning', title: mt('main.remoteSafety.auth.dialogTitle'), message: mt('main.remoteSafety.auth.dialogMessage'),
        detail: mt('main.remoteSafety.auth.dialogDetail'), buttons: [mt('main.remoteSafety.auth.unlock'), mt('main.remoteSafety.auth.cancel')],
        defaultId: 1, cancelId: 1, noLink: true,
      })
      return r.response === 0
    },
    passwordPrompt: () => mt('main.remoteSafety.auth.dialogMessage'),
    log: (m) => console.log(m),
  }),
  lang: () => trayLang(),
  remoteCapable: () => remoteSessions.isEnabled(), // R-11
  trustedCallerLabel: (id) => remoteSessions.trustedCaller(id)?.name ?? null, // R-11
  mac: process.platform === 'darwin',
  log: (m) => console.log(m),
})
remoteSafety.onChange((st) => {
  for (const w of BrowserWindow.getAllWindows()) if (!w.isDestroyed() && !w.webContents.isDestroyed()) w.webContents.send('remoteSafety:changed', st)
})
/** 托盘「更改快捷键…」:主窗前置 + 打开设置浮窗的「远程会话」页(K2 面板经 K4 的扩展槽挂在那页末尾)。 */
function openRemoteSafetySettings(): void {
  showMainWindow()
  openFloatingPanel({ id: 'settings', title: mt('main.remoteSafety.settingsTitle'), builtin: 'settings', params: { tab: 'remote-sessions', skillKey: null, nonce: Date.now() } }) // nonce:设置窗口开着、停在别的页时也落得回来(同渲染层 openSettings)
}

async function readShellConfig(): Promise<Partial<TanguStoredConfig>> {
  let cur: Partial<TanguStoredConfig> = {}
  try { cur = JSON.parse(await readFile(configPath(), 'utf8')) } catch { /* 无文件 → 空 */ }
  // 首启从旧 desktop 迁移:本端 shell 配置无 mode(从未初始化)→ 依次尝试旧目录继承连接设置
  // (mode=managed + 云 token + 同步/工作区等)。tangu-agent-desktop2 = 2.4.0 包名 Forsion 化前的
  // dev userData 目录(打包版 userData 走 productName「Forsion」,不受包名影响);tangu-agent-desktop = 1.0。
  if (!cur.mode) {
    for (const legacyDir of ['tangu-agent-desktop2', 'tangu-agent-desktop']) {
      try {
        const legacyPath = join(app.getPath('userData'), '..', legacyDir, 'tangu-desktop-config.json')
        const legacy = JSON.parse(await readFile(legacyPath, 'utf8')) as Partial<TanguStoredConfig>
        if (legacy.mode) {
          const seeded = { ...legacy, ...cur } // 本端已显式设的键优先
          // 落盘一次,此后与旧目录解耦。这条经 loadConfig 走、排不进 configQueue(唯一临时名只保证不写坏文件,不防内容回退);
          // 正常启动时首次播种在 migrateCloudTokenToAuthJson 里就 await 完了,早于 IPC 注册,碰不上并发写
          await writePrivateJson(configPath(), seeded)
          return seeded
        }
      } catch { /* 该旧目录无配置 → 试下一个 */ }
    }
  }
  return cur
}

/**
 * 渲染端契约的完整 StoredDesktopConfig:`...shell` 提供所有旧键的回落(老用户零回退),
 * config.json 各段(存在即权威)覆盖其上 → 唯一真源在 config.json,desktop 文件仅兜底 + 存 shell 键。
 */
async function loadConfig(): Promise<TanguStoredConfig> {
  const shell = await readShellConfig()
  const home = await readHomeConfig()
  const cloud = home.cloud || {}, browser = home.browser || {}, notes = home.notes || {}, tts = home.tts || {}, asr = home.asr || {}
  const auxModels = home.models || {} // 辅助模型段(引擎侧 specialAgentsConfig / visionService 读同一段)
  const merged: TanguStoredConfig = {
    ...DEFAULT_CONFIG,
    ...shell, // 旧 desktop 文件:既给 shell 键,也作未迁移段的回落
    ...(home.cloud !== undefined ? { cloudUrl: cloud.url || '', modelId: cloud.defaultModel || '' } : {}),
    ...(home.sandbox !== undefined ? { sandbox: home.sandbox } : {}),
    hostSandbox: normalizeHostSandboxConfig(home.hostSandbox),
    ...(home.workspace !== undefined ? { defaultWorkspaceDir: home.workspace } : {}),
    ...(home.browser !== undefined ? {
      browserEnabled: browser.enabled !== false, browserEngine: browser.engine || 'auto',
      browserSearchEngine: browser.searchEngine || 'duckduckgo', browserAllowPrivateUrls: !!browser.allowPrivateUrls,
      browserCommandTimeoutMs: browser.commandTimeoutMs || 30000,
    } : {}),
    ...(home.notes !== undefined ? {
      notesAttachmentMode: notes.mode || 'attachments',
      notesAttachmentFolder: notes.folder || 'assets',
      notesImportPreview: notes.preview !== false,
      notesDailyFolder: notes.dailyFolder || '',
      notesUpgradeV4: notes.upgradeV4 !== false, // 未配置=开(Codex P1:=== true 会把默认物化成关)
      notesWikiIncludeFiles: notes.wikiIncludeFiles !== false,
    } : {}),
    ...(home.tts !== undefined ? {
      ttsModelId: tts.modelId || '',
      ttsVoice: tts.voice || '',
      ttsSpeed: typeof tts.speed === 'number' ? tts.speed : 1,
      ttsAutoSpeak: !!tts.autoSpeak,
      realtimeModelId: tts.realtimeModel || '',
      realtimeVoice: tts.realtimeVoice || '',
    } : {}),
    realtimeModelUnset: tts.realtimeModel === undefined,
    ...(home.asr !== undefined ? { asrModelId: asr.modelId || '', asrBackend: asr.backend === 'local' ? 'local' : 'cloud' } : {}),
    ...(home.models !== undefined ? {
      backgroundModelId: auxModels.background || '',
      visionModelId: auxModels.vision || '',
      visionMode: auxModels.visionMode === 'always' || auxModels.visionMode === 'off' ? auxModels.visionMode : 'auto',
    } : {}),
  }
  // v1→v2 迁移:mode='unit'(A 渲染器 attach 远端)已废除,遗留值一律迁回 managed,防悬空启动态。
  if ((merged.mode as unknown) === 'unit') merged.mode = 'managed'
  // P1-K5:设备密钥不在 shell 配置里了。降级旧版本写回来的残留也别让它经 `...shell` 进 config:get(渲染层)/ 设备页;
  // external token 从加密存储解密回填(槽空不碰加密后端;锁定 = '')。
  delete (merged as unknown as Record<string, unknown>).unitHostId
  delete (merged as unknown as Record<string, unknown>).unitHostSecret
  merged.token = await deviceSecrets.externalToken()
  // Account credentials and their server form one identity. A remembered endpoint
  // from settings must never send an active account's token to another server.
  const accountCreds = loadTanguCreds()
  if (accountCreds.token && accountCreds.cloudUrl) merged.cloudUrl = accountCreds.cloudUrl
  Object.assign(merged, loadAccountCloudSettings(accountCreds))
  merged.forsionSyncAccountId = forsionAccountId(accountCreds.cloudUrl || '', accountCreds.token || '')
  // 环境变量兜底:TANGU_CLOUD_URL(managed/登录默认)、TANGU_BACKEND_URL(external 外部地址)。
  if (!merged.cloudUrl) {
    merged.cloudUrl = process.env.TANGU_CLOUD_URL || loadTanguCreds().cloudUrl || DEFAULT_CLOUD_URL
  }
  if (process.env.TANGU_BACKEND_URL && merged.backendUrl === DEFAULT_CONFIG.backendUrl) {
    merged.backendUrl = process.env.TANGU_BACKEND_URL
  }
  return merged
}

/** patch 按键分流:shell 键 → desktop 文件;config-backed 键 → config.json 对应段(唯一真源)。
 *  排 configQueue;返回**写入前**的配置 —— 与写入同一队位读出,调用方拿它判「变没变」才不会读到别人写了一半的盘面。
 *  patch 也可以是 (写入前配置) => patch:基于当前值算新值(配对设备列表增删)必须用函数形态,在队外读会丢并发更新。 */
function saveConfig(
  patch: Partial<TanguStoredConfig> | ((before: TanguStoredConfig) => Partial<TanguStoredConfig>),
  accountCreds = loadTanguCreds(),
): Promise<TanguStoredConfig> {
  return configQueue(async () => {
    const before = await loadConfig()
    await writeConfigPatch(typeof patch === 'function' ? patch(before) : patch, accountCreds)
    return before
  })
}
async function writeConfigPatch(patch: Partial<TanguStoredConfig>, accountCreds: ReturnType<typeof loadTanguCreds>): Promise<void> {
  const accountPatch: Partial<ReturnType<typeof loadAccountCloudSettings>> = {}
  if ('forsionSyncEnabled' in patch) accountPatch.forsionSyncEnabled = patch.forsionSyncEnabled === true
  if ('forsionLastSyncedAt' in patch) accountPatch.forsionLastSyncedAt = patch.forsionLastSyncedAt || 0
  const accountId = forsionAccountId(accountCreds.cloudUrl || '', accountCreds.token || '')
  if (Object.keys(accountPatch).length && (patch.forsionSyncAccountId === undefined || patch.forsionSyncAccountId === accountId)) {
    saveAccountCloudSettings(accountPatch, accountCreds)
  }
  // P1-K5:external token 进加密存储(setExternalToken 顺带删掉 shell 里残留的旧原件)。下面读 shell 必须排在它之后,
  // 否则写回的是删之前那份 → 下次启动迁移按「shell 为准」把旧 token 盖回来。
  if ('token' in patch) await deviceSecrets.setExternalToken(String(patch.token ?? ''))
  // shell 键
  const shell = await readShellConfig()
  let shellTouched = false
  for (const k of SHELL_KEYS) if (k in patch) { (shell as any)[k] = (patch as any)[k]; shellTouched = true }
  if (shellTouched) await writePrivateJson(configPath(), shell)
  // config-backed 键 → config.json 段:持跨进程写锁、在写入那一刻的内容上合并(引擎 / CLI 同写这份);
  // patch 里没有这类键(最常见的 lastApprovalMode 之类)就不碰锁
  if (applyHomePatch({}, patch)) await updateHomeConfig((home) => applyHomePatch(home, patch))
}
/** 把 patch 里 config-backed 的键合进 config.json 各段;一个都没有 → undefined(不写)。 */
function applyHomePatch(home: Record<string, any>, patch: Partial<TanguStoredConfig>): Record<string, any> | undefined {
  const cloud = { ...(home.cloud || {}) }, browser = { ...(home.browser || {}) }, notes = { ...(home.notes || {}) }, tts = { ...(home.tts || {}) }, asr = { ...(home.asr || {}) }
  const auxModels = { ...(home.models || {}) }
  let cT = false, bT = false, oT = false, nT = false, tT = false, aT = false, mT = false
  if ('cloudUrl' in patch) { cloud.url = patch.cloudUrl; cT = true }
  if ('modelId' in patch) { cloud.defaultModel = patch.modelId; cT = true }
  if ('asrModelId' in patch) { asr.modelId = patch.asrModelId; aT = true }
  if ('asrBackend' in patch) { asr.backend = patch.asrBackend; aT = true }
  if ('backgroundModelId' in patch) { auxModels.background = patch.backgroundModelId; mT = true }
  if ('visionModelId' in patch) { auxModels.vision = patch.visionModelId; mT = true }
  if ('visionMode' in patch) { auxModels.visionMode = patch.visionMode; mT = true }
  if ('sandbox' in patch) { home.sandbox = patch.sandbox; oT = true }
  if ('hostSandbox' in patch) { home.hostSandbox = normalizeHostSandboxConfig(patch.hostSandbox); oT = true }
  if ('defaultWorkspaceDir' in patch) { home.workspace = patch.defaultWorkspaceDir; oT = true }
  if ('browserEnabled' in patch) { browser.enabled = patch.browserEnabled; bT = true }
  if ('browserEngine' in patch) { browser.engine = patch.browserEngine; bT = true }
  if ('browserSearchEngine' in patch) { browser.searchEngine = patch.browserSearchEngine; bT = true }
  if ('browserAllowPrivateUrls' in patch) { browser.allowPrivateUrls = patch.browserAllowPrivateUrls; bT = true }
  if ('browserCommandTimeoutMs' in patch) { browser.commandTimeoutMs = patch.browserCommandTimeoutMs; bT = true }
  if ('notesAttachmentMode' in patch) { notes.mode = patch.notesAttachmentMode; nT = true }
  if ('notesAttachmentFolder' in patch) { notes.folder = patch.notesAttachmentFolder; nT = true }
  if ('notesImportPreview' in patch) { notes.preview = patch.notesImportPreview; nT = true }
  if ('notesDailyFolder' in patch) { notes.dailyFolder = patch.notesDailyFolder; nT = true }
  if ('notesUpgradeV4' in patch) { notes.upgradeV4 = patch.notesUpgradeV4; nT = true }
  if ('notesWikiIncludeFiles' in patch) { notes.wikiIncludeFiles = patch.notesWikiIncludeFiles; nT = true }
  if ('ttsModelId' in patch) { tts.modelId = patch.ttsModelId; tT = true }
  if ('ttsVoice' in patch) { tts.voice = patch.ttsVoice; tT = true }
  if ('ttsSpeed' in patch) { tts.speed = patch.ttsSpeed; tT = true }
  if ('ttsAutoSpeak' in patch) { tts.autoSpeak = patch.ttsAutoSpeak; tT = true }
  if ('realtimeModelId' in patch) { tts.realtimeModel = patch.realtimeModelId; tT = true }
  if ('realtimeVoice' in patch) { tts.realtimeVoice = patch.realtimeVoice; tT = true }
  if (cT) home.cloud = cloud
  if (bT) home.browser = browser
  if (nT) home.notes = notes
  if (tT) home.tts = tts
  if (aT) home.asr = asr
  if (mT) home.models = auxModels
  return cT || bT || oT || nT || tT || aT || mT ? home : undefined
}

/** 一次性迁移:历史第二真源的 cloud token(config.json cloud.token,以及更老版本残留在桌面 shell 配置
 *  tangu-desktop-config.json 里的 cloudToken——readShellConfig 会整包继承旧目录,`...shell` 展开曾让它生效)
 *  → 并入 auth.json 后从各处删除。此后登录凭证唯一真源 = auth.json。 */
async function migrateCloudTokenToAuthJson(): Promise<void> {
  try {
    const home = await readHomeConfig()
    const shell = (await readShellConfig()) as Record<string, any>
    const legacy = home.cloud?.token || shell.cloudToken
    if (!legacy) return
    const creds = loadTanguCreds()
    if (!creds.token) saveTanguCreds({ ...creds, token: String(legacy) })
    if (home.cloud?.token) {
      await updateHomeConfig((c) => {
        if (!c.cloud?.token) return undefined
        delete c.cloud.token
        return c
      })
    }
    if (shell.cloudToken) {
      delete shell.cloudToken
      await writePrivateJson(configPath(), shell)
    }
  } catch (e) {
    console.error('[auth] cloud.token 迁移失败(忽略,登录态以 auth.json 为准):', e)
  }
}

const backend = new BackendManager()
let mainWindow: BrowserWindow | null = null
// 托盘常驻:关窗默认只隐藏;仅托盘「退出」/before-quit 置 true 后才放行真正关闭。
let isQuitting = false

// MCP 端点(electron/mcpServer.ts):**常驻**(08-24 引擎原生路 P1)——App 启动即起,给引擎当
// ASR 桥(transcribe_audio,凭每次启动随机的 bridgeSecret)。设置「高级」开关只管**外部 agent 面**:
// 开=接受 localSecret + 发布 forsion-mcp.json;关=拒外部密钥 + 删发现文件(知情启用的同意语义)。
const mcpBridgeSecret = randomBytes(24).toString('hex')
/** 主进程 ASR 的路径面(在 ipc 注册段与 runTranscribe 一起定义后赋值;桥调用时兜空)。 */
let mcpTranscribeFile:
  | ((p: string, req: { timestamps?: boolean; language?: string }) => Promise<string | { text: string; segments?: Array<{ start: number; end: number; text: string }> }>)
  | null = null
// 启动那次 apply 与 config:set 的 apply 可能并发:lifecycle 串行化,只起一个服务、发布/撤销按调用顺序(见 mcpServer.ts)。
const mcpLifecycle = createMcpLifecycle({
  start: (externalEnabled) => startForsionMcp({
    getEngine: () => ({ url: backend.getStatus().url, token: backend.getToken() }),
    localSecret: backend.localSecret(),
    bridgeSecret: mcpBridgeSecret,
    externalEnabled,
    transcribeFile: (p, req) => {
      if (!mcpTranscribeFile) return Promise.reject(new Error('ASR 未初始化'))
      return mcpTranscribeFile(p, req)
    },
    homeDir: forsionHomeDir(),
    log: (m) => console.log(m),
  }),
  homeDir: () => forsionHomeDir(),
  localSecret: () => backend.localSecret(),
  log: (m) => console.log(m),
})
async function applyForsionMcp(enabled: boolean | (() => Promise<boolean>)): Promise<void> {
  try {
    await mcpLifecycle.apply(enabled)
  } catch (e) {
    console.error('[mcp] apply enabled failed:', e)
  }
}
/** 渲染端「高级」页展示用:开关语义不变——running/url 只反映**外部 agent 面**是否开启(桥面常驻不展示)。 */
function forsionMcpStatus(): { running: boolean; url: string | null; token: string } {
  const url = mcpLifecycle.externalUrl()
  return { running: !!url, url, token: backend.localSecret() }
}

// ── 设备互联(方案 §11,B 端渲染):「允许其他设备连接本机」开关起停两件东西 ──────────────
//   unitWeb(unitWeb.ts):局域网 web 面(0.0.0.0,无需登录;配对令牌鉴权)——把本机曝成网页。
//   unitHub(Forsion Extend 0.6 起,见 unitHubSeam.ts):server 反向通道(需登录),把隧道请求整包转发给本机 unitWeb;
//     带着 P1-K7a 的 caps 上报器(通道 ready 之后报本机引擎态,手机据此分「在线但引擎没起」)。没有 Extend = 只起局域网面。
let unitHub: UnitHubInstance | null = null
let unitHubFactory: UnitHubFactory | null = null // Extend 装载时登记(setUnitHubFactory),doRefreshUnitHost 每次重建时调
let unitWeb: UnitWebHandle | null = null
let amadeusReadPlugins: (() => Promise<ExternalPluginSource[]>) | null = null // registerAmadeusIpc 返回时赋上
let amadeusVaultFace: import('./amadeus/ipc').VaultFace | null = null // 同上;unitWeb /vault/* 的本地库面
// 登录成功后踢一次 Amadeus 云同步引擎(值由 registerAmadeusIpc 返回时赋上)。否则引擎状态卡在
// auth-required:云端登录提示不消失 + 双向同步不启动(引擎凭据只有 restart 会重读,登录路径原本不触发)。
let restartAmadeusSync: (() => Promise<void>) | null = null
let stopAmadeusSync: (() => Promise<void>) | null = null
// Amadeus 云同步引擎住在 Forsion Extend(0.4 起):Extend 装载时登记工厂,registerAmadeusIpc 里 vault 建好后再调(amadeus/cloudSeam.ts)
let amadeusSyncFactory: AmadeusSyncFactory | null = null
let unitHostCloudUrl = DEFAULT_CLOUD_URL
let unitHostPairing: { unitId: string; secret: string } | null = null
// P1-KF:主进程文案(mt)的界面语言 = 渲染层报来的生效语言(ui:locale),上次的值落 userData/ui-locale.json 供窗口载入前用。
const uiLocale = createUiLocaleSync({ file: () => join(app.getPath('userData'), UI_LOCALE_FILE), log: (m) => console.log(m) })
// P1-K3:远程来源 run 的待批 → 系统通知(点击打开会话,通知上不放「批准」);60s 没人答 → 经 unit-hub 投收件箱给手机。逻辑全在 approvalDelivery.ts。
// e2e 钩子双闸(非打包 + 显式 FORSION_E2E_APPROVAL_DELIVERY=1,同 FORSION_UNIT_AUTO_PAIR 口径;打包版 isPackaged 恒 true → 天然失效):
// chat-events 台架是外部模式(桩引擎),这条订阅本该 idle —— 钩子让它改订 TANGU_BACKEND_URL,并把真 Notification 挂到
// globalThis.__forsionE2E,台架据此读 pending()、在真通知上 emit('click') 走完「点击 → approval:open → 打开会话」整链。
const approvalE2E = !app.isPackaged && process.env.FORSION_E2E_APPROVAL_DELIVERY === '1' && process.env.TANGU_BACKEND_URL
  ? { engineUrl: process.env.TANGU_BACKEND_URL, notifications: [] as Array<{ n: Notification; closed: boolean }> } : null
const approvalDelivery = createApprovalDelivery({
  ...(approvalE2E ? { getEngine: () => ({ url: approvalE2E.engineUrl, token: '' }), onEngineStatus: () => () => {} } : engineFromBackend(backend)),
  unitCreds: () => (unitHub?.status().connected && unitHostPairing
    ? { cloudUrl: unitHostCloudUrl, token: loadTanguCreds().token || '', unitId: unitHostPairing.unitId, secret: unitHostPairing.secret } : null),
  t: mt,
  notify: (o) => {
    if (!Notification.isSupported()) return null
    const n = new Notification({ title: o.title.slice(0, 200), body: o.body.slice(0, 300), timeoutType: 'never' })
    const rec = { n, closed: false }
    approvalE2E?.notifications.push(rec)
    n.show()
    return { close: () => { rec.closed = true; try { n.close() } catch { /* 已收走 */ } }, onClick: (cb) => { n.on('click', cb) } }
  },
  openSession: (sessionId) => { showMainWindow(); if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(APPROVAL_OPEN_CHANNEL, { sessionId }) },
  log: (m) => console.log(m),
})
if (approvalE2E) (globalThis as Record<string, unknown>).__forsionE2E = { approvalDelivery, notifications: approvalE2E.notifications }
/** 内置浏览器注入 Authorization 的隧道前缀(effectiveConfig 刷新)。 */
let unitTunnelPrefix = ''
/** P2P 直连(方案 §12):隐藏窗 WebRTC 宿主,懒建;身份变化点 closeAll(站着的已鉴权信道,
 *  不像 T2 逐请求重验 owner)。 */
let p2pMgr: P2pManager | null = null
/** A 侧出向连接:unitId → 本机代理。dead 由信道 onClose 打标,下次打开重建。 */
const p2pOutgoing = new Map<string, { proxy: P2pProxyHandle; peerId: string; dead: boolean }>()
/** 本机 P2P 代理的分区注入表:url 前缀 → Bearer 秘密(同隧道 Authorization 的机制)。 */
const p2pProxySecrets = new Map<string, string>()
let p2pStunCache: string[] = DEFAULT_STUN
function getP2p(): P2pManager {
  if (!p2pMgr) {
    p2pMgr = new P2pManager({
      preloadPath: join(__dirname, '../preload/p2pPreload.mjs'),
      stunServers: () => p2pStunCache,
      log: (m) => console.log(m),
    })
  }
  return p2pMgr
}
/** 关掉全部 P2P(两个方向)+ 回收本机代理与注入秘密。 */
async function closeAllP2p(): Promise<void> {
  p2pMgr?.closeAll()
  const closes = [...p2pOutgoing.values()].map((o) => o.proxy.close().catch(() => {}))
  p2pOutgoing.clear()
  p2pProxySecrets.clear()
  await Promise.all(closes)
}

/** 本机第一个非回环 IPv4 → 局域网直连地址;拿不到给 null(名册照常,只是没有直连提示)。 */
function unitLanUrl(): string | null {
  if (!unitWeb) return null
  for (const list of Object.values(networkInterfaces())) {
    for (const ni of list ?? []) {
      if (!ni.internal && ni.family === 'IPv4') return `http://${ni.address}:${unitWeb.port}`
    }
  }
  return null
}

/** 用户/插件 Space 配方清单(spaces:list IPC 与 unitWeb /unit/spaces 共用的唯一真源):
 *  ~/.tangu/spaces/<slug>/space.json + 插件捆绑包内嵌 plugins/<id>/spaces/<slug>/space.json。
 *  设备页(B 端渲染)没有这份数据就装不出插件 Space → Ribbon 上一个插件图标都没有(2026-08-24 实测),
 *  而方案 §拍板口径是「A 看到 B 的完整 Forsion(含 Ribbon/Space)」。 */
async function readSpacesList(): Promise<Array<{ slug: string; json: string; plugin?: string; iconUrl?: string }>> {
  const out: Array<{ slug: string; json: string; plugin?: string; iconUrl?: string }> = []
  // 自绘图标(space.json 的 iconFile)在这里读成 data URL 随清单带回去:设备页同源拿到,渲染层不必再开一条 IPC。
  // ponytail: 每枚 ≤256KB 的 base64 直接进清单;插件多到拖慢 loadUserSpaces 再改走 amadeus-asset: 协议按需取。
  const entry = async (slug: string, dir: string, plugin?: { id: string; dir: string }): Promise<void> => {
    const json = await readFile(join(dir, 'space.json'), 'utf8')
    const iconUrl = await readSpaceIconDataUrl(json, plugin ? [dir, plugin.dir] : [dir])
    out.push({ slug, json, ...(plugin ? { plugin: plugin.id } : {}), ...(iconUrl ? { iconUrl } : {}) })
  }
  try {
    const base = join(tanguHomeDir(), 'spaces')
    for (const e of (await readdir(base, { withFileTypes: true })).filter((x) => x.isDirectory())) {
      try { await entry(e.name, join(base, e.name)) } catch { /* 无 manifest 跳过 */ }
    }
  } catch { /* 目录不存在 = 空 */ }
  try {
    const proot = join(tanguHomeDir(), 'plugins')
    const SAFE_PID = /^[a-z0-9][a-z0-9-]{0,63}$/ // 与 amadeus/ipc.ts pluginIdOf 同一门禁(归属 id 须两侧一致)
    for (const p of (await readdir(proot, { withFileTypes: true })).filter((x) => x.isDirectory() && !x.name.startsWith('.'))) {
      let pid: string
      try {
        const m = JSON.parse(await readFile(join(proot, p.name, 'manifest.json'), 'utf8')) as { id?: string }
        const cand = typeof m.id === 'string' && SAFE_PID.test(m.id) ? m.id : p.name
        if (!SAFE_PID.test(cand)) continue // manifest id 与目录名皆非法 → 与拒载口径一致
        pid = cand
      } catch { continue } // 无 manifest.json = 非插件目录,跳过
      try {
        const sroot = join(proot, p.name, 'spaces')
        for (const e of (await readdir(sroot, { withFileTypes: true })).filter((x) => x.isDirectory())) {
          try { await entry(e.name, join(sroot, e.name), { id: pid, dir: join(proot, p.name) }) } catch { /* 无 space.json 跳过 */ }
        }
      } catch { /* 无 spaces/ 子目录 */ }
    }
  } catch { /* plugins 目录不存在 = 无捆绑包 */ }
  return out
}

/** 设备页可见的配置白名单(RW/RO 与远端只读的审批档)真身在 unitConfigFace.ts。 */

/** listDir 唯一真源(fs:listDir IPC 与 /unit/hostdir 共用):2000 条 cap,目录在前按名排序。 */
async function listDirImpl(dirPath: string): Promise<Array<{ name: string; isDir: boolean; size: number; path: string }>> {
  if (!dirPath || typeof dirPath !== 'string') return []
  const entries = await readdir(dirPath, { withFileTypes: true }).catch(() => [])
  const out: Array<{ name: string; isDir: boolean; size: number; path: string }> = []
  for (const e of entries.slice(0, 2000)) {
    let size = 0
    if (e.isFile()) {
      try { size = (await stat(join(dirPath, e.name))).size } catch { /* ignore */ }
    }
    // path 必须随条目返回:渲染层(HostFilesTab)按 en.path 做预览/进目录/重命名/删除,缺失则全部操作拿到 undefined 而报错。
    out.push({ name: e.name, isDir: e.isDirectory(), size, path: join(dirPath, e.name) })
  }
  // 目录在前,各自按名排序
  out.sort((a, b) => (a.isDir === b.isDir ? a.name.localeCompare(b.name) : a.isDir ? -1 : 1))
  return out
}
/** statPath 唯一真源(fs:stat IPC 与 /unit/hoststat 共用)。 */
async function statPathImpl(p: string): Promise<{ isDir: boolean; mtimeMs: number; birthtimeMs: number | null; files?: number; folders?: number } | null> {
  if (!p || typeof p !== 'string') return null
  try {
    const st = await stat(p)
    const birthtimeMs = st.birthtimeMs > 0 ? st.birthtimeMs : null
    if (!st.isDirectory()) return { isDir: false, mtimeMs: st.mtimeMs, birthtimeMs }
    const es = await readdir(p, { withFileTypes: true }).catch(() => [])
    let files = 0
    let folders = 0
    for (const e of es) e.isDirectory() ? folders++ : files++
    return { isDir: true, mtimeMs: st.mtimeMs, birthtimeMs, files, folders }
  } catch { return null }
}

/** 本机确认过的项目根(/unit/host* 会话根的准入,Codex 终审 out1 #2):原生目录选择框的结果 + 一次性种子。
 *  存 userData 下独立文件 —— 不在 config:set / /unit/config 能写的配置里。规则见 unitLocalRoots.ts 文件头。 */
let unitLocalRegistry: LocalProjectRegistry | null = null
function localProjectRegistry(): LocalProjectRegistry {
  return (unitLocalRegistry ??= createFileProjectRegistry(join(app.getPath('userData'), 'unit-local-project-roots.json')))
}
/** host 会话行的来源(引擎在 loopback,15s 缓存防抖;引擎没起 / 拉取失败 = 空集,只剩工作区 + vault 两根,不放大)。 */
let unitRootsSource: UnitSessionRootsSource | null = null
function unitSessionRootsSource(): UnitSessionRootsSource {
  return (unitRootsSource ??= createUnitSessionRoots({
    engine: () => {
      const st = backend.getStatus()
      return { url: st.state === 'ready' ? (st.url ?? null) : null, token: backend.getToken() }
    },
    registry: localProjectRegistry(),
    log: (m) => console.log(m),
  }))
}

/** /unit/host{file,dir,stat} 三端点共用的钳制上下文:roots = 工作区 ∪ vault ∪ **本机确认过的**会话根,default-deny。
 *  会话根:无远程标记、且 realpath 落在本机根(工作区 / vault / Coding Studio 项目根 / 本机登记表)里的 project_path
 *  (unitLocalRoots.ts);再过 `/`、家目录、受保护目录祖先的过滤;受保护路径(Forsion 家目录 / 引擎 home / userData /
 *  通用凭据库)无条件拒(契约 C4,评审 A-desktop#1)。「校验和读取绑同一对象」的竞态防线在 unitHostScope.ts(vitest 直测):
 *  文件读走 openUnitHostRegularFile(经下面的 openUnitScopedFile),目录 / stat 走 withVerifiedUnitPath。 */
async function unitScopeCtx(): Promise<{ roots: { base: string[]; session: string[] }; env: { home: string }; guard: ReturnType<typeof buildUnitScopeGuard> }> {
  const stored = await loadConfig()
  const base: string[] = []
  try { base.push(realpathSync(await ensureDefaultWorkspaceDir(stored))) } catch { /* 无工作区 */ }
  try { const vr = amadeusVaultFace?.root(); if (vr) base.push(realpathSync(vr)) } catch { /* 无库 */ }
  const localExtra: string[] = []
  try { localExtra.push(realpathSync(join(forsionWorkspaceDir(), 'Project'))) } catch { /* Coding Studio 没建过项目 */ }
  const guard = buildUnitScopeGuard({
    home: homedir(),
    forsionHome: forsionHomeDir(),
    tanguHome: process.env.TANGU_HOME || tanguDataDir(),
    userData: app.getPath('userData'),
    appData: app.getPath('appData'),
  })
  const env = { home: homedir() }
  const roots = await composeUnitRoots({ base, localExtra, registry: localProjectRegistry(), source: unitSessionRootsSource(), env, guard })
  return { roots, env, guard }
}

/** /unit/hostfile(readHostFile)与 /unit/hostfile/download(openHostFile)的唯一文件解析(P1-DL):同一份根 / 凭据闸 / fd 绑定,
 *  两条路永远同判。只认普通文件;句柄归调用方关闭。 */
async function openUnitScopedFile(p: string): ReturnType<typeof openUnitHostRegularFile> {
  const ctx = await unitScopeCtx()
  return openUnitHostRegularFile(p, ctx.roots, ctx.env, ctx.guard)
}

/** 按当前配置起停/重建 unitWeb + 云端设备通道(开关/cloudUrl/账号变化后调;幂等)。
 *  串行化(同 ensureChain 的病):四个身份变化点 + config:set 可能连发,并发重建会让第二次
 *  startUnitWeb 撞 EADDRINUSE → 落 port 0 → 悄悄换掉用户刚抄走的直连端口。 */
let unitRefreshChain: Promise<void> = Promise.resolve()
function refreshUnitHost(): Promise<void> {
  unitRefreshChain = unitRefreshChain
    .then(() => doRefreshUnitHost())
    .catch((e) => { console.error('[unit] refresh failed:', e) })
  return unitRefreshChain
}
async function doRefreshUnitHost(): Promise<void> {
  const stored = await loadConfig()
  unitHostCloudUrl = stored.cloudUrl
  p2pStunCache = stored.unitP2pStun?.length ? stored.unitP2pStun : DEFAULT_STUN
  // P2P 全收(advisor P0):站着的信道不逐请求重验身份,登录/登出/换号/开关变化一律推倒重连。
  await closeAllP2p()
  // P1-K5:配对从 device-secrets.json 读,只在互联开着时读(读 = 可能解密 = macOS 可能弹钥匙串)。
  const pairing: deviceSecrets.PairingRead = stored.unitHostEnabled ? await deviceSecrets.unitPairing() : { state: 'ok', value: null }
  unitHostPairing = pairing.state === 'ok' ? pairing.value : null
  if (unitHub) { unitHub.stop(); unitHub = null } // stop() 也让 caps 上报器停报(onChannelDown)
  if (unitWeb) { const w = unitWeb; unitWeb = null; await w.close() } // 必须等旧服务真放掉端口,否则新起撞自己
  remoteSessions.notifyChanged() // P1-K4:父开关 / 账号可能变了(换号收掉旧账号的确认框)
  if (!stored.unitHostEnabled) return
  // 实例 id:首次开启生成并回写(/unit/meta 自证身份,防 DHCP 换主誊错设备)。
  let instanceId = stored.unitInstanceId
  if (!instanceId) {
    instanceId = randomUUID()
    await saveConfig({ unitInstanceId: instanceId })
  }
  // 本机项目根种子没做完之前,远端的 /engine 一律 503(seedGatedEngine):远端没有窗口抢在种子之前改 project_path。
  void localProjectRegistry().ready().then(() => unitSessionRootsSource().ensureSeeded()).then(() => unitHub?.engineChanged()) // P1-K7a:种子做完 = starting → ready
  const webDeps = {
    getEngine: seedGatedEngine(() => {
      const st = backend.getStatus()
      return { url: st.state === 'ready' ? (st.url ?? null) : null, token: backend.getToken(), remoteMark: backend.remoteMarkSecret() }
    }, unitSessionRootsSource()),
    confirmPair: async (info: { name: string; code: string; ip: string }): Promise<boolean> => {
      // 开发测试后门:**双闸**——非打包(app.isPackaged=false)且显式 FORSION_UNIT_AUTO_PAIR=1,
      // 才自动批准免手点。任一缺失都走下面的真弹框。⚠️ 这道闸绝不能变成无条件/进发布包:
      // 少了它同网段任何设备都能无验证接管本机(引擎执行 + 读写库)。打包版 isPackaged 恒 true,
      // 后门天然失效;env 需人显式设,不会误触。
      if (!app.isPackaged && process.env.FORSION_UNIT_AUTO_PAIR === '1') {
        console.log(`[unit-web] AUTO-PAIR(dev 后门):自动批准「${info.name}」(${info.ip}) 码=${info.code}`)
        return true
      }
      showMainWindow()
      // ⚠️ 弹框必须挂父窗:mac 上无父的 showMessageBox 是 app-modal,会**冻住主进程事件循环**——
      // unitWeb/引擎代理/本机 IPC 全部悬死,对端的配对轮询整片超时(活体探针 2026-08-24 实测)。
      // 挂父 = window-modal sheet,主循环照转;拿不到窗口的极端情形维持旧行为(短暂冻结好过弹不出)。
      const opts = {
        type: 'question' as const,
        title: mt('main.pair.title'),
        message: mt('main.pair.message', { name: info.name, ip: info.ip }),
        detail: mt('main.pair.detail', { code: info.code }),
        buttons: [mt('main.pair.allow'), mt('main.pair.deny')],
        defaultId: 1,
        cancelId: 1,
      }
      const win = mainWindow && !mainWindow.isDestroyed() ? mainWindow : null
      const r = win ? await dialog.showMessageBox(win, opts) : await dialog.showMessageBox(opts)
      return r.response === 0
    },
    pairedDevices: {
      list: (): PairedDevice[] => unitPairedCache,
      add: async (d: PairedDevice): Promise<void> => {
        let next: PairedDevice[] = []
        await saveConfig((c) => ({ unitPairedDevices: (next = [...(c.unitPairedDevices || []), d]) })) // 以队内读到的列表为底,与并发的撤销互不抹掉
        unitPairedCache = next // 落盘成功才放行:写失败不留一台只在内存里的已配对设备
      },
    },
    readPlugins: () => (amadeusReadPlugins ? amadeusReadPlugins() : Promise.resolve([])),
    readSpaces: () => readSpacesList(),
    ...unitConfigFace({
      effective: async () => (await effectiveConfig()) as unknown as Record<string, unknown>,
      save: async (p) => { await saveConfig(p as Partial<TanguStoredConfig>) },
    }),
    // 直连 provider 元数据(模型选择器认直连模型用):**剥 apiKey/baseUrl** —— 密钥绝不出机,
    // 设备页只需要清单字段;代价=设备页朗读/生图直连不可用(它们要 key,本就该在对方机器上跑)。
    readProviders: async () => (await readProvidersFile()).map((p) => ({
      providerId: p.providerId,
      modelIds: p.modelIds || [],
      imageModelIds: p.imageModelIds || [],
      ttsModelIds: p.ttsModelIds || [],
      asrModelIds: p.asrModelIds || [],
      noVisionModelIds: p.noVisionModelIds || [],
    })),
    // 主机文件只读面(Desk/文件卡/Pin Summary 产物的数据源):realpath 钳制在
    // 工作区根 ∪ vault 根 ∪ **host 会话的 project_path 集合**(Codex P2:会话可开在任意目录,
    // 只钳默认工作区会让那些会话的 Desk/文件卡全 404;这些目录本就是 agent 的可达范围,只读不扩权)。
    // default-deny —— 越界/不存在一律 null(unitWeb 统一 404,不泄露存在性)。写/删一概不给(审计 C1)。
    readHostFile: async (p: string, maxBytes?: number) => {
      // 文件读:根本身是目录,不含。校验与读取绑在同一个 FileHandle 上(换软链的竞态读不到凭据,Codex 三轮 P1)。
      // 与下面的 openHostFile(/unit/hostfile/download)同一个解析,两条路判据不分叉。
      const opened = await openUnitScopedFile(p)
      if (!opened) return null
      const { fh, real, st } = opened
      try {
        // 上限:直连 50MB(同 fs:readFile);隧道路径由 unitWeb 按信封余量传入更小值(Codex P2:
        // base64 双重膨胀,10MB 信封实际只装得下 ~4MB 原文,超了会超时而不是优雅 tooLarge)。
        const UNIT_MAX_READ = Math.min(maxBytes || 50 * 1024 * 1024, 50 * 1024 * 1024)
        const ext = (real.split('.').pop() || '').toLowerCase()
        const UNIT_MIME: Record<string, string> = {
          md: 'text/markdown', txt: 'text/plain', html: 'text/html', htm: 'text/html', css: 'text/css',
          js: 'text/javascript', ts: 'text/plain', json: 'application/json', csv: 'text/csv',
          png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', svg: 'image/svg+xml',
          pdf: 'application/pdf', mp4: 'video/mp4', mp3: 'audio/mpeg', wav: 'audio/wav',
        } // ponytail: fs:readFile 的 MIME_BY_EXT 是函数局部,先复制常用子集;要合并时把那张表提到模块级
        const mimeType = UNIT_MIME[ext] || 'application/octet-stream'
        if (st.size > UNIT_MAX_READ) return { mimeType, content: '', size: st.size, mtimeMs: st.mtimeMs, tooLarge: true }
        const buf = await fh.readFile()
        return { mimeType, content: buf.toString('base64'), size: st.size, mtimeMs: st.mtimeMs }
      } finally {
        await fh.close().catch(() => {})
      }
    },
    // 主机文件下载(P1-DL,/unit/hostfile/download):与 readHostFile 同一个解析,拿到的句柄交 unitWeb 流式写出(它负责关)。
    openHostFile: async (p: string) => {
      const opened = await openUnitScopedFile(p)
      return opened ? { fh: opened.fh, real: opened.real, size: opened.st.size } : null
    },
    // 主机目录/条目只读面(工作台文件面板/悬停提示的数据源):钳制同 hostfile,目录类可指根本身。
    // 与 fs:listDir / fs:stat 共用唯一真源实现(listDirImpl/statPathImpl)。写/删仍一概不给。
    readHostDir: async (p: string) => {
      const ctx = await unitScopeCtx()
      // 枚举必须钉在**已验证的 real**上(拿 p 再列会在钳制后重新解引用软链 —— 竞态改指向即可
      // 越界枚举,Codex 四轮 P2/TOCTOU),且列完再核一次对象身份(withVerifiedUnitPath);条目路径再改写回
      // **请求方命名空间**(根是软链时,realpath 命名空间会让面板认不出自己的根,三轮 P2)。逐条读取仍各自钳制。
      return withVerifiedUnitPath(p, ctx.roots, ctx.env, ctx.guard, true, async (real) => {
        const st = await stat(real).catch(() => null)
        if (!st?.isDirectory()) return null
        return (await listDirImpl(real)).map((e) => ({ ...e, path: join(p, e.name) }))
      })
    },
    readHostStat: async (p: string) => {
      const ctx = await unitScopeCtx()
      return withVerifiedUnitPath(p, ctx.roots, ctx.env, ctx.guard, true, (real) => statPathImpl(real))
    },
    vault: () => amadeusVaultFace,
    // P2P 应答(B 侧,方案 §12):acceptOffer 出 answer;DataChannel 开门后把信道接到本机 unitWeb
    // (attachHostChannel 与 Forsion Extend 里 UnitHost.handle 同构,但盖的是 P2P 专用密钥 x-unit-p2p,响应全流式)。
    // 打洞不成(waitOpen 超时)只收对端,不影响别的通路。
    p2pAnswer: async (offerSdp: string) => {
      const mgr = getP2p()
      const { peerId, sdp } = await mgr.acceptOffer(offerSdp)
      void mgr.waitOpen(peerId, 25_000).then(() => {
        attachHostChannel(mgr.channel(peerId), {
          getUnitWeb: () => ({ url: unitWeb ? `http://127.0.0.1:${unitWeb.port}` : null, p2pSecret: unitWeb?.p2pSecret ?? '' }),
          log: (m) => console.log(m),
        })
      }).catch(() => mgr.closePeer(peerId))
      return sdp
    },
    meta: { instanceId, name: hostname(), version: app.getVersion() },
    webDistDir: (): string | null => {
      const env = process.env.TANGU_UNIT_WEB_DIST
      if (env && existsSync(env)) return env
      const bundled = join(process.resourcesPath || '', 'unit-web') // 捆包落点(electron-builder extraResources)
      if (existsSync(bundled)) return bundled
      const dev = join(app.getAppPath(), 'unit-web-dist') // dev:build-unit-web.mjs 的产物,免设环境变量
      return existsSync(dev) ? dev : null
    },
    log: (m: string) => console.log(m),
    remoteAccess: remoteSessions.gate, // P1-K4:会话档闸(同步;K2 的 remoteLock 放在相邻一行)
    ...(PRODUCT.agentBackend ? { remoteLock: () => remoteSafety.isLocked() } : {}), // P1-K2:急停后远端只剩读 + 中止(同步内存镜像)
  }
  // 配对名单在队列里现读,别用开头那份快照:上面几处 await 期间用户可能刚撤销了设备,旧快照会把它重新放行
  unitPairedCache = await configQueue(async () => (await loadConfig()).unitPairedDevices || [])
  await remoteSessions.ready // P1-K4:迁移读完再开门(之前闸本就 fail closed,这里只为首个请求拿到真状态)
  try {
    // 端口保持稳定(便于手输 IP 直连):首选已存端口/8791,被占则退化系统分配并回写。
    const want = stored.unitWebPort || 8791
    try {
      unitWeb = await startUnitWeb(webDeps, { port: want })
    } catch {
      unitWeb = await startUnitWeb(webDeps, { port: 0 })
    }
    if (unitWeb.port !== stored.unitWebPort) await saveConfig({ unitWebPort: unitWeb.port })
    console.log(`[unit-web] 已启动:${unitLanUrl() ?? `http://127.0.0.1:${unitWeb.port}`}`)
  } catch (e: any) {
    console.error('[unit-web] 启动失败:', e?.message || e)
    return
  }
  // P1-K5:配对读不出来(钥匙串拒绝 / 被重置 / 迁移校验没过)= 只起局域网面,不建设备通道,**绝不自动重新登记**
  // (新 unit id 会让别的设备对本机的信任全部作废);等本机「重试」或「重新登记本机」(secrets:* IPC)。
  if (deviceSecrets.unitHostStartPlan({ enabled: stored.unitHostEnabled, pairing: pairing.state }) === 'web-only-locked') {
    console.warn('[unit] 设备凭据读不出来:只起局域网面,不建设备通道')
    return
  }
  // 云端设备通道(隧道 + P1-K7a caps 上报器)住在 Forsion Extend(0.6 起,unitHubSeam.ts):没装载 = 只起局域网面。
  if (!unitHubFactory) {
    console.log('[unit] 没有 Forsion Extend 的设备通道:只起局域网面,不经云端中转')
    return
  }
  const hub: UnitHubInstance = unitHubFactory({
    getCreds: () => ({ cloudUrl: unitHostCloudUrl, token: loadTanguCreds().token || '' }),
    getUnitWeb: () => ({ url: unitWeb ? `http://127.0.0.1:${unitWeb.port}` : null, internalSecret: unitWeb?.internalSecret ?? '' }),
    // 调用方断言(P1 · K1)宿主签:钥是这个 unitWeb 实例的 per-boot proxyCallerKey,签哪些路径与验签都在 unitCaller.ts
    callerHeaders: makeCallerHeaders(() => unitWeb?.proxyCallerKey ?? '', (m) => console.log(m)),
    getLanUrl: () => unitLanUrl(),
    getPairing: () => unitHostPairing,
    // 入册回包到达时这个通道已被 refreshUnitHost 换掉(停用 / 换账号):旧那一轮的配对不许落盘(Codex 评审 P1)。
    // 残余窗口(检查通过后才换号)由通道 403/404 → clearPairing → 重新入册自愈。
    ...pairingWriters(() => unitHub === hub, async (p) => { unitHostPairing = p; await deviceSecrets.setUnitPairing(p) }),
    // caps 上报器每次现算(通道 ready 之后报一次,backend.onStatus / 种子做完再报变化)
    engineCaps: () => engineCapsState({ agentBackend: PRODUCT.agentBackend, backend: backend.getStatus().state, seeded: unitSessionRootsSource().seeded() }),
    log: (m) => console.log(m),
  })
  unitHub = hub
  hub.start()
}
let unitPairedCache: PairedDevice[] = []

/** renderer 视角的有效配置:managed 就绪时 backendUrl/token 来自托管子进程。
 *  externalConnection = **落盘的**外部连接地址 / 令牌(不被托管折算覆盖):设置页从托管切到外部时用它填表,
 *  不能拿托管后端的临时地址 / 令牌当外部配置写回去(Codex 第一轮 A-1)。 */
async function effectiveConfig(): Promise<
  TanguStoredConfig & {
    backendState: BackendStatus
    homeDir: string
    forsionMcp: { running: boolean; url: string | null; token: string }
    externalConnection: { backendUrl: string; token: string }
  }
> {
  const stored = await loadConfig()
  const st = backend.getStatus()
  const homeDir = app.getPath('home')
  const forsionMcp = forsionMcpStatus()
  // 默认工作区目录折算为有效绝对路径(并确保存在),renderer 用它建「Tangu 默认工作区」会话。
  const defaultWorkspaceDir = await ensureDefaultWorkspaceDir(stored)
  // 内置浏览器给隧道设备页注入 Authorization 的前缀(effectiveConfig 被 boot/配置变更高频调用,借道刷新)。
  unitTunnelPrefix = `${stored.cloudUrl.replace(/\/+$/, '')}/api/units/`
  const externalConnection = { backendUrl: stored.backendUrl, token: stored.token }
  if (stored.mode === 'managed' && st.state === 'ready' && st.url) {
    return { ...stored, backendUrl: st.url, token: backend.getToken(), backendState: st, homeDir, defaultWorkspaceDir, forsionMcp, externalConnection }
  }
  return { ...stored, backendState: st, homeDir, defaultWorkspaceDir, forsionMcp, externalConnection }
}

// 串行化:连续 config:set(如先改 cloudUrl 再改 sandbox)触发的多次 ensureBackend
// 排队执行,避免并发 start() 双 spawn/端口竞争。
let ensureChain: Promise<void> = Promise.resolve()
function ensureBackend(): Promise<void> {
  if (!PRODUCT.agentBackend) return Promise.resolve() // 产品档案:本变体不捆 agent 托管后端
  ensureChain = ensureChain.then(async () => {
    const stored = await loadConfig()
    // 「允许其他设备连接本机」开着时引擎必须常驻:本机 UI 切去别的 Unit(mode≠managed)
    // 也不能停 —— 停了 = 别的设备那头断服(设备通道与局域网面的转发目标就是这个引擎)。
    if (stored.mode !== 'managed' && !stored.unitHostEnabled) {
      await backend.stop()
      return
    }
    const defaultWorkspaceDir = await ensureDefaultWorkspaceDir(stored)
    // 退出 / 清数据已开始(那边刚 stop 过):排在队里的这次若照常拉起,App 一退引擎就成了孤儿。
    // backend.stop() 的代号只作废已进 start() 的链,拦不住还在上面两个 await 里的这一次。
    if (isQuitting) return
    await backend.start({
      cloudUrl: stored.cloudUrl,
      modelId: stored.modelId || undefined,
      sandbox: stored.sandbox,
      pythonMode: stored.pythonMode,
      mirror: stored.mirror,
      browserEnabled: stored.browserEnabled,
      browserEngine: stored.browserEngine,
      browserSearchEngine: stored.browserSearchEngine,
      browserAllowPrivateUrls: stored.browserAllowPrivateUrls,
      browserCommandTimeoutMs: stored.browserCommandTimeoutMs,
      defaultWorkspaceDir,
    })
  }).catch((e) => {
    console.error('[tangu-desktop] ensureBackend failed:', e)
  })
  return ensureChain
}

/** 所有窗口(主窗 + 独立窗 + mini + floating)共用的 webPreferences:同一份 preload → 同一 window.tangu 暴露面。 */
/** 台架静默:Playwright 起的实例(或 TANGU_HARNESS_QUIET=1)窗口一律 showInactive —— 不激活 App、不抢用户前台焦点。
 *  TANGU_HARNESS_QUIET=0 强制关(测聚焦语义的台架 / 负对照用);人起的 dev / 安装版不受影响。
 *  主窗 / 独立窗另外压到普通窗口之下(见 sinkForHarness),不盖住用户正在用的 App。
 *  ponytail: 不做全隐藏 —— 隐藏窗的截图 / 点击实测不挂,但几十个台架断言 isVisible(),藏起来就得伪造可见性。 */
const QUIET_WINDOWS = process.env.TANGU_HARNESS_QUIET
  ? process.env.TANGU_HARNESS_QUIET === '1'
  : typeof (globalThis as { __playwright_run?: unknown }).__playwright_run === 'function'

// 台架跳过 macOS「重新打开窗口」询问:台架与 dev 共用 com.github.Electron,它崩过后 AppKit 在 -[NSApplication run] →
// _handleAEOpenEvent 里弹 NSAlert 模态框,ready 永不来 → 台架零输出挂死(09-27 多会话同时中招)。注册域只在内存、不落盘;
// AppKit 在主脚本同步段之后才读这个键(09-28 注入探针实证,仪器 npm run check:persistignore)。
if (QUIET_WINDOWS && process.platform === 'darwin') systemPreferences.registerDefaults({ ApplePersistenceIgnoreState: true })

function present(win: BrowserWindow): void {
  if (QUIET_WINDOWS) win.showInactive()
  else { win.show(); win.focus() }
}

/** 台架的大窗(主窗 / 独立窗)压到所有普通窗口之下(macOS 窗口层级 -1)。showInactive 只是不抢键盘焦点,
 *  窗口照样盖在用户正在用的 App 上面;压下去之后它仍然可见,isVisible / 截图 / 点击 / 动画帧照常
 *  (仪器 npm run check:quietfocus 读系统窗口列表里的层级)。子窗(浮动面板)跟随父窗;Mini / App Dock /
 *  权限引导这些本来就要浮在别的 App 上的小窗不压。层级名只在 macOS 有意义,Windows 上传 true 就是置顶,所以只管 darwin。 */
function sinkForHarness(win: BrowserWindow): void {
  if (QUIET_WINDOWS && process.platform === 'darwin') win.setAlwaysOnTop(true, 'normal', -1)
}

function satelliteWebPreferences(): Electron.WebPreferences {
  return {
    preload: join(__dirname, '../preload/preload.mjs'),
    contextIsolation: true,
    nodeIntegration: false,
    // sandbox:true 不支持 ESM preload(electron-vite 产出 .mjs);renderer 无 Node 能力,暴露面仅 contextBridge 最小 API。
    sandbox: false,
    plugins: true, // Chromium 内置 PDFium(blob pdf 预览)
    webviewTag: true, // 内置浏览器(builtin:browser)用 <webview>;guest 的 preload/nodeIntegration 在 will-attach-webview 里强制剥掉
  }
}

/** 子窗口打开处理:http(s) 回投渲染层(它决定进内置浏览器还是系统浏览器),其余一律拒绝(不产生游离子窗口)。
 *  回投而非主进程直接判:内置浏览器的开关/设置都住渲染层 localStorage,主进程不复制一份真源。
 *  渲染层的 openUrlRouter 在**每种窗口**(主/独立/mini)都装,没有内置浏览器的窗口自己转 openExternal。
 *  fromGuest = 这次是内置浏览器里的页面(<webview> guest)自己开的新窗口:带给渲染层,它据此把新窗口留在
 *  内置浏览器里、不看「应用内链接」开关 —— 远程设备页的附件、网页应用的登录跳转都靠这个分区里的凭据 /
 *  会话,交给系统浏览器就是 401(该开关 2026-10-05 起缺省关,不带这个标记等于缺省全坏)。 */
function openUrlHandler(wc: Electron.WebContents, fromGuest = false) {
  return ({ url }: { url: string }): { action: 'deny' } => {
    if (isHttpUrl(url)) {
      if (!wc.isDestroyed()) wc.send('app:open-url', url, fromGuest)
      else shell.openExternal(url)
    }
    return { action: 'deny' }
  }
}

/** http(s) 判定:交给 URL 解析,不用正则(畸形串按正则可能误判)。 */
export function isHttpUrl(url: unknown): boolean {
  if (typeof url !== 'string') return false
  try {
    const p = new URL(url).protocol
    return p === 'http:' || p === 'https:'
  } catch { return false }
}

/** IPC 可信来源:必须是我们自己开的窗口的**顶层** WebContents。
 *  webview guest / 子 frame / 已销毁的 sender 一律拒 —— 否则一旦 renderer 逃逸,
 *  `pty:spawn` 就是白送一个登录 shell(Electron 安全须知 #17:校验每条 IPC 的 sender)。 */
/** 屏幕共享的**预选源**:webContents.id → { 源 id, 存入时刻 }。渲染层选完先存这儿,
 *  setDisplayMediaRequestHandler 取用即删(见 app.whenReady 里那段)。按 wc 分桶,
 *  免得 mini 窗与主窗互相顶掉对方的选择。
 *  ⚠️ 两条清理都必要:①「选了源但没调 getDisplayMedia 就关窗」会永久留条目,而 webContents.id
 *  是**会被复用**的 —— 新窗口可能捡到上一个窗口的预选(共享出用户没选的屏幕);② 超时作废,
 *  预选只在「选完立刻调用」这一瞬有意义,留久了同样是给复用留口子。 */
const SHARE_PRESELECT_TTL_MS = 60_000
const pendingShareSource = new Map<number, { id: string; at: number }>()

export function isTrustedSender(e: { sender: Electron.WebContents; senderFrame?: Electron.WebFrameMain | null }): boolean {
  const wc = e.sender
  if (!wc || wc.isDestroyed()) return false
  if (wc.getType() === 'webview') return false
  if (!BrowserWindow.fromWebContents(wc)) return false // 只认真实窗口的顶层 contents
  const frame = e.senderFrame
  if (frame && frame !== wc.mainFrame) return false // 子 frame 不算
  return true
}

/** 拖入 OS 文件的默认导航会把 SPA 冲掉;SPA 自身从不整页导航到 file:,一律拦下
 *  (渲染层 fileDropGuard 已兜底,这里主进程各窗再加一道)。 */
function hardenNav(wc: Electron.WebContents): void {
  wc.on('will-navigate', (e, url) => {
    if (url.startsWith('file:')) e.preventDefault()
    // 外站 http(s) 也一律拦下并改走外链路由。SPA 自己从不整页导航到别的源,能走到这儿的
    // 只有「渲染出来的 <a href> 被点了」——markdown 里随便一条链接(聊天回复、远端拉来的
    // 更新说明)就能把整个应用页面替换成第三方网页,而那个 BrowserWindow 上挂着 preload。
    else if (/^https?:/i.test(url) && new URL(url).origin !== new URL(wc.getURL() || 'about:blank').origin) {
      e.preventDefault()
      if (!wc.isDestroyed()) wc.send('app:open-url', url)
    }
  })
}

// 内置浏览器 <webview> 的安全边界:guest 装的是**任意第三方网页**,不是我们的代码。
//  - will-attach-webview:强制剥掉 preload / nodeIntegration / 套娃 webviewTag —— 渲染层就算写错
//    属性也拿不到 window.tangu(否则等于把 PTY/文件读写送给任意站点);
//  - did-attach-webview:站点里的 target=_blank 回投**宿主**渲染层(带 fromGuest)→ 开成新的内置浏览器标签,不产生游离窗。
// guest 不套 hardenNav:本地 .html 预览要允许 file: 内的相对跳转。
app.on('web-contents-created', (_e, contents) => {
  contents.on('will-attach-webview', (_ev, webPreferences, params) => {
    // 全部写死,不是「删掉危险的」——渲染层能塞进来的键太多(sandbox/webSecurity/…),
    // 白名单式覆写才封得住;partition 也钉死,否则空 partition 会落回权限全放行的 defaultSession。
    delete webPreferences.preload
    webPreferences.nodeIntegration = false
    webPreferences.nodeIntegrationInSubFrames = false
    webPreferences.nodeIntegrationInWorker = false
    webPreferences.contextIsolation = true
    webPreferences.sandbox = true
    webPreferences.webSecurity = true
    webPreferences.allowRunningInsecureContent = false
    webPreferences.experimentalFeatures = false
    webPreferences.webviewTag = false
    ;(webPreferences as Record<string, unknown>).allowFileAccessFromFiles = false // 本地 .html 不许读同盘其它文件
    webPreferences.partition = BROWSER_PARTITION
    params.partition = BROWSER_PARTITION
    delete params.nodeintegration
    delete params.nodeintegrationinsubframes
    delete params.disablewebsecurity
    delete params.webpreferences
  })
  contents.on('did-attach-webview', (_ev, guest) => {
    guest.setWindowOpenHandler(openUrlHandler(contents, true))
  })
})

function createWindow(): void {
  // Windows/Linux 默认会渲染 File/Edit/View/Window 菜单条;macOS 菜单在系统栏(不在窗口内)。
  // 置空菜单让 Windows/Linux 与 macOS 观感一致(无窗口内菜单条);文本框的复制/粘贴等由 Chromium 原生处理,不依赖菜单。
  if (process.platform !== 'darwin') Menu.setApplicationMenu(null)

  mainWindow = new BrowserWindow({
    width: 1200,
    height: 820,
    minWidth: 880,
    minHeight: 600,
    // hiddenInset 是 macOS 专用(交通灯内嵌、无原生标题栏);Windows/Linux 用 default 保留原生
    // 最小化/最大化/关闭按钮,否则该值被忽略可能导致无窗口控件。菜单条另由 setApplicationMenu(null) 去除。
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    autoHideMenuBar: true, // 即便保留了菜单也不在窗口内显示(Alt 不唤出);与置空菜单双保险
    // macOS 系统玻璃必须在建窗时具备透明能力;是否真的启用 vibrancy 由当前主题经 IPC 动态决定。
    // 其他平台保持原来的实色窗口,不改变稳定性/窗口行为。
    transparent: process.platform === 'darwin',
    backgroundColor: process.platform === 'darwin' ? '#00000000' : '#fbf8f5',
    // Let the early HTML paint the saved light/dark splash before showing the native window.
    show: false,
    webPreferences: satelliteWebPreferences(),
  })
  sinkForHarness(mainWindow)
  mainWindow.once('ready-to-show', () => { if (mainWindow && !mainWindow.isDestroyed()) present(mainWindow) })

  mainWindow.webContents.setWindowOpenHandler(openUrlHandler(mainWindow.webContents))
  hardenNav(mainWindow.webContents)
  // deep link 推送门:reload(Cmd+R)换掉渲染层监听者但 webContents 不变 → 每次开载都翻回「未就绪」,
  // 等新一代渲染层来 drain(否则 push 进虚空,URL 丢失)。
  mainWindow.webContents.on('did-start-loading', () => {
    deepLinkReady = false; mainPanelReady = false
    miniSession = { sessionId: null, runId: null }; miniAutoPanel?.refresh()
  })
  // 主进程文案(托盘 / 对话框 / 通知,mainI18n)跟随界面语言:由渲染层挂载时与每次切换经 ui:locale 报上来的**生效**语言喂入
  // (P1-KF,见 uiLocaleSync.ts)。这里刻意不再读 localStorage `tangu_locale`:那是「手选」键,② 系统 / ③ IP 判出的语言不写它,
  // 读到 null 还会把渲染层已报上来的语言重置回系统。

  // 崩溃自愈:渲染进程被 OOM / GPU 崩溃杀死时,窗口只剩一张白页且不会自己恢复(React ErrorBoundary
  // 只接 JS 渲染异常,接不到进程级死亡)。这里监听进程死亡 + 无响应 + 加载失败,自动 reload 兜底。
  mainWindow.webContents.on('render-process-gone', (_e, d) => {
    if (d.reason !== 'clean-exit') recoverRenderer(`render-process-gone:${d.reason}`)
  })
  mainWindow.webContents.on('unresponsive', () => recoverRenderer('unresponsive'))
  mainWindow.webContents.on('did-fail-load', (_e, code, desc, _url, isMainFrame) => {
    if (isMainFrame && code !== -3) recoverRenderer(`did-fail-load:${code} ${desc}`) // -3=ERR_ABORTED(外链 deny),忽略
  })

  // 关闭窗口 = 最小化到托盘(App 常驻后台,后端/Muse 不中断);真正退出走托盘「退出」/before-quit(置 isQuitting)。
  mainWindow.on('close', (e) => {
    if (isQuitting) return
    e.preventDefault()
    mainWindow?.hide()
  })

  loadRenderer(mainWindow)
}

function loadRenderer(win: BrowserWindow): void {
  if (process.env.ELECTRON_RENDERER_URL) win.loadURL(process.env.ELECTRON_RENDERER_URL)
  else win.loadFile(join(__dirname, '../renderer/index.html'))
}

/** 载入同一渲染包但带 URL 参数(?window=…&id=…&ui=…):卫星窗口据此分流(见 frontend/windowKind)。 */
function loadRendererWith(win: BrowserWindow, params: Record<string, string>): void {
  if (process.env.ELECTRON_RENDERER_URL) {
    const u = new URL(process.env.ELECTRON_RENDERER_URL)
    u.search = new URLSearchParams(params).toString()
    void win.loadURL(u.toString())
  } else {
    void win.loadFile(join(__dirname, '../renderer/index.html'), { query: params })
  }
}

/** 召回主窗:隐藏则显示、最小化则还原、销毁则重建。托盘/通知/单实例/activate 共用。 */
function showMainWindow(): void {
  if (!mainWindow || mainWindow.isDestroyed()) { createWindow(); return }
  if (mainWindow.isMinimized()) mainWindow.restore()
  present(mainWindow)
}

// ══ 卫星窗口:独立窗(拖出的 dockview,无 ribbon)+ mini 悬浮卡片 + floating 面板 ════════
interface ViewDesc { type: string; params?: Record<string, unknown> }

const detachedWindows = new Map<string, BrowserWindow>()
const readyDetachedWindows = new WeakSet<BrowserWindow>()
const pendingDetachedViews = new Map<string, ViewDesc[]>() // 拖出登记的初始视图,渲染端 detachedReady 时 pull
let persistedDetached: Array<{ id: string; bounds: Electron.Rectangle; space?: string }> = [] // 内存副本 + 落盘(重启恢复);space = 这扇是哪个 Space 的窗口
let detachedStateLoaded = false
let detachedSeq = 0

const detachedStatePath = (): string => join(app.getPath('userData'), 'detached-windows.json')

async function loadDetachedState(): Promise<void> {
  try {
    const arr = JSON.parse(await readFile(detachedStatePath(), 'utf8'))
    if (Array.isArray(arr)) persistedDetached = arr.filter((x) => x && typeof x.id === 'string' && x.bounds)
  } catch { persistedDetached = [] }
  detachedStateLoaded = true
}
let saveDetachedTimer: NodeJS.Timeout | null = null
function saveDetachedState(): void {
  if (saveDetachedTimer) clearTimeout(saveDetachedTimer)
  saveDetachedTimer = null
  if (!detachedStateLoaded) return // Quitting before startup reads the file must not erase the previous windows.
  // This small window-state file must finish before app.exit, including a quit inside the debounce interval.
  const file = detachedStatePath(), tmp = `${file}.${process.pid}.tmp`
  try {
    writeFileSync(tmp, JSON.stringify(persistedDetached), { encoding: 'utf8', mode: 0o600 })
    renameSync(tmp, file)
  } catch (error) {
    try { rmSync(tmp, { force: true }) } catch { /* best effort */ }
    console.error('[win] could not save detached window state:', error)
  }
}
function scheduleSaveDetachedState(): void {
  if (saveDetachedTimer) clearTimeout(saveDetachedTimer)
  saveDetachedTimer = setTimeout(saveDetachedState, 400)
}
function upsertDetachedBounds(id: string, bounds: Electron.Rectangle, space?: string): void {
  const i = persistedDetached.findIndex((x) => x.id === id)
  if (i >= 0) persistedDetached[i].bounds = bounds
  else persistedDetached.push({ id, bounds, ...(space ? { space } : {}) })
  scheduleSaveDetachedState()
}
function removeDetachedState(id: string): void {
  persistedDetached = persistedDetached.filter((x) => x.id !== id)
  scheduleSaveDetachedState()
}

function nextDetachedId(): string { detachedSeq += 1; return `d${Date.now().toString(36)}_${detachedSeq}` }

/** Space id 的形状(同 shared/spaceAppearance 的 ID):进 URL 参数与布局键之前先过一遍。 */
const SPACE_ID = /^[A-Za-z0-9._-]{1,128}$/

/** space = 把整个 Space 开在这扇窗里(渲染层据 ?space= 进入该 Space 并锁在里面)。一个 Space 一扇:id 由 Space id 定,
 *  已开着就叫到前面;布局键跟着 id 走,所以关了再开还是这扇窗上次的样子。 */
function createDetachedWindow(opts: { id?: string; views?: ViewDesc[]; bounds?: Partial<Electron.Rectangle>; space?: string }): string {
  const space = opts.space
  const id = opts.id || (space ? `sp_${space}` : nextDetachedId())
  const open = detachedWindows.get(id)
  if (open && !open.isDestroyed()) {
    if (open.isMinimized()) open.restore()
    if (readyDetachedWindows.has(open)) present(open)
    return id
  }
  if (opts.views?.length) pendingDetachedViews.set(id, opts.views)
  const win = new BrowserWindow({
    width: opts.bounds?.width ?? (space ? 1100 : 900),
    height: opts.bounds?.height ?? (space ? 760 : 680),
    x: opts.bounds?.x,
    y: opts.bounds?.y,
    minWidth: 480,
    minHeight: 360,
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    autoHideMenuBar: true,
    transparent: process.platform === 'darwin',
    backgroundColor: process.platform === 'darwin' ? '#00000000' : '#fbf8f5',
    show: false,
    webPreferences: satelliteWebPreferences(),
  })
  sinkForHarness(win)
  win.once('ready-to-show', () => {
    if (win.isDestroyed()) return
    if (process.platform === 'win32' && opts.bounds) {
      // Windows can add fractional-DPI frame rounding during construction. Reapply the saved outer bounds
      // after the native frame exists, correcting the measured residual so repeated restores cannot grow it.
      const target = { ...win.getBounds(), ...opts.bounds }
      target.width = Math.max(480, target.width)
      target.height = Math.max(360, target.height)
      const requested = { ...target }
      for (let attempt = 0; attempt < 3; attempt++) {
        win.setBounds(requested)
        const actual = win.getBounds()
        if (actual.width === target.width && actual.height === target.height) break
        requested.width = Math.max(480, requested.width + target.width - actual.width)
        requested.height = Math.max(360, requested.height + target.height - actual.height)
      }
    }
    readyDetachedWindows.add(win)
    present(win)
  })
  detachedWindows.set(id, win)
  win.webContents.setWindowOpenHandler(openUrlHandler(win.webContents))
  hardenNav(win.webContents)
  let closing = false
  const persist = (): void => { if (!closing && !win.isDestroyed()) upsertDetachedBounds(id, win.getBounds()) }
  // move/resize cover programmatic bounds changes too; Windows resized fires only for a manual resize.
  win.on('move', persist)
  win.on('resize', persist)
  win.on('close', () => {
    closing = true
    if (!isQuitting) removeDetachedState(id) // Record the close intent before a subsequent app quit.
  })
  win.on('closed', () => {
    console.log('[win] detached closed', id)
    detachedWindows.delete(id)
    pendingDetachedViews.delete(id)
    if (!isQuitting) removeDetachedState(id) // Also handles webContents being closed directly by a harness.
  })
  upsertDetachedBounds(id, win.getBounds(), space) // 立即登记(拖出后崩溃也能恢复)
  console.log('[win] detached open', id, space ? `space=${space}` : `views=${opts.views?.map((v) => v.type).join(',')}`)
  loadRendererWith(win, { window: 'detached', id, ui: 'desktop', ...(space ? { space } : {}) })
  return id
}

async function restoreDetachedWindows(): Promise<void> {
  await loadDetachedState()
  for (const { id, bounds, space } of [...persistedDetached]) {
    createDetachedWindow({ id, bounds, space: typeof space === 'string' && SPACE_ID.test(space) ? space : undefined })
  }
}

const floatingWindows = new Map<string, BrowserWindow>()
const floatingTargets = new Map<string, FloatingPanelOpenOptions>()
const readyFloating = new WeakSet<BrowserWindow>()

/** 会话级面板(旁聊 btw,target.sessionId)只在主窗当前会话 = 它的归属会话时露面;普通面板恒为 true。 */
function inSessionScope(id: string): boolean {
  const owner = floatingTargets.get(id)?.sessionId
  return !owner || owner === miniSession.sessionId
}

/** 主窗换会话 → 会话级面板跟着显隐。隐藏不销毁:切回来原样还在(旁聊线程住在面板自己的渲染进程里)。
 *  showInactive:焦点留在刚点了会话的主窗。没到 ready-to-show 的窗不碰(提前 show 会闪一块白)。
 *  会话级面板不给最小化(见 openFloatingPanel):进了 Dock 的窗在别的会话里也点得出来(Codex 评审 P2),
 *  而 macOS 上被 hide() 的最小化窗 isMinimized 仍为真、Dock 状态又读不到 —— 与其补一条观测不到的路径,不如不让它进 Dock。 */
function syncSessionPanels(): void {
  for (const [id, win] of floatingWindows) {
    if (win.isDestroyed() || !floatingTargets.get(id)?.sessionId || !readyFloating.has(win)) continue
    if (inSessionScope(id)) { if (!win.isVisible()) win.showInactive() }
    else if (win.isVisible()) win.hide()
  }
}

/** Floating Panel is a normal child window: movable/minimizable/closable, but kept above its main window. */
function openFloatingPanel(raw: unknown): { id: string } | undefined {
  const target = normalizeFloatingPanelOpenOptions(raw)
  if (!target) return undefined
  // 已绑会话的面板被卫星窗(独立窗 / Mini,不带归属)再次打开:保留原归属,否则它从此不再跟着主窗会话显隐
  const prev = floatingTargets.get(target.id)
  if (prev?.sessionId && !target.sessionId) target.sessionId = prev.sessionId
  floatingTargets.set(target.id, target)
  const existing = floatingWindows.get(target.id)
  if (existing && !existing.isDestroyed()) {
    existing.setTitle(target.title)
    existing.setMinimizable(!target.sessionId) // 先以普通面板开过、后被主窗绑上会话的,也收回最小化
    if (existing.isMinimized()) existing.restore()
    present(existing)
    // 还在载入:渲染层可能已经 floatingReady 拿走了上一份 target,这份得等载入完补发(发最新的;同一份重复到达不会重挂 —— 面板按 params 做 key,设置的带落点请求靠 params.nonce 区分先后)
    const deliver = (): void => { if (!existing.isDestroyed()) existing.webContents.send('window:floatingTarget', floatingTargets.get(target.id) ?? target) }
    if (existing.webContents.isLoadingMainFrame()) existing.webContents.once('did-finish-load', deliver)
    else deliver()
    return { id: target.id }
  }
  const win = new BrowserWindow({
    parent: mainWindow && !mainWindow.isDestroyed() ? mainWindow : undefined,
    modal: false,
    show: false,
    width: target.width,
    height: target.height,
    minWidth: target.minWidth,
    minHeight: target.minHeight,
    title: target.title,
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    autoHideMenuBar: true,
    // 会话级面板(旁聊)不给最小化:收起 = 切走会话,关掉 = 清空;进了 Dock 就能在别的会话里被点出来
    minimizable: !target.sessionId,
    closable: true,
    resizable: true,
    transparent: process.platform === 'darwin',
    backgroundColor: process.platform === 'darwin' ? '#00000000' : '#fbf8f5',
    webPreferences: satelliteWebPreferences(),
  })
  floatingWindows.set(target.id, win)
  win.webContents.setWindowOpenHandler(openUrlHandler(win.webContents))
  hardenNav(win.webContents)
  win.once('ready-to-show', () => {
    if (win.isDestroyed()) return
    readyFloating.add(win)
    // 载入期间主窗已换会话:会话级面板先不露面,等主窗切回它的会话再由 syncSessionPanels 显示
    if (inSessionScope(target.id)) present(win)
  })
  win.on('closed', () => {
    if (floatingWindows.get(target.id) === win) floatingWindows.delete(target.id)
    floatingTargets.delete(target.id)
  })
  loadRendererWith(win, { window: 'floating', id: target.id, ui: 'desktop' })
  return { id: target.id }
}

let pendingMainPanelTarget: MainPanelTarget | null = null
let mainPanelReady = false

let miniWindow: BrowserWindow | null = null
let miniSession: MiniSessionContext = { sessionId: null, runId: null }
let miniAutoPanel: ReturnType<typeof startMiniAutoPanel> | null = null
/** 电脑历史控制器(只在带 agent 后端的形态建;见 electron/computerHistory.ts)。 */
let computerHistory: ComputerHistory | null = null
let autoMiniWindow: BrowserWindow | null = null
let autoMiniSessionId: string | null = null
/** 最后获焦的 Forsion 窗口(自动 Mini 除外);自动 Mini 开场时快照成 autoMiniReturnTo,本轮跑完还给用户。 */
let lastFocusedWindow: BrowserWindow | null = null
let autoMiniReturnTo: BrowserWindow | null = null
let stopMiniPassThrough: (() => void) | null = null
/** Mini 尚在载入时也保留最后一次定向,`did-finish-load` 后补发,避免快速连续打开丢第二个目标。 */
let miniTarget: MiniOpenOptions | undefined
/** 贴边吸附态:edge=贴哪条边,expanded=当前是否展开。null=未贴边(自由浮动)。 */
let miniDock: { edge: Edge; expanded: boolean } | null = null
let suppressMiniMoved = false // 抑制程序化 setBounds 触发的 moved(否则折叠/展开自激)
let miniDragging = false // 用户正在拖窗(moved 连发中);其间不吸附/不轮询,避免和拖拽对打(修「拖不出来」)
let miniSettleTimer: NodeJS.Timeout | null = null
let miniPollTimer: NodeJS.Timeout | null = null

const MINI_CARD_WIDTH = 320
const MINI_CARD_HEIGHT = 420
const MINI_PEEK = 14 // 折叠后露出可辨识的把手宽度,避免 8px 细线难发现
const MINI_TRIGGER_PAD = 6 // 悬停触发容差(薄条外扩,好点中)
const MINI_HYSTERESIS = 28 // 展开后离开迟滞(出界超此才折叠,修「一动就弹回」)

function closeAutoMini(restore = false): void {
  const win = autoMiniWindow, back = autoMiniReturnTo
  autoMiniWindow = null; autoMiniSessionId = null; autoMiniReturnTo = null
  if (win && !win.isDestroyed()) win.destroy()
  // Computer Use 跑完:回到开场时用户所在的 Forsion 窗口。期间被用户自己藏起来的不强拉。
  if (!restore || !back || back.isDestroyed() || !(back.isVisible() || back.isMinimized())) return
  if (back.isMinimized()) back.restore()
  if (!QUIET_WINDOWS) app.focus({ steal: true })
  present(back)
}

/** A temporary observer: parked top-right, owns no saved Mini layout, and opens without activating the app.
 * Focusable + acceptFirstMouse so the header drags on the first press; that click does activate Forsion,
 * but the card itself takes focus (not the main window), and hasForsionFocus ignores it. */
function openAutoMini(sessionId: string): void {
  closeAutoMini()
  autoMiniSessionId = sessionId
  autoMiniReturnTo = lastFocusedWindow
  const size = { width: MINI_CARD_WIDTH, height: MINI_CARD_HEIGHT }
  const position = topRightPosition(size, screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).workArea)
  const win = new BrowserWindow({
    ...size, ...position, show: false, acceptFirstMouse: true,
    frame: false, transparent: true, resizable: false, alwaysOnTop: true,
    skipTaskbar: true, hasShadow: true, backgroundColor: '#00000000',
    webPreferences: satelliteWebPreferences(),
  })
  autoMiniWindow = win
  win.setAlwaysOnTop(true, 'floating')
  if (process.platform === 'darwin') win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true, skipTransformProcessType: true })
  win.webContents.setWindowOpenHandler(openUrlHandler(win.webContents))
  hardenNav(win.webContents)
  const stop = startMiniPassThrough(win, { active: () => true, cursor: () => screen.getCursorScreenPoint() })
  win.on('closed', () => {
    stop()
    if (autoMiniWindow === win) { autoMiniWindow = null; autoMiniSessionId = null; miniAutoPanel?.dismiss() }
  })
  loadRendererWith(win, { window: 'mini', transient: '1', sessionId })
}

function createMiniWindow(opts?: MiniOpenOptions): void {
  miniTarget = opts
  const width = MINI_CARD_WIDTH
  const height = MINI_CARD_HEIGHT
  const wa = screen.getPrimaryDisplay().workArea
  miniWindow = new BrowserWindow({
    width, height,
    x: wa.x + wa.width - width - 24,
    y: wa.y + 24,
    minWidth: width, minHeight: height, maxWidth: width, maxHeight: height,
    frame: false,
    transparent: true,
    resizable: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    hasShadow: true,
    backgroundColor: '#00000000',
    show: !QUIET_WINDOWS,
    webPreferences: satelliteWebPreferences(),
  })
  if (QUIET_WINDOWS) miniWindow.showInactive()
  miniWindow.setAlwaysOnTop(true, 'floating')
  miniWindow.webContents.setWindowOpenHandler(openUrlHandler(miniWindow.webContents))
  hardenNav(miniWindow.webContents)
  miniWindow.webContents.on('did-finish-load', () => {
    if (miniTarget && miniWindow && !miniWindow.isDestroyed()) miniWindow.webContents.send('window:miniTarget', miniTarget)
  })
  stopMiniPassThrough = startMiniPassThrough(miniWindow, {
    active: () => miniAutoPanel?.following() ?? false,
    cursor: () => screen.getCursorScreenPoint(),
  })
  miniWindow.on('moved', onMiniMoved)
  miniWindow.on('closed', () => { console.log('[win] mini closed'); stopMiniPassThrough?.(); stopMiniPassThrough = null; miniWindow = null; miniTarget = undefined; miniDock = null; stopMiniPoll() })
  console.log('[win] mini open')
  loadRendererWith(miniWindow, { window: 'mini', ...(opts?.sessionId ? { sessionId: opts.sessionId } : {}) })
}

// ══ 侧边拼接(App Dock):对话面板贴在别的 App 窗口旁边,像一个窗口那样一起动(跟随见 electron/appDock.ts)══
// 面板本身是一扇 Mini 形态的窗口(?window=mini&dock=1):先列出屏上的窗口让用户挑,挑中后贴过去、里面开一段新对话,
// 默认引用这个 App。全程经 CU helper(本机辅助 App)看位置、挪窗口、读划线;只支持 macOS(Windows 的 helper 桌面够不着)。
let dockWindow: BrowserWindow | null = null
let dockTarget: DockWindow | null = null
let stopDockFollow: (() => void) | null = null
let dockLink: HelperLink | null = null
/** 每次贴 / 撤都 +1。attach 每个 await 之后核一次:连点两行、或贴到一半关了面板,旧的那次就地作废,不会留下第二个跟随器。 */
let dockGen = 0
/** 最近一次列给用户挑的窗口(pid:windowId)。attach 只认这里面的 —— dock 窗里也跑插件代码,不能让它绕过挑选,
 *  随手报一个 pid 就贴过去、再读那个 App 的选区。 */
let dockOffered = new Set<string>()

function dockState(): DockState { return { target: dockTarget } }
function sendDockState(): void {
  if (dockWindow && !dockWindow.isDestroyed()) dockWindow.webContents.send('appDock:state', dockState())
}
function detachDock(): void {
  dockGen++
  stopDockFollow?.(); stopDockFollow = null
  dockTarget = null
}

function openDockWindow(): void {
  if (dockWindow && !dockWindow.isDestroyed()) { present(dockWindow); return }
  const wa = screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).workArea
  const width = DOCK_PANEL_WIDTH, height = Math.min(640, wa.height - 48)
  const win = new BrowserWindow({
    width, height, x: Math.round(wa.x + (wa.width - width) / 2), y: Math.round(wa.y + (wa.height - height) / 2),
    minWidth: DOCK_PANEL_MIN_WIDTH, minHeight: DOCK_PANEL_MIN_HEIGHT,
    frame: false, transparent: true, resizable: true, hasShadow: true, skipTaskbar: true,
    minimizable: false, maximizable: false, fullscreenable: false,
    // 目标 App 在前台时第一下点面板就要能拖 / 能点进输入框(见 miniForeground 那轮实测)
    acceptFirstMouse: true,
    backgroundColor: '#00000000', show: !QUIET_WINDOWS,
    webPreferences: satelliteWebPreferences(),
  })
  dockWindow = win
  if (QUIET_WINDOWS) win.showInactive()
  win.webContents.setWindowOpenHandler(openUrlHandler(win.webContents))
  hardenNav(win.webContents)
  win.on('closed', () => {
    if (dockWindow !== win) return
    detachDock(); dockWindow = null
    dockLink?.close(); dockLink = null
  })
  console.log('[win] dock open')
  loadRendererWith(win, { window: 'mini', dock: '1' })
}

async function attachDock(target: DockWindow): Promise<{ ok: boolean; error?: string }> {
  const win = dockWindow
  if (!win || win.isDestroyed()) return { ok: false, error: 'closed' }
  detachDock()
  const gen = dockGen
  const superseded = (): boolean => gen !== dockGen || win.isDestroyed()
  dockLink ??= new HelperLink(helperSocketPath())
  const link = dockLink
  let probe = normalizeProbe(await link.request({ cmd: 'dockProbe', windowId: target.windowId }).catch(() => null))
  if (superseded()) return { ok: false, error: 'superseded' }
  if (!probe.exists) return { ok: false, error: 'window_gone' }
  const panelWidth = Math.max(DOCK_PANEL_MIN_WIDTH, win.getBounds().width)
  const wa = screen.getDisplayMatching(probe.rect).workArea
  const side = chooseSide(probe.rect, panelWidth, wa)
  const room = makeRoom(probe.rect, panelWidth, wa)
  if (room && side === 'right') {
    await link.request({ cmd: 'setWindowFrame', pid: target.pid, windowId: target.windowId, x: room.x, y: room.y, width: room.width, height: room.height }).catch(() => {})
    probe = normalizeProbe(await link.request({ cmd: 'dockProbe', windowId: target.windowId }).catch(() => null))
    if (superseded()) return { ok: false, error: 'superseded' }
  }
  win.setBounds(panelRectFor(probe.rect, side, panelWidth))
  dockTarget = target
  // 把这一对一起带到前面:目标拿前台(用户接着就要在里面干活),面板随后由跟随循环提上来。
  await link.request({ cmd: 'focusWindow', pid: target.pid, windowId: target.windowId }).catch(() => {})
  if (superseded()) return { ok: false, error: 'superseded' }
  stopDockFollow = startDockFollow({
    win, target, side,
    request: (payload) => link.request(payload),
    displayBoundsOf: (rect) => screen.getDisplayMatching(rect).bounds,
    onGone: () => { if (!win.isDestroyed()) win.close() }, // 目标关了:对话已在会话列表里,面板一并收起
    intervalMs: Number(process.env.DOCK_FOLLOW_MS) || undefined, // 只给台架负对照用(e2e:appdock --nc=nofollow)
  })
  sendDockState()
  return { ok: true }
}

function dockSender(e: Electron.IpcMainInvokeEvent): boolean {
  return isTrustedSender(e) && !!dockWindow && !dockWindow.isDestroyed() && e.sender === dockWindow.webContents
}

function toggleMiniWindow(opts?: MiniOpenOptions): void {
  if (!opts && autoMiniSessionId) opts = { sessionId: autoMiniSessionId }
  miniAutoPanel?.dismiss()
  if (miniWindow && !miniWindow.isDestroyed()) {
    // 带目标是「把这条正式会话拿到 Mini 继续」:已显示也只更新+聚焦,不能反而把窗口藏掉。
    if (opts?.sessionId || opts?.spaceId || opts?.view) {
      miniTarget = opts
      if (!miniWindow.webContents.isLoadingMainFrame()) miniWindow.webContents.send('window:miniTarget', opts)
      present(miniWindow)
    } else if (miniWindow.isVisible()) miniWindow.hide()
    else present(miniWindow)
  } else createMiniWindow(opts)
}

/** 设 bounds;mac 传 animate=true 走原生滑动动画(修「无动画」),win/linux 瞬时。程序化移动抑制 moved 自激。 */
function setMiniBounds(r: Rect, animate = true): void {
  if (!miniWindow || miniWindow.isDestroyed()) return
  suppressMiniMoved = true
  miniWindow.setBounds(r, animate && process.platform === 'darwin')
  setTimeout(() => { suppressMiniMoved = false }, animate && process.platform === 'darwin' ? 320 : 60)
}

// moved 连发 = 用户在拖窗;只在**停稳 200ms 后**才判贴边(拖拽过程中绝不折叠 → 能自由拖出)。
function onMiniMoved(): void {
  if (!miniWindow || suppressMiniMoved) return // 程序化移动不算用户拖拽
  miniDragging = true
  if (miniSettleTimer) clearTimeout(miniSettleTimer)
  miniSettleTimer = setTimeout(onMiniSettled, 200)
}

function onMiniSettled(): void {
  miniDragging = false
  if (!miniWindow || miniWindow.isDestroyed()) return
  const b = miniWindow.getBounds()
  const wa = screen.getDisplayMatching(b).workArea
  const edge = nearestEdge(b, wa)
  if (edge) {
    miniDock = { edge, expanded: false }
    setMiniBounds(collapsedBounds(b, edge, wa, MINI_PEEK)) // 停在边上 → 折叠(动画)
    ensureMiniPoll()
  } else {
    miniDock = null // 拖离边 → 解除吸附
    stopMiniPoll()
  }
}

// 贴边时轮询光标(替掉 frameless 透明窗上不可靠的 DOM mouseenter/leave):折叠态触到薄条→展开,展开态离开(超迟滞)→折叠。
function ensureMiniPoll(): void {
  if (miniPollTimer) return
  miniPollTimer = setInterval(pollMiniCursor, 90)
}
function stopMiniPoll(): void {
  if (miniPollTimer) { clearInterval(miniPollTimer); miniPollTimer = null }
}
function pollMiniCursor(): void {
  if (!miniWindow || miniWindow.isDestroyed() || !miniDock || miniDragging || suppressMiniMoved) return
  const pt = screen.getCursorScreenPoint()
  const b = miniWindow.getBounds()
  const wa = screen.getDisplayMatching(b).workArea
  if (!miniDock.expanded) {
    // 折叠:光标触到薄条(可见交集 + 容差)→ 展开
    if (pointInRect(pt.x, pt.y, growRect(visibleRect(b, wa), MINI_TRIGGER_PAD))) {
      miniDock.expanded = true
      setMiniBounds(expandedBounds(b, miniDock.edge, wa))
    }
  } else {
    // 展开:光标离开窗口 + 迟滞边距 → 折叠(小幅移动不触发,修「一动就弹回」)
    if (!pointInRect(pt.x, pt.y, growRect(b, MINI_HYSTERESIS))) {
      miniDock.expanded = false
      setMiniBounds(collapsedBounds(b, miniDock.edge, wa, MINI_PEEK))
    }
  }
}

/** 可作跨窗拖拽落点的 dockview 窗口(主窗 + 独立窗;mini 卡片不是 dockview,排除)。 */
function dockviewWindows(): BrowserWindow[] {
  return [mainWindow, ...detachedWindows.values()].filter((w): w is BrowserWindow => !!w && !w.isDestroyed())
}
/** 屏幕点(screenX,screenY)命中哪个 dockview 窗口(排除 exclude=源窗);无则 null。z 序未细分,重叠取首个。 */
function windowAtPoint(x: number, y: number, exclude?: BrowserWindow | null): BrowserWindow | null {
  for (const w of dockviewWindows()) {
    if (w === exclude || !w.isVisible()) continue
    const b = w.getBounds()
    if (x >= b.x && x < b.x + b.width && y >= b.y && y < b.y + b.height) return w
  }
  return null
}
/** 给所有 dockview 窗口清除跨窗落点预览。 */
function clearAllDragPreview(): void {
  for (const w of dockviewWindows()) w.webContents.send('window:dragPreview', null)
}

// 60s 内崩溃≥3 次则熔断(避免崩溃-重载风暴),弹框让用户决定重载或退出。
let reloadTimestamps: number[] = []
function recoverRenderer(reason: string): void {
  console.error('[tangu-desktop] renderer recover, reason=', reason)
  if (!mainWindow || mainWindow.isDestroyed()) { createWindow(); return }
  const now = Date.now()
  reloadTimestamps = reloadTimestamps.filter((t) => now - t < 60_000)
  if (reloadTimestamps.length >= 3) {
    dialog
      .showMessageBox(mainWindow, {
        type: 'error',
        buttons: [mt('main.crash.reload'), mt('main.crash.quit')],
        defaultId: 0,
        message: mt('main.crash.message'),
        detail: mt('main.crash.detail', { reason }),
      })
      .then((r) => {
        if (r.response === 0 && mainWindow && !mainWindow.isDestroyed()) { reloadTimestamps = []; loadRenderer(mainWindow) }
        else app.quit()
      })
    return
  }
  reloadTimestamps.push(now)
  loadRenderer(mainWindow)
}

// GPU 硬化(必须在 app ready 前设):Windows 上 GPU 进程崩溃不要触发整体白屏;
// TANGU_DISABLE_GPU=1 是逃生阀,驱动有问题的机器可彻底关硬件加速(默认不关,避免牺牲所有人性能)。
if (process.platform === 'win32') app.commandLine.appendSwitch('disable-gpu-process-crash-limit')
if (process.env.TANGU_DISABLE_GPU === '1') app.disableHardwareAcceleration()

// 滚动条悬浮不占位 + 静止后自动隐去。
// Win/Linux 的 Aura 滚动条默认经典、恒占 15px,只能靠 feature 开成 overlay。
// 两个名字都传:Chromium 换过一轮命名(OverlayScrollbar → FluentOverlayScrollbar),不认识的会被忽略。
if (process.platform !== 'darwin') {
  app.commandLine.appendSwitch('enable-features', 'FluentOverlayScrollbar,OverlayScrollbar')
} else {
  // ⚠️ 2026-08-14 更正:原先写「mac 不用管,默认就是 overlay」是错的 —— 系统「显示滚动条」缺省值是
  // **自动**,而自动的语义是「触控板→overlay,接了鼠标→经典」。插着鼠标时 AppKit 给的是
  // NSScrollerStyleLegacy,Chromium 照单全收:恒占 15px 且**永不隐去**(用户实报「静止后不渐隐」,
  // check:scrollbar 实测 gutter=15px)。页面 CSS 覆盖不了,自绘滚动条又必然占位(那是上一轮被否的方案)。
  // 出路:AppleShowScrollBars 是**逐 app 生效**的 —— 只往本 app 自己的域里写,不动全局,别的 app 不受影响。
  try {
    // 用户在全局显式选了「总是显示」的,多半是无障碍需要,不许替他改回去 → 撤掉本 app 的覆盖。
    // ⚠️ 必须走子进程读全局:本 app 域一旦写过,systemPreferences.getUserDefault 读到的就是自己写的那份。
    const g = execFileSync('defaults', ['read', '-g', 'AppleShowScrollBars'], { encoding: 'utf8' }).trim()
    if (g === 'Always') systemPreferences.removeUserDefault('AppleShowScrollBars')
    else systemPreferences.setUserDefault('AppleShowScrollBars', 'string', 'WhenScrolling')
  } catch {
    // 全局没设过(缺省=自动)时 `defaults read` 直接非零退出 —— 这恰恰是要修的那种情况。
    systemPreferences.setUserDefault('AppleShowScrollBars', 'string', 'WhenScrolling')
  }
}

// Amadeus Space:amadeus-asset:// 自定义协议须在 app ready 前登记为 privileged。
registerAmadeusAssetSchemes()

const marketBase = async (): Promise<string> => {
  const stored = await loadConfig()
  const creds = loadTanguCreds()
  const base = (stored.cloudUrl || creds.cloudUrl || '').replace(/\/+$/, '')
  if (!base) throw new Error('未配置 Forsion 云端地址')
  return base
}
const MARKET_UA = 'Forsion-Tangu'

async function downloadMarketPackage(id: string, report: (phase: 'resolve' | 'download' | 'install', progress?: DownloadProgress) => void = () => {}): Promise<{ info: { type: string; installSlug: string; downloadUrl: string; source: string } & NpmInstallSnapshot; buf: Buffer }> {
  const base = await marketBase()
  // 服务端解析 github 源时要问 api.github.com(服务端在大陆,也会慢);没有超时 = 按钮一直转。
  // 错误消息只放语言中立的原因码(`resolve: …`),界面层自己套中英文案(frontend/src/services/marketService.ts 的 unwrapIpcError)。
  const infoRes = await fetch(`${base}/api/market/items/${encodeURIComponent(id)}/install`, { headers: { 'User-Agent': MARKET_UA }, signal: AbortSignal.timeout(30_000) })
    .catch((err: any) => { throw new Error(`resolve: ${err?.name === 'TimeoutError' ? 'timeout' : err?.cause?.code || err?.message || err}`) })
  if (!infoRes.ok) throw new Error(`resolve: HTTP ${infoRes.status}`)
  const info = (await infoRes.json()) as { type: string; installSlug: string; downloadUrl: string; source: string } & NpmInstallSnapshot
  if (!MARKET_SUBDIR[info.type] || !isSafeSlug(info.installSlug)) throw new Error('resolve: invalid target')
  // github 源走 net.fetch(认系统代理);开了「中国大陆镜像」才加第三方代理站(见 downloadCandidates 的 ⚠️)。
  // zip 源(Forsion 对象存储)一直能通,照旧 Node fetch 单发 —— 不让一个失效的系统代理设置拖累它。
  const stored = await loadConfig()
  const github = info.source === 'github'
  const npm = info.source === 'npm'
  const candidates = npm ? npmDownloadCandidates(info, stored.mirror) : github ? downloadCandidates(info.downloadUrl, stored.mirror, process.env.TANGU_GITHUB_PROXY || '') : [info.downloadUrl]
  const archive = await downloadZip(candidates, (u, init) => github || u.startsWith(NPM_OFFICIAL) ? net.fetch(u, init) : fetch(u, init), (p) => report('download', p), npm ? GZIP_MAGIC : ZIP_MAGIC)
  const buf = npm ? await npmTarballToZip(archive, info, info.type) : archive
  return { info, buf }
}

app.whenReady().then(async () => {
  await registerStartupAppearance(isTrustedSender)
  const desktopPermissions = registerDesktopPermissions({
    isTrustedSender, computerUseAvailable: PRODUCT.agentBackend, returnToApp: showMainWindow,
    // 电脑历史开着时,运行中的 helper 协议太老也判「需要更新」→ 权限卡的「更新并重启助手」把老进程换掉
    requiredHelperProtocol: () => computerHistory?.requiredHelperProtocol(),
  })
  // 电脑历史:IPC 先登记(设置页随时会问,handler 里等 ready),配置读完再 start(见下方活动日志那段)。
  // 读者是 agent 工具 / Muse,没有 agent 后端的产品形态不建(preload 同步收掉 window.tangu.computerHistory)。
  if (PRODUCT.agentBackend) {
    const socketPath = helperSocketPath()
    const chRoot = join(forsionHomeDir(), 'computer-history')
    computerHistory = new ComputerHistory({
      root: chRoot,
      platform: process.platform,
      socketPath,
      externalSocket: socketPath !== helperSocketPath({}),
      helperAppPath: () => permissionHelperAppPath(),
      // Windows:CU 包里的 windows-bridge.exe 拷成 %LOCALAPPDATA% 下的私有副本再以常驻服务跑(绝不原地跑,见 computerHistoryWin.ts)
      windowsRecorder: process.platform === 'win32' ? createWindowsRecorderResolver({
        binDir: recorderBinDir(),
        source: () => windowsRecorderSource({
          isPackaged: app.isPackaged, appPath: app.getAppPath(), resourcesPath: process.resourcesPath, pluginsRoot: join(forsionHomeDir(), 'plugins'),
        }),
      }) : undefined,
      // 权限页关停 / 重装 helper 期间不拉起(会拉起旧包);忙完立刻重连
      helperBusy: () => desktopPermissions.helperBusy(),
      onHelperIdle: (cb) => desktopPermissions.onHelperIdle(cb),
      selfBundleId: readSelfBundleId(process.execPath),
      persist: (patch) => saveConfig(patch),
      openFolder: (dir) => shell.openPath(dir),
      onChanged: (view) => {
        for (const w of BrowserWindow.getAllWindows()) if (!w.isDestroyed() && !w.webContents.isDestroyed()) w.webContents.send('computerHistory:changed', view)
        refreshTrayMenu()
      },
    })
    registerComputerHistoryIpc(computerHistory, isTrustedSender)
  }
  // Windows 系统通知前提(无 AppUserModelId 时 Notification 可能不弹);mac/linux 无副作用。
  app.setAppUserModelId('com.forsion.tangu')
  // 媒体权限(麦克风,语音输入):Electron 层放行——部分平台/版本默认拒 getUserMedia。callback(true) 沿用
  // 「未设 handler=全放行」的既有默认,不回归其他权限(通知等)。macOS 仍受系统隐私设置门控(拒了要去设置改)。
  session.defaultSession.setPermissionRequestHandler((_wc, _permission, callback) => callback(true))
  session.defaultSession.setPermissionCheckHandler(() => true)
  // 屏幕共享:上面那条 permission handler **管不着** getDisplayMedia —— 它走的是另一条闸,
  // 没装 setDisplayMediaRequestHandler 时逐字报 `NotSupportedError: Not supported`(实测,check:rtc C6),
  // 界面上长得就是「点了共享没反应」。这里补上这条闸。
  //
  // 选源 UI **不焊进壳**:渲染层先 screenShareSources() 拿到带缩略图的源列表、自己画选择器,
  // 选定后 screenShareSelect(id) 存下预选,再调 getDisplayMedia —— 本 handler 只负责兑现那个预选。
  // 好处是不必主进程反向驱动渲染层弹窗(那样没人应答就永远挂着),也不必把选择器做进宿主 UI。
  // macOS 15+ 存在系统原生选择器:useSystemPicker 让系统接管,此时本 handler 根本不会被调用。
  //
  // ⚠️「拒绝」这条路 Electron **没有**干净出口:请求要了 video 而回调没给,它就同步抛
  // `TypeError: Video was requested, but no video stream was provided`。渲染层拿到的结果是对的
  // (AbortError),但这个异常会从 handler 冒出去变成主进程的 UnhandledPromiseRejection 噪音。
  // 所以拒绝必须包 try/catch —— 不是防御性编程,是这条 API 唯一的拒绝姿势。
  const denyShare = (callback: (s: Electron.Streams) => void): void => {
    try { callback({} as Electron.Streams) } catch { /* 见上:拒绝必抛,吞掉 */ }
  }
  session.defaultSession.setDisplayMediaRequestHandler(
    (request, callback) => {
      void (async () => {
        const wc = request.frame ? webContents.fromFrame(request.frame) : undefined
        // ⚠️ 必须确认请求来自该 WebContents 的**顶层** frame:预选是顶层(插件所在的主世界)存下的,
        // 不校验的话同一 WebContents 里的子 frame 能抢先消费掉它 —— 拿到用户为别处选的屏幕,
        // 而合法的那次请求反被拒。与 screenShare:select 的 isTrustedSender 同一口径。
        const fromTop = !!wc && !!request.frame && request.frame === wc.mainFrame
        const entry = wc && fromTop ? pendingShareSource.get(wc.id) : undefined
        // 预选是**一次性**的:用掉即弃,否则下一次共享会静默沿用上一次选的窗口。
        if (wc && fromTop) pendingShareSource.delete(wc.id)
        const wanted = entry && Date.now() - entry.at < SHARE_PRESELECT_TTL_MS ? entry.id : undefined
        if (!wanted) return denyShare(callback) // 没预选/已过期 → 渲染层拿到 AbortError,提示「请先选择共享内容」
        try {
          const sources = await desktopCapturer.getSources({ types: ['screen', 'window'] })
          const src = sources.find((x) => x.id === wanted)
          if (!src) return denyShare(callback) // 源已消失(窗口被关) → 同样按取消处理
          // loopback(带系统声音)只有 Windows 支持,别的平台传了会被拒。
          callback(process.platform === 'win32' ? { video: src, audio: 'loopback' } : { video: src })
        } catch {
          denyShare(callback)
        }
      })()
    },
    { useSystemPicker: true },
  )
  // 内置浏览器的 guest 走独立分区:上面那条「全放行」是为 App 自己的麦克风语音输入开的,
  // 任意第三方站点不该白拿麦克风/摄像头/定位/通知 —— 该分区**默认全拒**(且 cookie 与 App 隔离),
  // 只放行 GUEST_ALLOWED_PERMISSIONS(指针锁/全屏:必须有手势、Esc 可退、不泄露数据)。
  // ⚠️别改回无差别 callback(false):那样任何 3D/FPS/地图网页都会 `requestPointerLock` 报权限拒绝。
  try {
    const bs = session.fromPartition(BROWSER_PARTITION)
    const allow = (p: string): boolean => GUEST_ALLOWED_PERMISSIONS.includes(p)
    bs.setPermissionRequestHandler((_wc, permission, callback) => callback(allow(permission)))
    bs.setPermissionCheckHandler((_wc, permission) => allow(permission))
    bs.setDevicePermissionHandler(() => false) // HID/USB/串口不走上面那套权限检查,单独关
    // 下载:**必须放行**——网页的「导出/下载文件」就是这条路,`blob:` 更是根本交不给系统浏览器
    // (曾一律 preventDefault 转外部,等于把导出功能整个做废)。默认行为就是弹系统保存对话框:
    // 用户自己选落点 = 不会有静默落盘,也不用自造下载管理 UI。取消对话框 = 取消下载,无副作用。
    bs.on('will-download', (_e, item) => {
      item.setSaveDialogOptions({ defaultPath: join(app.getPath('downloads'), item.getFilename()) })
      item.once('done', (_ev, state) => {
        if (state !== 'completed') return
        try { new Notification({ title: item.getFilename(), body: mt('main.download.done') }).show() } catch { /* 通知不可用 */ }
      })
    })
    // 设备互联 T2(方案 §11.2):内置浏览器打开「经 server 隧道的设备页」时,webview 的文档与子资源
    // 请求无法自带 Bearer —— 在分区层对**当前云端的隧道前缀**注入 Authorization。绝不走 URL query
    // (隐私铁律);前缀随 effectiveConfig 刷新,其余站点请求原样放行。
    bs.webRequest.onBeforeSendHeaders((details, cb) => {
      const h = details.requestHeaders
      // ⚠️ BROWSER_PARTITION 同时承载内置浏览器的任意第三方页面——按 URL 前缀盲注 = 把凭据发给
      // 分区里所有人(第三方页 fetch/表单打这些前缀就白拿授权,CORS 拦不住请求本身;Codex H1)。
      // Fetch Metadata 收口:设备页自身的子资源/接口 = same-origin;app 发起的首层导航 = none;
      // 第三方页发起的一律 cross-site/same-site → 不注入。P2P 代理侧还有同规的 403 兜底。
      const sfs = String(h['Sec-Fetch-Site'] || h['sec-fetch-site'] || '')
      const trustedInitiator = !sfs || sfs === 'none' || sfs === 'same-origin'
      if (unitTunnelPrefix && details.url.startsWith(unitTunnelPrefix)) {
        const token = loadTanguCreds().token
        if (token && trustedInitiator) h.Authorization = `Bearer ${token}`
      } else if (trustedInitiator) {
        // P2P 本机代理(方案 §12):同机制注入 per-proxy 秘密 —— loopback 上别的进程没有它,
        // 打不动对端;表极小(同时开着的 P2P 设备数),线性查无所谓。
        for (const [prefix, secret] of p2pProxySecrets) {
          if (details.url.startsWith(prefix)) { h.Authorization = `Bearer ${secret}`; break }
        }
      }
      cb({ requestHeaders: h })
    })
  } catch (e) {
    console.error('[main] 内置浏览器分区权限策略注册失败:', e)
  }
  // 本机服务(ActivityWatch 等)通常不回 CORS 头——CSP connect-src 虽放行 localhost,浏览器 CORS 仍会
  // 挡死 renderer 直连(插件轮询/依赖应用 probe 全靠这条)。只补缺失的 ACAO,已有的不动(vite/引擎后端不受扰)。
  try {
    session.defaultSession.webRequest.onHeadersReceived(
      { urls: ['http://localhost:*/*', 'http://127.0.0.1:*/*'] },
      (details, cb) => {
        const h = details.responseHeaders || {}
        if (!Object.keys(h).some((k) => k.toLowerCase() === 'access-control-allow-origin')) {
          h['Access-Control-Allow-Origin'] = ['*']
        }
        cb({ responseHeaders: h })
      },
    )
  } catch (e) {
    console.error('[main] localhost CORS 补头注册失败(外置插件直连本机服务会被 CORS 挡):', e)
  }
  migrateForsionHome() // 品牌迁移 ~/.tangu→~/.forsion + ~/Tangu→~/Forsion(改名+兼容软链;最早期,先于一切读盘)
  migrateEngineData() // 两层布局:顶层引擎条目 → ~/.forsion/tangu/ + ~/.tangu 软链改指(dev 家同法;须在 backend spawn/读盘之前)
  await loadTanguEnvFile() // 先于一切 loadConfig(其 env 兜底读 TANGU_CLOUD_URL/TANGU_BACKEND_URL)
  await migrateCloudTokenToAuthJson() // config.json cloud.token(历史第二真源)并入 auth.json;须在首次 ensureBackend 前
  // P1-K5:主进程文案(mt)的系统语言来源(界面语言之后由渲染层经 ui:locale 报上来,P1-KF)。托盘、对话框都在这之后才建。
  initMainLocale({ systemLanguages: () => app.getPreferredSystemLanguages() })
  uiLocale.seed() // P1-KF:窗口载入前(托盘、启动期的通知 / 对话框)先用上次渲染层报来的界面语言;首次运行才回落系统语言
  // P1-K5:设备凭据(配对 / external token)迁出明文 shell 配置、进 safeStorage。必须是 configQueue 的第一个使用者:
  // loadConfig 要等它(external token 从这里解密),排在它前面的队列任务若调 loadConfig 就会互等。
  await deviceSecrets.init({ readShell: readShellConfig as () => Promise<Record<string, any>>, writeShell: (s) => writePrivateJson(configPath(), s), queue: configQueue })
  void remoteSessions.init() // P1-K4:迁移 / 读盘(isEnabled 依赖 K5 状态,须在它之后);K5 状态一变就重播视图
  deviceSecrets.onStatusChange(() => remoteSessions.notifyChanged())
  const marketPluginUpdater = createMarketPluginUpdater({
    home: forsionHomeDir(), appVersion: app.getVersion(),
    protectedIds: () => new Set([...builtinPluginIds(), ...BUILTIN_BUNDLES.map((x) => x.id)]),
    lookup: async (id) => {
      const base = await marketBase()
      const r = await fetch(`${base}/api/market/items/${encodeURIComponent(id)}`, { headers: { 'User-Agent': MARKET_UA }, signal: AbortSignal.timeout(30_000) })
      if (!r.ok) throw new Error(`resolve: HTTP ${r.status}`)
      return await r.json() as MarketUpdateItem
    },
    download: async (item) => {
      const { info, buf } = await downloadMarketPackage(item.id)
      if (info.installSlug !== item.installSlug || info.type !== item.type) throw new Error('resolve: market identity changed')
      return buf
    },
    broadcast: (status) => {
      for (const w of BrowserWindow.getAllWindows()) if (!w.isDestroyed()) w.webContents.send('market:updateStatus', status)
    },
  })
  if (PRODUCT.market) await marketPluginUpdater.init().catch((e) => console.warn('[market-updates] initialization failed:', e))
  await seedDefaultThemes(themesDir()) // 首次运行种入 soft 示例主题(themes/ 已存在则跳过;内部吞错不阻塞启动)
  // 内置插件捆绑包(电脑操作 / Forsion Extend)播种进 <home>/plugins/:须在 ensureBackend 之前 await 完 —— 引擎只在启动时扫一次
  // bundle 根;随包版本更新才替换,不降级;逐包吞错不阻塞启动(见 builtinPlugins.ts)。单品变体不捆内置包 → 不播。
  const bundleSources = builtinBundleSources({ isPackaged: app.isPackaged, resourcesPath: process.resourcesPath, appPath: app.getAppPath(), agentBackend: PRODUCT.agentBackend })
  // 云端账号面(个人中心 / 会员 / 额度 / 反馈 / cloud:fetch)住在 Forsion Extend 的主进程半身里(cloudHost.ts):播种后、开窗前
  // 验签装载;缺席 / 验签失败就没有这一面,preload 按 `cloud:present` 删键,渲染层门控自动隐藏。
  // 记下 Extend 实际注册的通道:preload 只保留有人接的桥键(账号面 / Connect 各自独立,Extend 版本与宿主接缝不同步时不会留下悬空键)。
  const cloudChannels = new Set<string>()
  // 账号编排(accountCore.ts):auth.json + 渲染层握手 + 停/起同步 + 引擎重启 + 设备互联。Forsion 云端那半(device flow / whoami /
  // 续期 / 多账号 / auth:* 通道)在 Extend 里,经下面 host 的 account* 接缝调进来;Extend 缺席 = 只剩 auth.json watcher 这一条。
  const accountCore = createAccountCore({
    loadCreds: loadTanguCreds,
    saveCreds: saveTanguCreds,
    saveConfig: (patch) => saveConfig(patch),
    loadConfig,
    ensureBackend,
    refreshUnitHost,
    renderers: () => [mainWindow, miniWindow, ...detachedWindows.values()]
      .filter((w): w is BrowserWindow => !!w && !w.isDestroyed())
      .map((w) => w.webContents)
      .filter((wc) => !wc.isDestroyed() && !!wc.getURL() && !wc.isLoadingMainFrame()),
    events: ipcMain,
    broadcast: (channel, payload) => { for (const w of BrowserWindow.getAllWindows()) w.webContents.send(channel, payload) },
    stopSync: () => stopAmadeusSync?.(),
    restartSync: () => restartAmadeusSync?.(),
    log: (m) => console.error(m),
  })
  // 全档案都播种 / 装载(2026-09-28 起):Amadeus / basic 单品也跑云同步、penzor、登录态续期,这些都住在 Extend 里;
  // 只在 agent 后端才有意义的包(电脑操作)由清单 requires 挡在 bundleSources 之外。
  {
    await seedBuiltinBundles(join(forsionHomeDir(), 'plugins'), bundleSources, { appVersion: app.getVersion() })
      .catch((e) => console.warn('[builtin-plugins] 播种失败(忽略):', (e as Error)?.message))
    const host: CloudHost = {
      getCloud: async () => {
        const stored = await loadConfig()
        const creds = loadTanguCreds()
        return { base: (stored.cloudUrl || creds.cloudUrl || DEFAULT_CLOUD_URL).replace(/\/+$/, ''), token: creds.token || '' }
      },
      handle: (channel, fn) => { ipcMain.handle(channel, fn); cloudChannels.add(channel) },
      openExternal: (url) => shell.openExternal(url),
      isTrustedSender,
      log: (m) => console.log(m),
      // ── Forsion Connect(0.2 起):项目根、与预览同一份转译器 / MIME 表、codePreview 的 Forsion 挂钩 ──
      projectsRoot: () => join(forsionWorkspaceDir(), 'Project'),
      transpileForServe,
      mimeOf: (ext) => MIME[ext],
      setPreviewHooks: setForsionPreviewHooks,
      // ── 0.3 起:原样凭据 / 账号身份(不回落 DEFAULT_CLOUD_URL,与 amadeus/settings.ts 的 currentCloudAccountId 同口径)、远程同步外置后端注册点 ──
      readCreds: () => { const c = loadTanguCreds(); return { cloudUrl: c.cloudUrl || '', token: c.token || '' } },
      accountId: () => { const c = loadTanguCreds(); return forsionAccountId(c.cloudUrl || '', c.token || '') },
      registerRemoteSyncBackend,
      // ── 0.3 起:账号核心(auth:* 通道住在 Extend,编排在 accountCore)──
      homeDir: forsionHomeDir,
      appVersion: () => app.getVersion(),
      broadcast: (channel, payload) => { for (const w of BrowserWindow.getAllWindows()) w.webContents.send(channel, payload) },
      // managed 变体的「引擎在不在」轴:引擎没 ready 时账号卡必须显示引擎态,绝不能只看 token 文件亮绿灯
      // (「显示已登录但后端根本没启动」的根)。external/无 agent 后端形态 = null,前端不渲染引擎态。
      accountBackendState: async () => (PRODUCT.agentBackend && (await loadConfig()).mode === 'managed' ? backend.getStatus().state : null),
      accountTransition: (fn) => accountCore.transition(fn),
      accountCommit: (creds, assertCurrent, onCommitPoint) => accountCore.commit(creds, assertCurrent, onCommitPoint),
      accountClear: (assertCurrent, onCommitPoint) => accountCore.clear(assertCurrent, onCommitPoint),
      writeCreds: (patch) => accountCore.writeCreds(patch),
      onExternalCredsChange: (cb) => accountCore.onExternalChange(cb),
      setTokenRefresher: (fn) => accountCore.setRefresher(fn),
      // ── 0.4 起:Amadeus 云同步工厂(引擎与 11 个通道住在 Extend;宿主 registerAmadeusIpc 里 vault 建好后调)──
      setAmadeusSyncFactory: (factory) => { amadeusSyncFactory = factory },
      // ── 0.6 起:设备互联的云端通道工厂(隧道 + caps 上报器;units:* 名册四通道也由 Extend 注册)。doRefreshUnitHost 每次重建时调 ──
      setUnitHubFactory: (factory) => { unitHubFactory = factory },
    }
    // 插件页停用了的:不装主进程半身 —— 与没装 Extend 同一个形态(cloud:present 空,云端界面整套隐藏)。
    const off = (await loadConfig()).disabledBundles
    initBundleSwitches(Array.isArray(off) ? off.filter((x): x is string => typeof x === 'string') : [])
    for (const s of bundleSources) if (s.desktop && bundleOff(s.id)) console.log(`[cloud-host] ${s.id} 已在插件页停用,不装载主进程半身`)
    const loaded = await loadBuiltinDesktopEntries({ pluginsRoot: join(forsionHomeDir(), 'plugins'), sources: bundleSources.filter((s) => !bundleOff(s.id)), appVersion: app.getVersion(), host, tempRoot: app.getPath('userData') })
    if (!loaded.includes('forsion-extend')) cloudChannels.clear()
  }
  ipcMain.on('cloud:present', (e) => { e.returnValue = [...cloudChannels] })
  // 插件页拨带主进程半身的内置包(Forsion Extend):只改下次开机装不装,回「是否待重启」。别的 id 一律拒(开关名单不收杂项)。
  ipcMain.handle('plugins:setBundleEnabled', async (e, id: unknown, on: unknown) => {
    if (!isTrustedSender(e)) throw new Error('forbidden')
    if (typeof id !== 'string' || !lockedPluginIds().has(id) || typeof on !== 'boolean') throw new Error('invalid arguments') // 内部串:只有受信渲染层传错参才会到这
    await saveConfig((before) => {
      const next = new Set((Array.isArray(before.disabledBundles) ? before.disabledBundles : []).filter((x) => typeof x === 'string'))
      if (on) next.delete(id)
      else next.add(id)
      return { disabledBundles: [...next] }
    })
    setBundleOff(id, !on)
    return { restartPending: bundleRestartPending(id) }
  })
  // 「重启以生效」:走正常退出链(引擎 / 同步收尾),退完再拉起。dev(electron-vite)下拉不起来就手动重跑 npm run dev。
  const guardedRestart = createRestartGuard({
    inspect: async () => {
      const st = backend.getStatus()
      // External/cloud engines survive this desktop restarting; only inspect the engine we stop.
      if (!PRODUCT.agentBackend || st.state === 'stopped' || st.state === 'crashed') return { tasks: 0, processes: 0 }
      if (st.state !== 'ready' || !st.url) return { tasks: 0, processes: 0, unknown: true }
      return readRestartActivity(st.url, backend.getToken())
    },
    confirm: async (options) => {
      showMainWindow()
      if (!mainWindow || mainWindow.isDestroyed()) return false
      return (await dialog.showMessageBox(mainWindow, options)).response === 1
    },
    restart: async (install) => {
      isQuitting = true
      // Stop before relaunch/quitAndInstall so before-quit cannot bypass either with app.exit.
      try {
        await backend.stop()
        if (install) installUpdate()
        else { app.relaunch(); app.quit() }
      } catch (error) {
        isQuitting = false
        throw error
      }
    },
  })
  ipcMain.handle('app:relaunch', (e) => {
    if (!isTrustedSender(e)) throw new Error('forbidden')
    return guardedRestart()
  })
  ipcMain.handle('updater:restart', (e) => {
    if (!isTrustedSender(e)) throw new Error('forbidden')
    return guardedRestart(canInstallUpdate() && getUpdaterStatus().phase === 'downloaded')
  })
  // Manual checks and background checks share state and a single in-flight run.
  const corePluginUpdater = createCorePluginUpdater({
    items: bundleSources.map((s) => ({ id: s.id, packageName: s.pkg, phase: 'idle' })),
    enabled: app.isPackaged,
    broadcast: (status) => {
      for (const w of BrowserWindow.getAllWindows()) if (!w.isDestroyed()) w.webContents.send('updater:core-status', status)
    },
    run: async (onStatus) => {
      const stored = await loadConfig()
      return checkBuiltinUpdates({
        pluginsRoot: join(forsionHomeDir(), 'plugins'), sources: bundleSources,
        appVersion: app.getVersion(), registries: registryOrder(stored.mirror), onStatus,
        fetch: (url, init) => url.startsWith(NPM_OFFICIAL) ? net.fetch(url, init) : fetch(url, init),
      })
    },
  })
  const checkAllUpdates = () => {
    void corePluginUpdater.check()
    if (PRODUCT.market) void marketPluginUpdater.check().catch((e) => console.warn('[market-updates]', e))
    return checkForUpdates()
  }
  ipcMain.handle('updater:core-status', () => corePluginUpdater.snapshot())
  if (app.isPackaged) {
    setTimeout(() => {
      void corePluginUpdater.check()
      setInterval(() => void corePluginUpdater.check(), 6 * 3600_000).unref()
    }, 60_000).unref()
  }
  // tangu CLI 自动安装/自愈:shim 指向 App 内部资源(App 自动更新 → CLI 同步),幂等注入 PATH;吞错不阻塞。
  if (PRODUCT.agentBackend) void ensureCliInstalled({
    isPackaged: app.isPackaged,
    platform: process.platform,
    execPath: process.execPath,
    resourcesPath: process.resourcesPath,
    appImagePath: process.env.APPIMAGE || null,
    homeDir: app.getPath('home'),
    tanguHome: tanguHomeDir(),
    log: (m) => console.log(m),
  }).catch(() => {})

  // 用户活动日志:开关初值 + 30 天轮转 + app.start 事件(埋点面见 frontend/src/activity/log.ts)。
  try {
    const startCfg = await loadConfig()
    setActivityLogEnabled(startCfg.activityLogEnabled !== false)
    activeWindowOn = startCfg.activeWindowEnabled === true
    keepAwakeOn = startCfg.keepAwakeWhileRunning === true
    void pruneActivity()
    logActivity('app.start', { v: app.getVersion() })
  } catch { /* 装饰性,不阻塞启动 */ }
  // 电脑历史:按配置开录 / 保持关闭;7 天保留期启动时与每小时各清一次。配置读挂了也要 start(IPC 在等 ready),按全关起步。
  if (computerHistory) {
    const ch = computerHistory
    void loadConfig().then((cfg) => ch.start(cfg), () => ch.start({})).catch((e) => console.warn('[computer-history] start failed', e))
  }
  // renderer 埋点入口:结构化 {event, detail},拼行/消毒只在 activityLog.ts(用户内容进不了行结构)。
  ipcMain.on('activity:append', (_e, payload: { event?: unknown; detail?: unknown }) => {
    if (!payload || typeof payload.event !== 'string') return
    const detail = payload.detail && typeof payload.detail === 'object' ? (payload.detail as Record<string, unknown>) : undefined
    logActivity(payload.event, detail)
  })
  ipcMain.handle('activity:export', (_e, days?: number) => exportActivity(Number(days) || 7))

  // 前台窗口采样接缝:默认拒(activeWindowEnabled,开发者选项里开)。开关态缓存在这里,
  // 与 activityLogEnabled 同款——config:set 里同步刷新,免得每次采样都读一遍盘。
  ipcMain.handle('system:activeWindow', () => sampleActiveWindow())

  // 「有会话运行时不休眠」:各窗口报自己订阅着的在飞 run 数,判定与 powerSaveBlocker 都在 keepAwake.ts。
  // 窗口销毁 / 渲染进程崩溃 / 主框架换了新文档(重载,含新页面没跑到上报那步)/ 主框架加载失败(卫星窗口没有
  // recoverRenderer 兜重载)都来不及报 0 → 这里替它清;新页面重新订阅到 run 会再报上来。宁可短暂放行休眠,也不让旧计数把电脑一直顶着。
  const keepAwakeWatched = new Set<number>()
  ipcMain.on('power:running', (e, count: unknown) => {
    if (!isTrustedSender(e) || !e.senderFrame) return // senderFrame 为空 = 旧文档导航后才到的迟到上报,丢弃
    const wc = e.sender
    const id = wc.id
    if (!keepAwakeWatched.has(id)) {
      keepAwakeWatched.add(id)
      wc.once('destroyed', () => { keepAwakeWatched.delete(id); keepAwake.forget(id) })
      wc.on('render-process-gone', () => keepAwake.forget(id))
      wc.on('did-navigate', () => keepAwake.forget(id))
      wc.on('did-fail-load', (_ev, code, _desc, _url, isMainFrame) => { if (isMainFrame && code !== -3) keepAwake.forget(id) }) // -3=导航被取消,旧页面还在
    }
    keepAwake.report(id, Number.isSafeInteger(count) && (count as number) > 0)
  })
  // Windows 在用户主动睡眠时终止电源请求,唤醒后手里的 id 已失效 → 重新申请(macOS 断言跨睡眠保留,重申无害)。
  // 设备互联通道:合盖期间的出站长连多半已是半开连接(不报错也收不到东西)→ 唤醒即重拨,别等 45s 读看门狗。
  // 睡眠会让「暂停到点」的计时器迟到 → keepAwake 重排;电脑历史采集器重新核一次状态。
  powerMonitor.on('resume', () => {
    keepAwake.rearm()
    computerHistory?.recheck()
    unitHub?.reconnect('resume')
  })

  ipcMain.handle('config:get', () => effectiveConfig())
  registerDocumentTaskIpc(ipcMain, join(app.getPath('userData'), 'document-task-receipts.json'), isTrustedSender)
  deviceSecrets.registerSecretsIpc(ipcMain, { isTrustedSender, refreshUnitHost }) // P1-K5:secrets:status / retry / resetUnitPairing / relaunch
  registerRemoteSessionsIpc(ipcMain, remoteSessions, isTrustedSender) // P1-K4:remoteSessions:get / setEnabled / setMaxApprovalMode / revoke
  registerRemoteSafetyIpc(ipcMain, remoteSafety, isTrustedSender) // P1-K2:remoteSafety:get / estop / unlock / setHotkey / setHotkeyRecording
  ipcMain.handle('config:set', async (_e, patch: Partial<TanguStoredConfig>) => {
    const accountCreds = loadTanguCreds() // Capture before saveConfig's first await.
    // 渲染层直接改电脑历史的键(正路是 window.tangu.computerHistory.*,那条自己落盘):这次落盘与控制器的意愿操作 / 后台补落
    // 排同一条队、发出即作废在途的「开 / 恢复」,落成后只同步仍是最新意愿的字段(见 ComputerHistory.configSet)
    const chPatch: ComputerHistoryConfig = {}
    for (const k of ['computerHistoryEnabled', 'computerHistoryPausedUntil', 'computerHistoryExclude'] as const) if (k in patch) (chPatch as Record<string, unknown>)[k] = patch[k]
    const save = (): Promise<TanguStoredConfig> => saveConfig(patch, accountCreds)
    // before 与写入同一队位读出(见 saveConfig);下面的内存镜像紧跟本次落盘赋值,先于下一个排队的写 → 顺序与盘面一致。
    const before = computerHistory && Object.keys(chPatch).length ? await computerHistory.configSet(chPatch, save) : await save()
    if (patch.activityLogEnabled !== undefined) setActivityLogEnabled(patch.activityLogEnabled !== false)
    if (patch.activeWindowEnabled !== undefined) {
      activeWindowOn = patch.activeWindowEnabled === true
      // 它的 ⌘K 入口注册在**主窗**的命令表里,而开关多半是从设置浮窗拨的(命令表每个渲染进程各一份)。
      // 落盘之后才推,主窗回读 config 时拿到的才是新值。
      if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('window:mainAction', 'dev-commands')
    }
    if (patch.keepAwakeWhileRunning !== undefined) {
      keepAwakeOn = patch.keepAwakeWhileRunning === true
      keepAwake.refresh() // 运行中切开关:关要立刻放、开要立刻拦,不等下一次上报
    }
    // 模式/托管参数变化 → 重启托管后端(切到 external 则停掉)。
    const managedKeys: Array<keyof TanguStoredConfig> = [
      'mode', 'cloudUrl', 'sandbox', 'hostSandbox', 'pythonMode', 'mirror',
      'browserEnabled', 'browserEngine', 'browserSearchEngine', 'browserAllowPrivateUrls', 'browserCommandTimeoutMs',
      'unitHostEnabled', // 开着 = 引擎常驻(即使 mode≠managed),见 ensureBackend
    ]
    if (managedKeys.some((k) => patch[k] !== undefined && patch[k] !== before[k])) {
      void ensureBackend()
    }
    // 设备互联:开关或云端地址变化 → 重建 unit host 连接。
    if ((patch.unitHostEnabled !== undefined && patch.unitHostEnabled !== before.unitHostEnabled)
      || (patch.cloudUrl !== undefined && patch.cloudUrl !== before.cloudUrl)) {
      void refreshUnitHost()
    }
    // 对外 MCP 端点开关变化 → 起停(await 完再返回,让 effectiveConfig 带上最新运行状态供 UI 展示连接信息)。
    if (patch.mcpEnabled !== undefined && patch.mcpEnabled !== before.mcpEnabled) {
      await applyForsionMcp(patch.mcpEnabled)
    }
    return effectiveConfig()
  })

  // ── 设备互联(Forsion Unit):名册 CRUD(units:list / update / remove)与「在浏览器中打开」(units:openInBrowser,代拼 #token=)
  // 自 2026-09-28 起住在内置包 Forsion Extend 的主进程半身里(0.6,unit/index.ts);没有 Extend = preload 删掉这四个桥键,渲染层不列名册。
  // 下面留在宿主的是不经云端名册也成立的那几条:P2P 直连、本机通道状态、局域网探针与已配对设备。

  // `cloud:fetch`(插件以当前用户身份调 Forsion 云端 API 的通用接缝)、个人中心 / 会员页、额度与重置卡、反馈提交
  // 这一组云端账号 IPC 自 2026-09-27 起住在内置包 Forsion Extend 的主进程半身里(cloudHost.ts 装载,registerCloud(host) 注册)。

  /** P2P 直连打开设备(A 侧,方案 §12):offer 经**现有隧道**送达对端(零 server 改动——信令即
   *  一次普通 proxy 请求,owner 校验白得),answer 回来打洞;成了起本机代理(127.0.0.1)供
   *  webview 当 lanUrl 用,流量一个字节不过 server。失败 throw 可读错误,UI 负责回落中转。 */
  ipcMain.handle('units:p2pOpen', async (_e, unitId: string) => {
    if (typeof unitId !== 'string' || !unitId) throw new Error('参数不完整')
    const live = p2pOutgoing.get(unitId)
    if (live && !live.dead) return { url: live.proxy.url }
    if (live) { p2pProxySecrets.delete(live.proxy.url); p2pOutgoing.delete(unitId); void live.proxy.close().catch(() => {}) }
    const token = loadTanguCreds().token
    if (!token) throw new Error('not-logged-in') // 原因码:UnitSwitcher 回落中转时经 ipcErrorText 上屏
    const stored = await loadConfig()
    const mgr = getP2p()
    const { peerId, sdp } = await mgr.makeOffer()
    let answer = ''
    try {
      const r = await fetch(`${stored.cloudUrl.replace(/\/+$/, '')}/api/units/${unitId}/proxy/unit/p2p/offer`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ sdp }),
        signal: AbortSignal.timeout(25_000),
      })
      if (r.status === 404 || r.status === 501) throw new Error('对方版本不支持 P2P 直连')
      if (!r.ok) {
        const j = await r.json().catch(() => null) as { detail?: string } | null
        throw new Error(j?.detail || `信令失败 HTTP ${r.status}`)
      }
      answer = String((await r.json() as { sdp?: string }).sdp || '')
      if (!answer) throw new Error('对端未返回 answer')
    } catch (e) {
      mgr.closePeer(peerId)
      throw e
    }
    mgr.finish(peerId, answer)
    try {
      await mgr.waitOpen(peerId, 15_000)
    } catch (e) {
      mgr.closePeer(peerId)
      throw e
    }
    const ch = mgr.channel(peerId)
    const proxy = await startP2pProxy(ch, { log: (m) => console.log(m) })
    p2pProxySecrets.set(proxy.url, proxy.secret)
    const entry = { proxy, peerId, dead: false }
    p2pOutgoing.set(unitId, entry)
    ch.onClose(() => { entry.dead = true; p2pProxySecrets.delete(proxy.url) })
    if (entry.dead) {
      // waitOpen 与此处之间信道已断(channel().onClose 对已关信道同步回调):别把死代理地址
      // 当成功返回——渲染层拿到就是黑页,还压不出回落(Codex M7 的竞态半边)。
      p2pOutgoing.delete(unitId)
      void proxy.close().catch(() => {})
      throw new Error('P2P 信道在建立后立即断开')
    }
    return { url: proxy.url }
  })
  ipcMain.handle('units:hostStatus', () => ({
    ...(unitHub ? unitHub.status() : { running: false, connected: false, unitId: null, lastError: null }),
    webPort: unitWeb?.port ?? null,
    lanUrl: unitLanUrl(),
  }))
  // LAN 直连探针(v2.1 自动择路):主进程发(渲染层跨源 fetch 会被 CORS 拦),1.2s 封顶。
  // 只判「是台 unitWeb 且响应 meta」,身份最终由配对流的 6 位码人工比对把关(防 DHCP 换主)。
  ipcMain.handle('units:probeLan', async (_e, lanUrl: string) => {
    try {
      const u = new URL(String(lanUrl))
      if (u.protocol !== 'http:' && u.protocol !== 'https:') return null
      const ctrl = new AbortController()
      const timer = setTimeout(() => ctrl.abort(), 1200)
      try {
        const r = await fetch(new URL('/unit/meta', u), { signal: ctrl.signal })
        if (!r.ok) return null
        const meta = (await r.json()) as { instanceId?: unknown; name?: unknown }
        return typeof meta?.instanceId === 'string' ? { instanceId: meta.instanceId, name: String(meta.name || '') } : null
      } finally {
        clearTimeout(timer)
      }
    } catch {
      return null
    }
  })
  // T1 配对设备的回收面(B 侧自己的 UI;无回收的配对不许上线——方案 §11.3)。
  ipcMain.handle('units:pairedList', async () => (await loadConfig()).unitPairedDevices || [])
  ipcMain.handle('units:pairedRemove', async (_e, id: string) => {
    try {
      await saveConfig((c) => {
        // 队内读当前列表:队外读会抹掉并发配上的设备。撤销先于落盘生效(fail-closed):写盘失败也不再放行它,直到重启重读磁盘
        unitPairedCache = (c.unitPairedDevices || []).filter((d) => d.id !== String(id))
        return { unitPairedDevices: unitPairedCache }
      })
    } finally {
      // P2P 是站着的信道,建立后逐请求走 x-unit-p2p(unitWeb 的 per-boot p2pSecret,与隧道分钥)——不收的话被撤销的设备继续全权访问,
      // 直到信道偶然断开(Codex H2)。粗粒度全收(含账号态会话):撤销是低频动作,重连便宜。落盘失败也照收。
      // ponytail: 按主体(pairHash)定向收要把身份穿进 PeerEntry,撤销频率撑不起那台机器
      await closeAllP2p()
    }
    return { ok: true }
  })

  // 收件箱:系统通知(点击 → 聚焦窗口 + 回跳 Inbox Space)与 dock 角标。
  ipcMain.handle('inbox:notify', (_e, title: string, body: string) => {
    if (!Notification.isSupported()) return
    const n = new Notification({ title: String(title || '').slice(0, 200), body: String(body || '').slice(0, 200) })
    n.on('click', () => {
      showMainWindow()
      if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('inbox:open')
    })
    n.show()
  })
  // 通用系统通知(应用内通知统一同步发,不止收件箱;点击仅聚焦窗口)。
  ipcMain.handle('ui:notify', (_e, title: string, body: string) => {
    if (!Notification.isSupported()) return
    const n = new Notification({ title: String(title || '').slice(0, 200), body: String(body || '').slice(0, 200) })
    n.on('click', () => showMainWindow())
    n.show()
  })
  // Agent Desk 截屏(引擎 desk_screenshot 工具):渲染层给视口矩形,这里抓真实像素。
  // 用 webContents.capturePage 而不是 html2canvas 那类 DOM 复刻——webview / canvas / 原生视图
  // 都能抓到,复刻方案对这些一律是空白。矩形按 DIP,与 getBoundingClientRect 的视口坐标同系。
  installAmbientPalette(isTrustedSender)
  ipcMain.handle('ui:captureRect', async (e, rect: { x: number; y: number; width: number; height: number }) => {
    const win = BrowserWindow.fromWebContents(e.sender)
    if (!win || win.isDestroyed()) return null
    const int = (v: unknown): number => Math.max(0, Math.round(Number(v) || 0))
    const r = { x: int(rect?.x), y: int(rect?.y), width: int(rect?.width), height: int(rect?.height) }
    if (r.width < 16 || r.height < 16) return null
    try {
      const img = await win.webContents.capturePage(r)
      if (img.isEmpty()) return null
      // 控 token:最长边压到 1024(HiDPI 下原图是 2x,不压一张图能顶几千 token)
      const { width, height } = img.getSize()
      const max = Math.max(width, height)
      const out = max > 1024 ? img.resize({ width: Math.round((width * 1024) / max), quality: 'good' }) : img
      return out.toDataURL()
    } catch {
      return null
    }
  })
  ipcMain.handle('inbox:badge', (_e, count: number) => {
    // setBadgeCount:mac dock 原生;Linux 仅 Unity;Windows 无角标概念(需 setOverlayIcon 自绘,v1 no-op)。
    if (process.platform === 'darwin') app.setBadgeCount(Math.max(0, Math.floor(Number(count) || 0)))
  })
  // 本机模式的工作目录选择(host-exec 的 cwd)。
  ipcMain.handle('dialog:pickDirectory', async (_e, opts?: unknown) => {
    const win = BrowserWindow.getFocusedWindow() ?? mainWindow
    const r = win
      ? await dialog.showOpenDialog(win, { properties: ['openDirectory', 'createDirectory'], title: mt('main.dialog.pickWorkdir') })
      : await dialog.showOpenDialog({ properties: ['openDirectory', 'createDirectory'], title: mt('main.dialog.pickWorkdir') })
    if (r.canceled || !r.filePaths.length) return null
    // 「添加 / 导入项目」里本机原生选择框选的目录 = 本机确认过的项目根(设备页没有这个桥):/unit/host* 才认开在这里的会话
    // (unitLocalRoots.ts)。技能导入 / 同步目录 / 额外可写根等别的用途不登记 —— 选了个目录不等于同意设备页浏览它(Codex r3 #2)。
    await registerPickedDirectory(localProjectRegistry(), r.filePaths[0], opts).catch((e) => console.error('[unit] 登记本机项目根失败:', e))
    return r.filePaths[0]
  })

  // Chat Box「添加文件或文件夹」：一个系统面板允许多选文件 / 目录，并把类型一并回给 renderer。
  ipcMain.handle('dialog:pickPaths', async () => {
    const win = BrowserWindow.getFocusedWindow() ?? mainWindow
    const opts = { properties: ['openFile' as const, 'openDirectory' as const, 'multiSelections' as const], title: mt('main.dialog.pickPaths') }
    const r = win ? await dialog.showOpenDialog(win, opts) : await dialog.showOpenDialog(opts)
    if (r.canceled || !r.filePaths.length) return []
    return Promise.all(r.filePaths.map(async (path) => ({
      path,
      isDirectory: await stat(path).then((s) => s.isDirectory()).catch(() => false),
    })))
  })

  // 另存为文本文件(导出日志等):弹系统保存框,用户选位置后写盘。canceled → { ok:false }。
  ipcMain.handle('dialog:saveTextFile', async (_e, defaultName: string, content: string) => {
    if (typeof content !== 'string') return { ok: false, path: null }
    const win = BrowserWindow.getFocusedWindow() ?? mainWindow
    const opts = {
      title: mt('main.dialog.export'),
      defaultPath: typeof defaultName === 'string' && defaultName ? defaultName : 'export.json',
      filters: [{ name: 'JSON', extensions: ['json'] }, { name: 'All Files', extensions: ['*'] }],
    }
    const r = win ? await dialog.showSaveDialog(win, opts) : await dialog.showSaveDialog(opts)
    if (r.canceled || !r.filePath) return { ok: false, path: null }
    await writeFile(r.filePath, content, 'utf8')
    return { ok: true, path: r.filePath }
  })

  // ── 本机工作区文件浏览(host 模式右栏:直接读 cwd 真实目录)──
  ipcMain.handle('fs:listDir', (_e, dirPath: string) => listDirImpl(dirPath))
  /** 单条目 stat(侧栏悬停提示用;悬停 1s 才调 = 天然节流,不进 listDir 热路径)。
   *  文件 → 修改/创建时间;目录 → 另带直接子项计数。⚠️birthtime 只有 mac/Windows 可靠,
   *  Linux 部分文件系统拿不到 → Node 给 0(或悄悄回退 ctime);0 一律当「无」,由渲染层省略该行。 */
  ipcMain.handle('fs:stat', (_e, p: string) => statPathImpl(p))
  const MIME_BY_EXT: Record<string, string> = {
    txt: 'text/plain', md: 'text/markdown', markdown: 'text/markdown', json: 'application/json',
    js: 'text/javascript', mjs: 'text/javascript', cjs: 'text/javascript', ts: 'text/typescript',
    tsx: 'text/typescript', jsx: 'text/javascript', css: 'text/css', html: 'text/html', xml: 'text/xml',
    yml: 'text/yaml', yaml: 'text/yaml', toml: 'text/plain', csv: 'text/csv', py: 'text/x-python',
    sh: 'text/x-sh', go: 'text/x-go', rs: 'text/x-rust', java: 'text/x-java', c: 'text/x-c', h: 'text/x-c',
    cpp: 'text/x-c++', sql: 'text/plain', log: 'text/plain', env: 'text/plain', gitignore: 'text/plain',
    png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', svg: 'image/svg+xml', bmp: 'image/bmp',
  }
  // ponytail: 预览读盘上限 50MB —— PDF/Office/图片基本够;超大视频会判 tooLarge 走「在文件管理器显示」兜底。
  // 整文件 base64 经 IPC 传输,再大就该换 file:// 流式/分块,目前用不上。
  const MAX_PREVIEW_BYTES = 50 * 1024 * 1024
  ipcMain.handle('fs:readFile', async (_e, filePath: string) => {
    const st = await stat(filePath)
    const ext = (filePath.split('.').pop() || '').toLowerCase()
    const mimeType = MIME_BY_EXT[ext] || 'application/octet-stream'
    if (st.size > MAX_PREVIEW_BYTES) return { mimeType, content: '', size: st.size, mtimeMs: st.mtimeMs, tooLarge: true }
    const buf = await readFile(filePath)
    return { mimeType, content: buf.toString('base64'), size: st.size, mtimeMs: st.mtimeMs }
  })
  // ── Coding Space:本地静态预览服务器(整 cwd 挂 127.0.0.1 随机端口;渲染端 iframe 加载多文件 web app)──
  ipcMain.handle('codePreview:serve', async (e, rootDir: string) => {
    if (!isTrustedSender(e)) throw new Error('forbidden')
    if (!rootDir || typeof rootDir !== 'string') throw new Error('非法的预览根目录')
    if (!(await stat(rootDir)).isDirectory()) throw new Error('Preview root is not a directory')
    // Each project gets its own origin: localStorage and simultaneous preview windows stay isolated.
    // 托管根下的项目 = 产物 → 稳定源(跨重启同源,本地数据不丢);其余走一次性令牌根。
    return previewOriginFor(join(forsionWorkspaceDir(), 'Project'), rootDir, forsionHomeDir())
  })
  const studioWatchers = new Map<number, ReturnType<typeof createCodeStudioProjectWatcher>>()
  ipcMain.handle('codeStudio:watch', async (e, rootDir: string | null) => {
    if (!isTrustedSender(e)) throw new Error('forbidden')
    if (rootDir !== null && (typeof rootDir !== 'string' || !rootDir)) throw new Error('Invalid project root')
    let watcher = studioWatchers.get(e.sender.id)
    if (!watcher) {
      watcher = createCodeStudioProjectWatcher(
        change => { if (!e.sender.isDestroyed()) e.sender.send('codeStudio:changed', change) },
        (error, root) => {
          if (root && !e.sender.isDestroyed()) e.sender.send('codeStudio:changed', { root, path: null, error: error.message })
        },
      )
      studioWatchers.set(e.sender.id, watcher)
      const id = e.sender.id
      e.sender.once('destroyed', () => { studioWatchers.get(id)?.close(); studioWatchers.delete(id) })
    }
    return { root: await watcher.setRoot(rootDir) }
  })
  ipcMain.handle('codeStudio:versions', async (e, rootDir: string) => {
    if (!isTrustedSender(e)) throw new Error('forbidden')
    return listCodeStudioSnapshots(rootDir, join(forsionHomeDir(), 'coding-history'))
  })
  ipcMain.handle('codeStudio:snapshot', async (e, rootDir: string, name: string) => {
    if (!isTrustedSender(e)) throw new Error('forbidden')
    return createCodeStudioSnapshot(rootDir, join(forsionHomeDir(), 'coding-history'), name)
  })
  ipcMain.handle('codeStudio:restore', async (e, rootDir: string, id: string) => {
    if (!isTrustedSender(e)) throw new Error('forbidden')
    return restoreCodeStudioSnapshot(rootDir, join(forsionHomeDir(), 'coding-history'), id)
  })
  ipcMain.handle('codePreview:stop', () => { stopCodePreview(); return { ok: true } })
  // 单文件 HTML 预览(wsfile / Agent Desk / 笔记内嵌):把该文件**所在目录**挂到一个不可猜的令牌根下。
  // 为什么必须走真 http 源:srcdoc 的 iframe 会继承宿主 CSP(script-src 无外部源)且 sandbox 无
  // allow-same-origin → CDN 脚本被拦、fetch('./model.glb') 被拦,three.js 这类页面必然空白。
  ipcMain.handle('codePreview:servePath', async (e, filePath: string) => {
    if (!isTrustedSender(e)) throw new Error('forbidden')
    if (!filePath || typeof filePath !== 'string') throw new Error('非法的预览路径')
    const st = await stat(filePath).catch(() => null)
    if (!st?.isFile()) throw new Error('预览目标不是文件')
    const real = realpathSync(filePath) // 软链指到别处时按真实落点挂根,不给「链出去」的越权
    const { base } = await servePathRoot(dirname(real))
    return { url: `${base}/${encodeURIComponent(basename(real))}` }
  })

  // 没有本机路径的 HTML(云沙箱文件 / 对话内联)——同样给真实源,不许退回 srcdoc。
  ipcMain.handle('codePreview:serveHtml', async (e, html: string) => {
    if (!isTrustedSender(e)) throw new Error('forbidden')
    if (typeof html !== 'string') throw new Error('非法的预览内容')
    // 内联内容常驻主进程内存(没有落盘可回收),按字节数封顶——64 条 × 无上限单条 = 无上限内存。
    if (Buffer.byteLength(html, 'utf8') > 8 * 1024 * 1024) throw new Error('预览内容过大(>8MB)')
    return serveInlineHtml(html)
  })

  // Forsion Connect(Coding Space 发布 + 预览态 AI 代理)自 0.2 起住在内置包 Forsion Extend 的主进程半身里:
  // connect:* 通道与 codePreview 的 /forsion-connect.js、/__forsion/* 挂钩都由它经 CloudHost 注册(cloudHost.ts)。
  // 造物 Space + Coding Studio git 版本:逻辑在 productsIpc / 各纯模块里,这里只注入 Electron 依赖。
  installPreviewPersistence(forsionHomeDir)
  registerProductsIpc({
    ipcMain, isTrustedSender,
    projectsRoot: () => join(forsionWorkspaceDir(), 'Project'),
    homeDir: forsionHomeDir,
    // 版本历史找 git 用这份 env:内置 git 按同一规则挂上,没装 git 的机器也有版本管理。
    env: () => {
      const e = envWithFullPath()
      const key = pathKeyOf(e)
      e[key] = withBundledGit(e[key] || '', resolveBundledGit()?.pathDirs || [])
      return e
    },
    isPackaged: app.isPackaged,
    desktopDir: () => app.getPath('desktop'),
    execPath: process.execPath,
    trashItem: (p) => shell.trashItem(p),
    broadcast: (channel, payload) => { for (const w of BrowserWindow.getAllWindows()) if (!w.isDestroyed() && !w.webContents.isDestroyed()) w.webContents.send(channel, payload) },
    writeShortcutLink: process.platform === 'win32' ? (p, o) => shell.writeShortcutLink(p, 'create', o) : undefined,
  })

  // Coding Space 的项目根目录 = ~/Forsion/Project(与 Amadeus 的 ~/Forsion/Amadeus 同级;dev=~/Forsion-Dev/Project),
  // 每个项目一个子文件夹。返回时确保存在(子文件夹经 fs:mkdir 的 safeName 校验创建)。
  ipcMain.handle('codeProjects:root', async () => {
    const root = join(forsionWorkspaceDir(), 'Project')
    await mkdir(root, { recursive: true }).catch(() => { /* ignore */ })
    return root
  })
  // 用系统默认应用打开(预览不支持的类型走这里);openPath 失败返回错误串而非抛异常。
  ipcMain.handle('fs:openPath', async (_e, p: string) => {
    if (!p || typeof p !== 'string') return { ok: false, error: 'invalid path' }
    const err = await shell.openPath(p)
    return err ? { ok: false, error: err } : { ok: true }
  })
  // 按路径串行,精确 mtime CAS 在 tmp fsync 后、rename 前再检查;新建仍走 wx。
  ipcMain.handle('fs:writeFile', (_e, filePath: string, content: string, expectedMtimeMs?: number, createNew?: boolean) =>
    writeHostTextFile(filePath, content, expectedMtimeMs, createNew))

  // ── 本机工作区文件操作:重命名 / 新建文件夹 / 删除到回收站 / 在文件管理器显示 / 原生拖出 ──
  // 安全:重命名/新建只接受**单段名字**(无路径分隔符、非 . / ..),结果始终落在原目录内,杜绝越权写。
  const safeName = (s: unknown): s is string =>
    typeof s === 'string' && s.length > 0 && s.length < 256 && !/[\\/]/.test(s) && !s.includes('\0') && s !== '.' && s !== '..'
  const exists = async (p: string): Promise<boolean> => stat(p).then(() => true).catch(() => false)
  // 目标重名则在扩展名前加 (1)/(2)…,绝不覆盖已有文件。
  const uniqueDest = async (dir: string, name: string): Promise<string> => {
    const dot = name.lastIndexOf('.')
    const base = dot > 0 ? name.slice(0, dot) : name
    const ext = dot > 0 ? name.slice(dot) : ''
    let candidate = join(dir, name)
    for (let i = 1; await exists(candidate); i++) candidate = join(dir, `${base} (${i})${ext}`)
    return candidate
  }

  ipcMain.handle('fs:rename', async (_e, oldPath: string, newName: string) => {
    if (!oldPath || typeof oldPath !== 'string' || !safeName(newName)) throw new Error('非法的重命名参数')
    const dest = join(dirname(oldPath), newName)
    if (dest !== oldPath && (await exists(dest))) throw new Error('同名文件/文件夹已存在')
    await rename(oldPath, dest)
    return { path: dest }
  })
  ipcMain.handle('fs:mkdir', async (_e, parentDir: string, name: string) => {
    if (!parentDir || typeof parentDir !== 'string' || !safeName(name)) throw new Error('非法的文件夹名')
    const dest = join(parentDir, name)
    if (await exists(dest)) throw new Error('同名文件/文件夹已存在')
    await mkdir(dest, { recursive: false })
    return { path: dest }
  })
  ipcMain.handle('fs:trash', async (_e, p: string) => {
    if (!p || typeof p !== 'string') throw new Error('非法路径')
    // 已经不在了 = 目的已达成(幂等):移除项目时它可能从没建过 .tangu/。lstat 不跟软链,悬空软链也照常移走
    const gone = await lstat(p).then(() => false, (e: NodeJS.ErrnoException) => { if (e?.code === 'ENOENT') return true; throw e }) // 只有「不存在」算成功,权限 / IO 错误照常抛
    if (gone) return { ok: true, missing: true }
    // 台架接缝:真 Electron 仪器验「移到废纸篓」时挪进这个临时目录,不往用户的真废纸篓里塞东西
    const e2eTrash = process.env.FORSION_E2E_TRASH_DIR
    if (e2eTrash) { await mkdir(e2eTrash, { recursive: true }); await rename(p, join(e2eTrash, `${Date.now()}-${basename(p)}`)); return { ok: true } }
    await shell.trashItem(p) // 移入系统回收站(可恢复),不做不可逆删除
    return { ok: true }
  })
  ipcMain.handle('fs:reveal', async (_e, p: string) => {
    if (!p || typeof p !== 'string') return { ok: false }
    shell.showItemInFolder(p) // 在系统文件管理器中定位并高亮
    return { ok: true }
  })
  // 拖拽 OS 文件/文件夹 → 复制进本机工作区目录(host 右栏)。重名自动加序号,不覆盖。
  ipcMain.handle('fs:copy', async (_e, srcPaths: unknown, destDir: string) => {
    if (!Array.isArray(srcPaths) || typeof destDir !== 'string' || !destDir) throw new Error('非法的复制参数')
    let copied = 0
    for (const src of srcPaths) {
      if (typeof src !== 'string' || !src) continue
      await cp(src, await uniqueDest(destDir, basename(src)), { recursive: true })
      copied++
    }
    return { copied }
  })
  /** 复合笔记(X.md + 同名 X.fd)从库里拖出来时必须**成对同名**落地。
   *  逐件走 fs:copy 会让两半各自 uniqueDest:目标目录已有 `X.md` 而没有 `X.fd` 时,复制出来的是
   *  `X (1).md` + `X.fd` —— 新笔记找不到自己的子树,而那份 .fd 挂到了目标**已存在的那篇 X.md** 下
   *  (= 把别人的子笔记混进去)。故这里先给整套预留同一个可用 stem,再逐件复制;.fd 失败回滚 .md,
   *  不留半套结构。(codex 评审 2026-08-25) */
  ipcMain.handle('fs:copyBundle', async (_e, items: unknown, destDir: string) => {
    if (!Array.isArray(items) || typeof destDir !== 'string' || !destDir) throw new Error('非法的复制参数')
    let copied = 0
    for (const it of items) {
      const md = (it as { md?: unknown } | null)?.md
      const fd = (it as { fd?: unknown } | null)?.fd
      if (typeof md !== 'string' || !md) continue
      const name = basename(md)
      if (!/\.md$/i.test(name)) { await cp(md, await uniqueDest(destDir, name), { recursive: true }); copied++; continue }
      const stem = name.replace(/\.md$/i, '')
      let s = stem
      for (let i = 1; (await exists(join(destDir, `${s}.md`))) || (await exists(join(destDir, `${s}.fd`))); i++) s = `${stem} (${i})`
      const mdDest = join(destDir, `${s}.md`)
      await cp(md, mdDest, { recursive: true })
      if (typeof fd === 'string' && fd) {
        try { await cp(fd, join(destDir, `${s}.fd`), { recursive: true }) }
        catch (err) { await rm(mdDest, { recursive: true, force: true }); throw err }
      }
      copied++
    }
    return { copied }
  })
  // 拖一行到文件夹 → 移动(同卷 rename;跨卷回退 copy+回收站)。同目录拖放视为 no-op。
  ipcMain.handle('fs:move', async (_e, srcPath: string, destDir: string) => {
    if (typeof srcPath !== 'string' || !srcPath || typeof destDir !== 'string' || !destDir) throw new Error('非法的移动参数')
    if (dirname(srcPath) === destDir) return { path: srcPath }
    const dest = await uniqueDest(destDir, basename(srcPath))
    try {
      await rename(srcPath, dest)
    } catch (err: any) {
      if (err?.code === 'EXDEV') { await cp(srcPath, dest, { recursive: true }); await shell.trashItem(srcPath) }
      else throw err
    }
    return { path: dest }
  })
  // 原生拖出(把工作区文件拖到其它应用 / 桌面):必须用 webContents.startDrag,HTML5 dataTransfer
  // 无法投递真实文件。单向 send(非 invoke);icon 用文件自身图标,取不到则回退一枚 16px 占位图。
  const DRAG_FALLBACK_ICON =
    'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAAHElEQVR42mNkoBAwjhoAA0YwGo0GjUajQYMBADaqAQ8E2sQ4AAAAAElFTkSuQmCC'
  ipcMain.on('fs:startDrag', async (e, filePath: string) => {
    if (!filePath || typeof filePath !== 'string') return
    let icon: Electron.NativeImage | undefined
    try {
      icon = await app.getFileIcon(filePath, { size: 'normal' })
    } catch {
      /* fall through to placeholder */
    }
    if (!icon || icon.isEmpty()) icon = nativeImage.createFromDataURL(DRAG_FALLBACK_ICON)
    e.sender.startDrag({ file: filePath, icon })
  })

  ipcMain.handle('backend:getStatus', () => backend.getStatus())
  ipcMain.handle('backend:getLogs', () => backend.getLogs())
  ipcMain.handle('backend:restart', async () => {
    await ensureBackend()
    return backend.getStatus()
  })

  // ── 环境检测 + 引导安装(首启向导)──
  ipcMain.handle('env:check', () => runEnvCheck())
  // env:run 只接受 env:check 登记的 opaque id(renderer 无法注入任意命令);输出流式发 env:output。
  ipcMain.handle('env:run', async (e, installId: string) => {
    const command = pendingInstallCommands.get(String(installId))
    if (!command) throw new Error('未知安装命令 id(请先重新检测)')
    const wc = e.sender
    // 补全 PATH(GUI 子进程找得到 brew/winget)+ 中国大陆时注入 brew/pip/npm 镜像 env,
    // 否则「切了镜像」对引导安装完全不生效(brew bottles/GitHub 直连在国内基本走不通)。
    const mirrorEnv = (await loadConfig()).mirror === 'china' ? chinaInstallEnv() : {}
    return await new Promise<{ exitCode: number }>((resolve) => {
      // stdin 一律关掉:安装器/包管理器一旦停下来要输入(winget 源协议、sudo 密码),关着的 stdin 让它立刻失败
      // 并把原因打进日志;开着的管道没人写,它就永远等下去、界面永远转圈(2026-09-25 Windows 实测)。
      // 不加 windowsHide:runner 是管理员、测不到 UAC,藏起控制台后提权弹窗会不会退到任务栏闪烁没验证过,保持原样。
      const child = spawn(command, { shell: true, env: envWithFullPath(mirrorEnv), stdio: ['ignore', 'pipe', 'pipe'] })
      const emit = (line: string): void => {
        if (!wc.isDestroyed()) wc.send('env:output', { installId, line })
      }
      emit(`$ ${command}`)
      child.stdout?.on('data', (d) => emit(String(d)))
      child.stderr?.on('data', (d) => emit(String(d)))
      child.on('error', (err) => {
        emit(`[error] ${err?.message || err}`)
        resolve({ exitCode: -1 })
      })
      child.on('close', (code) => {
        emit(`[exit ${code ?? -1}]`)
        resolve({ exitCode: code ?? -1 })
      })
    })
  })
  // ── Forsion 插件依赖应用一键安装:白名单表(shared/knownApps)查命令 → 登记 opaque id,
  // 执行/流式输出复用 env:run 通道。插件只能声明 id,命令文本永远在宿主,无注入面。──
  ipcMain.handle('plugin:request-install', async (_e, appId: string) => {
    const cmd = KNOWN_APPS[String(appId)]?.install[process.platform as 'darwin' | 'win32' | 'linux']
    // 表外 id / 本平台无一键命令 / 命令依赖的 winget、brew 不在 → 前端降级「打开官网」
    if (!cmd || !(await programExists(requiredProgram(cmd)))) return null
    const installId = `app_${String(appId)}_${Date.now().toString(36)}`
    pendingInstallCommands.set(installId, cmd)
    return { installId, command: cmd }
  })
  // 镜像连通性测试:让用户在切「中国大陆镜像」前后确认 registry 是否真的可达/更快。URL 走固定枚举表
  // (不接受 renderer 传 URL → 无 SSRF);每个目标各自 catch,整体绝不抛(任一挂了不影响另一个)。
  ipcMain.handle('env:test-mirror', async (_e, mirrorArg?: 'default' | 'china') => {
    const mirror: 'default' | 'china' =
      mirrorArg === 'china' || mirrorArg === 'default' ? mirrorArg : (await loadConfig()).mirror
    const TARGETS: Record<'default' | 'china', Array<{ name: string; url: string }>> = {
      china: [
        { name: 'npm', url: 'https://registry.npmmirror.com/' },
        { name: 'pip', url: 'https://pypi.tuna.tsinghua.edu.cn/simple/' },
      ],
      default: [
        { name: 'npm', url: 'https://registry.npmjs.org/' },
        { name: 'pip', url: 'https://pypi.org/simple/' },
      ],
    }
    const targets = await Promise.all(
      TARGETS[mirror].map(async (t) => {
        const started = Date.now()
        try {
          // 任何 HTTP 响应(含 4xx/405,某些 registry 不吃 HEAD)= 网络可达;只有网络层错误/超时才算不可达。
          const r = await fetch(t.url, { method: 'HEAD', signal: AbortSignal.timeout(5000) })
          return { name: t.name, url: t.url, ok: true, status: r.status, latencyMs: Date.now() - started }
        } catch (e: any) {
          return {
            name: t.name, url: t.url, ok: false, status: 0, latencyMs: Date.now() - started,
            error: e?.name === 'TimeoutError' ? 'timeout' : e?.message || 'unreachable',
          }
        }
      }),
    )
    return { mirror, targets }
  })

  // ── MCP server 管理(写 config.json 的 mcp 段;managed 模式保存后重启后端重连)──
  const mcpFile = (): string => join(tanguDataDir(), 'mcp.json') // legacy 文件在引擎域
  /** 当前生效的 MCP server 表(mcp:read 与 mcp:write 的保留名比对共用:界面看到的就是比对的底)。 */
  const readMcpServers = async (): Promise<Record<string, any>> => {
    const sec = (await readHomeConfig()).mcp
    if (sec !== undefined) return sec?.mcpServers && typeof sec.mcpServers === 'object' ? sec.mcpServers : {}
    try { // 回落 legacy mcp.json(后端 migrate 前的过渡)
      const parsed = JSON.parse(await readFile(mcpFile(), 'utf8'))
      return parsed?.mcpServers && typeof parsed.mcpServers === 'object' ? parsed.mcpServers : {}
    } catch {
      return {}
    }
  }
  ipcMain.handle('mcp:read', async () => ({ mcpServers: await readMcpServers() }))
  ipcMain.handle('mcp:write', async (_e, cfg: { mcpServers: Record<string, any> }) => {
    if (!cfg || typeof cfg.mcpServers !== 'object') throw new Error('非法 MCP 配置')
    // dev / dev_* 是设备 MCP 的保留命名空间(shared/mcpNames.ts):新加的一律拒,盘上存量的放行(引擎加载时跳过、状态报错)
    const reserved = newReservedMcpNames(cfg.mcpServers, await readMcpServers())
    if (reserved.length) throw new Error(`${MCP_NAME_RESERVED}: ${reserved.join(', ')}`)
    await saveHomeSection('mcp', { mcpServers: cfg.mcpServers }) // 唯一真源:config.json mcp 段(chmod 600)
    const stored = await loadConfig()
    if (stored.mode === 'managed') void ensureBackend() // 重启后端重连 MCP(进程级冻结语义)
    return { mcpServers: cfg.mcpServers }
  })

  // ── 拖入式主题(~/.tangu/themes/<id>/{theme.json,theme.css}):主进程读盘 → 渲染端 <style> 注入 ──
  ipcMain.handle('themes:list', () => readThemesDir(themesDir()))
  ipcMain.handle('themes:openDir', async () => {
    await mkdir(themesDir(), { recursive: true })
    await shell.openPath(themesDir())
    return { ok: true }
  })
  // 主题提交白名单语义(system-glass/opaque)+ 已解析的 #rrggbb 舞台色；具体 vibrancy 与平台能力由主进程掌控。
  ipcMain.handle('window:setMaterial', (e, input: unknown) => {
    const request = parseWindowMaterialRequest(input)
    if (!request) return { ok: false }
    applyWindowMaterial(BrowserWindow.fromWebContents(e.sender), request)
    return { ok: true }
  })

  // ── 设置界面「打开文件夹」:在系统文件管理器打开 agent / skills 目录(~/.tangu/{agents,skills})──
  ipcMain.handle('agents:openDir', async (_e, slug?: string) => {
    const base = join(tanguDataDir(), 'agents')
    // slug 安全化(只允许文件名字符,防路径穿越);无效/缺省则打开 agents 根目录。
    const safe = typeof slug === 'string' && /^[A-Za-z0-9_-]+$/.test(slug) ? slug : ''
    const dir = safe ? join(base, safe) : base
    await mkdir(dir, { recursive: true })
    await shell.openPath(dir)
    return { ok: true }
  })
  ipcMain.handle('skills:openDir', async () => {
    const dir = join(tanguDataDir(), 'skills')
    await mkdir(dir, { recursive: true })
    await shell.openPath(dir)
    return { ok: true }
  })
  ipcMain.handle('plugins:openDir', async () => {
    const dir = join(tanguDataDir(), 'plugins')
    await mkdir(dir, { recursive: true })
    await shell.openPath(dir)
    return { ok: true }
  })

  // ── 跨生态 agent 资产发现/导入(~/.claude、~/.codex、~/.hermes → ~/.tangu)──
  // 导入的 MCP 一律 enabled:false(绝不自动运行外来命令),故**不**触发后端重启;
  // 技能落盘 ~/.tangu/skills/ 后由后端按 mtime 重扫即时生效。
  ipcMain.handle('discovery:scan', () => scanAll())
  ipcMain.handle('discovery:importSkills', (_e, ids: string[]) =>
    importSkills(Array.isArray(ids) ? ids.filter((x) => typeof x === 'string') : [], tanguDataDir()))
  // 两次导入并发会在同一个 legacy mcp.json 上互相覆盖 → 整段串行(不能用 configQueue:里面要 saveHomeSection,会自等死锁)
  const importMcpQueue = createSerialQueue()
  ipcMain.handle('discovery:importMcp', (_e, names: string[]) => importMcpQueue(async () => {
    // importMcp 在 legacy mcp.json 上做合并:先把 config.json 的 mcp 段播种进去(免丢已有),导入后再写回 config.json。
    const home = await readHomeConfig()
    await writePrivateJson(mcpFile(), { mcpServers: home.mcp?.mcpServers || {} }) // 播种内容含 env/headers 密钥 → 0600
    const r = await importMcp(Array.isArray(names) ? names.filter((x) => typeof x === 'string') : [], tanguDataDir())
    let merged: Record<string, unknown> = {}
    try { merged = JSON.parse(await readFile(mcpFile(), 'utf8'))?.mcpServers || {} } catch { /* 读不回 = 没导入成 */ }
    const got = r.imported.filter((k) => k in merged)
    // 只把这次新导入的键合进写入那一刻的 mcp 段:上面播种读的是旧段,整段写回会盖掉在这之间落盘的 mcp:write / 引擎改动。
    // 同名以段里已有的为准(importer 按播种快照避让,之后别处写进来的同名不能被导入盖掉),返回值只报真落盘的。
    let landed: string[] = []
    if (got.length) {
      await saveHomeSection('mcp', (sec: any) => {
        landed = got.filter((k) => !(k in (sec?.mcpServers ?? {})))
        return { ...sec, mcpServers: { ...sec?.mcpServers, ...Object.fromEntries(landed.map((k) => [k, merged[k]])) } }
      })
    }
    return { ...r, imported: landed }
  }))

  // ── 直连 provider 管理(写 ~/.tangu/providers.json;managed 模式保存后重启后端加载)──
  ipcMain.handle('providers:list', () => readProvidersFile())
  ipcMain.handle('providers:save', async (_e, provider: DirectProviderConfig) => {
    if (!provider?.providerId || !provider?.baseUrl) throw new Error('providerId 与 baseUrl 必填')
    const list = await updateProvidersFile((cur) => {
      const i = cur.findIndex((p) => p.providerId === provider.providerId)
      if (i >= 0) cur[i] = provider
      else cur.push(provider)
      return cur
    })
    const stored = await loadConfig()
    if (stored.mode === 'managed') void ensureBackend()
    return list
  })
  ipcMain.handle('providers:delete', async (_e, providerId: string) => {
    const list = await updateProvidersFile((cur) => cur.filter((p) => p.providerId !== providerId))
    const stored = await loadConfig()
    if (stored.mode === 'managed') void ensureBackend()
    return list
  })

  // ── 桌面级共享语音转写(任意功能复用:聊天框、Amadeus…;本地/自带-key,不经引擎/服务端)──
  /** 转写一段音频。`timestamps` 不传 = 老行为(回字符串,语音输入用);传 true 回 { text, segments }。 */
  const runTranscribe = async (audio: Buffer, req: { mime?: string; modelId?: string; language?: string; timestamps?: boolean }) => {
    const cfg = await loadConfig()
    if (!audio.length) throw new Error('空音频')
    // 本地优先:选了本地且模型就绪 → 离线转写(不联网)。
    if (cfg.asrBackend === 'local' && localModelReady()) {
      return transcribeLocal(audio, { timestamps: req?.timestamps })
    }
    // 云端:自带 provider(<provider>/<model> 命中 providers.json)→ 主进程直连上游;否则走 Forsion 托管(计费)。
    const modelId = (req?.modelId || cfg.asrModelId || '').trim()
    const i = modelId.indexOf('/')
    const provider = i > 0 ? (await readProvidersFile()).find((p) => p.providerId === modelId.slice(0, i)) : undefined
    if (provider) {
      return transcribeViaOpenAI({ baseUrl: provider.baseUrl, apiKey: provider.apiKey, model: modelId.slice(i + 1), audio, mime: req?.mime || 'audio/wav', language: req?.language, timestamps: req?.timestamps })
    }
    // 非自带 provider = Forsion 托管模型(或未选,让服务端用 app asr 默认)→ 直连 Forsion 服务端(token 不下发 renderer)。
    const creds = loadTanguCreds()
    const cloudUrl = cfg.cloudUrl || creds.cloudUrl || ''
    const token = creds.token || ''
    if (!cloudUrl || !token) throw new Error('未设置语音识别:选一个自带 provider 的语音识别模型 + key,或登录 Forsion 用云端,或下载本地语音模型。')
    return transcribeViaForsion({ cloudUrl, token, modelId, audioB64: audio.toString('base64'), mime: req?.mime || 'audio/wav', language: req?.language, timestamps: req?.timestamps })
  }

  ipcMain.handle('asr:transcribe', async (_e, req: { audioBase64: string; mime?: string; modelId?: string; language?: string; timestamps?: boolean }) =>
    runTranscribe(Buffer.from(req?.audioBase64 || '', 'base64'), req || {}))

  // 按路径转写:视频转录动辄几十 MB WAV,走 base64 过 IPC 既撑爆消息又白涨 33%(且 fs:readFile 有 50MB 闸)。
  // 主进程直接读盘。路径由调用方给(与 fs:readFile 同口径,不额外设沙箱)。
  const transcribeFileByPath = async (filePath: string, req?: { mime?: string; modelId?: string; language?: string; timestamps?: boolean }) => {
    if (!filePath || typeof filePath !== 'string') throw new Error('非法的音频路径')
    const audio = await readFile(filePath)
    const ext = (filePath.split('.').pop() || '').toLowerCase()
    return runTranscribe(audio, { ...(req || {}), mime: req?.mime || (ext === 'wav' ? 'audio/wav' : ext === 'mp3' ? 'audio/mpeg' : ext === 'm4a' ? 'audio/mp4' : 'application/octet-stream') })
  }
  ipcMain.handle('asr:transcribeFile', async (_e, filePath: string, req?: { mime?: string; modelId?: string; language?: string; timestamps?: boolean }) =>
    transcribeFileByPath(filePath, req))
  // MCP 桥(transcribe_audio)复用同一条路径面:引擎侧 needs_asr 接力不再必须经渲染端插件。
  mcpTranscribeFile = (p, req) => transcribeFileByPath(p, req)

  // ── 本地语音模型(SenseVoice)下载 / 状态 / 删除。下载进度经 'asr:localProgress' 推回发起窗口。──
  // ── 侧边拼接(App Dock):open 谁都能调(命令面板入口);候选 / 贴靠 / 读划线只认面板窗口自己 ──
  ipcMain.handle('appDock:open', (e) => {
    if (!isTrustedSender(e)) return { ok: false }
    if (process.platform !== 'darwin') return { ok: false, error: 'unsupported_platform' }
    openDockWindow()
    return { ok: true }
  })
  ipcMain.handle('appDock:ready', (e) => (dockSender(e) ? dockState() : { target: null }))
  ipcMain.handle('appDock:candidates', async (e) => {
    if (!dockSender(e)) return { windows: [] }
    try {
      await ensureHelperRunning()
      const windows = normalizeDockCandidates(await askHelper(helperSocketPath(), { cmd: 'dockCandidates', excludePids: [process.pid] }, 5_000))
      dockOffered = new Set(windows.map((w) => `${w.pid}:${w.windowId}`))
      return { windows }
    } catch (err) {
      const code = (err as { code?: string }).code
      return { windows: [], error: code === 'unknown_command' ? 'unsupported_helper' : code || 'unavailable' }
    }
  })
  ipcMain.handle('appDock:attach', async (e, raw: unknown) => {
    const target = normalizeDockWindow(raw)
    if (!dockSender(e) || !target) return { ok: false }
    if (!dockOffered.has(`${target.pid}:${target.windowId}`)) return { ok: false, error: 'not_offered' }
    try { return await attachDock(target) } catch (err) { return { ok: false, error: (err as { code?: string }).code || 'unavailable' } }
  })
  ipcMain.handle('appDock:detach', (e) => {
    if (!dockSender(e)) return
    detachDock(); sendDockState()
  })
  ipcMain.handle('appDock:selection', async (e) => {
    if (!dockSender(e) || !dockTarget) return {}
    try {
      // 单独一条连接:读 AX 最慢要 1s,走跟随那条长连接会把这 1s 的位置更新全堵在后面。
      return normalizeDockSelection(await askHelper(helperSocketPath(), { cmd: 'selection', pid: dockTarget.pid, windowId: dockTarget.windowId }, 3_000))
    } catch (err) {
      return { error: (err as { code?: string }).code || 'unavailable' }
    }
  })

  // ── Computer Use:最近被操控窗口的一帧画面(只读,不启动 helper;详见 electron/computerUse.ts)──
  ipcMain.handle('computerUse:liveView', (_e, opts?: { maxDimension?: number; quality?: number; activeWithinMs?: number; image?: boolean }) =>
    computerUseLiveView(opts || {}),
  )

  ipcMain.handle('asr:localStatus', () => ({ ready: localModelReady(), sizeBytes: localModelSize() }))
  ipcMain.handle('asr:localDownload', async (e) => {
    const cfg = await loadConfig()
    await downloadLocalModel(cfg.mirror === 'china' ? 'china' : 'default', (received, total) => {
      if (!e.sender.isDestroyed()) e.sender.send('asr:localProgress', { received, total })
    })
    return { ok: true, ready: localModelReady() }
  })
  ipcMain.handle('asr:localRemove', async () => { await removeLocalModel(); return { ok: true } })

  ipcMain.handle('app:version', () => app.getVersion())
  // forsion:// 待处理队列:仅主窗顶层可拉(卫星窗不是 deep link 目标);拉过=就绪,后续直推。
  ipcMain.handle('deeplink:drain', (e) => {
    if (!isTrustedSender(e) || e.sender !== mainWindow?.webContents) return []
    deepLinkReady = true
    return drainDeepLinks()
  })

  // ── 应用内自动更新(electron-updater;检查 → 下载 → 重启安装。mac 仅检测,UI 引导手动下载)──
  ipcMain.handle('updater:check', () => checkAllUpdates())
  ipcMain.handle('updater:status', () => getUpdaterStatus())
  // 测试版通道开关。落 config.json 的 updater 段;updater.ts 每次检查现读,改完无需重启。
  ipcMain.handle('updater:getBeta', () => betaChannelOn())
  ipcMain.handle('updater:setBeta', async (_e, on: boolean) => {
    await saveHomeSection('updater', (sec: any) => ({ ...sec, beta: !!on }))
    return { ok: true }
  })
  ipcMain.handle('updater:download', () => downloadUpdate())
  ipcMain.handle('updater:install', async (e) => {
    if (!isTrustedSender(e)) throw new Error('forbidden')
    if (!canInstallUpdate() || getUpdaterStatus().phase !== 'downloaded') return { ok: false }
    return guardedRestart(true)
  })

  // 应用内「卸载 / 清空数据」(mac/linux 无 NSIS 卸载器,靠此;Windows 也可用)。清完 relaunch 为全新状态。
  //   tangu:  ~/.forsion(账号/设置/Agent 数据/会话/state.db)+ ~/Forsion 工作区 + ~/.tangu、~/Tangu 兼容软链
  //   desktop:userData 里的壳层配置(窗口/Amadeus)
  ipcMain.handle('app:clearData', async (_e, opts: { desktop?: boolean; tangu?: boolean }) => {
    isQuitting = true // 先封住排队中的拉起(ensureBackend 核对它):删库期间不能又被拉起来占住 state.db
    // 电脑历史先停:断订阅、丢缓冲、store 关门、等在途那笔写落定(封顶 10s)(app.exit 不发 before-quit;不停的话 1s 批量落盘
    // 会在删目录途中把 computer-history/events 建回来)。超时没落定的,删完目录后由 afterWipe 等它落定再删一次(见下)。
    const chWipe = computerHistory ? await stopComputerHistoryForWipe(computerHistory) : null
    await backend.stop() // 释放 state.db 句柄,否则占用删不掉
    await ensureChain // 在途那次收尾(它可能正要重建默认工作区目录)再删
    // 与配置写入同排一队:在途的写先落完再删;删完同一拍就退出,排在后面的写来不及把 config.json(含 apiKey)写回来
    await configQueue(async () => {
      if (opts?.tangu) {
        // 显式 TANGU_HOME=…/tangu 时 forsionHomeDir() 是推导出的父目录(可能是 ~ 或整块数据盘)→ 绝不整删,只删用户指定的那个。
        // ponytail: 该形态下父目录里的共享域文件(auth/config.json 等)会留下;要连带清就得逐项列共享域条目。
        for (const p of [process.env.TANGU_HOME || forsionHomeDir(), forsionWorkspaceDir(), join(homedir(), '.tangu'), join(homedir(), 'Tangu')]) {
          await rm(p, { recursive: true, force: true }).catch(() => {})
        }
        // 电脑历史根目录单独再删(显式 TANGU_HOME 时它不在上面删的目录里);在途写超时没落定的,等它落定后再删一次。
        // 就在配置队列里做:删完同一拍退出的约束不破。
        await chWipe?.afterWipe()
      }
      if (opts?.desktop) {
        // ⚠️ P1-K2 / G11:remote-lock.json **不在**清理列表 —— 清数据 = 不经系统认证解锁(远端锁定只能本机认证后解)
        for (const f of ['tangu-desktop-config.json', 'amadeus-config.json', REMOTE_SESSIONS_FILE]) { // P1-K4:remote-sessions.json(重置远程会话开关与信任)
          await rm(join(app.getPath('userData'), f), { force: true }).catch(() => {})
        }
        await deviceSecrets.wipe().catch(() => {}) // P1-K5:device-secrets.json(配对 / external token)
      }
    })
    app.relaunch()
    app.exit(0)
    return { ok: true }
  })

  // ── Forsion Market ──
  // 浏览/详情/安装全在主进程:有 cloudUrl + 文件系统 + 免 CORS。浏览端点公开(无需 token)。

  /** 服务端给的 iconUrl 是相对路径(它不知道自己的公网地址);渲染层的 <img> 直连,所以在这里拼成绝对地址。
   *  base 无尾斜杠、iconUrl 以 /api 开头,直接相接即可。图标是公开端点,不带 token。 */
  const absIcon = <T extends { iconUrl?: string | null }>(base: string, it: T): T => {
    if (it?.iconUrl && it.iconUrl.startsWith('/')) it.iconUrl = `${base}${it.iconUrl}`
    return it
  }

  ipcMain.handle('market:list', async (_e, type?: string) => {
    const base = await marketBase()
    const q = type ? `?type=${encodeURIComponent(type)}` : ''
    const r = await fetch(`${base}/api/market/items${q}`, { headers: { 'User-Agent': MARKET_UA } })
    if (!r.ok) throw new Error(`加载失败 HTTP ${r.status}`)
    const data = (await r.json()) as { items?: Array<{ iconUrl?: string | null }> }
    for (const it of data.items || []) absIcon(base, it)
    return data // { items }
  })

  ipcMain.handle('market:detail', async (_e, id: string) => {
    const base = await marketBase()
    const r = await fetch(`${base}/api/market/items/${encodeURIComponent(id)}`, { headers: { 'User-Agent': MARKET_UA } })
    if (!r.ok) throw new Error(`加载失败 HTTP ${r.status}`)
    return absIcon(base, (await r.json()) as { iconUrl?: string | null })
  })

  // 安装进度推回发起窗口('market:installProgress',同 asr:localProgress 口径):市场住在独立浮窗里,
  // 全局通知在那里不渲染,按钮上的阶段/字节 + 市场自己的提示条是用户唯一看得见的反馈。
  ipcMain.handle('market:install', async (e, id: string) => marketPluginUpdater.exclusive(async () => {
    if (!isTrustedSender(e)) throw new Error('Untrusted sender')
    let lastSent = 0
    const report = (phase: 'resolve' | 'download' | 'install', p?: DownloadProgress): void => {
      const now = Date.now()
      if (phase === 'download' && p && p.received > 0 && now - lastSent < 120) return // 字节进度限流,换阶段/换候选必发
      lastSent = now
      if (!e.sender.isDestroyed()) e.sender.send('market:installProgress', { id, phase, ...p })
    }
    report('resolve')
    const { info, buf } = await downloadMarketPackage(id, report)
    report('install')
    // 后端 category 对插件家族可能误标(Forsion 插件标成引擎 'plugin')→ 按包内 manifest 实测重定,
    // 否则装进错误目录后两边加载器都不认。返回 effType 让渲染层走对应的装后流程(引擎重扫 / amadeus 重载)。
    const effType = await detectMarketType(buf, info.type)
    const dest = join(tanguHomeDir(), MARKET_SUBDIR[effType], info.installSlug)
    // 内置包(播种进 plugins/<id>)不许从市场再装:解压是原地覆盖,所以要在写入**之前**拒 —— 目标目录就是已播种的那份
    // (slug = 内置 id,或目录里的 manifest 是内置 id)时,覆盖再回滚会把它连同用户数据一起删掉。
    const occupant = await readFile(join(dest, 'manifest.json'), 'utf8').then((s) => JSON.parse(s)?.id, () => undefined)
    if (builtinPluginIds().has(info.installSlug) || (typeof occupant === 'string' && builtinPluginIds().has(occupant))) throw new Error('install: builtin')
    const files = await extractZipToDir(buf, dest, MARKET_MANIFEST[effType] || [])
    // 插件家族:清掉同 slug 在「另一插件目录」里那份**误装的旧副本**(修复前 Forsion 插件被装进引擎位等),
    // 消除 split-brain 双份。⚠ 身份守卫:若那份带对方类型的合法 manifest(是恰好同 slug 的**另一个合法插件**),
    // 绝不删 —— 宁可留一份陈旧也不误删他人插件(install_slug 无全局唯一约束,跨类型可能撞名)。
    if (effType === 'plugin' || effType === 'amadeus-plugin') {
      const otherType = effType === 'plugin' ? 'amadeus-plugin' : 'plugin'
      const otherDir = join(tanguHomeDir(), MARKET_SUBDIR[otherType], info.installSlug)
      // 仅当「对方类型 manifest 确实不存在(ENOENT)」才判为误装旧副本并删除:读到=合法插件保留;
      // 其它错误(EACCES/EIO/锁定等)不确定 → 保守保留,绝不因一时读不到就删掉可能合法的插件(codex R3)。
      const staleMisinstall = await readFile(join(otherDir, MARKET_MANIFEST[otherType][0]), 'utf8')
        .then(() => false)
        .catch((e: NodeJS.ErrnoException) => e?.code === 'ENOENT')
      if (staleMisinstall) await rm(otherDir, { recursive: true, force: true }).catch(() => {})
    }
    // Forsion 插件带回装载器认的那个 id(manifest id 不合法时回落目录名,与 listPlugins 同一条规则):
    // 渲染层要按 id 通知别的窗口重载 —— 同版本重装比不出版本差,只能点名。
    const pluginId = effType === 'amadeus-plugin'
      ? effectivePluginId(info.installSlug, await readFile(join(dest, 'manifest.json'), 'utf8').then((s) => JSON.parse(s)?.id, () => undefined))
      : null
    // 包内 manifest 的 id 是内置 id(slug 不同的第二份同 id 副本,两边加载器谁先扫到谁赢)→ 也拒;上面已保证 dest 不是内置那份,删它安全。
    if (pluginId && builtinPluginIds().has(pluginId)) {
      await rm(dest, { recursive: true, force: true }).catch(() => {})
      throw new Error('install: builtin')
    }
    await marketPluginUpdater.forget(effType, info.installSlug, false)
    return { ok: true, path: dest, files, type: effType, slug: info.installSlug, ...(pluginId ? { id: pluginId } : {}) }
  }))

  ipcMain.handle('market:updateStatus', (e) => {
    if (!isTrustedSender(e)) throw new Error('Untrusted sender')
    return marketPluginUpdater.snapshot()
  })
  ipcMain.handle('market:setAutoUpdate', async (e, id: string, on: boolean) => {
    if (!isTrustedSender(e)) throw new Error('Untrusted sender')
    const state = await marketPluginUpdater.setAutoUpdate(id, on)
    if (on) void marketPluginUpdater.check().catch((err) => console.warn('[market-updates]', err))
    return state
  })
  ipcMain.handle('market:checkUpdates', (e) => {
    if (!isTrustedSender(e)) throw new Error('Untrusted sender')
    return marketPluginUpdater.check()
  })
  if (PRODUCT.market) setTimeout(() => {
    void marketPluginUpdater.check().catch((e) => console.warn('[market-updates]', e))
    setInterval(() => void marketPluginUpdater.check().catch((e) => console.warn('[market-updates]', e)), 6 * 3600_000).unref()
  }, 60_000).unref()

  ipcMain.handle('market:installed', async () => {
    // 每个已装项带版本号(读其 manifest),供市场「可更新」检查;插件另带装载 id(目录名可 ≠ id),供「打开设置」直达。
    const out: Record<string, Array<{ slug: string; version: string | null; id?: string }>> = { skill: [], agent: [], plugin: [], space: [], theme: [], 'amadeus-plugin': [] }
    for (const [type, sub] of Object.entries(MARKET_SUBDIR)) {
      try {
        const base = join(tanguHomeDir(), sub)
        const ents = await readdir(base, { withFileTypes: true })
        out[type] = await Promise.all(
          ents.filter((e) => e.isDirectory()).map(async (e) => {
            const id = await readInstalledPluginId(type, join(base, e.name))
            return { slug: e.name, version: await readInstalledVersion(type, join(base, e.name)), ...(id ? { id } : {}) }
          }),
        )
      } catch {
        /* 目录不存在 = 空 */
      }
    }
    return out
  })

  // 卸载市场项:删掉安装目录。**只删 MARKET_SUBDIR 白名单里的目录**(marketItemDir 校验 type+slug,
  // 拒绝即 null) —— 目录不存在直接报错而不是静默成功,否则用户会以为卸载了、其实装在别处。
  // ⚠️ 插件家族:同 slug 可能因历史误标同时躺在引擎位与 Forsion 位。这里**只删调用方指明的那一个**,
  //    渲染层按 installedInfo 算出的 realType 传值;不做跨目录清扫(那是 market:install 的职责,它有身份守卫)。
  ipcMain.handle('market:uninstall', async (e, type: string, slug: string) => marketPluginUpdater.exclusive(async () => {
    if (!isTrustedSender(e)) throw new Error('Untrusted sender')
    const dir = marketItemDir(tanguHomeDir(), type, slug)
    if (!dir) throw new Error('非法的卸载目标')
    if (!existsSync(dir)) throw new Error('该项不在已安装目录中')
    // Space 带回配方 id(目录名可 ≠ id):各窗 ribbon 按它撤 —— loadUserSpaces 只增不撤用户 Space,删除一律走 space-removed。
    const spaceId = type === 'space' ? await readFile(join(dir, 'space.json'), 'utf8').then((s) => JSON.parse(s)?.id, () => undefined) : undefined
    await rm(dir, { recursive: true, force: true })
    await marketPluginUpdater.forget(type, slug)
    return { ok: true, path: dir, type, ...(typeof spaceId === 'string' && spaceId ? { id: spaceId } : {}) }
  }))

  // ── 用户自定义 Space:~/.tangu/spaces/<slug>/space.json(纯数据布局配方;market type='space' 装到同目录)──
  // 另汇入 Forsion 插件捆绑包内嵌的 Space(plugins/<id>/spaces/<slug>/space.json,带 plugin=manifest id):
  // 用户目录条目在前(同 spec id 先到先得,用户版本胜);渲染层按插件启停显隐、不提供单独删除。
  ipcMain.handle('spaces:list', () => readSpacesList())
  ipcMain.handle('spaces:save', async (_e, slug: string, json: string) => {
    if (!isSafeSlug(slug)) throw new Error('invalid-space-id') // 原因码,渲染层 ipcErrorText 译
    JSON.parse(json) // 落盘前校验合法 JSON,防写入损坏配方
    const dir = join(tanguHomeDir(), 'spaces', slug)
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, 'space.json'), json, 'utf8')
    return { ok: true }
  })
  ipcMain.handle('spaces:delete', async (_e, slug: string) => {
    if (!isSafeSlug(slug)) throw new Error('invalid-space-id') // 原因码,渲染层 ipcErrorText 译
    await rm(join(tanguHomeDir(), 'spaces', slug), { recursive: true, force: true })
    return { ok: true }
  })

  // ── 后端插件卸载:只动 ~/.tangu/plugins(用户目录);<pkg>/plugins 首方插件结构性安全(不在这里,删不到)。
  // manifest id 可能 ≠ 目录名,须读 manifest 映射。设置清理走后端 DELETE /agent/plugins/:id,重启由前端触发。
  ipcMain.handle('plugins:userInstalled', () => readUserPluginDirs(join(tanguDataDir(), 'plugins')))
  ipcMain.handle('plugins:uninstall', async (_e, id: string) => marketPluginUpdater.exclusive(async () => {
    if (!isSafeSlug(id)) throw new Error('invalid-plugin-id') // 原因码,渲染层 ipcErrorText 译
    const hit = (await readUserPluginDirs(join(tanguDataDir(), 'plugins'))).find((p) => p.id === id)
    if (!hit) throw new Error('not-user-plugin') // 内置/首方插件不可卸载
    await marketPluginUpdater.forget('plugin', hit.slug)
    await rm(join(tanguDataDir(), 'plugins', hit.slug), { recursive: true, force: true })
    return { ok: true }
  }))

  // provider OAuth(xAI 等):动态 import 包 dist 的 providerOAuth(dev=包根 dist,打包=resources/tangu-server/dist),
  // 与 `tangu login <provider>` 同一实现、同一份 ~/.tangu/provider-auth.json。
  const providerOAuthModule = async (): Promise<any> => {
    // dev 后端从 ~/.forsion-dev/tangu 起，但 Electron 主进程本身不经 BackendManager.spawn，
    // 因此须在动态导入前补同一 TANGU_HOME；否则 OAuth 会静默写到正式 ~/.forsion，dev 引擎永远读不到。
    // 此处在启动迁移之后才绑定，避免把 dev 迁移路径误判成用户手动重定向。
    bindDevTanguHome()
    const entry = BackendManager.resolveEntry()
    if (!entry) throw new Error('找不到 tangu-server dist(dev 下请先在包根 npm run build)')
    const distRoot = dirname(dirname(entry)) // …/dist/standalone/main.js → …/dist
    return import(pathToFileURL(join(distRoot, 'llm', 'providerOAuth.js')).href)
  }

  ipcMain.handle('auth:providers', async () => {
    try {
      const m = await providerOAuthModule()
      const ids: string[] = Object.keys(m.OAUTH_PROVIDERS || {})
      const logged = new Set<string>()
      try {
        const credsPath = join(forsionHomeDir(), 'provider-auth.json')
        const raw = JSON.parse(await readFile(credsPath, 'utf8'))
        for (const k of Object.keys(raw || {})) logged.add(k)
      } catch { /* 未登录过 */ }
      return ids.map((id) => ({ id, loggedIn: logged.has(id) }))
    } catch {
      return []
    }
  })

  ipcMain.handle('auth:providerLogin', async (_e, id: string) => {
    const m = await providerOAuthModule()
    const p = m.OAUTH_PROVIDERS?.[id]
    if (!p) throw new Error(`未知 provider: ${id}`)
    await m.providerOAuthLogin(p) // loopback+PKCE,自动开浏览器,落盘 provider-auth.json
    const stored = await loadConfig()
    // await(不是 void):provider 只在引擎启动时装载一次,IPC 必须等重启完成才返回,
    // 否则渲染层拿到 ok 就去拉模型目录 —— 打的还是正在被杀的旧端口。
    if (stored.mode === 'managed') await ensureBackend() // 重启让后端加载该 provider
    return { ok: true, id }
  })

  backend.onStatus((st) => {
    for (const w of BrowserWindow.getAllWindows()) {
      w.webContents.send('backend:status', st)
    }
    remoteSafety.engineStatusChanged() // P1-K2:重连活动流;有没送到的急停 / 解锁就补
    unitHub?.engineChanged() // P1-K7a:引擎起停 / 崩溃 → 名册的 caps.engine
    // 引擎刚就绪:补一次本机项目根种子。开机时设备互联常比引擎先起,那一次 ensureSeeded 拿不到引擎就返回了;
    // 不补的话 caps 一直报「在启动」,要等第一条远端请求经 seedGatedEngine 才顺手种(0.6 Codex 评审 P2 的 e2e 钉出来的)。
    if (st.state === 'ready' && unitWeb) void unitSessionRootsSource().ensureSeeded().then(() => unitHub?.engineChanged())
  })

  // ~/.forsion/auth.json 是登录态唯一真源(桌面与 CLI `tangu login` 共写)。watch 它:任何来源的凭证
  // 变化(终端 tangu login / logout、手工改文件)也走与桌面登录同一条传播链——广播渲染层 + managed
  // 后端带新 token 重启(token 经 env 快照注入,重启是唯一传播手段)+ 踢 Amadeus 云同步(accountCore.ts)。
  // 桌面自己的登录/登出(Extend 的 auth:* 通道经 accountCommit / accountClear)已先行处理并更新去重快照,watcher 比对相同即跳过,不会二次重启。
  try {
    mkdirSync(forsionHomeDir(), { recursive: true })
    fsWatch(forsionHomeDir(), (_ev, fname) => { if (!fname || fname === "auth.json") accountCore.onAuthFileMaybeChanged() })
  } catch (e) {
    console.error("[auth] auth.json watcher 注册失败(外部登录变化需重启 App 才生效):", e)
  }

  // ── 多窗口 IPC:独立窗 + mini 卡片 + floating 面板 ──
  ipcMain.on('window:cursorScreenPoint', (e) => {
    const point = isTrustedSender(e) ? screen.getCursorScreenPoint() : { x: 0, y: 0 }
    e.returnValue = { screenX: point.x, screenY: point.y }
  })
  ipcMain.handle('window:detachedReady', (_e, id: string) => {
    const v = pendingDetachedViews.get(String(id)) || []
    pendingDetachedViews.delete(String(id))
    return v
  })
  ipcMain.handle('window:openDetached', (_e, views: ViewDesc[], at?: { screenX: number; screenY: number }, opts?: { space?: unknown }) => {
    const list = Array.isArray(views) ? views.filter((v) => v && typeof v.type === 'string') : []
    // 整个 Space 开窗(Ribbon 的右键 / ⌘·Ctrl 点击 / 拖出):不带初始视图,窗口自己进那个 Space
    const space = typeof opts?.space === 'string' && SPACE_ID.test(opts.space) ? opts.space : undefined
    const at2 = at && Number.isFinite(at.screenX) && Number.isFinite(at.screenY) ? at : undefined
    const bounds = at2 ? { x: Math.round(at2.screenX), y: Math.round(at2.screenY), width: space ? 1100 : 900, height: space ? 760 : 680 } : undefined
    return { id: createDetachedWindow(space ? { space, bounds } : { views: list, bounds }) }
  })
  ipcMain.on('window:openMini', (e, raw: unknown) => {
    if (!isTrustedSender(e)) return
    toggleMiniWindow(normalizeMiniOpenOptions(raw))
  })
  ipcMain.handle('window:openFloating', (e, raw: unknown) => {
    if (!isTrustedSender(e)) return undefined
    return openFloatingPanel(raw)
  })
  ipcMain.handle('window:floatingReady', (e, rawId: unknown) => {
    if (!isTrustedSender(e) || typeof rawId !== 'string') return undefined
    const id = rawId.slice(0, 256)
    const win = floatingWindows.get(id)
    return win?.webContents === e.sender ? floatingTargets.get(id) : undefined
  })
  ipcMain.on('window:miniReady', (e) => {
    if (isTrustedSender(e) && e.sender === miniWindow?.webContents && miniTarget) e.sender.send('window:miniTarget', miniTarget)
    if (isTrustedSender(e) && e.sender === autoMiniWindow?.webContents && autoMiniSessionId) e.sender.send('window:miniTarget', { sessionId: autoMiniSessionId })
  })
  ipcMain.on('window:miniSession', (e, raw: unknown) => {
    if (!isTrustedSender(e) || e.sender !== mainWindow?.webContents) return
    const prevSession = miniSession.sessionId
    miniSession = normalizeMiniSessionContext(raw)
    miniAutoPanel?.refresh()
    if (miniSession.sessionId !== prevSession) syncSessionPanels()
  })
  ipcMain.on('window:miniSessionReady', (e, sessionId: unknown) => {
    if (!isTrustedSender(e) || e.sender !== autoMiniWindow?.webContents || typeof sessionId !== 'string') return
    miniAutoPanel?.refresh()
    if (sessionId === autoMiniSessionId && miniAutoPanel?.wants(sessionId)) autoMiniWindow?.showInactive()
  })
  ipcMain.on('window:showMainPanel', (e, raw: unknown) => {
    if (!isTrustedSender(e) || !raw || typeof raw !== 'object') return
    const target = raw as MainPanelTarget
    if (typeof target.type !== 'string' || !target.type || target.type.length > 256) return
    pendingMainPanelTarget = { type: target.type, spaceId: typeof target.spaceId === 'string' ? target.spaceId : undefined,
      params: target.params && typeof target.params === 'object' && !Array.isArray(target.params) ? target.params : {} }
    showMainWindow()
    if (mainPanelReady && mainWindow) {
      mainWindow.webContents.send('window:mainPanelTarget', pendingMainPanelTarget)
      pendingMainPanelTarget = null
    }
  })
  ipcMain.on('window:mainPanelReady', (e) => {
    if (!isTrustedSender(e) || e.sender !== mainWindow?.webContents) return
    mainPanelReady = true
    if (pendingMainPanelTarget) { e.sender.send('window:mainPanelTarget', pendingMainPanelTarget); pendingMainPanelTarget = null }
  })
  ipcMain.on('window:mainAction', (e, rawAction: unknown, rawPayload: unknown) => {
    const req = isTrustedSender(e) ? normalizeMainAction(rawAction, rawPayload) : undefined
    if (!req) return
    // 只有要用户回主窗看结果的才把主窗抢到前面:重开引导、带着草稿 / 引用去聊天、打开 Agent。其余(⌘K 重算、测试通知卡、恢复布局、
    // 成就弹窗、撤 Space)用户还在设置浮窗里,别打断。
    if (req.action === 'onboarding' || req.action === 'chat-draft' || req.action === 'chat-quote' || req.action === 'open-agents' || req.action === 'open-agent') showMainWindow()
    const deliver = (): void => {
      // extensions-changed 也要到两扇 mini(手开的 / 自动弹的):它们和分离窗一样各握一份插件实例(见 amadeusPlugins.ts)。
      const recipients = req.action === 'skills-changed' || req.action === 'agents-changed' || req.action === 'extensions-changed'
        ? [mainWindow, miniWindow, autoMiniWindow, ...detachedWindows.values(), ...floatingWindows.values()]
        : [mainWindow]
      for (const win of recipients) if (win && !win.isDestroyed() && !win.webContents.isDestroyed() && win.webContents !== e.sender) {
        win.webContents.send('window:mainAction', req.action, req.payload)
      }
    }
    if (mainWindow?.webContents.isLoadingMainFrame()) mainWindow.webContents.once('did-finish-load', deliver)
    else deliver()
  })
  // 界面跨窗同步:设置是独立浮窗(各窗一份 store 与 DOM),在那儿改主题/字体/缩放/光标/语言只改得动
  // 它自己。发方带值,本进程**重建**成已知字段后转给其余窗口(这条缝插件也够得着,原样转发等于让它
  // 把任意对象放大到所有窗口);不回发发方 —— 它已经是最新的,回放只会跟自己在飞的操作抢。
  ipcMain.on('ui:sync', (e, raw: unknown) => {
    if (!isTrustedSender(e)) return
    const state = normalizeUiSync(raw)
    if (!state) return
    // ⚠️ 不从 prefs['tangu_locale'] 取主进程语言(P1-KF):那是手选键,任何字体 / 缩放广播都带着它的 null → 曾把中文界面的主进程文案重置成系统英文。
    // 语言走下面的 ui:locale(发方窗口自己切语言时 i18n.tsx 会报;收方重放后也会再报一次同值,主进程同值不动)。
    for (const w of BrowserWindow.getAllWindows()) {
      if (w.webContents !== e.sender && !w.webContents.isDestroyed()) w.webContents.send('ui:sync', state)
    }
  })
  // P1-KF:渲染层的生效界面语言(四级链的结论)→ 主进程文案(托盘 / 系统通知 / 对话框 / 远程会话确认框,全走 mt())。
  ipcMain.on(UI_LOCALE_CHANNEL, (e, v: unknown) => {
    if (!isTrustedSender(e)) return
    uiLocale.report(v)
  })
  ipcMain.on('window:closeSelf', (e) => BrowserWindow.fromWebContents(e.sender)?.close())
  // 系统浏览器兜底(内置浏览器关掉 / mini 窗 / 用户点「用系统浏览器打开」);只放 http(s),
  // 别的 scheme 经 openExternal 等于让页面唤起任意本机协议处理器。scheme 用 URL 解析比对,
  // 不靠正则(`https:/\evil` 之类畸形串别指望正则拿捏)。
  ipcMain.handle('shell:openExternal', (e, url: string) => {
    if (!isTrustedSender(e)) return
    if (isHttpUrl(url)) void shell.openExternal(url)
  })
  // 屏幕共享选源:把可共享的屏幕/窗口连缩略图交给渲染层,由它画选择器(见上面的 handler)。
  ipcMain.handle('screenShare:sources', async (e) => {
    if (!isTrustedSender(e)) return []
    const sources = await desktopCapturer.getSources({
      types: ['screen', 'window'],
      thumbnailSize: { width: 320, height: 180 },
    })
    return sources.map((s) => ({
      id: s.id,
      name: s.name,
      // 缩略图转 dataURL:渲染层 CSP 的 img-src 放行 data:,直接 <img src> 即可。
      thumbnail: s.thumbnail.isEmpty() ? '' : s.thumbnail.toDataURL(),
      isScreen: s.id.startsWith('screen:'),
    }))
  })
  ipcMain.on('screenShare:select', (e, id: unknown) => {
    if (!isTrustedSender(e)) return
    const wcId = e.sender.id
    if (typeof id === 'string' && id) {
      pendingShareSource.set(wcId, { id, at: Date.now() })
      // 窗口没走完共享流程就关掉时把条目带走 —— webContents.id 会被复用,留着等于把
      // 上一个窗口选的屏幕交给下一个窗口。once:同一 wc 多次 select 不会堆监听。
      if (!e.sender.isDestroyed()) e.sender.once('destroyed', () => pendingShareSource.delete(wcId))
    } else pendingShareSource.delete(wcId)
  })
  // 外部日历订阅(.ics)必须在主进程拉:Google / Outlook / Apple 的订阅地址都不发 CORS 头,
  // 渲染层直接 fetch 一律被浏览器拦下。`webcal://` 是历史别名,等价 https。
  //
  // ⚠️ 这是一条「渲染层给什么地址,主进程就去请求什么地址」的通道 —— 不设防就是现成的 SSRF:
  // 订阅 `http://127.0.0.1:<端口>/…` 能探测本机服务,`169.254.169.254` 是云元数据端点。所以
  //  · 逐跳自己跟重定向(redirect:'manual'),**每一跳都重新校验**(只校验首个地址等于没校验);
  //  · 每跳都把主机名解析成 IP 再比对,挡住回环/私网/链路本地/保留段(以及解析到私网的公网域名);
  //  · 流式累计字节,超限当场断开 —— 先 arrayBuffer() 再判大小的话,内存早就吃完了。
  ipcMain.handle('calendar:fetchIcs', async (e, url: string) => {
    if (!isTrustedSender(e)) return { ok: false, error: 'untrusted sender' }
    let target = typeof url === 'string' ? url.trim().replace(/^webcal:\/\//i, 'https://') : ''
    if (!isHttpUrl(target)) return { ok: false, error: '只支持 http(s):// 或 webcal:// 地址' }
    const MAX = 8 * 1024 * 1024
    try {
      let res: Response | null = null
      for (let hop = 0; hop < 5; hop++) {
        const bad = await privateHostReason(new URL(target).hostname)
        if (bad) return { ok: false, error: bad }
        res = await fetch(target, { redirect: 'manual', signal: AbortSignal.timeout(20_000) })
        if (res.status < 300 || res.status >= 400) break
        const loc = res.headers.get('location')
        if (!loc) break
        void res.body?.cancel()
        target = new URL(loc, target).toString()
        if (!isHttpUrl(target)) return { ok: false, error: '重定向到了不支持的地址' }
        res = null
      }
      if (!res) return { ok: false, error: '重定向次数过多' }
      if (!res.ok) return { ok: false, error: `HTTP ${res.status}` }
      const chunks: Buffer[] = []
      let n = 0
      const reader = res.body?.getReader()
      if (reader) {
        for (;;) {
          const { done, value } = await reader.read()
          if (done) break
          n += value.byteLength
          if (n > MAX) { void reader.cancel(); return { ok: false, error: '日历文件过大(> 8MB)' } }
          chunks.push(Buffer.from(value))
        }
      }
      return { ok: true, text: Buffer.concat(chunks).toString('utf8') }
    } catch (err: unknown) {
      return { ok: false, error: (err as Error)?.message || String(err) }
    }
  })
  // 主页 Bing 壁纸:与可输入 URL 的日历通道分开 —— 目标域名、路径、市场都在主进程收口,
  // renderer 只能选语言和数量,没有 SSRF 面。图片本身由 Chromium 直接加载 Bing https URL。
  ipcMain.handle('wallpaper:listBing', async (e, market?: string, count?: number) => {
    if (!isTrustedSender(e)) return { ok: false, items: [], error: 'untrusted sender' }
    const mkt = market === 'en-US' ? 'en-US' : 'zh-CN'
    const n = Math.max(1, Math.min(8, Math.floor(Number(count) || 8)))
    try {
      const response = await fetch(`https://www.bing.com/HPImageArchive.aspx?format=js&idx=0&n=${n}&mkt=${mkt}`, {
        signal: AbortSignal.timeout(15_000),
      })
      if (!response.ok) return { ok: false, items: [], error: `HTTP ${response.status}` }
      const body = await response.json() as { images?: Array<Record<string, unknown>> }
      const items = (Array.isArray(body.images) ? body.images : []).flatMap((raw) => {
        const base = typeof raw.urlbase === 'string' && raw.urlbase.startsWith('/') ? raw.urlbase : ''
        const relative = typeof raw.url === 'string' && raw.url.startsWith('/') ? raw.url : ''
        const url = base ? `https://www.bing.com${base}_UHD.jpg` : relative ? `https://www.bing.com${relative}` : ''
        if (!url) return []
        return [{
          id: typeof raw.startdate === 'string' ? raw.startdate : (base || url),
          url,
          thumbnailUrl: base ? `https://www.bing.com${base}_400x240.jpg` : url,
          title: typeof raw.title === 'string' ? raw.title : '',
          copyright: typeof raw.copyright === 'string' ? raw.copyright : '',
          startDate: typeof raw.startdate === 'string' ? raw.startdate : '',
        }]
      })
      return { ok: true, items }
    } catch (error) {
      return { ok: false, items: [], error: error instanceof Error ? error.message : String(error) }
    }
  })
  // 跨窗撕拽:实时坐标 → 命中窗口显落点预览、其余清除。
  ipcMain.on('window:dragUpdate', (e, p: { screenX: number; screenY: number; view: ViewDesc }) => {
    const src = BrowserWindow.fromWebContents(e.sender)
    const target = windowAtPoint(p.screenX, p.screenY, src)
    for (const w of dockviewWindows()) {
      if (w === src) continue
      if (w === target) { const b = w.getBounds(); w.webContents.send('window:dragPreview', { localX: p.screenX - b.x, localY: p.screenY - b.y }) }
      else w.webContents.send('window:dragPreview', null)
    }
  })
  // 跨窗撕拽:最终落点路由。命中另一 dockview 窗 → acceptView 并入;空桌面 → 建新独立窗;都算已路由(源窗关 panel)。
  ipcMain.handle('window:dropView', (e, p: { screenX: number; screenY: number; view: ViewDesc }) => {
    clearAllDragPreview()
    if (!p?.view || typeof p.view.type !== 'string') return { routed: false }
    const src = BrowserWindow.fromWebContents(e.sender)
    const target = windowAtPoint(p.screenX, p.screenY, src)
    if (target) {
      console.log('[win] dropView → merge into existing', target.id)
      target.webContents.send('window:acceptView', p.view)
      target.focus()
      return { routed: true }
    }
    console.log('[win] dropView → new detached window')
    createDetachedWindow({ views: [p.view], bounds: { x: Math.round(p.screenX), y: Math.round(p.screenY), width: 900, height: 680 } })
    return { routed: true }
  })
  // mini 全局快捷键(默认 ⌘/Ctrl+⇧+M;register 返回 false=被占用,吞掉不阻塞启动)。
  try { globalShortcut.register('CommandOrControl+Shift+M', () => toggleMiniWindow()) } catch { /* 快捷键冲突 */ }
  if (PRODUCT.agentBackend) approvalDelivery.start() // P1-K3:订阅本机引擎待批流(引擎未就绪时 idle,ready 后自连)
  if (PRODUCT.agentBackend) void remoteSafety.start() // P1-K2:读锁文件(跨重启)→ 注册急停热键 ⌃⌥⇧.(失败托盘 / 设置页可见)→ 订引擎活动流

  // 启动即续期(2 周滑动窗口),且**必须先于 ensureBackend**:后端 token 走 env 快照,而本地端点鉴权
  // 是**逐字比对**那枚快照 —— 续期把 auth.json 换成新的、引擎手上还是旧串,渲染层(getConfig 实时读
  // auth.json)一连就整片 401,表现为「本地会话列表加载失败 + 假的『登录已过期』」。开窗不等这条
  // (4s 封顶,离线不拖启动);无需续期时(1h 内换过)立即落到 finally,后端照常即刻起。
  void accountCore.refresh(4000).catch(() => {}).finally(() => { void ensureBackend() })
  setInterval(() => { void accountCore.refresh() }, 24 * 3600_000) // 一直开着不关的也算「在用软件」
  // MCP 服务常驻、随 App 启动(引擎的 ASR 桥要用);外部面按设置「高级」开关(默认关)。开关值在 lifecycle 队列里现读:
  // 若先读到旧值、用户又在读完前切了开关,旧值作废(见 createMcpLifecycle)。不依赖后端就绪,工具调用时现取引擎地址。
  void applyForsionMcp(async () => (await loadConfig()).mcpEnabled)
  // ⚠️必须**先于** createWindow / restoreDetachedWindows:恢复的终端 tab 一挂载就 pty:spawn,
  // 那时 handler 还没注册的话 IPC 直接「No handler registered」,视图落进已退出态且不会重试。
  registerPtyIpc(isTrustedSender)
  if (PRODUCT.agentBackend && process.platform === 'darwin') {
    miniAutoPanel = startMiniAutoPanel({
      readForeground: readComputerUseForeground,
      // 用户按住自动 Mini 拖走时焦点落在它自己身上 —— 不算「回到 Forsion」,否则一拖就收起。
      hasForsionFocus: () => { const w = BrowserWindow.getFocusedWindow(); return !!w && w !== autoMiniWindow },
      manualMiniVisible: () => !!miniWindow && !miniWindow.isDestroyed() && miniWindow.isVisible(),
      session: () => miniSession,
      open: openAutoMini, close: closeAutoMini,
    })
    app.on('browser-window-focus', (_e, w) => { if (w !== autoMiniWindow) lastFocusedWindow = w; miniAutoPanel?.refresh() })
  }
  createWindow()
  void restoreDetachedWindows() // 恢复上次退出时的独立窗(位置/尺寸 + 各窗自恢复布局)
  // 系统托盘 / mac 菜单栏图标:显示窗口 / 检查更新 / 退出。
  const ch = computerHistory
  createTray({
    show: showMainWindow,
    checkUpdates: () => { void checkAllUpdates() },
    quit: () => { isQuitting = true; app.quit() },
    computerHistory: ch ? {
      state: () => ch.view().state,
      pauseHour: () => { void ch.pause(3_600_000).catch(() => {}) },
      resume: () => { void ch.resume().catch(() => {}) },
    } : undefined,
    remote: PRODUCT.agentBackend ? remoteSafety.trayHandlers(openRemoteSafetySettings) : undefined, // P1-K2:远程会话运行中 · 设备名 / 停止全部 / 解锁
  })
  // Amadeus Space:装载 vault IPC(暴露给 window.amadeus)+ 资产协议(指向当前 vault 根)。
  const { getVaultRoot, restartSync, stopSync, readExternalPlugins, vaultFace } = registerAmadeusIpc(() => mainWindow, amadeusSyncFactory)
  amadeusReadPlugins = readExternalPlugins
  amadeusVaultFace = vaultFace
  void refreshUnitHost() // 「允许其他设备连接本机」开着就恢复出站通道
  restartAmadeusSync = restartSync
  stopAmadeusSync = stopSync
  registerAmadeusAssetProtocol(getVaultRoot)
  registerRemoteSync() // 本地库远程同步(remotely-save 式;隔离层见 electron/remotesync/)
  app.on('activate', () => showMainWindow()) // dock/tray 唤起:隐藏则显示,销毁则重建
  // GPU 进程崩溃(Windows 驱动 TDR / 睡眠恢复常见)会级联拖垮渲染器 → 白屏。监听并自愈。
  app.on('child-process-gone', (_e, d) => {
    console.error('[tangu-desktop] child-process-gone', d.type, d.reason)
    if (d.type === 'GPU' && d.reason !== 'clean-exit') recoverRenderer(`gpu-gone:${d.reason}`)
  })
})

app.on('before-quit', (e) => {
  isQuitting = true // 放行 window close 拦截(否则 hide 会吞掉退出)
  for (const state of persistedDetached) {
    const win = detachedWindows.get(state.id)
    if (win && !win.isDestroyed()) state.bounds = win.getBounds()
  }
  saveDetachedState()
  globalShortcut.unregisterAll() // 释放 mini 全局快捷键
  miniAutoPanel?.stop(); miniAutoPanel = null
  approvalDelivery.stop() // P1-K3
  remoteSafety.dispose() // P1-K2:断活动流、注销急停热键、放掉强制防休眠(锁文件原样留着 = 锁跨重启)
  flushAllNoteEdits() // 活动日志:5 分钟合并窗口内未落盘的 note.edit 冲出去
  void computerHistory?.dispose() // 电脑历史:断订阅、缓冲同步落盘、state 改成非录制态(同步部分当场做完,不等返回的 promise)
  // 优雅停后端(SIGTERM→3s→SIGKILL);停完再真正退出。
  const st = backend.getStatus().state
  if (st === 'ready' || st === 'starting') {
    e.preventDefault()
    void backend.stop().finally(() => app.exit(0))
  }
})

app.on('window-all-closed', () => {
  // 关窗只是隐藏到托盘(见 createWindow 的 close 拦截),App 常驻后台。
  // 故此处不再 app.quit();退出统一走托盘「退出」或 mac Cmd+Q → before-quit。
})
