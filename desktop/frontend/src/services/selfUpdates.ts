import type { HistorianActivityItem, ToolEvent } from '../types'
import { harnessChanges, harnessChangeState, type HarnessChangeState } from './harnessUpdates'
import { humanChanges } from './humanCollaboration'
import { parseUtc } from '../stores/inboxStore'

/** 引擎 remember 回执里的一次改动(tangu-agent `tools/builtin/memoryLog.ts`;字段只增不改)。
 *  回执里没有 Agent 的 slug:撤销时由调用方按「这条发言是谁说的 / 会话的 Agent」给,引擎那头自己折叠共用记忆。 */
export interface MemoryChange {
  /** 工具调用 id(行的 key;同一条回执重放时去重)。 */
  callId: string
  action: 'add' | 'update' | 'forget'
  scope: 'agent' | 'project'
  /** scope 'project':项目名(引擎给的目录名)。 */
  project?: string
  entryId?: string
  /** add / update:落库的那一句;forget:空(回执不带被忘掉的原句)。 */
  content: string
}
const MEMORY_ACTIONS = new Set(['add', 'update', 'forget'])

/** 只认 remember 自己落库的成功回执(重开历史会话照样还原);list、没写进去的重复、报错、老后端的纯文本回执都不算。 */
export function memoryChanges(events: ToolEvent[] = []): MemoryChange[] {
  const changes = new Map<string, MemoryChange>()
  for (const ev of events) {
    if (ev.name !== 'remember' || !ev.done || ev.isError || !ev.result) continue
    try {
      const r = JSON.parse(ev.result)
      if (r?.ok !== true || !MEMORY_ACTIONS.has(r.action) || (r.scope !== 'agent' && r.scope !== 'project') || r.duplicate) continue
      const entryId = typeof r.entry?.id === 'string' ? r.entry.id : typeof r.id === 'string' ? r.id : undefined
      const content = typeof r.entry?.content === 'string' ? r.entry.content : ''
      if (r.action !== 'forget' && (!entryId || !content)) continue
      changes.set(ev.id, { callId: ev.id, action: r.action, scope: r.scope, ...(typeof r.project === 'string' ? { project: r.project } : {}), ...(entryId ? { entryId } : {}), content })
    } catch { /* 纯文本回执(报错、老后端)不出行 */ }
  }
  return [...changes.values()]
}

/** 这次工具调用已经由回执行 / 请求卡呈现(Agent 自己写了记忆、进化记录或协作说明)→ 工具组里不再重复列一行。
 *  没写成的(报错、list、还在跑)照旧留在工具组里。 */
export function isSelfWriteReceipt(ev: ToolEvent): boolean {
  if (ev.name !== 'remember' && ev.name !== 'manage_harness' && ev.name !== 'manage_human') return false
  return memoryChanges([ev]).length + harnessChanges([ev]).length + humanChanges([ev]).length > 0
}

// ── 留痕:后台复盘(Historian)在这段对话之后写下的东西,钉回触发它的那条回复后面 ──
export type TraceKind = 'harness_adopted' | 'harness_confirm' | 'project_memory_added' | 'project_memory_candidates' | 'project_memory_compacted'
const TRACE_KINDS = new Set<string>(['harness_adopted', 'harness_confirm', 'project_memory_added', 'project_memory_candidates', 'project_memory_compacted'])
export interface SessionTrace {
  id: string
  kind: TraceKind
  /** 发生时刻(ms)。 */
  at: number
  /** 这一笔里的条目(进化记录的标题 / 项目事实原句);压缩那一种为空。 */
  items: string[]
  /** harness_adopted 且本机编辑史里对得上:能从这一行撤销(同对话里回执行的撤销);state 也从编辑史推出。 */
  undo?: { entryId: string; rev: string; state: HarnessChangeState }
  /** harness_confirm / project_memory_candidates:这段对话留给用户点头、现在还没处理的候选(读到了收件箱才有;空数组 = 都处理完了)。 */
  pending?: TraceCandidate[]
}
/** 留痕下面的一条待确认候选。上屏的 text 和要处理的 target 出自收件箱里的同一条 —— 点的就是看到的那一条,不靠活动流里的文字去对。 */
export interface TraceCandidate {
  key: string
  text: string
  /** 装备建议之类不能在这里直接采纳,只能丢弃。 */
  adoptable: boolean
  target: { kind: 'harness'; line: string } | { kind: 'project'; id: string }
}
/** 待确认候选的来源:进化记录的候选收件箱(`getAgentHarness().candidateItems`)、项目记忆的候选(`ProjectMemoryView.candidates`)。没读到就不给。 */
export interface PendingSources {
  harness?: Array<{ line: string; needsUser: boolean; adoptable: boolean }>
  project?: Array<{ id: string; content: string; at: number }>
}
/** 收件箱原始行 `- [YYYY-MM-DD s:xxxxxxxx] 正文`(引擎 harnessStore.appendHarnessCandidates 的形状)。s: 后面是会话 id 的前 8 位。 */
export function parseCandidateLine(line: string): { date: string; session: string; text: string } {
  const m = line.match(/^-\s*\[(\d{4}-\d{2}-\d{2})(?:\s+s:([A-Za-z0-9-]*))?\]\s*(.*)$/)
  return m ? { date: m[1], session: m[2] || '', text: m[3] } : { date: '', session: '', text: line.replace(/^-\s*/, '') }
}
const sessionTag = (sessionId: string): string => sessionId.replace(/[^A-Za-z0-9-]/g, '').slice(0, 8)
type JournalLine = { ts: string; rev?: string; action: string; entryId: string; after: { title: string } | null; by?: string; sessionId?: string }

