/**
 * 本机多 Unit · 主进程的盘上部分(名册、标记文件、运行记录、启动参数、拉起别的实例时的环境)。无 Electron 依赖,vitest 直测。
 * 共用的类型和纯函数在 shared/localUnits.ts;Electron 那一层(IPC、对话框、快捷方式、监视)在 localUnitsHost.ts。
 *
 * 落盘纪律:
 *   · 名册与标记都「唯一临时名 + fsync + rename」,不截断直写;
 *   · 名册的读改写跨进程持锁(<名册>.lock,O_EXCL 建;超过 10 秒算陈旧,挪开再删),锁内现读现改,提交前核一次锁还是自己的;
 *   · 读不出 ≠ 空:名册不存在(ENOENT)才是空名册;零字节、半截、结构不对、没权限一律「不知道」,所有写操作回 registry_unreadable,
 *     绝不按空名册写回去;
 *   · 标记文件读不出 = 这不是(或已不是)一个 Unit,名册里那一条照样留着(显示「找不到这个文件夹」),不替用户删。
 */
import { randomUUID } from 'node:crypto'
import {
  accessSync, closeSync, constants as fsConstants, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, realpathSync,
  renameSync, rmSync, statSync, writeFileSync, writeSync,
} from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, isAbsolute, join, resolve, sep } from 'node:path'
import {
  LOCAL_UNIT_ARG, LOCAL_UNIT_DIRS, LOCAL_UNIT_MARKER, LOCAL_UNIT_QUIT_ARG, LOCAL_UNIT_REGISTRY,
  isValidLocalUnitName, localUnitFolderName, parseLocalUnitMarker, parseLocalUnitRegistry,
  type LocalUnitChannel, type LocalUnitMarker, type LocalUnitRegistry, type LocalUnitRow, type LocalUnitSelf,
  type LocalUnitsErrorCode, type LocalUnitsResult, type LocalUnitsSnapshot,
} from '../shared/localUnits'
import { dirIdentity, sameDevIno } from './dirIdentity'
import type { WindowShortcutKind } from './spaceShortcut'

/** 文件夹 Unit 跑起来以后在自己 app-data 里写的运行记录(退出删;判活看 pid)。 */
export const LOCAL_UNIT_RUN_FILE = 'local-unit-run.json'
/** 名册锁超过这么久没动 = 持锁进程死在临界区,挪开再抢。 */
export const REGISTRY_LOCK_STALE_MS = 10_000
const REGISTRY_LOCK_WAIT_MS = 5_000
const LOCK_BUSY = new Set(process.platform === 'win32' ? ['EEXIST', 'EPERM', 'EACCES'] : ['EEXIST'])
const ID_RE = /^[0-9a-f-]{8,64}$/i
const ICON_MAX = 64

export const isLocalUnitId = (v: unknown): v is string => typeof v === 'string' && ID_RE.test(v)
export const localUnitChannel = (isPackaged: boolean): LocalUnitChannel => (isPackaged ? 'stable' : 'dev')

/** 默认那台的 userData:进程刚起、还没改 userData 时的那个值;开发版和 main.ts 一样再挂 -dev。名册就在它下面。 */
export function defaultUserDataDir(startupUserData: string, isPackaged: boolean): string {
  return isPackaged ? startupUserData : `${startupUserData}-dev`
}
export const localUnitRegistryFile = (defaultUserData: string): string => join(defaultUserData, LOCAL_UNIT_REGISTRY)

/** 「新建」的缺省父目录:安装版 ~/Forsion Units,开发版 ~/.forsion-dev/units(开发版绝不落到安装版那里)。 */
export function localUnitsDefaultParent(isPackaged: boolean, home = homedir()): string {
  return isPackaged ? join(home, 'Forsion Units') : join(home, '.forsion-dev', 'units')
}

/** 给人看的路径:家目录缩成 ~。 */
export function localUnitDisplayPath(p: string, home = homedir()): string {
  if (!home) return p
  if (p === home) return '~'
  return p.startsWith(home + sep) ? `~${sep}${p.slice(home.length + 1)}` : p
}

