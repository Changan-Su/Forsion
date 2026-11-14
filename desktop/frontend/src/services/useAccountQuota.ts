/**
 * 账号额度视图的 React 读法:宿主 IPC 读一次 + 订阅广播(转入 / 切账号后别处刷新)。
 * 首拉回来之前已经收到过广播 → 首拉那份是旧快照,丢掉。
 * null = 还没读到 / 宿主没这个接口 / 没登录 / 读失败 —— 一律当「不知道」,别当「没有后台额度」去下结论(仓规「读失败 ≠ 空」)。
 * 换号(resetAccountQuotaScope)→ 清成 null 并按新账号重读;旧账号的回包晚到丢掉(倍率上限别把 A 的带给 B)。
 */
import { useEffect, useState } from 'react'
import { accountQuotaEpoch, subscribeAccountQuota, subscribeAccountQuotaScope, type AccountQuotaView } from './accountQuota'

export function useAccountQuota(enabled = true): AccountQuotaView | null {
  const [quota, setQuota] = useState<AccountQuotaView | null>(null)
  const [scope, setScope] = useState(accountQuotaEpoch)
  useEffect(() => subscribeAccountQuotaScope(() => setScope(accountQuotaEpoch())), [])
  useEffect(() => {
    setQuota(null)
    if (!enabled) return
    let alive = true
    let pushed = false
    const epoch = accountQuotaEpoch()
    // null 广播 = 登出 / 切号 / 读失败:清掉,别留着上一个账号的计入模型
    const off = subscribeAccountQuota((q) => { if (alive) { pushed = true; setQuota(q) } })
    void window.tangu?.accountQuota?.().then((r) => {
      if (alive && !pushed && epoch === accountQuotaEpoch() && r?.status === 200 && r.json) setQuota(r.json)
    }).catch(() => {})
    return () => { alive = false; off() }
  }, [enabled, scope])
  return quota
}

/** 后台额度实际计入的那个模型(服务端扣费同一口径:muse / automation 标签 × 这个模型);不知道 / 服务端没配 = ''。 */
export function backgroundQuotaModel(quota: AccountQuotaView | null): string {
  return quota?.background?.modelId || ''
}
