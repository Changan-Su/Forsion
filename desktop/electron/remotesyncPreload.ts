// remotesync:暴露 window.remoteSync(本地库远程同步设置/触发/状态订阅)。
import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'

contextBridge.exposeInMainWorld('remoteSync', {
  get: (): Promise<unknown> => ipcRenderer.invoke('remotesync:get'),
  set: (patch: Record<string, unknown>): Promise<unknown> => ipcRenderer.invoke('remotesync:set', patch),
  run: (opts?: { dryRun?: boolean; allowMassDelete?: boolean }): Promise<unknown> => ipcRenderer.invoke('remotesync:run', opts),
  check: (): Promise<{ ok: boolean; error?: string }> => ipcRenderer.invoke('remotesync:check'),
  rootStats: (): Promise<unknown> => ipcRenderer.invoke('remotesync:rootStats'),
  adoptRemote: (label: string): Promise<unknown> => ipcRenderer.invoke('remotesync:adoptRemote', label),
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
  // 智库同步第 2 步:「同步到哪」的网盘(syncTargets.ts)。list 永不回凭据;save 的凭据只进主进程、落 sync-targets 文件
  targets: {
    list: (): Promise<unknown> => ipcRenderer.invoke('remotesync:targets:list'),
    save: (input: { id?: string; kind: string; label?: string; section: Record<string, unknown> }): Promise<unknown> => ipcRenderer.invoke('remotesync:targets:save', input),
    remove: (id: string): Promise<unknown> => ipcRenderer.invoke('remotesync:targets:remove', id),
    check: (id: string): Promise<{ ok: boolean; error?: string }> => ipcRenderer.invoke('remotesync:targets:check', id),
    // 新建 / 重新授权 Dropbox 去处(契约 H-9):凭据不进渲染层,结果事件里只有去处摘要和账号显示名
    authStart: (kind: 'dropbox', opts?: { id?: string; label?: string; baseDir?: string; appKey?: string }): Promise<unknown> =>
      ipcRenderer.invoke('remotesync:targets:authStart', kind, opts ?? {}),
    authFinish: (attempt: string, code: string): Promise<{ ok: boolean; error?: string }> => ipcRenderer.invoke('remotesync:targets:authFinish', attempt, code),
    authCancel: (attempt: string): Promise<unknown> => ipcRenderer.invoke('remotesync:targets:authCancel', attempt),
    onAuth: (cb: (ev: unknown) => void): (() => void) => {
      const listener = (_e: IpcRendererEvent, ev: unknown): void => cb(ev)
      ipcRenderer.on('remotesync:targets:auth', listener)
      return () => { ipcRenderer.removeListener('remotesync:targets:auth', listener) }
    },
  },
  // 智库同步第 2 步:退出门禁卡(syncQuitGate.ts)。订阅了才会在有没同步完的时候被问;回 'quit' = 直接退出,'cancel' = 取消退出
  quitGate: {
    subscribe: (cb: (s: { open: boolean; result?: unknown }) => void): (() => void) => {
      const listener = (_e: IpcRendererEvent, st: { open: boolean; result?: unknown }): void => cb(st)
      ipcRenderer.on('remotesync:quitGate', listener)
      void ipcRenderer.invoke('remotesync:quitGate:subscribe', true)
      return () => {
        ipcRenderer.removeListener('remotesync:quitGate', listener)
        void ipcRenderer.invoke('remotesync:quitGate:subscribe', false)
      }
    },
    answer: (a: 'quit' | 'cancel'): Promise<unknown> => ipcRenderer.invoke('remotesync:quitGate:answer', a),
  },
  onStatus: (cb: (st: unknown) => void): (() => void) => {
    const listener = (_e: IpcRendererEvent, st: unknown): void => cb(st)
    ipcRenderer.on('remotesync:status', listener)
    return () => ipcRenderer.removeListener('remotesync:status', listener)
  },
})
