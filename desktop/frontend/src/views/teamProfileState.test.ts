import { describe, expect, it } from 'vitest'
import type { AgentConfig, NormalAgentDef, TeamDef } from '../types'
import { moveTeamMember, teamDraft, teamSessionConfig } from './teamProfileState'

const team: TeamDef = { slug: 'atlas', name: 'Atlas', description: 'Research', avatar: '🧭', lead: 'a', members: [{ slug: 'a', role: 'Plan' }, { slug: 'b', role: 'Review' }], doc: 'Cite sources', libraryDir: '/atlas', createdAt: '' }

describe('party configuration', () => {
  it('edits the effective conversation roster while using the saved TEAM charter and roles', () => {
    const draft = teamDraft({ groupAgents: ['b', 'c', 'b'], teamDoc: 'stale', teamRoles: { b: 'stale' } }, 'Chat title', team)
    expect(draft.name).toBe('Atlas')
    expect(draft.doc).toBe('Cite sources')
    expect(draft.members).toEqual([{ slug: 'b', role: 'Review' }, { slug: 'c', role: '' }])
  })
  it('uses the saved roster when the conversation has no roster override', () => {
    expect(teamDraft({}, '', team).members).toEqual(team.members)
    expect(teamDraft({ groupAgents: ['a'] }, '', team).members).toEqual(team.members)
  })
  it('keeps missing member slugs visible so load failure cannot silently remove them', () => {
    expect(teamDraft({ groupAgents: ['a', 'deleted'], teamRoles: { deleted: 'Research' } }, 'Session').members).toEqual([{ slug: 'a', role: '' }, { slug: 'deleted', role: 'Research' }])
  })
  it('merges only team fields and preserves identity, paused mode and newer execution settings', () => {
    const current: AgentConfig = { teamSlug: 'atlas', groupChat: false, execMode: 'host', cwd: '/atlas', approvalMode: 'readonly', enabledMcpServers: [], extraRoots: ['/sources'] }
    const draft = teamDraft({}, '', team)
    const next = teamSessionConfig(current, { ...draft, members: [{ slug: 'b', role: ' Review ' }, { slug: 'a', role: '' }] })
    expect(next).toMatchObject(current)
    expect(next.groupAgents).toEqual(['b', 'a'])
    expect(next.teamRoles).toEqual({ b: 'Review', a: '' })
    expect(current.groupAgents).toBeUndefined()
  })
  it('keeps included temporary definitions and removes only excluded ones from config', () => {
    const temp = { slug: 'temp', name: 'Temp', systemPrompt: 'Verify evidence' } as NormalAgentDef
    const draft = teamDraft({ groupAgents: ['a', 'temp'], groupTempAgents: [temp, { ...temp, slug: 'removed' }], teamRoles: { removed: 'stale', temp: 'Research' } }, 'Project party')
    const next = teamSessionConfig({}, draft)
    expect(next.groupTempAgents).toEqual([temp])
    expect(next.teamRoles).toEqual({ a: '', temp: 'Research' })
    expect(next.teamSlug).toBeUndefined()
  })
  it('moves a member without losing roles or mutating the source, and ignores invalid moves', () => {
    const moved = moveTeamMember(team.members, 'b', -1)
    expect(moved).toEqual([team.members[1], team.members[0]])
    expect(team.members[0].slug).toBe('a')
    expect(moveTeamMember(team.members, 'a', -1)).toBe(team.members)
    expect(moveTeamMember(team.members, 'absent', 1)).toBe(team.members)
  })
})
