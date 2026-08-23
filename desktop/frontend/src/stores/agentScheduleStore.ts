/**
 * Agent 日程(agents/<slug>/SCHEDULE.db)的桌面缓存:GET /agent/special/schedule 聚合结果。
 * 消费方:Calendar Space(useAgentCalDbs 合成只读 AggDb 源——刻意不并进 dbAggregateStore 的
 * hook:那是纯 vault 聚合层,Todo 视图第三方消费,HTTP 轮询不该塞进去)+ 自动化 Space「Agent 日程」组。
 * 旧引擎无此端点 → refresh 单源 catch 保旧值,两处视图无感。
 */
import { useMemo } from 'react'
import { create } from 'zustand'
import { getAgentSchedules } from '../services/backendService'
import type { AgentScheduleInfo, TanguDesktopConfig } from '../types'
import { cellText, type AggDb } from '../amadeus/store/dbAggregateStore'
import type { CellValue, DbColumn } from '@amadeus-shared/db/schema'

interface AgentScheduleState {
  schedules: AgentScheduleInfo[]
  loaded: boolean
  refresh(cfg: TanguDesktopConfig): Promise<void>
}

export const useAgentSchedules = create<AgentScheduleState>((set, get) => ({
  schedules: [],
  loaded: false,
  async refresh(cfg) {
    const next = await getAgentSchedules(cfg).catch(() => get().schedules)
    // 旧/代理后端偶尔会以 200 返回缺字段对象；Calendar 不应因一份可选只读源把主视图一起砸掉。
    const schedules = Array.isArray(next) ? next : get().schedules
    set({ schedules, loaded: true })
  },
}))

/** 合成只读日历源:path=`agent://<slug>/SCHEDULE.db`(colorForDb/isHidden 按 path 字符串键,天然可用)。 */
export function useAgentCalDbs(): AggDb[] {
  const schedules = useAgentSchedules((s) => (Array.isArray(s.schedules) ? s.schedules : []))
  return useMemo(() => schedules.map((s): AggDb => {
    const nameId = s.db.columns[0]?.id ?? ''
    return {
      path: `agent://${s.slug}/SCHEDULE.db`,
      name: s.name,
      isNoteView: false,
      readonly: true,
      columns: s.db.columns as DbColumn[],
      rows: s.db.rows.map((r) => {
        const cells = r.cells as Record<string, CellValue>
        return { rowId: r.id, name: cellText(cells[nameId]), cells }
      }),
    }
  }), [schedules])
}
