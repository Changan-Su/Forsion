/**
 * 会话标题的**显示**口径(评审 U-30 A 类):引擎新建会话时落库的标题就是字面量 `New Chat`
 * (tangu-agent `sessions.ts`),中文界面里不该原样露英文。显示层统一过这一道;
 * 落库值不改 —— `appStore` 的首条消息自动改名仍按 `=== 'New Chat'` 判「还没起过名」。
 */
import { agentName, agentNames } from './agentName'
import { registerMessages } from './i18n'
import type { NormalAgentDef, WorkspaceDescriptor } from './types'

registerMessages({
  'session.untitled': { zh: '新会话', en: 'New session' },
  // 评审 U-38b(拍板 #6):「不在项目中工作」是**选择器里的动作**;作侧栏组头 / 工作区详情标题时改说它装的是什么。
  'session.rootlessGroup': { zh: '无项目会话', en: 'No project' },
})

/** 引擎给未命名会话落库的占位标题。 */
export const ENGINE_UNTITLED_SESSION = 'New Chat'

/** 空标题或引擎占位标题 → 当前语言的「新会话」;其余原样返回。 */
export function displaySessionTitle(title: string | null | undefined, t: (key: string) => string): string {
  const s = (title || '').trim()
  return !s || s === ENGINE_UNTITLED_SESSION ? t('session.untitled') : (title as string)
}

/** 私聊:没起过题时显示 Agent 现在的名字(名字随语言和改名变,引擎不落库);老会话落库的是建会话时的名字,也按没起过题算。 */
export function soloSessionTitle(title: string | null | undefined, agent: NormalAgentDef | undefined, t: (key: string) => string): string {
  const s = (title || '').trim()
  return agent && (!s || s === ENGINE_UNTITLED_SESSION || agentNames(agent).includes(s)) ? agentName(agent) : displaySessionTitle(title, t)
}

/** 工作区作**组头 / 详情标题**时的显示名:无根组换成「无项目会话」,其余用落盘名(选择器里仍显示 ws.name 原文)。 */
export function workspaceGroupLabel(ws: Pick<WorkspaceDescriptor, 'kind' | 'name'>, t: (key: string) => string): string {
  return ws.kind === 'rootless' ? t('session.rootlessGroup') : ws.name
}
