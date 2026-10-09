// 移植自 desktop/electron/amadeus/fs/vaultManager.ts。逻辑照搬,只换 IO:
//  node:fs → ./fsAdapter(Capacitor Filesystem);node:path → path-browserify;删 electron.dialog;
//  atomicWrite 直写(Android rename 不覆盖已存在文件,故不用 tmp+rename);process.platform→false。
// 虚拟绝对根 = '/vault'(见 mobileAmadeusBridge)。
import path from 'path-browserify'
import { fs, type Dirent } from './fsAdapter'
import type { CompilerIO } from '@amadeus-shared/compiler'
import { isDrawingPath } from '@amadeus-shared/excalidraw/format'
import { attachmentPaths } from './attachmentPaths'

export class VaultManager {
  /** pluginExts:插件声明的文件后缀(小写),由 mobile/src/main.tsx 在建桥**之前**从各插件 manifest 清点好
   *  (pluginHost.fileExtensions)。给的是取值函数:装 / 卸插件后名单会变,这里每次现取。 */
  constructor(private readonly pluginExts: () => string[] = () => []) {}

  private root: string | null = null
  private counter = 0
  private lastWritten = new Map<string, string>()

  getRoot(): string | null { return this.root }
  setRoot(p: string): void { this.root = p }

  private requireRoot(): string {
    if (!this.root) throw new Error('No vault is open')
    return this.root
  }

  private resolveInVault(relOrSegs: string): string {
    const root = this.requireRoot()
    const abs = path.resolve(root, relOrSegs)
    const rel = path.relative(root, abs)
    if (rel === '' || rel.startsWith('..') || path.isAbsolute(rel)) {
      if (abs !== root) throw new Error('Path escapes vault: ' + abs)
    }
    return abs
  }

