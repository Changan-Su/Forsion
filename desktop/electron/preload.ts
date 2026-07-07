/**
 * Preload:contextBridge 暴露最小安全 API(配置读写 + 托管后端状态)。
 * agent 调用 renderer 直连 HTTP,不经主进程。
 */
import { contextBridge, ipcRenderer, webUtils } from 'electron'
import { PRODUCT } from './product'
import './amadeus/preload' // Amadeus Space:暴露 window.amadeus(vault IPC 桥),副作用导入

export interface BackendStatus {
  state: 'stopped' | 'starting' | 'ready' | 'crashed'
  url: string | null
  pid: number | null
  lastError: string | null
}

const api = {
  /** 宿主平台('darwin' | 'win32' | 'linux');渲染层据此调标题栏/交通灯留白等。 */
  platform: process.platform as string,
  getConfig: (): Promise<any> => ipcRenderer.invoke('config:get'),
  setConfig: (patch: Record<string, any>): Promise<any> => ipcRenderer.invoke('config:set', patch),
  backendStatus: (): Promise<BackendStatus> => ipcRenderer.invoke('backend:getStatus'),
  backendLogs: (): Promise<string[]> => ipcRenderer.invoke('backend:getLogs'),
  backendRestart: (): Promise<BackendStatus> => ipcRenderer.invoke('backend:restart'),
  onBackendStatus: (cb: (st: BackendStatus) => void): (() => void) => {
    const listener = (_e: unknown, st: BackendStatus): void => cb(st)
    ipcRenderer.on('backend:status', listener)
    return () => ipcRenderer.removeListener('backend:status', listener)
  },
  // ── 收件箱:系统通知 + dock 角标(仅 mac)+ 通知点击回跳订阅 ──
  notifyInbox: (title: string, body: string): Promise<void> => ipcRenderer.invoke('inbox:notify', title, body),
  setInboxBadge: (count: number): Promise<void> => ipcRenderer.invoke('inbox:badge', count),
  onInboxOpen: (cb: () => void): (() => void) => {
    const listener = (): void => cb()
    ipcRenderer.on('inbox:open', listener)
    return () => ipcRenderer.removeListener('inbox:open', listener)
  },
  // ── Forsion 账号 / provider OAuth 登录(与 `tangu login` 同一份凭证)──
  authStatus: (): Promise<any> => ipcRenderer.invoke('auth:status'),
  forsionLogin: (cloudUrl?: string): Promise<any> => ipcRenderer.invoke('auth:forsionLogin', cloudUrl),
  forsionLogout: (): Promise<any> => ipcRenderer.invoke('auth:logout'),
  authProviders: (): Promise<Array<{ id: string; loggedIn: boolean }>> => ipcRenderer.invoke('auth:providers'),
  providerLogin: (id: string): Promise<any> => ipcRenderer.invoke('auth:providerLogin', id),
  openAccountCenter: (section?: string): Promise<{ ok: boolean }> => ipcRenderer.invoke('auth:openAccountCenter', section),
  /** 提交反馈到 Forsion 反馈中心(会话日志 JSON 随附为附件;token 留主进程)。 */
  submitFeedback: (input: { description: string; sessionLogJson?: string; sessionLogName?: string }): Promise<{ ok: boolean; id?: string | null; error?: string; attachmentSkipped?: boolean }> =>
    ipcRenderer.invoke('feedback:submit', input),
  appVersion: (): Promise<string> => ipcRenderer.invoke('app:version'),
  // ── 应用内自动更新(检查 → 下载 → 重启安装;mac 仅检测,引导手动下载)──
  checkForUpdates: (): Promise<any> => ipcRenderer.invoke('updater:check'),
  downloadUpdate: (): Promise<void> => ipcRenderer.invoke('updater:download'),
  installUpdate: (): Promise<{ ok: boolean }> => ipcRenderer.invoke('updater:install'),
  /** 应用内清空数据(卸载/重置);清完主进程会 relaunch。 */
  clearAppData: (opts: { desktop?: boolean; tangu?: boolean }): Promise<{ ok: boolean }> =>
    ipcRenderer.invoke('app:clearData', opts),
  onUpdaterStatus: (cb: (st: any) => void): (() => void) => {
    const listener = (_e: unknown, st: any): void => cb(st)
    ipcRenderer.on('updater:status', listener)
    return () => ipcRenderer.removeListener('updater:status', listener)
  },
  onAuthDevice: (cb: (info: { url: string; userCode: string }) => void): (() => void) => {
    const listener = (_e: unknown, info: { url: string; userCode: string }): void => cb(info)
    ipcRenderer.on('auth:device', listener)
    return () => ipcRenderer.removeListener('auth:device', listener)
  },
  /** 本机模式工作目录选择;取消返回 null。 */
  pickDirectory: (): Promise<string | null> => ipcRenderer.invoke('dialog:pickDirectory'),
  /** 另存为文本文件(导出日志等);取消返回 { ok:false }。 */
  saveTextFile: (defaultName: string, content: string): Promise<{ ok: boolean; path: string | null }> =>
    ipcRenderer.invoke('dialog:saveTextFile', defaultName, content),
  /** 拖入文件 → 绝对路径(Electron≥32 File.path 已移除,必须 webUtils 在渲染层取)。 */
  getPathForFile: (file: File): string => webUtils.getPathForFile(file),
  /** 本机工作区文件浏览:列目录 / 读文件(主进程 fs)。 */
  listDir: (dirPath: string): Promise<Array<{ name: string; isDir: boolean; size: number; path: string }>> =>
    ipcRenderer.invoke('fs:listDir', dirPath),
  readHostFile: (filePath: string): Promise<{ mimeType: string; content: string; size: number; mtimeMs?: number; tooLarge?: boolean }> =>
    ipcRenderer.invoke('fs:readFile', filePath),
  /** 用系统默认应用打开(预览不支持的类型)。 */
  openHostPath: (p: string): Promise<{ ok: boolean; error?: string }> => ipcRenderer.invoke('fs:openPath', p),
  /** Coding Space:把工作区目录挂本地静态服务器,返回 origin(iframe 加载多文件 web app 预览)。 */
  codePreviewServe: (rootDir: string): Promise<{ origin: string }> => ipcRenderer.invoke('codePreview:serve', rootDir),
  codePreviewStop: (): Promise<{ ok: boolean }> => ipcRenderer.invoke('codePreview:stop'),
  /** Coding Space 项目根 ~/Forsion/Project(确保存在)。 */
  codeProjectsRoot: (): Promise<string> => ipcRenderer.invoke('codeProjects:root'),
  /** 写回文本文件(工作区 .md 编辑):原子写;expectedMtimeMs 不符返回 conflict 不覆盖。 */
  writeHostFile: (filePath: string, content: string, expectedMtimeMs?: number, createNew?: boolean): Promise<{ ok?: boolean; conflict?: boolean; mtimeMs: number }> =>
    ipcRenderer.invoke('fs:writeFile', filePath, content, expectedMtimeMs, createNew),
  // ── 本机工作区文件操作:重命名 / 新建文件夹 / 删除到回收站 / 在文件管理器显示 / 原生拖出 ──
  renameHostPath: (oldPath: string, newName: string): Promise<{ path: string }> =>
    ipcRenderer.invoke('fs:rename', oldPath, newName),
  mkdirHost: (parentDir: string, name: string): Promise<{ path: string }> =>
    ipcRenderer.invoke('fs:mkdir', parentDir, name),
  trashHostPath: (p: string): Promise<{ ok: boolean }> => ipcRenderer.invoke('fs:trash', p),
  revealHostPath: (p: string): Promise<{ ok: boolean }> => ipcRenderer.invoke('fs:reveal', p),
  /** 原生拖出:在元素 onDragStart 里 e.preventDefault() 后调用,主进程接管系统级拖拽。 */
  startHostDrag: (filePath: string): void => ipcRenderer.send('fs:startDrag', filePath),
  /** 拖 OS 文件/文件夹进 host 工作区目录 → 原生复制(重名加序号)。 */
  copyHostFiles: (srcPaths: string[], destDir: string): Promise<{ copied: number }> =>
    ipcRenderer.invoke('fs:copy', srcPaths, destDir),
  /** 拖一行到文件夹 → 移动(同卷 rename)。 */
  moveHostPath: (srcPath: string, destDir: string): Promise<{ path: string }> =>
    ipcRenderer.invoke('fs:move', srcPath, destDir),
  // ── 直连 provider 管理(~/.tangu/providers.json;managed 模式保存后自动重启后端加载)──
  listProviders: (): Promise<any[]> => ipcRenderer.invoke('providers:list'),
  saveProvider: (provider: Record<string, any>): Promise<any[]> => ipcRenderer.invoke('providers:save', provider),
  deleteProvider: (providerId: string): Promise<any[]> => ipcRenderer.invoke('providers:delete', providerId),
  // ── MCP server 管理(~/.tangu/mcp.json;保存后托管后端重启重连)──
  readMcpConfig: (): Promise<{ mcpServers: Record<string, any> }> => ipcRenderer.invoke('mcp:read'),
  writeMcpConfig: (cfg: { mcpServers: Record<string, any> }): Promise<{ mcpServers: Record<string, any> }> =>
    ipcRenderer.invoke('mcp:write', cfg),
  // ── 跨生态 agent 资产发现/导入(~/.claude、~/.codex、~/.hermes → ~/.tangu)──
  discoveryScan: (): Promise<any> => ipcRenderer.invoke('discovery:scan'),
  discoveryImportSkills: (ids: string[]): Promise<{ imported: string[] }> =>
    ipcRenderer.invoke('discovery:importSkills', ids),
  discoveryImportMcp: (names: string[]): Promise<{ imported: string[] }> =>
    ipcRenderer.invoke('discovery:importMcp', names),
  // ── 拖入式主题(~/.tangu/themes/;主进程读盘成字符串,渲染端 <style> 注入)──
  listThemes: (): Promise<Array<{ id: string; manifest: Record<string, any>; css: string }>> =>
    ipcRenderer.invoke('themes:list'),
  openThemesDir: (): Promise<{ ok: boolean }> => ipcRenderer.invoke('themes:openDir'),
  // 设置界面「打开文件夹」:agent(slug 缺省=agents 根)/ skills 目录。
  openAgentDir: (slug?: string): Promise<{ ok: boolean }> => ipcRenderer.invoke('agents:openDir', slug),
  openSkillsDir: (): Promise<{ ok: boolean }> => ipcRenderer.invoke('skills:openDir'),
  // ── Forsion Market(浏览/详情/安装全走主进程:公开浏览 + 本地解压安装)──
  marketList: (type?: string): Promise<{ items: any[] }> => ipcRenderer.invoke('market:list', type),
  marketDetail: (id: string): Promise<any> => ipcRenderer.invoke('market:detail', id),
  marketInstall: (id: string): Promise<{ ok: boolean; path: string; files: number; type: string; slug: string }> =>
    ipcRenderer.invoke('market:install', id),
  marketInstalled: (): Promise<Record<string, string[]>> => ipcRenderer.invoke('market:installed'),
  // ── 后端插件卸载(仅 ~/.tangu/plugins 用户目录;设置清理走后端 DELETE,重启由前端触发)──
  pluginsUserInstalled: (): Promise<Array<{ id: string; slug: string }>> => ipcRenderer.invoke('plugins:userInstalled'),
  pluginsUninstall: (id: string): Promise<{ ok: boolean }> => ipcRenderer.invoke('plugins:uninstall', id),
  // ── 用户自定义 Space(~/.tangu/spaces;数据化布局配方,market type='space' 同目录)──
  spacesList: (): Promise<Array<{ slug: string; json: string }>> => ipcRenderer.invoke('spaces:list'),
  spacesSave: (slug: string, json: string): Promise<{ ok: boolean }> => ipcRenderer.invoke('spaces:save', slug, json),
  spacesDelete: (slug: string): Promise<{ ok: boolean }> => ipcRenderer.invoke('spaces:delete', slug),
  // ── 环境检测 + 引导安装(首启向导;run 仅认 check 登记的 opaque id)──
  envCheck: (): Promise<any[]> => ipcRenderer.invoke('env:check'),
  envRun: (installId: string): Promise<{ exitCode: number }> => ipcRenderer.invoke('env:run', installId),
  onEnvOutput: (cb: (ev: { installId: string; line: string }) => void): (() => void) => {
    const listener = (_e: unknown, ev: { installId: string; line: string }): void => cb(ev)
    ipcRenderer.on('env:output', listener)
    return () => ipcRenderer.removeListener('env:output', listener)
  },
}

