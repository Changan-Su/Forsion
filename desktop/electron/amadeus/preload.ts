// The only bridge between the sandboxed renderer and the main process.
// Exposes a minimal, typed `window.amadeus` surface — no raw ipcRenderer, no Node.

import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'
import { IPC, type AmadeusApi } from '@amadeus-shared/ipc'
import { SYNC_IPC } from './sync/ipcKeys'

const api: AmadeusApi = {
  openVault: () => ipcRenderer.invoke(IPC.openVault),
  restoreVault: () => ipcRenderer.invoke(IPC.restoreVault),
  listPages: () => ipcRenderer.invoke(IPC.listPages),
  listFiles: () => ipcRenderer.invoke(IPC.listFiles),
  loadPage: (pagePath) => ipcRenderer.invoke(IPC.loadPage, pagePath),
  readPage: (pagePath) => ipcRenderer.invoke(IPC.readPage, pagePath),
  newPage: (pagePath) => ipcRenderer.invoke(IPC.newPage, pagePath),
  savePage: (pagePath, manifest, contents) =>
    ipcRenderer.invoke(IPC.savePage, pagePath, manifest, contents),
  renamePage: (oldPath, newName, manifest, contents) =>
    ipcRenderer.invoke(IPC.renamePage, oldPath, newName, manifest, contents),
  reconcilePage: (pagePath, prevManifest, prevContents) =>
    ipcRenderer.invoke(IPC.reconcilePage, pagePath, prevManifest, prevContents),
  saveAsset: (pagePath, fileName, bytes) =>
    ipcRenderer.invoke(IPC.saveAsset, pagePath, fileName, bytes),
  saveVaultBytes: (filePath, bytes) => ipcRenderer.invoke(IPC.saveVaultBytes, filePath, bytes),
  readVaultBytes: (filePath) => ipcRenderer.invoke(IPC.readVaultBytes, filePath),
  saveAttachment: (pagePath, fileName, bytes, opts) =>
    ipcRenderer.invoke(IPC.saveAttachment, pagePath, fileName, bytes, opts),
  openAttachment: (pagePath, ref) => ipcRenderer.invoke(IPC.openAttachment, pagePath, ref),
  openVaultFile: (vaultRel) => ipcRenderer.invoke(IPC.openVaultFile, vaultRel),
  exportPdf: (defaultName) => ipcRenderer.invoke(IPC.exportPdf, defaultName),
  onExternalChange: (cb) => {
    const listener = (_event: IpcRendererEvent, pagePath: string): void => cb(pagePath)
    ipcRenderer.on(IPC.externalChange, listener)
    return () => {
      ipcRenderer.removeListener(IPC.externalChange, listener)
    }
  },
  search: (query) => ipcRenderer.invoke(IPC.search, query),
  backlinks: (pagePath) => ipcRenderer.invoke(IPC.backlinks, pagePath),
  reindex: () => ipcRenderer.invoke(IPC.reindex),
  listTags: () => ipcRenderer.invoke(IPC.listTags),
  pagesByTag: (tag) => ipcRenderer.invoke(IPC.pagesByTag, tag),
  deletePage: (pagePath) => ipcRenderer.invoke(IPC.deletePage, pagePath),
  movePage: (pagePath, destFolder) => ipcRenderer.invoke(IPC.movePage, pagePath, destFolder),
  resolveEmbed: (target) => ipcRenderer.invoke(IPC.resolveEmbed, target),
  blockBacklinks: (target) => ipcRenderer.invoke(IPC.blockBacklinks, target),
  listFolders: () => ipcRenderer.invoke(IPC.listFolders),
  createFolder: (parentFolder, name) => ipcRenderer.invoke(IPC.createFolder, parentFolder, name),
  renameFolder: (folderPath, newName) => ipcRenderer.invoke(IPC.renameFolder, folderPath, newName),
  deleteFolder: (folderPath) => ipcRenderer.invoke(IPC.deleteFolder, folderPath),
  moveFolder: (folderPath, destFolder) => ipcRenderer.invoke(IPC.moveFolder, folderPath, destFolder),
  trashEntry: (rel) => ipcRenderer.invoke(IPC.trashEntry, rel),
  listTrash: () => ipcRenderer.invoke(IPC.listTrash),
  restoreTrash: (name) => ipcRenderer.invoke(IPC.restoreTrash, name),
  deleteTrashEntry: (name) => ipcRenderer.invoke(IPC.deleteTrashEntry, name),
  emptyTrash: () => ipcRenderer.invoke(IPC.emptyTrash),
  pageIcons: () => ipcRenderer.invoke(IPC.pageIcons),
  fetchLinkMeta: (url) => ipcRenderer.invoke(IPC.fetchLinkMeta, url),
  searchImages: (q) => ipcRenderer.invoke(IPC.searchImages, q),
  onStructureChange: (cb) => {
    const listener = (): void => cb()
    ipcRenderer.on(IPC.structureChange, listener)
    return () => {
      ipcRenderer.removeListener(IPC.structureChange, listener)
    }
  },
  onDbExternalChange: (cb) => {
    const listener = (_event: IpcRendererEvent, dbPath: string): void => cb(dbPath)
    ipcRenderer.on(IPC.dbChange, listener)
    return () => {
      ipcRenderer.removeListener(IPC.dbChange, listener)
    }
  },
  listPlugins: () => ipcRenderer.invoke(IPC.listPlugins),
  openPluginsFolder: () => ipcRenderer.invoke(IPC.openPluginsFolder),
  scaffoldSamplePlugin: () => ipcRenderer.invoke(IPC.scaffoldPlugin),
  uninstallPlugin: (id) => ipcRenderer.invoke(IPC.uninstallPlugin, id),
  revealInFileManager: (targetPath) => ipcRenderer.invoke(IPC.revealInFileManager, targetPath),
  readDatabase: (pagePath, ref) => ipcRenderer.invoke(IPC.dbRead, pagePath, ref),
  writeDatabase: (dbPath, data) => ipcRenderer.invoke(IPC.dbWrite, dbPath, data),
  readDrawing: (pagePath, ref) => ipcRenderer.invoke(IPC.drawingRead, pagePath, ref),
  writeDrawing: (drawingPath, source) => ipcRenderer.invoke(IPC.drawingWrite, drawingPath, source),
  readTextFile: (filePath) => ipcRenderer.invoke(IPC.readTextFile, filePath),
  writeTextFile: (filePath, text) => ipcRenderer.invoke(IPC.writeTextFile, filePath, text),
  listPageProps: (folder) => ipcRenderer.invoke(IPC.listPageProps, folder),
  setPageFrontmatter: (pagePath, patch) => ipcRenderer.invoke(IPC.setPageFrontmatter, pagePath, patch),
  renamePageFile: (oldPath, newBaseName) => ipcRenderer.invoke(IPC.renamePageFile, oldPath, newBaseName),
  renameDbFile: (oldPath, newBaseName) => ipcRenderer.invoke(IPC.renameDbFile, oldPath, newBaseName),
}

