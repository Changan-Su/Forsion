/**
 * /unit/host{file,dir,stat} 的路径钳制(远端只读面,设备页 Desk / 文件卡 / 工作台文件面板的数据源)。
 *
 * 可读范围 = 工作区根 ∪ vault 根 ∪ host 会话的 project_path。project_path 是远端经允许清单里的
 * POST /agent/sessions、PATCH /agent/sessions/:id 就能写的自由字符串 —— 只凭「在某个根里」放行,远端把
 * 某会话的 project_path 改成家目录,就能读走 ~/.forsion/auth.json(评审 A-desktop#1,契约 C4 / 方案 §6.4-1)。
 * 两道闸,都在 realpath 之后:
 *   ① 会话根过滤:`/`(及 Windows 盘根)、家目录、任何受保护目录的祖先 —— 一律不算根;
 *   ② 受保护路径硬拒:不管从哪个根进来(工作区 / vault 也一样),落在受保护目录内一律 null。
 * 刻意零 electron 依赖:路径集合由 main.ts 注入,vitest 直测(electron/unitHostScope.test.ts)。
 */
import { constants as fsConstants, realpathSync, type Stats } from 'node:fs'
import { lstat, open, stat, type FileHandle } from 'node:fs/promises'
import { dirname, isAbsolute, join, parse, relative, resolve } from 'node:path'

export interface UnitScopeEnv {
  home: string
  /** forsionHomeDir():当前实例的 Forsion 共享域(auth.json / provider-auth.json / config.json / secrets …)。 */
  forsionHome: string
  /** 引擎 home(TANGU_HOME,缺省 = forsionHome/tangu)。 */
  tanguHome?: string
  /** Electron userData(tangu-desktop-config.json:unitHostSecret、配对设备 hash)。 */
  userData?: string
  /** Electron appData:推出正式版 / dev / 旧包名的 userData 兄弟目录(另一实例的壳层配置同样是凭据)。 */
  appData?: string
  platform?: NodeJS.Platform
}

/** 另一实例 / 旧包名的 userData 目录名(main.ts readShellConfig 的迁移源 + 打包版 productName)。
 *  与引擎 hostSandboxProtection.USERDATA_NAMES 同一张表(electron/unitUserDataNamesSync.test.ts 钉住),两边都再各配一个 `-dev` 变体
 *  (main.ts 未打包时 setPath(userData + '-dev'):每个历史包名的开发版目录都可能在)。 */
const USERDATA_SIBLINGS = ['Forsion', 'forsion-desktop', 'forsion-desktop-dev', 'tangu-agent-desktop', 'tangu-agent-desktop2', 'Tangu Agent', 'Tangu Agent 2.0']
/** 兄弟 userData 目录名(含 `-dev` 变体),与引擎 desktopUserDataDirs 同一展开口径。 */
export const USERDATA_SIBLING_DIRS: readonly string[] = [...new Set(USERDATA_SIBLINGS.flatMap((n) => [n, `${n}-dev`]))]

/** 家目录下的通用凭据库(与 Forsion 无关,但远端读到同样是凭据外泄)。 */
const HOME_CREDENTIAL_DIRS = [
  '.ssh', '.aws', '.gnupg', '.kube', '.docker', '.config', '.codex', '.claude', '.agents',
  '.netrc', '.npmrc', '.pypirc', '.git-credentials',
  join('Library', 'Keychains'), join('Library', 'Cookies'),
]

const foldCase = (platform: NodeJS.Platform): boolean => platform === 'darwin' || platform === 'win32'
const norm = (p: string, platform: NodeJS.Platform): string => (foldCase(platform) ? resolve(p).toLowerCase() : resolve(p))

/** child 等于 parent 或在其内(realpath 之后的字面路径;darwin / win32 不分大小写)。 */
export function isWithin(child: string, parent: string, platform: NodeJS.Platform = process.platform): boolean {
  const c = norm(child, platform)
  const p = norm(parent, platform)
  if (c === p) return true
  const rel = relative(p, c)
  return !!rel && !rel.startsWith('..') && !isAbsolute(rel)
}

