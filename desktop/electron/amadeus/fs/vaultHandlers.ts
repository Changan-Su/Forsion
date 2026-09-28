/** Filesystem-backed Amadeus operations shared by desktop IPC and standalone Unit RPC.
 * Host integration (dialogs, cloud identity, transport authentication) belongs to callers.
 */
import { promises as fs } from 'node:fs'
import { createHash } from 'node:crypto'
import path from 'node:path'
import { IPC, type DbReadResult, type DrawingReadResult, type PageProps } from '@amadeus-shared/ipc'
import { dbFileSchema, parseDb, serializeDb } from '@amadeus-shared/db/schema'
import { rewriteDbRefs } from '@amadeus-shared/db/rewriteDbRefs'
import { rewriteNoteRefs } from '@amadeus-shared/rewriteNoteRefs'
import { parseFmObject, setFmExtraOnSource } from '@amadeus-shared/db/pageFrontmatter'
import { extractFrontmatterExtra } from '@amadeus-shared/compiler/split'
import { loadPage, newPage, pageFileName, savePage, type PageManifest } from '@amadeus-shared/compiler'
import { findMarkLine } from '@amadeus-shared/mdMarks'
import { linkMentionInText } from '@amadeus-shared/linkIndex'
import type { VaultManager } from './vaultManager'
import type { VaultIndex } from './vaultIndex'
import { withDbLock } from './dbLock'
import { writeVaultText } from './pageWrite'
import { textFingerprint } from '@amadeus-shared/writeConflict'

const nowIso = (): string => new Date().toISOString()
function dbVersion(text: string): string {
  return createHash('sha1').update(text).digest('hex').slice(0, 16)
}

/** Unit 设备页(unitWeb /vault/*)拿到的本地 vault 面:同一套 handler,HTTP RPC 起源。 */
export interface VaultFace {
  /** origin = 远端客户端自报的 clientId(回声按 origin 判,不按路径时间窗——Codex P1)。 */
  call: (channel: string, args: unknown[], origin?: string | null) => Promise<unknown>
  onEvent: (cb: (channel: string, payload: unknown, origin: string | null) => void) => () => void
  assetAbs: (page: string | null, ref: string) => Promise<string | null>
  absPath: (rel: string) => string
  /** 当前 vault 根(远程 asset 面做 realpath 边界校验用);无库 = null。 */
  root: () => string | null
}

/** 写通道 → 回灌事件。isPagePath = VaultManager.isPagePath(笔记判据,插件文件类型 / 画板不算),
 *  **必传**:两个派发口(ipc.ts 的 handle 与 vaultFace.call)漏传就是类型错,不会静默退回旧映射。 */
export const VAULT_WRITE_EVENTS: Record<string, (a: unknown[], isPagePath: (rel: string) => boolean) => [string, unknown?]> = {
  [IPC.savePage]: (a) => [IPC.externalChange, a[0]],
  [IPC.setPageFrontmatter]: (a) => [IPC.externalChange, a[0]],
  // v4 笔记唯一的落盘通道就是它,而开着的 UnifiedPage 只听 externalChange:映射成 fileChange = 只进插件
  // watchFile,Unit 另一端写的改动本机编辑器永不回灌、下一击键整篇盖掉;反方向同理(评审 G1-04)。
  // 非笔记文件(按 isPagePath:插件片段、画板、插件自定义的 `.md` 文件类型)照旧 fileChange,进插件 watchFile。
  // ⚠️ 这与 watcher 的分流**不一样**:watcher 对一切 .md(含 .excalidraw.md / 插件 .mindmap.md)都发 externalChange,
  //    只有非 .md 才发 fileChange;这里按笔记判据分,插件自定义 .md 类型走 fileChange。
  [IPC.writeTextFile]: (a, isPagePath) => [typeof a[0] === 'string' && isPagePath(a[0]) ? IPC.externalChange : IPC.fileChange, a[0]],
  [IPC.drawingWrite]: (a) => [IPC.fileChange, a[0]],
  [IPC.saveVaultBytes]: (a) => [IPC.fileChange, a[0]],
  [IPC.dbWrite]: (a) => [IPC.dbChange, a[0]],
  [IPC.dbWriteCas]: (a) => [IPC.dbChange, a[0]],
  [IPC.newPage]: () => [IPC.structureChange],
  [IPC.deletePage]: () => [IPC.structureChange],
  [IPC.movePage]: () => [IPC.structureChange],
  [IPC.renamePage]: () => [IPC.structureChange],
  [IPC.createFolder]: () => [IPC.structureChange],
  [IPC.renameFolder]: () => [IPC.structureChange],
  [IPC.deleteFolder]: () => [IPC.structureChange],
  [IPC.moveFolder]: () => [IPC.structureChange],
  [IPC.trashEntry]: () => [IPC.structureChange],
  [IPC.restoreTrash]: () => [IPC.structureChange],
  [IPC.deleteTrashEntry]: () => [IPC.structureChange],
  [IPC.emptyTrash]: () => [IPC.structureChange],
  [IPC.renamePageFile]: () => [IPC.structureChange],
  [IPC.renameDbFile]: () => [IPC.structureChange],
  [IPC.saveAttachment]: () => [IPC.structureChange],
  [IPC.saveAsset]: () => [IPC.structureChange],
}

