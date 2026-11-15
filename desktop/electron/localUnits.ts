/**
 * 本机多 Unit · 主进程的盘上部分(名册、标记文件、运行记录、启动参数、拉起别的实例时的环境)。无 Electron 依赖,vitest 直测。
 * 共用的类型和纯函数在 shared/localUnits.ts;Electron 那一层(IPC、对话框、快捷方式、监视)在 localUnitsHost.ts。
 *
 * 落盘纪律:
 *   · 名册与标记都「唯一临时名 + fsync + rename」,不截断直写;
 *   · 名册的读改写跨进程持锁(<名册>.lock,O_EXCL 建,内容 = <pid>-<uuid>;持锁进程还活着就永不回收,死了才原子地挪开,
 *     见 reclaimIfStale),锁内现读现改,提交前核一次锁还是自己的;
 *   · 读不出 ≠ 空:名册不存在(ENOENT)才是空名册;零字节、半截、结构不对、没权限一律「不知道」,所有写操作回 registry_unreadable,
 *     绝不按空名册写回去;
 *   · 标记文件分四种:不存在(ENOENT / ENOTDIR)、有效、对不上(别的 id / 通道)、读不出(没权限、坏 JSON)。
 *     只有「不存在」才可能当搬家;读不出一律当「不知道」,不据此改名册。名册里那一条照样留着,不替用户删。
 */