const realOr = (p: string): string => { try { return realpathSync(p) } catch { return resolve(p) } }
const bothForms = (p: string): string[] => [...new Set([resolve(p), realOr(p)])]

/** 钳制用的路径集合:受保护目录 + 引擎 home 里的 Library 例外(字面与 realpath 两种形态都收 ——
 *  ~/.tangu 是指向 ~/.forsion 的软链,mac 的 tmp 在 /private/var 下)。 */
export interface UnitScopeGuard {
  protectedPaths: string[]
  /** 引擎 home:其下 {agents,teams,engines}/<x>/Library/** 是 Agent 私聊的工作目录(agentLoop 把私聊 cwd
   *  钉在 libDirOf(slug)),产物要在设备页 Desk / 文件卡里预览 —— 与引擎 C4 远程写的例外同口径,
   *  但 Library 里的 .tangu / .forsion 控制目录不算。凭据文件都不在 Library 下。 */
  libraryBases: string[]
}

export function buildUnitScopeGuard(env: UnitScopeEnv): UnitScopeGuard {
  const h = env.home
  const tanguHome = env.tanguHome || join(env.forsionHome, 'tangu')
  const raw = [
    env.forsionHome,
    join(h, '.forsion'), join(h, '.forsion-dev'), join(h, '.tangu'),
    tanguHome,
    ...(env.userData ? [env.userData] : []),
    ...(env.appData ? USERDATA_SIBLING_DIRS.map((d) => join(env.appData!, d)) : []),
    ...HOME_CREDENTIAL_DIRS.map((d) => join(h, d)),
  ]
  return { protectedPaths: [...new Set(raw.flatMap(bothForms))], libraryBases: bothForms(tanguHome) }
}

const LIBRARY_KINDS = new Set(['agents', 'teams', 'engines'])
const CONTROL_DIRS = new Set(['.tangu', '.forsion'])

export function isUnitProtected(real: string, guard: UnitScopeGuard, platform: NodeJS.Platform = process.platform): boolean {
  if (!guard.protectedPaths.some((p) => isWithin(real, p, platform))) return false
  const fold = (x: string): string => (foldCase(platform) ? x.toLowerCase() : x)
  for (const base of guard.libraryBases) {
    if (!isWithin(real, base, platform)) continue
    const segs = relative(norm(base, platform), norm(real, platform)).split(/[\\/]+/).filter(Boolean)
    if (segs.length >= 3 && LIBRARY_KINDS.has(segs[0]) && segs[2] === fold('Library') && !segs.slice(3).some((x) => CONTROL_DIRS.has(x))) return false
  }
  return true
}

/** 会话根过滤:文件系统根 / 家目录 / 任何受保护目录的祖先(含等于)都不能当可读根。 */
export function filterSessionRoots(roots: string[], env: Pick<UnitScopeEnv, 'home' | 'platform'>, guard: UnitScopeGuard): string[] {
  const platform = env.platform ?? process.platform
  const homes = bothForms(env.home).map((x) => norm(x, platform))
  return roots.filter((r) => {
    const abs = resolve(r)
    if (abs === parse(abs).root) return false
    if (homes.includes(norm(abs, platform))) return false
    if (guard.protectedPaths.some((p) => isWithin(p, abs, platform))) return false
    return true
  })
}

/**
 * 钳制主体:real 必须是 realpath 之后的路径。base = 工作区 / vault(本机配置的,原样当根);
 * session = host 会话 project_path(远端可写,先过 filterSessionRoots)。受保护路径无条件拒。
 * allowRoot:目录类操作(list / stat)可指根本身;文件读不可(根是目录)。
 */
export function unitPathInScope(
  real: string,
  roots: { base: string[]; session: string[] },
  env: Pick<UnitScopeEnv, 'home' | 'platform'>,
  guard: UnitScopeGuard,
  allowRoot: boolean,
): boolean {
  const platform = env.platform ?? process.platform
  if (isUnitProtected(real, guard, platform)) return false
  const all = [...roots.base, ...filterSessionRoots(roots.session, env, guard)]
  return all.some((r) => (norm(r, platform) === norm(real, platform) ? allowRoot : isWithin(real, r, platform)))
}

