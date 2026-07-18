/**
 * Tangu 桌面 GUI — Electron 主进程。
 * 负责:建窗 + 配置持久化(IPC)+ 托管内置 tangu-server(managed 模式,backendManager)。
 * agent 调用由 renderer 直连 HTTP/SSE(localhost),不经主进程代理。
 */
import { app, BrowserWindow, dialog, ipcMain, Menu, screen, globalShortcut, session, shell, nativeImage, Notification } from 'electron'
import { basename, dirname, join } from 'path'
import { pathToFileURL } from 'url'
import { readFile, writeFile, mkdir, chmod, readdir, stat, lstat, rename, cp, open as fsOpen, unlink, rm } from 'fs/promises'
import { existsSync } from 'fs'
import { ensureCliInstalled } from './cliInstall'
import { PRODUCT } from './product'
import { forsionHomeDir, tanguDataDir, migrateForsionHome, migrateEngineData, migratePair, setDevMode, defaultWorkspaceDir as forsionWorkspaceDir } from './forsionHome'
import { execFile, spawn } from 'child_process'
import { homedir } from 'os'
import { BackendManager, bundledPythonBin, type BackendStatus } from './backendManager'
import {
  forsionDeviceLogin, forsionLogout, forsionWhoami, loadTanguCreds,
} from './forsionAuth'
import { importMcp, importSkills, scanAll } from './discovery'
import { checkForUpdates, downloadUpdate, installUpdate } from './updater'
import { createTray } from './tray'
import { readThemesDir, seedDefaultThemes } from './themes'
import { extractZipToDir, MARKET_SUBDIR, MARKET_MANIFEST, isSafeSlug, readInstalledVersion, readUserPluginDirs } from './marketInstall'
import { serveDir as codePreviewServe, stopCodePreview } from './codePreview'
import { transcribeViaOpenAI, transcribeViaForsion } from './asr'
import { localModelReady, localModelSize, downloadLocalModel, removeLocalModel, transcribeLocal } from './asrLocal'
// Amadeus Space:vendored 笔记后端(vault IPC + 资产协议)。renderImport 别名后保持 verbatim。
import { registerIpc as registerAmadeusIpc } from './amadeus/ipc'
import { logActivity, setActivityLogEnabled, pruneActivity, exportActivity, flushAllNoteEdits } from './activityLog'
import { KNOWN_APPS } from '../shared/knownApps'
import { registerAssetSchemes as registerAmadeusAssetSchemes, registerAssetProtocol as registerAmadeusAssetProtocol } from './amadeus/assetProtocol'
import { nearestEdge, collapsedBounds, expandedBounds, miniSizeFromWidth, visibleRect, pointInRect, growRect, type Rect, type Edge } from './windowGeometry'
import { applyWindowMaterial, parseWindowMaterialRequest } from './windowMaterial'

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
app.on('second-instance', () => showMainWindow())

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
  ttsModelIds?: string[]
  asrModelIds?: string[]
}

async function readProvidersFile(): Promise<DirectProviderConfig[]> {
  const sec = (await readHomeConfig()).providers
  if (sec !== undefined) return Array.isArray(sec) ? sec : []
  try {
    const parsed = JSON.parse(await readFile(join(tanguDataDir(), 'providers.json'), 'utf8')) // legacy 文件在引擎域
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

/** GUI 启动的 Electron 只拿到 launchd/桌面会话的精简 PATH(mac 上不含 /opt/homebrew/bin 等),
 *  Homebrew/用户目录装的 node/git/docker 会被误判「未检测到」。环境探测与引导安装统一用补全 PATH。 */
function envWithFullPath(extra?: Record<string, string>): NodeJS.ProcessEnv {
  const sep = process.platform === 'win32' ? ';' : ':'
  const home = homedir()
  // Windows 上 GUI Electron 拿到的 PATH 常缺 nvm/scoop/winget/npm-global 等 per-user 目录 → node/npm/docker 误判未装。
  // 补进最常见的安装位置(存在才补)。真正让 npm.cmd 等 .cmd shim 能被探测到的是 probeVersion 的 shell:true。
  const additions = process.platform === 'win32'
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
  const cur = (process.env.PATH || '').split(sep).filter(Boolean)
  // 只补「真实存在且尚不在 PATH」的目录(existsSync 过滤,避免塞进不存在的路径 + 无意义查找)。
  const add = additions.filter((p) => existsSync(p) && !cur.includes(p))
  const PATH = [...cur, ...add].join(sep)
  return { ...process.env, PATH, ...(extra || {}) }
}

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

function probeVersion(cmd: string, args: string[]): Promise<string | null> {
  return new Promise((resolve) => {
    // Windows:npm/docker/python 等多为 .cmd/.bat shim,execFile 不带 shell 无法执行(npm 根本没有 npm.exe)→ 一律
    // 误判「未装」。shell:true 交 cmd.exe 解析。args 全为硬编码常量(--version 等),无注入面。windowsHide 免弹窗。
    const p = execFile(cmd, args, { timeout: 8000, env: envWithFullPath(), shell: process.platform === 'win32', windowsHide: true }, (err, stdout, stderr) => {
      if (err) return resolve(null)
      resolve(String(stdout || stderr).trim().split('\n')[0].slice(0, 80) || '(ok)')
    })
    p.on('error', () => resolve(null))
  })
}

function installCommandFor(tool: string, mirror: 'default' | 'china'): string | null {
  const platform = process.platform
  const cn = mirror === 'china'
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
      // 官方安装脚本原生支持 --mirror Aliyun(中国网络直连 get.docker.com/Docker CDN 极慢)。
      linux: cn ? 'curl -fsSL https://get.docker.com | sh -s -- --mirror Aliyun' : 'curl -fsSL https://get.docker.com | sh',
      darwin: 'brew install --cask docker',
      win32: 'winget install Docker.DockerDesktop',
    },
  }
  return byTool[tool]?.[platform] ?? null
}

