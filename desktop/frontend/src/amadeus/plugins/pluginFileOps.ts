/**
 * ctx.app.createFolder / stat / renamePath / movePath(2026-11-16,移植 Obsidian Templater 时缺的三块)。
 *
 * 不另造写路:改名 / 挪动一律走文件树那几条链(笔记 = amadeus/lib/noteRename、.db = dbFileOps.renameDb、
 * 挪笔记与附件 = pageStore.movePage、文件夹 = pageStore.renameFolder / moveFolder),全库引用重写、开着的编辑器跟随、
 * .fd 级联都由它们负责。那几条为了给界面兜底把失败吞进 store.error,插件要的是结果:做完按刷新后的清单再判一次,
 * 没到位就 reject(同 ctx.app.trash)。
 *
 * 边界(用户定):源路径在插件自己的工作文件夹**里面**,或在它这一程建的账本里(pluginCreated.ts)→ 直接做;
 * 别的先用宿主确认框问用户(允许 / 取消),取消 → reject Error('user_declined')。
 * 确认框不在串行队列里(可能挂几分钟);点了允许之后在队列里把源、目标、库、插件存活重核一遍。
 * 信任模型照旧是「只装可信插件」:插件和宿主同一个渲染进程,这道确认是防手滑与误操作,不是沙箱。
 */
import { registerMessages, translate } from '../../i18n'
import { amadeus } from '../api'
import { onNotePathGone, remapScopePaths, usePageStore } from '../store/pageStore'
import { isDrawingPath } from '../../../../shared/amadeus/excalidraw/format'
import { isDashboardPath } from '../../../../shared/amadeus/dashboard'
import { normalizePluginRename } from './pluginExt'
import { followCreatedPath, isPluginCreated, markPluginCreated } from './pluginCreated'
import type { PluginAppApi } from './types'

registerMessages({
  'pluginfileops.rename': { zh: '「{plugin}」想把「{from}」改名为「{to}」。', en: '{plugin} wants to rename “{from}” to “{to}”.' },
  'pluginfileops.move': { zh: '「{plugin}」想把「{from}」移到「{to}」。', en: '{plugin} wants to move “{from}” to “{to}”.' },
  'pluginfileops.moveToRoot': { zh: '「{plugin}」想把「{from}」移到智库根目录。', en: '{plugin} wants to move “{from}” to the vault root.' },
  'pluginfileops.allow': { zh: '允许', en: 'Allow' },
})

const toSlash = (p: string): string => p.replace(/\\/g, '/')

/** 插件给的库内路径 → `/` 分隔、去首尾斜杠;`.` / `..` / 空段、盘符一律拒(越界)。不修空白(同 trash)。
 *  allowRoot:'' = 库根(stat / createFolder / movePath 的目标可以是它)。 */
export function cleanVaultPath(p: unknown, allowRoot = false): string {
  if (typeof p !== 'string') throw new TypeError('Expected a vault-relative path string')
  const rel = toSlash(p).replace(/^\/+|\/+$/g, '')
  if (!rel) {
    if (allowRoot) return ''
    throw new Error('Expected a path inside the vault, not the vault root')
  }
  if (/^[a-zA-Z]:/.test(rel) || rel.split('/').some((s) => !s || s === '.' || s === '..')) {
    throw new Error(`Path escapes the vault: ${p}`)
  }
  return rel
}

/** 新名字:不带分隔符、非空、首尾没有空白(桥会悄悄修掉,修完就不是插件要的那个名字了)、不以 `.` 开头
 *  (点开头的文件树清单看不见:改完核不到结果,用户也找不着)。 */
export function cleanNewName(n: unknown): string {
  if (typeof n !== 'string') throw new TypeError('Expected a new name string')
  if (!n || n.trim() !== n || /[\\/]/.test(n) || n.startsWith('.')) throw new Error(`Invalid name: "${n}"`)
  return n
}

