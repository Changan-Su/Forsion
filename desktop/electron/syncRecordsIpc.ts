/**
 * 同步记录的主进程接线(存取在 syncRecords.ts):给 Extend 的口子(cloudHost.syncRecords)、远程服务的记录、渲染层的 sync-records:list。
 * 记录按账号分开;没传账号的(远程服务、老调用)记在当前账号名下。
 */
import path from 'node:path'
import { BrowserWindow, app, ipcMain } from 'electron'
import { SYNC_RECORDS_IPC, type SyncRecordSink } from '../shared/vaultSync'
import { currentCloudAccountId } from './amadeus/settings'
import { createSyncRecordStore, type SyncRecordStore } from './syncRecords'

let store: SyncRecordStore | null = null

function recordStore(): SyncRecordStore {
  if (!store) {
    store = createSyncRecordStore(path.join(app.getPath('userData'), 'sync-records'), {
      onChanged: () => {
        for (const w of BrowserWindow.getAllWindows()) if (!w.isDestroyed()) w.webContents.send(SYNC_RECORDS_IPC.changed)
      },
    })
  }
  return store
}

/** 记一条(account 不给 = 当前账号)。只观测:抛错吞掉。 */
export function appendSyncRecord(record: unknown, account?: string | null): void {
  try { recordStore().append(record, account === undefined ? currentCloudAccountId() : account) } catch { /* 记录绝不影响同步 */ }
}

/** 给 Forsion Extend 的口子(CloudHost.syncRecords)。 */
export const syncRecordSink: SyncRecordSink = { append: (record, account) => appendSyncRecord(record, account) }

export function registerSyncRecordsIpc(): void {
  ipcMain.handle(SYNC_RECORDS_IPC.list, (_e, raw: unknown) => {
    const o = (raw && typeof raw === 'object' ? raw : {}) as { since?: unknown; limit?: unknown; feeds?: unknown; vault?: unknown }
    const feeds = Array.isArray(o.feeds) ? o.feeds.filter((f): f is string => typeof f === 'string' && f.length <= 4096).slice(0, 50) : undefined
    return recordStore().list(currentCloudAccountId(), {
      ...(typeof o.since === 'number' && Number.isFinite(o.since) ? { since: o.since } : {}),
      ...(feeds ? { feeds } : {}),
      ...(typeof o.vault === 'string' && o.vault.length <= 4096 ? { vault: o.vault } : {}),
      ...(typeof o.limit === 'number' && o.limit > 0 ? { limit: Math.min(5000, Math.floor(o.limit)) } : {}),
    })
  })
}

export function flushSyncRecords(): Promise<void> {
  return store?.flush() ?? Promise.resolve()
}
