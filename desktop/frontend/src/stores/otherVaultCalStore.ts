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
  /** 上一次拉完(成功、失败、宿主没有这条接缝都算)对应的是哪一侧哪个库(otherSideKey);null = 还没拉过。
   *  和当前的对不上 = dbs 还是别的库的 / 还没到:日历来源定色据此等它到齐,也不把别的库的来源记到这个库名下。 */
  loadedFor: string | null
  refresh(): Promise<void>
}

/** 「此刻是哪一侧哪个库」:另一侧的日历按它重拉。 */
export const otherSideKey = (): string => { const s = usePageStore.getState(); return `${s.vaultSide}:${s.vaultRoot}` }

export const useOtherSideCal = create<OtherSideState>((set) => ({
  dbs: [],
  loadedFor: null,
  async refresh() {
    const loadedFor = otherSideKey()
    const api = window.amadeusSync
    if (!api?.otherSideCalDbs) { set({ loadedFor }); return } // web/移动或旧 preload:优雅缺位
    try {
      const res = await api.otherSideCalDbs()
      if (!res) {
        set({ dbs: [], loadedFor })
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
      set({ dbs, loadedFor })
    } catch {
      set({ dbs: [], loadedFor })
    }
  },
}))

/** 拉一次,之后活动侧根 / 侧切(vaultRoot / vaultSide 变)时重拉;返回退订。
 *  日历视图(useOtherVaultCalDbs)与插件接缝 ctx.calendar(pluginCalendar.ts)共用。 */
export function watchOtherSideCal(): () => void {
  const key = otherSideKey
  let last = key()
  void useOtherSideCal.getState().refresh()
  return usePageStore.subscribe(() => {
    const k = key()
    if (k === last) return
    last = k
    void useOtherSideCal.getState().refresh()
  })
}

/** 非活动侧只读日历库。挂载即拉;活动侧根/侧切(vaultRoot/vaultSide 变)时重拉。 */
export function useOtherVaultCalDbs(): AggDb[] {
  const dbs = useOtherSideCal((s) => s.dbs)
  useEffect(watchOtherSideCal, [])
  return dbs
}
