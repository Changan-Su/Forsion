/**
 * agentStatusOf 的推导表(2026-09-19)。纯函数,每行 = 一个 store 形状 → 期望的状态。
 * 关键不变式:
 *  ① waiting > tool > thinking(确切信号)> speaking > thinking(兜底);
 *  ② waiting 只在**在跑且本 run 窗口内**找 pending —— 上个 run 残留的 pending 不许把状态钉死;
 *  ③ done / error 只认 runStats.finishedAt + 余韵,重载后的历史 error 气泡不复活;
 *  ④ 草稿(null)/ 没有活动会话恒 idle(sessionId null);
 *  ⑤ 每条状态都报「这个会话归哪个 Agent」(2026-09-20 加,给「每个 Agent 一个形象」的插件挑形象用)。
 * 负对照(已实跑红):waiting 扫描去掉 `inRunWindow` 条件 → 「上个 run 残留的 pending」红;
 * 非运行分支去掉 `!rs || fin == null` 闸(只看 last.status)→ 「重载的历史 error」红;
 * tool 阶段退回从 work.activity 猜工具名 → 「团队成员占位只有任务」两行红;
 * 去掉「刚落定气泡续 speaking」那条 return → 「气泡已 done / error、running 还没清」两行红;
 * agentOf 去掉 engineId 那道闸 → 「外部引擎会话」红;agentName 回落成 slug → 「名册里查不到」红;
 * statusKey 加进 agentName → 「只改展示名不进键」红;statusKey 去掉 agentSlug → 「换 Agent 进键」红。
 */
import { describe, expect, it } from 'vitest'
import { agentStatusOf, statusKey, DONE_HOLD_MS, ERROR_HOLD_MS, type AgentStatusSlice } from './agentStatus'
import type { NormalAgentDef, UiMessage } from '../types'
import type { RunStats } from './runStats'

const T0 = 1_000_000
const NOW = T0 + 10_000

const user = (over: Partial<UiMessage> = {}): UiMessage => ({ id: 'u1', role: 'user', content: 'hi', status: 'done', timestamp: T0, ...over })
const asst = (over: Partial<UiMessage> = {}): UiMessage => ({ id: 'a1', role: 'assistant', content: '', status: 'streaming', timestamp: T0 + 1, ...over })
const rs = (over: Partial<RunStats> = {}): RunStats => ({ runId: 'r1', startedAt: T0, tokens: 0, thinkMs: 0, thinkTracked: true, ...over })
const adef = (slug: string, name: string, over: Partial<NormalAgentDef> = {}): NormalAgentDef =>
  ({ slug, name, description: '', model: '', tools: [], thinkingLevel: '', maxIterations: null, approvalMode: '', createdBy: 'user', createdAt: '', systemPrompt: '', ...over })

// Agent 那几个字段的缺省一律留空(名册空 / 没默认 Agent)=「推不出来」→ 状态里整个不出现,
// 于是既有断言(尤其草稿那条 toEqual 精确形状)照旧成立,归属的行为单独在下面那个 describe 里钉。
function slice(over: Partial<AgentStatusSlice> & { msgs?: UiMessage[]; running?: boolean; stats?: RunStats } = {}): AgentStatusSlice {
  const { msgs, running = true, stats = rs(), ...rest } = over
  return {
    activeId: 's1',
    messagesBySession: { s1: msgs ?? [user(), asst()] },
    runningBySession: running ? { s1: 'r1' } : {},
    stoppingBySession: {},
    runStatsBySession: { s1: stats },
    llmRetryBySession: {},
    groupVoting: {},
    configBySession: {},
    defaultAgentSlug: '',
    agentDefs: [],
    newChatCfg: {},
    ...rest,
  }
}