/** 在工作文件夹**里面**(不含它自己:改工作文件夹本身的名字会让插件设置指空)。 */
export function insideWorkFolder(path: string, workFolder: string): boolean {
  const wf = toSlash(workFolder).replace(/^\/+|\/+$/g, '')
  return !!wf && path.startsWith(`${wf}/`)
}

/** 边界:工作文件夹里面,或这一程这个插件建的。 */
export function pluginOwnsPath(pluginId: string, path: string, workFolder: string): boolean {
  return insideWorkFolder(path, workFolder) || isPluginCreated(pluginId, path)
}

const dirOf = (p: string): string => (p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '')
const nameOf = (p: string): string => p.slice(p.lastIndexOf('/') + 1)
const join = (dir: string, name: string): string => (dir ? `${dir}/${name}` : name)

/** 文件「是哪一种」:改名不许换种类(白板 / 仪表盘 / 插件复合后缀被改成普通笔记,下次会被当笔记打开写坏)。 */
function kindKey(path: string, fileTypeExt: (p: string) => string | null): string {
  const ext = /\.md$/i.test(path) ? fileTypeExt(path) : null
  if (ext) return `type:${ext.toLowerCase()}`
  if (isDrawingPath(path)) return 'drawing'
  if (isDashboardPath(path)) return 'dashboard'
  if (/\.md$/i.test(path)) return 'note'
  if (/\.db$/i.test(path)) return 'db'
  return 'other'
}

type RenamePlan = { to: string; run: (raw: string) => Promise<unknown> }

/** 改名目标(纯函数部分,给单测):folder = 原名换掉;.db 补回 `.db`;复合后缀(插件类型 / 白板 / 仪表盘)缺了补回;
 *  普通笔记补回 `.md`。改完种类变了或这种文件文件树也改不了 → 抛。 */
export function renameTarget(path: string, isFolder: boolean, newName: string, fileTypeExt: (p: string) => string | null): string {
  const dir = dirOf(path)
  if (isFolder) return join(dir, newName)
  const kind = kindKey(path, fileTypeExt)
  let to: string
  if (kind === 'db') to = join(dir, `${newName.replace(/\.db$/i, '')}.db`)
  else if (kind === 'note') to = join(dir, `${newName.replace(/\.md$/i, '')}.md`)
  else if (kind === 'drawing' || kind === 'dashboard' || kind.startsWith('type:')) {
    const ext = kind === 'drawing' ? '.excalidraw.md' : kind === 'dashboard' ? '.dashboard.md' : kind.slice(5)
    // 白板也有裸 `.excalidraw`(不带 .md)、插件也有不以 .md 结尾的后缀:文件树改不了(renamePageFile 恒补 .md)
    if (!/\.md$/i.test(path) || !path.toLowerCase().endsWith(ext.toLowerCase())) throw new Error(`Renaming this kind of file is not supported: ${path}`)
    to = join(dir, `${normalizePluginRename(newName, ext)}.md`)
  } else throw new Error(`Renaming this kind of file is not supported: ${path}`)
  if (kindKey(to, fileTypeExt) !== kind) throw new Error(`Renaming cannot change the file type: ${path} → ${to}`)
  return to
}

// ── 串行队列:树上整批拖放也是一项收尾再下一项(amadeusViews dropTo 的注释)——并发的结构操作会让早到的目录刷新
//    盖掉后一项的结果、同时重写同步注册表。插件很可能 Promise.all 一把,这里替它排好。全宿主共用一条。 ──
let queue: Promise<unknown> = Promise.resolve()
function serial<T>(task: () => Promise<T>): Promise<T> {
  const run = queue.then(task, task)
  queue = run.catch(() => {})
  return run
}

