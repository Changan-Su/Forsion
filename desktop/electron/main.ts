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

/** ~/.tangu(与包内 core/tanguHome.ts 同约定;TANGU_HOME 可整体重定向)。 */
const tanguHomeDir = (): string => process.env.TANGU_HOME || join(app.getPath('home'), '.tangu')

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

/** 直连 provider 配置(~/.tangu/providers.json;托管后端启动时自动加载,见包内 assemble.loadProviders)。 */
interface DirectProviderConfig {
  providerId: string
  baseUrl: string
  apiKey?: string
  modelIds?: string[]
}

async function readProvidersFile(): Promise<DirectProviderConfig[]> {
  try {
    const parsed = JSON.parse(await readFile(join(tanguHomeDir(), 'providers.json'), 'utf8'))
    return Array.isArray(parsed) ? parsed : Array.isArray(parsed?.providers) ? parsed.providers : []
  } catch {
    return []
  }
}

async function writeProvidersFile(list: DirectProviderConfig[]): Promise<void> {
  const file = join(tanguHomeDir(), 'providers.json')
  await mkdir(tanguHomeDir(), { recursive: true })
  await writeFile(file, JSON.stringify(list, null, 2), 'utf8')
  await chmod(file, 0o600).catch(() => {}) // best-effort:文件含 apiKey
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

const configPath = (): string => join(app.getPath('userData'), 'tangu-desktop-config.json')

async function loadConfig(): Promise<TanguStoredConfig> {
  let merged: TanguStoredConfig
  try {
    merged = { ...DEFAULT_CONFIG, ...JSON.parse(await readFile(configPath(), 'utf8')) }
  } catch {
    merged = { ...DEFAULT_CONFIG }
  }
  // 环境变量兜底(与包内 standalone/worker 同名约定):配置里没填时生效。
  //   TANGU_CLOUD_URL    Forsion 云端地址(managed 模式 / 登录默认地址)
  //   TANGU_BACKEND_URL  external 模式的外部 tangu-server 地址
  if (!merged.cloudUrl) {
    merged.cloudUrl = process.env.TANGU_CLOUD_URL || loadTanguCreds().cloudUrl || DEFAULT_CLOUD_URL
  }
  if (process.env.TANGU_BACKEND_URL && merged.backendUrl === DEFAULT_CONFIG.backendUrl) {
    merged.backendUrl = process.env.TANGU_BACKEND_URL
  }
  return merged
}
async function saveConfig(patch: Partial<TanguStoredConfig>): Promise<TanguStoredConfig> {
  const merged = { ...(await loadConfig()), ...patch }
  await mkdir(app.getPath('userData'), { recursive: true }).catch(() => {})
  await writeFile(configPath(), JSON.stringify(merged, null, 2), 'utf8')
  return merged
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
    backgroundColor: '#F5F5F7', // qbird 浅色底(默认主题),避免白屏闪烁
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

  ipcMain.handle('config:get', () => effectiveConfig())
  ipcMain.handle('config:set', async (_e, patch: Partial<TanguStoredConfig>) => {
    const before = await loadConfig()
    const merged = await saveConfig(patch)
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

  // ── MCP server 管理(写 ~/.tangu/mcp.json;managed 模式保存后重启后端重连)──
  const mcpFile = (): string => join(tanguHomeDir(), 'mcp.json')
  ipcMain.handle('mcp:read', async () => {
    try {
      const parsed = JSON.parse(await readFile(mcpFile(), 'utf8'))
      return { mcpServers: parsed?.mcpServers && typeof parsed.mcpServers === 'object' ? parsed.mcpServers : {} }
    } catch {
      return { mcpServers: {} }
    }
  })
  ipcMain.handle('mcp:write', async (_e, cfg: { mcpServers: Record<string, any> }) => {
    if (!cfg || typeof cfg.mcpServers !== 'object') throw new Error('非法 MCP 配置')
    await mkdir(tanguHomeDir(), { recursive: true })
    await writeFile(mcpFile(), JSON.stringify({ mcpServers: cfg.mcpServers }, null, 2), 'utf8')
    await chmod(mcpFile(), 0o600).catch(() => {}) // env/headers 可能含密钥
    const stored = await loadConfig()
    if (stored.mode === 'managed') void ensureBackend() // 重启后端重连 MCP(进程级冻结语义)
    return { mcpServers: cfg.mcpServers }
  })

  // ── 跨生态 agent 资产发现/导入(~/.claude、~/.codex、~/.hermes → ~/.tangu)──
  // 导入的 MCP 一律 enabled:false(绝不自动运行外来命令),故**不**触发后端重启;
  // 技能落盘 ~/.tangu/skills/ 后由后端按 mtime 重扫即时生效。
  ipcMain.handle('discovery:scan', () => scanAll())
  ipcMain.handle('discovery:importSkills', (_e, ids: string[]) =>
    importSkills(Array.isArray(ids) ? ids.filter((x) => typeof x === 'string') : [], tanguHomeDir()))
  ipcMain.handle('discovery:importMcp', (_e, names: string[]) =>
    importMcp(Array.isArray(names) ? names.filter((x) => typeof x === 'string') : [], tanguHomeDir()))

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

  // 打开 Forsion 个人中心(对齐 AI Studio:{cloudUrl}/account?token=…)。token 留在主进程,不下发渲染层。
  ipcMain.handle('auth:openAccountCenter', async () => {
    const stored = await loadConfig()
    const creds = loadTanguCreds()
    const cloudUrl = (stored.cloudUrl || creds.cloudUrl || '').replace(/\/+$/, '')
    const token = stored.cloudToken || creds.token || ''
    if (!cloudUrl) return { ok: false }
    const url = `${cloudUrl}/account${token ? `?token=${encodeURIComponent(token)}` : ''}`
    await shell.openExternal(url)
    return { ok: true }
  })

  ipcMain.handle('auth:forsionLogin', async (_e, cloudUrl?: string) => {
    const stored = await loadConfig()
    const url = (cloudUrl || stored.cloudUrl || '').trim()
    const r = await forsionDeviceLogin(url, (info) => broadcast('auth:device', info))
    // 登录成功:cloudUrl 记进配置(token 留在 auth.json,managed 后端/getToken 自动回退读取);
    // managed 模式重启后端让子进程吃到新凭证。
    await saveConfig({ cloudUrl: r.cloudUrl })
    if (stored.mode === 'managed') void ensureBackend()
    return { ok: true, cloudUrl: r.cloudUrl }
  })

  ipcMain.handle('auth:logout', async () => {
    forsionLogout()
    const stored = await loadConfig()
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