describe('agentStatusOf:在跑时的各阶段', () => {
  const rows: Array<[string, AgentStatusSlice, Partial<ReturnType<typeof agentStatusOf>>]> = [
    ['刚起 run、还没任何输出 → thinking(since = run 起点)', slice(), { phase: 'thinking', since: T0, runId: 'r1' }],
    ['推理流中(thinkSince)→ thinking', slice({ stats: rs({ thinkSince: T0 + 500 }) }), { phase: 'thinking', since: T0 + 500 }],
    ['等首帧(live)→ thinking', slice({ msgs: [user(), asst({ live: { phase: 'accepted', since: T0 + 700 } })] }), { phase: 'thinking', since: T0 + 700 }],
    ['LLM 重试中 → thinking', slice({ llmRetryBySession: { s1: { attempt: 1, max: 3, waitMs: 1000 } } }), { phase: 'thinking' }],
    ['群聊投票中 → thinking', slice({ groupVoting: { s1: true } }), { phase: 'thinking' }],
    ['顺序段末尾是正文 → speaking', slice({ msgs: [user(), asst({ content: 'Hello', segments: [{ t: 'text', text: 'Hello' }] })] }), { phase: 'speaking' }],
    ['老形状(无 segments)有正文 → speaking', slice({ msgs: [user(), asst({ content: 'Hello' })] }), { phase: 'speaking' }],
    ['正文之后又开始推理 → thinking 压过 speaking', slice({ stats: rs({ thinkSince: T0 + 900 }), msgs: [user(), asst({ content: 'Hi', segments: [{ t: 'text', text: 'Hi' }] })] }), { phase: 'thinking' }],
    ['新一轮 llm_call(live)压过上一轮留下的正文段', slice({ msgs: [user(), asst({ content: 'Hi', segments: [{ t: 'text', text: 'Hi' }], live: { phase: 'sending', since: T0 + 800 } })] }), { phase: 'thinking', since: T0 + 800 }],
    ['工具执行中(有 startedAt)→ tool/exec', slice({ msgs: [user(), asst({ toolEvents: [{ id: 't1', name: 'read_file', done: false, startedAt: T0 + 300 }], segments: [{ t: 'tools', ids: ['t1'] }] })] }), { phase: 'tool', tool: 'read_file', toolStage: 'exec', since: T0 + 300 }],
    ['模型还在写参数(无 startedAt)→ tool/args', slice({ msgs: [user(), asst({ toolEvents: [{ id: 't1', name: 'write_file', done: false }] })] }), { phase: 'tool', tool: 'write_file', toolStage: 'args' }],
    ['工具都已完成、正文段在末尾 → speaking', slice({ msgs: [user(), asst({ content: 'ok', toolEvents: [{ id: 't1', name: 'x', done: true, startedAt: T0 }], segments: [{ t: 'tools', ids: ['t1'] }, { t: 'text', text: 'ok' }] })] }), { phase: 'speaking' }],
    ['工具结果回来、等下一轮 → 兜底 thinking', slice({ msgs: [user(), asst({ toolEvents: [{ id: 't1', name: 'x', done: true, startedAt: T0 }], segments: [{ t: 'tools', ids: ['t1'] }] })] }), { phase: 'thinking', since: T0 }],
    ['团队成员的工具(team_activity 写的 work.tool)→ tool', slice({ msgs: [user(), asst({ work: { tool: 'web_search', activity: 'web_search forsion' } })] }), { phase: 'tool', tool: 'web_search', toolStage: 'exec' }],
    ['团队成员占位只有任务(英文)→ thinking,不把任务首词当工具', slice({ msgs: [user(), asst({ work: { activity: 'Implement the parser and add tests' } })] }), { phase: 'thinking' }],
    ['团队成员占位只有任务(中文无空格)→ thinking,不把整句当工具', slice({ msgs: [user(), asst({ work: { activity: '调研竞品并写一份对比报告' } })] }), { phase: 'thinking' }],
    ['待审批压过同一刻「未完成」的工具 → waiting/approval', slice({ msgs: [user(), asst({ toolEvents: [{ id: 't1', name: 'run_bash', done: false, startedAt: T0 + 1 }], approvals: [{ approvalId: 'p1', runId: 'r1', name: 'run_bash', preview: '', status: 'pending' }] })] }), { phase: 'waiting', waitingFor: 'approval', tool: 'run_bash' }],
    ['ask_user → waiting/inquiry', slice({ msgs: [user(), asst({ inquiries: [{ inquiryId: 'q1', runId: 'r1', question: '?', options: [], status: 'pending' }] })] }), { phase: 'waiting', waitingFor: 'inquiry', tool: 'ask_user' }],
    ['计划审阅 → waiting/inquiry(exit_plan_mode)', slice({ msgs: [user(), asst({ inquiries: [{ inquiryId: 'q1', runId: 'r1', question: 'plan', options: [], status: 'pending', kind: 'plan' }] })] }), { phase: 'waiting', waitingFor: 'inquiry', tool: 'exit_plan_mode' }],
    ['团队成员占位在等(work.waiting)→ waiting', slice({ msgs: [user(), asst({ work: { waiting: true } })] }), { phase: 'waiting' }],
    ['用户已叫停(stopping)→ idle', slice({ stoppingBySession: { s1: 'r1' }, msgs: [user(), asst({ content: 'x' })] }), { phase: 'idle', runId: 'r1' }],
    // done / error 的 reducer 先把气泡标 done/error、后 endRun 清 running:两次 set 之间不许掉进兜底 thinking。
    ['气泡已 done、running 还没清 → 续 speaking(字符数照报)', slice({ msgs: [user(), asst({ id: 'a7', status: 'done', content: 'Hello', segments: [{ t: 'text', text: 'Hello' }] })] }), { phase: 'speaking', messageId: 'a7', textChars: 5 }],
    ['气泡已 error、running 还没清 → 续 speaking', slice({ msgs: [user(), asst({ status: 'error', error: 'boom', content: 'Hel' })] }), { phase: 'speaking', textChars: 3 }],
    ['已落定但以工具收尾 → 兜底 thinking(与收尾前同键,不回调)', slice({ msgs: [user(), asst({ status: 'done', toolEvents: [{ id: 't1', name: 'x', done: true, startedAt: T0 }], segments: [{ t: 'tools', ids: ['t1'] }] })] }), { phase: 'thinking' }],
    ['最后一条是用户消息(插话)→ 不认前面落定的气泡', slice({ msgs: [user(), asst({ status: 'done', content: 'ok' }), user({ id: 'u2', timestamp: T0 + 2 })] }), { phase: 'thinking' }],
  ]
  it.each(rows)('%s', (_name, s, want) => {
    expect(agentStatusOf(s, 's1', NOW)).toMatchObject(want)
  })

  it('上个 run 残留的 pending 审批不把新 run 钉在 waiting(出了本 run 窗口就不算)', () => {
    const stale = asst({ id: 'old', status: 'done', timestamp: T0 - 60_000, approvals: [{ approvalId: 'p0', runId: 'r0', name: 'run_bash', preview: '', status: 'pending' }] })
    const s = slice({ msgs: [user({ id: 'u0', timestamp: T0 - 61_000 }), stale, user(), asst({ content: 'Hi', segments: [{ t: 'text', text: 'Hi' }] })] })
    expect(agentStatusOf(s, 's1', NOW).phase).toBe('speaking')
  })

  it('字符数 / messageId 取当前流式气泡(口型包络按帧拉它)', () => {
    const s = slice({ msgs: [user(), asst({ id: 'a9', content: 'Hello', reasoning: 'hmm', segments: [{ t: 'text', text: 'Hello' }] })] })
    expect(agentStatusOf(s, 's1', NOW)).toMatchObject({ messageId: 'a9', textChars: 5, reasoningChars: 3 })
  })
})