async function runEnvCheck(): Promise<EnvProbe[]> {
  pendingInstallCommands.clear()
  const mirror = (await loadConfig()).mirror
  const probes: Array<{ tool: string; cmd: string; args: string[] }> = [
    { tool: 'node', cmd: 'node', args: ['--version'] },
    { tool: 'npm', cmd: 'npm', args: ['--version'] },
    { tool: 'python3', cmd: process.platform === 'win32' ? 'python' : 'python3', args: ['--version'] },
    { tool: 'git', cmd: 'git', args: ['--version'] },
    // `--version` 只问客户端(docker.exe),不连 daemon:原来的 `version --format {{.Server.Version}}` 要查
    // daemon,Docker Desktop 没开/慢启动时会卡满 8s 超时并误报「未装」。检测存在性用客户端版本即可。
    { tool: 'docker', cmd: 'docker', args: ['--version'] },
  ]
  const out: EnvProbe[] = []
  for (const p of probes) {
    const version = await probeVersion(p.cmd, p.args)
    // npm 跟随 node 装,无独立安装命令
    const installCommand = version === null && p.tool !== 'npm' ? installCommandFor(p.tool, mirror) : null
    let installId: string | null = null
    if (installCommand) {
      installId = `env_${p.tool}_${Date.now().toString(36)}`
      pendingInstallCommands.set(installId, installCommand)
    }
    out.push({ tool: p.tool, found: version !== null, version, installId, installCommand })
  }
  // 内置 Python:默认 pythonMode=bundled 时 agent 用内置解释器,故 python 视为已满足(展示内置版本、无需系统安装)。
  const pyBin = bundledPythonBin()
  if (pyBin) {
    const v = await probeVersion(pyBin, ['--version'])
    const idx = out.findIndex((o) => o.tool === 'python3')
    const entry: EnvProbe = { tool: 'python3', found: true, version: `${v || 'Python'} · bundled`, installId: null, installCommand: null }
    if (idx >= 0) out[idx] = entry; else out.push(entry)
  }
  // tangu CLI:App 启动时自装的终端命令(report-only,无安装按钮——ensureCliInstalled 每次启动自愈)。
  const shim = join(tanguHomeDir(), 'bin', process.platform === 'win32' ? 'tangu.cmd' : 'tangu')
  out.push({
    tool: 'tangu',
    found: existsSync(shim),
    version: existsSync(shim) ? `CLI · v${app.getVersion()}` : null,
    installId: null,
    installCommand: null,
  })
  return out
}

/** 持久化配置(userData/tangu-desktop-config.json)。 */
interface TanguStoredConfig {
  /** managed=自动托管内置后端;external=连接外部 tangu-server。 */
  mode: 'managed' | 'external'
  backendUrl: string // external 模式
  token: string // external 模式
  modelId: string
  /** 默认语音识别模型 id(语音输入转写用;持久化到 config.json asr.modelId;缺省=跟随 app 级 asr 默认)。 */
  asrModelId: string
  /** 语音输入偏好后端:local=本地 SenseVoice(需下载);cloud=自带-key/Forsion 云端。缺省 cloud。 */
  asrBackend: 'local' | 'cloud'
  cloudUrl: string // managed:传给 tangu-server 的 Forsion 云端
  cloudToken: string // managed:forsion_token(空则子进程回退 tangu login 凭证)
  sandbox: 'auto' | 'docker' | 'none'
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
  wechatEnabled: boolean
  wechatDefaultSessionId: string
  wechatRemoteApprovalMode: 'readonly' | 'auto-edit' | 'full-auto'
  wechatAllowedPeers: string[]
  /** 本地记忆/日志是否自动同步 Forsion Brain(默认 false=仅手动)。 */
  forsionSyncEnabled: boolean
  /** 上次成功同步时刻(epoch ms)。 */
  forsionLastSyncedAt: number
  /** 笔记(Amadeus)拖入附件存放方式:attachments=同目录 attachments/;same=与笔记同目录;vault=固定文件夹。 */
  notesAttachmentMode: 'attachments' | 'same' | 'vault'
  /** notesAttachmentMode==='vault' 时的 vault 相对文件夹(如 "assets")。 */
  notesAttachmentFolder: string
  /** 导入文件是否默认开启预览(![[file]] 形式);false=插入 [名](路径) 链接。 */
  notesImportPreview: boolean
  /** 日记(每日笔记)所在 vault 相对文件夹;'' = vault 根。 */
  notesDailyFolder: string
  /** 朗读(TTS)模型 id(<providerId>/<model> 或某 provider ttsModelIds 命中);'' = 未启用,聊天不显示朗读按钮。 */
  ttsModelId: string
  /** 朗读音色 id(provider 特定,如 'alloy');'' = 不传该参数(OpenAI 等部分服务必填音色)。 */
  ttsVoice: string
  /** 朗读语速 0.5–2。 */
  ttsSpeed: number
  /** 新回复完成后自动朗读(仅当前活跃会话)。 */
  ttsAutoSpeak: boolean
  /** 记录应用内活动日志(~/.forsion/activity;Muse 数据源+bug 排查导出);关=停止新记录。 */
  activityLogEnabled: boolean
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
  asrModelId: '',
  asrBackend: 'cloud',
  cloudUrl: '',
  cloudToken: '',
  sandbox: 'auto',
  pythonMode: 'bundled',
  mirror: 'default',
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
  notesAttachmentMode: 'attachments',
  notesAttachmentFolder: 'assets',
  notesImportPreview: true,
  notesDailyFolder: '',
  ttsModelId: '',
  ttsVoice: '',
  ttsSpeed: 1,
  ttsAutoSpeak: false,
  activityLogEnabled: true,
}

