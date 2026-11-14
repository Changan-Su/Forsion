/**
 * 应用内「卸载 / 清空数据」(app:clearData)要删哪些路径 —— 纯函数,单测钉住;真删在 main.ts。
 *
 *   · 这台电脑的主人(默认那台):引擎 home(显式 TANGU_HOME 时只删它本身,不删推导出的父目录)+ 默认工作区 + ~/.tangu、~/Tangu 兼容软链;
 *   · 插件沙箱:只删它自己的 home 与工作区(兼容软链是整机的,不归它管);
 *   · 文件夹 Unit:只删本文件夹下的 home/ 与 Forsion/,路径由文件夹本身推出,不看环境变量;
 *     任何一条落在默认那台的数据目录(~/.forsion*、~/Forsion*、~/.tangu、~/Tangu)上或里面、或盖住了家目录 —— 一律不删。
 *   · 「桌面」那一半三种身份相同:只删自己 userData 下的几份壳层文件(整个 userData 被 Electron 占着,不整删;
 *     文件夹 Unit 的 userData 就是本文件夹的 app-data/)。
 */
import { isAbsolute, join, relative, resolve } from 'node:path'
import { LOCAL_UNIT_DIRS } from '../shared/localUnits'

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
}

const inside = (child: string, parent: string): boolean => {
  const r = relative(resolve(parent), resolve(child))
  return r === '' || (!r.startsWith('..') && !isAbsolute(r))
}

/** 默认那台的数据根:文件夹 Unit 的清理绝不碰到它们(含它们里面的任何东西)。 */
export function machineDataRoots(home: string): string[] {
  return ['.forsion', '.forsion-dev', 'Forsion', 'Forsion-Dev', '.tangu', 'Tangu'].map((n) => join(home, n))
}

export function clearDataPaths(i: ClearDataInput): { remove: string[]; refused: string[] } {
  const remove: string[] = []
  const refused: string[] = []
  if (i.tangu) {
    if (i.role === 'folder') {
      if (!i.folderDir || !isAbsolute(i.folderDir)) {
        refused.push(String(i.folderDir ?? ''))
      } else {
        const roots = machineDataRoots(i.home)
        for (const p of [join(i.folderDir, LOCAL_UNIT_DIRS.home), join(i.folderDir, LOCAL_UNIT_DIRS.workspace)]) {
          const clash = roots.some((r) => inside(p, r) || inside(r, p)) || inside(i.home, p)
          ;(clash ? refused : remove).push(p)
        }
      }
    } else {
      remove.push(i.envTanguHome || i.forsionHome, i.workspace)
      if (i.role === 'owner') remove.push(join(i.home, '.tangu'), join(i.home, 'Tangu'))
    }
  }
  if (i.desktop) for (const f of i.desktopFiles) remove.push(join(i.userData, f))
  return { remove, refused }
}
