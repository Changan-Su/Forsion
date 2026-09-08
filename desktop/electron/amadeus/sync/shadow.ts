/**
 * 同步 shadow(基线)持久化:userData/amadeus-sync(.dev).json。
 * 放 userData 而非子树内 —— 不赌 watcher 的 dotfile 忽略规则,也绝不把自己同步上云。
 * shadow 即墓碑知识源:重置/长离线后的全量对账全靠它区分「云端删了」和「本地新增」。
 */

import { promises as fs } from 'node:fs'
import path from 'node:path'
import { app } from 'electron'
import { isDevMode } from '../../forsionHome'
import type { ShadowEntry } from './reconcile'

export interface SyncShadow {
  /** 绑定的本地 vault 根(绝对路径);当前打开的 vault 不是它 → 引擎不启动。 */
  vaultRoot: string
  /** 同步子树名(默认 'Cloud')。 */
  folder: string
  /** 云端 vault id。 */
  vaultId: string
  /** 已应用的变更流游标(vault.last_change_seq)。 */
  cursor: number
  /** 上次成功全量/增量同步完成时间(epoch ms)。 */
  lastSyncAt: number | null
  /** key = 服务端路径(NFC,'/' 分隔)。 */
  files: Record<string, ShadowEntry>
  /** 被删除保护拦下、等用户确认的删除(serverPath → 哪一侧将被删)。持久化 = 重启绕不过确认
   *  (Codex 终审:重启后首轮全量对账只看到低于阈值的残余,会直接执行)。 */
  pending?: Record<string, 'local' | 'remote'>
}

/** name:每个同步绑定一份 shadow('amadeus-sync'=自己的云库;'amadeus-sync-share-<id>'=与我共享)。 */
const file = (name: string): string =>
  path.join(app.getPath('userData'), isDevMode() ? `${name}.dev.json` : `${name}.json`)

export async function loadShadow(name: string): Promise<SyncShadow | null> {
  try {
    const j = JSON.parse(await fs.readFile(file(name), 'utf8')) as SyncShadow
    if (!j || typeof j.vaultRoot !== 'string' || typeof j.vaultId !== 'string') return null
    j.files = j.files ?? {}
    j.cursor = Number(j.cursor ?? 0)
    j.lastSyncAt = j.lastSyncAt ?? null
    return j
  } catch {
    return null
  }
}

export function createShadowSaver(name: string): { save: (s: SyncShadow) => void; flush: () => Promise<void> } {
  let pending: SyncShadow | null = null
  let timer: ReturnType<typeof setTimeout> | null = null
  let writing: Promise<void> = Promise.resolve()
  const write = (): Promise<void> => {
    if (!pending) return writing
    const snapshot = JSON.stringify(pending)
    pending = null
    writing = writing.then(async () => {
      try {
        const f = file(name)
        const tmp = `${f}.tmp-${process.pid}-${Date.now()}-0`
        await fs.writeFile(tmp, snapshot, 'utf8')
        await fs.rename(tmp, f)
      } catch {
        /* best-effort;下次保存重试 */
      }
    })
    return writing
  }
  return {
    save(s: SyncShadow) {
      pending = s
      if (timer) return
      timer = setTimeout(() => {
        timer = null
        void write()
      }, 500)
    },
    async flush() {
      if (timer) {
        clearTimeout(timer)
        timer = null
      }
      await write()
    },
  }
}

export async function deleteShadowFile(name: string): Promise<void> {
  try {
    await fs.unlink(file(name))
  } catch {
    /* absent */
  }
}
