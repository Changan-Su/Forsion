import type { AgentConfig, SessionRecord } from '../types'

export type ProjectExecutorKind = 'agent' | 'team' | 'party' | 'engine'
export interface ProjectExecutor {
  /** agent:<slug> | team:<slug> | party:<sessionId> | engine:<id> */
  key: string
  kind: ProjectExecutorKind
  /** Agent slug / 团队 slug / 临时配队的会话 id / 外部引擎 id。 */
  id: string
  /** 用它的会话,新的在前。 */
  sessions: SessionRecord[]
  running: boolean
  /** 当前聚焦的会话就是它的。 */
  current: boolean
  lastActive: number
}

/** 一条会话的执行者身份:团队实体 > 会话级配队 > 外部引擎 > Agent(存值缺席回落全局默认,与 TanguDetailsView 同规则)。 */
export function executorOf(session: SessionRecord, config: AgentConfig | null | undefined, defaultSlug: string): Pick<ProjectExecutor, 'kind' | 'id' | 'key'> {
  const cfg = config || session.agent_config || {}
  if (cfg.teamSlug) return { kind: 'team', id: cfg.teamSlug, key: `team:${cfg.teamSlug}` }
  if (cfg.groupChat) return { kind: 'party', id: session.id, key: `party:${session.id}` }
  const engine = cfg.engineId || cfg.soloEngineId
  if (engine) return { kind: 'engine', id: engine, key: `engine:${engine}` }
  const slug = cfg.agentSlug || cfg.soloAgentSlug || defaultSlug
  return { kind: 'agent', id: slug, key: `agent:${slug}` }
}

/** 在这个项目(project_path)里工作过的执行者,按会话推导(含归档):当前会话的置顶,其余按最近活动降序。
 *  这不是显式名单 —— 它回答「谁在这里干过活」;固定名册等真有「无会话也要显示」的需求再落盘。 */
export function projectExecutors(input: {
  sessions: SessionRecord[]
  projectPath: string
  /** 同组的别名路径(默认工作区换过目录时,旧 project_path 仍归这一组;见 WorkspaceDescriptor.sessionKeys)。 */
  aliases?: string[]
  configBySession: Record<string, AgentConfig>
  runningBySession: Record<string, string>
  defaultSlug: string
  currentSessionId?: string | null
}): ProjectExecutor[] {
  const byKey = new Map<string, ProjectExecutor>()
  const paths = new Set([input.projectPath, ...(input.aliases || [])])
  for (const s of input.sessions) {
    if (s.projectless || !s.project_path || !paths.has(s.project_path)) continue
    const { kind, id, key } = executorOf(s, input.configBySession[s.id], input.defaultSlug)
    const at = Date.parse(s.updated_at) || 0
    const ex = byKey.get(key) || { key, kind, id, sessions: [], running: false, current: false, lastActive: 0 }
    ex.sessions.push(s)
    ex.running ||= !!input.runningBySession[s.id]
    ex.current ||= s.id === input.currentSessionId
    ex.lastActive = Math.max(ex.lastActive, at)
    byKey.set(key, ex)
  }
  const out = [...byKey.values()]
  for (const ex of out) ex.sessions.sort((a, b) => (Date.parse(b.updated_at) || 0) - (Date.parse(a.updated_at) || 0))
  return out.sort((a, b) => Number(b.current) - Number(a.current) || b.lastActive - a.lastActive)
}

/** 家目录缩成 ~,给头部路径行用(完整路径留在 title 里)。 */
export function shortenPath(p: string, homeDir?: string | null): string {
  const norm = p.replace(/\\/g, '/')
  const home = homeDir ? homeDir.replace(/\\/g, '/').replace(/\/$/, '') : ''
  return home && (norm === home || norm.startsWith(`${home}/`)) ? `~${norm.slice(home.length)}` : norm
}

/** 「3 天前」:语言跟随界面,不自己拼文案(Intl 不认的运行时退回日期)。 */
export function relativeTimeOf(at: number, now: number, locale: string): string {
  const diff = Math.round((at - now) / 1000)
  const abs = Math.abs(diff)
  const [value, unit]: [number, Intl.RelativeTimeFormatUnit] = abs < 60 ? [diff, 'second']
    : abs < 3600 ? [Math.round(diff / 60), 'minute']
    : abs < 86400 ? [Math.round(diff / 3600), 'hour']
    : abs < 86400 * 30 ? [Math.round(diff / 86400), 'day']
    : abs < 86400 * 365 ? [Math.round(diff / (86400 * 30)), 'month']
    : [Math.round(diff / (86400 * 365)), 'year']
  try { return new Intl.RelativeTimeFormat(locale, { numeric: 'auto' }).format(value, unit) } catch { return new Date(at).toLocaleDateString() }
}
