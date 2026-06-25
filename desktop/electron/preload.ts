/**
 * Preload:contextBridge 暴露最小安全 API(配置读写 + 托管后端状态)。
 * agent 调用 renderer 直连 HTTP,不经主进程。
 */
import { contextBridge, ipcRenderer, webUtils } from 'electron'

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
  // ── Forsion 账号 / provider OAuth 登录(与 `tangu login` 同一份凭证)──
  authStatus: (): Promise<any> => ipcRenderer.invoke('auth:status'),
  forsionLogin: (cloudUrl?: string): Promise<any> => ipcRenderer.invoke('auth:forsionLogin', cloudUrl),
  forsionLogout: (): Promise<any> => ipcRenderer.invoke('auth:logout'),
  authProviders: (): Promise<Array<{ id: string; loggedIn: boolean }>> => ipcRenderer.invoke('auth:providers'),
  providerLogin: (id: string): Promise<any> => ipcRenderer.invoke('auth:providerLogin', id),
  openAccountCenter: (): Promise<{ ok: boolean }> => ipcRenderer.invoke('auth:openAccountCenter'),
  appVersion: (): Promise<string> => ipcRenderer.invoke('app:version'),
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
  readHostFile: (filePath: string): Promise<{ mimeType: string; content: string; size: number; tooLarge?: boolean }> =>
    ipcRenderer.invoke('fs:readFile', filePath),
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
  // ── 环境检测 + 引导安装(首启向导;run 仅认 check 登记的 opaque id)──
  envCheck: (): Promise<any[]> => ipcRenderer.invoke('env:check'),
  envRun: (installId: string): Promise<{ exitCode: number }> => ipcRenderer.invoke('env:run', installId),
  onEnvOutput: (cb: (ev: { installId: string; line: string }) => void): (() => void) => {
    const listener = (_e: unknown, ev: { installId: string; line: string }): void => cb(ev)
    ipcRenderer.on('env:output', listener)
    return () => ipcRenderer.removeListener('env:output', listener)
  },
}

contextBridge.exposeInMainWorld('tangu', api)
