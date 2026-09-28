/**
 * 云镜像目录助手(2026-09-28 从 sync/engine.ts 抽出,引擎本体搬进 Forsion Extend 后宿主仍要用:restoreVault 的云根守卫、
 * switchSide、远程同步的同步根校验)。Extend 经 AmadeusSyncHostDeps.cloudVaultDir / isManagedCloudVault 拿同一份实现 ——
 * 两边算出的目录必须是同一个,所以只在这里实现一次。
 */
import { createHash } from 'node:crypto'
import { existsSync, renameSync, realpathSync } from 'node:fs'
import path from 'node:path'
import { defaultWorkspaceDir, forsionHomeDir } from '../forsionHome'
import { cloudAccountNamespace, currentCloudAccountId } from './settings'

/** 云 vault 的本地镜像目录:固定、应用管理,与用户自选 vault 无关(胶囊滑块的 Cloud 侧)。
 *  放在隐藏应用数据目录(~/.forsion),彻底不出现在任何工作区文件夹里——本地 vault 若选在
 *  工作区(如 ~/Forsion)也不会把云端内容混进本地模式的笔记树。 */
export function cloudVaultDir(accountId = currentCloudAccountId()): string {
  return path.join(forsionHomeDir(), 'Amadeus Accounts', cloudAccountNamespace(accountId), 'Cloud')
}
/** Previous unscoped mirror is retained for recovery; it is never a new account's upload source. */
export function unscopedCloudVaultDir(): string {
  return path.join(forsionHomeDir(), 'Amadeus Cloud')
}
export function isManagedCloudVault(root: string): boolean {
  const canonical = (value: string): string => {
    try { return realpathSync.native(value) } catch { return path.resolve(value) }
  }
  const roots = [unscopedCloudVaultDir(), legacyCloudVaultDir(), path.join(forsionHomeDir(), 'Amadeus Accounts')]
  return roots.some((base) => {
    const relative = path.relative(canonical(base), canonical(root))
    return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))
  })
}
/** 旧位置(工作区内可见目录)。已迁至隐藏目录;仅迁移与 restoreVault 兼容判定用。 */
export function legacyCloudVaultDir(): string {
  return path.join(defaultWorkspaceDir(), 'Amadeus Cloud')
}
/**
 * 一次性迁移:旧可见镜像目录 → 新隐藏目录。整目录 rename(含 与我共享/ 子绑定),
 * shadow 存的是 vault 相对路径,随目录移动仍对得上,不会被当成本地删除推给服务端。
 * ponytail: 两路径同在 $HOME 下(同卷),renameSync 原子且不会 EXDEV;失败仅记录不阻塞。
 */
export function migrateCloudMirrorDir(log: (m: string) => void = console.log): void {
  const oldDir = legacyCloudVaultDir()
  const newDir = unscopedCloudVaultDir()
  if (oldDir === newDir || !existsSync(oldDir) || existsSync(newDir)) return
  try {
    renameSync(oldDir, newDir)
    log(`[amadeus-sync] 云镜像已迁移到隐藏目录 ${oldDir} → ${newDir}`)
  } catch (e) {
    log(`[amadeus-sync] ⚠️ 云镜像迁移失败(保持旧位置,不阻塞): ${e instanceof Error ? e.message : String(e)}`)
  }
}

/** 短哈希(远程同步基线文件名、旧 entry shadow 名):与 Extend 的 entryRegistry.hash8 逐字同构。 */
export const hash8 = (s: string): string => createHash('sha256').update(s).digest('hex').slice(0, 8)