/** main.ts 的 /unit/host* 入口:realpath(不存在 = null)→ unitPathInScope。 */
export function resolveUnitHostPath(
  p: unknown,
  roots: { base: string[]; session: string[] },
  env: Pick<UnitScopeEnv, 'home' | 'platform'>,
  guard: UnitScopeGuard,
  allowRoot: boolean,
): string | null {
  if (!p || typeof p !== 'string') return null
  let real: string
  try { real = realpathSync(p) } catch { return null }
  return unitPathInScope(real, roots, env, guard, allowRoot) ? real : null
}

const sameObject = (a: Stats, b: Stats): boolean => a.dev === b.dev && a.ino === b.ino

/** 测试接缝:在「校验通过」与「打开」之间 / 打开之后插一脚(模拟换软链的竞态)。生产不传。 */
export interface UnitRaceHooks { beforeOpen?: () => unknown; afterOpen?: () => unknown }

/**
 * 文件读:校验与读取绑在同一个打开对象上(Codex 三轮 P1:realpath 校验之后再按路径 stat / readFile,
 * 中间把某一段换成指向 ~/.forsion 的软链就能读走凭据)。
 *   ① resolveUnitHostPath(realpath + 钳制);② open(O_NOFOLLOW,末段是软链直接失败);
 *   ③ 打开之后再 realpath 一次重新钳制,并比对 fd 与该路径的 (dev, ino) —— 中间段被换、或换过去又换回来都对不上。
 * 调用方只能经返回的 FileHandle 读,用完 close。残余:hard link(同引擎 C4,路径口径拦不住)。
 */
export async function openUnitHostFile(
  p: unknown,
  roots: { base: string[]; session: string[] },
  env: Pick<UnitScopeEnv, 'home' | 'platform'>,
  guard: UnitScopeGuard,
  hooks?: UnitRaceHooks,
): Promise<{ fh: FileHandle; real: string; st: Stats } | null> {
  const real = resolveUnitHostPath(p, roots, env, guard, false)
  if (!real) return null
  await hooks?.beforeOpen?.()
  let fh: FileHandle
  try { fh = await open(real, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0)) } catch { return null }
  try {
    await hooks?.afterOpen?.()
    const st = await fh.stat()
    const again = resolveUnitHostPath(real, roots, env, guard, false)
    if (again !== real || !sameObject(st, await stat(again))) { await fh.close(); return null }
    return { fh, real, st }
  } catch {
    await fh.close().catch(() => {})
    return null
  }
}

/**
 * /unit/hostfile(预览,base64 JSON)与 /unit/hostfile/download(下载原文件,流式)共用的**唯一**文件解析(P1-DL):
 * openUnitHostFile(realpath 钳制在根内 ∪ 受保护 / 凭据路径硬拒 ∪ 校验与读取绑同一 FileHandle)再要求普通文件。
 * 两条路只许经它拿文件,判据永不分叉(main.ts 的 readHostFile / openHostFile 都调它)。句柄归调用方关闭。
 */
export async function openUnitHostRegularFile(
  p: unknown,
  roots: { base: string[]; session: string[] },
  env: Pick<UnitScopeEnv, 'home' | 'platform'>,
  guard: UnitScopeGuard,
  hooks?: UnitRaceHooks,
): Promise<{ fh: FileHandle; real: string; st: Stats } | null> {
  const opened = await openUnitHostFile(p, roots, env, guard, hooks)
  if (!opened) return null
  if (!opened.st.isFile()) { await opened.fh.close().catch(() => {}); return null }
  return opened
}

/** real 所在的(最深的)可读根;没有 = null。 */
function matchedUnitRoot(
  real: string,
  roots: { base: string[]; session: string[] },
  env: Pick<UnitScopeEnv, 'home' | 'platform'>,
  guard: UnitScopeGuard,
): string | null {
  const platform = env.platform ?? process.platform
  const hits = [...roots.base, ...filterSessionRoots(roots.session, env, guard)].filter((r) => isWithin(real, r, platform))
  return hits.sort((a, b) => b.length - a.length)[0] ?? null
}

