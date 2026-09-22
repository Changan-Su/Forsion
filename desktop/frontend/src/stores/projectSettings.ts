import type { AgentConfig, ProjectSettings, TeamDef, WorkspaceDescriptor } from '../types'

export type ProjectWorkspace = WorkspaceDescriptor & { kind: 'local'; path: string }

/** 只有用户自己添加的本地目录才算「Project」:系统默认工作区、Vault、通道文件夹、云端 Project 与无根会话都不是 ——
 *  与侧栏分组同一口径。默认工作区里的随手会话仍看 Agent 详情,不该被项目页顶掉。 */
export function isProjectWorkspace(ws: WorkspaceDescriptor | undefined | null): ws is ProjectWorkspace {
  return !!ws && ws.kind === 'local' && !ws.system && !!ws.path
}

/** 项目默认项 → 新会话的初始配置(+ 模型)。团队展开成**会话级配队**(groupChat + 成员 + 职责 + TEAM.md),不是 teamSlug ——
 *  teamSlug 会把会话锁成团队实体、cwd 换成团队 Library(routes/teams.ts 强制 projectless)。团队成员不足 2(定义被改过)→ 不展开。 */
export function projectDefaultsForNewSession(settings: ProjectSettings | null | undefined, teams: TeamDef[]): { config: Partial<AgentConfig>; model?: string } {
  if (!settings) return { config: {} }
  const config: Partial<AgentConfig> = {}
  if (settings.defaultAgent) config.agentSlug = settings.defaultAgent
  else if (settings.defaultTeam) {
    const team = teams.find((item) => item.slug === settings.defaultTeam)
    if (team && team.members.length >= 2) {
      config.groupChat = true
      config.groupAgents = team.members.map((m) => m.slug)
      config.teamRoles = Object.fromEntries(team.members.map((m) => [m.slug, m.role]))
      if (team.doc) config.teamDoc = team.doc
    }
  }
  if (settings.approvalMode) config.approvalMode = settings.approvalMode
  if (settings.thinkingLevel) config.thinkingLevel = settings.thinkingLevel
  return { config, ...(settings.model ? { model: settings.model } : {}) }
}

/** 只补 draft 里**缺席**(undefined)的键:用户显式选过的(含清空成 '' 的)永远优先;`agentSlug: undefined` 这类「没选」才由项目默认接管。 */
export function fillProjectDefaults(draft: AgentConfig, defaults: Partial<AgentConfig>): AgentConfig {
  const out: AgentConfig = { ...draft }
  for (const [key, value] of Object.entries(defaults) as Array<[keyof AgentConfig, AgentConfig[keyof AgentConfig]]>) {
    if (out[key] === undefined && value !== undefined) (out as Record<string, unknown>)[key] = value
  }
  return out
}

/** 新会话初始配置的三层次序:**显式选择(picks,新对话草稿里用户点过的)> 项目默认 > 上次用的档位(sticky)**。
 *  sticky 在 host 会话里恒带 approvalMode,所以不能把它当底再「只补缺席键」—— 那样项目的审批档永远轮不到(codex 评审抓的)。 */
export function newSessionConfig(sticky: Partial<AgentConfig>, project: Partial<AgentConfig>, picks: AgentConfig = {}): AgentConfig {
  return fillProjectDefaults(picks, { ...sticky, ...project })
}