export interface LocalUnitPaths { dir: string; marker: string; home: string; appData: string; workspace: string; runRecord: string }
export function localUnitPaths(dir: string): LocalUnitPaths {
  const appData = join(dir, LOCAL_UNIT_DIRS.appData)
  return {
    dir, marker: join(dir, LOCAL_UNIT_MARKER),
    home: join(dir, LOCAL_UNIT_DIRS.home), appData, workspace: join(dir, LOCAL_UNIT_DIRS.workspace),
    runRecord: join(appData, LOCAL_UNIT_RUN_FILE),
  }
}

/** Windows 任务栏分组用的 AppUserModelID:每台文件夹 Unit 一组(进程与它的 .lnk 同一个)。 */
const LOCAL_UNIT_AUMID = 'com.forsion.tangu.unit'
export const localUnitAppUserModelId = (id: string): string => `${LOCAL_UNIT_AUMID}.${id}`

/** 「添加到桌面」的种类表条目(落盘那套在 spaceShortcut.ts):快捷方式里只有 id,带 --forsion-unit=<id> 另起一份;
 *  文件夹搬家后照样能开。没有 forsion:// 链接 —— 链接不能指定文件夹 Unit。 */
export const LOCAL_UNIT_SHORTCUT: WindowShortcutKind = {
  host: 'local-unit',
  isId: isLocalUnitId,
  aumid: LOCAL_UNIT_AUMID,
  bundle: 'net.forsion.local-unit-shortcut',
  plistKey: 'ForsionLocalUnitId',
  scriptComment: '# Forsion Unit shortcut: opens this Unit on this computer in its own Forsion.',
  argv: (id) => [`${LOCAL_UNIT_ARG}=${id}`],
}

/** mac:可执行文件所在的 .app(Contents/MacOS/<名> 往上三层);不在 .app 里(开发版的裸 Electron 也在 .app 里,但开发版不建快捷方式)→ undefined。 */
export function macAppBundleOf(execPath: string): string | undefined {
  const bundle = resolve(execPath, '..', '..', '..')
  return bundle.endsWith('.app') ? bundle : undefined
}

// ── 启动参数 ────────────────────────────────────────────────────────────────────────────

export interface LocalUnitArgs {
  /** argv 里出现了 --forsion-unit(哪怕写法不对)。 */
  present: boolean
  /** 合法的 id;写法不对 / 不是 id = null(按拒绝处理,不回落成默认那台)。 */
  id: string | null
  quit: boolean
}
/** 只认 `--forsion-unit=<id>` 与 `--forsion-unit-quit`;参数里从不带路径。 */
export function parseLocalUnitArgs(argv: readonly string[]): LocalUnitArgs {
  let present = false
  let id: string | null = null
  let quit = false
  for (const a of argv) {
    if (typeof a !== 'string') continue
    if (a === LOCAL_UNIT_QUIT_ARG) { quit = true; continue }
    if (a === LOCAL_UNIT_ARG) { present = true; continue }
    if (a.startsWith(`${LOCAL_UNIT_ARG}=`)) {
      const v = a.slice(LOCAL_UNIT_ARG.length + 1)
      if (!present) id = isLocalUnitId(v) ? v : null
      else if (id !== v) id = null // 两个不同的 id:不猜
      present = true
    }
  }
  return { present, id: present ? id : null, quit }
}

// ── 原子写 / 跨进程锁 ─────────────────────────────────────────────────────────────────

function writeAtomicSync(file: string, text: string, mine: () => boolean = () => true): void {
  const tmp = `${file}.${process.pid}-${randomUUID()}.tmp`
  let fd: number | undefined
  try {
    fd = openSync(tmp, 'wx', 0o644)
    writeFileSync(fd, text, 'utf8')
    fsyncSync(fd)
    const closing = fd; fd = undefined; closeSync(closing)
    if (!mine()) throw new Error(`the lock on ${basename(file)} was taken over while writing; nothing written`)
    renameSync(tmp, file)
  } catch (e) {
    if (fd !== undefined) try { closeSync(fd) } catch { /* ignore */ }
    try { rmSync(tmp, { force: true }) } catch { /* 清不掉就留着,别盖掉原始错误 */ }
    throw e
  }
}

function stealIfStale(lock: string, now = Date.now()): void {
  try {
    if (now - statSync(lock).mtimeMs < REGISTRY_LOCK_STALE_MS) return
    const aside = `${lock}.stale-${process.pid}-${randomUUID()}`
    renameSync(lock, aside)
    rmSync(aside, { force: true })
  } catch { /* 锁刚被放掉 / 被别人先挪走:回去重抢 */ }
}