/** 默认工作区目录(配置未填时兜底):新用户 ~/Forsion(dev→~/Forsion-Dev);
 *  仅当存在**真实** ~/Tangu 目录(老用户,迁移软链不算)才沿用 ~/Tangu。best-effort 创建。 */
async function ensureDefaultWorkspaceDir(stored: TanguStoredConfig): Promise<string> {
  let dir = stored.defaultWorkspaceDir?.trim()
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
  'mode', 'backendUrl', 'token', 'wechatAllowedPeers', 'forsionSyncEnabled', 'forsionLastSyncedAt',
  'pythonMode', 'mirror', // 桌面专属(内置 python 是桌面才有的能力;镜像经后端 env 注入,不落 config.json 段)
  'activityLogEnabled', // 桌面专属(活动日志由 main 落盘)
]
const configPath = (): string => join(app.getPath('userData'), 'tangu-desktop-config.json')

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
          await mkdir(app.getPath('userData'), { recursive: true }).catch(() => {})
          await writeFile(configPath(), JSON.stringify(seeded, null, 2), 'utf8') // 落盘一次,此后与旧目录解耦
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
  const cloud = home.cloud || {}, browser = home.browser || {}, wechat = home.wechat || {}, notes = home.notes || {}, tts = home.tts || {}, asr = home.asr || {}
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
    ...(home.notes !== undefined ? {
      notesAttachmentMode: notes.mode || 'attachments',
      notesAttachmentFolder: notes.folder || 'assets',
      notesImportPreview: notes.preview !== false,
      notesDailyFolder: notes.dailyFolder || '',
    } : {}),
    ...(home.tts !== undefined ? {
      ttsModelId: tts.modelId || '',
      ttsVoice: tts.voice || '',
      ttsSpeed: typeof tts.speed === 'number' ? tts.speed : 1,
      ttsAutoSpeak: !!tts.autoSpeak,
    } : {}),
    ...(home.asr !== undefined ? { asrModelId: asr.modelId || '', asrBackend: asr.backend === 'local' ? 'local' : 'cloud' } : {}),
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
  const cloud = { ...(home.cloud || {}) }, browser = { ...(home.browser || {}) }, wechat = { ...(home.wechat || {}) }, notes = { ...(home.notes || {}) }, tts = { ...(home.tts || {}) }, asr = { ...(home.asr || {}) }
  let cT = false, bT = false, wT = false, oT = false, nT = false, tT = false, aT = false
  if ('cloudUrl' in patch) { cloud.url = patch.cloudUrl; cT = true }
  if ('cloudToken' in patch) { cloud.token = patch.cloudToken; cT = true }
  if ('modelId' in patch) { cloud.defaultModel = patch.modelId; cT = true }
  if ('asrModelId' in patch) { asr.modelId = patch.asrModelId; aT = true }
  if ('asrBackend' in patch) { asr.backend = patch.asrBackend; aT = true }
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
  if ('notesAttachmentMode' in patch) { notes.mode = patch.notesAttachmentMode; nT = true }
  if ('notesAttachmentFolder' in patch) { notes.folder = patch.notesAttachmentFolder; nT = true }
  if ('notesImportPreview' in patch) { notes.preview = patch.notesImportPreview; nT = true }
  if ('notesDailyFolder' in patch) { notes.dailyFolder = patch.notesDailyFolder; nT = true }
  if ('ttsModelId' in patch) { tts.modelId = patch.ttsModelId; tT = true }
  if ('ttsVoice' in patch) { tts.voice = patch.ttsVoice; tT = true }
  if ('ttsSpeed' in patch) { tts.speed = patch.ttsSpeed; tT = true }
  if ('ttsAutoSpeak' in patch) { tts.autoSpeak = patch.ttsAutoSpeak; tT = true }
  if (cT) home.cloud = cloud
  if (bT) home.browser = browser
  if (wT) home.wechat = wechat
  if (nT) home.notes = notes
  if (tT) home.tts = tts
  if (aT) home.asr = asr
  if (cT || bT || wT || oT || nT || tT || aT) await writeHomeConfig(home)
  return loadConfig()
}

const backend = new BackendManager()
let mainWindow: BrowserWindow | null = null
// 托盘常驻:关窗默认只隐藏;仅托盘「退出」/before-quit 置 true 后才放行真正关闭。
let isQuitting = false

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
  if (!PRODUCT.agentBackend) return Promise.resolve() // 产品档案:本变体不捆 agent 托管后端
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
      pythonMode: stored.pythonMode,
      mirror: stored.mirror,
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

/** 所有窗口(主窗 + 独立窗 + mini)共用的 webPreferences:同一份 preload → 同一 window.tangu 暴露面。 */
function satelliteWebPreferences(): Electron.WebPreferences {
  return {
    preload: join(__dirname, '../preload/preload.mjs'),
    contextIsolation: true,
    nodeIntegration: false,
    // sandbox:true 不支持 ESM preload(electron-vite 产出 .mjs);renderer 无 Node 能力,暴露面仅 contextBridge 最小 API。
    sandbox: false,
    plugins: true, // Chromium 内置 PDFium(blob pdf 预览)
  }
}

