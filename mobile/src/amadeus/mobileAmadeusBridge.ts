/**
 * 移动端 window.amadeus 桥:实现 AmadeusApi 全表面,底层 = 移植的 VaultManager/VaultIndex(Capacitor
 * Filesystem,Directory.Data/vault)+ 复用的 @amadeus-shared 编译器/索引依赖。逻辑镜像 desktop 的
 * electron/amadeus/ipc.ts handler 体。桌面渲染层经 amadeus/api.ts 的 `window.amadeus` 门面零改接管。
 *
 * 落地范围:20 纯文件 I/O + 7 派生索引全实现;9 个 OS/事件方法 no-op(渲染层已 `?.` 兜底)。
 * 图片(amadeus-asset://)由原生 Android 拦截读同一 vault(见 android WebViewClient),此处不涉及。
 */
import path from 'path-browserify'
import { loadPage, newPage, pageFileName, savePage } from '@amadeus-shared/compiler'
import type { PageManifest } from '@amadeus-shared/compiler'
import { dbFileSchema, parseDb, serializeDb } from '@amadeus-shared/db/schema'
import type { DbFile } from '@amadeus-shared/db/schema'
import type { AmadeusApi, DbReadResult, VaultInfo } from '@amadeus-shared/ipc'
import { VaultManager } from './vaultManager'
import { VaultIndex } from './vaultIndex'

const ROOT = '/vault' // 虚拟绝对根;实际落 Capacitor Data/vault/
const LAST_PAGE_KEY = 'amadeus_last_page'
const nowIso = (): string => new Date().toISOString()
const rememberPage = (p: string): void => { try { localStorage.setItem(LAST_PAGE_KEY, p) } catch { /* ignore */ } }
const lastPage = (): string | undefined => { try { return localStorage.getItem(LAST_PAGE_KEY) || undefined } catch { return undefined } }