/** 持名册锁跑一段**同步**的读改写(持锁期间不让出事件循环)。等锁超过 5 秒抛错,绝不无锁硬写。 */
export async function withRegistryLock<T>(file: string, fn: (mine: () => boolean) => T): Promise<T> {
  const lock = `${file}.lock`
  const token = `${process.pid}-${randomUUID()}`
  const deadline = Date.now() + REGISTRY_LOCK_WAIT_MS
  mkdirSync(dirname(file), { recursive: true })
  for (;;) {
    let fd: number
    try {
      fd = openSync(lock, 'wx')
    } catch (e) {
      if (!LOCK_BUSY.has((e as NodeJS.ErrnoException).code ?? '')) throw e
      stealIfStale(lock)
      if (Date.now() > deadline) throw new Error(`${basename(file)} is locked by another Forsion process`)
      await new Promise((r) => setTimeout(r, 10))
      continue
    }
    try { writeSync(fd, token) } catch (e) {
      try { closeSync(fd) } catch { /* ignore */ }
      rmSync(lock, { force: true })
      throw e
    }
    closeSync(fd)
    break
  }
  const mine = (): boolean => { try { return readFileSync(lock, 'utf8') === token } catch { return false } }
  try {
    return fn(mine)
  } finally {
    try { if (mine()) rmSync(lock, { force: true }) } catch { /* 删不掉就留给陈旧回收 */ }
  }
}

// ── 名册 ─────────────────────────────────────────────────────────────────────────────

export type LocalUnitRegistryRead = { state: 'ok'; registry: LocalUnitRegistry } | { state: 'unreadable'; error: string }

/** 不存在 = 空名册;别的任何读不出 = unreadable(不是空)。 */
export function readLocalUnitRegistry(file: string): LocalUnitRegistryRead {
  let raw: string
  try { raw = readFileSync(file, 'utf8') } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return { state: 'ok', registry: { schema: 1, units: [] } }
    return { state: 'unreadable', error: (e as Error).message }
  }
  let json: unknown
  try { json = JSON.parse(raw) } catch (e) { return { state: 'unreadable', error: `invalid JSON: ${(e as Error).message}` } }
  const registry = parseLocalUnitRegistry(json)
  return registry ? { state: 'ok', registry } : { state: 'unreadable', error: 'unexpected registry shape' }
}

type Fail = { ok: false; code: LocalUnitsErrorCode; message?: string }
const fail = (code: LocalUnitsErrorCode, message?: string): Fail => (message ? { ok: false, code, message } : { ok: false, code })

/** 锁内现读名册交给 fn;fn 回 next 就原子写回。名册读不出 → registry_unreadable,fn 不跑、什么都不写。 */
export async function mutateLocalUnitRegistry<R>(
  file: string,
  fn: (registry: LocalUnitRegistry, mine: () => boolean) => { next?: LocalUnitRegistry; result: R },
): Promise<{ ok: true; result: R } | Fail> {
  try {
    return await withRegistryLock(file, (mine) => {
      const read = readLocalUnitRegistry(file)
      if (read.state !== 'ok') return fail('registry_unreadable', read.error)
      const { next, result } = fn(read.registry, mine)
      if (next) writeAtomicSync(file, `${JSON.stringify(next, null, 2)}\n`, mine)
      return { ok: true as const, result }
    })
  } catch (e) {
    return fail('io', e instanceof Error ? e.message : String(e))
  }
}

// ── 标记文件 ──────────────────────────────────────────────────────────────────────────

export function readLocalUnitMarker(dir: string): LocalUnitMarker | null {
  try { return parseLocalUnitMarker(JSON.parse(readFileSync(join(dir, LOCAL_UNIT_MARKER), 'utf8'))) } catch { return null }
}
export function writeLocalUnitMarker(dir: string, marker: LocalUnitMarker, mine?: () => boolean): void {
  writeAtomicSync(join(dir, LOCAL_UNIT_MARKER), `${JSON.stringify(marker, null, 2)}\n`, mine)
}