type Entry = { folder: boolean; raw: string }
const st = () => usePageStore.getState()
/** 清单里的原样字符串才是仓库动作认的键(Windows 上主进程给的是 `\`)。 */
function lookup(rel: string): Entry | null {
  const s = st()
  const hit = (list: string[]): string | undefined => list.find((x) => toSlash(x) === rel)
  const folder = hit(s.folders)
  if (folder !== undefined) return { folder: true, raw: folder }
  const file = hit(s.pages) ?? hit(s.files)
  return file !== undefined ? { folder: false, raw: file } : null
}
const exists = (rel: string): boolean => rel === '' || lookup(rel) !== null
/** 夹里有 .db 的文件夹不改名、不挪:别的表里指向它们的关联列(refDb 存库内路径)与日历设置只在 .db 本身改名时迁移,
 *  文件夹那两条链不管(同挪 .db 的拒绝,Codex 评审)。 */
function refuseDatabasesInside(folder: string): void {
  if (st().files.some((f) => /\.db$/i.test(f) && toSlash(f).startsWith(`${folder}/`))) {
    throw new Error(`Folders that contain databases can't be renamed or moved yet: ${folder}`)
  }
}

/**
 * 写之前判「原本不存在」:清单里有 = 存在(不走 IPC);清单里没有 → 一次 statPath 核实。
 * 没有 statPath 的宿主(网页)只按清单判(用户定的「便宜判法」之一;残余:清单还没刷到的别处新文件会被算成插件建的)。
 * 清单正在装 / 没有 stat 时清单认不出的点路径 / 核实出错 → 当「不知道」(false),不记账。
 * **同步发出** stat:它比随后那次写先进主进程;万一写先落地,stat 看到文件 = 不记账,错也只错在多问一次。
 */
export function probeAbsent(path: unknown): Promise<boolean> {
  try {
    const s = st()
    if (!s.vaultRoot || s.filesPendingFor || typeof path !== 'string') return Promise.resolve(false)
    const rel = cleanVaultPath(path)
    if (lookup(rel)) return Promise.resolve(false)
    if (typeof amadeus?.statPath !== 'function') return Promise.resolve(!rel.split('/').some((seg) => seg.startsWith('.')))
    return amadeus.statPath(rel).then((r) => r === null, () => false)
  } catch {
    return Promise.resolve(false)
  }
}

export interface PluginFileOpsDeps {
  pluginId: string
  getName(): string
  alive(): boolean
  workFolder(): string
  /** 落盘之后作废 ctx.app 的清单缓存。 */
  dropListCache(): void
  /** 插件注册的文件类型里命中 path 的那个后缀(如 `.canvas.md`),没有 = null。 */
  fileTypeExt(path: string): string | null
}

