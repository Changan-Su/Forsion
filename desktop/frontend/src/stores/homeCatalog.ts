/**
 * 「本端」的 Agent 目录(P1-K6 S2;K6 待定 4 的缺省:焦点在「我的电脑」时管理面板恒显示 home)。
 *
 * appStore 顶层的 agentDefs / agentAvatars 永远是**焦点目标**的目录(聊天面按它选 Agent、盖身份)。
 * 手机把整端切到一台电脑之后,收件箱发件人、自动化规则里引用的 Agent 仍是本端的(收件箱 / 自动化是 home 类,
 * 请求恒打 home)—— 这些读者改读这里:焦点在 home = 顶层那份;焦点在 unit = 目录缓存里 home 那份
 * (services/engine/catalog.ts,换焦点时 ensureCatalog('home') 预热)。
 */
import type { NormalAgentDef } from '../types'
import { useApp } from './appStore'
import { useEngineFocus } from '../services/engine/targets'
import { useTargetCatalogs } from '../services/engine/catalog'

const NO_AGENTS: NormalAgentDef[] = []
const NO_AVATARS: Record<string, string> = {}

const focusIsHome = (): boolean => useEngineFocus.getState().ref.kind === 'home'

export function homeAgentDefs(): NormalAgentDef[] {
  return focusIsHome() ? useApp.getState().agentDefs : (useTargetCatalogs.getState().byKey.home?.agents ?? NO_AGENTS)
}

export function homeAgentAvatars(): Record<string, string> {
  return focusIsHome() ? useApp.getState().agentAvatars : (useTargetCatalogs.getState().byKey.home?.avatars ?? NO_AVATARS)
}

export function useHomeAgentDefs(): NormalAgentDef[] {
  const home = useEngineFocus((s) => s.ref.kind === 'home')
  const top = useApp((s) => s.agentDefs)
  const cached = useTargetCatalogs((s) => s.byKey.home?.agents)
  return home ? top : (cached ?? NO_AGENTS)
}

export function useHomeAgentAvatars(): Record<string, string> {
  const home = useEngineFocus((s) => s.ref.kind === 'home')
  const top = useApp((s) => s.agentAvatars)
  const cached = useTargetCatalogs((s) => s.byKey.home?.avatars)
  return home ? top : (cached ?? NO_AVATARS)
}

/** 非 React 列表源:home 目录变了才通知(appStore 流式时变得很勤,只看这两样;焦点切换也算一次变化)。 */
export function subscribeHomeAgents(cb: () => void): () => void {
  const offApp = useApp.subscribe((s, p) => { if (focusIsHome() && (s.agentDefs !== p.agentDefs || s.agentAvatars !== p.agentAvatars)) cb() })
  const offCat = useTargetCatalogs.subscribe((s, p) => { if (!focusIsHome() && s.byKey.home !== p.byKey.home) cb() })
  const offFocus = useEngineFocus.subscribe((s, p) => { if (s.ref !== p.ref) cb() })
  return () => { offApp(); offCat(); offFocus() }
}
