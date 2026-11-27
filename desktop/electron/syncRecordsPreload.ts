// 同步记录:暴露 window.syncRecords(同步面板的最近几轮、全部记录;存取在主进程 syncRecords.ts)。
import { contextBridge, ipcRenderer } from 'electron'
import { SYNC_RECORDS_IPC } from '../shared/vaultSync'

contextBridge.exposeInMainWorld('syncRecords', {
  list: (opts?: { since?: number; limit?: number }): Promise<unknown> => ipcRenderer.invoke(SYNC_RECORDS_IPC.list, opts ?? {}),
  onChanged: (cb: () => void): (() => void) => {
    const listener = (): void => cb()
    ipcRenderer.on(SYNC_RECORDS_IPC.changed, listener)
    return () => ipcRenderer.removeListener(SYNC_RECORDS_IPC.changed, listener)
  },
})