/**
 * 路径链指纹:从 real 一路往上到它所在的根(含),每一段记 (dev, ino),每一段的**父目录**记 (dev, ino, mtimeNs, ctimeNs)(lstat,不跟软链)。
 * 「换过去、读、再换回来」要在某个父目录里至少改名 / 删建两次 —— 那个父目录的 mtime 必然变(macOS APFS 实测 2000/2000 次都变);
 * 用 utimes 把 mtime 改回去也没用:utimes 本身会把 ctime 刷成「现在」,而 macOS / Linux 上 ctime 用户态设不回去(Codex r3 #3)。
 * ⚠️ Windows 例外:SetFileInformationByHandle 能直接写 ChangeTime,有目录写权限的进程可以把两种时间都恢复 —— 写明的残余,见下。
 * 所以读前读后指纹一致 = 读的那一刻路径上没有被换过。
 */
async function chainFingerprint(real: string, root: string, platform: NodeJS.Platform): Promise<string> {
  const parts: string[] = []
  let c = real
  for (;;) {
    const st = await lstat(c, { bigint: true })
    const parent = dirname(c)
    const ps = await lstat(parent, { bigint: true })
    parts.push(`${st.dev}:${st.ino}|${ps.dev}:${ps.ino}:${ps.mtimeNs}:${ps.ctimeNs}`)
    if (norm(c, platform) === norm(root, platform) || parent === c) break
    c = parent
  }
  return parts.join('/')
}

/** 读前读后指纹对不上时的重试次数:路径上的父目录有正常写入(同目录新建 / 删除文件)也会让 mtime 变,不能一次就判死。 */
const VERIFY_ATTEMPTS = 3

/**
 * 目录列表 / stat:Node 没有按 fd 枚举目录的 API(macOS 的 /dev/fd/N 对目录是 ENOTDIR,实测),改为「前后各核一次」——
 * 读之前记下路径链指纹(每一段的对象身份 + 每个父目录的 mtime),读完再 realpath 钳制、再取指纹比对:
 *   · 换过软链没换回来 → realpath 复核落进受保护目录 / 对象身份变了 → null;
 *   · 换过去、读、又换回来(Codex 终审 out1 #4)→ 换的那一层父目录 mtime 变了 → 指纹不等 → 重试,仍不等 → null。
 * 残余(写明):① 时间戳粒度粗的文件系统(Linux 多数 fs 按 jiffy 取时间,约 1–10ms)上,同一个时钟刻内完成的换过去 + 换回来
 * 看不出来;② Windows 上能写 ChangeTime 的进程可以连 ctime 一起恢复;①② 最多漏出受保护目录的**条目名 / 大小 / 时间**
 * (不含内容;文件内容走 openUnitHostFile 的 fd 绑定,不受此限),且都要求攻击者已能在本机跑代码、改工作区目录;
 * ③ 硬链接(同引擎 C4,路径口径拦不住)。
 */
export async function withVerifiedUnitPath<T>(
  p: unknown,
  roots: { base: string[]; session: string[] },
  env: Pick<UnitScopeEnv, 'home' | 'platform'>,
  guard: UnitScopeGuard,
  allowRoot: boolean,
  read: (real: string) => Promise<T>,
  hooks?: UnitRaceHooks,
): Promise<T | null> {
  const platform = env.platform ?? process.platform
  const real = resolveUnitHostPath(p, roots, env, guard, allowRoot)
  if (!real) return null
  const root = matchedUnitRoot(real, roots, env, guard)
  if (!root) return null
  try {
    for (let attempt = 0; attempt < VERIFY_ATTEMPTS; attempt++) {
      const before = await chainFingerprint(real, root, platform)
      await hooks?.beforeOpen?.()
      const out = await read(real)
      await hooks?.afterOpen?.()
      const again = resolveUnitHostPath(real, roots, env, guard, allowRoot)
      if (again !== real) return null
      if (before === (await chainFingerprint(real, root, platform))) return out
    }
    return null
  } catch {
    return null
  }
}
