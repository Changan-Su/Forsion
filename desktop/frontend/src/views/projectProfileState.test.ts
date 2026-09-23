import { describe, expect, it } from 'vitest'
import { executorOf, projectExecutors, relativeTimeOf, shortenPath } from './projectProfileState'
import { fillProjectDefaults, isProjectWorkspace, newSessionConfig, projectDefaultsForNewSession } from '../stores/projectSettings'
import type { SessionRecord, TeamDef } from '../types'

const session = (id: string, over: Partial<SessionRecord> = {}): SessionRecord => ({
  id, title: id, model_id: null, archived: false, emoji: null, agent_config: null, project_path: '/p/a', project_name: 'a',
  created_at: '2026-09-01T00:00:00Z', updated_at: '2026-09-01T00:00:00Z', ...over,
})

describe('projectExecutors', () => {
  it('按会话推导执行者:同 Agent 合并、团队实体 / 临时配队 / 外部引擎各自成行;当前会话置顶,其余按最近活动;别的项目与无根会话不算', () => {
    const sessions = [
      session('s1', { agent_config: { agentSlug: 'coder' }, updated_at: '2026-09-02T00:00:00Z' }),
      session('s2', { agent_config: { agentSlug: 'coder' }, updated_at: '2026-09-05T00:00:00Z' }),
      session('s3', { agent_config: { groupChat: true, groupAgents: ['a', 'b'] }, updated_at: '2026-09-03T00:00:00Z' }),
      session('s4', { agent_config: { teamSlug: 'squad', groupChat: true }, updated_at: '2026-09-04T00:00:00Z' }),
      session('s5', { agent_config: { engineId: 'codex' }, updated_at: '2026-09-06T00:00:00Z' }),
      session('s6', { agent_config: {}, updated_at: '2026-09-07T00:00:00Z' }), // 存值没 agent → 全局默认
      session('other', { project_path: '/p/b', agent_config: { agentSlug: 'coder' }, updated_at: '2026-09-09T00:00:00Z' }),
      session('rootless', { projectless: true, project_path: null, agent_config: { agentSlug: 'coder' }, updated_at: '2026-09-09T00:00:00Z' }),
    ]
    const out = projectExecutors({ sessions, projectPath: '/p/a', configBySession: { s2: { agentSlug: 'writer' } }, runningBySession: { s3: 'run' }, defaultSlug: 'xyra', currentSessionId: 's3' })
    expect(out.map((e) => [e.key, e.sessions.map((s) => s.id), e.running, e.current])).toEqual([
      ['party:s3', ['s3'], true, true],
      ['agent:xyra', ['s6'], false, false],
      ['engine:codex', ['s5'], false, false],
      ['agent:writer', ['s2'], false, false], // 会话存值(configBySession)压过会话行上的 agent_config
      ['team:squad', ['s4'], false, false],
      ['agent:coder', ['s1'], false, false],
    ])
  })

  it('默认工作区换过目录:别名路径下的旧会话仍算这个项目的', () => {
    const sessions = [session('new', { project_path: '/vault/Sessions', agent_config: { agentSlug: 'a' } }), session('old', { project_path: '/Users/me/Tangu', agent_config: { agentSlug: 'b' } }), session('x', { project_path: '/elsewhere' })]
    const out = projectExecutors({ sessions, projectPath: '/vault/Sessions', aliases: ['/vault/Sessions', '/Users/me/Tangu'], configBySession: {}, runningBySession: {}, defaultSlug: 'd' })
    expect(out.map((e) => e.key).sort()).toEqual(['agent:a', 'agent:b'])
  })

  it('executorOf:teamSlug 优先于 groupChat,engine 优先于 agent', () => {
    expect(executorOf(session('x'), { teamSlug: 't', groupChat: true, agentSlug: 'a' }, 'd').key).toBe('team:t')
    expect(executorOf(session('x'), { soloEngineId: 'pi', agentSlug: 'a' }, 'd').key).toBe('engine:pi')
    expect(executorOf(session('x'), { soloAgentSlug: 'solo' }, 'd').key).toBe('agent:solo')
    expect(executorOf(session('x'), null, 'd').key).toBe('agent:d')
  })
})