contextBridge.exposeInMainWorld('amadeus', api)

// 云同步(桌面专属,不进三端共享的 AmadeusApi 契约;web/mobile 下为 undefined)。
contextBridge.exposeInMainWorld('amadeusSync', {
  get: () => ipcRenderer.invoke(SYNC_IPC.get),
  setEnabled: (on: boolean) => ipcRenderer.invoke(SYNC_IPC.setEnabled, on),
  syncNow: () => ipcRenderer.invoke(SYNC_IPC.syncNow),
  confirmDeletions: () => ipcRenderer.invoke(SYNC_IPC.confirmDeletions),
  switchSide: (side: 'local' | 'cloud') => ipcRenderer.invoke(SYNC_IPC.switchSide, side),
  onStatus: (cb: (s: unknown) => void) => {
    const listener = (_e: IpcRendererEvent, s: unknown): void => cb(s)
    ipcRenderer.on(SYNC_IPC.status, listener)
    return () => {
      ipcRenderer.removeListener(SYNC_IPC.status, listener)
    }
  },
  // 按条目云同步(本地 vault 子集 ↔ 云端 <Vault名>/)
  entrySyncGet: () => ipcRenderer.invoke(SYNC_IPC.entryGet),
  otherSideCalDbs: () => ipcRenderer.invoke(SYNC_IPC.otherSideDbs),
  entrySyncEnable: (payload: unknown) => ipcRenderer.invoke(SYNC_IPC.entryEnable, payload),
  entrySyncDisable: (p: string) => ipcRenderer.invoke(SYNC_IPC.entryDisable, p),
  entrySyncClosure: (rootRel: string, kind: 'page' | 'folder') => ipcRenderer.invoke(SYNC_IPC.entryClosure, rootRel, kind),
  onEntrySyncChange: (cb: () => void) => {
    const listener = (): void => cb()
    ipcRenderer.on(SYNC_IPC.entryChange, listener)
    return () => {
      ipcRenderer.removeListener(SYNC_IPC.entryChange, listener)
    }
  },
})

