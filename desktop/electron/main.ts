/**
 * Tangu 桌面 GUI — Electron 主进程。
 * 负责:建窗 + 配置持久化(IPC)+ 托管内置 tangu-server(managed 模式,backendManager)。
 * agent 调用由 renderer 直连 HTTP/SSE(localhost),不经主进程代理。
 */
import { app, BrowserWindow, dialog, ipcMain, Menu, shell, nativeImage } from 'electron'
import { basename, dirname, join } from 'path'
import { pathToFileURL } from 'url'
import { readFile, writeFile, mkdir, chmod, readdir, stat, rename, cp } from 'fs/promises'
import { execFile, spawn } from 'child_process'
import { BackendManager, type BackendStatus } from './backendManager'
import {
  forsionDeviceLogin, forsionLogout, forsionWhoami, loadTanguCreds,
} from './forsionAuth'
import { importMcp, importSkills, scanAll } from './discovery'
import { checkForUpdates, downloadUpdate, installUpdate } from './updater'
import { readThemesDir, seedDefaultThemes } from './themes'
import { extractZipToDir, MARKET_SUBDIR, isSafeSlug } from './marketInstall'

/** ~/.tangu(与包内 core/tanguHome.ts 同约定;TANGU_HOME 可整体重定向)。 */
const tanguHomeDir = (): string => process.env.TANGU_HOME || join(app.getPath('home'), '.tangu')
/** ~/.tangu/themes:拖入式主题目录(每主题一子目录:theme.json + theme.css)。 */
const themesDir = (): string => join(tanguHomeDir(), 'themes')

/**
 * 加载 ~/.tangu/.env 进 process.env(不覆盖真实环境;与包内 tanguHome.loadTanguEnv 同语义)。
 * 打包 Electron 不继承 shell 环境,.env 文件是 TANGU_CLOUD_URL 等预配置的标准载体(模板:包根 example.env)。
 */
async function loadTanguEnvFile(): Promise<void> {
  let raw: string
  try {
    raw = await readFile(join(tanguHomeDir(), '.env'), 'utf8')
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
    return p && typeof p === 'object' ? p : {}
  } catch { return {} }
}
async function writeHomeConfig(c: Record<string, any>): Promise<void> {
  await mkdir(tanguHomeDir(), { recursive: true })
  await writeFile(homeConfigPath(), JSON.stringify(c, null, 2), 'utf8')
  await chmod(homeConfigPath(), 0o600).catch(() => {}) // 含 token/apiKey
}
async function saveHomeSection(name: string, value: any): Promise<void> {
  const c = await readHomeConfig()
  c[name] = value
  await writeHomeConfig(c)
}

/** 直连 provider 配置。读 config.json 的 providers 段优先,缺失回落 legacy ~/.tangu/providers.json。 */
interface DirectProviderConfig {
  providerId: string
  baseUrl: string
  apiKey?: string
  modelIds?: string[]
  imageModelIds?: string[]
}

async function readProvidersFile(): Promise<DirectProviderConfig[]> {
  const sec = (await readHomeConfig()).providers
  if (sec !== undefined) return Array.isArray(sec) ? sec : []
  try {
    const parsed = JSON.parse(await readFile(join(tanguHomeDir(), 'providers.json'), 'utf8'))
    return Array.isArray(parsed) ? parsed : Array.isArray(parsed?.providers) ? parsed.providers : []
  } catch {
    return []
  }
}

async function writeProvidersFile(list: DirectProviderConfig[]): Promise<void> {
  await saveHomeSection('providers', list) // 唯一真源:落 config.json providers 段(chmod 600)
}

// ── 环境检测 + 引导安装(首启向导;检测+用户确认后执行,绝不静默自动装)──────────────
interface EnvProbe {
  tool: string
  found: boolean
  version: string | null
  /** 缺失时的安装命令(按平台);经 env:check 登记,env:run 只认 opaque id——renderer 不能传任意命令。 */
  installId: string | null
  installCommand: string | null
}

/** env:check 登记的可执行安装命令(id → command);env:run 仅从此表取,防 renderer 注入任意命令。 */
const pendingInstallCommands = new Map<string, string>()

function probeVersion(cmd: string, args: string[]): Promise<string | null> {
  return new Promise((resolve) => {
    const p = execFile(cmd, args, { timeout: 8000 }, (err, stdout, stderr) => {
      if (err) return resolve(null)
      resolve(String(stdout || stderr).trim().split('\n')[0].slice(0, 80) || '(ok)')
    })
    p.on('error', () => resolve(null))
  })
}