describe('agentStatusOf:没在跑', () => {
  const done = (status: UiMessage['status'], fin: number | undefined, extra: UiMessage[] = []) =>
    slice({ running: false, stats: rs({ finishedAt: fin }), msgs: [user(), asst({ status, content: 'x' }), ...extra] })

  it('刚成功结束 → done,带 until;余韵到期 → idle', () => {
    const fin = NOW - 1000
    expect(agentStatusOf(done('done', fin), 's1', NOW)).toMatchObject({ phase: 'done', runId: 'r1', since: fin, until: fin + DONE_HOLD_MS })
    expect(agentStatusOf(done('done', fin), 's1', fin + DONE_HOLD_MS)).toMatchObject({ phase: 'idle', runId: null, since: fin + DONE_HOLD_MS })
    expect(agentStatusOf(done('done', fin), 's1', fin + DONE_HOLD_MS).until).toBeUndefined()
  })

  it('刚失败 → error(余韵比 done 长);到期 → idle', () => {
    const fin = NOW - DONE_HOLD_MS - 100 // done 的余韵早过了,error 的还没过
    expect(agentStatusOf(done('error', fin), 's1', NOW)).toMatchObject({ phase: 'error', until: fin + ERROR_HOLD_MS })
    expect(agentStatusOf(done('error', fin), 's1', fin + ERROR_HOLD_MS).phase).toBe('idle')
  })

  it('用户停止的 run → idle(不演 done)', () => {
    expect(agentStatusOf(done('stopped', NOW - 10), 's1', NOW).phase).toBe('idle')
  })

  it('末尾的 system 行(费用提示 / 已压缩)不挡 done', () => {
    const s = done('done', NOW - 10, [{ id: 'sys', role: 'system', content: 'cost', timestamp: NOW - 5 }])
    expect(agentStatusOf(s, 's1', NOW).phase).toBe('done')
  })

  it('重载的历史 error 气泡不复活(没有 runStats = 没有这一程的 run)', () => {
    const s = slice({ running: false, runStatsBySession: {}, msgs: [user(), asst({ status: 'error', error: 'boom' })] })
    expect(agentStatusOf(s, 's1', NOW)).toMatchObject({ phase: 'idle', since: 0 })
  })

  it('runStats 属于别的 run(气泡在它窗口之前)→ 不认领', () => {
    const s = slice({ running: false, stats: rs({ runId: 'r2', startedAt: T0 + 5000, finishedAt: NOW - 10 }), msgs: [user(), asst({ status: 'error' })] })
    expect(agentStatusOf(s, 's1', NOW).phase).toBe('idle')
  })
})