/** 比对交换写被拒(带 base 的 writeTextFile / dbWriteCas 回 `{ ok:false }`)= 什么都没写:派发口据此**不发**
 *  VAULT_WRITE_EVENTS 映射的回灌事件 —— 发了就是叫别的编辑器 / 设备去重读一份没变过的盘面(收口 N-9)。
 *  三个派发口共用这一份判据:ipc.ts 的 handle 与 vaultFace.call、unit/localVault 的 call。 */
export function casRejected(channel: string, result: unknown): boolean {
  return (channel === IPC.dbWriteCas || channel === IPC.writeTextFile) && (result as { ok?: unknown } | null | undefined)?.ok === false
}

export interface VaultHandlerDependencies {
  vault: VaultManager
  index: VaultIndex
  handle: (channel: string, fn: (event: unknown, ...args: any[]) => unknown) => void
  rememberPage: (page: string) => Promise<void>
  notifyAll: (channel: string, payload?: unknown) => void
  logActivity?: (action: 'file.save', data: { f: string }) => void
  logNoteEdit?: (page: string, before: string, after: string) => void
  /** 把一条回灌事件发给**除发起窗口以外**的本机窗口(G1-01 跨窗同篇)。origin = handler 收到的事件对象:
   *  渲染层 IPC 起源是真 IpcMainInvokeEvent(带 sender),Unit RPC 起源是 null(那条由 vaultFace.call 的
   *  VAULT_WRITE_EVENTS 映射负责,这里不插手)。缺省 = 不发(测试 / 无窗口宿主)。 */
  notifyPeers?: (origin: unknown, channel: string, payload?: unknown) => void
}

/** 同一路径的文本写串行化(进程内)。CAS 的「读→比对→写」中间有两次 await,两个窗口的 invoke
 *  会交错在它们之间 —— 两边都比对通过、先写的那份被后写的静默盖掉,等于没做 CAS。非 CAS 的写也进同一条
 *  链,免得一发盲写插在别人的比对与落盘之间。引擎是另一个进程,不在这把锁里(它的改动走 watcher → 回灌)。
 *  ⚠️ **同一篇 .md 的每一条读改写 / 写通道都得进这把锁,并且在锁内读**(Codex g3#2):setPageFrontmatter、patchMark、
 *  改名引用重写这些「读全文 → 改一处 → 整篇写回」若在锁外,读到旧全文后编辑器的 CAS 写照样比对通过、回 ok:true,
 *  随后旧正文连同补丁写回 → 编辑器刚落盘的新正文静默丢失。不可重入:只在最底层那段「读→改→写」上锁,
 *  别把一个会再去拿锁的 helper 整个包进来。 */
const textWriteChains = new Map<string, Promise<unknown>>()
function withTextWriteLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const prev = textWriteChains.get(key) ?? Promise.resolve()
  const run = prev.then(fn, fn)
  const tail = run.catch(() => {})
  textWriteChains.set(key, tail)
  void tail.then(() => { if (textWriteChains.get(key) === tail) textWriteChains.delete(key) })
  return run
}

