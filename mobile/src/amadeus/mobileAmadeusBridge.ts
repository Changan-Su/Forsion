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
import { parseFmObject, setFmExtraOnSource } from '@amadeus-shared/db/pageFrontmatter'
import { extractFrontmatterExtra } from '@amadeus-shared/compiler/split'
import { dbFileSchema, parseDb, serializeDb } from '@amadeus-shared/db/schema'
import { rewriteDbRefs } from '@amadeus-shared/db/rewriteDbRefs'
import type { DbFile } from '@amadeus-shared/db/schema'
import type { AmadeusApi, DbReadResult, LinkMeta, PageProps, VaultInfo } from '@amadeus-shared/ipc'
import { VaultManager } from './vaultManager'
import { VaultIndex } from './vaultIndex'

const ROOT = '/vault' // 虚拟绝对根;实际落 Capacitor Data/vault/
const LAST_PAGE_KEY = 'amadeus_last_page'
const nowIso = (): string => new Date().toISOString()
const rememberPage = (p: string): void => { try { localStorage.setItem(LAST_PAGE_KEY, p) } catch { /* ignore */ } }
const lastPage = (): string | undefined => { try { return localStorage.getItem(LAST_PAGE_KEY) || undefined } catch { return undefined } }

/** cfg 可选:提供后端基址与 token 时,fetchLinkMeta 走 server 代理(书签卡);缺省优雅降级 null。 */
export function createMobileAmadeusBridge(cfg?: { apiBase?: () => string; getToken?: () => string }): AmadeusApi {
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
    moveFolder: async (folderPath, destFolder) => {
      await ensureVault()
      const src = folderPath.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '')
      const name = src.split('/').pop()
      if (!name) throw new Error('文件夹路径不能为空')
      const dst = destFolder.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '')
      const newPath = dst ? `${dst}/${name}` : name
      if (newPath === src) return src
      if (dst === src || dst.startsWith(`${src}/`)) throw new Error('不能移动到自身内部')
      if (await vault.pathExists(newPath)) throw new Error('目标位置已存在同名文件夹')
      await vault.moveEntry(src, newPath)
      await index.build()
      return newPath
    },

    // 外科式 frontmatter 写(镜像 electron ipc.ts 的 setPageFrontmatter;.fd children 同步依赖)。
    setPageFrontmatter: async (pagePath, patch) => {
      await ensureVault()
      const io = vault.pageIO(pagePath)
      const name = pageFileName(pagePath)
      if (!(await io.exists(name))) return // 笔记不在(已被删)→ 静默跳过
      const raw = await io.readFile(name)
      await vault.writeTextFile(pagePath, setFmExtraOnSource(raw, patch))
      await index.update(pagePath)
    },

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

    // ---- 字节读写(PDF 阅读器 getDocument({data}) 等) ----
    saveVaultBytes: async (p, bytes) => { await ensureVault(); await vault.writeVaultBytes(p, bytes) },
    readVaultBytes: async (p) => { await ensureVault(); return vault.readVaultBytes(p) },

    // ---- Excalidraw 画板(desktop ipc.ts drawingRead/drawingWrite 同款) ----
    readDrawing: async (pagePath, ref) => {
      await ensureVault()
      // Obsidian 链接省略 .md:`![[Foo.excalidraw]]` 实指 `Foo.excalidraw.md` → 原样先试,落空再补 .md。
      const abs =
        (await vault.resolveAttachment(pagePath, ref)) ?? (await vault.resolveAttachment(pagePath, `${ref}.md`))
      const root = vault.getRoot()
      if (!abs || !root) return { status: 'missing' }
      try {
        return { status: 'ok', path: path.relative(root, abs), source: await vault.readTextAbs(abs) }
      } catch {
        return { status: 'missing' }
      }
    },
    writeDrawing: async (drawingPath, source) => { await ensureVault(); await vault.writeTextFile(drawingPath, source) },

    // ---- 插件自定义文件类型的纯文本读写(desktop ipc.ts readTextFile/writeTextFile 同款) ----
    // 越界/不存在一律返回 null:absPath 走 resolveInVault(越界即抛),读不到也抛,catch 兜成 null。
    readTextFile: async (p) => {
      await ensureVault()
      try { return await vault.readTextAbs(vault.absPath(p)) } catch { return null }
    },
    writeTextFile: async (p, text) => { await ensureVault(); await vault.writeTextFile(p, text) },

    // ---- 回收站(.trash 语义在 vaultManager;desktop 同款 trash 后全量重建索引) ----
    trashEntry: async (rel) => { await ensureVault(); await vault.trashEntry(rel); await index.build() },
    listTrash: async () => { await ensureVault(); return vault.listTrash() },
    restoreTrash: async (name) => {
      await ensureVault()
      const restored = await vault.restoreTrash(name)
      await index.build()
      return restored
    },
    deleteTrashEntry: async (name) => { await ensureVault(); await vault.deleteTrashEntry(name) },
    emptyTrash: async () => { await ensureVault(); await vault.emptyTrash() },

    // ---- 笔记视图(Bases)/页面图标(desktop ipc.ts listPageProps/pageIcons 同款) ----
    listPageProps: async (folder) => {
      await ensureVault()
      const prefix = folder.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '')
      const inFolder = (await vault.listPages()).filter((p) => {
        if (prefix === '') return !p.includes('/') // 整库:仅顶层笔记
        if (!p.startsWith(`${prefix}/`)) return false
        return !p.slice(prefix.length + 1).includes('/') // 仅直属子级,不递归子文件夹
      })
      const out: PageProps[] = []
      for (const p of inFolder) {
        let raw: string
        try { raw = await vault.readTextAbs(vault.absPath(p)) } catch { continue }
        out.push({ path: p, title: path.basename(p).replace(/\.md$/i, ''), fm: parseFmObject(extractFrontmatterExtra(raw)) })
      }
      return out
    },
    pageIcons: async () => { await ensureVault(); return index.pageIcons() },

    // ---- 文件级改名(desktop ipc.ts renamePageFile/renameDbFile 同款) ----
    renamePageFile: async (oldPath, newBaseName) => {
      await ensureVault()
      const dir = path.dirname(oldPath)
      let base = newBaseName.trim().replace(/[\\/]/g, '')
      if (!base) throw new Error('笔记名不能为空')
      if (base.toLowerCase().endsWith('.md')) base = base.slice(0, -3)
      const newPath = dir === '.' ? `${base}.md` : `${dir}/${base}.md`
      if (newPath === oldPath) return oldPath
      if (await vault.pathExists(newPath)) throw new Error('目标笔记已存在')
      await vault.moveEntry(oldPath, newPath) // 纯移动:不落 v3,外来 .md 不被收编
      index.remove(oldPath)
      await index.update(newPath)
      return newPath
    },
    renameDbFile: async (oldPath, newBaseName) => {
      await ensureVault()
      const norm = (s: string): string => s.replace(/\\/g, '/')
      const oldRel = norm(oldPath)
      let base = newBaseName.trim().replace(/[\\/]/g, '')
      if (base.toLowerCase().endsWith('.db')) base = base.slice(0, -3)
      if (!base) throw new Error('名称不能为空')
      const dir = path.dirname(oldRel)
      const newPath = dir === '.' ? `${base}.db` : `${dir}/${base}.db`
      if (newPath === oldRel) return { newPath, rewrittenPages: [] }
      if (await vault.pathExists(newPath)) throw new Error('目标文件已存在')
      await vault.moveEntry(oldRel, newPath)
      // title 同步:name = 新 basename。parseDb 失败(损坏文件)只移动不动内容。
      try {
        const parsed = parseDb(await vault.readTextAbs(vault.absPath(newPath)))
        if (parsed.ok && parsed.data.name !== base) {
          await vault.writeTextFile(newPath, serializeDb({ ...parsed.data, name: base }))
        }
      } catch { /* corrupt: 跳过 name 同步 */ }
      // 引用重写(纯函数 rewriteDbRefs;desktop 同款朴素全库扫描,个人 vault 规模足够)
      const rewrittenPages: string[] = []
      for (const p of await vault.listPages()) {
        const pRel = norm(p)
        let raw: string
        try { raw = await vault.readTextAbs(vault.absPath(p)) } catch { continue }
        const next = rewriteDbRefs(raw, { oldRel, newBase: `${base}.db`, pageDir: path.dirname(pRel) })
        if (next !== raw) {
          await vault.writeTextFile(p, next)
          await index.update(p)
          rewrittenPages.push(p)
        }
      }
      return { newPath, rewrittenPages }
    },

    // ---- 书签卡/封面搜索(server 代理 + Openverse 直连;web cloudBridge 同款) ----
    fetchLinkMeta: async (url) => {
      const base = cfg?.apiBase?.()
      const token = cfg?.getToken?.()
      if (!base || !token) return null
      try {
        const r = await fetch(`${base}/amadeus/link-meta?url=${encodeURIComponent(url)}`, {
          headers: { Authorization: `Bearer ${token}` },
        })
        if (!r.ok) return null
        return (await r.json()) as LinkMeta | null
      } catch {
        return null
      }
    },
    searchImages: async (query) => {
      const q = query.trim()
      if (!q) return []
      const res = await fetch(`https://api.openverse.org/v1/images/?q=${encodeURIComponent(q)}&page_size=20`, {
        headers: { accept: 'application/json' },
      })
      if (!res.ok) throw new Error(`openverse HTTP ${res.status}`)
      const j = (await res.json()) as { results?: Array<{ thumbnail?: string; url?: string; creator?: string }> }
      return (j.results ?? [])
        .map((r) => ({ thumb: r.thumbnail ?? '', full: r.url ?? '', author: r.creator }))
        .filter((x) => x.thumb && x.full)
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
    onDbExternalChange: () => () => { /* 无 watcher */ },
    onStructureChange: () => () => { /* 无 watcher */ },
  }
}
