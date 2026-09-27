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
import { open, stat, type FileHandle } from 'node:fs/promises'
import { isAbsolute, join, parse, relative, resolve } from 'node:path'

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

/** 另一实例 / 旧包名的 userData 目录名(main.ts readShellConfig 的迁移源 + 打包版 productName)。 */
const USERDATA_SIBLINGS = ['Forsion', 'forsion-desktop', 'forsion-desktop-dev', 'tangu-agent-desktop', 'tangu-agent-desktop2', 'Tangu Agent', 'Tangu Agent 2.0']

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
    ...(env.appData ? USERDATA_SIBLINGS.map((d) => join(env.appData!, d)) : []),
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
 * 目录列表 / stat:没有按 fd 枚举目录的 API,改为「前后各核一次」—— 读之前记下对象身份,读完再 realpath 钳制并比对,
 * 换过软链(没换回来)的一律 null。残余:换过去又在窗口内换回来,最多漏出受保护目录的**条目名 / 元数据**(不含内容)。
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
  const real = resolveUnitHostPath(p, roots, env, guard, allowRoot)
  if (!real) return null
  try {
    await hooks?.beforeOpen?.()
    const before = await stat(real)
    const out = await read(real)
    await hooks?.afterOpen?.()
    const again = resolveUnitHostPath(real, roots, env, guard, allowRoot)
    if (again !== real || !sameObject(before, await stat(again))) return null
    return out
  } catch {
    return null
  }
}
