/**
 * 应用内「卸载 / 清空数据」(app:clearData)要删哪些路径 —— 读盘核对、不删东西,单测用临时目录(含软链)钉住;真删在 main.ts。
 *
 *   · 这台电脑的主人(默认那台):引擎 home(显式 TANGU_HOME 时只删它本身,不删推导出的父目录)+ 默认工作区 + ~/.tangu、~/Tangu 兼容软链;
 *     名册里任何一台文件夹 Unit 的文件夹和要删的路径沾边(在里面 / 盖住 / 同一个,按真实路径比)→ 整个不删;名册读不出 → 也不删。
 *   · 插件沙箱:只删它自己的 home 与工作区(兼容软链是整机的,不归它管);
 *   · 文件夹 Unit:只删本文件夹下的 home/ 与 Forsion/,路径由文件夹本身推出,不看环境变量;
 *     每条都按**真实路径**核:不能是软链、必须就在本文件夹里(文件夹本身没被换掉),不能和默认那台的数据目录
 *     (~/.forsion、~/.forsion-dev、~/Forsion、~/Forsion-Dev、~/.tangu、~/Tangu、默认 userData)、别的 Unit 的文件夹沾边,
 *     不能是家目录或盖住家目录;说不准就算沾边。
 *   · 有一条不行 → 一条都不删(remove 为空,refused 列出原因),由调用方告诉用户。
 *   · 「桌面」那一半三种身份相同:只删自己 userData 下的几份壳层文件(整个 userData 被 Electron 占着,不整删;
 *     文件夹 Unit 的 userData 就是本文件夹的 app-data/)。
 * 计划只算一次;真删前每条只核它自己(verifyClearTarget):已经没了不算失败、软链只删链接、目录要还是原来那一个。
 */
import { lstatSync } from 'node:fs'
import { dirname, isAbsolute, join } from 'node:path'
import { LOCAL_UNIT_DIRS } from '../shared/localUnits'
import { dirIdentity, sameDevIno, type DirIdentity } from './dirIdentity'
import { guardConflict, pathRelation, realPathLoose, type PathGuard } from './pathOverlap'

export interface ClearDataInput {
  role: 'owner' | 'sandbox' | 'folder'
  tangu?: boolean
  desktop?: boolean
  /** process.env.TANGU_HOME(可空)。 */
  envTanguHome?: string
  forsionHome: string
  workspace: string
  userData: string
  /** userData 下要删的壳层文件名。 */
  desktopFiles: readonly string[]
  /** 系统用户目录(os.homedir())。 */
  home: string
  /** 文件夹 Unit 的文件夹(role = folder 时必填)。 */
  folderDir?: string
  /** 文件夹 Unit 启动时这个文件夹的身份:清数据时对不上(被换成了别的目录 / 软链)→ 不删。 */
  folderIdentity?: DirIdentity | null
  /** 名册里的文件夹 Unit(文件夹 Unit 自己那份除外)。null = 名册读不出(不知道 ≠ 没有)→ owner / folder 都不删。 */
  unitDirs?: readonly string[] | null
  /** 文件夹 Unit 另外绝不碰的根(默认那台的 userData 两种写法、启动时的 TANGU_HOME / 工作区重定向;main.ts 传 localUnitGuard 的 strict)。 */
  protectedRoots?: readonly string[]
}

export interface ClearRefusal { path: string; reason: 'not_absolute' | 'link' | 'moved' | 'overlap' | 'unit_inside' | 'registry_unreadable' | 'unverifiable'; with?: string }
/**
 * 要删的一条,连同算计划那一刻它在盘上是什么:dir(带 dev + ino)/ link(软链,只删链接本身,绝不跟进去)/ file / absent(那时还没有)。
 * scope 决定真删前要不要再核沾边:folder = 文件夹 Unit 的 home / Forsion;owner = 默认那台的 home / 工作区;plain = 不核(沙箱、壳层文件)。
 */
