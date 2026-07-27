// Owns the filesystem and the vault security boundary: path clamping, atomic writes,
// page discovery, and a self-write ledger so the watcher can ignore our own writes.

import { promises as fs } from 'node:fs'
import path from 'node:path'
import { dialog } from 'electron'
import type { CompilerIO } from '@amadeus-shared/compiler'
import { isDrawingPath } from '@amadeus-shared/excalidraw/format'
import { attachmentPaths } from './attachmentPaths'

export class VaultManager {
  private root: string | null = null
  private counter = 0
  /** absolutePath -> last content WE wrote, used to suppress echo events in the watcher. */
  private lastWritten = new Map<string, string>()
  /** 插件声明的文件类型扩展名(小写;经 listPlugins → setPluginFileExtensions 注入)。这些 .md 文件
   *  是插件的自定义类型(如 `.mindmap.md`)、不是笔记,须排出 listPages 免被 compiler 改写=毁档。 */
  private pluginExts: string[] = []
  /** 应用侧写盘钩子(云同步推送触发):自写走台账不进 watcher,同步引擎靠它感知应用内改动。 */
  private onMutate: ((rel: string, kind: 'write' | 'remove') => void) | null = null
  private onMove: ((fromRel: string, toRel: string) => void) | null = null

  setMutationHooks(
    onMutate: (rel: string, kind: 'write' | 'remove') => void,
    onMove: (fromRel: string, toRel: string) => void,
  ): void {
    this.onMutate = onMutate
    this.onMove = onMove
  }

  private emitMutate(abs: string, kind: 'write' | 'remove'): void {
    if (!this.onMutate || !this.root) return
    const rel = path.relative(this.root, abs)
    if (rel && !rel.startsWith('..')) this.onMutate(rel, kind)
  }

  getRoot(): string | null {
    return this.root
  }

  setRoot(p: string): void {
    this.root = p
  }

  async openDialog(): Promise<string | null> {
    const res = await dialog.showOpenDialog({
      title: '打开 Vault 文件夹',
      properties: ['openDirectory', 'createDirectory'],
    })
    if (res.canceled || !res.filePaths[0]) return null
    this.root = res.filePaths[0]
    return this.root
  }

  private requireRoot(): string {
    if (!this.root) throw new Error('No vault is open')
    return this.root
  }

  /** Resolve a vault-relative path, rejecting anything that escapes the vault root. */
  private resolveInVault(relOrSegs: string): string {
    const root = this.requireRoot()
    const abs = path.resolve(root, relOrSegs)
    const rel = path.relative(root, abs)
    if (rel === '' || rel.startsWith('..') || path.isAbsolute(rel)) {
      if (abs !== root) throw new Error('Path escapes vault: ' + abs)
    }
    return abs
  }

  /** All files passing `pred`, vault-relative, ignoring dot-sidecars and node_modules. */
  private async collectFiles(pred: (name: string) => boolean): Promise<string[]> {
    const root = this.requireRoot()
    const out: string[] = []
    const walk = async (dir: string): Promise<void> => {
      let entries: import('node:fs').Dirent[]
      try {
        entries = await fs.readdir(dir, { withFileTypes: true })
      } catch {
        return
      }
      for (const e of entries) {
        if (e.name.startsWith('.') || e.name === 'node_modules') continue
        const abs = path.join(dir, e.name)
        if (e.isDirectory()) await walk(abs)
        else if (e.isFile() && pred(e.name)) out.push(path.relative(root, abs))
      }
    }
    await walk(root)
    return out.sort()
  }

  /** All page (.md) files, vault-relative.
   *  `*.excalidraw.md`(Excalidraw 画板)磁盘上虽是 .md,却绝不是笔记:放进来就会被笔记树收录、被
   *  compiler 当页面解析,一存就把插件的载荷改写成 `<!-- a id -->` 块 + amadeus_* frontmatter
   *  —— 对 Obsidian 侧即毁档。页面侧的消费方(树/索引/搜索/反链/tags)全从这一个口取,挡这里就够。 */
  async listPages(): Promise<string[]> {
    return this.collectFiles(
      (n) => n.endsWith('.md') && !isDrawingPath(n) && !this.isPluginFile(n),
    )
  }

  /** All non-page files (attachments/.db/画板/思维导图/插件文件类型/…), vault-relative — for the vault tree. */
  async listFiles(): Promise<string[]> {
    return this.collectFiles(
      (n) => !n.endsWith('.md') || isDrawingPath(n) || this.isPluginFile(n),
    )
  }