// 页面级共享/发布/presence(与 web 的 cloudCollab 同构;HTTP 在主进程,token 不下发)。
const collabCall = (fn: string, ...args: unknown[]): Promise<any> => ipcRenderer.invoke(SYNC_IPC.collabCall, fn, args)
contextBridge.exposeInMainWorld('amadeusCollab', {
  listVaults: () => collabCall('listVaults'),
  activeVaultId: () => collabCall('activeVaultId'),
  // 桌面无「切库」:共享内容在镜像的 与我共享/ 里,SharedWithMeSection 用 localPath 直开。
  switchVault: () => {},
  pageShare: (path: string) => collabCall('pageShare', path),
  createPageShare: (path: string, opts: unknown) => collabCall('createPageShare', path, opts),
  updatePageShare: (id: string, patch: unknown) => collabCall('updatePageShare', id, patch),
  revokePageShare: (id: string) => collabCall('revokePageShare', id),
  setParticipantRole: (id: string, userId: string, role: string) => collabCall('setParticipantRole', id, userId, role),
  removeParticipant: (id: string, userId: string) => collabCall('removeParticipant', id, userId),
  sharedWithMe: () => collabCall('sharedWithMe'),
  leaveShare: (id: string) => collabCall('leaveShare', id),
  inviteUrl: (token: string) => `${linkBase}/invite/${token}`,
  publishes: () => collabCall('publishes'),
  listAllShares: () => collabCall('listAllShares'),
  createPublish: (mode: string, path: string) => collabCall('createPublish', mode, path),
  revokePublish: (token: string) => collabCall('revokePublish', token),
  revokePublishIn: (vaultId: string, token: string) => collabCall('revokePublishIn', vaultId, token),
  revokePageShareIn: (vaultId: string, id: string) => collabCall('revokePageShareIn', vaultId, id),
  publishUrl: (token: string) => `${linkBase}/share/${token}`,
  heartbeat: (page: string | null) => {
    void collabCall('heartbeat', page)
    if (!hbTimer) hbTimer = setInterval(() => void collabCall('heartbeat', page), 30_000)
    hbPage = page
  },
  stopHeartbeat: () => {
    if (hbTimer) { clearInterval(hbTimer); hbTimer = null }
  },
  onPresence: (cb: (list: unknown) => void) => {
    const listener = (_e: IpcRendererEvent, list: unknown): void => cb(list)
    ipcRenderer.on(SYNC_IPC.presence, listener)
    return () => {
      ipcRenderer.removeListener(SYNC_IPC.presence, listener)
    }
  },
  myUserId: () => cachedUserId,
})

// linkBase / userId:preload 加载时一次性取(登录态变化重启 app 生效;sync 面同款语义)。
let linkBase = ''
let cachedUserId: string | null = null
let hbTimer: ReturnType<typeof setInterval> | null = null
let hbPage: string | null = null
void hbPage
void collabCall('linkBase').then((b) => { linkBase = String(b ?? '') }).catch(() => {})
void collabCall('myUserId').then((u) => { cachedUserId = (u as string | null) ?? null }).catch(() => {})