/** 三个子目录要么还没建、要么是真目录:软链 / 普通文件 = 拒(拷来的文件夹里 home 指向默认那台的 ~/.forsion 就成了两份共用一份数据)。 */
export function localUnitFolderSafe(dir: string): boolean {
  for (const sub of Object.values(LOCAL_UNIT_DIRS)) {
    let st: ReturnType<typeof lstatSync>
    try { st = lstatSync(join(dir, sub)) } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') continue
      return false
    }
    if (st.isSymbolicLink() || !st.isDirectory()) return false
  }
  return true
}

const realOrNull = (p: string): string | null => { try { return realpathSync(p) } catch { return null } }

/** 同一个文件夹:realpath 相同,或 dev+ino 相同(大小写不敏感的盘上写法可能不同)。 */
export function sameFolder(a: string, b: string): boolean {
  const ra = realOrNull(a) ?? resolve(a)
  const rb = realOrNull(b) ?? resolve(b)
  if (ra === rb) return true
  const ia = dirIdentity(ra), ib = dirIdentity(rb)
  return !!ia && !!ib && sameDevIno(ia, ib)
}

// ── 运行记录 ──────────────────────────────────────────────────────────────────────────

export function writeLocalUnitRunRecord(appData: string, pid: number, startedAt = Date.now()): void {
  mkdirSync(appData, { recursive: true })
  writeAtomicSync(join(appData, LOCAL_UNIT_RUN_FILE), JSON.stringify({ pid, startedAt }))
}
/** 只删自己写的那份(pid 对得上);同步,能在 process 'exit' 里调。 */
export function clearLocalUnitRunRecord(appData: string, pid: number): void {
  const f = join(appData, LOCAL_UNIT_RUN_FILE)
  try {
    const rec = JSON.parse(readFileSync(f, 'utf8')) as { pid?: unknown }
    if (rec?.pid === pid) rmSync(f, { force: true })
  } catch { /* 没有 / 坏了:不管 */ }
}
export function pidAlive(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false
  try { process.kill(pid, 0); return true } catch (e) { return (e as NodeJS.ErrnoException).code === 'EPERM' }
}
/** 记录里的 pid 还活着 → pid;没记录 / 坏了 / 进程没了 → null。 */
export function localUnitRunningPid(appData: string, alive: (pid: number) => boolean = pidAlive): number | null {
  try {
    const rec = JSON.parse(readFileSync(join(appData, LOCAL_UNIT_RUN_FILE), 'utf8')) as { pid?: unknown }
    const pid = typeof rec?.pid === 'number' ? rec.pid : NaN
    return alive(pid) ? pid : null
  } catch { return null }
}

// ── 启动时的核对(只读,不建任何目录) ──────────────────────────────────────────────────

export type LocalUnitLaunchRefusal = 'bad_arg' | 'registry_unreadable' | 'not_found' | 'missing' | 'mismatch' | 'channel_mismatch' | 'unsafe'
export type LocalUnitLaunch =
  | { ok: true; id: string; marker: LocalUnitMarker; paths: LocalUnitPaths }
  | { ok: false; reason: LocalUnitLaunchRefusal }

/** 参数里的 id → 名册里的路径 → 标记文件的 id 与通道都对上才放行。这一步只读,失败时盘上什么都不留下。 */
export function resolveLocalUnitLaunch(o: { id: string | null; registryFile: string; channel: LocalUnitChannel }): LocalUnitLaunch {
  if (!isLocalUnitId(o.id)) return { ok: false, reason: 'bad_arg' }
  const read = readLocalUnitRegistry(o.registryFile)
  if (read.state !== 'ok') return { ok: false, reason: 'registry_unreadable' }
  const entry = read.registry.units.find((u) => u.id === o.id)
  if (!entry || !isAbsolute(entry.path)) return { ok: false, reason: 'not_found' }
  const dir = realOrNull(entry.path)
  if (!dir) return { ok: false, reason: 'missing' }
  const marker = readLocalUnitMarker(dir)
  if (!marker) return { ok: false, reason: 'missing' }
  if (marker.id !== o.id) return { ok: false, reason: 'mismatch' }
  if (marker.channel !== o.channel) return { ok: false, reason: 'channel_mismatch' }
  if (!localUnitFolderSafe(dir)) return { ok: false, reason: 'unsafe' }
  return { ok: true, id: o.id, marker, paths: localUnitPaths(dir) }
}

// ── 列表 ─────────────────────────────────────────────────────────────────────────────

