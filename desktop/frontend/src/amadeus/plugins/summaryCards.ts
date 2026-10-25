/**
 * 摘要栏插件卡(ctx.summary.registerCard,2026-10-25+)的注册表 —— 叶子模块(同 deskCompanion.ts:
 * 写入方 pluginStore、读取方 TaskSummary,pluginStore ↔ appStore 有 import 环,这里只依赖 zustand)。
 *
 * 插件往 Tangu 聊天右侧的摘要栏里加一张卡,和内置卡(进度 / 后台 / 产物 / 来源 / 工作范围 / Agent Desk)同一个栈:
 * 同样能折叠、拖动排序,收起状态和顺序由宿主按卡片记住。卡片按注册顺序排在 Agent Desk 前面。
 * 每个会话的摘要栏各挂一份:换会话 = 卸载重挂(mount 拿到的 sessionId 不会变);同屏两个聊天面板就挂两份。
 */
import { create } from 'zustand'

export interface SummaryCardHost {
  /** 这一份挂在哪个会话的摘要栏里。 */
  sessionId: string
  /** 会话的默认工作目录;没有(沙箱会话之外的特殊情况)= null。 */
  cwd: string | null
  /** 卡头右侧的计数(null = 不显示);hidden = 这一份先不画(仍挂着,之后可以再亮出来)。只影响这一份挂载。 */
  update(patch: { count?: number | null; hidden?: boolean }): void
}

export interface SummaryCardContribution {
  /** 插件内稳定 id(宿主拼成 `plugin:<pluginId>:<id>`,收起状态和顺序按它记)。 */
  id: string
  /** 卡头标题;给 `{ zh, en }` 跟随界面语言。 */
  title: string | { zh: string; en: string }
  /** 用户没点过折叠时是否收起;缺省展开。 */
  defaultCollapsed?: boolean
  /** 往卡片正文里渲染。返回卸载函数。正文高度上限 240px,超出由宿主内滚。 */
  mount(el: HTMLElement, host: SummaryCardHost): void | (() => void)
}

export interface SummaryCardHandle { dispose(): void }

export interface SummaryCardEntry {
  key: string
  pluginId: string
  title: SummaryCardContribution['title']
  defaultCollapsed: boolean
  mount: SummaryCardContribution['mount']
}

const useCards = create<{ list: SummaryCardEntry[] }>(() => ({ list: [] }))

/** 同 key 再注册 = 原位替换(插件重载不叠两份、位置不跳);被替换的旧 handle 随之变哑(按条目身份认领)。 */
export function registerSummaryCard(pluginId: string, def: SummaryCardContribution): SummaryCardHandle {
  const id = String(def?.id || '').trim()
  if (!id || typeof def?.mount !== 'function') throw new Error('registerCard: id and mount(el, host) are required')
  const t = def.title
  const title = typeof t === 'string' ? t : t && typeof t === 'object' ? { zh: String(t.zh ?? ''), en: String(t.en ?? t.zh ?? '') } : id
  const mine: SummaryCardEntry = { key: `plugin:${pluginId}:${id}`, pluginId, title, defaultCollapsed: !!def.defaultCollapsed, mount: def.mount }
  useCards.setState((s) => {
    const i = s.list.findIndex((e) => e.key === mine.key)
    return { list: i < 0 ? [...s.list, mine] : s.list.map((e, j) => (j === i ? mine : e)) }
  })
  let live = true
  return {
    dispose: () => {
      if (!live) return
      live = false
      useCards.setState((s) => (s.list.includes(mine) ? { list: s.list.filter((e) => e !== mine) } : s))
    },
  }
}

/** 插件禁用 / 重载 / setup 抛错:宿主收掉它的全部摘要卡。 */
export function revokeSummaryCards(pluginId: string): void {
  useCards.setState((s) => (s.list.some((e) => e.pluginId === pluginId) ? { list: s.list.filter((e) => e.pluginId !== pluginId) } : s))
}

export const useSummaryCards = (): SummaryCardEntry[] => useCards((s) => s.list)

/** 仅供单测复位。 */
export const __resetSummaryCards = (): void => useCards.setState({ list: [] })
