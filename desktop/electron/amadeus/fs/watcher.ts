// Watches the vault for external page (.md) edits — e.g. Obsidian writing main.md.
// Dot-sidecars/manifests are ignored; our own writes are filtered via the self-write ledger.

import { promises as fs } from 'node:fs'
import path from 'node:path'
import chokidar, { type FSWatcher } from 'chokidar'
import type { SelfWrite, VaultManager } from './vaultManager'
import { isOverridableBuiltinType } from '@amadeus-shared/builtinTypes'

/** `ctx.app.watchFile` 能监听的文件类型白名单:只有文本配置类。见 handle() 里的说明。 */
const WATCHABLE_TEXT = /\.(js|mjs|cjs|json|jsonc|ya?ml|toml|txt|csv|tsv|css|html?|xml|ini|conf)$/i
/** 白名单内也设上限:再是文本文件,几十 MB 的 csv/json 也不该每次改动都整份读进主进程。 */
const WATCHABLE_MAX_BYTES = 2 * 1024 * 1024

export class VaultWatcher {
  private watcher: FSWatcher | null = null

  constructor(
    private readonly vault: VaultManager,
    private readonly onExternalPageChange: (pagePath: string) => void,
    private readonly onStructureChange: () => void,
    /** 外部对 `.db` 文件的内容改动(如 agent 直连磁盘改日历);桌面据此热重载 dbStore。 */
    private readonly onExternalDbChange?: (dbPath: string) => void,
    /** 外部对**其余**文件的内容改动(片段 `.js`、附件…);ctx.app.watchFile 的数据源。
     *  ⚠️只发 change,不发 add/unlink —— 那两类照旧由 onStructureChange 覆盖。 */
    private readonly onExternalFileChange?: (filePath: string) => void,
    private readonly onError?: (error: unknown) => void,
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
    if (this.onError) this.watcher.on('error', this.onError)
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
    // ⚠️其余文件必须先过白名单再读盘。ctx.app.watchFile 的用途是**文本配置**(插件片段库 .js、
    // 规则表 .json),而库里躺着的是图片/PDF/视频 —— 外部工具改写它们是常事,无条件
    // readFile('utf8') 会把整个文件拽进主进程内存,换一次注定被丢弃的比较(500MB 的视频被剪辑
    // 软件存一次盘 = 主进程读 500MB)。这里也不能靠「有没有人订阅」来省:回调是 ipc 无条件挂上的。
    // 例外:插件可接管的内置格式(目前只有 PDF)只报「变了」,**不读内容** —— 内置阅读器与接管它的插件
    // 各自重读。不读就没有上面那笔开销;也就没法按内容滤掉自写的回声,而宿主自己不写这类文件
    // (saveVaultBytes 本来就不记自写账本),没有要压掉的回声。
    if (isOverridableBuiltinType(abs)) {
      this.onExternalFileChange?.(path.relative(root, abs))
      return
    }
    const isWatchable = !isMd && !isDb && !!this.onExternalFileChange && WATCHABLE_TEXT.test(abs)
    if (!isMd && !isDb && !isWatchable) return
    let content = ''
    let seen: SelfWrite | undefined
    try {
      if (isWatchable) {
        const st = await fs.stat(abs)
        if (st.size > WATCHABLE_MAX_BYTES) return
      }
      // 读盘前先记下眼下那笔自写账:读到别人的内容时要作废的是它,不是读盘途中我们自己新记的那笔。
      seen = this.vault.selfWriteEntry(abs)
      content = await fs.readFile(abs, 'utf8')
    } catch {
      return
    }
    // Ignore the echo of our own atomic writes.
    if (this.vault.wasSelfWrite(abs, content, seen)) return
    if (isDb) this.onExternalDbChange?.(path.relative(root, abs))
    else if (isMd) this.onExternalPageChange(path.relative(root, abs))
    else this.onExternalFileChange?.(path.relative(root, abs))
  }

  stop(): void {
    void this.close()
  }

  /** Standalone plugin lifecycle awaits watcher shutdown before replacing a package. */
  async close(): Promise<void> {
    const watcher = this.watcher
    this.watcher = null
    await watcher?.close()
  }

  /** Used by a headless host before advertising its vault as ready. */
  ready(): Promise<void> {
    const watcher = this.watcher
    if (!watcher) return Promise.resolve()
    return new Promise((resolve, reject) => {
      const done = (): void => { watcher.off('error', fail); resolve() }
      const fail = (error: unknown): void => { watcher.off('ready', done); reject(error) }
      watcher.once('ready', done)
      watcher.once('error', fail)
    })
  }
}