import { randomUUID } from 'node:crypto'
import {
  accessSync, closeSync, constants as fsConstants, fsyncSync, linkSync, lstatSync, mkdirSync, openSync, readFileSync, realpathSync,
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
import { legacyDevUnitsParent, machineDataRoots } from './clearDataPaths'
import { dirIdentity, sameDevIno } from './dirIdentity'
import { guardConflict, pathRelation, type PathGuard } from './pathOverlap'
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

/**
 * 「新建」的缺省父目录:安装版 ~/Forsion Units,开发版 ~/.forsion-dev-units(开发版绝不落到安装版那里)。
 * 开发版不放进 ~/.forsion-dev 里面:那是开发版默认那台的 home,清它的数据会把里面的 Unit 一起删掉。
 * 早先建在 ~/.forsion-dev/units 下的老 Unit 按路径登记着,照样能开(见 localUnitGuard 的 legacyParents)。
 */
export function localUnitsDefaultParent(isPackaged: boolean, home = homedir()): string {
  return isPackaged ? join(home, 'Forsion Units') : join(home, '.forsion-dev-units')
}

/**
 * 文件夹 Unit 的文件夹(及 home / app-data / Forsion)不许和这些沾边:默认那台的 home、userData、工作区(安装版与开发版两套)、
 * 旧的 ~/.tangu、~/Tangu、默认那台启动时的 TANGU_HOME / FORSION_WORKSPACE_DIR 重定向;也不许就是家目录或盖住家目录。
 * 加入、新建、打开、启动都过这一道(启动时在改 userData / home 之前算)。
 */
export function localUnitGuard(o: { home: string; startupUserData: string; envTanguHome?: string; envWorkspace?: string }): PathGuard {
  const env = [o.envTanguHome, o.envWorkspace].filter((v): v is string => !!v && isAbsolute(v))
  return {
    strict: [...machineDataRoots(o.home), defaultUserDataDir(o.startupUserData, true), defaultUserDataDir(o.startupUserData, false), ...env],
    cover: [o.home],
    legacyParents: [legacyDevUnitsParent(o.home)],
  }
}

/** 这个文件夹(连同三个子目录)和默认那台的数据沾边 → 回冲突的那条;不沾边 → null。 */
export function localUnitOverlap(dir: string, guard: PathGuard | undefined): string | null {
  if (!guard) return null
  const p = localUnitPaths(dir)
  for (const x of [p.dir, p.home, p.appData, p.workspace]) {
    const clash = guardConflict(x, guard)
    if (clash) return clash
  }
  return null
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

/** 锁文件内容 = `<pid>-<uuid>`;读出持锁进程的 pid(内容不是这个样子 → null)。 */
const lockHolderPid = (token: string): number | null => {
  const m = /^(\d+)-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.exec(token)
  return m ? Number(m[1]) : null
}

/** 测试与台架用的接缝:判活、等锁上限、以及「判定陈旧之后、真去挪之前」那一刻(复现交错用)。 */
export interface RegistryLockOptions {
  alive?: (pid: number) => boolean
  waitMs?: number
  beforeReclaim?: (lock: string, staleToken: string) => void
}

/**
 * 锁被占着时要不要回收(同一台电脑上的进程,按 pid 判活,不按 mtime):
 *  · 持锁进程还活着 → 永不回收,等它放;
 *  · 死了 → 回收;内容读不出 / 不是 `<pid>-<uuid>`(刚建、token 还没写进去)→ 只有过了 10 秒仍是这样才算陈旧。
 * 回收是原子的:把锁 rename 到一边,再核挪走的正是刚才判陈旧的那一份;不是(别人已回收并拿到了新锁)→ 用 link 原样放回
 * (link 不覆盖:要是这期间又有人建了锁,放不回去,被挪走的那位持锁者在提交前核 mine() 时发现、放弃这次写)。
 */
// 已知余量(不再加码):三个写者恰好交错时仍有一个极窄的窗口 —— B 判陈旧后挪走的已是 A 刚拿到的新锁、还没放回去之前,C 抢到锁
// 并提交,而 A 此前已核过 mine(),随后的 rename 会盖掉 C 的那一次。最坏结果是名册里少一条(那台 Unit 的文件夹原样不动,
// 再「加入已有的」一次即可),不会坏掉名册、也不会删任何文件夹。
function reclaimIfStale(lock: string, o: RegistryLockOptions): void {
  let token: string
  let mtimeMs: number
  try { token = readFileSync(lock, 'utf8'); mtimeMs = statSync(lock).mtimeMs } catch { return } // 刚被放掉:回去重抢
  const pid = lockHolderPid(token)
  if (pid !== null ? (o.alive ?? pidAlive)(pid) : Date.now() - mtimeMs < REGISTRY_LOCK_STALE_MS) return
  try { if (readFileSync(lock, 'utf8') !== token) return } catch { return } // 再核一眼,缩小窗口
  o.beforeReclaim?.(lock, token)
  const aside = `${lock}.stale-${process.pid}-${randomUUID()}`
  try { renameSync(lock, aside) } catch { return }
  let moved: string | null = null
  try { moved = readFileSync(aside, 'utf8') } catch { /* 读不出:按「不是那一份」处理 */ }
  if (moved !== token) {
    try { linkSync(aside, lock) } catch { /* 已有新锁:放不回去,见上 */ }
  }
  try { rmSync(aside, { force: true }) } catch { /* 留个孤儿文件,不影响锁 */ }
}

/** 持名册锁跑一段**同步**的读改写(持锁期间不让出事件循环)。等锁超过 5 秒抛错,绝不无锁硬写。 */
export async function withRegistryLock<T>(file: string, fn: (mine: () => boolean) => T, o: RegistryLockOptions = {}): Promise<T> {
  const lock = `${file}.lock`
  const token = `${process.pid}-${randomUUID()}`
  const deadline = Date.now() + (o.waitMs ?? REGISTRY_LOCK_WAIT_MS)
  mkdirSync(dirname(file), { recursive: true })
  for (;;) {
    let fd: number
    try {
      fd = openSync(lock, 'wx')
    } catch (e) {
      if (!LOCK_BUSY.has((e as NodeJS.ErrnoException).code ?? '')) throw e
      reclaimIfStale(lock, o)
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

type Fail = { ok: false; code: LocalUnitsErrorCode; message?: string; detail?: string }
/** 失败:detail = 只进日志的原文(errno、内部原因,英文,不给人看)。 */
const fail = (code: LocalUnitsErrorCode, detail?: string): Fail => (detail ? { ok: false, code, detail } : { ok: false, code })
/** 失败并带一句给人看的话:message 必须已按界面语言翻好(ctx.text → 主进程 mt),渲染层原样显示。 */
const failSay = (code: LocalUnitsErrorCode, message: string, detail?: string): Fail => ({ ok: false, code, message, ...(detail ? { detail } : {}) })

/** 锁内现读名册交给 fn;fn 回 next 就原子写回。名册读不出 → registry_unreadable,fn 不跑、什么都不写。 */
export async function mutateLocalUnitRegistry<R>(
  file: string,
  fn: (registry: LocalUnitRegistry, mine: () => boolean) => { next?: LocalUnitRegistry; result: R },
  lockOptions?: RegistryLockOptions,
): Promise<{ ok: true; result: R } | Fail> {
  try {
    return await withRegistryLock(file, (mine) => {
      const read = readLocalUnitRegistry(file)
      if (read.state !== 'ok') return fail('registry_unreadable', read.error)
      const { next, result } = fn(read.registry, mine)
      if (next) writeAtomicSync(file, `${JSON.stringify(next, null, 2)}\n`, mine)
      return { ok: true as const, result }
    }, lockOptions)
  } catch (e) {
    return fail('io', e instanceof Error ? e.message : String(e))
  }
}

// ── 标记文件 ──────────────────────────────────────────────────────────────────────────

export type LocalUnitMarkerRead =
  | { state: 'missing' }
  | { state: 'valid'; marker: LocalUnitMarker }
  | { state: 'unreadable'; error: string }

/** 标记文件:不存在(含文件夹不在了)= missing;读得出且结构对 = valid;别的(没权限、坏 JSON、结构不对)= unreadable。 */
export function readLocalUnitMarkerState(dir: string): LocalUnitMarkerRead {
  let raw: string
  try { raw = readFileSync(join(dir, LOCAL_UNIT_MARKER), 'utf8') } catch (e) {
    const code = (e as NodeJS.ErrnoException).code
    if (code === 'ENOENT' || code === 'ENOTDIR') return { state: 'missing' }
    return { state: 'unreadable', error: (e as Error).message }
  }
  let json: unknown
  try { json = JSON.parse(raw) } catch (e) { return { state: 'unreadable', error: `invalid JSON: ${(e as Error).message}` } }
  const marker = parseLocalUnitMarker(json)
  return marker ? { state: 'valid', marker } : { state: 'unreadable', error: 'unexpected marker shape' }
}
/** 只要有效的标记(missing / unreadable 都回 null:只在「拿不到就不做」的地方用)。 */
export function readLocalUnitMarker(dir: string): LocalUnitMarker | null {
  const r = readLocalUnitMarkerState(dir)
  return r.state === 'valid' ? r.marker : null
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
/**
 * 不看 pid 直接删。只在手里攥着这台 Unit 的单实例锁时调:锁在我们手里 = 它没在跑,剩下的记录是崩溃留下的
 * (pid 可能已被别的进程复用,判活会误判成「在跑」而一直挡住装更新)。
 */
export function dropStaleLocalUnitRunRecord(appData: string): void {
  try { rmSync(join(appData, LOCAL_UNIT_RUN_FILE), { force: true }) } catch { /* 删不掉:下次正常启动会覆盖 */ }
}
export function pidAlive(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false
  try { process.kill(pid, 0); return true } catch (e) { return (e as NodeJS.ErrnoException).code === 'EPERM' }
}
export type LocalUnitRunState = { state: 'running'; pid: number } | { state: 'stopped' } | { state: 'unknown'; error: string }

/**
 * 运行状态:没有运行记录(或文件夹不在了)= stopped;记录里的 pid 活着 = running、死了 = stopped;
 * 记录读不出 / 写坏了 = unknown(不知道 ≠ 没在跑:装更新与「从列表移除」都按在跑处理)。
 * 文件夹 Unit 启动时写不进运行记录就不往下跑(main.ts),所以「没有记录」才敢当没在跑。
 */
export function localUnitRunState(appData: string, alive: (pid: number) => boolean = pidAlive): LocalUnitRunState {
  let raw: string
  try { raw = readFileSync(join(appData, LOCAL_UNIT_RUN_FILE), 'utf8') } catch (e) {
    const code = (e as NodeJS.ErrnoException).code
    return code === 'ENOENT' || code === 'ENOTDIR' ? { state: 'stopped' } : { state: 'unknown', error: (e as Error).message }
  }
  let pid: unknown
  try { pid = (JSON.parse(raw) as { pid?: unknown })?.pid } catch (e) { return { state: 'unknown', error: `invalid JSON: ${(e as Error).message}` } }
  if (typeof pid !== 'number' || !Number.isSafeInteger(pid) || pid <= 0) return { state: 'unknown', error: 'run record has no pid' }
  return alive(pid) ? { state: 'running', pid } : { state: 'stopped' }
}
/** 记录里的 pid 还活着 → pid;别的 → null(只给「显示」用;要做决定的地方用 localUnitRunState)。 */
export function localUnitRunningPid(appData: string, alive: (pid: number) => boolean = pidAlive): number | null {
  const s = localUnitRunState(appData, alive)
  return s.state === 'running' ? s.pid : null
}

// ── 启动时的核对(只读,不建任何目录) ──────────────────────────────────────────────────

/** 启动被拒的原因(各有中英文说明);overlap = 文件夹和默认那台的数据沾边;unwritable = 运行记录写不进去;env_outside = 自己 .env 里的路径指出了文件夹(见 main.ts)。 */
export type LocalUnitLaunchRefusal = 'bad_arg' | 'registry_unreadable' | 'not_found' | 'missing' | 'mismatch' | 'channel_mismatch' | 'unsafe' | 'overlap' | 'unwritable' | 'env_outside'
export type LocalUnitLaunch =
  | { ok: true; id: string; marker: LocalUnitMarker; paths: LocalUnitPaths }
  | { ok: false; reason: LocalUnitLaunchRefusal }

/** 参数里的 id → 名册里的路径 → 标记文件的 id 与通道都对上、文件夹不和默认那台的数据沾边才放行。这一步只读,失败时盘上什么都不留下。 */
export function resolveLocalUnitLaunch(o: { id: string | null; registryFile: string; channel: LocalUnitChannel; guard?: PathGuard }): LocalUnitLaunch {
  if (!isLocalUnitId(o.id)) return { ok: false, reason: 'bad_arg' }
  const read = readLocalUnitRegistry(o.registryFile)
  if (read.state !== 'ok') return { ok: false, reason: 'registry_unreadable' }
  const entry = read.registry.units.find((u) => u.id === o.id)
  if (!entry || !isAbsolute(entry.path)) return { ok: false, reason: 'not_found' }
  const dir = realOrNull(entry.path)
  if (!dir) return { ok: false, reason: 'missing' }
  const m = readLocalUnitMarkerState(dir)
  if (m.state === 'missing') return { ok: false, reason: 'missing' }
  if (m.state === 'unreadable') return { ok: false, reason: 'mismatch' }
  if (m.marker.id !== o.id) return { ok: false, reason: 'mismatch' }
  if (m.marker.channel !== o.channel) return { ok: false, reason: 'channel_mismatch' }
  if (!localUnitFolderSafe(dir)) return { ok: false, reason: 'unsafe' }
  if (localUnitOverlap(dir, o.guard)) return { ok: false, reason: 'overlap' }
  return { ok: true, id: o.id, marker: m.marker, paths: localUnitPaths(dir) }
}

// ── 列表 ─────────────────────────────────────────────────────────────────────────────

export interface LocalUnitsContext {
  registryFile: string
  channel: LocalUnitChannel
  /** 当前进程是文件夹 Unit → 它的 id 与文件夹;默认那台 = null。 */
  self: { id: string; dir: string } | null
  home?: string
  alive?: (pid: number) => boolean
  /** 文件夹不许和默认那台的数据沾边(localUnitGuard);不给 = 不核(单测)。 */
  guard?: PathGuard
  /** 给人看的几句说明(主进程按界面语言给中英文);不给 = 英文。 */
  text?: (key: LocalUnitsTextKey) => string
  lockOptions?: RegistryLockOptions
}

/** 主进程按界面语言翻译的说明(渲染层把 message 原样给用户看的那几种)。 */
export type LocalUnitsTextKey = 'removeRunning' | 'overlapsDefault' | 'originalMarkerUnreadable'
const TEXT_FALLBACK: Record<LocalUnitsTextKey, string> = {
  removeRunning: 'This Unit is open (or its state is unknown). Close it before removing it from the list.',
  overlapsDefault: "This folder overlaps this computer's own Forsion data or your home folder, so it can't be used as a Unit.",
  originalMarkerUnreadable: "The folder this Unit is registered at can't be read right now, so Forsion can't tell whether this is a copy. Nothing was changed.",
}
const textOf = (ctx: LocalUnitsContext, k: LocalUnitsTextKey): string => ctx.text?.(k) ?? TEXT_FALLBACK[k]

function rowFor(entry: { id: string; path: string }, ctx: LocalUnitsContext): LocalUnitRow {
  const home = ctx.home ?? homedir()
  const current = ctx.self?.id === entry.id
  const base = { id: entry.id, path: entry.path, displayPath: localUnitDisplayPath(entry.path, home), current }
  const m = readLocalUnitMarkerState(entry.path)
  if (m.state === 'missing') return { ...base, name: basename(entry.path), icon: '', state: 'missing' }
  if (m.state === 'unreadable') return { ...base, name: basename(entry.path), icon: '', state: 'mismatch' }
  const marker = m.marker
  if (marker.id !== entry.id || marker.channel !== ctx.channel) return { ...base, name: marker.name, icon: marker.icon, state: 'mismatch' }
  // 运行记录读不出 = 不知道:按在跑显示(和装更新、从列表移除同一口径)
  const running = current || localUnitRunState(localUnitPaths(entry.path).appData, ctx.alive).state !== 'stopped'
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
  const m = readLocalUnitMarkerState(entry.path)
  if (m.state === 'missing') return fail('not_a_unit', 'folder or marker file is missing')
  if (m.state === 'unreadable') return fail('not_a_unit', `marker file can't be read: ${m.error}`)
  const marker = m.marker
  if (marker.channel !== ctx.channel) return fail('channel_mismatch')
  if (marker.id !== id) return fail('not_a_unit', 'marker id does not match')
  if (!localUnitFolderSafe(entry.path)) return fail('not_a_unit', 'a sub-folder is a link or a file')
  if (localUnitOverlap(entry.path, ctx.guard)) return failSay('not_a_unit', textOf(ctx, 'overlapsDefault'))
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
  if (localUnitOverlap(target, ctx.guard)) return failSay('parent_invalid', textOf(ctx, 'overlapsDefault')) // 比如父目录选在 ~/.forsion 里
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
  }), ctx.lockOptions)
  if (!r.ok) { undo(); return r }
  return { ok: true, unit: rowFor({ id: marker.id, path: target }, ctx) }
}

/**
 * 加入一个已有的 Unit 文件夹。四种情形(id 以标记文件为准):
 *   · 名册里没有这个 id → 登记;
 *   · 同 id 同一个文件夹 → 成功,不重复登记;
 *   · 同 id 已登记在**另一个仍然存在、标记 id 也相同**的文件夹上 → duplicate_id(多半是拷贝出来的;这一步不替谁改身份);
 *   · 同 id 登记的原文件夹不在了(标记文件不存在)、或那里是一份有效但**别的 id** 的标记 → 当搬家,改名册里的路径;
 *   · 原文件夹的标记读不出(没权限、写坏了)→ 不知道它是不是还在那儿:io,名册不动(绝不据此改路径)。
 * 选的文件夹本身和默认那台的数据沾边(就是家目录、在 ~/.forsion 里……)→ not_a_unit。
 */
export async function addExistingLocalUnit(ctx: LocalUnitsContext & { dir: unknown; now?: number }): Promise<LocalUnitsResult<{ unit: LocalUnitRow }>> {
  if (typeof ctx.dir !== 'string' || !isAbsolute(ctx.dir)) return fail('not_a_unit')
  const dir = realOrNull(ctx.dir)
  if (!dir) return fail('not_a_unit')
  const m = readLocalUnitMarkerState(dir)
  if (m.state === 'missing') return fail('not_a_unit')
  if (m.state === 'unreadable') return fail('not_a_unit', `marker file can't be read: ${m.error}`)
  const marker = m.marker
  if (marker.channel !== ctx.channel) return fail('channel_mismatch')
  if (!localUnitFolderSafe(dir)) return fail('not_a_unit', 'a sub-folder is a link or a file')
  if (localUnitOverlap(dir, ctx.guard)) return failSay('not_a_unit', textOf(ctx, 'overlapsDefault'))
  const now = ctx.now ?? Date.now()
  const r = await mutateLocalUnitRegistry(ctx.registryFile, (reg) => {
    const existing = reg.units.find((u) => u.id === marker.id)
    if (!existing) return { next: { schema: 1, units: [...reg.units, { id: marker.id, path: dir, addedAt: now }] }, result: 'added' as const }
    if (sameFolder(existing.path, dir)) return { result: 'same' as const }
    const there = readLocalUnitMarkerState(existing.path)
    if (there.state === 'unreadable') return { result: 'unknown' as const }
    if (there.state === 'valid' && there.marker.id === marker.id) return { result: 'duplicate' as const }
    return { next: { schema: 1, units: reg.units.map((u) => (u.id === marker.id ? { ...u, path: dir } : u)) }, result: 'moved' as const }
  }, ctx.lockOptions)
  if (!r.ok) return r
  if (r.result === 'duplicate') return fail('duplicate_id')
  if (r.result === 'unknown') return failSay('io', textOf(ctx, 'originalMarkerUnreadable'))
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
    const m = readLocalUnitMarkerState(entry.path)
    if (m.state === 'missing') return { result: fail('not_a_unit', 'folder or marker file is missing') }
    if (m.state === 'unreadable') return { result: fail('not_a_unit', `marker file can't be read: ${m.error}`) }
    const marker = m.marker
    if (marker.channel !== ctx.channel) return { result: fail('channel_mismatch') }
    if (marker.id !== id) return { result: fail('not_a_unit', 'marker id does not match') }
    const next: LocalUnitMarker = { ...marker, ...(name ? { name } : {}), ...(patch.icon !== undefined ? { icon: cleanIcon(patch.icon) } : {}) }
    try { writeLocalUnitMarker(entry.path, next, mine) } catch (e) { return { result: fail('io', (e as Error).message) } }
    return { result: { ok: true, path: entry.path } }
  }, ctx.lockOptions)
  if (!r.ok) return r
  if (!r.result.ok) return r.result
  return { ok: true, unit: rowFor({ id, path: r.result.path }, ctx) }
}

/**
 * 从列表移除:只删名册条目,文件夹不动。对自己 → is_self。
 * 它正开着(或运行记录读不出、说不准)→ io + 说明,不删:名册是「装更新前要关哪些」的唯一来源,从名册拿掉一台开着的,
 * 装更新时就漏关它。
 */
export async function removeLocalUnit(ctx: LocalUnitsContext & { id: unknown }): Promise<LocalUnitsResult> {
  if (!isLocalUnitId(ctx.id)) return fail('not_found')
  const id = ctx.id
  if (ctx.self?.id === id) return fail('is_self')
  const r = await mutateLocalUnitRegistry(ctx.registryFile, (reg): { next?: LocalUnitRegistry; result: 'removed' | 'not_found' | 'running' } => {
    const entry = reg.units.find((u) => u.id === id)
    if (!entry) return { result: 'not_found' }
    if (localUnitRunState(localUnitPaths(entry.path).appData, ctx.alive).state !== 'stopped') return { result: 'running' }
    return { next: { schema: 1, units: reg.units.filter((u) => u.id !== id) }, result: 'removed' }
  }, ctx.lockOptions)
  if (!r.ok) return r
  if (r.result === 'running') return failSay('io', textOf(ctx, 'removeRunning'))
  return r.result === 'removed' ? { ok: true } : fail('not_found')
}

// ── 装更新前关掉文件夹 Unit ──────────────────────────────────────────────────────────────

/**
 * 名册里的文件夹 Unit(自己除外)凡不是确定没在跑的(在跑 / 说不准)都发退出请求,最多等 timeoutMs。回还没确认关掉的个数;
 * 名册读不出 = -1(不知道 ≠ 没有在跑的)。
 * 每一轮按运行记录**重新判**(不是盯着最初那个 pid):退出请求要是拿到了那台的单实例锁,说明它根本没在跑,会顺手删掉崩溃留下的记录
 * (main.ts),这一台下一轮就判成 stopped、立刻从等待里拿掉 —— 不会因为记录里的 pid 被别的进程复用而白等 15 秒。
 * 局限:等的这 15 秒里有人从快捷方式新开了一台原本没开的 Unit,这里看不到它。
 */
export async function quitLocalUnitsForInstall(o: {
  registryFile: string
  selfId?: string | null
  requestQuit: (id: string) => void
  alive?: (pid: number) => boolean
  sleep?: (ms: number) => Promise<void>
  now?: () => number
  timeoutMs?: number
  log?: (m: string) => void
}): Promise<number> {
  const alive = o.alive ?? pidAlive
  const sleep = o.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)))
  const now = o.now ?? Date.now
  const read = readLocalUnitRegistry(o.registryFile)
  if (read.state !== 'ok') return -1
  const stateOf = (u: { path: string }): LocalUnitRunState => localUnitRunState(localUnitPaths(u.path).appData, alive)
  let left = read.registry.units.filter((u) => u.id !== o.selfId && stateOf(u).state !== 'stopped')
  for (const u of left) {
    const s = stateOf(u)
    o.log?.(`[local-units] asking Unit ${u.id} (${s.state === 'running' ? `pid ${s.pid}` : 'state unknown'}) to quit before installing the update`)
    o.requestQuit(u.id)
  }
  const deadline = now() + (o.timeoutMs ?? 15_000)
  while (left.length && now() < deadline) {
    await sleep(250)
    left = left.filter((u) => stateOf(u).state !== 'stopped')
  }
  return left.length
}

