/**
 * 新对话「Agent 选择条」状态句的判定(纯函数,单测钉住):**与发送链同一套解析** —— 草稿(newChatCfg)只补缺席键,
 * 由项目默认项(projectDefaultsForNewSession)填,仍没有 Agent 时 send() 兜底全局默认 Agent。
 *
 * Codex 第一轮 B2-1 / B2-2:原来按「agentSlug 与 groupChat **都**缺席才看项目」共用一个条件 ——
 *  - 没显式选项目时直接不看项目 → 隐式默认工作区的项目默认团队漏报(B2-1,由 newChatProjectPath 修);
 *  - 清空已选 Agent 会写 groupChat:false、agentSlug:undefined:发送时 agentSlug 仍由项目默认 Agent 补上,
 *    状态句却报全局默认(B2-2)。这里对每个键分别走 fillProjectDefaults,团队与 Agent 各自判断。
 */
import { fillProjectDefaults } from '../stores/projectSettings'
import type { AgentConfig } from '../types'

export type DraftDispatch = { kind: 'team'; count: number } | { kind: 'agent'; slug: string | null }

/** @param picks 新对话草稿里用户点过的配置;@param projectConfig 项目默认项展开后的配置(无项目 = {})。 */
export function draftDispatch(picks: AgentConfig, projectConfig: Partial<AgentConfig>, defaultAgentSlug: string | null | undefined): DraftDispatch {
  const eff = fillProjectDefaults(picks, projectConfig)
  const members = eff.groupAgents ?? []
  if (eff.groupChat && members.length >= 2) return { kind: 'team', count: members.length }
  return { kind: 'agent', slug: eff.agentSlug || defaultAgentSlug || null }
}
