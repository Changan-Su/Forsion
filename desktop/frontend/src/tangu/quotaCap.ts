/**
 * Tangu 界面这侧读模型倍率上限(报错条判断「会话现在选着的模型还锁不锁」用)。
 * 宿主侧的同名读法在 services/modelTierLock.ts(useAccountQuota);这里不引它,Tangu 界面包对宿主的依赖只走额度接缝 accountQuota.ts。
 * null = 不知道(没登录 / 读失败 / 旧服务端)或不限。
 */
import { useEffect, useState } from 'react'
import { accountQuotaEpoch, modelMultiplierCapOf, subscribeAccountQuota, subscribeAccountQuotaScope } from '../services/accountQuota'

export function useQuotaMultiplierCap(enabled: boolean): number | null {
  const [cap, setCap] = useState<number | null>(null)
  const [scope, setScope] = useState(accountQuotaEpoch)
  useEffect(() => subscribeAccountQuotaScope(() => setScope(accountQuotaEpoch())), [])
  useEffect(() => {
    setCap(null) // 换号后先当不知道,不沿用上个账号的上限
    if (!enabled) return
    let alive = true
    let pushed = false
    const epoch = accountQuotaEpoch()
    const off = subscribeAccountQuota((q) => { if (alive) { pushed = true; setCap(modelMultiplierCapOf(q)) } })
    void window.tangu?.accountQuota?.().then((r) => {
      if (alive && !pushed && epoch === accountQuotaEpoch() && r?.status === 200 && r.json) setCap(modelMultiplierCapOf(r.json))
    }).catch(() => {})
    return () => { alive = false; off() }
  }, [enabled, scope])
  return cap
}