// ── 拉起别的实例 ──────────────────────────────────────────────────────────────────────

/**
 * 拉起默认那台 / 别的文件夹 Unit 前先清掉的环境变量 —— 都是「这一份」的东西(很多来自这一份 home 里的 .env),带过去就会让对方
 * 住进这一份的目录、用这一份的账号、连这一份的引擎或助手。对方从自己的配置(和自己 home 里的 .env)重建。按用途分四组:
 *   · 数据位置:TANGU_HOME、TANGU_DATA_DIR、TANGU_DEFAULT_WORKSPACE、FORSION_WORKSPACE_DIR、FORSION_AMADEUS_VAULT、
 *     FORSION_AMADEUS_CONFIG、FORSION_DESKTOP_CONFIG、FORSION_DEFAULT_CALENDAR(日历双向镜像)、FORSION_REMOTE_LOCK_FILE、
 *     TANGU_PLUGINS_DIR、TANGU_PROVIDERS_FILE、TANGU_WECHAT_STATE_DIR、TANGU_BROWSER_SOCKET_DIR、TANGU_IMPORT_HOME、
 *     FORSION_E2E_TRASH_DIR;
 *   · 账号与密钥:TANGU_TOKEN、TANGU_TOKEN_FILE(引擎会拿它盖掉宿主给的当前账号)、TANGU_LOCAL_TOKEN、TANGU_REMOTE_MARK_SECRET、
 *     TANGU_USER_ID;
 *   · 连到这一份的进程 / 端口:TANGU_BACKEND_URL、TANGU_PORT、TANGU_HOST、TANGU_MCP_OAUTH_PORT、TANGU_BROWSER_EXTENSION(_PORT)、
 *     PI_CU_SOCKET_PATH、FORSION_HOST_STDIN;
 *   · 身份 / 角色:FORSION_SANDBOX*、TANGU_SANDBOX、FORSION_UNIT*、ELECTRON_RUN_AS_NODE。
 * 留着的是整机通用的(云端地址、Node / bash / Python 路径、台架开关、开发版的渲染层地址……)。
 */
