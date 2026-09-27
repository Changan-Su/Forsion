/**
 * 设备页的配置面(/unit/config):本机 UI 偏好的白名单子集,远端可读、部分可写。
 * 刻意零 electron 依赖(读写由 main.ts 注入),vitest 直测(electron/unitConfigFace.test.ts)。
 */
import { UNIT_PREFERENCE_KEYS } from '../shared/unitPreferences'

/** 远端只读的偏好键。lastApprovalMode = 本机新会话的缺省审批档:本机 run 不受远端审批上限(C3)约束,
 *  远端写回它就等于远程抬高本机的审批档 —— 审批类策略只许在设备本机改(方案 §6.3,评审 A-desktop#3)。
 *  便携 Unit 的工作区主人 / 账号偏好(unit/localWorkspace.ts、unit/accountHttp.ts)是主人自己的面,不受此限。 */
export const UNIT_REMOTE_READONLY_PREFS: readonly string[] = ['lastApprovalMode']

/** RW = 设备页可读可写回(纯 UI/体验/笔记偏好,写回无本机副作用);RO = 只读展示。
 *  ⚠️ default-deny:token/backendUrl/cloudUrl/mode/sandbox/unitHostEnabled/forsionMcp(含 token)
 *  等连接与本机治理键**读写都绝不透传**;browser 系/mirror/pythonMode 属 managedKeys(写=重启对方后端)只读不写。 */
export const UNIT_CONFIG_RW: readonly string[] = UNIT_PREFERENCE_KEYS.filter((k) => !UNIT_REMOTE_READONLY_PREFS.includes(k))
export const UNIT_CONFIG_RO: readonly string[] = [...UNIT_REMOTE_READONLY_PREFS, 'homeDir', 'defaultWorkspaceDir', 'activityLogEnabled', 'browserSearchEngine']

export function pickUnitConfig(src: Record<string, unknown>, keys: readonly string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const k of keys) if (src[k] !== undefined) out[k] = src[k]
  return out
}

export interface UnitConfigStore {
  /** 生效配置全量(main.ts 的 effectiveConfig)。 */
  effective: () => Promise<Record<string, unknown>>
  /** 落盘一个已裁剪的补丁(main.ts 的 saveConfig)。 */
  save: (patch: Record<string, unknown>) => Promise<void>
}

/** unitWeb 的 readConfig / writeConfig 依赖:读 = RW ∪ RO,写只收 RW。 */
export function unitConfigFace(store: UnitConfigStore): { readConfig: () => Promise<Record<string, unknown>>; writeConfig: (patch: Record<string, unknown>) => Promise<Record<string, unknown>> } {
  const view = async (): Promise<Record<string, unknown>> => {
    const c = await store.effective()
    return { ...pickUnitConfig(c, UNIT_CONFIG_RW), ...pickUnitConfig(c, UNIT_CONFIG_RO) }
  }
  return {
    readConfig: view,
    writeConfig: async (patch) => {
      const p = pickUnitConfig(patch && typeof patch === 'object' ? patch : {}, UNIT_CONFIG_RW)
      if (Object.keys(p).length) await store.save(p)
      return view()
    },
  }
}
