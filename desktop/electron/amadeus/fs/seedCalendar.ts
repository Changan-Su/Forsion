/**
 * 默认日历统一到引擎家目录的 human/CALENDAR.db 之后,老版本种在库根的 Calendar.db 没用了:还是没人动过的种子就挪进库回收站。
 * 判定和挪走在同一把跨进程写锁里 —— 引擎的旧位置镜像拿同一把,否则它刚把 human/ 的行写回来,这里还当空文件扔掉。
 * 删除经云同步传到别的设备:没改过的那台跟删;离线改过的那台「编辑胜删除」推回来,这里再见到时已不是种子(Extend reconcile.ts decide)。
 */
import { promises as fs } from 'node:fs'
import { isUntouchedCalendarSeed } from '../../../../tangu-agent/src/contracts/dbRowMerge'
import { withDbLock } from './dbLock'
import type { VaultManager } from './vaultManager'

const SEED_FILE = 'Calendar.db'

export async function trashSeedCalendar(vault: Pick<VaultManager, 'getRoot' | 'absPath' | 'trashEntry' | 'listTrash' | 'restoreTrash'>): Promise<boolean> {
  const root = vault.getRoot()
  const abs = vault.absPath(SEED_FILE)
  // 读不到 = 不知道,和「不是种子」一样不动
  const isSeed = async (file: string): Promise<boolean> => isUntouchedCalendarSeed(await fs.readFile(file, 'utf8').catch(() => null))
  if (!await isSeed(abs)) return false
  return withDbLock(abs, async () => {
    // 等锁时切了库:abs 还是旧库的,trashEntry 却会落到新库
    if (!await isSeed(abs) || vault.getRoot() !== root) return false
    await vault.trashEntry(SEED_FILE)
    // Extend 的云同步落盘不拿这把锁:判定之后才拉下来的内容也会被一起挪走,而同步基线已是那份,不放回去下一轮就成了云端删除
    const moved = (await vault.listTrash()).find((e) => e.original === SEED_FILE) // 最新的排最前
    if (!moved || await isSeed(vault.absPath(`.trash/${moved.name}`))) return true
    await vault.restoreTrash(moved.name)
    return false
  })
}