export const SPAWN_ENV_STRIP = new RegExp(`^(${[
  'TANGU_HOME', 'TANGU_DATA_DIR', 'TANGU_DEFAULT_WORKSPACE', 'FORSION_WORKSPACE_DIR', 'FORSION_AMADEUS_VAULT', 'FORSION_AMADEUS_CONFIG',
  'FORSION_DESKTOP_CONFIG', 'FORSION_DEFAULT_CALENDAR', 'FORSION_REMOTE_LOCK_FILE', 'TANGU_PLUGINS_DIR', 'TANGU_PROVIDERS_FILE',
  'TANGU_WECHAT_STATE_DIR', 'TANGU_BROWSER_SOCKET_DIR', 'TANGU_IMPORT_HOME', 'FORSION_E2E_TRASH_DIR',
  'TANGU_TOKEN', 'TANGU_TOKEN_FILE', 'TANGU_LOCAL_TOKEN', 'TANGU_REMOTE_MARK_SECRET', 'TANGU_USER_ID',
  'TANGU_BACKEND_URL', 'TANGU_PORT', 'TANGU_HOST', 'TANGU_MCP_OAUTH_PORT', 'TANGU_BROWSER_EXTENSION', 'TANGU_BROWSER_EXTENSION_PORT',
  'PI_CU_SOCKET_PATH', 'FORSION_HOST_STDIN',
  'FORSION_SANDBOX.*', 'TANGU_SANDBOX', 'FORSION_UNIT.*', 'ELECTRON_RUN_AS_NODE',
].join('|')})$`)
export function localUnitSpawnEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {}
  for (const [k, v] of Object.entries(env)) if (!SPAWN_ENV_STRIP.test(k)) out[k] = v
  return out
}

