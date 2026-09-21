/**
 * Agent Desk 伴随面(ctx.desk.registerCompanion,2026-09-19+)的注册表 —— 叶子模块。
 *
 * 插件往 Tangu 聊天右侧的 Agent Desk 里挂一块自绘区域(典型:会跟着 agent 状态做反应的 3D 形象)。
 * 为什么是叶子:写入方 pluginStore、读取方 AgentDesk / ChatView / ChatWikiLink / appStore 的 desk
 * 写入口都要用它,而 pluginStore ↔ appStore 之间有既有 import 环(见 tanguSeam.ts 顶注)。
 * 这里只依赖 zustand,各方单向依赖它。
 *
 * 两种模式(插件自己声明,可随时 update):
 *  - 'idle'   :Desk 里**没有任何展示条目**时,卡片空态位换成伴随面(草稿态 / 空会话 / 清空后)。
 *               一旦 agent 往 Desk 上放东西,伴随面让位;卡片与侧板头部出现「清空 Desk」把它请回来。
 *  - 'always' :**完全替换** —— 卡片与展开侧板都只显示伴随面,Desk 的文件展示整体停用:
 *               agent 的 desk_present / 编辑自动上台 / 直播格不再落状态,一律按 Desk 关闭时的老路走:
 *               聊天里点引用 → 新标签页;概览的「正在编辑」入口隐藏(标签页没有实时源,开了只是半截/旧内容);
 *               desk_screenshot 照截形象但标 companion(deskCapture 按 DOM 判,引擎据此告诉模型「这是插件画的」)。
 *               判据单源 = `deskAcceptsFiles()`。
 *
 * 同一时刻只有一个生效者:**最后注册的那个**(栈顶)。它 dispose 后退回前一个。
 */
import { create } from 'zustand'

export type DeskCompanionMode = 'always' | 'idle'

/** 伴随面挂在哪:卡片态(小、只读预览、正文 zoom:0.75 + pointer-events:none)或展开侧板(可交互)。 */
export type DeskCompanionSurface = 'desk-card' | 'desk-panel'

/** Agent 在这个 Desk 所属会话里的状态(与 ctx.tangu.agentStatus 同一份类型,定义在 tanguSeam)。 */
export type { TanguAgentStatus as DeskAgentStatus } from './tanguSeam'
import type { TanguAgentStatus } from './tanguSeam'

/** 宿主递给 `mount` 的第二个参数:这一块挂载点的身份与它所属会话的 agent 状态。 */
export interface DeskCompanionHost {
  surface: DeskCompanionSurface
  /** 这个 Desk 当前对应的会话 id;新对话草稿 = null。首条消息发出(null → 真 id)与切会话都**不重挂**,
   *  只经 onStatus 通知 —— 插件别据此重载模型。 */
  sessionId(): string | null
  /** 拉取式快照。宿主没有状态探针时恒为 idle。流式回答期间要跟「说话量」就自己按帧拉 textChars。 */
  status(): TanguAgentStatus
  /** phase / tool / waitingFor / sessionId / agentSlug **真的变了**才回调(每个 SSE 增量不回调,
   *  改 Agent 展示名也不回调)。换 Agent 会响一次 —— 按 Agent 挑形象的伴随面据此换装。返回退订;
   *  卸载时宿主也会统一收掉。 */
  onStatus(cb: (s: TanguAgentStatus) => void): () => void
}

export interface DeskCompanionContribution {
  /** 插件内稳定 id(宿主拼成 `plugin:<pluginId>:<id>`)。 */
  id: string
  mode: DeskCompanionMode
  /** 往宿主给的容器里渲染(容器已撑满可用区域、position:relative)。返回卸载函数。
   *  ⚠️卡片与侧板是**两个挂载点**:收起/展开在两者间切换,多个聊天面板各有一张卡片 —— 同时可能挂着
   *  不止一份,重资源(WebGL 上下文、解析好的模型)请插件自己在模块级缓存/复用。 */
  mount(el: HTMLElement, host: DeskCompanionHost): void | (() => void)
}

export interface DeskCompanionHandle {
  /** 就地改模式(设置页切 always/idle 用),不重注册、不重挂。 */
  update(patch: { mode?: DeskCompanionMode }): void
  dispose(): void
}

