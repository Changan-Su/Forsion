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
 * 真删前每条再调一次 recheckClearTarget(核对与删除之间文件夹被换成软链之类)。
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
export interface ClearPlan { remove: string[]; refused: ClearRefusal[] }

/** 默认那台的数据根:文件夹 Unit 的清理绝不碰到它们(含它们里面的任何东西)。 */
export function machineDataRoots(home: string): string[] {
  return ['.forsion', '.forsion-dev', 'Forsion', 'Forsion-Dev', '.tangu', 'Tangu'].map((n) => join(home, n))
}
/** 旧的开发版缺省父目录(现在是 ~/.forsion-dev-units):已经登记在那里的老 Unit 照样能清自己的数据。 */
export const legacyDevUnitsParent = (home: string): string => join(home, '.forsion-dev', 'units')

const isLink = (p: string): boolean | null => {
  try { return lstatSync(p).isSymbolicLink() } catch (e) { return (e as NodeJS.ErrnoException).code === 'ENOENT' ? false : null }
}
const exists = (p: string): boolean => { try { lstatSync(p); return true } catch { return false } }

function folderGuard(i: ClearDataInput): PathGuard {
  return {
    strict: [...machineDataRoots(i.home), ...(i.protectedRoots ?? []), ...(i.unitDirs ?? [])],
    cover: [i.home],
    legacyParents: [legacyDevUnitsParent(i.home)],
  }
}

function folderTargets(i: ClearDataInput, refused: ClearRefusal[]): string[] {
  const dir = i.folderDir
  if (!dir || !isAbsolute(dir)) { refused.push({ path: String(dir ?? ''), reason: 'not_absolute' }); return [] }
  if (i.unitDirs === null) { refused.push({ path: dir, reason: 'registry_unreadable' }); return [] }
  const dirLink = isLink(dir)
  if (dirLink !== false) { refused.push({ path: dir, reason: dirLink ? 'link' : 'unverifiable' }); return [] }
  const id = dirIdentity(dir)
  if (!id || (i.folderIdentity && !sameDevIno(id, i.folderIdentity))) { refused.push({ path: dir, reason: 'moved' }); return [] }
  const guard = folderGuard(i)
  const out: string[] = []
  for (const p of [join(dir, LOCAL_UNIT_DIRS.home), join(dir, LOCAL_UNIT_DIRS.workspace)]) {
    if (!exists(p)) continue // 本来就没有:不用删
    const link = isLink(p)
    if (link !== false) { refused.push({ path: p, reason: link ? 'link' : 'unverifiable' }); continue }
    // 必须真的就在本文件夹里:真实路径的上一级就是这个文件夹(按身份比,不按字符串)
    const real = realPathLoose(p)
    const parentId = real ? dirIdentity(dirname(real)) : null
    if (!parentId || !sameDevIno(parentId, id)) { refused.push({ path: p, reason: 'moved' }); continue }
    const clash = guardConflict(p, guard)
    if (clash) { refused.push({ path: p, reason: 'overlap', with: clash }); continue }
    out.push(p)
  }
  return out
}

function ownerTargets(i: ClearDataInput, refused: ClearRefusal[]): string[] {
  const targets = [i.envTanguHome || i.forsionHome, i.workspace, ...(i.role === 'owner' ? [join(i.home, '.tangu'), join(i.home, 'Tangu')] : [])]
  if (i.role !== 'owner') return targets
  if (i.unitDirs === null) { refused.push({ path: targets[0], reason: 'registry_unreadable' }); return [] }
  for (const t of targets) {
    for (const u of i.unitDirs ?? []) {
      const rel = pathRelation(u, t)
      if (rel === 'none') continue
      refused.push({ path: t, reason: rel === 'unknown' ? 'unverifiable' : 'unit_inside', with: u })
    }
  }
  return targets
}

export function clearDataPaths(i: ClearDataInput): ClearPlan {
  const refused: ClearRefusal[] = []
  const tangu = i.tangu ? (i.role === 'folder' ? folderTargets(i, refused) : ownerTargets(i, refused)) : []
  if (refused.length) return { remove: [], refused } // 有一条不行就一条都不删
  const desktop = i.desktop ? i.desktopFiles.map((f) => join(i.userData, f)) : []
  return { remove: [...tangu, ...desktop], refused }
}

/** 真删某一条之前再核一次:按同样的输入重算,这条还在、且没有任何拒绝,才删。 */
export function recheckClearTarget(p: string, i: ClearDataInput): boolean {
  const fresh = clearDataPaths(i)
  return fresh.refused.length === 0 && fresh.remove.includes(p)
}