export interface LocalUnitsContext {
  registryFile: string
  channel: LocalUnitChannel
  /** 当前进程是文件夹 Unit → 它的 id 与文件夹;默认那台 = null。 */
  self: { id: string; dir: string } | null
  home?: string
  alive?: (pid: number) => boolean
}

function rowFor(entry: { id: string; path: string }, ctx: LocalUnitsContext): LocalUnitRow {
  const home = ctx.home ?? homedir()
  const current = ctx.self?.id === entry.id
  const base = { id: entry.id, path: entry.path, displayPath: localUnitDisplayPath(entry.path, home), current }
  const marker = readLocalUnitMarker(entry.path)
  if (!marker) return { ...base, name: basename(entry.path), icon: '', state: 'missing' }
  if (marker.id !== entry.id || marker.channel !== ctx.channel) return { ...base, name: marker.name, icon: marker.icon, state: 'mismatch' }
  const running = current || localUnitRunningPid(localUnitPaths(entry.path).appData, ctx.alive) !== null
  return { ...base, name: marker.name, icon: marker.icon, state: running ? 'running' : 'stopped' }
}

export function listLocalUnits(ctx: LocalUnitsContext & { defaultParent: string }): LocalUnitsSnapshot {
  const home = ctx.home ?? homedir()
  let self: LocalUnitSelf = { kind: 'default' }
  if (ctx.self) {
    const m = readLocalUnitMarker(ctx.self.dir)
    self = { kind: 'folder', id: ctx.self.id, name: m?.name ?? basename(ctx.self.dir), icon: m?.icon ?? '', path: ctx.self.dir, displayPath: localUnitDisplayPath(ctx.self.dir, home) }
  }
  const read = readLocalUnitRegistry(ctx.registryFile)
  return {
    self,
    units: read.state === 'ok' ? read.registry.units.map((u) => rowFor(u, ctx)) : [],
    registry: read.state === 'ok' ? 'ok' : 'unreadable',
    defaultParent: ctx.defaultParent,
    defaultParentDisplay: localUnitDisplayPath(ctx.defaultParent, home),
  }
}

/** 名册里这一条,外加它此刻能不能用(open / rename / reveal / 添加到桌面先过这里)。 */
export function lookupLocalUnit(ctx: LocalUnitsContext, id: unknown):
  | { ok: true; entry: { id: string; path: string }; marker: LocalUnitMarker; row: LocalUnitRow }
  | Fail {
  if (!isLocalUnitId(id)) return fail('not_found')
  const read = readLocalUnitRegistry(ctx.registryFile)
  if (read.state !== 'ok') return fail('registry_unreadable', read.error)
  const entry = read.registry.units.find((u) => u.id === id)
  if (!entry) return fail('not_found')
  const marker = readLocalUnitMarker(entry.path)
  if (!marker) return fail('not_a_unit', 'folder or marker file is missing')
  if (marker.channel !== ctx.channel) return fail('channel_mismatch')
  if (marker.id !== id) return fail('not_a_unit', 'marker id does not match')
  return { ok: true, entry, marker, row: rowFor(entry, ctx) }
}

// ── 写操作 ────────────────────────────────────────────────────────────────────────────

const cleanIcon = (v: unknown): string => (typeof v === 'string' ? Array.from(v.trim()).slice(0, ICON_MAX).join('') : '')