/** 每个插件一份;revoke 收掉还开着的确认框(插件停用时宿主调)。 */
export function createPluginFileOps(deps: PluginFileOpsDeps): {
  api: Pick<PluginAppApi, 'createFolder' | 'stat' | 'renamePath' | 'movePath'>
  revoke(): void
} {
  const { pluginId } = deps
  const asking = new Set<AbortController>()
  const gone = (): Error => new Error('plugin disabled')
  const requireRoot = (): string => {
    const root = st().vaultRoot
    if (!root) throw new Error('No vault is open')
    return root
  }

  /** 宿主确认框(插件 ctx.ui.confirm 同一个原语;手机上走原生 sheet)。 */
  const ask = async (title: () => string): Promise<boolean> => {
    const ctl = new AbortController()
    asking.add(ctl)
    try {
      const { confirmPlugin } = await import('./partsSurface')
      if (!deps.alive()) return false
      const guard = <T,>(fn: () => T): T | undefined => { try { return fn() } catch { return undefined } }
      return (await confirmPlugin({ title, ok: () => translate('pluginfileops.allow') }, guard, ctl.signal)) && !ctl.signal.aborted
    } finally {
      asking.delete(ctl)
    }
  }

  /** 改名 / 挪动的共同骨架:解析源 → 算目标 → 边界(需要就问)→ 排队重核 → 走链 → 按刷新后的清单核结果。 */
  const relocate = async (
    path: unknown,
    plan: (rel: string, e: Entry) => RenamePlan,
    question: (rel: string, to: string) => () => string,
  ): Promise<string> => {
    if (!deps.alive()) throw gone()
    const rel = cleanVaultPath(path)
    const root = requireRoot()
    await st().refreshStructure()
    if (!deps.alive()) throw gone()
    if (st().vaultRoot !== root) throw new Error('The active vault changed')
    const first = lookup(rel)
    if (!first) throw new Error(`No such file or folder in the vault: ${rel}`)
    const { to } = plan(rel, first)
    if (to === rel) return rel
    if (exists(to)) throw new Error(`Target already exists: ${to}`)
    const asked = !pluginOwnsPath(pluginId, rel, deps.workFolder())
    if (asked && !(await ask(question(rel, to)))) throw new Error(deps.alive() ? 'user_declined' : 'plugin disabled')
    return serial(async () => {
      if (!deps.alive()) throw gone()
      await st().refreshStructure()
      if (!deps.alive()) throw gone()
      if (st().vaultRoot !== root) throw new Error('The active vault changed')
      // 确认框可能开了很久:源还在、还是同一种、目标还空着,才动手
      const e = lookup(rel)
      if (!e || e.folder !== first.folder) throw new Error(`No such file or folder in the vault: ${rel}`)
      const again = plan(rel, e)
      if (again.to !== to) throw new Error(`The file changed while waiting: ${rel}`)
      if (exists(to)) throw new Error(`Target already exists: ${to}`)
      // 没问过用户的那次是凭「归它」放行的:排队期间源被删了、原位换成了用户的文件,账本已经摘掉 —— 不许照旧不问就动
      if (!asked && !pluginOwnsPath(pluginId, rel, deps.workFolder())) throw new Error(`The file changed while waiting: ${rel}`)
      const errBefore = st().error
      const kind = e.folder ? 'prefix' as const : 'file' as const
      let remapped = false
      const offGone = onNotePathGone((from) => { if (toSlash(from).replace(/^\/+|\/+$/g, '') === rel) remapped = true })
      let runErr: unknown = null
      try {
        await again.run(e.raw)
      } catch (err) {
        runErr = err
      } finally {
        offGone()
        await st().refreshStructure().catch(() => {})
        deps.dropListCache()
      }
      if (st().vaultRoot !== root) throw new Error('The active vault changed')
      const storeErr = st().error && st().error !== errBefore ? st().error : null
      const landed = lookup(to)
      if (!landed || landed.folder !== e.folder || lookup(rel)) {
        if (runErr) throw runErr
        throw new Error(storeErr || `Could not move ${rel} to ${to}`)
      }
      // 盘上已经挪过去、链却半路失败(索引 / .fd 级联 / 引用重写出错):那几条失败时不改指编辑器(按住的放手成 null),
      // 开着它的标签还攥着旧路径、下一次保存会把它写回来 —— 这里补一次改指,再把失败如实报给插件
      if (!remapped) remapScopePaths(e.raw, to, kind)
      followCreatedPath(rel, kind, to, root) // 链里的路径广播已经改过一遍,这里幂等兜底
      const partial = runErr ? (runErr instanceof Error ? runErr.message : String(runErr)) : storeErr
      if (partial) throw new Error(`${rel} is now ${to}, but the host could not finish: ${partial}`)
      return to
    })
  }

  const api: Pick<PluginAppApi, 'createFolder' | 'stat' | 'renamePath' | 'movePath'> = {
    createFolder: async (path) => {
      if (!deps.alive()) throw gone()
      const rel = cleanVaultPath(path, true)
      const root = requireRoot()
      if (!rel) return
      const segs = rel.split('/')
      // 点开头的段文件树清单看不见(没法判「已经有了」),两端会被桥修掉的空白同样拒
      for (const seg of segs) {
        if (seg.startsWith('.')) throw new Error(`Folder names starting with "." are not supported: ${seg}`)
        if (seg.trim() !== seg) throw new Error(`Invalid folder name: "${seg}"`)
      }
      await serial(async () => {
        if (!deps.alive()) throw gone()
        await st().refreshStructure()
        if (st().vaultRoot !== root) throw new Error('The active vault changed')
        const made: string[] = []
        let parent = ''
        try {
          for (const seg of segs) {
            const here = join(parent, seg)
            const e = lookup(here)
            if (e && !e.folder) throw new Error(`A file is in the way: ${here}`)
            if (!e) {
              if (!deps.alive()) throw gone()
              try {
                await amadeus.createFolder(parent, seg)
                made.push(here)
              } catch (err) {
                // 「已存在」:别人刚建好(不是我们建的,不记账)还是有个文件挡着?按刷新后的清单分
                await st().refreshStructure()
                const now = lookup(here)
                if (now && !now.folder) throw new Error(`A file is in the way: ${here}`)
                if (!now) throw err
              }
              if (st().vaultRoot !== root) throw new Error('The active vault changed')
            }
            parent = here
          }
        } finally {
          if (made.length) {
            await st().refreshStructure().catch(() => {})
            deps.dropListCache()
          }
          // 只记真建出来的那几层(用户原有的文件夹不因为插件「建」了一次就归它)
          for (const m of made) markPluginCreated(pluginId, m, root)
        }
      })
    },

    ...(typeof amadeus?.statPath === 'function'
      ? {
          stat: async (path: string) => {
            const rel = cleanVaultPath(path, true)
            const r = await amadeus.statPath!(rel)
            return r ? { kind: r.kind, size: r.size, mtime: r.mtime, ctime: r.ctime ?? null } : null
          },
        }
      : {}),

    renamePath: async (path, newName) => {
      const name = cleanNewName(newName)
      return relocate(
        path,
        (rel, e) => {
          const to = renameTarget(rel, e.folder, name, deps.fileTypeExt)
          if (e.folder) refuseDatabasesInside(rel)
          const run = async (raw: string): Promise<unknown> => {
            if (e.folder) return st().renameFolder(raw, name)
            // 交给链的是**整个**新名字:桥只掐掉一次结尾的 .md / .db 再补回去。先掐一次再交出去 =
            // 掐两次:`a.md` → `B.excalidraw.md.md` 会落成 `B.excalidraw.md`(笔记变白板,Codex 评审 P1)
            if (/\.db$/i.test(rel)) {
              const { renameDb } = await import('../lib/dbFileOps')
              return renameDb(raw, nameOf(to))
            }
            const { renameNoteFile } = await import('../lib/noteRename')
            return renameNoteFile(raw, nameOf(to))
          }
          return { to, run }
        },
        (rel, to) => () => translate('pluginfileops.rename', { plugin: deps.getName(), from: rel, to: nameOf(to) }),
      )
    },

    movePath: async (path, destFolder) => {
      const dest = cleanVaultPath(destFolder, true)
      return relocate(
        path,
        (rel, e) => {
          const to = join(dest, nameOf(rel))
          if (to === rel) return { to, run: async () => {} }
          if (dest && !lookup(dest)?.folder) throw new Error(`No such folder in the vault: ${dest}`)
          if (e.folder && (dest === rel || dest.startsWith(`${rel}/`))) throw new Error(`Cannot move a folder into itself: ${rel}`)
          if (e.folder) refuseDatabasesInside(rel)
          // .db 挪走后,别的表里指向它的关联列(refDb 存库内路径)与日历设置不会跟着改 —— 改名有这一步,挪动没有
          if (!e.folder && /\.db$/i.test(rel)) throw new Error(`Moving databases is not supported: ${rel}`)
          return { to, run: (raw: string) => (e.folder ? st().moveFolder(raw, dest) : st().movePage(raw, dest)) }
        },
        (rel) => () => (dest
          ? translate('pluginfileops.move', { plugin: deps.getName(), from: rel, to: dest })
          : translate('pluginfileops.moveToRoot', { plugin: deps.getName(), from: rel })),
      )
    },
  }

  return {
    api,
    revoke: () => {
      for (const c of Array.from(asking)) c.abort()
      asking.clear()
    },
  }
}