/**
 * .env 的读法,和引擎(tanguHome.loadTanguEnv)、桌面(main.ts loadTanguEnvFile)逐字一致:一行一条 KEY=VALUE,空行与 # 开头的跳过,
 * 没有 = 或 = 在行首的跳过,值两侧成对的单 / 双引号去掉。
 */
export function parseTanguEnvText(raw: string): Array<[string, string]> {
  const out: Array<[string, string]> = []
  for (const line of raw.split('\n')) {
    const t = line.trim()
    if (!t || t.startsWith('#')) continue
    const i = t.indexOf('=')
    if (i <= 0) continue
    const k = t.slice(0, i).trim()
    let v = t.slice(i + 1).trim()
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1)
    if (k) out.push([k, v])
  }
  return out
}

/** 文件夹 Unit 的 .env:引擎 home = <文件夹>/home/tangu(桌面的 tanguDataDir),.env 就在它下面 —— 引擎和桌面读的都是这一份。 */
export const localUnitEnvFile = (p: LocalUnitPaths): string => join(p.home, 'tangu', '.env')

/**
 * 文件夹 Unit 起来之前核它自己的 .env:下面这些指路径的变量(数据库、令牌文件、笔记库、日历、插件、工作区……)只要有一条指到
 * 本文件夹以外(或不是绝对路径),就不打开 —— 引擎启动后会自己再读一遍 .env,宿主在拉起时删掉的变量会被它原样补回来,
 * 那样就和别的 Unit 共用账号或数据了。空值(= 关)不算。.env 不存在或读不出:引擎和桌面也都当没有,这里同样放行。
 */