/** 新建:名字 → 文件夹名;目标已存在 → path_exists;写标记、建三个子目录、登记。不打开。登记失败 → 把刚建的文件夹收掉。 */
export async function createLocalUnit(ctx: LocalUnitsContext & {
  name: unknown; icon: unknown; parentDir?: unknown; defaultParent: string; now?: number; newId?: () => string
}): Promise<LocalUnitsResult<{ unit: LocalUnitRow }>> {
  const name = typeof ctx.name === 'string' ? ctx.name.trim() : ''
  if (!isValidLocalUnitName(name)) return fail('name_invalid')
  const folder = localUnitFolderName(name)
  if (!folder) return fail('name_invalid')
  const pre = readLocalUnitRegistry(ctx.registryFile)
  if (pre.state !== 'ok') return fail('registry_unreadable', pre.error) // 先判,不在读不出名册时往盘上建东西
  const parentIn = ctx.parentDir === undefined || ctx.parentDir === null || ctx.parentDir === '' ? ctx.defaultParent : ctx.parentDir
  if (typeof parentIn !== 'string' || !isAbsolute(parentIn)) return fail('parent_invalid')
  const parentAbs = resolve(parentIn)
  try {
    if (parentAbs === resolve(ctx.defaultParent)) mkdirSync(parentAbs, { recursive: true }) // 只有缺省父目录替用户建
    if (!statSync(parentAbs).isDirectory()) return fail('parent_invalid')
    accessSync(parentAbs, fsConstants.W_OK)
  } catch { return fail('parent_invalid') }
  const parent = realOrNull(parentAbs)
  if (!parent) return fail('parent_invalid')
  const target = join(parent, folder)
  if (dirname(target) !== parent || basename(target) !== folder) return fail('name_invalid')
  try { mkdirSync(target) } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EEXIST' ? fail('path_exists') : fail('io', (e as Error).message)
  }
  const now = ctx.now ?? Date.now()
  const marker: LocalUnitMarker = { schema: 1, id: (ctx.newId ?? randomUUID)(), name, icon: cleanIcon(ctx.icon), channel: ctx.channel, createdAt: now }
  const undo = (): void => { try { rmSync(target, { recursive: true, force: true }) } catch { /* 留着也只是个空壳 */ } }
  try {
    const p = localUnitPaths(target)
    for (const d of [p.home, p.appData, p.workspace]) mkdirSync(d)
    writeLocalUnitMarker(target, marker)
  } catch (e) { undo(); return fail('io', (e as Error).message) }
  const r = await mutateLocalUnitRegistry(ctx.registryFile, (reg) => ({
    next: { schema: 1, units: [...reg.units.filter((u) => u.id !== marker.id), { id: marker.id, path: target, addedAt: now }] },
    result: null,
  }))
  if (!r.ok) { undo(); return r }
  return { ok: true, unit: rowFor({ id: marker.id, path: target }, ctx) }
}

/**
 * 加入一个已有的 Unit 文件夹。四种情形(id 以标记文件为准):
 *   · 名册里没有这个 id → 登记;
 *   · 同 id 同一个文件夹 → 成功,不重复登记;
 *   · 同 id 已登记在**另一个仍然存在、标记 id 也相同**的文件夹上 → duplicate_id(多半是拷贝出来的;这一步不替谁改身份);
 *   · 同 id 登记的原文件夹不在了(或那里的标记已不是这个 id)→ 当搬家,改名册里的路径。
 */
export async function addExistingLocalUnit(ctx: LocalUnitsContext & { dir: unknown; now?: number }): Promise<LocalUnitsResult<{ unit: LocalUnitRow }>> {
  if (typeof ctx.dir !== 'string' || !isAbsolute(ctx.dir)) return fail('not_a_unit')
  const dir = realOrNull(ctx.dir)
  if (!dir) return fail('not_a_unit')
  const marker = readLocalUnitMarker(dir)
  if (!marker) return fail('not_a_unit')
  if (marker.channel !== ctx.channel) return fail('channel_mismatch')
  if (!localUnitFolderSafe(dir)) return fail('not_a_unit', 'a sub-folder is a link or a file')
  const now = ctx.now ?? Date.now()
  const r = await mutateLocalUnitRegistry(ctx.registryFile, (reg) => {
    const existing = reg.units.find((u) => u.id === marker.id)
    if (!existing) return { next: { schema: 1, units: [...reg.units, { id: marker.id, path: dir, addedAt: now }] }, result: 'added' as const }
    if (sameFolder(existing.path, dir)) return { result: 'same' as const }
    const there = readLocalUnitMarker(existing.path)
    if (there && there.id === marker.id) return { result: 'duplicate' as const }
    return { next: { schema: 1, units: reg.units.map((u) => (u.id === marker.id ? { ...u, path: dir } : u)) }, result: 'moved' as const }
  })
  if (!r.ok) return r
  if (r.result === 'duplicate') return fail('duplicate_id')
  return { ok: true, unit: rowFor({ id: marker.id, path: dir }, ctx) }
}

