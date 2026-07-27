// remotesync:暴露 window.remoteSync(本地库远程同步设置/触发/状态订阅)。
import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'

contextBridge.exposeInMainWorld('remoteSync', {
  get: (): Promise<unknown> => ipcRenderer.invoke('remotesync:get'),
  set: (patch: Record<string, unknown>): Promise<unknown> => ipcRenderer.invoke('remotesync:set', patch),
  run: (opts?: { dryRun?: boolean; allowMassDelete?: boolean }): Promise<unknown> => ipcRenderer.invoke('remotesync:run', opts),
  check: (): Promise<{ ok: boolean; error?: string }> => ipcRenderer.invoke('remotesync:check'),
  dropboxAuthStart: (appKey: string): Promise<{ ok: boolean; error?: string }> =>
    ipcRenderer.invoke('remotesync:dropboxAuthStart', appKey),
  dropboxAuthFinish: (appKey: string, code: string): Promise<{ ok: boolean; error?: string; email?: string; config?: unknown }> =>
    ipcRenderer.invoke('remotesync:dropboxAuthFinish', appKey, code),
  onStatus: (cb: (st: unknown) => void): (() => void) => {
    const listener = (_e: IpcRendererEvent, st: unknown): void => cb(st)
    ipcRenderer.on('remotesync:status', listener)
    return () => ipcRenderer.removeListener('remotesync:status', listener)
  },
})