  private async collectFiles(pred: (name: string) => boolean): Promise<string[]> {
    const root = this.requireRoot()
    const out: string[] = []
    const walk = async (dir: string): Promise<void> => {
      let entries: Dirent[]
      try { entries = await fs.readdir(dir, { withFileTypes: true }) } catch { return }
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

  /** 「这条路径算不算一篇笔记」的单一判据(desktop vaultManager.isPagePath 同款):白板(.excalidraw.md)与插件声明的
   *  文件类型(`.deck.md` 等)磁盘上是 .md,却绝不是笔记 —— 进了 pages 就被索引 / 改名重写 / 笔记编辑器按笔记的写法
   *  改写 = 毁档。页面侧的消费方(树 / 索引 / 搜索 / 反链)全从 listPages 取,索引的单篇更新也问这里(VaultIndex.update)。 */
  isPagePath(rel: string): boolean {
    const n = rel.replace(/\\/g, '/')
    const lower = n.toLowerCase()
    return n.endsWith('.md') && !isDrawingPath(n) && !this.pluginExts().some((ext) => lower.endsWith(ext))
  }
  async listPages(): Promise<string[]> { return this.collectFiles((n) => this.isPagePath(n)) }
  /** 笔记以外的全部文件(附件 / .db / 白板 / 插件文件类型),给文件树用:插件文件挪出 pages 之后还得在树上看得见。 */
  async listFiles(): Promise<string[]> { return this.collectFiles((n) => !this.isPagePath(n)) }

  wasSelfWrite(abs: string, content: string): boolean { return this.lastWritten.get(abs) === content }

  absPath(pagePath: string): string { return this.resolveInVault(pagePath) }

  /** VaultIndex 读文件用(移动端 fs 只 utf8)。 */
  readTextAbs(abs: string): Promise<string> { return fs.readFile(abs, 'utf8') }

  private async atomicWrite(abs: string, data: string): Promise<void> {
    // 移动端:Capacitor writeFile(recursive) 直接写;不用 tmp+rename(Android rename 不覆盖已存在)。
    await fs.writeFile(abs, data)
    this.lastWritten.set(abs, data)
  }

  async writeTextFile(rel: string, text: string): Promise<void> {
    await this.atomicWrite(this.resolveInVault(rel), text)
  }

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
    return `.amadeus/${unique}`
  }

  async writeAttachment(
    pagePath: string,
    fileName: string,
    bytes: Uint8Array,
    opts: { mode: 'attachments' | 'same' | 'vault'; folder: string },
  ): Promise<{ pageRel: string; base: string }> {
    this.requireRoot()
    const safeName = (path.basename(fileName) || 'file').replace(/[\\/]/g, '')
    const { destDirRel } = attachmentPaths(pagePath, safeName, opts)
    const absDir = this.resolveInVault(destDirRel || '.')
    await fs.mkdir(absDir, { recursive: true })
    const base = await this.uniqueName(absDir, safeName)
    const { fileVaultRel, pageRel } = attachmentPaths(pagePath, base, opts)
    const abs = this.resolveInVault(fileVaultRel)
    await fs.writeFile(abs, bytes)
    return { pageRel, base }
  }

  async resolveAttachment(pagePath: string, ref: string): Promise<string | null> {
    const root = this.requireRoot()
    const r = ref.replace(/^<|>$/g, '').trim()
    const safeDecode = (s: string): string => { try { return decodeURIComponent(s) } catch { return s } }
    let abs: string
    const looksLikePath = r.includes('/') // 移动端(Android)无 win32 '\\' 分隔
    if (looksLikePath) {
      const pageDirAbs = path.resolve(root, path.dirname(pagePath))
      abs = path.resolve(pageDirAbs, safeDecode(r))
    } else {
      const found = await this.findByBasename(root, r)
      if (!found) return null
      abs = found
    }
    const rel = path.relative(root, abs)
    if (rel.startsWith('..') || path.isAbsolute(rel)) return null
    return abs
  }

  private async uniqueName(absDir: string, name: string): Promise<string> {
    const ext = path.extname(name)
    const stem = name.slice(0, name.length - ext.length) || 'file'
    for (let i = 0; i < 1000; i++) {
      const candidate = i === 0 ? name : `${stem}-${i}${ext}`
      try { await fs.access(path.join(absDir, candidate)) } catch { return candidate }
    }
    return `${stem}-${Date.now().toString(36)}${ext}`
  }

  private async findByBasename(root: string, basename: string): Promise<string | null> {
    const target = basename.toLowerCase()
    const walk = async (dir: string): Promise<string | null> => {
      let entries: Dirent[]
      try { entries = await fs.readdir(dir, { withFileTypes: true }) } catch { return null }
      for (const e of entries) {
        if (e.name.startsWith('.') || e.name === 'node_modules') continue
        const abs = path.join(dir, e.name)
        if (e.isDirectory()) { const hit = await walk(abs); if (hit) return hit }
        else if (e.isFile() && e.name.toLowerCase() === target) return abs
      }
      return null
    }
    return walk(root)
  }

  async listFolders(): Promise<string[]> {
    const root = this.requireRoot()
    const out: string[] = []
    const walk = async (dir: string): Promise<void> => {
      let entries: Dirent[]
      try { entries = await fs.readdir(dir, { withFileTypes: true }) } catch { return }
      for (const e of entries) {
        if (e.name.startsWith('.') || e.name === 'node_modules') continue
        if (e.isDirectory()) { const abs = path.join(dir, e.name); out.push(path.relative(root, abs)); await walk(abs) }
      }
    }
    await walk(root)
    return out.sort()
  }

  async listChildren(relDir: string): Promise<string[]> {
    const abs = relDir ? this.resolveInVault(relDir) : this.requireRoot()
    try { return await fs.readdir(abs) } catch { return [] }
  }

  async pathExists(rel: string): Promise<boolean> {
    try { await fs.access(this.resolveInVault(rel)); return true } catch { return false }
  }

  async makeDir(rel: string): Promise<void> {
    await fs.mkdir(this.resolveInVault(rel), { recursive: true })
  }

  async moveEntry(srcRel: string, dstRel: string): Promise<void> {
    const srcAbs = this.resolveInVault(srcRel)
    const dstAbs = this.resolveInVault(dstRel)
    await fs.mkdir(path.dirname(dstAbs), { recursive: true })
    await fs.rename(srcAbs, dstAbs)
    this.lastWritten.delete(srcAbs)
  }

  async removeEntry(rel: string): Promise<void> {
    const abs = this.resolveInVault(rel)
    if (abs === this.requireRoot()) throw new Error('Refusing to remove the vault root')
    await fs.rm(abs, { recursive: true, force: true })
    this.lastWritten.delete(abs)
  }

  // ── 二进制读写(PDF 阅读器/字节资产;desktop writeVaultBytes/readVaultBytes 同款,IO 走 fsAdapter) ──

  async writeVaultBytes(rel: string, bytes: Uint8Array): Promise<void> {
    const abs = this.resolveInVault(rel) // 越界即抛
    await fs.mkdir(path.dirname(abs), { recursive: true })
    await fs.writeFile(abs, bytes)
  }

  async readVaultBytes(rel: string): Promise<Uint8Array> {
    return fs.readFile(this.resolveInVault(rel)) // 无 encoding = Uint8Array
  }

  /** 库根在 WebView 里可直接加载的地址(图片 / 音视频的显示地址以它为前缀,见 localAssets.ts)。 */
  assetBase(): Promise<string> {
    return fs.webUrl(this.requireRoot())
  }

  // ── 回收站(.trash):desktop vaultManager 同款(扁平存放,撞名加 " (N)",.meta.json 记原位;
  //    点开头目录被扫描/索引天然跳过 → 树/搜索/链接全免疫)。差异:无 watcher → 无 emitMutate。 ──

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
      try { await fs.access(this.trashItemAbs(n)); return true } catch { return false }
    }
    const name = await this.freeName(path.basename(rel), exists)
    await fs.rename(srcAbs, this.trashItemAbs(name))
    this.lastWritten.delete(srcAbs)
    const meta = await this.readTrashMeta()
    meta[name] = { original: rel.replace(/\\/g, '/'), deletedAt: Date.now() }
    await this.writeTrashMeta(meta)
  }

  async listTrash(): Promise<Array<{ name: string; original: string; deletedAt: number; dir: boolean }>> {
    let entries: Dirent[]
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
      try { await fs.access(path.resolve(root, rel)); return true } catch { return false }
    }
    const dir = original.includes('/') ? original.slice(0, original.lastIndexOf('/')) : ''
    const base = await this.freeName(original.slice(original.lastIndexOf('/') + 1), (n) => occupied(dir ? `${dir}/${n}` : n))
    const dstRel = dir ? `${dir}/${base}` : base
    const dstAbs = this.resolveInVault(dstRel)
    await fs.mkdir(path.dirname(dstAbs), { recursive: true })
    await fs.rename(srcAbs, dstAbs)
    delete meta[name]
    await this.writeTrashMeta(meta)
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

  pageIO(pagePath: string): CompilerIO {
    const root = this.requireRoot()
    const folderAbs = path.resolve(root, path.dirname(pagePath))
    const folderRel = path.relative(root, folderAbs)
    if (folderRel.startsWith('..') || path.isAbsolute(folderRel)) throw new Error('Page escapes vault: ' + pagePath)
    const within = (name: string): string => {
      const abs = path.resolve(folderAbs, name)
      const rel = path.relative(folderAbs, abs)
      if (rel.startsWith('..') || path.isAbsolute(rel)) throw new Error('Block path escapes page folder: ' + name)
      return abs
    }
    return {
      readFile: (n) => fs.readFile(within(n), 'utf8'),
      writeFile: (n, d) => this.atomicWrite(within(n), d),
      deleteFile: async (n) => { try { await fs.unlink(within(n)); this.lastWritten.delete(within(n)) } catch { /* gone */ } },
      exists: async (n) => { try { await fs.access(within(n)); return true } catch { return false } },
      listDir: async (rel) => { try { return await fs.readdir(rel ? within(rel) : folderAbs) } catch { return [] } },
      removeDir: async (rel) => { try { await fs.rm(within(rel), { recursive: true, force: true }) } catch { /* gone */ } },
    }
  }
}