/** 改名字 / 图标:只写标记文件(持名册锁,和别的实例的写排同一条队);运行中的那份下次 list 读到。 */
export async function renameLocalUnit(ctx: LocalUnitsContext & { id: unknown; patch: unknown }): Promise<LocalUnitsResult<{ unit: LocalUnitRow }>> {
  if (!isLocalUnitId(ctx.id)) return fail('not_found')
  const id = ctx.id
  const patch = (ctx.patch && typeof ctx.patch === 'object' ? ctx.patch : {}) as { name?: unknown; icon?: unknown }
  const name = patch.name === undefined ? undefined : typeof patch.name === 'string' ? patch.name.trim() : null
  if (name !== undefined && (name === null || !isValidLocalUnitName(name))) return fail('name_invalid')
  const r = await mutateLocalUnitRegistry(ctx.registryFile, (reg, mine): { result: Fail | { ok: true; path: string } } => {
    const entry = reg.units.find((u) => u.id === id)
    if (!entry) return { result: fail('not_found') }
    const marker = readLocalUnitMarker(entry.path)
    if (!marker) return { result: fail('not_a_unit', 'folder or marker file is missing') }
    if (marker.channel !== ctx.channel) return { result: fail('channel_mismatch') }
    if (marker.id !== id) return { result: fail('not_a_unit', 'marker id does not match') }
    const next: LocalUnitMarker = { ...marker, ...(name ? { name } : {}), ...(patch.icon !== undefined ? { icon: cleanIcon(patch.icon) } : {}) }
    try { writeLocalUnitMarker(entry.path, next, mine) } catch (e) { return { result: fail('io', (e as Error).message) } }
    return { result: { ok: true, path: entry.path } }
  })
  if (!r.ok) return r
  if (!r.result.ok) return r.result
  return { ok: true, unit: rowFor({ id, path: r.result.path }, ctx) }
}

/** 从列表移除:只删名册条目,文件夹不动。对自己 → is_self。 */
export async function removeLocalUnit(ctx: LocalUnitsContext & { id: unknown }): Promise<LocalUnitsResult> {
  if (!isLocalUnitId(ctx.id)) return fail('not_found')
  const id = ctx.id
  if (ctx.self?.id === id) return fail('is_self')
  const r = await mutateLocalUnitRegistry(ctx.registryFile, (reg) => {
    if (!reg.units.some((u) => u.id === id)) return { result: false }
    return { next: { schema: 1, units: reg.units.filter((u) => u.id !== id) }, result: true }
  })
  if (!r.ok) return r
  return r.result ? { ok: true } : fail('not_found')
}

// ── 拉起别的实例 ──────────────────────────────────────────────────────────────────────

/** 拉起默认那台 / 别的文件夹 Unit 前先清掉的环境变量:它们都是「这一份」的身份或重定向,带过去就会让对方住进这一份的目录、
 *  连这一份的引擎或助手。插件沙箱的父子约定(FORSION_SANDBOX*)同理。 */
const SPAWN_ENV_STRIP = /^(TANGU_HOME|FORSION_WORKSPACE_DIR|FORSION_SANDBOX.*|PI_CU_SOCKET_PATH|TANGU_BACKEND_URL|TANGU_BROWSER_EXTENSION(_PORT)?|FORSION_UNIT.*|ELECTRON_RUN_AS_NODE)$/
export function localUnitSpawnEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {}
  for (const [k, v] of Object.entries(env)) if (!SPAWN_ENV_STRIP.test(k)) out[k] = v
  return out
}

/** 拉起参数:开发版的 appPath、这一家实例共用的 --user-data-dir(只在本进程启动时就带着它时才转交:它定的是「哪一台是默认那台」,
 *  台架靠它隔离;安装版平时没有)、目标 Unit 的 id、退出请求、要转交给默认那台的链接 / 文件。 */
export function localUnitSpawnArgs(o: { appArgs: readonly string[]; userDataDirSwitch?: string | null; unitId?: string; quit?: boolean; forward?: readonly string[] }): string[] {
  if (o.unitId !== undefined && !isLocalUnitId(o.unitId)) throw new Error('invalid local Unit id')
  return [
    ...o.appArgs,
    ...(o.userDataDirSwitch ? [`--user-data-dir=${o.userDataDirSwitch}`] : []),
    ...(o.unitId ? [`${LOCAL_UNIT_ARG}=${o.unitId}`] : []),
    ...(o.quit ? [LOCAL_UNIT_QUIT_ARG] : []),
    ...(o.forward ?? []),
  ]
}
