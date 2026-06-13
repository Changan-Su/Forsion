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
  onAuthDevice: (cb: (info: { url: string; userCode: string }) => void): (() => void) => {
    const listener = (_e: unknown, info: { url: string; userCode: string }): void => cb(info)
    ipcRenderer.on('auth:device', listener)
    return () => ipcRenderer.removeListener('auth:device', listener)
  },
  /** 本机模式工作目录选择;取消返回 null。 */
  pickDirectory: (): Promise<string | null> => ipcRenderer.invoke('dialog:pickDirectory'),
  /** 拖入文件 → 绝对路径(Electron≥32 File.path 已移除,必须 webUtils 在渲染层取)。 */
  getPathForFile: (file: File): string => webUtils.getPathForFile(file),
  /** 本机工作区文件浏览:列目录 / 读文件(主进程 fs)。 */
  listDir: (dirPath: string): Promise<Array<{ name: string; isDir: boolean; size: number }>> =>
    ipcRenderer.invoke('fs:listDir', dirPath),
  readHostFile: (filePath: string): Promise<{ mimeType: string; content: string; size: number; tooLarge?: boolean }> =>
    ipcRenderer.invoke('fs:readFile', filePath),
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

export type TanguDesktopApi = typeof api
