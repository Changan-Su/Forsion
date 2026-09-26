/**
 * 「自动化」Space 的跨栏通道(照 calendarNavStore 先例:左栏列表/主区详情/右栏运行记录共享同一 store)。
 * 数据=四个现成端点聚合(special config / muse status / triggers / automation sessions);
 * 文案不在这里拼(i18n 归组件层),store 只存原始数据 + 选中态 + 构建器态。
 */
import { create } from 'zustand'
import type { Starter } from '../views/automation/experience'
import {
  getAgentSchedules,
  getAutomationActions,
  getAutomationSessions,
  getMuseStatus,
  getMuseTriggers,
  getSpecialConfig,
} from '../services/backendService'
import type {
  AgentScheduleInfo,
  AutomationActionCatalogItem,
  AutomationSessionInfo,
  MuseStatusInfo,
  MuseTriggerInfo,
  SpecialAgentsConfig,
  TanguDesktopConfig,
} from '../types'

/** 左栏选中项:系统自动化(muse/historian)、watch 规则或某条 agent 日程(auto 条目)。 */
export type AutomationSel =
  | { kind: 'muse' }
  | { kind: 'historian' }
  | { kind: 'trigger'; triggerId: string }
  | { kind: 'schedule'; slug: string; rowId: string }

interface AutomationState {
  loaded: boolean
  specialCfg: SpecialAgentsConfig | null
  museStatus: MuseStatusInfo | null
  triggers: MuseTriggerInfo[]
  /** agent 自动化的常驻会话(triggerId → sessionId 映射来源;日程条目 triggerKey=`sched:<slug>:<rowId>`)。 */
  autoSessions: AutomationSessionInfo[]
  /** agent 日程(SCHEDULE.db 聚合;「Agent 日程」组数据源)。 */
  schedules: AgentScheduleInfo[]
  /** tool_call 动作目录(构建器工具选择器+参数表单生成;旧引擎无端点 → 空)。 */
  actionsCatalog: AutomationActionCatalogItem[]
  sel: AutomationSel | null
  builder: null | { editingId?: string; starter?: Starter }
  /** 保存/启停/删除后 bump,右栏 runs 与列表跟着重拉。 */
  refreshNonce: number
  refresh(cfg: TanguDesktopConfig): Promise<void>
  setSel(sel: AutomationSel | null): void
  openBuilder(editingId?: string, starter?: Starter): void
  acceptSaved(trigger: MuseTriggerInfo): void
  closeBuilder(): void
  bump(): void
}

export const useAutomation = create<AutomationState>((set, get) => ({
  loaded: false,
  specialCfg: null,
  museStatus: null,
  triggers: [],
  autoSessions: [],
  schedules: [],
  actionsCatalog: [],
  sel: null,
  builder: null,
  refreshNonce: 0,

  async refresh(cfg) {
    const revision = get().refreshNonce
    // 六源并发,单源失败不阻断其余(旧引擎无 automation/schedule 端点 → 该项保持旧值/空)。
    // 端点在但响应形状不对(旧引擎 / 桩)时回落旧值,别把 undefined 存进列表字段 —— 列表 .map 会让整个 Space 崩掉。
    const list = <T,>(v: T[] | undefined, prev: T[]): T[] => (Array.isArray(v) ? v : prev)
    const [special, status, triggers, autoSessions, schedules, actionsCatalog] = await Promise.all([
      getSpecialConfig(cfg).then((r) => r.config).catch(() => get().specialCfg),
      getMuseStatus(cfg).catch(() => get().museStatus),
      getMuseTriggers(cfg).then((v) => list(v, get().triggers)).catch(() => get().triggers),
      getAutomationSessions(cfg).then((v) => list(v, get().autoSessions)).catch(() => get().autoSessions),
      getAgentSchedules(cfg).then((v) => list(v, get().schedules)).catch(() => get().schedules),
      getAutomationActions(cfg).then((v) => list(v, get().actionsCatalog)).catch(() => get().actionsCatalog),
    ])
    // A poll started before a save must not erase the saved rule or its selection.
    if (get().refreshNonce !== revision) return
    set({ specialCfg: special, museStatus: status, triggers, autoSessions, schedules, actionsCatalog, loaded: true })
    // 选中的规则/日程被删了 → 清选中
    const sel = get().sel
    if (sel?.kind === 'trigger' && !triggers.some((t) => t.id === sel.triggerId)) set({ sel: null })
    if (sel?.kind === 'schedule' && !schedules.some((s) => s.slug === sel.slug && s.entries.some((e) => e.id === sel.rowId))) set({ sel: null })
  },

  setSel(sel) {
    set({ sel, builder: null })
  },
  openBuilder(editingId, starter) {
    set({ builder: { editingId, starter } })
  },
  acceptSaved(trigger) {
    set((s) => ({ triggers: [...s.triggers.filter((t) => t.id !== trigger.id), trigger],
      sel: { kind: 'trigger', triggerId: trigger.id }, builder: null, refreshNonce: s.refreshNonce + 1 }))
  },
  closeBuilder() {
    set({ builder: null })
  },
  bump() {
    set((s) => ({ refreshNonce: s.refreshNonce + 1 }))
  },
}))

/** 规则的常驻会话 id(还没触发过 → null)。 */
export function sessionForTrigger(autoSessions: AutomationSessionInfo[], triggerId: string): string | null {
  return autoSessions.find((s) => s.triggerId === triggerId)?.id || null
}
