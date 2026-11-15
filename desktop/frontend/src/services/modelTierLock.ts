/**
 * 模型倍率门槛的宿主侧读法(模型选择器、正文 AI)。判定与报错识别在 accountQuota.ts(宿主与 Tangu 界面共用的额度接缝),这里只加 React 读法。
 */
import { useEffect, useState } from 'react'
import { useAccountQuota } from './useAccountQuota'
import { accountQuotaEpoch, modelMultiplierCapOf, modelTrialsOf, publishAccountQuota, type ModelTrials } from './accountQuota'

export { isModelTierLocked, isTierLockedError, modelMultiplierCapOf, modelTrialsOf, recentlyEndedTrial, tierLockedModelName, tierLockedText, trialEndsAt, visibleModelTags, TIER_LOCKED_RE } from './accountQuota'
export type { ModelTrials } from './accountQuota'

/** 模型选择器读上限:订阅额度广播(用卡 / 登出 / 切号后别处刷新),没登录或读失败 = null。 */
export function useModelMultiplierCap(enabled = true): number | null {
  return modelMultiplierCapOf(useAccountQuota(enabled))
}

/** 上限 + 限时开放一次读(只订阅一份额度视图);`now` 在最近一个开放到期那一刻往后跳,锁跟着翻回来。 */
export function useModelTierGate(enabled = true): { cap: number | null; trials: ModelTrials; now: number } {
  const quota = useAccountQuota(enabled)
  const trials = modelTrialsOf(quota)
  return { cap: modelMultiplierCapOf(quota), trials, now: useModelTrialClock(trials) }
}

/**
 * 限时开放到期那一刻自己翻回锁住,不等下次刷新额度:定时到最近的到期时间,到点更新 now(重新判锁)并重拉一次额度视图
 * (服务端那边同一刻不再列它;重拉也顺带拿到后台改过的开放)。setTimeout 上限约 24.8 天,更远的分段等。
 */
export function useModelTrialClock(trials: ModelTrials): number {
  const [now, setNow] = useState(() => Date.now())
  const key = Object.entries(trials).map(([id, at]) => `${id}@${at}`).sort().join('|')
  useEffect(() => {
    const next = Object.values(trials).filter((at) => at > Date.now()).sort((a, b) => a - b)[0]
    if (next == null) return
    const timer = setTimeout(() => {
      setNow(Date.now())
      if (Date.now() < next) return
      const epoch = accountQuotaEpoch()
      void window.tangu?.accountQuota?.().then((r) => {
        if (epoch === accountQuotaEpoch() && r?.status === 200 && r.json) publishAccountQuota(r.json)
      }).catch(() => {})
    }, Math.min(Math.max(0, next - Date.now()) + 250, 2 ** 31 - 1))
    return () => clearTimeout(timer)
    // trials 每次额度推送都是新对象;按内容(key)重排定时
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, now])
  return now
}