export function registerVaultHandlers(deps: VaultHandlerDependencies): void {
  const { vault, index, handle, rememberPage, notifyAll } = deps
  const logActivity = deps.logActivity ?? (() => {})
  const logNoteEdit = deps.logNoteEdit ?? (() => {})
  /** 按 vault 相对路径拿同篇写锁(键 = 绝对路径,各种写法归一)。越界 / 无库时 absPath 会抛:那就不上锁直接跑,
   *  fn 里照旧撞上同一个错误(或按原语义静默跳过)—— 行为与没加锁前逐字一致。 */
  const withPathLock = <T>(rel: string, fn: () => Promise<T>): Promise<T> => {
    let key: string
    try { key = vault.absPath(rel) } catch { return fn() }
    return withTextWriteLock(key, fn)
  }
  handle(IPC.listPages, () => vault.listPages())
  handle(IPC.listFiles, () => vault.listFiles())

  handle(IPC.loadPage, async (_e, pagePath: string) => {
    const page = await loadPage(vault.pageIO(pagePath), pagePath, nowIso(), { createIfMissing: false })
    await rememberPage(pagePath)
    return page
  })

  // 只读加载(模板读取等):不写 lastPage,不当成「打开」;文件不存在直接报错——
  // 编译器 loadPage 缺文件会 newPage 落盘,只读语义下不允许悄悄造文件。
  handle(IPC.readPage, async (_e, pagePath: string) => {
    const io = vault.pageIO(pagePath)
    return loadPage(io, pagePath, nowIso(), { createIfMissing: false })
  })

  handle(IPC.newPage, async (_e, pagePath: string) => {
    const page = await newPage(vault.pageIO(pagePath), pagePath, nowIso())
    await rememberPage(pagePath)
    await index.update(pagePath)
    return page
  })

  handle(
    IPC.savePage,
    async (_e, pagePath: string, manifest: PageManifest, contents: Record<string, string>) =>
      withPathLock(pagePath, async () => {
        const io = vault.pageIO(pagePath)
        // 活动日志 note.edit:保存前后各读一次盘算行差(文件小,开销可忽略;失败不阻断保存)。
        const oldText = await io.readFile(pageFileName(pagePath)).catch(() => '')
        await savePage(io, pagePath, manifest, { contents })
        await index.update(pagePath)
        try {
          const newText = await io.readFile(pageFileName(pagePath))
          logNoteEdit(pagePath, String(oldText ?? ''), String(newText ?? ''))
        } catch { /* 装饰性数据 */ }
      }),
  )

  /** 改名/移动后的全库引用重写(renameDbFile 同款先例):快照「操作前」页面表,物理移动完成后
   *  逐页跑纯函数 rewriteNoteRefs,判定「解析目标变了」才动笔;改动页原子写 + 更索引 +
   *  externalChange 回灌(打开着的编辑器由既有回灌机制接住)。
   *  ponytail: 朴素全库读扫,与 backlinks 同一量级,个人 vault 规模足够。 */
  const propagateRenames = async (pairsIn: Record<string, string>, pagesBefore: string[]): Promise<void> => {
    const pairs = new Map(Object.entries(pairsIn))
    if (!pairs.size) return
    const backMap = new Map([...pairs].map(([o, n]) => [n, o]))
    const before = [...pagesBefore].sort()
    const after = before.map((p) => pairs.get(p) ?? p).sort()
    for (const p of after) {
      const changed = await withPathLock(p, async () => {
        let raw: string
        try {
          raw = await fs.readFile(vault.absPath(p), 'utf8')
        } catch {
          return false
        }
        const next = rewriteNoteRefs(raw, backMap.get(p) ?? p, p, { pairs, pagesBefore: before, pagesAfter: after })
        if (next === raw) return false
        await vault.writeTextFile(p, next)
        await index.update(p)
        return true
      })
      if (changed) notifyAll(IPC.externalChange, p)
    }
  }

  /** 文件夹改名/移动 → 树下每一页一对 old→new(引用重写按页粒度进行)。 */
  const folderPairs = (pages: string[], oldFolder: string, newFolder: string): Record<string, string> => {
    const pre = `${oldFolder}/`
    const out: Record<string, string> = {}
    for (const p of pages) if (p.startsWith(pre)) out[p] = `${newFolder}/${p.slice(pre.length)}`
    return out
  }

  handle(
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
      const pagesBefore = await vault.listPages() // 引用重写要的「操作前」快照,须在移动前取
      await withPathLock(oldPath, () => savePage(vault.pageIO(oldPath), oldPath, manifest, { contents }))
      await vault.moveEntry(oldPath, newPath)
      await index.rename(oldPath, newPath)
      await rememberPage(newPath)
      await propagateRenames({ [oldPath]: newPath }, pagesBefore) // 先重写再 loadPage:自链接也进返回值
      const page = await loadPage(vault.pageIO(newPath), newPath, nowIso())
      return { newPath, page }
    },
  )

  handle(
    IPC.reconcilePage,
    async (_e, pagePath: string, _prevManifest: PageManifest, _prevContents: Record<string, string>) => {
      // v3 is single-file: an external edit just reloads (the .md is the single source).
      const page = await loadPage(vault.pageIO(pagePath), pagePath, nowIso(), { createIfMissing: false })
      await index.update(pagePath)
      return page
    },
  )

  handle(
    IPC.saveAsset,
    (_e, pagePath: string, fileName: string, bytes: Uint8Array) =>
      vault.writeAsset(pagePath, fileName, bytes),
  )

  handle(IPC.saveVaultBytes, async (_e, filePath: string, bytes: Uint8Array) => {
    await vault.writeVaultBytes(filePath, bytes)
    logActivity('file.save', { f: filePath })
  })

  handle(IPC.readVaultBytes, (_e, filePath: string) => vault.readVaultBytes(filePath))

  handle(
    IPC.saveAttachment,
    async (_e, pagePath: string, fileName: string, bytes: Uint8Array, opts: { mode: 'attachments' | 'same' | 'vault'; folder: string }) => {
      const r = await vault.writeAttachment(pagePath, fileName, bytes, opts)
      // 活动日志:附件/非 md 文件落盘;.db 跳过(renderer 已记 base.create,免重复)。
      if (!/\.db$/i.test(fileName || '')) logActivity('file.save', { f: fileName })
      return r
    },
  )

  // Database(.db JSON):read 按 ref 解析(与附件同一 basename 语义),write 按 read 返回的精确相对路径。
  handle(IPC.dbRead, async (_e, pagePath: string, ref: string): Promise<DbReadResult> => {
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
      ? { status: 'ok', path: rel, data: r.data, version: dbVersion(text) }
      : { status: 'corrupt', path: rel, message: r.error }
  })

  handle(IPC.dbWrite, async (_e, dbPath: string, data: unknown) => {
    const parsed = dbFileSchema.parse(data) // 防御性校验:坏数据拒写,绝不落半截文件
    await vault.writeTextFile(dbPath, serializeDb(parsed))
  })

  // 比对交换写:baseVersion 与磁盘现状不符就**不写**,把最新 version 回给渲染端去重载+重放。
  // 目标是那条真实竞态 —— 渲染端 500ms 防抖握着旧快照落盘,把这期间引擎/自动化加的行整个抹掉
  // (反向亦然:引擎读改写覆盖用户刚敲的格子)。写本身仍走 vault 的原子 tmp+rename。
  //
  // 「读→比对→写」这三步**在本进程内**是原子的(单线程,中间没有 await 让给别的 handler),
  // 但引擎是另一个进程 —— 它完全可以插在比对与写之间。所以整段再裹一层跨进程锁,
  // 与引擎 `mutateDb` 用的是同一个锁文件(见 dbLock.ts 里的路径约定)。
  handle(IPC.dbWriteCas, async (_e, dbPath: string, data: unknown, baseVersion: string) => {
    const parsed = dbFileSchema.parse(data)
    try {
      return await withDbLock(vault.absPath(dbPath), async () => {
        let cur = ''
        try { cur = Buffer.from(await vault.readVaultBytes(dbPath)).toString('utf8') } catch { cur = '' } // 文件不在=新建,视为无冲突
        const curVersion = cur ? dbVersion(cur) : ''
        if (cur && curVersion !== baseVersion) return { ok: false, version: curVersion }
        const text = serializeDb(parsed)
        await vault.writeTextFile(dbPath, text)
        return { ok: true, version: dbVersion(text) }
      })
    } catch (e) {
      // 拿不到锁(对方持锁超过 5s)= 当作一次冲突回给渲染端:它会重读磁盘、重放 pendingOps、再写。
      // 这正是既有的冲突通道,不必新开一条错误路径;**绝不能**因为锁没拿到就直接写下去。
      console.warn('[amadeus] db:write-cas 未能取得跨进程锁,按冲突处理:', (e as Error)?.message)
      let cur = ''
      try { cur = Buffer.from(await vault.readVaultBytes(dbPath)).toString('utf8') } catch { cur = '' }
      return { ok: false, version: cur ? dbVersion(cur) : '' }
    }
  })

  // Excalidraw 画板(`.excalidraw.md`,Obsidian 插件同款格式;裸 `.excalidraw` 也认)。
  // 只搬字节:解析/序列化是纯函数,在渲染端与编辑器同侧(见 shared/amadeus/excalidraw)。
  handle(IPC.drawingRead, async (_e, pagePath: string, ref: string): Promise<DrawingReadResult> => {
    // Obsidian 链接省略 .md:`![[Foo.excalidraw]]` 实指 `Foo.excalidraw.md` → 原样先试,落空再补 .md。
    const abs =
      (await vault.resolveAttachment(pagePath, ref)) ?? (await vault.resolveAttachment(pagePath, `${ref}.md`))
    const root = vault.getRoot()
    if (!abs || !root) return { status: 'missing' }
    try {
      return { status: 'ok', path: path.relative(root, abs), source: await fs.readFile(abs, 'utf8') }
    } catch {
      return { status: 'missing' }
    }
  })

  // 必须走 writeTextFile 而非 saveVaultBytes:后者不记自写账本,而 .excalidraw.md 命中 watcher 的
  // `.md` 分支 → 每次自动保存都会被当成外部改动回弹。
  handle(IPC.drawingWrite, (_e, drawingPath: string, source: string) =>
    withPathLock(drawingPath, () => vault.writeTextFile(drawingPath, source)))

  // 通用 vault 文本读写(插件文件类型:ctx.app.readFile/writeFile)。读越界即 null;
  // 写同 drawingWrite 走 writeTextFile(记自写账本,插件保存不被 watcher 当外部改动回弹)。
  handle(IPC.readTextFile, async (_e, filePath: string): Promise<string | null> => {
    if (!vault.getRoot()) return null
    try {
      return await fs.readFile(vault.absPath(filePath), 'utf8')
    } catch {
      return null
    }
  })
  handle(IPC.writeTextFile, async (e, filePath: string, text: string, opts?: { create?: boolean; base?: string }) => {
    const base = typeof opts?.base === 'string' ? opts.base : null // create 是云桥的语义,本地写盘不区分
    return withPathLock(filePath, async () => {
      if (base != null) {
        // 比对交换写(G1-01):盘上已不是调用方的基线 → 不写,把现文交回去(回灌 / 冲突副本由渲染层定)。
        // 文件不在 = 无冲突(与 dbWriteCas 同口径:删了再写 = 重建,不是覆盖别人)。
        // ⚠️ 只有 ENOENT 才算「不在」(Codex g3#4):文件读不了(EACCES / EIO / EISDIR…)而目录可写时,原子 rename
        //    照样盖得掉它 —— 基线没验证就丢了盘上版本。其余读错原样抛出:渲染层按写失败处理(提示 + 退避重试)。
        let cur: string | null = null
        try {
          cur = await fs.readFile(vault.absPath(filePath), 'utf8')
        } catch (err) {
          if ((err as NodeJS.ErrnoException | null)?.code !== 'ENOENT') throw err
          cur = null
        }
        if (cur != null && textFingerprint(cur) !== base) return { ok: false as const, current: cur }
      }
      // ⚠️ 必须走 writeVaultText:这是 **v4/unified 笔记唯一的落盘通道**,只写盘不更索引的话
      //    图标/搜索/反链/tags 全部停在上次启动时的样子(见 pageWrite.ts 顶注)。
      await writeVaultText(vault, index, filePath, text)
      // 同篇开在别的窗口:自写账本把 watcher 的回声压掉了(整个进程一本账),不补这一声它们永远停在旧内容,
      // 下一次保存再把这次写的整篇盖掉。发起窗口不回发 —— 它自己的同窗实例由渲染层 lifecycle 通知。
      // Unit RPC 起源(e = null)不走这里:它的本机广播由 vaultFace.call 按 VAULT_WRITE_EVENTS 负责。
      if (e != null && vault.isPagePath(filePath)) deps.notifyPeers?.(e, IPC.externalChange, filePath)
      return base != null ? { ok: true as const } : undefined
    })
  })

  // 「笔记视图」(Bases):行 = 目标文件夹直属笔记,frontmatter 是唯一真源。
  handle(IPC.listPageProps, async (_e, folder: string): Promise<PageProps[]> => {
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

  // 读改写整段在同篇路径锁内(Codex g3#2):锁外读到的旧全文会把编辑器刚 CAS 写入的新正文整篇盖回去。
  handle(IPC.setPageFrontmatter, (e, pagePath: string, patch: Record<string, unknown>) =>
    withPathLock(pagePath, async () => {
      let raw: string
      try {
        raw = await fs.readFile(vault.absPath(pagePath), 'utf8')
      } catch {
        return // 笔记不在(已被删)→ 静默跳过
      }
      const next = setFmExtraOnSource(raw, patch)
      if (next === raw) return
      await vault.writeTextFile(pagePath, next) // 原子写 + 自写账本 → watcher 不回声
      await index.update(pagePath)
      // 评审 G1-05:自写账本把 watcher 的回声压掉了,别的窗口开着这篇的 v4 实例就停在旧 fm,下一次击键把刚改的属性
      // 整篇写回旧值。与 writeTextFile 同口径补发给发起窗口以外的窗口;发起窗口自己的实例由渲染层直接走实例的 fm
      // 写口(lifecycle.unifiedPatchFm),根本不走到这条外科写。
      if (e != null && vault.isPagePath(pagePath)) deps.notifyPeers?.(e, IPC.externalChange, pagePath)
    }))

  handle(IPC.renamePageFile, async (_e, oldPath: string, newBaseName: string): Promise<string> => {
    const dir = path.dirname(oldPath)
    let base = newBaseName.trim().replace(/[\\/]/g, '')
    if (!base) throw new Error('笔记名不能为空')
    if (base.toLowerCase().endsWith('.md')) base = base.slice(0, -3)
    const newPath = dir === '.' ? `${base}.md` : `${dir}/${base}.md`
    if (newPath === oldPath) return oldPath
    if (await vault.pathExists(newPath)) throw new Error('目标笔记已存在')
    const pagesBefore = await vault.listPages()
    await vault.moveEntry(oldPath, newPath) // 纯移动:不落 v3,外来 .md 不被收编
    index.remove(oldPath)
    await index.update(newPath)
    await propagateRenames({ [oldPath]: newPath }, pagesBefore)
    return newPath
  })

  handle(IPC.renameDbFile, async (_e, oldPath: string, newBaseName: string): Promise<{ newPath: string; rewrittenPages: string[] }> => {
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
      const parsed = parseDb(await fs.readFile(vault.absPath(newPath), 'utf8'))
      if (parsed.ok && parsed.data.name !== base) {
        await vault.writeTextFile(newPath, serializeDb({ ...parsed.data, name: base }))
      }
    } catch { /* corrupt: 跳过 name 同步 */ }

    // 引用重写(纯函数 rewriteDbRefs,规则见其注释)。
    // ponytail: 朴素全库扫描,个人 vault 规模足够;[名](rel.db) 形式的 md 链接 v1 不重写。
    const rewrittenPages: string[] = []
    for (const p of await vault.listPages()) {
      const pRel = norm(p)
      const changed = await withPathLock(p, async () => {
        let raw: string
        try { raw = await fs.readFile(vault.absPath(p), 'utf8') } catch { return false }
        const next = rewriteDbRefs(raw, { oldRel, newBase: `${base}.db`, pageDir: path.posix.dirname(pRel) })
        if (next === raw) return false
        await vault.writeTextFile(p, next)
        await index.update(p)
        return true
      })
      if (changed) {
        notifyAll(IPC.externalChange, p)
        rewrittenPages.push(p)
      }
    }

    // 关联表列(rowlink)的 refDb 存的是 vault 相对路径:别的 .db 指向本表的,一并迁移,
    // 否则改个名整列 chip 变「已失联」、lookup 全空(codex 抓的)。同一趟朴素全库扫描。
    for (const f of await vault.listFiles()) {
      const fRel = norm(f)
      if (!/\.db$/i.test(fRel) || fRel === newPath) continue
      let parsed: ReturnType<typeof parseDb>
      try { parsed = parseDb(await fs.readFile(vault.absPath(fRel), 'utf8')) } catch { continue }
      if (!parsed.ok) continue
      let hit = false
      const columns = parsed.data.columns.map((c) => {
        if (c.refDb && norm(c.refDb) === oldRel) { hit = true; return { ...c, refDb: newPath } }
        return c
      })
      if (!hit) continue
      await vault.writeTextFile(fRel, serializeDb({ ...parsed.data, columns }))
      notifyAll(IPC.dbChange, fRel)
    }
    return { newPath, rewrittenPages }
  })

  handle(IPC.search, (_e, query: string) => index.search(query))
  handle(IPC.backlinks, (_e, pagePath: string) => index.backlinks(pagePath))
  handle(IPC.exclusiveAssets, (_e, pagePath: string) => index.exclusiveAssets(pagePath))
  handle(IPC.reindex, () => index.build())
  handle(IPC.listTags, () => index.listTags())
  handle(IPC.listMarks, () => index.marks())
  /** 改写一条 `@` 标记所在的整行(待办就地勾、日历拖动改期)。
   *  定位**按内容**(raw + 同文行序号),不按行号 —— 行号是清洗文本的坐标系。找不到就返回 false,
   *  由渲染层退回「跳到笔记里改」;**绝不模糊匹配**,宁可改不动也不能改错行。
   *  写盘 → 更索引 → externalChange 广播,与 propagateRenames / renameDbFile 同一条既有路子。 */
  handle(IPC.patchMark, async (_e, pagePath: string, raw: string, occ: number, next: string) => {
    if (!vault.isPagePath(pagePath)) return false
    // 读改写在同篇路径锁内(Codex g3#2,同 setPageFrontmatter);广播放到锁外。
    const wrote = await withPathLock(pagePath, async (): Promise<boolean | null> => {
      let text: string
      try { text = await fs.readFile(vault.absPath(pagePath), 'utf8') } catch { return false }
      const at = findMarkLine(text, raw, occ)
      if (at < 0) return false
      const eol = text.includes('\r\n') ? '\r\n' : '\n'
      const lines = text.split(/\r?\n/)
      if (lines[at] === next) return null // 幂等:拖回原位不写盘、不惊动打开着的编辑器
      lines[at] = next
      await writeVaultText(vault, index, pagePath, lines.join(eol))
      return true
    })
    if (wrote === false) return false
    if (wrote) notifyAll(IPC.externalChange, pagePath)
    return true
  })
  handle(IPC.pagesByTag, (_e, tag: string) => index.pagesByTag(tag))

  handle(IPC.listFolders, () => vault.listFolders())

  handle(IPC.resolveEmbed, (_e, target: string) => {
    // The inline index already holds each block's content + owning note.
    const hit = index.resolveBlock(target)
    return hit ? { owner: hit.path, content: hit.content, type: hit.type } : null
  })

  handle(IPC.blockBacklinks, (_e, target: string) => index.blockBacklinks(target))

  handle(IPC.deletePage, async (_e, pagePath: string) => {
    await vault.removeEntry(pagePath) // v3: a note is a single .md
    index.remove(pagePath)
  })

  handle(IPC.movePage, async (_e, pagePath: string, destFolder: string) => {
    const fileName = pageFileName(pagePath)
    const dstRel = destFolder.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '')
    const newPath = dstRel ? `${dstRel}/${fileName}` : fileName
    if (newPath === pagePath) return pagePath
    if (await vault.pathExists(newPath)) throw new Error('目标位置已存在同名文件')
    const pagesBefore = newPath.endsWith('.md') ? await vault.listPages() : []
    await vault.moveEntry(pagePath, newPath)
    // 树里的附件(非 .md)也走本通道移动:不进索引(index.update 会把二进制按 utf8 读成巨串)、不记 lastPage。
    if (newPath.endsWith('.md')) {
      index.remove(pagePath)
      await index.update(newPath)
      await rememberPage(newPath)
      await propagateRenames({ [pagePath]: newPath }, pagesBefore)
    }
    return newPath
  })

  handle(IPC.createFolder, async (_e, parentFolder: string, name: string) => {
    const clean = name.trim().replace(/[\\/]/g, '')
    if (!clean) throw new Error('文件夹名不能为空')
    const parent = parentFolder.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '')
    const rel = parent ? `${parent}/${clean}` : clean
    if (await vault.pathExists(rel)) throw new Error('同名文件夹已存在')
    await vault.makeDir(rel)
    return rel
  })

  handle(IPC.renameFolder, async (_e, folderPath: string, newName: string) => {
    const clean = newName.trim().replace(/[\\/]/g, '')
    if (!clean) throw new Error('文件夹名不能为空')
    const parentDir = path.dirname(folderPath)
    const parentRel = parentDir === '.' ? '' : parentDir
    const newPath = parentRel ? `${parentRel}/${clean}` : clean
    if (newPath === folderPath) return folderPath
    if (await vault.pathExists(newPath)) throw new Error('同名文件夹已存在')
    const pagesBefore = await vault.listPages()
    await vault.moveEntry(folderPath, newPath)
    await index.build()
    await propagateRenames(folderPairs(pagesBefore, folderPath, newPath), pagesBefore)
    return newPath
  })

  handle(IPC.deleteFolder, async (_e, folderPath: string) => {
    await vault.removeEntry(folderPath)
    await index.build()
  })

  handle(IPC.moveFolder, async (_e, folderPath: string, destFolder: string) => {
    const src = folderPath.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '')
    const name = src.split('/').pop()
    if (!name) throw new Error('文件夹路径不能为空')
    const dst = destFolder.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '')
    const newPath = dst ? `${dst}/${name}` : name
    if (newPath === src) return src
    if (dst === src || dst.startsWith(`${src}/`)) throw new Error('不能移动到自身内部')
    if (await vault.pathExists(newPath)) throw new Error('目标位置已存在同名文件夹')
    const pagesBefore = await vault.listPages()
    await vault.moveEntry(src, newPath)
    await index.build()
    await propagateRenames(folderPairs(pagesBefore, src, newPath), pagesBefore)
    return newPath
  })

  // ── 回收站:移入/列出/恢复/彻底删/清空(.trash 点目录对扫描天然隐身,动索引的只有移入与恢复) ──
  handle(IPC.trashEntry, async (_e, rel: string) => {
    await vault.trashEntry(rel)
    await index.build()
  })
  handle(IPC.listTrash, async () => vault.listTrash())
  handle(IPC.restoreTrash, async (_e, name: string) => {
    const restored = await vault.restoreTrash(name)
    await index.build()
    return restored
  })
  handle(IPC.deleteTrashEntry, async (_e, name: string) => vault.deleteTrashEntry(name))
  handle(IPC.emptyTrash, async () => vault.emptyTrash())
  handle(IPC.pageIcons, () => index.pageIcons())
  handle(IPC.pageAliases, () => index.pageAliases())
  handle(IPC.unlinkedMentions, (_e, pagePath: string) => index.unlinkedMentions(pagePath))
  /** 未链接提及 → `[[inner]]`(L-16):按内容定位(同 patchMark),对不上返回 false 不写;写盘 → 更索引 → externalChange 广播。 */
  handle(IPC.linkMention, async (_e, pagePath: string, hit: { raw: string; occ: number; col: number; match: string }, inner: string) => {
    if (!vault.isPagePath(pagePath)) return false
    const wrote = await withPathLock(pagePath, async (): Promise<boolean> => {
      let text: string
      try { text = await fs.readFile(vault.absPath(pagePath), 'utf8') } catch { return false }
      const next = linkMentionInText(text, hit, inner)
      if (next === null || next === text) return false
      await writeVaultText(vault, index, pagePath, next)
      return true
    })
    if (wrote) notifyAll(IPC.externalChange, pagePath)
    return wrote
  })
}
