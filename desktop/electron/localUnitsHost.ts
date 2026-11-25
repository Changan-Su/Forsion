/**
 * 本机多 Unit · Electron 那一层:`localUnits:*` IPC(只认主窗)、变化广播、装更新前关掉文件夹 Unit。盘上的事全在 localUnits.ts。
 *
 * 变化广播 `localUnits:changed`(任一实例改的都要传到别的实例):
 *   · fs.watch 名册所在目录(看目录不看文件:原子 rename 会换掉文件的 inode)、每个登记的文件夹(标记文件)和它的 app-data/(运行记录);
 *     Windows 改用 watchFile 观察两个文件,让已停止的 Unit 目录可移动。名册一变就按新名册重挂;
 *   · 任一窗口拿到焦点时再核一次(崩掉的 Unit 不会删运行记录、也不会有文件事件,回到这扇窗时以 pid 判活补上);
 *   · 本进程自己的写操作做完立刻核一次。
 * 每次都算一遍快照、和上一次比,真变了才广播(一次广播 = 渲染层重新 list 一次)。
 */
import { BrowserWindow, app, dialog, ipcMain, shell, type IpcMainInvokeEvent } from 'electron'
import { existsSync, unwatchFile, watch, watchFile } from 'node:fs'
import { dirname, join } from 'node:path'
import type { LocalUnitChannel, LocalUnitsResult, LocalUnitsSnapshot } from '../shared/localUnits'
import { LOCAL_UNIT_MARKER, LOCAL_UNIT_REGISTRY } from '../shared/localUnits'
import { defineMainMessages, mt } from './mainI18n'
import {
  LOCAL_UNIT_RUN_FILE, addExistingLocalUnit, createLocalUnit, isLocalUnitId, listLocalUnits, localUnitDisplayPath, localUnitPaths,
  lookupLocalUnit, quitLocalUnitsForInstall, readLocalUnitRegistry, removeLocalUnit, renameLocalUnit, type LocalUnitsContext,
} from './localUnits'
import type { PathGuard } from './pathOverlap'
import type { WindowShortcutResult } from './spaceShortcut'

