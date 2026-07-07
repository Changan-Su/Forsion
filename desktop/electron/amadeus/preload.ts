// The only bridge between the sandboxed renderer and the main process.
// Exposes a minimal, typed `window.amadeus` surface — no raw ipcRenderer, no Node.

import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'
import { IPC, type AmadeusApi } from '@amadeus-shared/ipc'

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
  revealInFileManager: (targetPath) => ipcRenderer.invoke(IPC.revealInFileManager, targetPath),
  readDatabase: (pagePath, ref) => ipcRenderer.invoke(IPC.dbRead, pagePath, ref),
  writeDatabase: (dbPath, data) => ipcRenderer.invoke(IPC.dbWrite, dbPath, data),
  listPageProps: (folder) => ipcRenderer.invoke(IPC.listPageProps, folder),
  setPageFrontmatter: (pagePath, patch) => ipcRenderer.invoke(IPC.setPageFrontmatter, pagePath, patch),
  renamePageFile: (oldPath, newBaseName) => ipcRenderer.invoke(IPC.renamePageFile, oldPath, newBaseName),
}

contextBridge.exposeInMainWorld('amadeus', api)