describe('agentStatusOf:会话口径', () => {
  it('草稿(显式 null)恒 idle,sessionId null —— 哪怕活动会话在跑', () => {
    expect(agentStatusOf(slice(), null, NOW)).toEqual({ phase: 'idle', sessionId: null, runId: null, since: 0, textChars: 0, reasoningChars: 0 })
  })
  it('省略 = 跟全局 activeId;activeId 为 null(新对话)→ idle', () => {
    expect(agentStatusOf(slice(), undefined, NOW)).toMatchObject({ phase: 'thinking', sessionId: 's1' })
    expect(agentStatusOf(slice({ activeId: null }), undefined, NOW)).toMatchObject({ phase: 'idle', sessionId: null })
  })
  it('没加载过的会话 → idle,sessionId 照报', () => {
    expect(agentStatusOf(slice(), 'other', NOW)).toMatchObject({ phase: 'idle', sessionId: 'other' })
  })
})

/** 会话归哪个 Agent(2026-09-20):Live3D 之类「每个 Agent 一个形象」的插件按它挑形象。 */
describe('agentStatusOf:会话归属的 Agent', () => {
  const defs = [adef('xyra', 'Xyra'), adef('muse', 'Muse', { createdBy: 'system' })]
  type SliceOver = Parameters<typeof slice>[0]
  const withRoster = (over: SliceOver = {}): AgentStatusSlice =>
    slice({ defaultAgentSlug: 'xyra', agentDefs: defs, ...over })

  it('会话显式选了 Agent → 报它 + 名册里的展示名', () => {
    const s = withRoster({ configBySession: { s1: { agentSlug: 'muse' } } })
    expect(agentStatusOf(s, 's1', NOW)).toMatchObject({ agentSlug: 'muse', agentName: 'Muse' })
  })

  it('会话没选 → 回落用户默认 Agent(与 agentStamp 同口径)', () => {
    expect(agentStatusOf(withRoster(), 's1', NOW)).toMatchObject({ agentSlug: 'xyra', agentName: 'Xyra' })
  })

  it('草稿(null)→ 新对话配置里选的那个;新对话也没选 → 默认', () => {
    const picked = withRoster({ newChatCfg: { agentSlug: 'muse' } })
    expect(agentStatusOf(picked, null, NOW)).toMatchObject({ phase: 'idle', sessionId: null, agentSlug: 'muse', agentName: 'Muse' })
    expect(agentStatusOf(withRoster(), null, NOW)).toMatchObject({ phase: 'idle', agentSlug: 'xyra' })
    // 省略 sessionId 且没有活动会话 = 同一个草稿(新对话的 Desk 卡片走这条)
    expect(agentStatusOf(withRoster({ activeId: null, newChatCfg: { agentSlug: 'muse' } }), undefined, NOW))
      .toMatchObject({ sessionId: null, agentSlug: 'muse' })
  })

  it('名册里查不到(还没拉回来 / 已删)→ 只给 slug,不拿 slug 冒充展示名', () => {
    const s = withRoster({ configBySession: { s1: { agentSlug: 'ghost' } } })
    const got = agentStatusOf(s, 's1', NOW)
    expect(got.agentSlug).toBe('ghost')
    expect('agentName' in got).toBe(false)
  })

  it('外部引擎会话 → 没有 Tangu agent,不报 agentSlug(同 agentStamp 的 engineId 优先)', () => {
    const s = withRoster({ configBySession: { s1: { engineId: 'claude-code', agentSlug: 'xyra' } } })
    const got = agentStatusOf(s, 's1', NOW)
    expect('agentSlug' in got).toBe(false)
    expect('agentName' in got).toBe(false)
    // 草稿侧同样对称:新对话选了外部引擎 → 不报
    expect('agentSlug' in agentStatusOf(withRoster({ newChatCfg: { engineId: 'claude-code' } }), null, NOW)).toBe(false)
  })

  it('团队会话 → 仍是会话配置的那个 Agent,不跟当前发言的成员', () => {
    const s = withRoster({ configBySession: { s1: { agentSlug: 'xyra', groupChat: true, groupAgents: ['xyra', 'muse'] } } })
    expect(agentStatusOf(s, 's1', NOW)).toMatchObject({ agentSlug: 'xyra' })
  })

  it('每条返回路径都带上,不只是 idle / thinking 那两条', () => {
    const cfg = { configBySession: { s1: { agentSlug: 'muse' } } }
    const rows: AgentStatusSlice[] = [
      withRoster(cfg), // ⑤ 兜底 thinking
      withRoster({ ...cfg, msgs: [user(), asst({ content: 'Hi', segments: [{ t: 'text', text: 'Hi' }] })] }), // speaking
      withRoster({ ...cfg, msgs: [user(), asst({ toolEvents: [{ id: 't1', name: 'x', done: false, startedAt: T0 }] })] }), // tool
      withRoster({ ...cfg, msgs: [user(), asst({ inquiries: [{ inquiryId: 'q1', runId: 'r1', question: '?', options: [], status: 'pending' }] })] }), // waiting
      withRoster({ ...cfg, stoppingBySession: { s1: 'r1' } }), // 叫停 → idle
      withRoster({ ...cfg, running: false, stats: rs({ finishedAt: NOW - 100 }), msgs: [user(), asst({ status: 'done', content: 'x' })] }), // done
      withRoster({ ...cfg, running: false, stats: rs({ finishedAt: NOW - DONE_HOLD_MS - 100 }), msgs: [user(), asst({ status: 'error', content: 'x' })] }), // error
      withRoster({ ...cfg, running: false, runStatsBySession: {}, msgs: [user()] }), // 余韵外的 idle
    ]
    for (const s of rows) expect(agentStatusOf(s, 's1', NOW)).toMatchObject({ agentSlug: 'muse', agentName: 'Muse' })
  })
})