function installCommandFor(tool: string): string | null {
  const platform = process.platform
  const byTool: Record<string, Record<string, string>> = {
    node: {
      linux: 'sudo apt-get install -y nodejs npm',
      darwin: 'brew install node',
      win32: 'winget install OpenJS.NodeJS.LTS',
    },
    python3: {
      linux: 'sudo apt-get install -y python3 python3-pip',
      darwin: 'brew install python',
      win32: 'winget install Python.Python.3.12',
    },
    git: {
      linux: 'sudo apt-get install -y git',
      darwin: 'brew install git',
      win32: 'winget install Git.Git',
    },
    docker: {
      linux: 'curl -fsSL https://get.docker.com | sh',
      darwin: 'brew install --cask docker',
      win32: 'winget install Docker.DockerDesktop',
    },
  }
  return byTool[tool]?.[platform] ?? null
}

async function runEnvCheck(): Promise<EnvProbe[]> {
  pendingInstallCommands.clear()
  const probes: Array<{ tool: string; cmd: string; args: string[] }> = [
    { tool: 'node', cmd: 'node', args: ['--version'] },
    { tool: 'npm', cmd: 'npm', args: ['--version'] },
    { tool: 'python3', cmd: process.platform === 'win32' ? 'python' : 'python3', args: ['--version'] },
    { tool: 'git', cmd: 'git', args: ['--version'] },
    { tool: 'docker', cmd: 'docker', args: ['version', '--format', '{{.Server.Version}}'] },
  ]
  const out: EnvProbe[] = []
  for (const p of probes) {
    const version = await probeVersion(p.cmd, p.args)
    // npm 跟随 node 装,无独立安装命令
    const installCommand = version === null && p.tool !== 'npm' ? installCommandFor(p.tool) : null
    let installId: string | null = null
    if (installCommand) {
      installId = `env_${p.tool}_${Date.now().toString(36)}`
      pendingInstallCommands.set(installId, installCommand)
    }
    out.push({ tool: p.tool, found: version !== null, version, installId, installCommand })
  }
  return out
}

/** 持久化配置(userData/tangu-desktop-config.json)。 */
interface TanguStoredConfig {
  /** managed=自动托管内置后端;external=连接外部 tangu-server。 */
  mode: 'managed' | 'external'
  backendUrl: string // external 模式
  token: string // external 模式
  modelId: string
  cloudUrl: string // managed:传给 tangu-server 的 Forsion 云端
  cloudToken: string // managed:forsion_token(空则子进程回退 tangu login 凭证)
  sandbox: 'auto' | 'docker' | 'none'
  /** 「Tangu 默认工作区」本地目录(空=按 ~/Tangu 兜底);新建本机会话默认 cwd。 */
  defaultWorkspaceDir: string
  browserEnabled: boolean
  browserEngine: 'auto' | 'chrome' | 'lightpanda'
  browserSearchEngine: 'duckduckgo' | 'bing' | 'google' | 'baidu'
  browserAllowPrivateUrls: boolean
  browserCommandTimeoutMs: number
  wechatEnabled: boolean
  wechatDefaultSessionId: string
  wechatRemoteApprovalMode: 'readonly' | 'auto-edit' | 'full-auto'
  wechatAllowedPeers: string[]
  /** 本地记忆/日志是否自动同步 Forsion Brain(默认 false=仅手动)。 */
  forsionSyncEnabled: boolean
  /** 上次成功同步时刻(epoch ms)。 */
  forsionLastSyncedAt: number
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
  modelId: '',
  cloudUrl: '',
  cloudToken: '',
  sandbox: 'auto',
  defaultWorkspaceDir: '',
  browserEnabled: true,
  browserEngine: 'auto',
  browserSearchEngine: 'duckduckgo',
  browserAllowPrivateUrls: false,
  browserCommandTimeoutMs: 30000,
  wechatEnabled: true,
  wechatDefaultSessionId: '',
  wechatRemoteApprovalMode: 'readonly',
  wechatAllowedPeers: [],
  forsionSyncEnabled: false,
  forsionLastSyncedAt: 0,
}