export function createMobileAmadeusBridge(): AmadeusApi {
  const vault = new VaultManager()
  const index = new VaultIndex(vault)
  let built = false

  async function ensureVault(): Promise<void> {
    if (vault.getRoot()) { if (!built) { await index.build(); built = true } return }
    vault.setRoot(ROOT)
    await vault.makeDir('') // 确保 Data/vault 存在
    await index.build()
    built = true
  }
  async function vaultInfo(): Promise<VaultInfo> {
    const pages = await vault.listPages()
    const lp = lastPage()
    return { root: ROOT, pages, folders: await vault.listFolders(), lastPage: lp && pages.includes(lp) ? lp : undefined }
  }

  return {
    openVault: async () => { await ensureVault(); return vaultInfo() },
    restoreVault: async () => { await ensureVault(); return vaultInfo() },

    listPages: async () => { await ensureVault(); return vault.listPages() },
    listFiles: async () => { await ensureVault(); return vault.listFiles() },
    listFolders: async () => { await ensureVault(); return vault.listFolders() },

    loadPage: async (pagePath) => {
      await ensureVault()
      const page = await loadPage(vault.pageIO(pagePath), pagePath, nowIso())
      rememberPage(pagePath)
      return page
    },
    readPage: async (pagePath) => {
      await ensureVault()
      const io = vault.pageIO(pagePath)
      if (!(await io.exists(pageFileName(pagePath)))) throw new Error(`note not found: ${pagePath}`)
      return loadPage(io, pagePath, nowIso())
    },
    newPage: async (pagePath) => {
      await ensureVault()
      const page = await newPage(vault.pageIO(pagePath), pagePath, nowIso())
      rememberPage(pagePath)
      await index.update(pagePath)
      return page
    },
    savePage: async (pagePath, manifest: PageManifest, contents: Record<string, string>) => {
      await ensureVault()
      await savePage(vault.pageIO(pagePath), pagePath, manifest, { contents })
      await index.update(pagePath)
    },
    renamePage: async (oldPath, newName, manifest: PageManifest, contents: Record<string, string>) => {
      await ensureVault()
      const dir = path.dirname(oldPath)
      let base = newName.trim().replace(/[\\/]/g, '')
      if (!base) throw new Error('页面名不能为空')
      if (base.toLowerCase().endsWith('.md')) base = base.slice(0, -3)
      const newPath = dir === '.' ? `${base}.md` : `${dir}/${base}.md`
      if (newPath === oldPath) {
        return { newPath: oldPath, page: await loadPage(vault.pageIO(oldPath), oldPath, nowIso()) }
      }
      if (await vault.pathExists(newPath)) throw new Error('目标页面已存在')
      await savePage(vault.pageIO(oldPath), oldPath, manifest, { contents })
      await vault.moveEntry(oldPath, newPath)
      await index.rename(oldPath, newPath)
      rememberPage(newPath)
      const page = await loadPage(vault.pageIO(newPath), newPath, nowIso())
      return { newPath, page }
    },
    reconcilePage: async (pagePath) => {
      await ensureVault()
      const page = await loadPage(vault.pageIO(pagePath), pagePath, nowIso())
      await index.update(pagePath)
      return page
    },

    saveAsset: async (pagePath, fileName, bytes) => { await ensureVault(); return vault.writeAsset(pagePath, fileName, bytes) },
    saveAttachment: async (pagePath, fileName, bytes, opts) => { await ensureVault(); return vault.writeAttachment(pagePath, fileName, bytes, opts) },

    deletePage: async (pagePath) => { await ensureVault(); await vault.removeEntry(pagePath); index.remove(pagePath) },
    movePage: async (pagePath, destFolder) => {
      await ensureVault()
      const fileName = pageFileName(pagePath)
      const dstRel = destFolder.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '')
      const newPath = dstRel ? `${dstRel}/${fileName}` : fileName
      if (newPath === pagePath) return pagePath
      if (await vault.pathExists(newPath)) throw new Error('目标位置已存在同名文件')
      await vault.moveEntry(pagePath, newPath)
      if (newPath.endsWith('.md')) { index.remove(pagePath); await index.update(newPath); rememberPage(newPath) }
      return newPath
    },
    createFolder: async (parentFolder, name) => {
      await ensureVault()
      const clean = name.trim().replace(/[\\/]/g, '')
      if (!clean) throw new Error('文件夹名不能为空')
      const parent = parentFolder.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '')
      const rel = parent ? `${parent}/${clean}` : clean
      if (await vault.pathExists(rel)) throw new Error('同名文件夹已存在')
      await vault.makeDir(rel)
      return rel
    },
    renameFolder: async (folderPath, newName) => {
      await ensureVault()
      const clean = newName.trim().replace(/[\\/]/g, '')
      if (!clean) throw new Error('文件夹名不能为空')
      const parentDir = path.dirname(folderPath)
      const parentRel = parentDir === '.' ? '' : parentDir
      const newPath = parentRel ? `${parentRel}/${clean}` : clean
      if (newPath === folderPath) return folderPath
      if (await vault.pathExists(newPath)) throw new Error('同名文件夹已存在')
      await vault.moveEntry(folderPath, newPath)
      await index.build()
      return newPath
    },
    deleteFolder: async (folderPath) => { await ensureVault(); await vault.removeEntry(folderPath); await index.build() },

    // 派生索引
    search: async (query) => { await ensureVault(); return index.search(query) },
    backlinks: async (pagePath) => { await ensureVault(); return index.backlinks(pagePath) },
    reindex: async () => { await ensureVault(); await index.build() },
    listTags: async () => { await ensureVault(); return index.listTags() },
    pagesByTag: async (tag) => { await ensureVault(); return index.pagesByTag(tag) },
    resolveEmbed: async (target) => {
      await ensureVault()
      const hit = index.resolveBlock(target)
      return hit ? { owner: hit.path, content: hit.content, type: hit.type } : null
    },
    blockBacklinks: async (target) => { await ensureVault(); return index.blockBacklinks(target) },

    // .db 数据库块
    readDatabase: async (pagePath, ref): Promise<DbReadResult> => {
      await ensureVault()
      const abs = await vault.resolveAttachment(pagePath, ref)
      const root = vault.getRoot()
      if (!abs || !root) return { status: 'missing' }
      const rel = path.relative(root, abs)
      let text: string
      try { text = await vault.readTextAbs(abs) } catch { return { status: 'missing' } }
      const r = parseDb(text)
      return r.ok ? { status: 'ok', path: rel, data: r.data } : { status: 'corrupt', path: rel, message: r.error }
    },
    writeDatabase: async (dbPath, data: DbFile) => {
      await ensureVault()
      const parsed = dbFileSchema.parse(data)
      await vault.writeTextFile(dbPath, serializeDb(parsed))
    },

    // OS 集成 / 事件 —— 移动端 no-op(渲染层已 `?.` 兜底)。图片经原生 amadeus-asset 拦截,不走这里。
    openAttachment: async () => { /* no-op(可后续接系统分享) */ },
    openVaultFile: async () => { /* no-op */ },
    exportPdf: async () => null,
    revealInFileManager: async () => { /* no-op */ },
    listPlugins: async () => [],
    openPluginsFolder: async () => { /* no-op */ },
    scaffoldSamplePlugin: async () => { /* no-op */ },
    onExternalChange: () => () => { /* 无 watcher */ },
    onStructureChange: () => () => { /* 无 watcher */ },
  }
}