export interface ClearTarget { path: string; kind: 'dir' | 'link' | 'file' | 'absent'; id?: { dev: number; ino: number }; scope: 'folder' | 'owner' | 'plain' }
export interface ClearPlan { remove: string[]; targets: ClearTarget[]; refused: ClearRefusal[] }

/** 默认那台的数据根:文件夹 Unit 的清理绝不碰到它们(含它们里面的任何东西)。 */
export function machineDataRoots(home: string): string[] {
  return ['.forsion', '.forsion-dev', 'Forsion', 'Forsion-Dev', '.tangu', 'Tangu'].map((n) => join(home, n))
}
/** 旧的开发版缺省父目录(现在是 ~/.forsion-dev-units):已经登记在那里的老 Unit 照样能清自己的数据。 */
export const legacyDevUnitsParent = (home: string): string => join(home, '.forsion-dev', 'units')

const missing = (e: unknown): boolean => ['ENOENT', 'ENOTDIR'].includes((e as NodeJS.ErrnoException)?.code ?? '')
/** 盘上此刻是什么(不跟软链);读不出(没权限之类)→ null。 */
function snapshot(path: string, scope: ClearTarget['scope']): ClearTarget | null {
  let st: ReturnType<typeof lstatSync>
  try { st = lstatSync(path) } catch (e) { return missing(e) ? { path, kind: 'absent', scope } : null }
  if (st.isSymbolicLink()) return { path, kind: 'link', scope }
  if (st.isDirectory()) return { path, kind: 'dir', id: { dev: st.dev, ino: st.ino }, scope }
  return { path, kind: 'file', scope }
}

function folderGuard(i: ClearDataInput): PathGuard {
  return {
    strict: [...machineDataRoots(i.home), ...(i.protectedRoots ?? []), ...(i.unitDirs ?? [])],
    cover: [i.home],
    legacyParents: [legacyDevUnitsParent(i.home)],
  }
}

/** 文件夹本身:不是软链、身份还是启动时那个。对 → 它的身份;不对 → 拒绝原因。 */
function folderSelf(i: ClearDataInput): DirIdentity | ClearRefusal {
  const dir = i.folderDir
  if (!dir || !isAbsolute(dir)) return { path: String(dir ?? ''), reason: 'not_absolute' }
  if (i.unitDirs === null) return { path: dir, reason: 'registry_unreadable' }
  const t = snapshot(dir, 'folder')
  if (!t || t.kind === 'link') return { path: dir, reason: t ? 'link' : 'unverifiable' }
  const id = dirIdentity(dir)
  if (!id || (i.folderIdentity && !sameDevIno(id, i.folderIdentity))) return { path: dir, reason: 'moved' }
  return id
}
const isRefusal = (v: DirIdentity | ClearRefusal): v is ClearRefusal => 'reason' in v

/** 文件夹 Unit 的一条目录:必须真的就在本文件夹里(真实路径的上一级按身份就是它),且不和要护住的路径沾边。 */
function folderDirProblem(p: string, folderId: DirIdentity, i: ClearDataInput): ClearRefusal | null {
  const real = realPathLoose(p)
  const parentId = real ? dirIdentity(dirname(real)) : null
  if (!parentId || !sameDevIno(parentId, folderId)) return { path: p, reason: 'moved' }
  const clash = guardConflict(p, folderGuard(i))
  return clash ? { path: p, reason: 'overlap', with: clash } : null
}

function folderTargets(i: ClearDataInput, refused: ClearRefusal[]): ClearTarget[] {
  const self = folderSelf(i)
  if (isRefusal(self)) { refused.push(self); return [] }
  const out: ClearTarget[] = []
  for (const p of [join(i.folderDir!, LOCAL_UNIT_DIRS.home), join(i.folderDir!, LOCAL_UNIT_DIRS.workspace)]) {
    const t = snapshot(p, 'folder')
    if (!t) { refused.push({ path: p, reason: 'unverifiable' }); continue }
    if (t.kind === 'absent') continue // 本来就没有:不用删
    if (t.kind === 'link') { refused.push({ path: p, reason: 'link' }); continue }
    const problem = folderDirProblem(p, self, i)
    if (problem) { refused.push(problem); continue }
    out.push(t)
  }
  return out
}

