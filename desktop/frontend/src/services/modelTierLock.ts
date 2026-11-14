/**
 * 模型倍率门槛的宿主侧读法(模型选择器、正文 AI)。判定与报错识别在 accountQuota.ts(宿主与 Tangu 界面共用的额度接缝),这里只加 React 读法。
 */
import { useAccountQuota } from './useAccountQuota'
import { modelMultiplierCapOf } from './accountQuota'

export { isModelTierLocked, isTierLockedError, modelMultiplierCapOf, tierLockedModelName, tierLockedText, TIER_LOCKED_RE } from './accountQuota'

/** 模型选择器读上限:订阅额度广播(用卡 / 登出 / 切号后别处刷新),没登录或读失败 = null。 */
export function useModelMultiplierCap(enabled = true): number | null {
  return modelMultiplierCapOf(useAccountQuota(enabled))
}