/** 子窗口打开处理:http(s) 转系统浏览器,其余一律拒绝(不产生游离子窗口)。 */
function denyExternal({ url }: { url: string }): { action: 'deny' } {
  if (url.startsWith('https://') || url.startsWith('http://')) shell.openExternal(url)
  return { action: 'deny' }
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
    // macOS 系统玻璃必须在建窗时具备透明能力;是否真的启用 vibrancy 由当前主题经 IPC 动态决定。
    // 其他平台保持原来的实色窗口,不改变稳定性/窗口行为。
    transparent: process.platform === 'darwin',
    backgroundColor: process.platform === 'darwin' ? '#00000000' : '#fbf8f5',
    webPreferences: satelliteWebPreferences(),
  })

  mainWindow.webContents.setWindowOpenHandler(denyExternal)

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
  mainWindow.show()
  mainWindow.focus()
}

// ══ 卫星窗口:独立窗(拖出的 dockview,无 ribbon)+ mini 悬浮卡片 ═══════════════════════
interface ViewDesc { type: string; params?: Record<string, unknown> }

const detachedWindows = new Map<string, BrowserWindow>()
const pendingDetachedViews = new Map<string, ViewDesc[]>() // 拖出登记的初始视图,渲染端 detachedReady 时 pull
let persistedDetached: Array<{ id: string; bounds: Electron.Rectangle }> = [] // 内存副本 + 落盘(重启恢复)
let detachedSeq = 0

const detachedStatePath = (): string => join(app.getPath('userData'), 'detached-windows.json')

async function loadDetachedState(): Promise<void> {
  try {
    const arr = JSON.parse(await readFile(detachedStatePath(), 'utf8'))
    if (Array.isArray(arr)) persistedDetached = arr.filter((x) => x && typeof x.id === 'string' && x.bounds)
  } catch { persistedDetached = [] }
}
let saveDetachedTimer: NodeJS.Timeout | null = null
function scheduleSaveDetachedState(): void {
  if (saveDetachedTimer) clearTimeout(saveDetachedTimer)
  saveDetachedTimer = setTimeout(() => { void writeFile(detachedStatePath(), JSON.stringify(persistedDetached)).catch(() => {}) }, 400)
}
function upsertDetachedBounds(id: string, bounds: Electron.Rectangle): void {
  const i = persistedDetached.findIndex((x) => x.id === id)
  if (i >= 0) persistedDetached[i].bounds = bounds
  else persistedDetached.push({ id, bounds })
  scheduleSaveDetachedState()
}
function removeDetachedState(id: string): void {
  persistedDetached = persistedDetached.filter((x) => x.id !== id)
  scheduleSaveDetachedState()
}

function nextDetachedId(): string { detachedSeq += 1; return `d${Date.now().toString(36)}_${detachedSeq}` }

function createDetachedWindow(opts: { id?: string; views?: ViewDesc[]; bounds?: Partial<Electron.Rectangle> }): string {
  const id = opts.id || nextDetachedId()
  if (opts.views?.length) pendingDetachedViews.set(id, opts.views)
  const win = new BrowserWindow({
    width: opts.bounds?.width ?? 900,
    height: opts.bounds?.height ?? 680,
    x: opts.bounds?.x,
    y: opts.bounds?.y,
    minWidth: 480,
    minHeight: 360,
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    autoHideMenuBar: true,
    transparent: process.platform === 'darwin',
    backgroundColor: process.platform === 'darwin' ? '#00000000' : '#fbf8f5',
    webPreferences: satelliteWebPreferences(),
  })
  detachedWindows.set(id, win)
  win.webContents.setWindowOpenHandler(denyExternal)
  const persist = (): void => { if (!win.isDestroyed()) upsertDetachedBounds(id, win.getBounds()) }
  win.on('moved', persist)
  win.on('resized', persist)
  win.on('closed', () => {
    console.log('[win] detached closed', id)
    detachedWindows.delete(id)
    pendingDetachedViews.delete(id)
    removeDetachedState(id) // 用户主动关 = 不再恢复;布局键留 localStorage 无害
  })
  upsertDetachedBounds(id, win.getBounds()) // 立即登记(拖出后崩溃也能恢复)
  console.log('[win] detached open', id, 'views=', opts.views?.map((v) => v.type).join(','))
  loadRendererWith(win, { window: 'detached', id, ui: 'desktop' })
  return id
}

async function restoreDetachedWindows(): Promise<void> {
  await loadDetachedState()
  for (const { id, bounds } of [...persistedDetached]) createDetachedWindow({ id, bounds })
}

let miniWindow: BrowserWindow | null = null
/** 贴边吸附态:edge=贴哪条边,expanded=当前是否展开。null=未贴边(自由浮动)。 */
let miniDock: { edge: Edge; expanded: boolean } | null = null
let suppressMiniMoved = false // 抑制程序化 setBounds 触发的 moved(否则折叠/展开自激)
let miniDragging = false // 用户正在拖窗(moved 连发中);其间不吸附/不轮询,避免和拖拽对打(修「拖不出来」)
let miniSettleTimer: NodeJS.Timeout | null = null
let miniPollTimer: NodeJS.Timeout | null = null

const MINI_PEEK = 8 // 折叠后露出的薄条 px
const MINI_TRIGGER_PAD = 6 // 悬停触发容差(薄条外扩,好点中)
const MINI_HYSTERESIS = 28 // 展开后离开迟滞(出界超此才折叠,修「一动就弹回」)