  /** 由 listPlugins 注入插件声明的文件类型扩展名(见 pluginExts)。 */
  setPluginFileExtensions(exts: string[]): void {
    this.pluginExts = exts.map((e) => e.toLowerCase()).filter(Boolean)
  }

  /** 该文件名是否命中某个插件声明的文件类型扩展名(小写后缀匹配)。 */
  private isPluginFile(name: string): boolean {
    if (!this.pluginExts.length) return false
    const n = name.toLowerCase()
    return this.pluginExts.some((ext) => n.endsWith(ext))
  }

  /** True if `content` matches what we last wrote to `abs` (i.e. not an external edit). */
  wasSelfWrite(abs: string, content: string): boolean {
    return this.lastWritten.get(abs) === content
  }

  absPath(pagePath: string): string {
    return this.resolveInVault(pagePath)
  }

  private async atomicWrite(abs: string, data: string): Promise<void> {
    await fs.mkdir(path.dirname(abs), { recursive: true })
    const tmp = `${abs}.tmp-${process.pid}-${Date.now()}-${this.counter++}`
    await fs.writeFile(tmp, data, 'utf8')
    await fs.rename(tmp, abs)
    this.lastWritten.set(abs, data)
    this.emitMutate(abs, 'write')
  }

  /** Write a UTF-8 text file at a vault-relative path (clamped + atomic;供 .db 等非页面文件写回)。 */
  async writeTextFile(rel: string, text: string): Promise<void> {
    await this.atomicWrite(this.resolveInVault(rel), text)
  }

  /** Overwrite a binary file in place at a vault-relative path (clamped + atomic;供 PDF 批注写回等)。
   *  与 writeAsset 不同:不重命名、不落 .amadeus/,原地覆盖既有文件;emit mutate 让同步/watcher 重传。 */
  async writeVaultBytes(rel: string, bytes: Uint8Array): Promise<void> {
    const abs = this.resolveInVault(rel) // 越界即抛
    await fs.mkdir(path.dirname(abs), { recursive: true })
    const tmp = `${abs}.tmp-${process.pid}-${Date.now()}-${this.counter++}`
    await fs.writeFile(tmp, bytes)
    await fs.rename(tmp, abs)
    this.emitMutate(abs, 'write')
  }

  /** Read a vault file's raw bytes by vault-relative path (clamped;供 PDF 阅读器 getDocument({data}))。 */
  async readVaultBytes(rel: string): Promise<Uint8Array> {
    const abs = this.resolveInVault(rel) // 越界即抛
    return fs.readFile(abs)
  }

  /** Write a binary asset under the page's .amadeus/ folder; returns its page-relative path. */
  async writeAsset(pagePath: string, fileName: string, bytes: Uint8Array): Promise<string> {
    const root = this.requireRoot()
    const folderAbs = path.resolve(root, path.dirname(pagePath))
    const ext = (path.extname(fileName) || '.png').toLowerCase().replace(/[^.a-z0-9]/g, '')
    const stem =
      path.basename(fileName, path.extname(fileName)).replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 24) || 'img'
    const unique = `${stem}-${Date.now().toString(36)}-${(this.counter++).toString(36)}${ext || '.png'}`
    const assetsAbs = path.join(folderAbs, '.amadeus')
    const fileAbs = path.join(assetsAbs, unique)

    const rel = path.relative(root, fileAbs)
    if (rel.startsWith('..') || path.isAbsolute(rel)) throw new Error('Asset escapes vault')

