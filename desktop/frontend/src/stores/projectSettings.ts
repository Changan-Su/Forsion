import type { AgentConfig, ProjectSettings, TeamDef, WorkspaceDescriptor } from '../types'

export type ProjectWorkspace = WorkspaceDescriptor & { kind: 'local'; path: string }

/** 本地目录才算「Project」:用户添加的目录 + Tangu 默认工作区(09-23 用户:「默认文件夹也是 Project」)。
 *  Vault(笔记库)、通道文件夹、云端 Project 与无根会话都不是 —— 与侧栏分组同一口径。 */
export function isProjectWorkspace(ws: WorkspaceDescriptor | undefined | null): ws is ProjectWorkspace {
  return !!ws && ws.kind === 'local' && !!ws.path && (!ws.system || !!ws.isDefault)
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

/** Ultra 的**完整**资格结算:只跟 max 同在,且只在拿得到 delegate 的会话里作数(本机 host、非 chat、非外部引擎、非团队模式);
 *  否则去掉这个键。建会话、空态显示、发 run 三处共用 —— 药丸显示什么,首条消息就按什么跑(creview 09-27:草稿里选了 Ultra
 *  再换云端工作区 / 外部引擎 / 团队,或选了自带 high 的 Agent,此前显示与实际会分叉)。 */
export function settleUltra<T extends AgentConfig>(cfg: T): T {
  if (!('ultra' in cfg)) return cfg
  if (cfg.ultra && cfg.thinkingLevel === 'max' && cfg.execMode === 'host' && cfg.preset !== 'chat' && !cfg.engineId && !cfg.groupChat) return cfg
  const { ultra: _drop, ...rest } = cfg
  return rest as T
}

/** 团队模式(与引擎 services/sessionSettings.settleTeamPlanMode 同一口径):groupChat 为真;团队轨道会话没有显式切回普通也算。 */
export const teamModeOn = (cfg: AgentConfig | null | undefined): boolean => !!cfg && (!!cfg.groupChat || (!!cfg.teamSlug && cfg.groupChat !== false))

/** 团队模式下没有计划模式(10-05 用户定):成员各跑各的,不吃会话上的计划模式 —— 开着也不作数。结算放在配置上、不放在各个入口:
 *  开团队的那一笔顺手关掉计划模式,团队会话里开计划模式的那一笔不作数。没动时原样返回同一个对象。 */
export function settlePlanMode<T extends AgentConfig>(cfg: T): T {
  return cfg.planMode && teamModeOn(cfg) ? { ...cfg, planMode: false } : cfg
}

/** 模式之间的互斥一次结清(Ultra 的资格 + 团队模式下没有计划模式):建会话、空态显示、发 run 共用。 */
export const settleModes = <T extends AgentConfig>(cfg: T): T => settlePlanMode(settleUltra(cfg))

/** 新会话初始配置的三层次序:**显式选择(picks,新对话草稿里用户点过的)> 项目默认 > 上次用的档位(sticky)**。
 *  sticky 在 host 会话里恒带 approvalMode,所以不能把它当底再「只补缺席键」—— 那样项目的审批档永远轮不到(codex 评审抓的)。 */
export function newSessionConfig(sticky: Partial<AgentConfig>, project: Partial<AgentConfig>, picks: AgentConfig = {}): AgentConfig {
  const out = fillProjectDefaults(picks, { ...sticky, ...project })
  // Ultra 只跟 max 同在:项目默认或草稿显式改过档,sticky 里上次的 Ultra 就不作数(引擎那边 ultra 会压过 thinkingLevel)。
  // 草稿里关掉的 Ultra 记的是 false(挡住 sticky 回填),落库前去掉。
  if (!out.ultra || out.thinkingLevel !== 'max') delete out.ultra
  return out
}