export const LOCAL_UNIT_ENV_PATH_KEYS: readonly string[] = [
  'TANGU_HOME', 'TANGU_DATA_DIR', 'TANGU_TOKEN_FILE', 'TANGU_DEFAULT_WORKSPACE', 'FORSION_WORKSPACE_DIR', 'FORSION_AMADEUS_VAULT',
  'FORSION_AMADEUS_CONFIG', 'FORSION_DESKTOP_CONFIG', 'FORSION_DEFAULT_CALENDAR', 'FORSION_REMOTE_LOCK_FILE', 'TANGU_PLUGINS_DIR',
  'TANGU_PROVIDERS_FILE', 'TANGU_WECHAT_STATE_DIR', 'TANGU_BROWSER_SOCKET_DIR', 'TANGU_IMPORT_HOME',
]
export function localUnitEnvOutside(p: LocalUnitPaths): { key: string; value: string; file: string } | null {
  const file = localUnitEnvFile(p)
  let raw: string
  try { raw = readFileSync(file, 'utf8') } catch { return null }
  for (const [key, value] of parseTanguEnvText(raw)) {
    if (!LOCAL_UNIT_ENV_PATH_KEYS.includes(key) || value === '') continue
    if (!isAbsolute(value) || pathRelation(value, p.dir) !== 'inside') return { key, value, file }
  }
  return null
}

/**
 * 文件夹 Unit 自己拉引擎时,指向某个文件的那几个变量必须落在本文件夹里:不在就丢掉,由宿主按这一份重新算(日历)或不给(令牌文件)。
 * 进程环境里本不该有(拉起时已清),这是第二道:从系统层面(Windows 用户环境变量、shell 导出)带进来的照样拦下。
 */
export const FOLDER_UNIT_PATH_ENV = ['FORSION_DEFAULT_CALENDAR', 'TANGU_TOKEN_FILE', 'TANGU_DATA_DIR', 'FORSION_AMADEUS_VAULT', 'TANGU_PLUGINS_DIR', 'TANGU_PROVIDERS_FILE', 'TANGU_WECHAT_STATE_DIR', 'TANGU_BROWSER_SOCKET_DIR'] as const

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