function createMiniWindow(): void {
  const { width, height } = miniSizeFromWidth(300) // 300×400,3:4 竖比
  const wa = screen.getPrimaryDisplay().workArea
  miniWindow = new BrowserWindow({
    width, height,
    x: wa.x + wa.width - width - 24,
    y: wa.y + 24,
    minWidth: width, minHeight: height, maxWidth: width, maxHeight: height, // 锁 3:4
    frame: false,
    transparent: true,
    resizable: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    hasShadow: true,
    backgroundColor: '#00000000',
    webPreferences: satelliteWebPreferences(),
  })
  miniWindow.setAlwaysOnTop(true, 'floating')
  miniWindow.webContents.setWindowOpenHandler(denyExternal)
  miniWindow.on('moved', onMiniMoved)
  miniWindow.on('closed', () => { console.log('[win] mini closed'); miniWindow = null; miniDock = null; stopMiniPoll() })
  console.log('[win] mini open')
  loadRendererWith(miniWindow, { window: 'mini', ui: 'mobile' })
}

function toggleMiniWindow(): void {
  if (miniWindow && !miniWindow.isDestroyed()) {
    if (miniWindow.isVisible()) miniWindow.hide()
    else { miniWindow.show(); miniWindow.focus() }
  } else createMiniWindow()
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
        buttons: ['重新加载', '退出'],
        defaultId: 0,
        message: '界面多次崩溃',
        detail: `原因:${reason}\n可重新加载,或退出后重开 Tangu。`,
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

// Amadeus Space:amadeus-asset:// 自定义协议须在 app ready 前登记为 privileged。
registerAmadeusAssetSchemes()

app.whenReady().then(async () => {
  // Windows 系统通知前提(无 AppUserModelId 时 Notification 可能不弹);mac/linux 无副作用。
  app.setAppUserModelId('com.forsion.tangu')
  // 媒体权限(麦克风,语音输入):Electron 层放行——部分平台/版本默认拒 getUserMedia。callback(true) 沿用
  // 「未设 handler=全放行」的既有默认,不回归其他权限(通知等)。macOS 仍受系统隐私设置门控(拒了要去设置改)。
  session.defaultSession.setPermissionRequestHandler((_wc, _permission, callback) => callback(true))
  session.defaultSession.setPermissionCheckHandler(() => true)
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
  await seedDefaultThemes(themesDir()) // 首次运行种入 soft 示例主题(themes/ 已存在则跳过;内部吞错不阻塞启动)
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
    setActivityLogEnabled((await loadConfig()).activityLogEnabled !== false)
    void pruneActivity()
    logActivity('app.start', { v: app.getVersion() })
  } catch { /* 装饰性,不阻塞启动 */ }
  // renderer 埋点入口:结构化 {event, detail},拼行/消毒只在 activityLog.ts(用户内容进不了行结构)。
  ipcMain.on('activity:append', (_e, payload: { event?: unknown; detail?: unknown }) => {
    if (!payload || typeof payload.event !== 'string') return
    const detail = payload.detail && typeof payload.detail === 'object' ? (payload.detail as Record<string, unknown>) : undefined
    logActivity(payload.event, detail)
  })
  ipcMain.handle('activity:export', (_e, days?: number) => exportActivity(Number(days) || 7))

  ipcMain.handle('config:get', () => effectiveConfig())
  ipcMain.handle('config:set', async (_e, patch: Partial<TanguStoredConfig>) => {
    const before = await loadConfig()
    await saveConfig(patch)
    if (patch.activityLogEnabled !== undefined) setActivityLogEnabled(patch.activityLogEnabled !== false)
    // 模式/托管参数变化 → 重启托管后端(切到 external 则停掉)。
    const managedKeys: Array<keyof TanguStoredConfig> = [
      'mode', 'cloudUrl', 'cloudToken', 'sandbox', 'pythonMode', 'mirror',
      'browserEnabled', 'browserEngine', 'browserSearchEngine', 'browserAllowPrivateUrls', 'browserCommandTimeoutMs',
      'wechatEnabled', 'wechatRemoteApprovalMode',
    ]
    if (managedKeys.some((k) => patch[k] !== undefined && patch[k] !== before[k])) {
      void ensureBackend()
    }
    return effectiveConfig()
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
  ipcMain.handle('inbox:badge', (_e, count: number) => {
    // setBadgeCount:mac dock 原生;Linux 仅 Unity;Windows 无角标概念(需 setOverlayIcon 自绘,v1 no-op)。
    if (process.platform === 'darwin') app.setBadgeCount(Math.max(0, Math.floor(Number(count) || 0)))
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
  /** 单条目 stat(侧栏悬停提示用;悬停 1s 才调 = 天然节流,不进 listDir 热路径)。
   *  文件 → 修改/创建时间;目录 → 另带直接子项计数。⚠️birthtime 只有 mac/Windows 可靠,
   *  Linux 部分文件系统拿不到 → Node 给 0(或悄悄回退 ctime);0 一律当「无」,由渲染层省略该行。 */
  ipcMain.handle('fs:stat', async (_e, p: string) => {
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
    if (st.size > MAX_PREVIEW_BYTES) return { mimeType, content: '', size: st.size, mtimeMs: st.mtimeMs, tooLarge: true }
    const buf = await readFile(filePath)
    return { mimeType, content: buf.toString('base64'), size: st.size, mtimeMs: st.mtimeMs }
  })
  // ── Coding Space:本地静态预览服务器(整 cwd 挂 127.0.0.1 随机端口;渲染端 iframe 加载多文件 web app)──
  ipcMain.handle('codePreview:serve', async (_e, rootDir: string) => {
    if (!rootDir || typeof rootDir !== 'string') throw new Error('非法的预览根目录')
    return codePreviewServe(rootDir)
  })
  ipcMain.handle('codePreview:stop', () => { stopCodePreview(); return { ok: true } })
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
  // 写回文本文件(工作区 .md 编辑 / 新建文件):写 tmp → fsync → rename 原子替换,失败清理 tmp;
  // expectedMtimeMs 不符**或文件已消失(被删/改名)** → 冲突不写(外部修改保护,防复活旧路径);
  // createNew=O_EXCL 内核原子独占创建(新建绝不覆盖,无 TOCTOU)。
  ipcMain.handle('fs:writeFile', async (_e, filePath: string, content: string, expectedMtimeMs?: number, createNew?: boolean) => {
    if (!filePath || typeof filePath !== 'string' || filePath.includes('\0') || typeof content !== 'string')
      throw new Error('非法的写入参数')
    if (createNew) {
      try { await writeFile(filePath, content, { encoding: 'utf8', flag: 'wx' }) }
      catch (e: any) { throw e?.code === 'EEXIST' ? new Error('同名文件/文件夹已存在') : e }
      const st0 = await stat(filePath)
      return { ok: true, mtimeMs: st0.mtimeMs }
    }
    if (typeof expectedMtimeMs === 'number') {
      const cur = await stat(filePath).catch(() => null)
      if (!cur) return { conflict: true, mtimeMs: 0 } // 基准文件已不在:视作冲突,别在旧路径复活
      if (Math.abs(cur.mtimeMs - expectedMtimeMs) > 1) return { conflict: true, mtimeMs: cur.mtimeMs }
    }
    const tmp = `${filePath}.tmp-${process.pid}-${Date.now()}`
    try {
      const fh = await fsOpen(tmp, 'w')
      try { await fh.writeFile(content, 'utf8'); await fh.sync() } finally { await fh.close() }
      await rename(tmp, filePath)
    } catch (e) {
      await unlink(tmp).catch(() => {}) // 半写残留清理(ENOSPC/rename 失败等)
      throw e
    }
    const st = await stat(filePath)
    return { ok: true, mtimeMs: st.mtimeMs }
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
    // 补全 PATH(GUI 子进程找得到 brew/winget)+ 中国大陆时注入 brew/pip/npm 镜像 env,
    // 否则「切了镜像」对引导安装完全不生效(brew bottles/GitHub 直连在国内基本走不通)。
    const mirrorEnv = (await loadConfig()).mirror === 'china' ? chinaInstallEnv() : {}
    return await new Promise<{ exitCode: number }>((resolve) => {
      const child = spawn(command, { shell: true, env: envWithFullPath(mirrorEnv) })
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
  ipcMain.handle('plugin:request-install', (_e, appId: string) => {
    const cmd = KNOWN_APPS[String(appId)]?.install[process.platform as 'darwin' | 'win32' | 'linux']
    if (!cmd) return null // 表外 id / 本平台无一键命令 → 前端降级「打开官网」
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
  // 主题只提交白名单语义(system-glass/opaque);具体 vibrancy 类型与平台能力由主进程掌控。
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
  ipcMain.handle('discovery:importMcp', async (_e, names: string[]) => {
    // importMcp 在 legacy mcp.json 上做合并:先把 config.json 的 mcp 段播种进去(免丢已有),导入后再写回 config.json。
    const home = await readHomeConfig()
    await mkdir(tanguDataDir(), { recursive: true })
    await writeFile(mcpFile(), JSON.stringify({ mcpServers: home.mcp?.mcpServers || {} }, null, 2), 'utf8')
    const r = await importMcp(Array.isArray(names) ? names.filter((x) => typeof x === 'string') : [], tanguDataDir())
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

  // ── 桌面级共享语音转写(任意功能复用:聊天框、Amadeus…;本地/自带-key,不经引擎/服务端)──
  ipcMain.handle('asr:transcribe', async (_e, req: { audioBase64: string; mime?: string; modelId?: string; language?: string }) => {
    const cfg = await loadConfig()
    const audio = Buffer.from(req?.audioBase64 || '', 'base64')
    if (!audio.length) throw new Error('空音频')
    // 本地优先:选了本地且模型就绪 → 离线转写(不联网)。
    if (cfg.asrBackend === 'local' && localModelReady()) {
      return transcribeLocal(audio)
    }
    // 云端:自带 provider(<provider>/<model> 命中 providers.json)→ 主进程直连上游;否则走 Forsion 托管(计费)。
    const modelId = (req?.modelId || cfg.asrModelId || '').trim()
    const i = modelId.indexOf('/')
    const provider = i > 0 ? (await readProvidersFile()).find((p) => p.providerId === modelId.slice(0, i)) : undefined
    if (provider) {
      return transcribeViaOpenAI({ baseUrl: provider.baseUrl, apiKey: provider.apiKey, model: modelId.slice(i + 1), audio, mime: req?.mime || 'audio/wav', language: req?.language })
    }
    // 非自带 provider = Forsion 托管模型(或未选,让服务端用 app asr 默认)→ 直连 Forsion 服务端(token 不下发 renderer)。
    const creds = loadTanguCreds()
    const cloudUrl = cfg.cloudUrl || creds.cloudUrl || ''
    const token = cfg.cloudToken || creds.token || ''
    if (!cloudUrl || !token) throw new Error('未设置语音识别:选一个自带 provider 的语音识别模型 + key,或登录 Forsion 用云端,或下载本地语音模型。')
    return transcribeViaForsion({ cloudUrl, token, modelId, audioB64: req?.audioBase64 || '', mime: req?.mime || 'audio/wav', language: req?.language })
  })

  // ── 本地语音模型(SenseVoice)下载 / 状态 / 删除。下载进度经 'asr:localProgress' 推回发起窗口。──
  ipcMain.handle('asr:localStatus', () => ({ ready: localModelReady(), sizeBytes: localModelSize() }))
  ipcMain.handle('asr:localDownload', async (e) => {
    const cfg = await loadConfig()
    await downloadLocalModel(cfg.mirror === 'china' ? 'china' : 'default', (received, total) => {
      if (!e.sender.isDestroyed()) e.sender.send('asr:localProgress', { received, total })
    })
    return { ok: true, ready: localModelReady() }
  })
  ipcMain.handle('asr:localRemove', async () => { await removeLocalModel(); return { ok: true } })

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
      // null=未校验/离线(不确定);true=有效;false=已失效(401/403)。供前端检测「登录过期」用,离线不误判。
      tokenValid: who ? (who.status === 'ok' ? true : who.status === 'expired' ? false : null) : null,
      cloudUrl,
      username: who?.user?.username || null,
      nickname: who?.user?.nickname || null,
      avatar: who?.user?.avatar || null,
      membershipTier: who?.user?.membershipTier || null,
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

  // 应用内「卸载 / 清空数据」(mac/linux 无 NSIS 卸载器,靠此;Windows 也可用)。清完 relaunch 为全新状态。
  //   tangu:  ~/.forsion(账号/设置/Agent 数据/会话/state.db)+ ~/Forsion 工作区 + ~/.tangu、~/Tangu 兼容软链
  //   desktop:userData 里的壳层配置(窗口/Amadeus)
  ipcMain.handle('app:clearData', async (_e, opts: { desktop?: boolean; tangu?: boolean }) => {
    await backend.stop() // 释放 state.db 句柄,否则占用删不掉
    if (opts?.tangu) {
      for (const p of [forsionHomeDir(), forsionWorkspaceDir(), join(homedir(), '.tangu'), join(homedir(), 'Tangu')]) {
        await rm(p, { recursive: true, force: true }).catch(() => {})
      }
    }
    if (opts?.desktop) {
      for (const f of ['tangu-desktop-config.json', 'amadeus-config.json']) {
        await rm(join(app.getPath('userData'), f), { force: true }).catch(() => {})
      }
    }
    isQuitting = true
    app.relaunch()
    app.exit(0)
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
  /** 中国大陆镜像:github release/raw 下载的候选地址序列——多代理站依次回退,最后直连兜底
   *  (gh 代理站点更迭频繁,单点必然间歇性失效;TANGU_GITHUB_PROXY 可指定首选)。非 github 地址原样单发。 */
  const GH_PROXIES = ['https://ghfast.top', 'https://ghproxy.net', 'https://gh-proxy.com']
  const githubMirrorCandidates = (url: string): string[] => {
    if (!/^https:\/\/(github\.com|[^/]*\.githubusercontent\.com)\//.test(url)) return [url]
    const custom = (process.env.TANGU_GITHUB_PROXY || '').replace(/\/+$/, '')
    const proxies = custom ? [custom, ...GH_PROXIES.filter((p) => p !== custom)] : GH_PROXIES
    return [...proxies.map((p) => `${p}/${url}`), url]
  }

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
    // 中国大陆镜像:github 源(release 资产)按「多代理 → 直连」序列依次尝试;zip 源(Forsion 对象存储)本就可达,不改。
    const stored = await loadConfig()
    const candidates = stored.mirror === 'china' && info.source === 'github'
      ? githubMirrorCandidates(info.downloadUrl)
      : [info.downloadUrl]
    let zipRes: Response | null = null
    let lastErr = ''
    for (const dl of candidates) {
      try {
        const r = await fetch(dl, { headers: { 'User-Agent': MARKET_UA } })
        if (r.ok) { zipRes = r; break }
        lastErr = `HTTP ${r.status}`
      } catch (e: any) {
        lastErr = e?.message || String(e)
      }
    }
    if (!zipRes) throw new Error(`下载失败(${candidates.length} 个地址均不可达:${lastErr})`)
    const buf = Buffer.from(await zipRes.arrayBuffer())
    const dest = join(tanguHomeDir(), sub, info.installSlug)
    const files = await extractZipToDir(buf, dest, MARKET_MANIFEST[info.type] || [])
    return { ok: true, path: dest, files, type: info.type, slug: info.installSlug }
  })

  ipcMain.handle('market:installed', async () => {
    // 每个已装项带版本号(读其 manifest),供市场「可更新」检查。
    const out: Record<string, Array<{ slug: string; version: string | null }>> = { skill: [], agent: [], plugin: [], space: [], theme: [], 'amadeus-plugin': [] }
    for (const [type, sub] of Object.entries(MARKET_SUBDIR)) {
      try {
        const base = join(tanguHomeDir(), sub)
        const ents = await readdir(base, { withFileTypes: true })
        out[type] = await Promise.all(
          ents.filter((e) => e.isDirectory()).map(async (e) => ({ slug: e.name, version: await readInstalledVersion(type, join(base, e.name)) })),
        )
      } catch {
        /* 目录不存在 = 空 */
      }
    }
    return out
  })

  // ── 用户自定义 Space:~/.tangu/spaces/<slug>/space.json(纯数据布局配方;market type='space' 装到同目录)──
  ipcMain.handle('spaces:list', async () => {
    const out: Array<{ slug: string; json: string }> = []
    try {
      const base = join(tanguHomeDir(), 'spaces')
      for (const e of (await readdir(base, { withFileTypes: true })).filter((x) => x.isDirectory())) {
        try { out.push({ slug: e.name, json: await readFile(join(base, e.name, 'space.json'), 'utf8') }) } catch { /* 无 manifest 跳过 */ }
      }
    } catch { /* 目录不存在 = 空 */ }
    return out
  })
  ipcMain.handle('spaces:save', async (_e, slug: string, json: string) => {
    if (!isSafeSlug(slug)) throw new Error('非法的 Space 标识')
    JSON.parse(json) // 落盘前校验合法 JSON,防写入损坏配方
    const dir = join(tanguHomeDir(), 'spaces', slug)
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, 'space.json'), json, 'utf8')
    return { ok: true }
  })
  ipcMain.handle('spaces:delete', async (_e, slug: string) => {
    if (!isSafeSlug(slug)) throw new Error('非法的 Space 标识')
    await rm(join(tanguHomeDir(), 'spaces', slug), { recursive: true, force: true })
    return { ok: true }
  })

  // ── 后端插件卸载:只动 ~/.tangu/plugins(用户目录);<pkg>/plugins 首方插件结构性安全(不在这里,删不到)。
  // manifest id 可能 ≠ 目录名,须读 manifest 映射。设置清理走后端 DELETE /agent/plugins/:id,重启由前端触发。
  ipcMain.handle('plugins:userInstalled', () => readUserPluginDirs(join(tanguDataDir(), 'plugins')))
  ipcMain.handle('plugins:uninstall', async (_e, id: string) => {
    if (!isSafeSlug(id)) throw new Error('非法的插件标识')
    const hit = (await readUserPluginDirs(join(tanguDataDir(), 'plugins'))).find((p) => p.id === id)
    if (!hit) throw new Error('插件不在用户目录(内置/首方插件不可卸载)')
    await rm(join(tanguDataDir(), 'plugins', hit.slug), { recursive: true, force: true })
    return { ok: true }
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

  // 登录成功后踢一次 Amadeus 云同步引擎(值由下方 registerAmadeusIpc 返回时赋上)。否则引擎状态卡在
  // auth-required:云端登录提示不消失 + 双向同步不启动(引擎凭据只有 restart 会重读,登录路径原本不触发)。
  let restartAmadeusSync: (() => void) | null = null
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
    restartAmadeusSync?.() // 登录成功:重读凭据、拉起云端双向同步(修「已登录仍显示登录提示 + 同步没开」)
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
    if (stored.mode === 'managed') void ensureBackend() // 重启让后端加载该 provider
    return { ok: true, id }
  })

  backend.onStatus((st) => {
    for (const w of BrowserWindow.getAllWindows()) {
      w.webContents.send('backend:status', st)
    }
  })

  // ── 多窗口 IPC:独立窗 + mini 卡片 ──
  ipcMain.handle('window:detachedReady', (_e, id: string) => {
    const v = pendingDetachedViews.get(String(id)) || []
    pendingDetachedViews.delete(String(id))
    return v
  })
  ipcMain.handle('window:openDetached', (_e, views: ViewDesc[], at?: { screenX: number; screenY: number }) => {
    const list = Array.isArray(views) ? views.filter((v) => v && typeof v.type === 'string') : []
    const bounds = at ? { x: Math.round(at.screenX), y: Math.round(at.screenY), width: 900, height: 680 } : undefined
    return { id: createDetachedWindow({ views: list, bounds }) }
  })
  ipcMain.on('window:openMini', () => toggleMiniWindow())
  ipcMain.on('window:closeSelf', (e) => BrowserWindow.fromWebContents(e.sender)?.close())
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

  void ensureBackend()
  createWindow()
  void restoreDetachedWindows() // 恢复上次退出时的独立窗(位置/尺寸 + 各窗自恢复布局)
  // 系统托盘 / mac 菜单栏图标:显示窗口 / 检查更新 / 退出。
  createTray({
    show: showMainWindow,
    checkUpdates: () => { void checkForUpdates() },
    quit: () => { isQuitting = true; app.quit() },
  })
  // Amadeus Space:装载 vault IPC(暴露给 window.amadeus)+ 资产协议(指向当前 vault 根)。
  const { getVaultRoot, restartSync } = registerAmadeusIpc(() => mainWindow)
  restartAmadeusSync = restartSync
  registerAmadeusAssetProtocol(getVaultRoot)
  app.on('activate', () => showMainWindow()) // dock/tray 唤起:隐藏则显示,销毁则重建
  // GPU 进程崩溃(Windows 驱动 TDR / 睡眠恢复常见)会级联拖垮渲染器 → 白屏。监听并自愈。
  app.on('child-process-gone', (_e, d) => {
    console.error('[tangu-desktop] child-process-gone', d.type, d.reason)
    if (d.type === 'GPU' && d.reason !== 'clean-exit') recoverRenderer(`gpu-gone:${d.reason}`)
  })
})

app.on('before-quit', (e) => {
  isQuitting = true // 放行 window close 拦截(否则 hide 会吞掉退出)
  globalShortcut.unregisterAll() // 释放 mini 全局快捷键
  flushAllNoteEdits() // 活动日志:5 分钟合并窗口内未落盘的 note.edit 冲出去
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
