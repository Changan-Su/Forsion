// remotesync:暴露 window.remoteSync(本地库远程同步设置/触发/状态订阅)。
import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'

contextBridge.exposeInMainWorld('remoteSync', {
  get: (): Promise<unknown> => ipcRenderer.invoke('remotesync:get'),
  set: (patch: Record<string, unknown>): Promise<unknown> => ipcRenderer.invoke('remotesync:set', patch),
  run: (opts?: { dryRun?: boolean; allowMassDelete?: boolean }): Promise<unknown> => ipcRenderer.invoke('remotesync:run', opts),
  check: (): Promise<{ ok: boolean; error?: string }> => ipcRenderer.invoke('remotesync:check'),
  dropboxAuthStart: (appKey: string): Promise<{ ok: boolean; error?: string; mode?: 'auto' | 'manual'; redirectUri?: string }> =>
    ipcRenderer.invoke('remotesync:dropboxAuthStart', appKey),
  dropboxAuthFinish: (appKey: string, code: string): Promise<{ ok: boolean; error?: string; email?: string; config?: unknown }> =>
    ipcRenderer.invoke('remotesync:dropboxAuthFinish', appKey, code),
  // 回环回调流的结果(浏览器授权完成后由主进程推回来)
  onDropboxAuth: (cb: (r: unknown) => void): (() => void) => {
    const listener = (_e: IpcRendererEvent, r: unknown): void => cb(r)
    ipcRenderer.on('remotesync:dropboxAuth', listener)
    return () => ipcRenderer.removeListener('remotesync:dropboxAuth', listener)
  },
  onStatus: (cb: (st: unknown) => void): (() => void) => {
    const listener = (_e: IpcRendererEvent, st: unknown): void => cb(st)
    ipcRenderer.on('remotesync:status', listener)
    return () => ipcRenderer.removeListener('remotesync:status', listener)
  },
})
