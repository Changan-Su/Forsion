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
  getMuseAutomationSuggestions,
  listMuseCards,
  patchMuseAutomationSuggestion,
} from '../services/backendService'
import type {
  AgentScheduleInfo,
  AutomationActionCatalogItem,
  AutomationSessionInfo,
  MuseAutomationSuggestion,
  MuseStatusInfo,
  MuseTriggerInfo,
  SpecialAgentsSummary,
  TanguDesktopConfig,
} from '../types'
import { homeTarget } from '../services/engine/targets'
import type { MuseCardInfo } from '../../../../tangu-agent/src/contracts/clientTypes'

/** 左栏选中项:系统自动化(muse/historian)、watch 规则或某条 agent 日程(auto 条目)。 */
export type AutomationSel =
  | { kind: 'muse' }
  | { kind: 'historian' }
  | { kind: 'trigger'; triggerId: string }
  | { kind: 'schedule'; slug: string; rowId: string }

interface AutomationState {
  loaded: boolean
  /** 只读开关与两个节奏值:设备页的 home 是那台电脑的引擎,远程来源只拿到这份摘要(P1-K10b);本机拿到的整份结构上同样满足。 */
  specialCfg: SpecialAgentsSummary | null
  museStatus: MuseStatusInfo | null
  triggers: MuseTriggerInfo[]
  /** agent 自动化的常驻会话(triggerId → sessionId 映射来源;日程条目 triggerKey=`sched:<slug>:<rowId>`)。 */
  autoSessions: AutomationSessionInfo[]
  /** agent 日程(SCHEDULE.db 聚合;「Agent 日程」组数据源)。 */
  schedules: AgentScheduleInfo[]
  /** tool_call 动作目录(构建器工具选择器+参数表单生成;旧引擎无端点 → 空)。 */
  actionsCatalog: AutomationActionCatalogItem[]
  /** Muse 给首页的任务建议(11-22 方案 A;Muse 关着 / 旧引擎 → 空)。 */
  suggestions: MuseAutomationSuggestion[]
  /** Muse 在私聊里提了、还没答的规则卡(引擎 muse_cards kind=rule, pending);首页「Muse 建议」一节最上面。 */
  pendingRules: MuseCardInfo[]
  sel: AutomationSel | null
  /** suggestion:画布里是某条 Muse 建议的草稿(存一份快照:轮询把它换掉时画布不能跟着变),存成规则后把那条记 used。 */
  builder: null | { editingId?: string; starter?: Starter; suggestion?: MuseAutomationSuggestion }
  /** 构建器挂进来的离开闸:有没保存的修改时问一句,答「否」= 不切走(D28)。文案在组件层,所以由构建器给。 */
  leaveGuard: (() => boolean) | null
  setLeaveGuard(guard: (() => boolean) | null): void
  /** 保存/启停/删除后 bump,右栏 runs 与列表跟着重拉。 */
  refreshNonce: number
  refresh(cfg: TanguDesktopConfig): Promise<void>
  setSel(sel: AutomationSel | null): void
  openBuilder(editingId?: string, starter?: Starter): void
  /** 点首页一条 Muse 建议:打开它的草稿(不建规则、不启用)。 */
  openSuggestion(id: string): void
  /** 点 × 选了理由(或直接关掉):本地先收,引擎记 dismissed 并写回 Muse 的 LOG。失败 → 放回来并抛给调用方。 */
  dismissSuggestion(id: string, reason?: string): Promise<void>
  /** 从 Automation Space 以外打开一条规则。构建器在 triggers 里找规则,找不到就是空白草稿,保存会把规则盖掉,所以先拉到再开。 */
  openRule(id: string): Promise<void>
  /** fromSuggestion:保存开始那一刻画布里那条 Muse 建议的 id(慢保存期间用户换了草稿,不能记错那条)。 */
  acceptSaved(trigger: MuseTriggerInfo, fromSuggestion?: string): void
  closeBuilder(): void
  bump(): void
}

/** 本次运行里已经 × 掉 / 存成规则的建议 id(轮询回来的旧快照里滤掉,不闪回)。 */
const settledSuggestions = new Set<string>()

/** 建议的规则 → 画布草稿(没有 id:保存是新建;先暂停,和模板同一约定)。 */
export function suggestionDraft(s: MuseAutomationSuggestion): MuseTriggerInfo {
  return { ...s.rule, id: '', desc: s.rule.desc || s.title, enabled: false, lastFiredAt: null, createdAt: '' } as MuseTriggerInfo
}