/** 采纳的活动和它写下的编辑史行出自同一轮复盘,先后只差几秒;隔得更远的同名行是别的轮次(或会话换过 Agent 之后另一位的)。 */
const SAME_PASS_MS = 120_000

/** 活动流 → 留痕。活动的 detail 是「条目 | 条目」(引擎截到 300 字符)。后台采纳的进化记录一条一行,
 *  并到本机编辑史里找同一轮写下的那几笔(`by: 'historian'` + 本会话 + 时刻挨着)拿撤销要用的 entryId / rev。
 *  只有「拆出来的条数 = 那一轮写下的笔数,且标题逐条对上」才给撤销:标题里自带「 | 」、detail 被截断、换了设备、
 *  编辑史被截断,都对不上 → 只留痕、不给撤销(宁可少给,不能撤到别的条目上)。 */
export function sessionTraces(activity: HistorianActivityItem[], journal: JournalLine[] = [], sessionId = '', pending: PendingSources = {}): SessionTrace[] {
  const out: SessionTrace[] = []
  const mine = journal.filter((l) => l.by === 'historian' && l.action === 'upsert' && !!l.rev && !!sessionId && l.sessionId === sessionId)
  for (const a of activity) {
    if (!TRACE_KINDS.has(a.action)) continue
    const at = (parseUtc(a.created_at) ?? new Date(a.created_at)).getTime()
    if (!Number.isFinite(at)) continue
    const kind = a.action as TraceKind
    const items = kind === 'project_memory_compacted' ? [] : (a.detail || '').split(' | ').map((x) => x.trim()).filter(Boolean)
    if (kind !== 'harness_adopted') { out.push({ id: a.id, kind, at, items }); continue }
    const pass = mine.filter((l) => Math.abs(Date.parse(l.ts) - at) <= SAME_PASS_MS)
    const lines = items.map((title) => pass.filter((l) => l.after?.title === title))
    const exact = pass.length === items.length && lines.every((l) => l.length === 1)
    items.forEach((title, i) => {
      const line = exact ? lines[i][0] : undefined
      out.push({ id: `${a.id}:${i}`, kind, at, items: [title], ...(line ? { undo: { entryId: line.entryId, rev: line.rev!, state: harnessChangeState(journal, { entryId: line.entryId, rev: line.rev! }) } } : {}) })
    })
  }
  out.sort((x, y) => x.at - y.at)
  // 待确认的候选挂到留痕下面。进化记录的收件箱行自带会话标签:本会话的、还等用户点头的,都挂在最近一条「留给你确认」上。
  const tag = sessionTag(sessionId)
  const confirm = [...out].reverse().find((t) => t.kind === 'harness_confirm')
  if (confirm && pending.harness && tag) {
    confirm.pending = pending.harness.filter((c) => c.needsUser).map((c) => ({ c, parsed: parseCandidateLine(c.line) }))
      .filter((x) => x.parsed.session === tag)
      .map((x) => ({ key: x.c.line, text: x.parsed.text, adoptable: x.c.adoptable, target: { kind: 'harness' as const, line: x.c.line } }))
  }
  // 项目记忆的候选不带会话,只有时刻:和这条留痕同一轮复盘记下的才算它的;一条候选只挂一处。
  if (pending.project) {
    const used = new Set<string>()
    for (const tr of out) {
      if (tr.kind !== 'project_memory_candidates') continue
      tr.pending = pending.project.filter((c) => !used.has(c.id) && Math.abs(c.at - tr.at) <= SAME_PASS_MS)
        .map((c) => { used.add(c.id); return { key: c.id, text: c.content, adoptable: true, target: { kind: 'project' as const, id: c.id } } })
    }
  }
  return out
}

/** 每条留痕钉在「它发生时已经存在的最后一条助手消息」后面。复盘比回复晚几秒到十几秒,所以正常就是触发它的那条回复;
 *  找不到(那条消息已被回退 / 不在已加载的历史里)就不显示,不硬贴到别的消息上。 */
export function anchorTraces(messages: Array<{ id: string; role: string; timestamp: number }>, traces: SessionTrace[]): Map<string, SessionTrace[]> {
  const map = new Map<string, SessionTrace[]>()
  const replies = messages.filter((m) => m.role !== 'user')
  for (const tr of traces) {
    let host: string | undefined
    // 活动流的时刻只到秒:同一秒里先有回复、后有留痕时,按秒比才落得到这条回复上
    for (const m of replies) if (Math.floor(m.timestamp / 1000) * 1000 <= tr.at) host = m.id
    if (!host) continue
    map.set(host, [...(map.get(host) || []), tr])
  }
  return map
}

// ── 开场:开新对话时说一句「上次之后」后台替这个 Agent 写下了什么 ──
const BACKGROUND_MEMORY = new Set(['historian', 'dream'])
const BACKGROUND_NOTES = new Set(['historian', 'muse'])
/** 只数后台写的(复盘、记忆整理、Muse 代收):它当面记的那些在对话里已经有回执行,用户手改的更不用说。
 *  进化记录按条目数(同一条改两次算一处),写了又被撤掉 / 删掉的不算。 */
export function openingSummary(
  since: number,
  entries: Array<{ createdAt: number; source?: { kind?: string } }>,
  journal: Array<{ ts: string; action: string; entryId: string; by?: string }>,
): { remembered: number; evolved: number } {
  const last = new Map<string, string>()
  for (const l of journal) last.set(l.entryId, l.action)
  const notes = new Set(journal.filter((l) => l.action === 'upsert' && BACKGROUND_NOTES.has(l.by || '') && Date.parse(l.ts) > since && last.get(l.entryId) === 'upsert').map((l) => l.entryId))
  return { remembered: entries.filter((e) => e.createdAt > since && BACKGROUND_MEMORY.has(e.source?.kind || '')).length, evolved: notes.size }
}
