/**
 * Tangu 界面这侧读模型倍率上限与限时开放(报错条判断「会话现在选着的模型还锁不锁」用)。
 * 宿主侧的同名读法在 services/modelTierLock.ts(useAccountQuota);这里不引它,Tangu 界面包对宿主的依赖只走额度接缝 accountQuota.ts。
 * cap null = 不知道(没登录 / 读失败 / 旧服务端)或不限。
 */
import { useEffect, useState } from 'react'
import { accountQuotaEpoch, modelMultiplierCapOf, modelTrialsOf, subscribeAccountQuota, subscribeAccountQuotaScope, type AccountQuotaView, type ModelTrials } from '../services/accountQuota'

function useQuotaView(enabled: boolean): AccountQuotaView | null {
  const [quota, setQuota] = useState<AccountQuotaView | null>(null)
  const [scope, setScope] = useState(accountQuotaEpoch)
  useEffect(() => subscribeAccountQuotaScope(() => setScope(accountQuotaEpoch())), [])
  useEffect(() => {
    setQuota(null) // 换号后先当不知道,不沿用上个账号的上限
    if (!enabled) return
    let alive = true
    let pushed = false
    const epoch = accountQuotaEpoch()
    const off = subscribeAccountQuota((q) => { if (alive) { pushed = true; setQuota(q) } })
    void window.tangu?.accountQuota?.().then((r) => {
      if (alive && !pushed && epoch === accountQuotaEpoch() && r?.status === 200 && r.json) setQuota(r.json)
    }).catch(() => {})
    return () => { alive = false; off() }
  }, [enabled, scope])
  return quota
}

export function useQuotaMultiplierCap(enabled: boolean): number | null {
  return modelMultiplierCapOf(useQuotaView(enabled))
}

/** 上限 + 正开放着的限时体验(isModelTierLocked 要两样一起判) */
export function useQuotaTierLock(enabled: boolean): { cap: number | null; trials: ModelTrials } {
  const quota = useQuotaView(enabled)
  return { cap: modelMultiplierCapOf(quota), trials: modelTrialsOf(quota) }
}
