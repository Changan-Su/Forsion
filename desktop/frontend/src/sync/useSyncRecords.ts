/** 同步记录(主进程按账号存的那份,经 window.syncRecords 读):面板读这个库的最近几轮,全部记录读 30 天。
 *  存取不懂「一轮」是什么 —— 第 2 步把入口搬进设置 › 同步时,这个钩子和 SyncRecordList 原样搬。 */
import { useEffect, useState } from 'react'
import type { SyncRoundRecord } from '../../../shared/vaultSync'

/** rows:null = 还在读;unavailable:读不出来(权限 / 坏文件挪不走),界面说「读不出来」,不说「没有记录」。 */
export function useSyncRecords(opts: { feeds?: string[]; vault?: string | null; limit?: number; enabled?: boolean }): { rows: SyncRoundRecord[] | null; unavailable: boolean } {
  const [rows, setRows] = useState<SyncRoundRecord[] | null>(null)
  const [unavailable, setUnavailable] = useState(false)
  const feedsKey = opts.feeds?.join('\n') ?? ''
  const on = opts.enabled !== false
  useEffect(() => {
    const api = window.syncRecords
    if (!api || !on) { setRows(null); return }
    let live = true
    const load = (): void => {
      void api.list({ ...(opts.feeds ? { feeds: opts.feeds } : {}), ...(opts.vault ? { vault: opts.vault } : {}), ...(opts.limit ? { limit: opts.limit } : {}) })
        .then((r) => { if (live) { setRows(Array.isArray(r) ? r : []); setUnavailable(false) } })
        .catch(() => { if (live) setUnavailable(true) })
    }
    load()
    const off = api.onChanged(load)
    return () => { live = false; off() }
    // feeds 按内容比(调用方每次渲染都给新数组)
  }, [feedsKey, opts.vault, opts.limit, on]) // eslint-disable-line react-hooks/exhaustive-deps
  return { rows, unavailable }
}
