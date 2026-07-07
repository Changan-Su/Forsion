// Watches the vault for external page (.md) edits — e.g. Obsidian writing main.md.
// Dot-sidecars/manifests are ignored; our own writes are filtered via the self-write ledger.

import { promises as fs } from 'node:fs'
import path from 'node:path'
import chokidar, { type FSWatcher } from 'chokidar'
import type { VaultManager } from './vaultManager'

export class VaultWatcher {
  private watcher: FSWatcher | null = null

  constructor(
    private readonly vault: VaultManager,
    private readonly onExternalPageChange: (pagePath: string) => void,
    private readonly onStructureChange: () => void,
    /** 外部对 `.db` 文件的内容改动(如 agent 直连磁盘改日历);桌面据此热重载 dbStore。 */
    private readonly onExternalDbChange?: (dbPath: string) => void,
  ) {}

  start(root: string): void {
    this.stop()
    this.watcher = chokidar.watch(root, {
      ignoreInitial: true,
      depth: 12,
      ignored: (p: string) => {
        const base = path.basename(p)
        // `.tmp-<pid>-<ts>-<n>` = vaultManager.atomicWrite 的自写临时文件:add/unlink 对非 .md 也发
        // structureChange 后,不滤掉它会让每次自动保存都触发全库重索引+左栏刷新(Linux/Win 实测)。
        return base.startsWith('.') || base === 'node_modules' || /\.tmp-\d+-\d+-\d+$/.test(base)
      },
    })
    this.watcher.on('change', (abs) => {
      void this.handle(abs, root)
    })
    // Files/folders added or removed (pages AND attachments — the vault tree shows all files)
    // → let the app refresh its tree + index. Debounced by the caller.
    for (const ev of ['add', 'unlink', 'addDir', 'unlinkDir'] as const) {
      this.watcher.on(ev, () => this.onStructureChange())
    }
  }

  private async handle(abs: string, root: string): Promise<void> {
    const isMd = abs.endsWith('.md')
    const isDb = abs.endsWith('.db')
    if (!isMd && !isDb) return
    let content = ''
    try {
      content = await fs.readFile(abs, 'utf8')
    } catch {
      return
    }
    // Ignore the echo of our own atomic writes.
    if (this.vault.wasSelfWrite(abs, content)) return
    if (isDb) this.onExternalDbChange?.(path.relative(root, abs))
    else this.onExternalPageChange(path.relative(root, abs))
  }

  stop(): void {
    if (this.watcher) {
      void this.watcher.close()
      this.watcher = null
    }
  }
}