/** 默认那台的一条:名册里的 Unit 不能和它沾边(软链例外 —— 只删链接本身,碰不到链接指向的东西)。 */
function ownerProblems(t: ClearTarget, i: ClearDataInput): ClearRefusal[] {
  if (t.kind === 'link') return []
  const out: ClearRefusal[] = []
  for (const u of i.unitDirs ?? []) {
    const rel = pathRelation(u, t.path)
    if (rel !== 'none') out.push({ path: t.path, reason: rel === 'unknown' ? 'unverifiable' : 'unit_inside', with: u })
  }
  return out
}

function ownerTargets(i: ClearDataInput, refused: ClearRefusal[]): ClearTarget[] {
  const owner = i.role === 'owner'
  const paths = [i.envTanguHome || i.forsionHome, i.workspace, ...(owner ? [join(i.home, '.tangu'), join(i.home, 'Tangu')] : [])]
  if (owner && i.unitDirs === null) { refused.push({ path: paths[0], reason: 'registry_unreadable' }); return [] }
  const out: ClearTarget[] = []
  for (const p of paths) {
    const t = snapshot(p, owner ? 'owner' : 'plain')
    if (!t) { refused.push({ path: p, reason: 'unverifiable' }); continue }
    if (owner) refused.push(...ownerProblems(t, i))
    out.push(t)
  }
  return out
}

export function clearDataPaths(i: ClearDataInput): ClearPlan {
  const refused: ClearRefusal[] = []
  const tangu = i.tangu ? (i.role === 'folder' ? folderTargets(i, refused) : ownerTargets(i, refused)) : []
  if (refused.length) return { remove: [], targets: [], refused } // 有一条不行就一条都不删
  const desktop = i.desktop ? i.desktopFiles.map((f) => snapshot(join(i.userData, f), 'plain') ?? { path: join(i.userData, f), kind: 'file' as const, scope: 'plain' as const }) : []
  const targets = [...tangu, ...desktop]
  return { remove: targets.map((t) => t.path), targets, refused }
}

/**
 * 真删某一条之前只核**这一条**(不重算整份计划 —— 前面删掉的东西会让后面的兼容软链悬空,那不是变故):
 *  · gone:已经没了(含前面删目录时连带没的)—— 跳过,不算失败;
 *  · unlink:软链或普通文件 —— 只删它本身,绝不跟进去;
 *  · rmdir:目录,而且还是算计划时那一个(dev + ino),按身份再核一次沾边 —— 整个删;
 *  · changed:算计划之后被换掉了(目录换成软链 / 另一个目录、文件夹被挪走、名册读不出……)—— 不删,算清理不完整。
 * i 传删之前现读的输入(名册可能变了)。
 */
export function verifyClearTarget(t: ClearTarget, i: ClearDataInput): 'gone' | 'unlink' | 'rmdir' | 'changed' {
  let st: ReturnType<typeof lstatSync>
  try { st = lstatSync(t.path) } catch (e) { return missing(e) ? 'gone' : 'changed' }
  if (st.isSymbolicLink() || !st.isDirectory()) return t.kind === 'dir' ? 'changed' : 'unlink'
  if (t.kind === 'dir' ? !t.id || st.dev !== t.id.dev || st.ino !== t.id.ino : t.kind !== 'absent') return 'changed'
  if (t.scope === 'folder') {
    const self = folderSelf(i)
    if (isRefusal(self) || folderDirProblem(t.path, self, i)) return 'changed'
  } else if (t.scope === 'owner') {
    if (i.unitDirs === null || ownerProblems({ ...t, kind: 'dir' }, i).length) return 'changed'
  }
  return 'rmdir'
}