export interface DeskCompanionEntry {
  /** `plugin:<pluginId>:<id>` —— React key 与身份判定都用它。 */
  key: string
  pluginId: string
  mode: DeskCompanionMode
  mount: DeskCompanionContribution['mount']
}

interface State { stack: DeskCompanionEntry[] }
const useCompanions = create<State>(() => ({ stack: [] }))

const isMode = (m: unknown): m is DeskCompanionMode => m === 'always' || m === 'idle'

/** pluginStore 的 ctx.desk.registerCompanion 落到这里。同 key 再注册 = 替换(插件重载不叠两份),
 *  **被替换的旧 handle 随之变哑**:update / dispose 按条目身份认领,不按 key —— 否则「先注册新的、再 dispose
 *  旧的」(防闪烁的常见写法)会把新条目撤掉,旧 handle 迟到的 update 也会翻新条目的模式。 */
export function registerDeskCompanion(pluginId: string, def: DeskCompanionContribution): DeskCompanionHandle {
  const id = String(def?.id || '').trim()
  if (!id || typeof def?.mount !== 'function') throw new Error('registerCompanion: id and mount(el, host) are required')
  const key = `plugin:${pluginId}:${id}`
  // 本 handle 名下的条目;update 换出新对象(让 useDeskCompanion 重渲染)时跟着换。不在栈里 = 已被替换 / 吊销。
  let mine: DeskCompanionEntry = { key, pluginId, mode: isMode(def.mode) ? def.mode : 'idle', mount: def.mount }
  useCompanions.setState((s) => ({ stack: [...s.stack.filter((e) => e.key !== key), mine] }))
  let live = true
  return {
    update: (patch) => {
      if (!live || !isMode(patch?.mode)) return
      const { stack } = useCompanions.getState()
      if (!stack.includes(mine)) return
      const cur = mine
      mine = { ...cur, mode: patch.mode }
      useCompanions.setState({ stack: stack.map((e) => (e === cur ? mine : e)) })
    },
    dispose: () => {
      if (!live) return
      live = false
      useCompanions.setState((s) => (s.stack.includes(mine) ? { stack: s.stack.filter((e) => e !== mine) } : s))
    },
  }
}

/** 插件禁用 / 重载 / setup 抛错:宿主收掉它的全部伴随面(插件忘了 dispose 也不留死挂载)。 */
export function revokeDeskCompanions(pluginId: string): void {
  useCompanions.setState((s) => (s.stack.some((e) => e.pluginId === pluginId)
    ? { stack: s.stack.filter((e) => e.pluginId !== pluginId) }
    : s))
}

/** 当前生效的伴随面(栈顶);没有 → null。 */
export const activeDeskCompanion = (): DeskCompanionEntry | null => {
  const st = useCompanions.getState().stack
  return st.length ? st[st.length - 1] : null
}

export function useDeskCompanion(): DeskCompanionEntry | null {
  return useCompanions((s) => (s.stack.length ? s.stack[s.stack.length - 1] : null))
}

export const subscribeDeskCompanion = (cb: () => void): (() => void) => useCompanions.subscribe(cb)

/** 'always' 伴随面生效 = Desk 的文件展示被整体替换。 */
export const deskReplacedByCompanion = (): boolean => activeDeskCompanion()?.mode === 'always'

/** **「Desk 收不收文件」的唯一判据**:store 的 desk 写入口(deskPresent / deskAutoShow / deskLiveSync /
 *  deskShowFile)与所有「点了在 Desk 里开」的路由点(ChatView 概览入口、ChatWikiLink 引用条)逐字同源。
 *  任何一处只判 agentDeskEnabled = always 模式下把文件塞进一个不显示文件的 Desk = 点了没反应。
 *  `deskOn` = 调用方原本的「Desk 在场」判据(agentDeskEnabled,路由点另含 UI_MODE/activeId 那几条)。 */
export const deskAcceptsFiles = (deskOn: boolean): boolean => deskOn && !deskReplacedByCompanion()

/** React 版:always ↔ idle 切换要让 ChatView 重渲染(入口显隐跟着变)。 */
export function useDeskAcceptsFiles(deskOn: boolean): boolean {
  const replaced = useCompanions((s) => s.stack.length > 0 && s.stack[s.stack.length - 1].mode === 'always')
  return deskOn && !replaced
}

/** 仅供单测复位。 */
export const __resetDeskCompanions = (): void => useCompanions.setState({ stack: [] })
