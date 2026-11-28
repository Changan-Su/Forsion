/**
 * Chat 头像资料卡(方案 docs/ToBeImproved/聊天头像资料卡方案_2026-11-27,11-27 用户选 B)的纯逻辑:
 * 发言人是谁、卡上每一行写什么、在忙几个会话、画像第一句。卡本身只是 Agent 资料 / 账号面板的摘要 + 入口,
 * 这里的每一行都从现成字段派生,不另存东西。组件在 ProfileCard.tsx。
 */
import type { AgentConfig, NormalAgentDef, SessionRecord, ThinkingLevel } from '../../types'
import { agentNames } from '../../agentName'
import { agentDescription } from '../../components/builtinAgentDescriptions'
import { thinkingLabel } from '../../components/thinkingLabel'
import { agentEngineLabel } from '../../tangu/agentEngine'
import { AGENT_SYNC_SEALED } from '../../../../../tangu-agent/src/contracts/agentSyncSeal'
import { splitPortrait } from '../../../../../tangu-agent/src/contracts/memoryLayers'
import { stripMarks } from '../../../../../tangu-agent/src/contracts/entryMark'

/** 点开的是谁。agent 的 slug 在名册里找不到 = 消息之后被删了(卡上写「已删除」)。 */
export type ProfileSubject =
  | { kind: 'agent'; slug: string }
  /** 群聊临时成员:只活在这个会话的配置里,没有资料页、没有私聊。 */
  | { kind: 'temp'; def: NormalAgentDef }
  /** 外部引擎会话(Claude Code 等)的发言人。 */
  | { kind: 'engine'; id: string; name: string }
  /** 只有名字、认不出是谁(群聊主持人、改过名又没 agentId 的老消息)。 */
  | { kind: 'unknown'; name: string }
  | { kind: 'user' }

export interface SpeakerCtx {
  agentDefs: readonly NormalAgentDef[]
  groupTempAgents?: readonly NormalAgentDef[]
  /** 这个会话跑在外部引擎上(engineId / soloEngineId)。 */
  engineId?: string
  engineName?: string
  /** 会话的 Agent(没盖发言人的历史助手消息算它的)。 */
  chatAgentSlug?: string
}

/** 助手消息的发言人:口径同 ChatView 给头像取图那段(agentId 优先、按名反查、名字认不出不回退会话 Agent)。 */
export function speakerOf(msg: { agentId?: string; agentName?: string }, ctx: SpeakerCtx): ProfileSubject {
  const byName = (name: string) => ctx.agentDefs.find((a) => agentNames(a).includes(name))?.slug
  const temps = ctx.groupTempAgents || []
  // 外部引擎会话:实时消息只盖引擎名(agentStamp 不写 agentId),要抢在按名查名册之前认出来,免得撞上同名本地 Agent
  if (ctx.engineId && !msg.agentId) return { kind: 'engine', id: ctx.engineId, name: ctx.engineName || msg.agentName || ctx.engineId }
  const aid = msg.agentId || (msg.agentName ? byName(msg.agentName) : undefined)
  if (aid) {
    if (ctx.agentDefs.some((a) => a.slug === aid)) return { kind: 'agent', slug: aid }
    const temp = temps.find((a) => a.slug === aid)
    if (temp) return { kind: 'temp', def: temp }
    if (aid.startsWith('__')) return { kind: 'unknown', name: msg.agentName || aid } // __host__ 这类内部发言人
    return { kind: 'agent', slug: aid } // 名册里没有了:删掉的 Agent
  }
  if (msg.agentName) {
    const temp = temps.find((a) => agentNames(a).includes(msg.agentName!) || a.name === msg.agentName)
    return temp ? { kind: 'temp', def: temp } : { kind: 'unknown', name: msg.agentName }
  }
  if (ctx.engineId) return { kind: 'engine', id: ctx.engineId, name: ctx.engineName || ctx.engineId }
  if (ctx.chatAgentSlug) return { kind: 'agent', slug: ctx.chatAgentSlug }
  return { kind: 'unknown', name: 'Tangu' }
}

/** 会话是哪个 Agent 在跑(私聊 / 单 Agent / 团队成员的工作会话)。 */
const sessionAgent = (cfg: AgentConfig | null | undefined): string | undefined => cfg?.soloAgentSlug || cfg?.agentSlug

/** 它这会儿在几个会话里干活(runningBySession × 各会话的 Agent)。群聊主会话里谁在说话分不出来,不算。 */
export function busyCount(slug: string, sessions: readonly Pick<SessionRecord, 'id' | 'agent_config'>[], runningBySession: Readonly<Record<string, string>>): number {
  let n = 0
  for (const s of sessions) {
    if (!runningBySession[s.id]) continue
    const cfg = s.agent_config
    if (cfg?.groupChat || cfg?.teamSlug) continue
    if (sessionAgent(cfg) === slug) n++
  }
  return n
}

