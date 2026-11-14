/**
 * Tangu 界面这侧读模型倍率上限(报错条判断「会话现在选着的模型还锁不锁」用)。
 * 宿主侧的同名读法在 services/modelTierLock.ts(useAccountQuota);这里不引它,Tangu 界面包对宿主的依赖只走额度接缝 accountQuota.ts。
 * null = 不知道(没登录 / 读失败 / 旧服务端)或不限。
 */
import { useEffect, useState } from 'react'
import { modelMultiplierCapOf, subscribeAccountQuota } from '../services/accountQuota'

export function useQuotaMultiplierCap(enabled: boolean): number | null {
  const [cap, setCap] = useState<number | null>(null)
  useEffect(() => {
    setCap(null)
    if (!enabled) return
    let alive = true
    let pushed = false
    const off = subscribeAccountQuota((q) => { if (alive) { pushed = true; setCap(modelMultiplierCapOf(q)) } })
    void window.tangu?.accountQuota?.().then((r) => { if (alive && !pushed && r?.status === 200 && r.json) setCap(modelMultiplierCapOf(r.json)) }).catch(() => {})
    return () => { alive = false; off() }
  }, [enabled])
  return cap
}
