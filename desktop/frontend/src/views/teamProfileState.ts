import type { AgentConfig, NormalAgentDef, TeamDef } from '../types'

export interface TeamDraft {
  name: string
  description: string
  avatar: string
  members: TeamDef['members']
  doc: string
  tempAgents: NormalAgentDef[]
}

/** The current conversation can override a saved TEAM's roster. Edit the roster actually in use. */
export function teamDraft(config: AgentConfig, title: string, team?: TeamDef): TeamDraft {
  const slugs = config.groupAgents && config.groupAgents.length >= (team ? 2 : 1) ? config.groupAgents : team?.members.map((m) => m.slug) || []
  const roles = team ? Object.fromEntries(team.members.map((m) => [m.slug, m.role])) : config.teamRoles || {}
  return {
    name: team?.name ?? title, description: team?.description || '', avatar: team?.avatar || '',
    members: [...new Set(slugs)].map((slug) => ({ slug, role: roles[slug] || '' })),
    doc: team?.doc ?? config.teamDoc ?? '', tempAgents: config.groupTempAgents || [],
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
  }
}

export function moveTeamMember(members: TeamDef['members'], slug: string, delta: number): TeamDef['members'] {
  const from = members.findIndex((m) => m.slug === slug), to = from + delta
  if (from < 0 || to < 0 || to >= members.length) return members
  const next = [...members]
  const [member] = next.splice(from, 1)
  next.splice(to, 0, member)
  return next
}