export type RowKey = 'about' | 'model' | 'skills' | 'memory' | 'source'
export interface CardRow { key: RowKey; value: string }

export interface RowCtx {
  defaultSlug?: string | null
  modelName: (id: string) => string | undefined
  skillName: (id: string) => string | undefined
  /** 记忆条数:undefined = 还在取,null = 取不到(只写「专属」,不写 0)。 */
  memory: number | null | undefined
  /** 分身的本体叫什么(standInOf 指的那个)。 */
  ownerName?: string
}

/** 卡上的五行。没有内容的行不出(没写简介就不画「简介」)。 */
export function agentRows(def: NormalAgentDef, ctx: RowCtx, t: (key: string, vars?: Record<string, string | number>) => string): CardRow[] {
  const rows: CardRow[] = []
  const about = agentDescription({ slug: def.slug, description: def.description || '' }, t).trim()
  if (about) rows.push({ key: 'about', value: about })

  const level = def.thinkingLevel ? thinkingLabel(def.thinkingLevel as ThinkingLevel, t) : ''
  const withLevel = (head: string) => (level ? `${head} · ${t('pc.model.thinking', { level })}` : head)
  if (def.engine) rows.push({ key: 'model', value: t('pc.model.engine', { engine: agentEngineLabel(def.engine) }) + (def.engineModel ? ` · ${def.engineModel}` : '') })
  else if (def.model) rows.push({ key: 'model', value: withLevel(ctx.modelName(def.model) || def.model) })
  else rows.push({ key: 'model', value: withLevel(t('pc.model.follow')) })

  if (Array.isArray(def.enabledSkillIds)) {
    const ids = def.enabledSkillIds
    if (!ids.length) rows.push({ key: 'skills', value: t('pc.skills.none') })
    else {
      const names = ids.slice(0, 2).map((id) => ctx.skillName(id) || id.replace(/^[a-z]+:/, ''))
      rows.push({ key: 'skills', value: ids.length > 2 ? t('pc.skills.more', { names: names.join(t('pc.listSep')), n: ids.length }) : names.join(t('pc.listSep')) })
    }
  } else rows.push({ key: 'skills', value: t('pc.skills.default') })

  const shared = !!def.shareDefaultMemory && def.slug !== ctx.defaultSlug
  rows.push({ key: 'memory', value: shared ? t('pc.memory.shared') : typeof ctx.memory === 'number' ? t('pc.memory.own', { n: ctx.memory }) : t('pc.memory.ownPlain') })

  const source = [t(def.libraryDir ? 'pc.source.local' : 'pc.source.cloud')]
  if (def.cloudSync && !AGENT_SYNC_SEALED) source.push(t('pc.source.sync')) // Agents 同步先封住时不说「云同步开」
  if (def.standInOf) source.push(t('pc.source.standIn', { name: ctx.ownerName || def.standInOf }))
  if (def.createdBy === 'agent') source.push(t('pc.source.byAgent'))
  rows.push({ key: 'source', value: source.join(' · ') })
  return rows
}

/** 头部的小签:默认 / 后台 / 分身 / 已停用(只出一枚,按这个顺序取)。 */
export function agentChip(def: NormalAgentDef, defaultSlug?: string | null): 'default' | 'system' | 'standIn' | 'disabled' | null {
  if (def.disabled) return 'disabled'
  if (def.slug === defaultSlug) return 'default'
  if (def.createdBy === 'system') return 'system'
  if (def.standInOf) return 'standIn'
  return null
}

/** 停用开关给不给:默认 Agent、后台 Agent(Muse)引擎同样拒,卡上就不出。 */
export const canToggleDisabled = (def: NormalAgentDef, defaultSlug?: string | null): boolean => def.slug !== defaultSlug && def.createdBy !== 'system'

/** 画像(SOUL.md)的第一句:只看常驻那段,去掉条目记号、标题、列表符号。没有就空串。 */
export function portraitLine(content: string): string {
  let text = content
  try { text = splitPortrait(content).resident } catch { /* 老格式:整份当常驻 */ }
  const lines = stripMarks(text).split('\n')
  let inFront = lines[0]?.trim() === '---'
  for (let i = inFront ? 1 : 0; i < lines.length; i++) {
    const line = lines[i].trim()
    if (inFront) { if (line === '---') inFront = false; continue }
    if (!line || line.startsWith('#') || line.startsWith('<!--') || line.startsWith('>')) continue
    const fact = line.replace(/^(?:[-*+]|\d+[.)])\s+/, '').replace(/\*\*/g, '').trim()
    if (fact) return fact
  }
  return ''
}
