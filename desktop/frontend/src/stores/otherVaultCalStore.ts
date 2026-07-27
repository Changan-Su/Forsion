/** 非活动侧(Local↔Cloud 另一侧)的日历只读源:主进程递归读另一侧根下 .db → parseDb → 合成只读 AggDb。
 *  与 useAgentCalDbs 同为「外部只读日历源」,刻意不并进 dbAggregateStore(那是活动侧全库聚合)。
 *  只读:另一侧事件不可编辑/删除/拖拽,要改切到那一侧。经典表(rows 有值)才纳入——笔记视图的行在
 *  另一侧磁盘,这里读不到,跳过。快照式:挂载 + 侧切时重拉;另一侧运行时改动须切侧/重挂才反映(桌面专属)。 */
import { useEffect } from 'react'
import { create } from 'zustand'
import { parseDb, type CellValue, type DbColumn } from '@amadeus-shared/db/schema'
import { cellText, firstDateCol, type AggDb } from '../amadeus/store/dbAggregateStore'
import { usePageStore } from '../amadeus/store/pageStore'

interface OtherSideState {
  dbs: AggDb[]
  refresh(): Promise<void>
}

export const useOtherSideCal = create<OtherSideState>((set) => ({
  dbs: [],
  async refresh() {
    const api = window.amadeusSync
    if (!api?.otherSideCalDbs) return // web/移动或旧 preload:优雅缺位
    try {
      const res = await api.otherSideCalDbs()
      if (!res) {
        set({ dbs: [] })
        return
      }
      const dbs: AggDb[] = []
      for (const { rel, source } of res.dbs) {
        const p = parseDb(source)
        if (!p.ok || p.data.source) continue // 解析失败 / 笔记视图(另一侧无行)跳过
        const df = p.data
        const nameId = df.columns[0]?.id ?? ''
        const agg: AggDb = {
          // 合成唯一 path:避开活动侧 colorForDb/isHidden 按相对路径的键碰撞(两侧都有 Calendar.db),自动取调色板色。
          path: `otherside:${res.root}/${rel}`,
          name: df.name, // 原名不拼后缀;Vault 归属走 vaultLabel(图例淡显),rename/数据层不受污染
          vaultLabel: res.vaultName,
          isNoteView: false,
          readonly: true,
          columns: df.columns as DbColumn[],
          rows: df.rows.map((r) => {
            const cells = r.cells as Record<string, CellValue>
            return { rowId: r.id, name: cellText(cells[nameId]), cells }
          }),
        }
        if (firstDateCol(agg)) dbs.push(agg) // 有日期列才算日历源
      }
      set({ dbs })
    } catch {
      set({ dbs: [] })
    }
  },
}))

/** 非活动侧只读日历库。挂载即拉;活动侧根/侧切(vaultRoot/vaultSide 变)时重拉。 */
export function useOtherVaultCalDbs(): AggDb[] {
  const dbs = useOtherSideCal((s) => s.dbs)
  const vaultRoot = usePageStore((s) => s.vaultRoot)
  const vaultSide = usePageStore((s) => s.vaultSide)
  useEffect(() => {
    void useOtherSideCal.getState().refresh()
  }, [vaultRoot, vaultSide])
  return dbs
}