export const useAutomation = create<AutomationState>((set, get) => ({
  loaded: false,
  specialCfg: null,
  museStatus: null,
  triggers: [],
  autoSessions: [],
  schedules: [],
  actionsCatalog: [],
  suggestions: [],
  pendingRules: [],
  sel: null,
  builder: null,
  leaveGuard: null,
  refreshNonce: 0,

  async refresh(cfg) {
    const revision = get().refreshNonce
    // 六源并发,单源失败不阻断其余(旧引擎无 automation/schedule 端点 → 该项保持旧值/空)。
    // 端点在但响应形状不对(旧引擎 / 桩)时回落旧值,别把 undefined 存进列表字段 —— 列表 .map 会让整个 Space 崩掉。
    const list = <T,>(v: T[] | undefined, prev: T[]): T[] => (Array.isArray(v) ? v : prev)
    const [special, status, triggers, autoSessions, schedules, actionsCatalog, suggestions, pendingRules] = await Promise.all([
      getSpecialConfig(homeTarget()).then((r) => r.config).catch(() => get().specialCfg),
      getMuseStatus(homeTarget()).catch(() => get().museStatus),
      getMuseTriggers(homeTarget()).then((v) => list(v, get().triggers)).catch(() => get().triggers),
      getAutomationSessions(homeTarget()).then((v) => list(v, get().autoSessions)).catch(() => get().autoSessions),
      getAgentSchedules(homeTarget()).then((v) => list(v, get().schedules)).catch(() => get().schedules),
      getAutomationActions(homeTarget()).then((v) => list(v, get().actionsCatalog)).catch(() => get().actionsCatalog),
      getMuseAutomationSuggestions(homeTarget()).then((v) => list(v, get().suggestions)).catch(() => get().suggestions),
      // 读失败 ≠ 没有卡:留着上一份
      listMuseCards(homeTarget(), 'pending').then((v) => list(v, get().pendingRules).filter((c) => c.kind === 'rule')).catch(() => get().pendingRules),
    ])
    // A poll started before a save must not erase the saved rule or its selection.
    if (get().refreshNonce !== revision) return
    // 本次会话里刚 × 掉 / 存成规则的那条:引擎还没收到或轮询拿的是旧快照时别让它闪回来
    const fresh = suggestions.filter((s) => !settledSuggestions.has(s.id))
    set({ specialCfg: special, museStatus: status, triggers, autoSessions, schedules, actionsCatalog, suggestions: fresh, pendingRules, loaded: true })
    // 选中的规则/日程被删了 → 清选中
    const sel = get().sel
    if (sel?.kind === 'trigger' && !triggers.some((t) => t.id === sel.triggerId)) set({ sel: null })
    if (sel?.kind === 'schedule' && !schedules.some((s) => s.slug === sel.slug && s.entries.some((e) => e.id === sel.rowId))) set({ sel: null })
  },

  setSel(sel) {
    if (get().builder && get().leaveGuard?.() === false) return
    set({ sel, builder: null })
  },
  openBuilder(editingId, starter) {
    if (get().builder && get().leaveGuard?.() === false) return
    set({ builder: { editingId, starter } })
  },
  openSuggestion(id) {
    const suggestion = get().suggestions.find((s) => s.id === id)
    if (!suggestion) return
    if (get().builder && get().leaveGuard?.() === false) return
    set({ builder: { suggestion } })
  },
  async dismissSuggestion(id, reason) {
    const row = get().suggestions.find((s) => s.id === id)
    settledSuggestions.add(id)
    set({ suggestions: get().suggestions.filter((s) => s.id !== id) })
    try {
      await patchMuseAutomationSuggestion(homeTarget(), id, 'dismissed', reason)
    } catch (e: any) {
      if (e?.status === 409) return // 已经不在显示了(别处处理过 / 被 Muse 换掉),收着就对
      settledSuggestions.delete(id)
      // 只放回这一条,插回原来的位置附近;期间轮询换来的新一组 / 别的已 × 的不动
      if (row && !get().suggestions.some((s) => s.id === id)) set({ suggestions: [row, ...get().suggestions] })
      throw e
    }
  },
  setLeaveGuard(guard) {
    set({ leaveGuard: guard })
  },
  async openRule(id) {
    if (get().builder && get().leaveGuard?.() === false) return
    const triggers = get().triggers.some((t) => t.id === id) ? get().triggers : await getMuseTriggers(homeTarget()).catch(() => [])
    if (triggers.some((t) => t.id === id)) set({ triggers, builder: { editingId: id } })
  },
  acceptSaved(trigger, fromSuggestion) {
    // 草稿来自 Muse 建议:存成了规则 → 那条记 used(写回 Muse 的 LOG),首页不再显示。失败不挡保存,下次轮询会再画出来。
    const suggestionId = fromSuggestion
    if (suggestionId) {
      settledSuggestions.add(suggestionId)
      set((s) => ({ suggestions: s.suggestions.filter((x) => x.id !== suggestionId) }))
      void patchMuseAutomationSuggestion(homeTarget(), suggestionId, 'used').catch(() => { settledSuggestions.delete(suggestionId) })
    }
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
