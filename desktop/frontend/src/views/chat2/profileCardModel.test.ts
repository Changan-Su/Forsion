import { describe, expect, it } from 'vitest'
import type { NormalAgentDef, SessionRecord } from '../../types'
import { agentChip, agentRows, busyCount, canToggleDisabled, portraitLine, speakerOf } from './profileCardModel'

const def = (slug: string, extra: Partial<NormalAgentDef> = {}): NormalAgentDef => ({
  slug, name: slug[0].toUpperCase() + slug.slice(1), description: '', model: '', tools: [], thinkingLevel: '', maxIterations: null,
  approvalMode: '', createdBy: 'user', createdAt: '', systemPrompt: '', libraryDir: `/lib/${slug}`, ...extra,
})
// 假 t:键 + 变量原样拼出来,断言看得到用了哪条文案、带了什么
const t = (key: string, vars?: Record<string, string | number>): string => (vars ? `${key}(${Object.entries(vars).map(([k, v]) => `${k}=${v}`).join(',')})` : key)

describe('speakerOf', () => {
  const defs = [def('xyra'), def('research', { nameZh: '研究员' })]
  const temp = def('scout', { name: 'Scout' })
  it('agentId 优先;名册里有就是它', () => {
    expect(speakerOf({ agentId: 'research' }, { agentDefs: defs })).toEqual({ kind: 'agent', slug: 'research' })
  })
  it('没 agentId 按名字反查(中英名都认)', () => {
    expect(speakerOf({ agentName: '研究员' }, { agentDefs: defs })).toEqual({ kind: 'agent', slug: 'research' })
  })
  it('群聊临时成员', () => {
    expect(speakerOf({ agentId: 'scout' }, { agentDefs: defs, groupTempAgents: [temp] })).toEqual({ kind: 'temp', def: temp })
    expect(speakerOf({ agentName: 'Scout' }, { agentDefs: defs, groupTempAgents: [temp] })).toEqual({ kind: 'temp', def: temp })
  })
  it('名册里没有了 = 删掉的 Agent;内部发言人只给名字', () => {
    expect(speakerOf({ agentId: 'gone' }, { agentDefs: defs })).toEqual({ kind: 'agent', slug: 'gone' })
    expect(speakerOf({ agentId: '__host__', agentName: 'Host' }, { agentDefs: defs })).toEqual({ kind: 'unknown', name: 'Host' })
  })
  it('名字认不出不回退会话 Agent(同头像取图的口径)', () => {
    expect(speakerOf({ agentName: 'Nobody' }, { agentDefs: defs, chatAgentSlug: 'xyra' })).toEqual({ kind: 'unknown', name: 'Nobody' })
  })
  it('外部引擎会话的实时消息只盖了引擎名:认成引擎,不撞同名本地 Agent', () => {
    const withSame = [...defs, def('claude', { name: 'Claude Code' })]
    expect(speakerOf({ agentName: 'Claude Code' }, { agentDefs: withSame, engineId: 'claude-code', engineName: 'Claude Code' })).toEqual({ kind: 'engine', id: 'claude-code', name: 'Claude Code' })
  })
  it('没盖发言人:外部引擎会话 → 引擎;否则 → 会话 Agent', () => {
    expect(speakerOf({}, { agentDefs: defs, engineId: 'claude-code', engineName: 'Claude Code', chatAgentSlug: 'xyra' })).toEqual({ kind: 'engine', id: 'claude-code', name: 'Claude Code' })
    expect(speakerOf({}, { agentDefs: defs, chatAgentSlug: 'xyra' })).toEqual({ kind: 'agent', slug: 'xyra' })
  })
})

describe('busyCount', () => {
  const ses = (id: string, cfg: Partial<NonNullable<SessionRecord['agent_config']>> | null) => ({ id, agent_config: cfg as SessionRecord['agent_config'] })
  it('只数在跑、而且是它在跑的会话(私聊 / 单 Agent / 成员工作会话);群聊主会话分不出是谁,不算', () => {
    const sessions = [ses('a', { agentSlug: 'xyra' }), ses('b', { soloAgentSlug: 'xyra' }), ses('c', { agentSlug: 'xyra' }), ses('d', { agentSlug: 'xyra', groupChat: true }), ses('e', { agentSlug: 'research' }), ses('f', null)]
    expect(busyCount('xyra', sessions, { a: 'r1', b: 'r2', d: 'r3', e: 'r4', f: 'r5' })).toBe(2)
    expect(busyCount('xyra', sessions, {})).toBe(0)
  })
})