/** 默认工作区目录(配置未填时兜底 ~/Tangu);best-effort 创建,失败不阻断。 */
async function ensureDefaultWorkspaceDir(stored: TanguStoredConfig): Promise<string> {
  const dir = stored.defaultWorkspaceDir?.trim() || join(app.getPath('home'), 'Tangu')
  await mkdir(dir, { recursive: true }).catch(() => {})
  return dir
}

// desktop-shell 专属键(留 userData/tangu-desktop-config.json):连哪个后端 + 同步开关。CLI 无此概念。
// 其余键(cloud/sandbox/workspace/browser/wechat)以 ~/.tangu/config.json 各段为权威,落盘亦写那里。
const SHELL_KEYS: Array<keyof TanguStoredConfig> = [
  'mode', 'backendUrl', 'token', 'wechatAllowedPeers', 'forsionSyncEnabled', 'forsionLastSyncedAt',
]
const configPath = (): string => join(app.getPath('userData'), 'tangu-desktop-config.json')

async function readShellConfig(): Promise<Partial<TanguStoredConfig>> {
  let cur: Partial<TanguStoredConfig> = {}
  try { cur = JSON.parse(await readFile(configPath(), 'utf8')) } catch { /* 无文件 → 空 */ }
  // 首启从旧 desktop 迁移:本端 shell 配置无 mode(从未初始化)→ 继承 desktop1.0 的连接设置
  // (mode=managed + 云 token + 同步/工作区等),与「兼容旧本地记录」一致;无旧 desktop 则回落默认(external + 引导)。
  if (!cur.mode) {
    try {
      const v1Path = join(app.getPath('userData'), '..', 'tangu-agent-desktop', 'tangu-desktop-config.json')
      const v1 = JSON.parse(await readFile(v1Path, 'utf8')) as Partial<TanguStoredConfig>
      if (v1.mode) {
        const seeded = { ...v1, ...cur } // 本端已显式设的键优先
        await mkdir(app.getPath('userData'), { recursive: true }).catch(() => {})
        await writeFile(configPath(), JSON.stringify(seeded, null, 2), 'utf8') // 落盘一次,此后与 1.0 解耦
        return seeded
      }
    } catch { /* 无旧 desktop 配置 → 默认 */ }
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
  const cloud = home.cloud || {}, browser = home.browser || {}, wechat = home.wechat || {}
  const merged: TanguStoredConfig = {
    ...DEFAULT_CONFIG,
    ...shell, // 旧 desktop 文件:既给 shell 键,也作未迁移段的回落
    ...(home.cloud !== undefined ? { cloudUrl: cloud.url || '', cloudToken: cloud.token || '', modelId: cloud.defaultModel || '' } : {}),
    ...(home.sandbox !== undefined ? { sandbox: home.sandbox } : {}),
    ...(home.workspace !== undefined ? { defaultWorkspaceDir: home.workspace } : {}),
    ...(home.browser !== undefined ? {
      browserEnabled: browser.enabled !== false, browserEngine: browser.engine || 'auto',
      browserSearchEngine: browser.searchEngine || 'duckduckgo', browserAllowPrivateUrls: !!browser.allowPrivateUrls,
      browserCommandTimeoutMs: browser.commandTimeoutMs || 30000,
    } : {}),
    ...(home.wechat !== undefined ? {
      wechatEnabled: wechat.enabled !== false, wechatDefaultSessionId: wechat.defaultSessionId || '',
      wechatRemoteApprovalMode: wechat.remoteApprovalMode || 'readonly',
    } : {}),
  }
  // 环境变量兜底:TANGU_CLOUD_URL(managed/登录默认)、TANGU_BACKEND_URL(external 外部地址)。
  if (!merged.cloudUrl) {
    merged.cloudUrl = process.env.TANGU_CLOUD_URL || loadTanguCreds().cloudUrl || DEFAULT_CLOUD_URL
  }
  if (process.env.TANGU_BACKEND_URL && merged.backendUrl === DEFAULT_CONFIG.backendUrl) {
    merged.backendUrl = process.env.TANGU_BACKEND_URL
  }
  return merged
}

/** patch 按键分流:shell 键 → desktop 文件;config-backed 键 → config.json 对应段(唯一真源)。 */
async function saveConfig(patch: Partial<TanguStoredConfig>): Promise<TanguStoredConfig> {
  // shell 键
  const shell = await readShellConfig()
  let shellTouched = false
  for (const k of SHELL_KEYS) if (k in patch) { (shell as any)[k] = (patch as any)[k]; shellTouched = true }
  if (shellTouched) {
    await mkdir(app.getPath('userData'), { recursive: true }).catch(() => {})
    await writeFile(configPath(), JSON.stringify(shell, null, 2), 'utf8')
  }
  // config-backed 键 → config.json 段
  const home = await readHomeConfig()
  const cloud = { ...(home.cloud || {}) }, browser = { ...(home.browser || {}) }, wechat = { ...(home.wechat || {}) }
  let cT = false, bT = false, wT = false, oT = false
  if ('cloudUrl' in patch) { cloud.url = patch.cloudUrl; cT = true }
  if ('cloudToken' in patch) { cloud.token = patch.cloudToken; cT = true }
  if ('modelId' in patch) { cloud.defaultModel = patch.modelId; cT = true }
  if ('sandbox' in patch) { home.sandbox = patch.sandbox; oT = true }
  if ('defaultWorkspaceDir' in patch) { home.workspace = patch.defaultWorkspaceDir; oT = true }
  if ('browserEnabled' in patch) { browser.enabled = patch.browserEnabled; bT = true }
  if ('browserEngine' in patch) { browser.engine = patch.browserEngine; bT = true }
  if ('browserSearchEngine' in patch) { browser.searchEngine = patch.browserSearchEngine; bT = true }
  if ('browserAllowPrivateUrls' in patch) { browser.allowPrivateUrls = patch.browserAllowPrivateUrls; bT = true }
  if ('browserCommandTimeoutMs' in patch) { browser.commandTimeoutMs = patch.browserCommandTimeoutMs; bT = true }
  if ('wechatEnabled' in patch) { wechat.enabled = patch.wechatEnabled; wT = true }
  if ('wechatDefaultSessionId' in patch) { wechat.defaultSessionId = patch.wechatDefaultSessionId; wT = true }
  if ('wechatRemoteApprovalMode' in patch) { wechat.remoteApprovalMode = patch.wechatRemoteApprovalMode; wT = true }
  if (cT) home.cloud = cloud
  if (bT) home.browser = browser
  if (wT) home.wechat = wechat
  if (cT || bT || wT || oT) await writeHomeConfig(home)
  return loadConfig()
}

const backend = new BackendManager()
let mainWindow: BrowserWindow | null = null

/** renderer 视角的有效配置:managed 就绪时 backendUrl/token 来自托管子进程。 */
async function effectiveConfig(): Promise<TanguStoredConfig & { backendState: BackendStatus; homeDir: string }> {
  const stored = await loadConfig()
  const st = backend.getStatus()
  const homeDir = app.getPath('home')
  // 默认工作区目录折算为有效绝对路径(并确保存在),renderer 用它建「Tangu 默认工作区」会话。
  const defaultWorkspaceDir = await ensureDefaultWorkspaceDir(stored)
  if (stored.mode === 'managed' && st.state === 'ready' && st.url) {
    return { ...stored, backendUrl: st.url, token: backend.getToken(), backendState: st, homeDir, defaultWorkspaceDir }
  }
  return { ...stored, backendState: st, homeDir, defaultWorkspaceDir }
}

// 串行化:连续 config:set(如先改 cloudUrl 再改 sandbox)触发的多次 ensureBackend
// 排队执行,避免并发 start() 双 spawn/端口竞争。
let ensureChain: Promise<void> = Promise.resolve()
function ensureBackend(): Promise<void> {
  ensureChain = ensureChain.then(async () => {
    const stored = await loadConfig()
    if (stored.mode !== 'managed') {
      await backend.stop()
      return
    }
    await backend.start({
      cloudUrl: stored.cloudUrl,
      cloudToken: stored.cloudToken,
      modelId: stored.modelId || undefined,
      sandbox: stored.sandbox,
      browserEnabled: stored.browserEnabled,
      browserEngine: stored.browserEngine,
      browserSearchEngine: stored.browserSearchEngine,
      browserAllowPrivateUrls: stored.browserAllowPrivateUrls,
      browserCommandTimeoutMs: stored.browserCommandTimeoutMs,
      wechatEnabled: stored.wechatEnabled,
      wechatRemoteApprovalMode: stored.wechatRemoteApprovalMode,
      defaultWorkspaceDir: await ensureDefaultWorkspaceDir(stored),
    })
  }).catch((e) => {
    console.error('[tangu-desktop] ensureBackend failed:', e)
  })
  return ensureChain
}

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
    backgroundColor: '#fbf8f5', // 启动闪屏底色(动画 stage 底色),避免首帧白屏闪烁
    webPreferences: {
      preload: join(__dirname, '../preload/preload.mjs'),
      contextIsolation: true,
      nodeIntegration: false,
      // sandbox:true 不支持 ESM preload(electron-vite 产出 .mjs);renderer 无 Node 能力,
      // 暴露面仅 contextBridge 的最小 API,风险可控。改 CJS preload 后可翻转。
      sandbox: false,
      // 启用 Chromium 内置 PDFium —— <iframe src="blob:…pdf"> 预览 PDF 依赖此项,默认关。
      plugins: true,
    },
  })

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('https://') || url.startsWith('http://')) shell.openExternal(url)
    return { action: 'deny' }
  })

  if (process.env.ELECTRON_RENDERER_URL) {
    mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

app.whenReady().then(async () => {
  await loadTanguEnvFile() // 先于一切 loadConfig(其 env 兜底读 TANGU_CLOUD_URL/TANGU_BACKEND_URL)
  await seedDefaultThemes(themesDir()) // 首次运行种入 soft 示例主题(themes/ 已存在则跳过;内部吞错不阻塞启动)

  ipcMain.handle('config:get', () => effectiveConfig())
  ipcMain.handle('config:set', async (_e, patch: Partial<TanguStoredConfig>) => {
    const before = await loadConfig()
    await saveConfig(patch)
    // 模式/托管参数变化 → 重启托管后端(切到 external 则停掉)。
    const managedKeys: Array<keyof TanguStoredConfig> = [
      'mode', 'cloudUrl', 'cloudToken', 'sandbox',
      'browserEnabled', 'browserEngine', 'browserSearchEngine', 'browserAllowPrivateUrls', 'browserCommandTimeoutMs',
      'wechatEnabled', 'wechatRemoteApprovalMode',
    ]
    if (managedKeys.some((k) => patch[k] !== undefined && patch[k] !== before[k])) {
      void ensureBackend()
    }
    return effectiveConfig()
  })
  // 本机模式的工作目录选择(host-exec 的 cwd)。
  ipcMain.handle('dialog:pickDirectory', async () => {
    const win = BrowserWindow.getFocusedWindow() ?? mainWindow
    const r = win
      ? await dialog.showOpenDialog(win, { properties: ['openDirectory', 'createDirectory'], title: '选择 Agent 工作目录' })
      : await dialog.showOpenDialog({ properties: ['openDirectory', 'createDirectory'], title: '选择 Agent 工作目录' })
    return r.canceled || !r.filePaths.length ? null : r.filePaths[0]
  })

  // 另存为文本文件(导出日志等):弹系统保存框,用户选位置后写盘。canceled → { ok:false }。
  ipcMain.handle('dialog:saveTextFile', async (_e, defaultName: string, content: string) => {
    if (typeof content !== 'string') return { ok: false, path: null }
    const win = BrowserWindow.getFocusedWindow() ?? mainWindow
    const opts = {
      title: '导出',
      defaultPath: typeof defaultName === 'string' && defaultName ? defaultName : 'export.json',
      filters: [{ name: 'JSON', extensions: ['json'] }, { name: 'All Files', extensions: ['*'] }],
    }
    const r = win ? await dialog.showSaveDialog(win, opts) : await dialog.showSaveDialog(opts)
    if (r.canceled || !r.filePath) return { ok: false, path: null }
    await writeFile(r.filePath, content, 'utf8')
    return { ok: true, path: r.filePath }
  })

  // ── 本机工作区文件浏览(host 模式右栏:直接读 cwd 真实目录)──
  ipcMain.handle('fs:listDir', async (_e, dirPath: string) => {
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
  })
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
    if (st.size > MAX_PREVIEW_BYTES) return { mimeType, content: '', size: st.size, tooLarge: true }
    const buf = await readFile(filePath)
    return { mimeType, content: buf.toString('base64'), size: st.size }
  })

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
    return await new Promise<{ exitCode: number }>((resolve) => {
      const child = spawn(command, { shell: true })
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

  // ── MCP server 管理(写 config.json 的 mcp 段;managed 模式保存后重启后端重连)──
  const mcpFile = (): string => join(tanguHomeDir(), 'mcp.json')
  ipcMain.handle('mcp:read', async () => {
    const sec = (await readHomeConfig()).mcp
    if (sec !== undefined) return { mcpServers: sec?.mcpServers && typeof sec.mcpServers === 'object' ? sec.mcpServers : {} }
    try { // 回落 legacy mcp.json(后端 migrate 前的过渡)
      const parsed = JSON.parse(await readFile(mcpFile(), 'utf8'))
      return { mcpServers: parsed?.mcpServers && typeof parsed.mcpServers === 'object' ? parsed.mcpServers : {} }
    } catch {
      return { mcpServers: {} }
    }
  })
  ipcMain.handle('mcp:write', async (_e, cfg: { mcpServers: Record<string, any> }) => {
    if (!cfg || typeof cfg.mcpServers !== 'object') throw new Error('非法 MCP 配置')
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

  // ── 跨生态 agent 资产发现/导入(~/.claude、~/.codex、~/.hermes → ~/.tangu)──
  // 导入的 MCP 一律 enabled:false(绝不自动运行外来命令),故**不**触发后端重启;
  // 技能落盘 ~/.tangu/skills/ 后由后端按 mtime 重扫即时生效。
  ipcMain.handle('discovery:scan', () => scanAll())
  ipcMain.handle('discovery:importSkills', (_e, ids: string[]) =>
    importSkills(Array.isArray(ids) ? ids.filter((x) => typeof x === 'string') : [], tanguHomeDir()))
  ipcMain.handle('discovery:importMcp', async (_e, names: string[]) => {
    // importMcp 在 legacy mcp.json 上做合并:先把 config.json 的 mcp 段播种进去(免丢已有),导入后再写回 config.json。
    const home = await readHomeConfig()
    await mkdir(tanguHomeDir(), { recursive: true })
    await writeFile(mcpFile(), JSON.stringify({ mcpServers: home.mcp?.mcpServers || {} }, null, 2), 'utf8')
    const r = await importMcp(Array.isArray(names) ? names.filter((x) => typeof x === 'string') : [], tanguHomeDir())
    try {
      const merged = JSON.parse(await readFile(mcpFile(), 'utf8'))
      await saveHomeSection('mcp', { mcpServers: merged?.mcpServers || {} })
    } catch { /* importMcp 未写文件(无导入项)→ config.json 不变 */ }
    return r
  })

  // ── 直连 provider 管理(写 ~/.tangu/providers.json;managed 模式保存后重启后端加载)──
  ipcMain.handle('providers:list', () => readProvidersFile())
  ipcMain.handle('providers:save', async (_e, provider: DirectProviderConfig) => {
    if (!provider?.providerId || !provider?.baseUrl) throw new Error('providerId 与 baseUrl 必填')
    const list = await readProvidersFile()
    const i = list.findIndex((p) => p.providerId === provider.providerId)
    if (i >= 0) list[i] = provider
    else list.push(provider)
    await writeProvidersFile(list)
    const stored = await loadConfig()
    if (stored.mode === 'managed') void ensureBackend()
    return list
  })
  ipcMain.handle('providers:delete', async (_e, providerId: string) => {
    const list = (await readProvidersFile()).filter((p) => p.providerId !== providerId)
    await writeProvidersFile(list)
    const stored = await loadConfig()
    if (stored.mode === 'managed') void ensureBackend()
    return list
  })

  // ── Forsion 账号 / provider OAuth 登录(与 `tangu login` 同一份凭证)──
  const broadcast = (channel: string, payload: any): void => {
    for (const w of BrowserWindow.getAllWindows()) w.webContents.send(channel, payload)
  }

  ipcMain.handle('auth:status', async () => {
    const stored = await loadConfig()
    const creds = loadTanguCreds()
    const cloudUrl = stored.cloudUrl || creds.cloudUrl || ''
    const token = stored.cloudToken || creds.token || ''
    const who = token ? await forsionWhoami(cloudUrl, token) : null
    return {
      loggedIn: !!token,
      cloudUrl,
      username: who?.username || null,
      nickname: who?.nickname || null,
      avatar: who?.avatar || null,
      membershipTier: who?.membershipTier || null,
      tokenSource: stored.cloudToken ? 'config' : creds.token ? 'tangu-login' : null,
    }
  })

  ipcMain.handle('app:version', () => app.getVersion())

  // ── 应用内自动更新(electron-updater;检查 → 下载 → 重启安装。mac 仅检测,UI 引导手动下载)──
  ipcMain.handle('updater:check', () => checkForUpdates())
  ipcMain.handle('updater:download', () => downloadUpdate())
  ipcMain.handle('updater:install', async () => {
    // 先优雅停后端 → 下方 before-quit 见 'stopped' 不再 preventDefault/app.exit(0),
    // electron-updater 的退出安装路径才不被硬退出截断。
    await backend.stop()
    installUpdate()
    return { ok: true }
  })

  // 打开 Forsion 个人中心(对齐 AI Studio:{cloudUrl}/account?token=…)。token 留在主进程,不下发渲染层。
  // 可选 section → 追加 #<section>(如投稿页 #submission)。
  ipcMain.handle('auth:openAccountCenter', async (_e, section?: string) => {
    const stored = await loadConfig()
    const creds = loadTanguCreds()
    const cloudUrl = (stored.cloudUrl || creds.cloudUrl || '').replace(/\/+$/, '')
    const token = stored.cloudToken || creds.token || ''
    if (!cloudUrl) return { ok: false }
    const hash = section && /^[a-z0-9-]+$/i.test(section) ? `#${section}` : ''
    const url = `${cloudUrl}/account${token ? `?token=${encodeURIComponent(token)}` : ''}${hash}`
    await shell.openExternal(url)
    return { ok: true }
  })

  // ── Forsion Market ──
  // 浏览/详情/安装全在主进程:有 cloudUrl + 文件系统 + 免 CORS。浏览端点公开(无需 token)。
  const marketBase = async (): Promise<string> => {
    const stored = await loadConfig()
    const creds = loadTanguCreds()
    const base = (stored.cloudUrl || creds.cloudUrl || '').replace(/\/+$/, '')
    if (!base) throw new Error('未配置 Forsion 云端地址')
    return base
  }
  const MARKET_UA = 'Forsion-Tangu'

  ipcMain.handle('market:list', async (_e, type?: string) => {
    const base = await marketBase()
    const q = type ? `?type=${encodeURIComponent(type)}` : ''
    const r = await fetch(`${base}/api/market/items${q}`, { headers: { 'User-Agent': MARKET_UA } })
    if (!r.ok) throw new Error(`加载失败 HTTP ${r.status}`)
    return await r.json() // { items }
  })

  ipcMain.handle('market:detail', async (_e, id: string) => {
    const base = await marketBase()
    const r = await fetch(`${base}/api/market/items/${encodeURIComponent(id)}`, { headers: { 'User-Agent': MARKET_UA } })
    if (!r.ok) throw new Error(`加载失败 HTTP ${r.status}`)
    return await r.json()
  })

  ipcMain.handle('market:install', async (_e, id: string) => {
    const base = await marketBase()
    const infoRes = await fetch(`${base}/api/market/items/${encodeURIComponent(id)}/install`, { headers: { 'User-Agent': MARKET_UA } })
    if (!infoRes.ok) throw new Error(`解析下载地址失败 HTTP ${infoRes.status}`)
    const info = (await infoRes.json()) as { type: string; installSlug: string; downloadUrl: string; source: string }
    const sub = MARKET_SUBDIR[info.type]
    if (!sub || !isSafeSlug(info.installSlug)) throw new Error('非法的安装目标')
    const zipRes = await fetch(info.downloadUrl, { headers: { 'User-Agent': MARKET_UA } })
    if (!zipRes.ok) throw new Error(`下载失败 HTTP ${zipRes.status}`)
    const buf = Buffer.from(await zipRes.arrayBuffer())
    const dest = join(tanguHomeDir(), sub, info.installSlug)
    const files = await extractZipToDir(buf, dest)
    return { ok: true, path: dest, files, type: info.type, slug: info.installSlug }
  })

  ipcMain.handle('market:installed', async () => {
    const out: Record<string, string[]> = { skill: [], agent: [], plugin: [] }
    for (const [type, sub] of Object.entries(MARKET_SUBDIR)) {
      try {
        const ents = await readdir(join(tanguHomeDir(), sub), { withFileTypes: true })
        out[type] = ents.filter((e) => e.isDirectory()).map((e) => e.name)
      } catch {
        /* 目录不存在 = 空 */
      }
    }
    return out
  })

  // 提交反馈到 Forsion 反馈中心(token 留主进程,不下发渲染层)。会话日志 JSON 作附件随附,
  // >5MB 则省略附件、正文照常提交(后端附件硬上限 5MB)。
  ipcMain.handle('feedback:submit', async (
    _e,
    input: { description?: string; sessionLogJson?: string; sessionLogName?: string },
  ) => {
    const stored = await loadConfig()
    const creds = loadTanguCreds()
    const cloudUrl = (stored.cloudUrl || creds.cloudUrl || '').replace(/\/+$/, '')
    const token = stored.cloudToken || creds.token || ''
    if (!cloudUrl || !token) return { ok: false, error: 'not-logged-in' }
    const description = (input?.description || '').trim()
    if (!description) return { ok: false, error: 'empty' }

    const attachments: Array<{ filename: string; mime_type: string; size: number; data_base64: string }> = []
    let attachmentSkipped = false
    if (input?.sessionLogJson) {
      const buf = Buffer.from(input.sessionLogJson, 'utf8')
      if (buf.length > 5 * 1024 * 1024) attachmentSkipped = true
      else attachments.push({
        filename: input.sessionLogName || 'tangu-session.json',
        mime_type: 'application/json',
        size: buf.length,
        data_base64: buf.toString('base64'),
      })
    }
    try {
      const r = await fetch(`${cloudUrl}/api/feedback`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ description, attachments }),
        signal: AbortSignal.timeout(20000),
      })
      if (!r.ok) {
        let detail = `HTTP ${r.status}`
        try { detail = (await r.json())?.detail || detail } catch { /* keep */ }
        return { ok: false, error: detail }
      }
      const j: any = await r.json().catch(() => ({}))
      return { ok: true, id: j?.id ?? null, attachmentSkipped }
    } catch (e: any) {
      return { ok: false, error: e?.message || String(e) }
    }
  })

  ipcMain.handle('auth:forsionLogin', async (_e, cloudUrl?: string) => {
    const stored = await loadConfig()
    const url = (cloudUrl || stored.cloudUrl || '').trim()
    const r = await forsionDeviceLogin(url, (info) => broadcast('auth:device', info))
    // 登录成功:cloudUrl 记进配置;token 由 forsionDeviceLogin 写进 auth.json(managed 后端/getToken 回退读取)。
    // ⚠️ config.cloud.token 优先级高于 auth.json(getToken/auth:status 均 `cloudToken || creds.token`)——
    // 残留的旧 cloudToken 会遮蔽本次登录的新 token,故一并清掉,否则「登录了但 Tangu 仍用旧 token」。
    await saveConfig({ cloudUrl: r.cloudUrl, ...(stored.cloudToken ? { cloudToken: '' } : {}) })
    // 关键:await(非 void)等后端带新 token 重启就绪后才返回,这样渲染端登录后的 onReconnect/onAuthChange
    // 必命中「已就绪 + 已鉴权」的后端。否则后端尚在重启时渲染端就 connect → 失败,只能靠异步 ready 广播
    // 自愈(竞态;新用户引导里常表现为登录后一直「连接后端」、模型加载不出,得手动去设置重启)。
    if (stored.mode === 'managed') await ensureBackend()
    return { ok: true, cloudUrl: r.cloudUrl }
  })

  ipcMain.handle('auth:logout', async () => {
    forsionLogout()                 // 清 auth.json 的 token
    const stored = await loadConfig()
    // 也清 config.json 的 cloudToken:auth:status 等一律 `stored.cloudToken || creds.token` 优先读它,
    // 不清则登出后仍判定已登录(本 bug 根因)。
    if (stored.cloudToken) await saveConfig({ cloudToken: '' })
    if (stored.mode === 'managed') void ensureBackend()
    return { ok: true }
  })

  // provider OAuth(xAI 等):动态 import 包 dist 的 providerOAuth(dev=包根 dist,打包=resources/tangu-server/dist),
  // 与 `tangu login <provider>` 同一实现、同一份 ~/.tangu/provider-auth.json。
  const providerOAuthModule = async (): Promise<any> => {
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
        const credsPath = join(app.getPath('home'), '.tangu', 'provider-auth.json')
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
    if (stored.mode === 'managed') void ensureBackend() // 重启让后端加载该 provider
    return { ok: true, id }
  })

  backend.onStatus((st) => {
    for (const w of BrowserWindow.getAllWindows()) {
      w.webContents.send('backend:status', st)
    }
  })

  void ensureBackend()
  createWindow()
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('before-quit', (e) => {
  // 优雅停后端(SIGTERM→3s→SIGKILL);停完再真正退出。
  const st = backend.getStatus().state
  if (st === 'ready' || st === 'starting') {
    e.preventDefault()
    void backend.stop().finally(() => app.exit(0))
  }
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