export const LOCAL_UNITS_MESSAGES = defineMainMessages({
  'main.localUnits.refuseTitle': { zh: '无法打开这台 Unit', en: "Can't open this Unit" },
  'main.localUnits.refuse.bad_arg': { zh: '启动参数不对。', en: 'The launch arguments are invalid.' },
  'main.localUnits.refuse.registry_unreadable': { zh: '读不出这台电脑上的 Unit 列表。', en: "Couldn't read the list of Units on this computer." },
  'main.localUnits.refuse.not_found': { zh: '这台电脑上没有登记这台 Unit，它可能已从列表移除。', en: "This Unit isn't registered on this computer. It may have been removed from the list." },
  'main.localUnits.refuse.missing': { zh: '找不到这台 Unit 的文件夹。它可能被移动、删除，或在没有连接的磁盘上。', en: "Can't find this Unit's folder. It may have been moved or deleted, or it's on a disk that isn't connected." },
  'main.localUnits.refuse.mismatch': { zh: '这台 Unit 的文件夹对不上。', en: "This Unit's folder doesn't match its registration." },
  'main.localUnits.refuse.channel_mismatch': { zh: '这台 Unit 属于另一个版本的 Forsion（安装版 / 开发版）。', en: 'This Unit belongs to another edition of Forsion (installed or development).' },
  'main.localUnits.refuse.unsafe': { zh: '这台 Unit 的文件夹里有指向别处的链接。为了不和别的 Unit 共用数据，暂时不能打开。', en: "This Unit's folder contains links to other places. To avoid sharing data with another Unit, it can't be opened." },
  'main.localUnits.refuse.overlap': { zh: '这台 Unit 的文件夹和这台电脑自己的 Forsion 数据（或你的用户文件夹）重叠，打开它会共用数据，所以不能打开。', en: "This Unit's folder overlaps this computer's own Forsion data (or your home folder). Opening it would share data, so it can't be opened." },
  'main.localUnits.refuse.unwritable': { zh: '无法写入这台 Unit 的文件夹，所以不能打开它。请检查这个文件夹的权限，以及磁盘是否已满。', en: "Can't write to this Unit's folder, so it can't be opened. Check the folder's permissions and free disk space." },
  'main.localUnits.refuse.env_outside': { zh: '这台 Unit 的设置文件 {file} 里，{key} 指向这台 Unit 文件夹以外的位置。为了不和别的 Unit 共用账号或数据，暂时不能打开。把这一行改成文件夹里的路径或删掉后再打开。', en: "In this Unit's settings file {file}, {key} points outside this Unit's folder. To avoid sharing an account or data with another Unit, it can't be opened. Change that line to a path inside the folder, or delete it, then open the Unit again." },
  'main.localUnits.removeRunning': { zh: '这台 Unit 正开着（或无法确认它已关掉）。请先关掉它，再从列表移除。', en: 'This Unit is open (or Forsion can\'t confirm it\'s closed). Close it before removing it from the list.' },
  'main.localUnits.overlapsDefault': { zh: '这个文件夹和这台电脑自己的 Forsion 数据（或你的用户文件夹）重叠，不能用作 Unit。', en: "This folder overlaps this computer's own Forsion data or your home folder, so it can't be used as a Unit." },
  'main.localUnits.originalMarkerUnreadable': { zh: '这台 Unit 登记的原文件夹现在读不出来，无法判断这是不是一份拷贝。什么都没改。', en: "The folder this Unit is registered at can't be read right now, so Forsion can't tell whether this is a copy. Nothing was changed." },
  'main.localUnits.clearRefusedTitle': { zh: '没有清空数据', en: "Data wasn't cleared" },
  'main.localUnits.clearRefused': { zh: '要删除的位置和另一台 Unit 的文件夹或这台电脑自己的 Forsion 数据重叠（或无法确认不重叠），所以什么都没删。请先把那台 Unit 移到别处，或从列表移除。', en: "The data to delete overlaps another Unit's folder or this computer's own Forsion data (or Forsion can't confirm it doesn't), so nothing was deleted. Move that Unit somewhere else or remove it from the list first." },
  'main.localUnits.clearIncompleteTitle': { zh: '清理不完整', en: 'Clearing was incomplete' },
  'main.localUnits.clearIncomplete': { zh: '下面这些位置在核对之后有了变化（或删不掉），为了安全没有删除。Forsion 会照常重启。', en: "These locations changed after they were checked (or couldn't be deleted), so they were left in place to be safe. Forsion will restart as usual." },
  'main.localUnits.startFailed': { zh: '没能启动 Forsion。', en: "Couldn't start Forsion." },
  'main.localUnits.chooseParent': { zh: '选择新 Unit 放在哪里', en: 'Choose where to put the new Unit' },
  'main.localUnits.chooseExisting': { zh: '选择一个 Unit 文件夹', en: 'Choose a Unit folder' },
  'main.localUnits.installBlockedTitle': { zh: '还不能安装更新', en: "Can't install the update yet" },
  'main.localUnits.installBlocked': { zh: '还有 {count} 台 Unit 没关掉。请先关掉它们，再安装更新。', en: 'Units still open: {count}. Close them, then install the update.' },
  'main.localUnits.installUnknown': { zh: '读不出这台电脑上的 Unit 列表，无法确认它们都已关掉，先不安装更新。', en: "Couldn't read the list of Units on this computer, so Forsion can't confirm they're closed. The update wasn't installed." },
  'main.localUnits.ok': { zh: '好', en: 'OK' },
})

export interface LocalUnitsHostDeps {
  registryFile: string
  channel: LocalUnitChannel
  /** 当前进程是文件夹 Unit → 它的 id 与文件夹;默认那台 = null。 */
  self: { id: string; dir: string } | null
  /** 文件夹不许和默认那台的数据沾边(localUnitGuard,main.ts 启动时算好)。 */
  guard: PathGuard
  defaultParent: string
  home: string
  /** 发起方是主窗(且可信)。 */
  isMainSender: (e: IpcMainInvokeEvent) => boolean
  mainWindow: () => BrowserWindow | null
  showMainWindow: () => void
  /** 拉起一份 Forsion(不给 unitId = 默认那台;quit = 叫那台退出)。拉不起来 = false。 */
  spawnInstance: (o: { unitId?: string; quit?: boolean }) => boolean
  addToDesktop: (unit: { id: string; name: string }, opts: { iconPng?: unknown; fallbackName?: unknown }) => Promise<WindowShortcutResult>
  log: (m: string) => void
}

export interface LocalUnitsHost {
  /** 装更新前:叫名册里在跑的文件夹 Unit 都退出,最多等 timeoutMs。回还在跑的个数;名册读不出 = -1(不知道)。 */
  quitRunningForInstall(timeoutMs?: number): Promise<number>
  dispose(): void
}

const deny = { ok: false as const, code: 'io' as const, detail: 'only the main window can do this' }

