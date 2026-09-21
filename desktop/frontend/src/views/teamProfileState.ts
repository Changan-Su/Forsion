import type { AgentConfig, NormalAgentDef, TeamDef } from '../types'

export type MemberTuning = NonNullable<AgentConfig['teamMemberConfigs']>[string]

export interface TeamDraft {
  name: string
  description: string
  avatar: string
  members: TeamDef['members']
  doc: string
  tempAgents: NormalAgentDef[]
  /** 会话级成员调档(模型 / Effort);临时成员的这两项住在 tempAgents 自己的定义里,不进这张表。 */
  memberConfigs: Record<string, MemberTuning>
}

/** The current conversation can override a saved TEAM's roster. Edit the roster actually in use. */
export function teamDraft(config: AgentConfig, title: string, team?: TeamDef): TeamDraft {
  const slugs = config.groupAgents && config.groupAgents.length >= (team ? 2 : 1) ? config.groupAgents : team?.members.map((m) => m.slug) || []
  const roles = team ? Object.fromEntries(team.members.map((m) => [m.slug, m.role])) : config.teamRoles || {}
  return {
    name: team?.name ?? title, description: team?.description || '', avatar: team?.avatar || '',
    members: [...new Set(slugs)].map((slug) => ({ slug, role: roles[slug] || '' })),
    doc: team?.doc ?? config.teamDoc ?? '', tempAgents: config.groupTempAgents || [],
    memberConfigs: config.teamMemberConfigs || {},
  }
}

/** Merge into the latest session config: identity, grants, cwd and unrelated controls must survive. */
export function teamSessionConfig(current: AgentConfig, draft: TeamDraft): AgentConfig {
  const slugs = new Set(draft.members.map((m) => m.slug))
  return {
    ...current,
    groupAgents: draft.members.map((m) => m.slug),
    groupTempAgents: draft.tempAgents.filter((a) => slugs.has(a.slug)),
    teamDoc: draft.doc,
    teamRoles: Object.fromEntries(draft.members.map((m) => [m.slug, m.role.trim()])),
    teamMemberConfigs: pruneMemberConfigs(draft),
  }
}

/** 只留「还在阵容里 + 真有值」的调档:选回默认要把键删掉(留 { model: '' } 等于把空串当模型发给引擎)。 */
function pruneMemberConfigs(draft: TeamDraft): AgentConfig['teamMemberConfigs'] {
  const temps = new Set(draft.tempAgents.map((a) => a.slug))
  const out: Record<string, MemberTuning> = {}
  for (const m of draft.members) {
    if (temps.has(m.slug)) continue
    const tuning = draft.memberConfigs[m.slug]
    const model = tuning?.model?.trim() || ''
    const thinkingLevel = tuning?.thinkingLevel || undefined
    if (model || thinkingLevel) out[m.slug] = { ...(model ? { model } : {}), ...(thinkingLevel ? { thinkingLevel } : {}) }
  }
  return Object.keys(out).length ? out : undefined
}

export function moveTeamMember(members: TeamDef['members'], slug: string, delta: number): TeamDef['members'] {
  const from = members.findIndex((m) => m.slug === slug), to = from + delta
  if (from < 0 || to < 0 || to >= members.length) return members
  const next = [...members]
  const [member] = next.splice(from, 1)
  next.splice(to, 0, member)
  return next
}
