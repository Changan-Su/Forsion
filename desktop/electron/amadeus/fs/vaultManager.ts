// Owns the filesystem and the vault security boundary: path clamping, atomic writes,
// page discovery, and a self-write ledger so the watcher can ignore our own writes.

import { promises as fs } from 'node:fs'
import path from 'node:path'
import { dialog } from 'electron'
import type { CompilerIO } from '@amadeus-shared/compiler'
import { attachmentPaths } from './attachmentPaths'

export class VaultManager {
  private root: string | null = null
  private counter = 0
  /** absolutePath -> last content WE wrote, used to suppress echo events in the watcher. */
  private lastWritten = new Map<string, string>()

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

  /** All page (.md) files, vault-relative. */
  async listPages(): Promise<string[]> {
    return this.collectFiles((n) => n.endsWith('.md'))
  }

  /** All non-page files (attachments/.db/…), vault-relative — for the vault tree. */
  async listFiles(): Promise<string[]> {
    return this.collectFiles((n) => !n.endsWith('.md'))
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
  }

  /** Write a UTF-8 text file at a vault-relative path (clamped + atomic;供 .db 等非页面文件写回)。 */
  async writeTextFile(rel: string, text: string): Promise<void> {
    await this.atomicWrite(this.resolveInVault(rel), text)
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

  /** A collision-free filename inside `absDir` (adds "-1", "-2"… before the extension). */
  private async uniqueName(absDir: string, name: string): Promise<string> {
    const ext = path.extname(name)
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
  }

  /** Recursively remove a file or folder within the vault (never the root). */
  async removeEntry(rel: string): Promise<void> {
    const abs = this.resolveInVault(rel)
    if (abs === this.requireRoot()) throw new Error('Refusing to remove the vault root')
    await fs.rm(abs, { recursive: true, force: true })
    this.lastWritten.delete(abs)
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
        } catch {
          /* already gone */
        }
      },
    }
  }
}