describe('statusKey', () => {
  it('只含 phase / tool / toolStage / waitingFor / sessionId / agentSlug —— since 与字符数不进键', () => {
    const a = agentStatusOf(slice({ msgs: [user(), asst({ content: 'He', segments: [{ t: 'text', text: 'He' }] })] }), 's1', NOW)
    const b = agentStatusOf(slice({ msgs: [user(), asst({ content: 'Hello', segments: [{ t: 'text', text: 'Hello' }] })] }), 's1', NOW + 50)
    expect(statusKey(a)).toBe(statusKey(b))
    expect(statusKey(a)).toBe('speaking||||s1|')
  })

  it('换 Agent 进键(订阅方要醒过来换形象);只改展示名不进键(不值得把每个插件敲一遍)', () => {
    const at = (over: Partial<AgentStatusSlice>): string =>
      statusKey(agentStatusOf(slice({ defaultAgentSlug: 'xyra', agentDefs: [adef('xyra', 'Xyra'), adef('muse', 'Muse')], ...over }), 's1', NOW))
    const base = at({})
    expect(at({ configBySession: { s1: { agentSlug: 'muse' } } })).not.toBe(base)
    expect(at({ agentDefs: [adef('xyra', 'Xyra 2.0')] })).toBe(base)
  })
})
