/**
 * Preload:contextBridge 暴露最小安全 API。只做「本地配置读写」;agent 调用 renderer 直连 HTTP。
 */
import { contextBridge, ipcRenderer } from 'electron'

export interface TanguDesktopConfig {
  backendUrl: string
  token: string
  modelId: string
}

const api = {
  getConfig: (): Promise<TanguDesktopConfig> => ipcRenderer.invoke('config:get'),
  setConfig: (patch: Partial<TanguDesktopConfig>): Promise<TanguDesktopConfig> =>
    ipcRenderer.invoke('config:set', patch),
}

contextBridge.exposeInMainWorld('tangu', api)

export type TanguDesktopApi = typeof api
