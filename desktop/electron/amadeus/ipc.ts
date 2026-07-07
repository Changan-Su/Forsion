import { promises as fs } from 'node:fs'
import path from 'node:path'
import { app, dialog, ipcMain, shell, type BrowserWindow } from 'electron'
import { IPC, gatePluginManifest, type DbReadResult, type ExternalPluginSource, type PageProps } from '@amadeus-shared/ipc'
import { dbFileSchema, parseDb, serializeDb, seedCalendarDb } from '@amadeus-shared/db/schema'
import { parseFmObject, setFmExtraOnSource } from '@amadeus-shared/db/pageFrontmatter'
import { extractFrontmatterExtra } from '@amadeus-shared/compiler/split'
import { loadPage, newPage, pageFileName, savePage } from '@amadeus-shared/compiler'
import type { PageManifest } from '@amadeus-shared/compiler'
import { VaultManager } from './fs/vaultManager'
import { VaultWatcher } from './fs/watcher'
import { VaultIndex } from './fs/vaultIndex'
import { readConfig, writeConfig } from './settings'
import { defaultWorkspaceDir, forsionHomeDir } from '../forsionHome'

const nowIso = (): string => new Date().toISOString()

const SAMPLE_MANIFEST = `{
  "id": "hello-amadeus",
  "name": "Hello Amadeus",
  "version": "1.0.0",
  "apiVersion": 1,
  "description": "示例插件：演示命令、slash 项与主题三种贡献点。",
  "main": "main.js"
}
`

// The plugin body runs with \`ctx\` in scope and may return a disposer (see PluginContext).
const SAMPLE_MAIN = `// Hello Amadeus —— 示例插件。文件体即 setup(ctx)，可 return 一个清理函数。
ctx.registerCommand({
  id: 'hello',
  title: 'Hello：打个招呼',
  keywords: 'hello hi 你好 shili',
  run: () => ctx.app.notify('你好，来自示例插件 👋'),
})
ctx.registerSlashItem({
  id: 'signature',
  label: '示例签名',
  icon: '✶',
  group: '示例',
  scaffold: '> —— 由 Amadeus 示例插件插入\\n\\n',
  keywords: 'sign 签名 shili sample',
})
ctx.registerTheme({
  id: 'sky',
  label: '天蓝',
  swatch: '#38bdf8',
  css: "[data-theme='sky'][data-mode='light']{--primary:#0284c7;--primary-2:#0369a1;--on-primary:#ffffff} [data-theme='sky'][data-mode='dark']{--primary:#38bdf8;--primary-2:#7dd3fc;--on-primary:#04283b}",
})
return () => {}
`