describe('agentRows', () => {
  const base = { defaultSlug: 'xyra', memory: 23 as number | null | undefined, modelName: (id: string) => (id === 'm1' ? 'GPT-6 Luna' : undefined), skillName: (id: string) => ({ 'local:writing': 'Writing', 'local:web': 'Web research' }[id]) }
  const rows = (d: NormalAgentDef, ctx: Partial<typeof base> & { ownerName?: string } = {}) => Object.fromEntries(agentRows(d, { ...base, ...ctx }, t).map((r) => [r.key, r.value]))
  it('五行:简介 / 模型 · 思考档 / 前两个技能 + 共几个 / 专属几条 / 来源', () => {
    const r = rows(def('xyra', { description: 'Everyday assistant', model: 'm1', thinkingLevel: 'medium', enabledSkillIds: ['local:writing', 'local:web', 'local:pdf'], cloudSync: true }))
    expect(r.about).toBe('Everyday assistant')
    expect(r.model).toBe('GPT-6 Luna · pc.model.thinking(level=input.thinkingShort.medium)')
    expect(r.skills).toBe('pc.skills.more(names=Writing' + 'pc.listSep' + 'Web research,n=3)')
    expect(r.memory).toBe('pc.memory.own(n=23)')
    expect(r.source).toBe('pc.source.local') // Agents 同步先封住(2026-11-27):存着开了也不说「云同步开」
  })
  it('没写简介不出那一行;没设模型 = 跟随会话;技能没限定 = 跟随默认', () => {
    const r = rows(def('research'))
    expect(r.about).toBeUndefined()
    expect(r.model).toBe('pc.model.follow')
    expect(r.skills).toBe('pc.skills.default')
  })
  it('外部引擎写由谁跑;模型 id 认不出照写原 id', () => {
    expect(rows(def('d', { engine: 'dsh', engineModel: 'deepseek-v4' })).model).toMatch(/^pc\.model\.engine\(engine=.+\) · deepseek-v4$/)
    expect(rows(def('d', { model: 'unknown-model' })).model).toBe('unknown-model')
  })
  it('记忆:读失败 / 还没取到只写「专属」,不写 0;共用默认 Agent 的不数', () => {
    expect(rows(def('r'), { memory: null }).memory).toBe('pc.memory.ownPlain')
    expect(rows(def('r'), { memory: undefined }).memory).toBe('pc.memory.ownPlain')
    expect(rows(def('r', { shareDefaultMemory: true })).memory).toBe('pc.memory.shared')
    expect(rows(def('xyra', { shareDefaultMemory: true })).memory).toBe('pc.memory.own(n=23)') // 默认 Agent 自己就是那份
  })
  it('来源:云端 / 分身 / Agent 创建', () => {
    expect(rows(def('c', { libraryDir: undefined })).source).toBe('pc.source.cloud')
    expect(rows(def('s', { standInOf: 'xyra' }), { ownerName: 'Xyra' }).source).toBe('pc.source.local · pc.source.standIn(name=Xyra)')
    expect(rows(def('a', { createdBy: 'agent' })).source).toBe('pc.source.local · pc.source.byAgent')
  })
  it('技能空名单 = 没开', () => {
    expect(rows(def('r', { enabledSkillIds: [] })).skills).toBe('pc.skills.none')
  })
})

describe('agentChip / canToggleDisabled', () => {
  it('只出一枚:已停用 > 默认 > 后台 > 分身', () => {
    expect(agentChip(def('xyra'), 'xyra')).toBe('default')
    expect(agentChip(def('xyra', { disabled: true }), 'xyra')).toBe('disabled')
    expect(agentChip(def('muse', { createdBy: 'system' }), 'xyra')).toBe('system')
    expect(agentChip(def('s', { standInOf: 'xyra' }), 'xyra')).toBe('standIn')
    expect(agentChip(def('r'), 'xyra')).toBeNull()
  })
  it('默认 Agent 和后台 Agent 不给停用', () => {
    expect(canToggleDisabled(def('xyra'), 'xyra')).toBe(false)
    expect(canToggleDisabled(def('muse', { createdBy: 'system' }), 'xyra')).toBe(false)
    expect(canToggleDisabled(def('research'), 'xyra')).toBe(true)
  })
})

describe('portraitLine', () => {
  it('跳过 frontmatter、标题、空行,去掉列表符号和加粗', () => {
    expect(portraitLine('---\ntitle: x\n---\n# 关于你\n\n- **做产品的独立开发者**,先看方案图再动手\n- 第二条')).toBe('做产品的独立开发者,先看方案图再动手')
  })
  it('空的 / 只有标题 → 空串', () => {
    expect(portraitLine('')).toBe('')
    expect(portraitLine('# 关于你\n\n')).toBe('')
  })
})
