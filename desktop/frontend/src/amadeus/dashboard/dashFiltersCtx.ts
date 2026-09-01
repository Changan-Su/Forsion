/** 仪表盘页面级筛选的下发接缝:宿主(DashboardGridView)供值,数据消费方(多维表 chart
 *  视图等)可选消费。默认空 = 非仪表盘宿主(笔记嵌入 / 独立 tab / 画布版)零感知。 */
import { createContext } from 'react'
import type { DashFilter } from '@amadeus-shared/dashboardData'

export const DashFiltersCtx = createContext<DashFilter[]>([])
