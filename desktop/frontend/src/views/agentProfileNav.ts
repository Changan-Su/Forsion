import { setActiveSpace, useWorkspace } from '@lcl/engine'

/** 在 Agents Space 主区打开某个 Agent 的详情。单独成模块:聊天区(HistorianStatus 的复盘提醒)也要跳过来,
 *  不该为两行导航把整个 AgentProfileView 拖进聊天 chunk。
 *  section:直达某个标签(提醒点开要落在「进化」而不是「配置」);sectionAt 让同一 Agent 已打开时也能再次跳转(视图按它重挂)。
 *  reuseKey 'primary':singleton 视图已开着时 openView 只聚焦不换参数(dockviewStore),带上它才会把 agentSlug / section 合并进去 ——
 *  没有它,「Agents 已经开着看 A,再点 B 的详情」只是聚焦回 A。 */
export function openAgentProfile(slug: string, section?: 'evolution'): void {
  setActiveSpace('agents')
  useWorkspace.getState().openView('agent-profile', { reuseKey: 'primary', agentSlug: slug, creating: false, ...(section ? { section, sectionAt: Date.now() } : {}) }, 'main')
}