export function registerIpc(getWindow: () => BrowserWindow | null): {
  getVaultRoot: () => string | null
} {
  const vault = new VaultManager()
  const index = new VaultIndex(vault)
  let structureTimer: ReturnType<typeof setTimeout> | null = null

  const watcher = new VaultWatcher(
    vault,
    (pagePath) => {
      void index.update(pagePath) // keep search/backlinks/embeds fresh on external edits
      getWindow()?.webContents.send(IPC.externalChange, pagePath)
    },
    () => {
      // External add/remove of pages or folders → debounce a reindex + notify the renderer.
      if (structureTimer) clearTimeout(structureTimer)
      structureTimer = setTimeout(() => {
        structureTimer = null
        void index.build()
        getWindow()?.webContents.send(IPC.structureChange)
      }, 300)
    },
    (dbPath) => {
      // 外部改 .db(如 agent 直连磁盘改日历)→ 通知渲染端热重载对应 dbStore 条目。
      getWindow()?.webContents.send(IPC.dbChange, dbPath)
    },
  )
  const rememberPage = (pagePath: string): Promise<void> => writeConfig({ lastPage: pagePath })

  /** 首启无 lastVault:自带默认工作区 ~/Forsion/Amadeus(dev→~/Forsion-Dev/Amadeus)+ 种子 Calendar.db。
   *  幂等:目录已存在不动,Calendar.db 已存在不覆盖(用户后来选过别的 vault 则走不到这里)。 */
  const ensureDefaultVault = async (): Promise<{ root: string; pages: string[]; folders: string[] }> => {
    const root = path.join(defaultWorkspaceDir(), 'Amadeus')
    await fs.mkdir(root, { recursive: true })
    vault.setRoot(root)
    try {
      await fs.access(path.join(root, 'Calendar.db'))
    } catch {
      await vault.writeTextFile('Calendar.db', serializeDb(seedCalendarDb()))
    }
    watcher.start(root)
    await writeConfig({ lastVault: root, lastPage: undefined })
    await index.build()
    return { root, pages: await vault.listPages(), folders: await vault.listFolders() }
  }

  ipcMain.handle(IPC.openVault, async () => {
    const root = await vault.openDialog()
    if (!root) return null
    watcher.start(root)
    await writeConfig({ lastVault: root, lastPage: undefined })
    await index.build()
    return { root, pages: await vault.listPages(), folders: await vault.listFolders() }
  })

  ipcMain.handle(IPC.restoreVault, async () => {
    const { lastVault, lastPage } = await readConfig()
    if (!lastVault) return ensureDefaultVault() // 首启:自带默认工作区 + 种子多维表(不再落欢迎页)
    try {
      const stat = await fs.stat(lastVault)
      if (!stat.isDirectory()) return null
    } catch {
      return null
    }
    vault.setRoot(lastVault)
    watcher.start(lastVault)
    const pages = await vault.listPages()
    const folders = await vault.listFolders()
    await index.build()
    return {
      root: lastVault,
      pages,
      folders,
      lastPage: lastPage && pages.includes(lastPage) ? lastPage : undefined,
    }
  })

  ipcMain.handle(IPC.listPages, () => vault.listPages())
  ipcMain.handle(IPC.listFiles, () => vault.listFiles())

  ipcMain.handle(IPC.loadPage, async (_e, pagePath: string) => {
    const page = await loadPage(vault.pageIO(pagePath), pagePath, nowIso())
    await rememberPage(pagePath)
    return page
  })

  // 只读加载(模板读取等):不写 lastPage,不当成「打开」;文件不存在直接报错——
  // 编译器 loadPage 缺文件会 newPage 落盘,只读语义下不允许悄悄造文件。
  ipcMain.handle(IPC.readPage, async (_e, pagePath: string) => {
    const io = vault.pageIO(pagePath)
    if (!(await io.exists(pageFileName(pagePath)))) throw new Error(`note not found: ${pagePath}`)
    return loadPage(io, pagePath, nowIso())
  })

  ipcMain.handle(IPC.newPage, async (_e, pagePath: string) => {
    const page = await newPage(vault.pageIO(pagePath), pagePath, nowIso())
    await rememberPage(pagePath)
    await index.update(pagePath)
    return page
  })

  ipcMain.handle(
    IPC.savePage,
    async (_e, pagePath: string, manifest: PageManifest, contents: Record<string, string>) => {
      await savePage(vault.pageIO(pagePath), pagePath, manifest, { contents })
      await index.update(pagePath)
    },
  )

  ipcMain.handle(
    IPC.renamePage,
    async (
      _e,
      oldPath: string,
      newName: string,
      manifest: PageManifest,
      contents: Record<string, string>,
    ) => {
      // Same folder only; sanitize the name (no path separators / traversal).
      const dir = path.dirname(oldPath)
      let base = newName.trim().replace(/[\\/]/g, '')
      if (!base) throw new Error('页面名不能为空')
      if (base.toLowerCase().endsWith('.md')) base = base.slice(0, -3)
      const newPath = dir === '.' ? `${base}.md` : `${dir}/${base}.md`
      if (newPath === oldPath) {
        return { newPath: oldPath, page: await loadPage(vault.pageIO(oldPath), oldPath, nowIso()) }
      }
      if (await vault.pathExists(newPath)) throw new Error('目标页面已存在')
      // v3 is single-file: persist in-flight edits, then move the one .md.
      await savePage(vault.pageIO(oldPath), oldPath, manifest, { contents })
      await vault.moveEntry(oldPath, newPath)
      await index.rename(oldPath, newPath)
      await rememberPage(newPath)
      const page = await loadPage(vault.pageIO(newPath), newPath, nowIso())
      return { newPath, page }
    },
  )

  ipcMain.handle(
    IPC.reconcilePage,
    async (_e, pagePath: string, _prevManifest: PageManifest, _prevContents: Record<string, string>) => {
      // v3 is single-file: an external edit just reloads (the .md is the single source).
      const page = await loadPage(vault.pageIO(pagePath), pagePath, nowIso())
      await index.update(pagePath)
      return page
    },
  )

  ipcMain.handle(
    IPC.saveAsset,
    (_e, pagePath: string, fileName: string, bytes: Uint8Array) =>
      vault.writeAsset(pagePath, fileName, bytes),
  )

  ipcMain.handle(
    IPC.saveAttachment,
    (_e, pagePath: string, fileName: string, bytes: Uint8Array, opts: { mode: 'attachments' | 'same' | 'vault'; folder: string }) =>
      vault.writeAttachment(pagePath, fileName, bytes, opts),
  )

  ipcMain.handle(IPC.openAttachment, async (_e, pagePath: string, ref: string) => {
    const abs = await vault.resolveAttachment(pagePath, ref)
    if (abs) await shell.openPath(abs)
  })

  // 树/侧栏点开:路径已知且精确 → 直接钳制解析,不走 markdown ref 的 decode/basename 兜底
  // (否则根级同名文件会开错、含字面 %xx 的文件名会被解码到不存在的路径)。
  ipcMain.handle(IPC.openVaultFile, async (_e, vaultRel: string) => {
    const err = await shell.openPath(vault.absPath(vaultRel))
    if (err) throw new Error(err)
  })

  // 导出 PDF:渲染端已把编辑器克隆挂到 #amx-print-root,@media print 只呈现它(见 amadeus-host.css);
  // printToPDF 走打印媒体查询,同文档内 amadeus-asset://、KaTeX 字体全部可用,无需隐藏窗口二次渲染。
  ipcMain.handle(IPC.exportPdf, async (_e, defaultName: string) => {
    const win = getWindow()
    if (!win) return null
    const safe = (defaultName || 'note').replace(/[\\/:*?"<>|]/g, ' ').trim() || 'note'
    const { canceled, filePath } = await dialog.showSaveDialog(win, {
      defaultPath: `${safe}.pdf`,
      filters: [{ name: 'PDF', extensions: ['pdf'] }],
    })
    if (canceled || !filePath) return null
    const data = await win.webContents.printToPDF({ printBackground: true, pageSize: 'A4' })
    await fs.writeFile(filePath, data)
    shell.showItemInFolder(filePath)
    return filePath
  })

  // Database(.db JSON):read 按 ref 解析(与附件同一 basename 语义),write 按 read 返回的精确相对路径。
  ipcMain.handle(IPC.dbRead, async (_e, pagePath: string, ref: string): Promise<DbReadResult> => {
    const abs = await vault.resolveAttachment(pagePath, ref)
    if (!abs) return { status: 'missing' }
    const root = vault.getRoot()
    if (!root) return { status: 'missing' }
    const rel = path.relative(root, abs)
    let text: string
    try {
      text = await fs.readFile(abs, 'utf8')
    } catch {
      return { status: 'missing' }
    }
    const r = parseDb(text)
    return r.ok
      ? { status: 'ok', path: rel, data: r.data }
      : { status: 'corrupt', path: rel, message: r.error }
  })

  ipcMain.handle(IPC.dbWrite, async (_e, dbPath: string, data: unknown) => {
    const parsed = dbFileSchema.parse(data) // 防御性校验:坏数据拒写,绝不落半截文件
    await vault.writeTextFile(dbPath, serializeDb(parsed))
  })

  // 「笔记视图」(Bases):行 = 目标文件夹直属笔记,frontmatter 是唯一真源。
  ipcMain.handle(IPC.listPageProps, async (_e, folder: string): Promise<PageProps[]> => {
    if (!vault.getRoot()) return []
    const prefix = folder.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '')
    const inFolder = (await vault.listPages()).filter((p) => {
      if (prefix === '') return !p.includes('/') // 整库:仅顶层笔记
      if (!p.startsWith(`${prefix}/`)) return false
      return !p.slice(prefix.length + 1).includes('/') // 仅直属子级,不递归子文件夹
    })
    const out: PageProps[] = []
    for (const p of inFolder) {
      let raw: string
      try {
        raw = await fs.readFile(vault.absPath(p), 'utf8')
      } catch {
        continue
      }
      out.push({ path: p, title: path.basename(p).replace(/\.md$/i, ''), fm: parseFmObject(extractFrontmatterExtra(raw)) })
    }
    return out
  })

  ipcMain.handle(IPC.setPageFrontmatter, async (_e, pagePath: string, patch: Record<string, unknown>) => {
    let raw: string
    try {
      raw = await fs.readFile(vault.absPath(pagePath), 'utf8')
    } catch {
      return // 笔记不在(已被删)→ 静默跳过
    }
    await vault.writeTextFile(pagePath, setFmExtraOnSource(raw, patch)) // 原子写 + 自写账本 → watcher 不回声
    await index.update(pagePath)
  })

  ipcMain.handle(IPC.renamePageFile, async (_e, oldPath: string, newBaseName: string): Promise<string> => {
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
  })

  ipcMain.handle(IPC.search, (_e, query: string) => index.search(query))
  ipcMain.handle(IPC.backlinks, (_e, pagePath: string) => index.backlinks(pagePath))
  ipcMain.handle(IPC.reindex, () => index.build())
  ipcMain.handle(IPC.listTags, () => index.listTags())
  ipcMain.handle(IPC.pagesByTag, (_e, tag: string) => index.pagesByTag(tag))

  ipcMain.handle(IPC.listFolders, () => vault.listFolders())

  ipcMain.handle(IPC.resolveEmbed, (_e, target: string) => {
    // The inline index already holds each block's content + owning note.
    const hit = index.resolveBlock(target)
    return hit ? { owner: hit.path, content: hit.content, type: hit.type } : null
  })

  ipcMain.handle(IPC.blockBacklinks, (_e, target: string) => index.blockBacklinks(target))

  ipcMain.handle(IPC.deletePage, async (_e, pagePath: string) => {
    await vault.removeEntry(pagePath) // v3: a note is a single .md
    index.remove(pagePath)
  })

  ipcMain.handle(IPC.movePage, async (_e, pagePath: string, destFolder: string) => {
    const fileName = pageFileName(pagePath)
    const dstRel = destFolder.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '')
    const newPath = dstRel ? `${dstRel}/${fileName}` : fileName
    if (newPath === pagePath) return pagePath
    if (await vault.pathExists(newPath)) throw new Error('目标位置已存在同名文件')
    await vault.moveEntry(pagePath, newPath)
    // 树里的附件(非 .md)也走本通道移动:不进索引(index.update 会把二进制按 utf8 读成巨串)、不记 lastPage。
    if (newPath.endsWith('.md')) {
      index.remove(pagePath)
      await index.update(newPath)
      await rememberPage(newPath)
    }
    return newPath
  })

  ipcMain.handle(IPC.createFolder, async (_e, parentFolder: string, name: string) => {
    const clean = name.trim().replace(/[\\/]/g, '')
    if (!clean) throw new Error('文件夹名不能为空')
    const parent = parentFolder.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '')
    const rel = parent ? `${parent}/${clean}` : clean
    if (await vault.pathExists(rel)) throw new Error('同名文件夹已存在')
    await vault.makeDir(rel)
    return rel
  })

  ipcMain.handle(IPC.renameFolder, async (_e, folderPath: string, newName: string) => {
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
  })

  ipcMain.handle(IPC.deleteFolder, async (_e, folderPath: string) => {
    await vault.removeEntry(folderPath)
    await index.build()
  })

  const pluginsDir = (): string | null => {
    const root = vault.getRoot()
    return root ? path.join(root, '.amadeus', 'plugins') : null
  }
  /** 全局插件目录(跨 vault 生效;market type='amadeus-plugin' 装到同目录)。 */
  const globalPluginsDir = (): string => path.join(forsionHomeDir(), 'amadeus', 'plugins')

  ipcMain.handle(IPC.listPlugins, async (): Promise<ExternalPluginSource[]> => {
    // 双根扫描,vault 优先(同 id vault 覆盖全局 = Obsidian 式开发覆盖;先扫先得,照 tangu-agent loader 的纪律)。
    const vaultDir = pluginsDir()
    const roots: Array<{ dir: string; source: 'vault' | 'global' }> = [
      ...(vaultDir ? [{ dir: vaultDir, source: 'vault' as const }] : []),
      { dir: globalPluginsDir(), source: 'global' as const },
    ]
    const seen = new Set<string>()
    const out: ExternalPluginSource[] = []
    for (const root of roots) {
      let entries: import('node:fs').Dirent[]
      try {
        entries = await fs.readdir(root.dir, { withFileTypes: true })
      } catch {
        continue
      }
      for (const e of entries) {
        if (!e.isDirectory() || e.name.startsWith('.')) continue
        const pdir = path.join(root.dir, e.name)
        try {
          const m = JSON.parse(await fs.readFile(path.join(pdir, 'manifest.json'), 'utf8')) as {
            id?: string
            name?: string
            version?: string
            description?: string
            main?: string
            apiVersion?: number
            minAppVersion?: string
          }
          const id = m.id || e.name
          if (seen.has(id)) continue
          // 门禁:apiVersion 不匹配 / 应用太旧 → 列出但不可加载(blocked 徽章),code 不读不发。
          const blocked = gatePluginManifest(m, app.getVersion())
          const code = blocked ? '' : await fs.readFile(path.join(pdir, m.main || 'main.js'), 'utf8')
          // seen 只在成功列出后占位:vault 副本坏了(如 main.js 缺失)不该把同 id 的全局副本也藏掉。
          seen.add(id)
          out.push({
            id,
            name: m.name || e.name,
            version: m.version || '0.0.0',
            description: m.description,
            code,
            apiVersion: typeof m.apiVersion === 'number' ? m.apiVersion : 1,
            minAppVersion: typeof m.minAppVersion === 'string' ? m.minAppVersion : undefined,
            source: root.source,
            blocked: blocked ?? undefined,
          })
        } catch {
          /* skip malformed plugin */
        }
      }
    }
    return out
  })

  ipcMain.handle(IPC.openPluginsFolder, async () => {
    const dir = pluginsDir() ?? globalPluginsDir() // 无 vault → 打开全局目录
    await fs.mkdir(dir, { recursive: true })
    await shell.openPath(dir)
  })

  ipcMain.handle(IPC.revealInFileManager, async (_e, targetPath: string) => {
    // Clamp to the vault, then select the item in the OS file manager. showItemInFolder
    // opens the parent and highlights the entry — works for both files and folders.
    const abs = vault.absPath(targetPath)
    shell.showItemInFolder(abs)
  })

  ipcMain.handle(IPC.scaffoldPlugin, async () => {
    const dir = pluginsDir() ?? globalPluginsDir() // 无 vault → 脚手架落全局目录
    const pdir = path.join(dir, 'hello-amadeus')
    await fs.mkdir(pdir, { recursive: true })
    await fs.writeFile(path.join(pdir, 'manifest.json'), SAMPLE_MANIFEST, 'utf8')
    await fs.writeFile(path.join(pdir, 'main.js'), SAMPLE_MAIN, 'utf8')
  })

  return { getVaultRoot: () => vault.getRoot() }
}