describe('project defaults', () => {
  const teams: TeamDef[] = [
    { slug: 'squad', name: 'Squad', description: '', lead: '', avatar: '', members: [{ slug: 'a', role: 'lead' }, { slug: 'b', role: '' }], createdAt: '', doc: 'TEAM doc', libraryDir: '' },
    { slug: 'solo', name: 'Solo', description: '', lead: '', avatar: '', members: [{ slug: 'a', role: '' }], createdAt: '', doc: '', libraryDir: '' },
  ]
  it('Agent 默认 → agentSlug;团队默认展开成会话级配队(不是 teamSlug);成员不足 2 的团队不展开', () => {
    expect(projectDefaultsForNewSession({ defaultAgent: 'coder', approvalMode: 'full-auto', thinkingLevel: 'high', model: 'm' }, teams))
      .toEqual({ config: { agentSlug: 'coder', approvalMode: 'full-auto', thinkingLevel: 'high' }, model: 'm' })
    expect(projectDefaultsForNewSession({ defaultTeam: 'squad' }, teams).config)
      .toEqual({ groupChat: true, groupAgents: ['a', 'b'], teamRoles: { a: 'lead', b: '' }, teamDoc: 'TEAM doc' })
    expect(projectDefaultsForNewSession({ defaultTeam: 'solo' }, teams)).toEqual({ config: {} })
    expect(projectDefaultsForNewSession(null, teams)).toEqual({ config: {} })
  })

  it('fillProjectDefaults 只补缺席的键:用户显式选过的(含空串)优先', () => {
    expect(fillProjectDefaults({ agentSlug: undefined, approvalMode: 'readonly' }, { agentSlug: 'coder', approvalMode: 'full-auto', thinkingLevel: 'low' }))
      .toEqual({ agentSlug: 'coder', approvalMode: 'readonly', thinkingLevel: 'low' })
  })

  it('newSessionConfig 三层次序:显式选择 > 项目默认 > 上次用的档位(sticky 恒带审批档也压不住项目默认)', () => {
    const sticky = { approvalMode: 'auto-edit' as const, thinkingLevel: 'low' as const }
    const project = { agentSlug: 'coder', approvalMode: 'full-auto' as const }
    expect(newSessionConfig(sticky, project)).toEqual({ agentSlug: 'coder', approvalMode: 'full-auto', thinkingLevel: 'low' })
    expect(newSessionConfig(sticky, project, { approvalMode: 'readonly', agentSlug: undefined })).toEqual({ agentSlug: 'coder', approvalMode: 'readonly', thinkingLevel: 'low' })
    expect(newSessionConfig(sticky, {}, {})).toEqual(sticky)
  })

  it('isProjectWorkspace:用户添加的本地目录 + Tangu 默认工作区;Vault 等其余系统目录不算', () => {
    expect(isProjectWorkspace({ key: '/p', name: 'p', kind: 'local', path: '/p' })).toBe(true)
    expect(isProjectWorkspace({ key: '/d', name: '默认工作区', kind: 'local', path: '/d', system: true, isDefault: true })).toBe(true)
    expect(isProjectWorkspace({ key: '/v', name: 'Vault', kind: 'local', path: '/v', system: true })).toBe(false)
    expect(isProjectWorkspace({ key: '__default__', name: '默认工作区', kind: 'local', path: null, system: true, isDefault: true })).toBe(false)
    expect(isProjectWorkspace({ key: '__cloud__:Tangu', name: 'Tangu', kind: 'cloud', path: null })).toBe(false)
    expect(isProjectWorkspace({ key: 'c', name: 'c', kind: 'channel', path: '/c' })).toBe(false)
    expect(isProjectWorkspace(undefined)).toBe(false)
  })
})

describe('display helpers', () => {
  it('shortenPath 只缩家目录前缀;relativeTimeOf 跟界面语言', () => {
    expect(shortenPath('/Users/me/Code/x', '/Users/me')).toBe('~/Code/x')
    expect(shortenPath('/Users/meow/x', '/Users/me')).toBe('/Users/meow/x')
    expect(shortenPath('C:\\Users\\me\\x', 'C:\\Users\\me')).toBe('~/x')
    const now = Date.parse('2026-09-22T12:00:00Z')
    expect(relativeTimeOf(now - 3 * 86400_000, now, 'zh-CN')).toBe('3天前')
    expect(relativeTimeOf(now - 3 * 86400_000, now, 'en')).toBe('3 days ago')
  })
})
