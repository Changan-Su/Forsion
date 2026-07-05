// 移植自 desktop/electron/amadeus/fs/vaultManager.ts。逻辑照搬,只换 IO:
//  node:fs → ./fsAdapter(Capacitor Filesystem);node:path → path-browserify;删 electron.dialog;
//  atomicWrite 直写(Android rename 不覆盖已存在文件,故不用 tmp+rename);process.platform→false。
// 虚拟绝对根 = '/vault'(见 mobileAmadeusBridge)。
import path from 'path-browserify'
import { fs, type Dirent } from './fsAdapter'
import type { CompilerIO } from '@amadeus-shared/compiler'
import { attachmentPaths } from './attachmentPaths'

export class VaultManager {
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

  async listPages(): Promise<string[]> { return this.collectFiles((n) => n.endsWith('.md')) }
  async listFiles(): Promise<string[]> { return this.collectFiles((n) => !n.endsWith('.md')) }

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