export function createLocalUnitsHost(d: LocalUnitsHostDeps): LocalUnitsHost {
  const ctx: LocalUnitsContext = { registryFile: d.registryFile, channel: d.channel, self: d.self, home: d.home, guard: d.guard, text: (k) => mt(`main.localUnits.${k}`) }
  const snapshot = (): LocalUnitsSnapshot => listLocalUnits({ ...ctx, defaultParent: d.defaultParent })

  // ── 变化广播 ──
  let lastSig = ''
  try { lastSig = JSON.stringify(snapshot()) } catch { /* 第一次核对时补上 */ }
  const recheck = (): void => {
    let sig: string
    try { sig = JSON.stringify(snapshot()) } catch { return }
    if (sig === lastSig) return
    lastSig = sig
    for (const w of BrowserWindow.getAllWindows()) if (!w.isDestroyed() && !w.webContents.isDestroyed()) w.webContents.send('localUnits:changed')
  }
  let timer: ReturnType<typeof setTimeout> | null = null
  const soon = (): void => { if (timer) clearTimeout(timer); timer = setTimeout(() => { timer = null; recheck(); rewatch() }, 150) }
  const watchers = new Map<string, () => void>()
  const watchDir = (dir: string, names: readonly string[]): void => {
    if (watchers.has(dir) || !existsSync(dir)) return
    try {
      const w = watch(dir, { persistent: false }, (_ev, f) => { if (!f || names.some((n) => String(f).startsWith(n))) soon() })
      const close = () => w.close()
      w.on('error', () => { close(); if (watchers.get(dir) === close) watchers.delete(dir) })
      watchers.set(dir, close)
    } catch { /* 监视不了就靠焦点时的核对 */ }
  }
  const watchUnitFile = (file: string): void => {
    if (watchers.has(file)) return
    // Windows directory watchers hold open handles and block renaming the Unit folder.
    // Stat the marker and run record instead, including while the run record is absent.
    try {
      watchFile(file, { persistent: false, interval: 750 }, soon)
      watchers.set(file, () => unwatchFile(file, soon))
    } catch { /* 监视不了就靠焦点时的核对 */ }
  }
  const rewatch = (): void => {
    const want = new Set<string>([dirname(d.registryFile)])
    watchDir(dirname(d.registryFile), [LOCAL_UNIT_REGISTRY])
    const read = readLocalUnitRegistry(d.registryFile)
    if (read.state === 'ok') {
      for (const u of read.registry.units) {
        const p = localUnitPaths(u.path)
        if (process.platform === 'win32') {
          for (const file of [join(p.dir, LOCAL_UNIT_MARKER), join(p.appData, LOCAL_UNIT_RUN_FILE)]) {
            want.add(file)
            watchUnitFile(file)
          }
        } else {
          want.add(p.dir); want.add(p.appData)
          watchDir(p.dir, [LOCAL_UNIT_MARKER])
          watchDir(p.appData, [LOCAL_UNIT_RUN_FILE])
        }
      }
    }
    for (const [target, close] of watchers) if (!want.has(target)) { close(); watchers.delete(target) }
  }
  rewatch()
  const onFocus = (): void => soon()
  app.on('browser-window-focus', onFocus)
  const after = <T>(r: T): T => { recheck(); rewatch(); return r }

  // ── IPC:只认主窗;别的窗口拿到拒绝,不抛 ──
  ipcMain.handle('localUnits:list', (e): LocalUnitsSnapshot => (d.isMainSender(e) ? snapshot() : { ...snapshot(), units: [], registry: 'unreadable' }))
  ipcMain.handle('localUnits:create', async (e, raw: unknown) => {
    if (!d.isMainSender(e)) return deny
    const input = (raw && typeof raw === 'object' ? raw : {}) as { name?: unknown; icon?: unknown; parentDir?: unknown }
    return after(await createLocalUnit({ ...ctx, name: input.name, icon: input.icon, parentDir: input.parentDir, defaultParent: d.defaultParent }))
  })
  ipcMain.handle('localUnits:chooseParent', async (e) => {
    if (!d.isMainSender(e)) return null
    const win = d.mainWindow()
    if (!win) return null
    const r = await dialog.showOpenDialog(win, {
      title: mt('main.localUnits.chooseParent'),
      defaultPath: existsSync(d.defaultParent) ? d.defaultParent : d.home,
      properties: ['openDirectory', 'createDirectory'],
    })
    const p = r.canceled ? undefined : r.filePaths[0]
    return p ? { path: p, display: localUnitDisplayPath(p, d.home) } : null
  })
  ipcMain.handle('localUnits:addExisting', async (e) => {
    if (!d.isMainSender(e)) return deny
    const win = d.mainWindow()
    if (!win) return deny
    const r = await dialog.showOpenDialog(win, {
      title: mt('main.localUnits.chooseExisting'),
      defaultPath: existsSync(d.defaultParent) ? d.defaultParent : d.home,
      properties: ['openDirectory'],
    })
    const p = r.canceled ? undefined : r.filePaths[0]
    if (!p) return { ok: false, code: 'cancelled' }
    return after(await addExistingLocalUnit({ ...ctx, dir: p }))
  })
  ipcMain.handle('localUnits:open', (e, id: unknown): LocalUnitsResult => {
    if (!d.isMainSender(e)) return deny
    if (id === 'default') {
      if (!d.self) { d.showMainWindow(); return { ok: true } } // 本来就是默认那台
      return d.spawnInstance({}) ? { ok: true } : { ok: false, code: 'io', message: mt('main.localUnits.startFailed'), detail: 'spawn failed' }
    }
    const hit = lookupLocalUnit(ctx, id)
    if (!hit.ok) return hit
    if (d.self?.id === hit.entry.id) { d.showMainWindow(); return { ok: true } }
    // 在跑也照样拉起:新进程拿不到那台的单实例锁,会把参数交给它(叫到前面)再退出
    const ok = d.spawnInstance({ unitId: hit.entry.id })
    soon()
    return ok ? { ok: true } : { ok: false, code: 'io', message: mt('main.localUnits.startFailed'), detail: 'spawn failed' }
  })
  ipcMain.handle('localUnits:rename', async (e, id: unknown, patch: unknown) => {
    if (!d.isMainSender(e)) return deny
    return after(await renameLocalUnit({ ...ctx, id, patch }))
  })
  ipcMain.handle('localUnits:reveal', (e, id: unknown): LocalUnitsResult => {
    if (!d.isMainSender(e)) return deny
    if (!isLocalUnitId(id)) return { ok: false, code: 'not_found' }
    const read = readLocalUnitRegistry(d.registryFile)
    if (read.state !== 'ok') return { ok: false, code: 'registry_unreadable' }
    const entry = read.registry.units.find((u) => u.id === id)
    if (!entry) return { ok: false, code: 'not_found' }
    if (!existsSync(entry.path)) return { ok: false, code: 'not_a_unit', detail: 'folder is missing' }
    shell.showItemInFolder(entry.path)
    return { ok: true }
  })
  ipcMain.handle('localUnits:remove', async (e, id: unknown) => {
    if (!d.isMainSender(e)) return deny
    return after(await removeLocalUnit({ ...ctx, id }))
  })
  ipcMain.handle('localUnits:addToDesktop', async (e, id: unknown, raw: unknown): Promise<LocalUnitsResult> => {
    if (!d.isMainSender(e)) return deny
    const hit = lookupLocalUnit(ctx, id)
    if (!hit.ok) return hit
    const opts = (raw && typeof raw === 'object' ? raw : {}) as { iconPng?: unknown; fallbackName?: unknown }
    const r = await d.addToDesktop({ id: hit.entry.id, name: hit.marker.name }, opts)
    if (r.ok) return { ok: true }
    return { ok: false, code: 'io', detail: 'detail' in r && r.detail ? `${r.code}: ${r.detail}` : r.code }
  })

  return {
    async quitRunningForInstall(timeoutMs = 15_000) {
      const left = await quitLocalUnitsForInstall({
        registryFile: d.registryFile, selfId: d.self?.id ?? null, timeoutMs, log: d.log,
        requestQuit: (id) => { d.spawnInstance({ unitId: id, quit: true }) },
      })
      soon()
      return left
    },
    dispose() {
      app.off('browser-window-focus', onFocus)
      if (timer) clearTimeout(timer)
      for (const close of watchers.values()) close()
      watchers.clear()
    },
  }
}

/** 装更新被挡下时的提示(挂主窗;拿不到窗就不弹)。 */
export async function showInstallBlocked(win: BrowserWindow | null, left: number): Promise<void> {
  if (!win || win.isDestroyed()) return
  await dialog.showMessageBox(win, {
    type: 'warning',
    title: mt('main.localUnits.installBlockedTitle'),
    message: left < 0 ? mt('main.localUnits.installUnknown') : mt('main.localUnits.installBlocked', { count: left }),
    buttons: [mt('main.localUnits.ok')], defaultId: 0, noLink: true,
  })
}
