/**
 * 新对话选择条状态句 = 发送链同一套解析(Codex 第一轮 B2-1 / B2-2)。
 * 发送侧的对应断言:projectSettings.test(fillProjectDefaults 只补缺席键)+ chatPreset.test(newChatProjectPath)。
 */
import { describe, expect, it } from 'vitest'
import { draftDispatch } from './agentSelectStatus'
import { newSessionConfig, projectDefaultsForNewSession } from '../stores/projectSettings'
import type { TeamDef } from '../types'

const TEAM: TeamDef = { slug: 'crew', name: 'Crew', members: [{ slug: 'a', role: 'lead' }, { slug: 'b', role: 'dev' }, { slug: 'c', role: 'qa' }] } as TeamDef
const teamProject = projectDefaultsForNewSession({ defaultTeam: 'crew' }, [TEAM]).config
const agentProject = projectDefaultsForNewSession({ defaultAgent: 'proj-agent' }, [TEAM]).config

describe('draftDispatch', () => {
  it('B2-1:草稿没选人、项目默认团队 → 报团队(发送会起多人团队)', () => {
    expect(draftDispatch({}, teamProject, 'global')).toEqual({ kind: 'team', count: 3 })
  })
  it('B2-2:清空已选 Agent(groupChat:false + agentSlug 缺席)→ 发送由项目默认 Agent 接手,状态句也报它', () => {
    const cleared = { groupChat: false, agentSlug: undefined }
    expect(draftDispatch(cleared, agentProject, 'global')).toEqual({ kind: 'agent', slug: 'proj-agent' })
    // 与发送链的物化结果逐项对齐(send → newSessionConfig → fillProjectDefaults)
    expect(newSessionConfig({}, agentProject, cleared).agentSlug).toBe('proj-agent')
  })
  it('清空后的 groupChat:false 挡住项目默认团队 → 回落全局默认 Agent(与发送一致)', () => {
    const cleared = { groupChat: false, agentSlug: undefined }
    expect(newSessionConfig({}, teamProject, cleared).groupChat).toBe(false)
    expect(draftDispatch(cleared, teamProject, 'global')).toEqual({ kind: 'agent', slug: 'global' })
  })
  it('没有项目:全局默认;都没有:匿名', () => {
    expect(draftDispatch({}, {}, 'global')).toEqual({ kind: 'agent', slug: 'global' })
    expect(draftDispatch({}, {}, null)).toEqual({ kind: 'agent', slug: null })
  })
})