    await fs.mkdir(assetsAbs, { recursive: true })
    await fs.writeFile(fileAbs, bytes)
    this.emitMutate(fileAbs, 'write')
    return `.amadeus/${unique}`
  }

  /** Import a dragged-in file to the configured location, keeping its name (de-duped on collision).
   *  mode: attachments=<pageDir>/attachments/;same=<pageDir>/;vault=<folder>/ (vault-relative). */
  async writeAttachment(
    pagePath: string,
    fileName: string,
    bytes: Uint8Array,
    opts: { mode: 'attachments' | 'same' | 'vault'; folder: string },
  ): Promise<{ pageRel: string; base: string }> {
    this.requireRoot() // 无 vault 即抛
    const safeName = (path.basename(fileName) || 'file').replace(/[\\/]/g, '') // 保留原名(允许空格/中文)
    const { destDirRel } = attachmentPaths(pagePath, safeName, opts) // destDir 与文件名无关,可先算
    const absDir = this.resolveInVault(destDirRel || '.')
    await fs.mkdir(absDir, { recursive: true })

    const base = await this.uniqueName(absDir, safeName)
    const { fileVaultRel, pageRel } = attachmentPaths(pagePath, base, opts)
    const abs = this.resolveInVault(fileVaultRel) // 越界钳制
    await fs.writeFile(abs, bytes)
    this.emitMutate(abs, 'write')
    return { pageRel, base }
  }

  /** Resolve an attachment ref (page-relative path OR bare basename) to an absolute path, vault-clamped. */
  async resolveAttachment(pagePath: string, ref: string): Promise<string | null> {
    const root = this.requireRoot()
    const r = ref.replace(/^<|>$/g, '').trim()
    // 文件名可含裸 '%'(如 "100% done.png"),decodeURIComponent 会抛 → 原样回退。
    const safeDecode = (s: string): string => { try { return decodeURIComponent(s) } catch { return s } }
    let abs: string
    // Windows 的 vault 相对路径以 '\' 分隔(listFiles/listPages 原样输出),同样按路径解析;
    // mac/linux 上 '\' 是合法文件名字符,不当分隔符。
    const looksLikePath = r.includes('/') || (process.platform === 'win32' && r.includes('\\'))
    if (looksLikePath) {
      const pageDirAbs = path.resolve(root, path.dirname(pagePath))
      abs = path.resolve(pageDirAbs, safeDecode(r))
      // 页相对解析落空 → 回退按 vault 根解析:dbAggregateStore/独立 db 视图传的是完整 vault 相对路径
      // (pagePath=dbPath 时页相对会双拼目录,子文件夹 .db 曾因此静默 missing)。
      try {
        await fs.access(abs)
      } catch {
        const rootAbs = path.resolve(root, safeDecode(r))
        try {
          await fs.access(rootAbs)
          abs = rootAbs
        } catch {
          /* 两处都不存在:保留页相对语义,由调用方按 missing 处理 */
        }
      }
    } else {
      const found = await this.findByBasename(root, r)
      if (!found) return null
      abs = found
    }
    const rel = path.relative(root, abs)
    if (rel.startsWith('..') || path.isAbsolute(rel)) return null
    return abs
  }

  /** A collision-free filename inside `absDir` (adds "-1", "-2"… before the extension).
   *  复合后缀类型(内置的 `x.excalidraw.md`,以及插件声明的 `x.mindmap.md` 一类)必须整段视为扩展名:
   *  按 path.extname 只认最后一段 `.md`,撞名会写出 `x.mindmap-1.md` —— 后缀一破就掉出该类型的判定、
   *  混回笔记树被 page compiler 当普通笔记改写 = 毁档(Codex)。
   *  插件声明的后缀走 pluginExts(listPlugins 注入),所以新插件的复合后缀自动受同一保护。 */
  private async uniqueName(absDir: string, name: string): Promise<string> {
    const lower = name.toLowerCase()
    // 最长匹配优先:`.excalidraw.md` 与 `.md` 同时命中时要取长的那个。
    const composite = ['.excalidraw.md', ...this.pluginExts]
      .filter((s) => lower.endsWith(s))
      .sort((a, b) => b.length - a.length)[0]
    const ext = composite ?? path.extname(name)
    const stem = name.slice(0, name.length - ext.length) || 'file'
    for (let i = 0; i < 1000; i++) {
      const candidate = i === 0 ? name : `${stem}-${i}${ext}`
      try {
        await fs.access(path.join(absDir, candidate))
      } catch {
        return candidate // doesn't exist → free
      }
    }
    return `${stem}-${Date.now().toString(36)}${ext}`
  }

  /** First file with `basename` anywhere in the vault (dot-dirs / node_modules skipped). */
  private async findByBasename(root: string, basename: string): Promise<string | null> {
    const target = basename.toLowerCase()
    const walk = async (dir: string): Promise<string | null> => {
      let entries: import('node:fs').Dirent[]
      try {
        entries = await fs.readdir(dir, { withFileTypes: true })
      } catch {
        return null
      }
      for (const e of entries) {
        if (e.name.startsWith('.') || e.name === 'node_modules') continue
        const abs = path.join(dir, e.name)
        if (e.isDirectory()) {
          const hit = await walk(abs)
          if (hit) return hit
        } else if (e.isFile() && e.name.toLowerCase() === target) {
          return abs
        }
      }
      return null
    }
    return walk(root)
  }

  /** All sub-folders, vault-relative, ignoring dot-dirs and node_modules. */
  async listFolders(): Promise<string[]> {
    const root = this.requireRoot()
    const out: string[] = []
    const walk = async (dir: string): Promise<void> => {
      let entries: import('node:fs').Dirent[]
      try {
        entries = await fs.readdir(dir, { withFileTypes: true })
      } catch {
        return
      }
      for (const e of entries) {
        if (e.name.startsWith('.') || e.name === 'node_modules') continue
        if (e.isDirectory()) {
          const abs = path.join(dir, e.name)
          out.push(path.relative(root, abs))
          await walk(abs)
        }
      }
    }
    await walk(root)
    return out.sort()
  }

  /** Names (not paths) of the immediate children of a vault-relative dir ('' = root). */
  async listChildren(relDir: string): Promise<string[]> {
    const abs = relDir ? this.resolveInVault(relDir) : this.requireRoot()
    try {
      return await fs.readdir(abs)
    } catch {
      return []
    }
  }

  async pathExists(rel: string): Promise<boolean> {
    try {
      await fs.access(this.resolveInVault(rel))
      return true
    } catch {
      return false
    }
  }

  /** Create a folder (recursive). */
  async makeDir(rel: string): Promise<void> {
    await fs.mkdir(this.resolveInVault(rel), { recursive: true })
  }

  /** Move/rename a file or folder within the vault (both ends clamped). */
  async moveEntry(srcRel: string, dstRel: string): Promise<void> {
    const srcAbs = this.resolveInVault(srcRel)
    const dstAbs = this.resolveInVault(dstRel)
    await fs.mkdir(path.dirname(dstAbs), { recursive: true })
    await fs.rename(srcAbs, dstAbs)
    this.lastWritten.delete(srcAbs)
    if (this.onMove && this.root) {
      const from = path.relative(this.root, srcAbs)
      const to = path.relative(this.root, dstAbs)
      if (!from.startsWith('..') && !to.startsWith('..')) this.onMove(from, to)
    }
  }

  /** Recursively remove a file or folder within the vault (never the root). */
  async removeEntry(rel: string): Promise<void> {
    const abs = this.resolveInVault(rel)
    if (abs === this.requireRoot()) throw new Error('Refusing to remove the vault root')
    await fs.rm(abs, { recursive: true, force: true })
    this.lastWritten.delete(abs)
    this.emitMutate(abs, 'remove')
  }

  // ── 回收站(.trash):删除默认可恢复。点开头目录被扫描/索引天然跳过 → 树/搜索/链接全免疫。
  //    布局:扁平存放(撞名加 " (N)")+ .meta.json 记原相对路径与删除时间,恢复按 meta 回原位。 ──

  private trashDir(): string {
    return path.join(this.requireRoot(), '.trash')
  }

  /** trash 条目名来自渲染端,须为纯 basename(防路径穿越)。 */
  private trashItemAbs(name: string): string {
    if (!name || name === '.' || name === '..' || name.includes('/') || name.includes('\\')) {
      throw new Error('Bad trash entry name')
    }
    return path.join(this.trashDir(), name)
  }

  private async readTrashMeta(): Promise<Record<string, { original: string; deletedAt: number }>> {
    try {
      const raw = JSON.parse(await fs.readFile(path.join(this.trashDir(), '.meta.json'), 'utf8')) as unknown
      return raw && typeof raw === 'object' ? (raw as Record<string, { original: string; deletedAt: number }>) : {}
    } catch {
      return {}
    }
  }

  private async writeTrashMeta(meta: Record<string, { original: string; deletedAt: number }>): Promise<void> {
    await fs.mkdir(this.trashDir(), { recursive: true })
    await fs.writeFile(path.join(this.trashDir(), '.meta.json'), `${JSON.stringify(meta, null, 2)}\n`)
  }

  /** 撞名找空位:在扩展名前追加 " (N)"。probe 返回 true = 已占用。 */
  private async freeName(base: string, probe: (candidate: string) => Promise<boolean>): Promise<string> {
    let name = base
    for (let i = 2; await probe(name); i++) {
      const ext = path.extname(base)
      name = `${base.slice(0, base.length - ext.length)} (${i})${ext}`
    }
    return name
  }

  /** 移入回收站(文件或文件夹)。 */
  async trashEntry(rel: string): Promise<void> {
    const srcAbs = this.resolveInVault(rel)
    if (srcAbs === this.requireRoot()) throw new Error('Refusing to trash the vault root')
    await fs.mkdir(this.trashDir(), { recursive: true })
    const exists = async (n: string): Promise<boolean> => {
      try {
        await fs.access(this.trashItemAbs(n))
        return true
      } catch {
        return false
      }
    }
    const name = await this.freeName(path.basename(rel), exists)
    await fs.rename(srcAbs, this.trashItemAbs(name))
    this.lastWritten.delete(srcAbs)
    this.emitMutate(srcAbs, 'remove')
    const meta = await this.readTrashMeta()
    meta[name] = { original: rel.replace(/\\/g, '/'), deletedAt: Date.now() }
    await this.writeTrashMeta(meta)
  }

  async listTrash(): Promise<Array<{ name: string; original: string; deletedAt: number; dir: boolean }>> {
    let entries
    try {
      entries = await fs.readdir(this.trashDir(), { withFileTypes: true })
    } catch {
      return []
    }
    const meta = await this.readTrashMeta()
    const out: Array<{ name: string; original: string; deletedAt: number; dir: boolean }> = []
    for (const e of entries) {
      if (e.name === '.meta.json') continue
      // 无 meta 的孤儿(外部塞进来的)也可见可恢复,原位视为 vault 根同名
      out.push({ name: e.name, original: meta[e.name]?.original ?? e.name, deletedAt: meta[e.name]?.deletedAt ?? 0, dir: e.isDirectory() })
    }
    out.sort((a, b) => b.deletedAt - a.deletedAt)
    return out
  }

  /** 恢复:回 meta 记录的原位(父目录补建);原位被占在文件名后加 " (N)"。返回恢复后的相对路径。 */
  async restoreTrash(name: string): Promise<string> {
    const root = this.requireRoot()
    const srcAbs = this.trashItemAbs(name)
    const meta = await this.readTrashMeta()
    const original = (meta[name]?.original ?? name).replace(/\\/g, '/')
    const occupied = async (rel: string): Promise<boolean> => {
      try {
        await fs.access(path.resolve(root, rel))
        return true
      } catch {
        return false
      }
    }
    const dir = original.includes('/') ? original.slice(0, original.lastIndexOf('/')) : ''
    const base = await this.freeName(original.slice(original.lastIndexOf('/') + 1), (n) => occupied(dir ? `${dir}/${n}` : n))
    const dstRel = dir ? `${dir}/${base}` : base
    const dstAbs = this.resolveInVault(dstRel)
    await fs.mkdir(path.dirname(dstAbs), { recursive: true })
    await fs.rename(srcAbs, dstAbs)
    delete meta[name]
    await this.writeTrashMeta(meta)
    this.emitMutate(dstAbs, 'write')
    return dstRel
  }

  /** 彻底删除单条。 */
  async deleteTrashEntry(name: string): Promise<void> {
    await fs.rm(this.trashItemAbs(name), { recursive: true, force: true })
    const meta = await this.readTrashMeta()
    if (meta[name]) {
      delete meta[name]
      await this.writeTrashMeta(meta)
    }
  }

  /** 清空回收站。 */
  async emptyTrash(): Promise<void> {
    await fs.rm(this.trashDir(), { recursive: true, force: true })
  }

  /** A CompilerIO bound to a page's folder (paths are relative to that folder). */
  pageIO(pagePath: string): CompilerIO {
    const root = this.requireRoot()
    const folderAbs = path.resolve(root, path.dirname(pagePath))
    const folderRel = path.relative(root, folderAbs)
    if (folderRel.startsWith('..') || path.isAbsolute(folderRel)) {
      throw new Error('Page escapes vault: ' + pagePath)
    }
    const within = (name: string): string => {
      const abs = path.resolve(folderAbs, name)
      const rel = path.relative(folderAbs, abs)
      if (rel.startsWith('..') || path.isAbsolute(rel)) {
        throw new Error('Block path escapes page folder: ' + name)
      }
      return abs
    }
    return {
      readFile: (n) => fs.readFile(within(n), 'utf8'),
      writeFile: (n, d) => this.atomicWrite(within(n), d),
      deleteFile: async (n) => {
        try {
          await fs.unlink(within(n))
          this.lastWritten.delete(within(n))
          this.emitMutate(within(n), 'remove')
        } catch {
          /* already gone */
        }
      },
      exists: async (n) => {
        try {
          await fs.access(within(n))
          return true
        } catch {
          return false
        }
      },
      listDir: async (rel) => {
        try {
          return await fs.readdir(rel ? within(rel) : folderAbs)
        } catch {
          return []
        }
      },
      removeDir: async (rel) => {
        try {
          await fs.rm(within(rel), { recursive: true, force: true })
          this.emitMutate(within(rel), 'remove')
        } catch {
          /* already gone */
        }
      },
    }
  }
}