// ── 产品档案收缩暴露面 ─────────────────────────────────────────────────────────
// 渲染端遍布 window.tangu?.X 能力门控:删掉键 = 对应功能(Inbox/市场/设置 agent tab/账号…)自动隐藏,UI 零改动。
const AGENT_KEYS = [
  'backendStatus', 'backendLogs', 'backendRestart', 'onBackendStatus',
  'notifyInbox', 'setInboxBadge', 'onInboxOpen',
  'authStatus', 'forsionLogin', 'forsionLogout', 'authProviders', 'providerLogin', 'openAccountCenter', 'onAuthDevice',
  'submitFeedback',
  'listProviders', 'saveProvider', 'deleteProvider',
  'readMcpConfig', 'writeMcpConfig',
  'discoveryScan', 'discoveryImportSkills', 'discoveryImportMcp',
  'openAgentDir', 'openSkillsDir',
  'envCheck', 'envRun', 'onEnvOutput',
  'pluginsUserInstalled', 'pluginsUninstall',
] as const
if (!PRODUCT.agentBackend) for (const k of AGENT_KEYS) delete (api as Record<string, unknown>)[k]
if (!PRODUCT.market) for (const k of ['marketList', 'marketDetail', 'marketInstall', 'marketInstalled'] as const) delete (api as Record<string, unknown>)[k]

contextBridge.exposeInMainWorld('tangu', api)
