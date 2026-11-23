/**
 * 演示舞台的「脚本回放引擎」(engine: 'scripted'):舞台里那份 Forsion 连的不是真引擎,是父进程起的这个本机 HTTP 服务。
 * 插件在演示库目录里带一份 engine.json(格式见 StageScript),对话 / 工具卡 / 审批卡按剧本确定地回放,不花模型额度。
 *
 * 原型是测试用的 scripts/lib/stub-engine.cjs(真 Electron e2e 的可编剧假引擎):渲染层要摸的路由面照它一条不少地搬过来,
 * 事件流的写法也照它(seq 自增、末尾自动补 done、`__hold` 挂住等回答、答询问时补 inquiry_result)。与它**有意不同**的地方,
 * 都是为了「演示中途刷新 / 久等审批 / 没有测试脚本在旁边 finish」时不穿帮:
 *  · run 是服务端的时间线:POST /agent/runs 就开始按 delay 播,事件进日志;GET …/events?fromSeq=N 先补发日志再跟播
 *    (桩是每条连接从头重播、不认 fromSeq)。停止会真的停下还在播的剧本。
 *  · GET /agent/runs?session_id= 列出在飞的 run(桩恒回空表):渲染层每 30s 的看门狗查不到在飞的 run 就把气泡收尾、
 *    审批卡作废 —— 审批卡挂着拍视频超过 30s 就会穿帮。
 *  · `__hold` 按位置切段:它后面的事件等回答到了再播(桩把它当开关、全部事件先播完再挂住;桩的用法里它恒在末尾,两者等价)。
 *    答审批同样续播(补 approval_result,与真引擎同形),桩只记录、靠测试手动 finish。
 *  · 跑完的对话落库:用户那句在 POST 时落(id = 应答里的 userMessageId),回答在 done / error / 停止时按真引擎的落库形状拼好
 *    (tool_calls 带 ui_content_offset,tool_results 按 tool_call_id 配),刷新后会话还在。
 *  · 会话面是真的:建会话按请求体建(不是克隆第一条)、改名 / 归档 / 删除 / 删消息 / 存配置都落到内存里,列表按 archived 筛、
 *    按 updated_at 倒序;剧本里的消息按 session_id 分会话(不带 session_id 的给每个剧本会话各一份,同桩)。
 *  · 桩的测试旋钮(请求记录、failRuns、runDelayMs、override / handle 钩子)不搬。
 *
 * ⚠️ 本模块不 import electron(单测直跑),只绑 127.0.0.1;任何 Bearer 令牌都收,不带也收(舞台写的是 'sandbox')。
 * ⚠️ 它跑在用户那份 Forsion 的主进程里:处理器整体 try/catch、请求体有上限、close() 收干净所有挂着的连接与计时器。
 */
import { createHash, randomUUID } from 'node:crypto'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'

export const STAGE_SCRIPT_MAX_BYTES = 2 * 1024 * 1024
export const STAGE_MAX_RUNS = 200
export const STAGE_MAX_RUN_EVENTS = 2000
export const STAGE_MAX_EVENT_DELAY_MS = 10_000
export const STAGE_MAX_RUN_DELAY_MS = 120_000
/** 请求体上限:发消息时附件按 data URL 走请求体,截图几 MB 是常事。 */
const MAX_BODY_BYTES = 8 * 1024 * 1024
/** 同时挂着的事件流上限(舞台一份渲染层用不了几条;挡住别的本机程序挂一堆连接)。 */
const MAX_SUBS = 64
/** 剧本里的消息展开后(不带 session_id 的每个会话各一份)最多多少条:2 MB 的剧本也能靠这个展开成几百万个对象(Codex 11-20)。 */
export const STAGE_MAX_EXPANDED_MESSAGES = 20_000
/** 个人日历(fixture 的 human/CALENDAR.db)上限:同真引擎那条接口。 */
export const STAGE_CALENDAR_MAX_BYTES = 8 * 1024 * 1024
const HEARTBEAT_MS = 15_000
const ID_RE = /^[^\u0000-\u001f]{1,200}$/

type Json = Record<string, unknown>

export interface StageModel { id: string; name: string; provider: string; contextWindow?: number; [key: string]: unknown }
export interface StageSession { id: string; [key: string]: unknown }
export interface StageMessage { id: string; role: 'user' | 'assistant' | 'model'; session_id?: string; timestamp?: number; [key: string]: unknown }
/** 一条剧本事件:seq 由引擎编;delay = 发这条之前等多少毫秒(已钳到 0–10000)。type '__hold' = 在这里挂住等回答。 */
export interface StageEvent { type: string; payload: Json; delay: number }
/** 一次 run 的剧本:match = 用户那句话里包含这段字才用它(区分大小写);不写 = 谁都接。 */
export interface StageRun { match?: string; events: StageEvent[] }
export interface StageScript {
  models: StageModel[]
  sessions: StageSession[]
  messages: StageMessage[]
  runs: StageRun[]
  // 下面这些与桩的 data 同名同义,原样回给对应端点(缺省 = 空)
  agents: unknown[]
  engines: unknown[]
  directProviders: unknown[]
  modelsMeta: Json
  sessionConfigs: Record<string, Json>
  approvalRules: Json | null
  searchHits: unknown[]
  checkpoints: unknown[]
  restoreReport: Json | null
}

const DEFAULT_MODEL: StageModel = { id: 'demo', name: 'Demo model', provider: 'demo', contextWindow: 128_000 }
const DEFAULT_SESSION_CONFIG: Json = { execMode: 'host', approvalMode: 'auto-edit' }
const DEFAULT_APPROVAL_RULES: Json = { base: 'auto-edit', allow: [], ask: [], deny: [] }
const DEFAULT_RESTORE_REPORT: Json = { restored: [], deleted: [], skipped: [], conflicts: [], failed: [] }
/** 其余端点给「空但结构正确」的应答(同桩):桌面启动会摸不少端点,少一个就卡在加载态。 */
const CATCH_ALL: Json = {
  ok: true, items: [], list: [], data: [], skills: [], agents: [], tools: [], commands: [],
  engines: [], providers: [], background: [], messages: [], sessions: [], checkpoints: [], hits: [], runs: [],
}

// ── 剧本校验(纯函数)───────────────────────────────────────────────────────────

class ScriptError extends Error {}
function fail(message: string): never { throw new ScriptError(message) }
const isObj = (v: unknown): v is Json => !!v && typeof v === 'object' && !Array.isArray(v)
const errText = (e: unknown): string => (e instanceof Error ? e.message : String(e))

function list(v: unknown, path: string): unknown[] {
  if (!Array.isArray(v)) fail(`${path} must be an array`)
  return v as unknown[]
}
function obj(v: unknown, path: string): Json {
  if (!isObj(v)) fail(`${path} must be an object`)
  return v as Json
}
function idOf(v: unknown, path: string): string {
  if (typeof v !== 'string' || !ID_RE.test(v)) fail(`${path} must be a non-empty string of at most 200 characters`)
  return v as string
}
/** 可缺省的字段:undefined 放过;给了就得是 allowed 里的类型。 */
function optional(v: unknown, path: string, allowed: Array<'string' | 'null' | 'boolean' | 'object' | 'array' | 'number'>): void {
  if (v === undefined) return
  const kind = v === null ? 'null' : Array.isArray(v) ? 'array' : typeof v === 'number' ? (Number.isFinite(v) ? 'number' : 'nan') : typeof v
  if (!(allowed as string[]).includes(kind)) fail(`${path} must be ${allowed.map((a) => (a === 'object' ? 'an object' : a === 'array' ? 'an array' : a)).join(' or ')}`)
}

function parseModels(v: unknown): StageModel[] {
  if (v === undefined) return [{ ...DEFAULT_MODEL }]
  const items = list(v, 'models')
  if (!items.length) fail('models must list at least one model')
  const seen = new Set<string>()
  return items.map((raw, i) => {
    const p = `models[${i}]`
    const m = obj(raw, p)
    const id = idOf(m.id, `${p}.id`)
    if (seen.has(id)) fail(`${p}.id "${id}" is used twice`)
    seen.add(id)
    optional(m.name, `${p}.name`, ['string'])
    optional(m.provider, `${p}.provider`, ['string'])
    if (m.contextWindow !== undefined && !(typeof m.contextWindow === 'number' && Number.isFinite(m.contextWindow) && m.contextWindow > 0)) fail(`${p}.contextWindow must be a positive number`)
    return { ...m, id, name: typeof m.name === 'string' && m.name ? m.name : id, provider: typeof m.provider === 'string' && m.provider ? m.provider : 'demo' }
  })
}

function parseSessions(v: unknown): StageSession[] {
  if (v === undefined) return []
  const seen = new Set<string>()
  return list(v, 'sessions').map((raw, i) => {
    const p = `sessions[${i}]`
    const s = obj(raw, p)
    const id = idOf(s.id, `${p}.id`)
    if (seen.has(id)) fail(`${p}.id "${id}" is used twice`)
    seen.add(id)
    optional(s.title, `${p}.title`, ['string', 'null'])
    optional(s.summary, `${p}.summary`, ['string', 'null'])
    optional(s.model_id, `${p}.model_id`, ['string', 'null'])
    optional(s.archived, `${p}.archived`, ['boolean'])
    optional(s.emoji, `${p}.emoji`, ['string', 'null'])
    optional(s.agent_config, `${p}.agent_config`, ['object', 'null'])
    optional(s.project_path, `${p}.project_path`, ['string', 'null'])
    optional(s.project_name, `${p}.project_name`, ['string', 'null'])
    optional(s.projectless, `${p}.projectless`, ['boolean'])
    optional(s.created_at, `${p}.created_at`, ['string'])
    optional(s.updated_at, `${p}.updated_at`, ['string'])
    return { ...s, id }
  })
}

const ROLES = new Set(['user', 'assistant', 'model'])
function parseMessages(v: unknown, sessions: StageSession[]): StageMessage[] {
  if (v === undefined) return []
  const sessionIds = new Set(sessions.map((s) => s.id))
  const seen = new Set<string>()
  return list(v, 'messages').map((raw, i) => {
    const p = `messages[${i}]`
    const m = obj(raw, p)
    const id = idOf(m.id, `${p}.id`)
    if (seen.has(id)) fail(`${p}.id "${id}" is used twice`)
    seen.add(id)
    if (typeof m.role !== 'string' || !ROLES.has(m.role)) fail(`${p}.role must be "user", "assistant" or "model"`)
    optional(m.content, `${p}.content`, ['string', 'null'])
    optional(m.reasoning, `${p}.reasoning`, ['string', 'null'])
    optional(m.timestamp, `${p}.timestamp`, ['number'])
    optional(m.tool_calls, `${p}.tool_calls`, ['array', 'null'])
    optional(m.tool_results, `${p}.tool_results`, ['array', 'null'])
    optional(m.attachments, `${p}.attachments`, ['array', 'null'])
    optional(m.display_files, `${p}.display_files`, ['array', 'null'])
    if (m.session_id !== undefined) {
      const sid = idOf(m.session_id, `${p}.session_id`)
      if (!sessionIds.has(sid)) fail(`${p}.session_id "${sid}" is not one of the script's sessions`)
    } else if (!sessions.length) fail(`${p} has no session_id and the script has no sessions to show it in`)
    return { ...m, id, role: m.role as StageMessage['role'] }
  })
}

function parseRuns(v: unknown): StageRun[] {
  if (v === undefined) return []
  const items = list(v, 'runs')
  if (items.length > STAGE_MAX_RUNS) fail(`runs has ${items.length} entries; the limit is ${STAGE_MAX_RUNS}`)
  return items.map((raw, i) => {
    const p = `runs[${i}]`
    const r = obj(raw, p)
    if (r.match !== undefined && (typeof r.match !== 'string' || !r.match || r.match.length > 2000)) fail(`${p}.match must be a non-empty string of at most 2000 characters`)
    const events = list(r.events, `${p}.events`)
    if (events.length > STAGE_MAX_RUN_EVENTS) fail(`${p}.events has ${events.length} entries; the limit is ${STAGE_MAX_RUN_EVENTS}`)
    let total = 0
    const parsed = events.map((rawEv, j) => {
      const q = `${p}.events[${j}]`
      const e = obj(rawEv, q)
      if (typeof e.type !== 'string' || !e.type || e.type.length > 100) fail(`${q}.type must be a non-empty string of at most 100 characters`)
      if (e.payload !== undefined && !isObj(e.payload)) fail(`${q}.payload must be an object`)
      if (e.delay !== undefined && !(typeof e.delay === 'number' && Number.isFinite(e.delay))) fail(`${q}.delay must be a number of milliseconds`)
      const delay = e.type === '__hold' ? 0 : Math.round(Math.min(STAGE_MAX_EVENT_DELAY_MS, Math.max(0, (e.delay as number | undefined) ?? 0)))
      total += delay
      return { type: e.type as string, payload: (e.payload as Json | undefined) ?? {}, delay }
    })
    if (total > STAGE_MAX_RUN_DELAY_MS) fail(`${p} adds up to ${total} ms of delay; the limit is ${STAGE_MAX_RUN_DELAY_MS} ms`)
    return { ...(typeof r.match === 'string' ? { match: r.match } : {}), events: parsed }
  })
}

function parseObjectMap(v: unknown, path: string): Record<string, Json> {
  if (v === undefined) return {}
  const m = obj(v, path)
  for (const [k, val] of Object.entries(m)) obj(val, `${path}.${k}`)
  return m as Record<string, Json>
}

function parseScript(raw: unknown): StageScript {
  let value: unknown
  if (typeof raw === 'string' || raw instanceof Uint8Array) {
    const size = typeof raw === 'string' ? Buffer.byteLength(raw, 'utf8') : raw.byteLength
    if (size > STAGE_SCRIPT_MAX_BYTES) fail(`the script is ${size} bytes; the limit is ${STAGE_SCRIPT_MAX_BYTES} bytes (2 MB)`)
    const text = typeof raw === 'string' ? raw : Buffer.from(raw.buffer, raw.byteOffset, raw.byteLength).toString('utf8')
    try { value = JSON.parse(text.replace(/^﻿/, '')) } catch (e) { fail(`the script is not valid JSON: ${errText(e)}`) }
  } else {
    // 已解析的值:按 JSON 文本量体积,再解析一遍 —— 拿到一份纯 JSON 的副本(函数 / undefined 之类的值不会混进来,调用方之后改原对象也不影响)
    let text: string | undefined
    try { text = JSON.stringify(raw) } catch (e) { fail(`the script must be plain JSON data: ${errText(e)}`) }
    if (text === undefined) fail('the script must be a JSON object')
    const size = Buffer.byteLength(text as string, 'utf8')
    if (size > STAGE_SCRIPT_MAX_BYTES) fail(`the script is ${size} bytes; the limit is ${STAGE_SCRIPT_MAX_BYTES} bytes (2 MB)`)
    value = JSON.parse(text as string)
  }
  if (!isObj(value)) fail('the script must be a JSON object')
  const s = value as Json
  const sessions = parseSessions(s.sessions)
  const arr = (k: string): unknown[] => (s[k] === undefined ? [] : list(s[k], k))
  return {
    models: parseModels(s.models),
    sessions,
    messages: parseMessages(s.messages, sessions),
    runs: parseRuns(s.runs),
    agents: arr('agents'),
    engines: arr('engines'),
    directProviders: arr('directProviders'),
    modelsMeta: s.modelsMeta === undefined ? {} : obj(s.modelsMeta, 'modelsMeta'),
    sessionConfigs: parseObjectMap(s.sessionConfigs, 'sessionConfigs'),
    approvalRules: s.approvalRules === undefined ? null : obj(s.approvalRules, 'approvalRules'),
    searchHits: arr('searchHits'),
    checkpoints: arr('checkpoints'),
    restoreReport: s.restoreReport === undefined ? null : obj(s.restoreReport, 'restoreReport'),
  }
}

/**
 * 校验并规整一份剧本(engine.json 的文本、字节,或已 JSON.parse 的值)。纯函数:不读盘、不看时钟。
 * 体积 ≤ 2 MB、runs ≤ 200、每个 run ≤ 2000 条事件、delay 钳到 0–10000 ms、每个 run 的 delay 合计 ≤ 120 s;
 * 不认识的顶层键忽略;类型不对 → { error }(英文,带出错的路径)。
 */
export function parseStageScript(raw: unknown): { script: StageScript } | { error: string } {
  try {
    const script = parseScript(raw)
    const shared = script.messages.filter((m) => !m.session_id).length
    const expanded = script.messages.length - shared + shared * Math.max(1, script.sessions.length)
    if (expanded > STAGE_MAX_EXPANDED_MESSAGES) return { error: `messages expand to ${expanded} rows across sessions (max ${STAGE_MAX_EXPANDED_MESSAGES}); give the messages a session_id` }
    return { script }
  } catch (e) {
    return { error: e instanceof ScriptError ? e.message : `the script could not be read: ${errText(e)}` }
  }
}

/** 给这次 run 挑剧本:先找第一条没用过、match 包含在用户那句话里的;没有再找第一条没用过、不带 match 的。都没有 = -1。 */
export function pickStageRun(runs: readonly StageRun[], used: ReadonlySet<number>, prompt: string): number {
  let fallback = -1
  for (let i = 0; i < runs.length; i++) {
    if (used.has(i)) continue
    const m = runs[i].match
    if (m === undefined) { if (fallback < 0) fallback = i }
    else if (prompt.includes(m)) return i
  }
  return fallback
}

// ── 回放服务 ────────────────────────────────────────────────────────────────

/** 个人日历的形状:同真引擎 routes/human.ts 的 isDbFile(经典表,不是笔记视图)。 */
const isCalendarDb = (d: unknown): d is Json => isObj(d) && typeof d.version === 'number' && typeof d.name === 'string'
  && Array.isArray(d.columns) && Array.isArray(d.rows) && d.source === undefined

/**
 * 校验 fixture 带的个人日历(human/CALENDAR.db 的文本、字节,或已 JSON.parse 的值)。纯函数。
 * 形状同真引擎家目录里那份:DbFile 经典表(version / name / columns / rows,没有 source)。
 */
export function parseStageCalendar(raw: unknown): { data: Json } | { error: string } {
  let v = raw
  if (typeof v === 'string' || Buffer.isBuffer(v) || v instanceof Uint8Array) {
    const text = (typeof v === 'string' ? v : Buffer.from(v).toString('utf8')).replace(/^\uFEFF/, '')
    if (Buffer.byteLength(text) > STAGE_CALENDAR_MAX_BYTES) return { error: 'human/CALENDAR.db is larger than 8 MB' }
    try { v = JSON.parse(text) } catch (e) { return { error: `human/CALENDAR.db is not valid JSON: ${errText(e)}` } }
  } else if (Buffer.byteLength(JSON.stringify(v) ?? '') > STAGE_CALENDAR_MAX_BYTES) return { error: 'human/CALENDAR.db is larger than 8 MB' }
  if (!isCalendarDb(v)) return { error: 'human/CALENDAR.db must be a database file: { version, name, columns: [], rows: [] } without source' }
  // fixture 是第三方插件带的:列和行逐个看形状,坏行(没有 cells)会让舞台里的日历渲染直接抛错(Codex 11-21)
  const columns = v.columns as unknown[]
  const rows = v.rows as unknown[]
  const badCol = columns.findIndex((c) => !isObj(c) || typeof c.id !== 'string' || typeof c.name !== 'string' || typeof c.type !== 'string')
  if (badCol >= 0) return { error: `human/CALENDAR.db columns[${badCol}] needs string id, name and type` }
  const badRow = rows.findIndex((r) => !isObj(r) || typeof r.id !== 'string' || !isObj(r.cells))
  if (badRow >= 0) return { error: `human/CALENDAR.db rows[${badRow}] needs a string id and a cells object` }
  return { data: v }
}

const calVersion = (text: string): string => createHash('sha256').update(text).digest('hex')

interface Frame { seq: number; type: string; payload: Json }
interface Sub { res: ServerResponse; hb: ReturnType<typeof setInterval> }
type RunStatus = 'running' | 'held' | 'done' | 'failed' | 'aborted'
/** 正在累积的那条回答(真引擎的「段」:turn_boundary 收尾一段、另起一段)。 */
interface Draft { id: string; content: string; reasoning: string; calls: Json[]; results: Json[]; files: Json[] }
interface RunState {
  id: string
  sessionId: string
  modelId: string | null
  createdAt: string
  /** 应答里给出去的两个 id:渲染层按它们建气泡,落库也必须用同一对,不然刷新一次对话就重复一轮。 */
  userMessageId: string
  assistantMessageId: string
  /** 当前这一段对应的用户那句(turn_boundary 注入的插话会换掉它):失败轮记录要指回它。 */
  turnUserId: string
  turnUserTs: number
  status: RunStatus
  /** 当前段还没播的事件;later = `__hold` 之后的各段,等回答到了一段段续播。 */
  pending: StageEvent[]
  later: StageEvent[][]
  log: Frame[]
  seq: number
  subs: Set<Sub>
  timer: ReturnType<typeof setTimeout> | null
  draft: Draft
  /** 回答比 `__hold` 先到(卡片已经画出来、后面还有带 delay 的事件在播):先收着,播到等待点时用掉(Codex 11-20)。 */
  early?: { type: string; payload: Json }
}

const SSE_HEADERS = { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' }
const strOf = (v: unknown): string => (typeof v === 'string' ? v : '')
const isTerminal = (s: RunStatus): boolean => s === 'done' || s === 'failed' || s === 'aborted'
const newDraft = (id: string): Draft => ({ id, content: '', reasoning: '', calls: [], results: [], files: [] })

class HttpError extends Error {
  constructor(readonly status: number, message: string) { super(message) }
}

/** 按 `__hold` 切段:[a, __hold, b] → [[a], [b]];末尾的 `__hold` 留一个空段(答完只补 done,同桩)。 */
function segmentsOf(events: StageEvent[]): StageEvent[][] {
  const out: StageEvent[][] = [[]]
  for (const e of events) {
    if (e.type === '__hold') out.push([])
    else out[out.length - 1].push(e)
  }
  return out
}

async function readBody(req: IncomingMessage): Promise<Json> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const c of req) {
    const b = Buffer.isBuffer(c) ? c : Buffer.from(String(c))
    size += b.length
    if (size > MAX_BODY_BYTES) throw new HttpError(413, 'request body too large')
    chunks.push(b)
  }
  try {
    const v = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')
    return isObj(v) ? v : {}
  } catch { return {} }
}

/**
 * 起一个回放服务,只听 127.0.0.1 的随机端口。返回 { url, close }:url 交给舞台当引擎地址(tangu-desktop-config.json 的
 * backendUrl / TANGU_BACKEND_URL);close() 断开所有连接(包括挂着的事件流)、停掉所有计时器后才 resolve。
 */
export async function startStageEngine(
  script: StageScript,
  opts: { log?(m: string): void; token?: string; /** fixture 的 human/CALENDAR.db,已过 parseStageCalendar */ calendar?: Json } = {},
): Promise<{ url: string; close(): Promise<void> }> {
  const log = (m: string): void => { try { opts.log?.(m) } catch { /* 记日志不许打断服务 */ } }
  // 个人日历:只活在这次舞台的内存里,舞台里的改动(拖日程、勾待办)不落盘。version = 文本的 sha256,同真引擎
  let calendar: { data: Json; version: string } | null = null
  if (opts.calendar) { const text = JSON.stringify(opts.calendar); calendar = { data: JSON.parse(text) as Json, version: calVersion(text) } }
  const now = Date.now()
  const models = script.models.length ? script.models : [{ ...DEFAULT_MODEL }]
  const defaultModelId = models[0].id

  // 会话:Map 保留插入序;没写时间的按剧本顺序错开一分钟(第一条最新),列表按 updated_at 倒序时仍是剧本里的顺序
  const sessions = new Map<string, Json>()
  const configs = new Map<string, Json>()
  const manualTitles = new Set<string>()
  /** 剧本 session_title 起过题的会话:客户端发完第一句会补一个 'auto' 占位标题(真引擎里 Historian 的标题总在它之后到),
   *  回放把时间压短了、顺序可能倒过来 —— 占位标题不许盖掉剧本的标题。 */
  const engineTitles = new Set<string>()
  script.sessions.forEach((s, i) => {
    const stamp = new Date(now - i * 60_000).toISOString()
    const created = typeof s.created_at === 'string' ? s.created_at : typeof s.updated_at === 'string' ? s.updated_at : stamp
    sessions.set(s.id, {
      title: 'New Chat', summary: null, model_id: null, archived: false, emoji: null, agent_config: null,
      ...s, created_at: created, updated_at: typeof s.updated_at === 'string' ? s.updated_at : created,
    })
  })
  const configOf = (sid: string): Json => {
    const stored = configs.get(sid)
    if (stored) return stored
    const fromScript = script.sessionConfigs[sid]
    if (fromScript) return fromScript
    const own = sessions.get(sid)?.agent_config
    return isObj(own) ? own : DEFAULT_SESSION_CONFIG
  }

  // 消息按会话存、按时间排;不带 session_id 的给每个剧本会话各一份(同桩:桩对任何会话都回同一份)
  const messages = new Map<string, Json[]>()
  const lastTs = new Map<string, number>()
  const failedRuns = new Map<string, Json[]>()
  const base = now - 3_600_000
  script.messages.forEach((m, i) => {
    const { session_id: sid, ...rest } = m
    const row: Json = {
      content: null, reasoning: null, tool_calls: null, tool_results: null, attachments: null, model_id: null, is_error: false,
      ...rest, timestamp: typeof m.timestamp === 'number' ? m.timestamp : base + i * 1000,
    }
    for (const target of sid ? [sid] : script.sessions.map((s) => s.id)) {
      const listFor = messages.get(target) ?? []
      listFor.push({ ...row })
      messages.set(target, listFor)
    }
  })
  for (const [sid, rows] of messages) {
    rows.sort((a, b) => Number(a.timestamp) - Number(b.timestamp))
    lastTs.set(sid, Math.max(0, ...rows.map((r) => Number(r.timestamp) || 0)))
  }

  let approvalRules: Json = script.approvalRules ?? DEFAULT_APPROVAL_RULES
  const used = new Set<number>()
  const runs = new Map<string, RunState>()
  const promptSubs = new Set<Sub>()
  let closed = false

  // ── 落库 ──
  const nextTs = (sid: string, min: number): number => {
    const t = Math.max(min, (lastTs.get(sid) ?? 0) + 1)
    lastTs.set(sid, t)
    return t
  }
  const touch = (sid: string): void => {
    const s = sessions.get(sid)
    if (s) s.updated_at = new Date().toISOString()
  }
  const upsertMessage = (sid: string, row: Json): void => {
    const rows = messages.get(sid) ?? []
    const i = rows.findIndex((m) => m.id === row.id)
    if (i >= 0) rows.splice(i, 1)
    let at = rows.length
    while (at > 0 && Number(rows[at - 1].timestamp) > Number(row.timestamp)) at--
    rows.splice(at, 0, row)
    messages.set(sid, rows)
  }
  /** 一段回答落库(与真引擎同形:role 'model'、tool_calls 带 ui_content_offset、tool_results 按 tool_call_id 配)。空段不落。 */
  const persistDraft = (run: RunState, content = run.draft.content): void => {
    const d = run.draft
    if (!run.sessionId || (!content && !d.reasoning && !d.calls.length && !d.files.length)) return
    upsertMessage(run.sessionId, {
      id: d.id, role: 'model', content, reasoning: d.reasoning || null,
      tool_calls: d.calls.length ? d.calls : null, tool_results: d.results.length ? d.results : null,
      attachments: null, display_files: d.files.length ? d.files : null,
      timestamp: nextTs(run.sessionId, run.turnUserTs + 1), model_id: run.modelId, is_error: false, origin: null,
    })
    touch(run.sessionId)
  }
  const persistUser = (sid: string, row: { id: string; content: string; attachments?: unknown; modelId: string | null }): number => {
    const ts = nextTs(sid, Date.now())
    upsertMessage(sid, {
      id: row.id, role: 'user', content: row.content, reasoning: null, tool_calls: null, tool_results: null,
      attachments: Array.isArray(row.attachments) && row.attachments.length ? row.attachments : null,
      timestamp: ts, model_id: row.modelId, is_error: false, origin: null,
    })
    touch(sid)
    return ts
  }
  /** 挂起的调用(托盘 run)在后面的段才出结果:回到落过库的那一行补上(同真引擎按同一 id 再 finalize)。 */
  const patchPersistedResult = (sid: string, result: Json): boolean => {
    const row = (messages.get(sid) ?? []).find((m) => Array.isArray(m.tool_calls) && (m.tool_calls as Json[]).some((c) => c.id === result.tool_call_id))
    if (!row) return false
    const results = Array.isArray(row.tool_results) ? (row.tool_results as Json[]).filter((r) => r.tool_call_id !== result.tool_call_id) : []
    row.tool_results = [...results, result]
    return true
  }

  // ── 事件 ──
  const write = (res: ServerResponse, text: string): void => { try { res.write(text) } catch { /* 对方已断 */ } }
  const frameText = (f: Frame): string => `data: ${JSON.stringify(f)}\n\n`
  const subCount = (): number => [...runs.values()].reduce((n, r) => n + r.subs.size, 0) + promptSubs.size
  const addSub = (set: Set<Sub>, res: ServerResponse): void => {
    if (subCount() >= MAX_SUBS) { try { res.end() } catch { /* 已断 */ } return }
    const sub: Sub = { res, hb: setInterval(() => write(res, ': hb\n\n'), HEARTBEAT_MS) }
    ;(sub.hb as { unref?: () => void }).unref?.() // 心跳不拖住进程退出
    set.add(sub)
    res.on('close', () => { clearInterval(sub.hb); set.delete(sub) })
  }
  const endSub = (sub: Sub): void => {
    clearInterval(sub.hb)
    try { sub.res.end() } catch { /* 已断 */ }
  }

  /** 引擎自己的 id 剧本里不必写:缺了就补(审批 / 询问 id、turn_boundary 的收尾与新段 id、标题事件的会话)。只补缺的,写了的原样。
   *  工具参数真引擎恒发 JSON 字符串(渲染层原样存、HTML 卡还要 JSON.parse 它):剧本里写成对象的在这里转成字符串,直播与落库同一份。 */
  const withIds = (run: RunState, type: string, payload: Json): Json => {
    const pl = { ...payload }
    if ((type === 'tool_call' || type === 'approval_request') && typeof pl.arguments !== 'string') pl.arguments = JSON.stringify(pl.arguments ?? {})
    if (type === 'approval_request' && typeof pl.approvalId !== 'string') pl.approvalId = `apv-${randomUUID()}`
    if (type === 'inquiry_request' && typeof pl.inquiryId !== 'string') pl.inquiryId = `inq-${randomUUID()}`
    if (type === 'session_title' && typeof pl.sessionId !== 'string') pl.sessionId = run.sessionId
    if (type === 'turn_boundary') {
      if (typeof pl.finalizedAssistantId !== 'string') pl.finalizedAssistantId = run.draft.id
      if (typeof pl.finalizedContent !== 'string') pl.finalizedContent = run.draft.content
      if (typeof pl.newAssistantId !== 'string' || !pl.newAssistantId) pl.newAssistantId = randomUUID()
      if (Array.isArray(pl.userMessages)) {
        pl.userMessages = pl.userMessages.filter(isObj).map((u) => ({ ...u, id: typeof u.id === 'string' && u.id ? u.id : randomUUID(), content: String(u.content ?? '') }))
      }
    }
    return pl
  }

  /** 事件 → 对话记录(真引擎落库的那份)。只记会落库的:审批 / 询问卡、计划、用量等不进消息行。 */
  const record = (run: RunState, type: string, pl: Json): void => {
    const d = run.draft
    switch (type) {
      case 'token': d.content += strOf(pl.delta); break
      case 'reasoning': d.reasoning += strOf(pl.delta); break
      case 'tool_stream': {
        const id = strOf(pl.id)
        if (!id) break
        const call = d.calls.find((c) => c.id === id)
        if (call) (call.function as Json).arguments = strOf((call.function as Json).arguments) + strOf(pl.delta)
        else d.calls.push({ id, type: 'function', function: { name: strOf(pl.name) || 'tool', arguments: strOf(pl.delta) }, ui_content_offset: d.content.length })
        break
      }
      case 'tool_call': {
        const id = strOf(pl.id)
        if (!id) break
        const args = typeof pl.arguments === 'string' ? pl.arguments : JSON.stringify(pl.arguments ?? {})
        const name = strOf(pl.name) || 'tool'
        const call = d.calls.find((c) => c.id === id)
        if (call) call.function = { name, arguments: args }
        else d.calls.push({ id, type: 'function', function: { name, arguments: args }, ui_content_offset: d.content.length })
        break
      }
      case 'tool_result': {
        const id = strOf(pl.id)
        if (!id) break
        const call = d.calls.find((c) => c.id === id)
        const result: Json = { tool_call_id: id, name: strOf(pl.name) || strOf((call?.function as Json | undefined)?.name) || 'tool', content: String(pl.result ?? ''), isError: pl.isError === true }
        for (const k of ['startedAt', 'elapsedMs', 'outputChars', 'parallelGroup', 'artifactPath', 'metadata', 'masked', 'parked'] as const) {
          if (pl[k] !== undefined) result[k] = pl[k]
        }
        if (!call && run.sessionId && patchPersistedResult(run.sessionId, result)) break
        d.results = [...d.results.filter((r) => r.tool_call_id !== id), result]
        break
      }
      case 'display_file': {
        if (typeof pl.name !== 'string' || !pl.name) break
        const file: Json = { name: pl.name }
        for (const k of ['mime', 'path', 'dataUrl'] as const) if (typeof pl[k] === 'string') file[k] = pl[k]
        d.files.push(file)
        break
      }
      case 'turn_boundary': {
        persistDraft(run, strOf(pl.finalizedContent) || d.content)
        for (const u of (Array.isArray(pl.userMessages) ? pl.userMessages : []) as Json[]) {
          if (!run.sessionId) break
          run.turnUserTs = persistUser(run.sessionId, { id: String(u.id), content: String(u.content ?? ''), modelId: run.modelId })
          run.turnUserId = String(u.id)
        }
        run.draft = newDraft(String(pl.newAssistantId))
        break
      }
      case 'session_title': {
        // 同真引擎 Historian:手动起过的标题不动
        const sid = strOf(pl.sessionId)
        const s = sessions.get(sid)
        if (s && !manualTitles.has(sid) && typeof pl.title === 'string' && pl.title.trim()) {
          s.title = pl.title.trim().slice(0, 200)
          engineTitles.add(sid)
        }
        break
      }
      case 'done': {
        // 与渲染层同口径:带 toolOffsets 的终稿说了算(空串也算);老写法只有非空 content 才盖
        if (typeof pl.content === 'string' && (pl.content || Array.isArray(pl.toolOffsets))) d.content = pl.content
        if (Array.isArray(pl.toolOffsets)) {
          for (const o of pl.toolOffsets.filter(isObj)) {
            const call = d.calls.find((c) => c.id === o.id)
            if (call && Number.isInteger(o.offset) && (o.offset as number) >= 0) call.ui_content_offset = o.offset
          }
        }
        persistDraft(run)
        run.status = 'done'
        break
      }
      case 'error': {
        if (typeof pl.content === 'string' && pl.content) d.content = pl.content
        persistDraft(run)
        run.status = pl.aborted === true ? 'aborted' : 'failed'
        // 失败轮(真引擎 services/failedRuns.ts):重开对话时据此补回失败行;停止不算失败
        if (run.status === 'failed' && run.sessionId) {
          const rows = failedRuns.get(run.sessionId) ?? []
          rows.push({ assistant_message_id: d.id, user_message_id: run.turnUserId, error: strOf(pl.error) || 'error', timestamp: run.turnUserTs + 1 })
          failedRuns.set(run.sessionId, rows)
        }
        break
      }
    }
  }

  const emit = (run: RunState, type: string, payload: Json): void => {
    const pl = withIds(run, type, payload)
    const frame: Frame = { seq: ++run.seq, type, payload: pl }
    run.log.push(frame)
    const text = frameText(frame)
    for (const s of run.subs) write(s.res, text)
    // 剧本是插件给的:哪条事件的形状怪到拼不进落库,也只记一笔,不能在计时器里抛到用户那份 Forsion 的主进程(Codex 11-20)
    try { record(run, type, pl) } catch (e) { log(`could not store a replayed "${type}" event: ${errText(e)}`) }
    if (isTerminal(run.status)) {
      if (run.timer) clearTimeout(run.timer)
      run.timer = null
      run.pending = []
      run.later = []
      for (const s of run.subs) endSub(s)
      run.subs.clear()
    }
  }

  /** 按 delay 播当前段;段播完:后面还有段 = 挂住等回答,没有 = 补 done(剧本自己发了 done / error 就已经收尾了)。 */
  const pump = (run: RunState): void => {
    run.timer = null
    while (run.status === 'running' && !closed) {
      const ev = run.pending.shift()
      if (!ev) {
        if (run.later.length) {
          // 回答已经先到了:不挂住,直接接着播
          if (run.early) { const e = run.early; run.early = undefined; resume(run, e.type, e.payload); return }
          run.status = 'held'
        } else emit(run, 'done', {})
        return
      }
      if (ev.delay > 0) {
        run.timer = setTimeout(() => {
          run.timer = null
          if (run.status !== 'running' || closed) return
          try {
            emit(run, ev.type, ev.payload)
            pump(run)
          } catch (e) {
            log(`replay failed: ${errText(e)}`)
            if (!isTerminal(run.status)) { try { emit(run, 'error', { error: 'the scripted run could not continue' }) } catch { /* 已尽力 */ } }
          }
        }, ev.delay)
        return
      }
      emit(run, ev.type, ev.payload)
    }
  }

  /** 回答到了(询问 / 审批):先发结果事件,再播 `__hold` 后面那一段。 */
  const resume = (run: RunState, type: string, payload: Json): void => {
    run.status = 'running'
    emit(run, type, payload)
    if (run.status !== 'running') return
    run.pending = [...(run.later.shift() ?? [])]
    pump(run)
  }

  const sessionRow = (s: Json): Json => {
    const id = String(s.id)
    const busy = [...runs.values()].some((r) => r.sessionId === id && !isTerminal(r.status))
    return { ...s, busy }
  }
  const sortedSessions = (): Json[] => {
    const t = (s: Json): number => Date.parse(String(s.updated_at)) || 0
    return [...sessions.values()].map((s, i) => ({ s, i })).sort((a, b) => t(b.s) - t(a.s) || a.i - b.i).map((x) => x.s)
  }

  const handle = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const u = new URL(req.url || '/', 'http://stage.local')
    const p = u.pathname
    const method = req.method || 'GET'
    const parts = p.split('/')
    const seg = (i: number): string => { const raw = parts[i] ?? ''; try { return decodeURIComponent(raw) } catch { return raw } }
    const json = (body: unknown, code = 200): void => {
      res.writeHead(code, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify(body))
    }
    const body = (): Promise<Json> => readBody(req)

    // ── run 生命周期 ──
    if (p === '/agent/runs' && method === 'GET') {
      const sid = u.searchParams.get('session_id')
      const rows = [...runs.values()].filter((r) => sid === null || r.sessionId === sid)
      return json({ runs: rows.map((r) => ({ id: r.id, session_id: r.sessionId, status: r.status === 'held' ? 'running' : r.status, assistant_message_id: r.assistantMessageId, created_at: r.createdAt })) })
    }
    if (p === '/agent/runs' && method === 'POST') {
      const b = await body()
      const sessionId = typeof b.session_id === 'string' ? b.session_id : ''
      const prompt = typeof b.message === 'string' ? b.message : ''
      const modelId = typeof b.model_id === 'string' && b.model_id ? b.model_id : null
      const pick = pickStageRun(script.runs, used, prompt)
      if (pick >= 0) used.add(pick)
      const segments = pick >= 0 ? segmentsOf(script.runs[pick].events) : [[]]
      const run: RunState = {
        id: randomUUID(), sessionId, modelId, createdAt: new Date().toISOString(),
        userMessageId: randomUUID(), assistantMessageId: randomUUID(), turnUserId: '', turnUserTs: 0,
        status: 'running', pending: segments[0], later: segments.slice(1), log: [], seq: 0, subs: new Set(), timer: null,
        draft: newDraft(''),
      }
      run.turnUserId = run.userMessageId
      run.draft = newDraft(run.assistantMessageId)
      if (sessionId) run.turnUserTs = persistUser(sessionId, { id: run.userMessageId, content: prompt, attachments: b.attachments, modelId })
      runs.set(run.id, run)
      log(pick >= 0 ? `run ${run.id}: playing scripted run #${pick}` : `run ${run.id}: no scripted run left, replying with done`)
      json({ runId: run.id, assistantMessageId: run.assistantMessageId, userMessageId: run.userMessageId })
      pump(run)
      return
    }
    if (/^\/agent\/runs\/[^/]+\/events$/.test(p)) {
      const run = runs.get(seg(3))
      res.writeHead(200, SSE_HEADERS)
      res.flushHeaders()
      // 不认识的 run(同桩):只回一条 done
      if (!run) { write(res, frameText({ seq: 1, type: 'done', payload: {} })); res.end(); return }
      const from = Number(u.searchParams.get('fromSeq')) || 0
      for (const f of run.log) if (f.seq > from) write(res, frameText(f))
      if (isTerminal(run.status) || closed) { res.end(); return }
      addSub(run.subs, res)
      return
    }
    // 停止:与真引擎同序 —— 先在事件流上发 error{aborted} 收尾,再回 { settled, status }
    if (/^\/agent\/runs\/[^/]+\/abort$/.test(p) && method === 'POST') {
      const run = runs.get(seg(3))
      if (run && !isTerminal(run.status)) {
        if (run.timer) clearTimeout(run.timer)
        run.timer = null
        run.status = 'running'
        emit(run, 'error', { error: 'aborted', aborted: true, content: '' })
        await new Promise((r) => setTimeout(r, 50)) // 让 UI 先收到终态帧再拿到确认
        return json({ success: true, settled: true, status: 'aborted' })
      }
      return json({ success: true, settled: true, status: run ? run.status : 'aborted' })
    }
    if (/^\/agent\/runs\/[^/]+\/inquiries\/[^/]+$/.test(p)) {
      const b = await body()
      const run = runs.get(seg(3))
      const inquiryId = seg(5)
      // ui_ 开头的是界面动作回执(sendUiAck 借这条路),不是在答询问:不续播
      if (run && !inquiryId.startsWith('ui_')) {
        if (run.status === 'held') resume(run, 'inquiry_result', { inquiryId, answer: b.answer })
        else if (run.status === 'running' && run.later.length && !run.early) run.early = { type: 'inquiry_result', payload: { inquiryId, answer: b.answer } }
      }
      return json({ ok: true })
    }
    // custom 审批档规则:内存里存一份,PUT 后 GET 读得回来
    if (p === '/agent/approval-rules') {
      if (method === 'PUT') {
        approvalRules = { ...approvalRules, ...(await body()) }
        return json({ ok: true, rules: approvalRules })
      }
      return json(approvalRules)
    }
    // 待批索引的计数面:剧本回放不往这里登记(在飞会话的审批卡走事件流),恒为空
    if (p === '/agent/approvals/pending' && method === 'GET') {
      if (u.searchParams.get('rev') === 'stage:0') return json({ rev: 'stage:0', unchanged: true })
      return json({ rev: 'stage:0', sessions: [] })
    }
    if (p === '/agent/approvals/stream' && method === 'GET') {
      res.writeHead(200, SSE_HEADERS)
      write(res, ': open\n\n')
      write(res, `data: ${JSON.stringify({ type: 'snapshot', rev: 'stage-p:0', items: [] })}\n\n`)
      if (closed) { res.end(); return }
      addSub(promptSubs, res)
      return
    }
    if (/^\/agent\/runs\/[^/]+\/approvals\/[^/]+$/.test(p)) {
      const b = await body()
      const run = runs.get(seg(3))
      const action = typeof b.action === 'string' && b.action ? b.action : 'approve'
      if (run?.status === 'held') resume(run, 'approval_result', { approvalId: seg(5), action })
      else if (run?.status === 'running' && run.later.length && !run.early) run.early = { type: 'approval_result', payload: { approvalId: seg(5), action } }
      return json({ ok: true })
    }

    // ── 会话面 ──
    if (p === '/agent/sessions/search') {
      const q = (u.searchParams.get('q') || '').toLowerCase()
      return json({ hits: q ? script.searchHits.filter((h) => JSON.stringify(h).toLowerCase().includes(q)) : [] })
    }
    if (/^\/agent\/sessions\/[^/]+\/checkpoints$/.test(p)) return json({ checkpoints: script.checkpoints })
    if (/^\/agent\/sessions\/[^/]+\/checkpoints\/restore$/.test(p)) {
      await body()
      return json(script.restoreReport ?? DEFAULT_RESTORE_REPORT)
    }
    if (/^\/agent\/sessions\/[^/]+\/messages\/delete$/.test(p)) {
      const sid = seg(3)
      const b = await body()
      if ([...runs.values()].some((r) => r.sessionId === sid && !isTerminal(r.status))) return json({ detail: 'run in progress' }, 409)
      const ids = new Set((Array.isArray(b.ids) ? b.ids : []).filter((x): x is string => typeof x === 'string' && !!x))
      const rows = messages.get(sid) ?? []
      const kept = rows.filter((m) => !ids.has(String(m.id)))
      messages.set(sid, kept)
      const fr = failedRuns.get(sid)
      if (fr) failedRuns.set(sid, fr.filter((f) => !ids.has(String(f.user_message_id)) && !ids.has(String(f.assistant_message_id))))
      return json({ ok: true, deleted: rows.length - kept.length })
    }
    if (p === '/agent/sessions' && method === 'GET') {
      const archived = u.searchParams.get('archived') === 'true'
      const limit = Math.floor(Math.min(Math.max(1, Number(u.searchParams.get('limit')) || 200), 500))
      return json({ sessions: sortedSessions().filter((s) => (s.archived === true) === archived).slice(0, limit).map(sessionRow) })
    }
    if (p === '/agent/sessions' && method === 'POST') {
      // 与真引擎 POST /agent/sessions 同口径按请求体建;标题缺省必须是 'New Chat'(渲染层只给这个标题的会话自动起名)
      const b = await body()
      const at = new Date().toISOString()
      const cfg = isObj(b.agent_config) ? b.agent_config : null
      const s: Json = {
        id: randomUUID(),
        title: typeof b.title === 'string' && b.title.trim() ? b.title.trim().slice(0, 200) : 'New Chat',
        summary: null,
        model_id: typeof b.model_id === 'string' && b.model_id ? b.model_id : defaultModelId,
        archived: false,
        emoji: typeof b.emoji === 'string' && b.emoji ? b.emoji : null,
        agent_config: cfg,
        project_path: typeof b.project_path === 'string' && b.project_path ? b.project_path.slice(0, 1000) : null,
        project_name: typeof b.project_name === 'string' && b.project_name ? b.project_name.slice(0, 255) : null,
        projectless: b.projectless === true,
        parent_session_id: null,
        created_at: at,
        updated_at: at,
      }
      sessions.set(String(s.id), s)
      if (cfg) configs.set(String(s.id), cfg)
      return json({ session: sessionRow(s) })
    }
    if (/^\/agent\/sessions\/[^/]+$/.test(p) && (method === 'PATCH' || method === 'DELETE')) {
      const sid = seg(3)
      const s = sessions.get(sid)
      if (!s) return json({ detail: 'Session not found' }, 404)
      if (method === 'DELETE') {
        sessions.delete(sid)
        messages.delete(sid)
        configs.delete(sid)
        failedRuns.delete(sid)
        return json({ ok: true })
      }
      // 与真引擎同:改名 / 归档 / 换模型 / 换项目都不动 updated_at(它是消息活动时间);'auto' 来的标题盖不掉手动起的
      const b = await body()
      let changed = false
      if (typeof b.title === 'string') {
        const title = b.title.trim().slice(0, 200)
        if (!(b.title_source === 'auto' && (manualTitles.has(sid) || engineTitles.has(sid)))) s.title = title
        if (b.title_source === 'user') { if (title) manualTitles.add(sid); else manualTitles.delete(sid) }
        changed = true
      }
      if (typeof b.archived === 'boolean') { s.archived = b.archived; changed = true }
      if (typeof b.model_id === 'string') { s.model_id = b.model_id || null; changed = true }
      if (typeof b.emoji === 'string' || b.emoji === null) { s.emoji = b.emoji || null; changed = true }
      if (typeof b.project_path === 'string' || b.project_path === null) { s.project_path = b.project_path ? String(b.project_path).slice(0, 1000) : null; changed = true }
      if (typeof b.project_name === 'string' || b.project_name === null) { s.project_name = b.project_name ? String(b.project_name).slice(0, 255) : null; changed = true }
      if (typeof b.projectless === 'boolean') { s.projectless = b.projectless; changed = true }
      if (!changed) return json({ detail: 'nothing to update' }, 400)
      return json({ session: sessionRow(s) })
    }
    if (/^\/agent\/sessions\/[^/]+\/detail$/.test(p) && sessions.has(seg(3))) {
      return json({ session: { ...sessionRow(sessions.get(seg(3)) as Json), delegate_running: false } })
    }
    if (/^\/agent\/sessions\/[^/]+\/messages$/.test(p)) {
      const sid = seg(3)
      const limit = Math.floor(Math.min(Math.max(1, Number(u.searchParams.get('limit')) || 200), 500))
      const before = Number(u.searchParams.get('before')) || 0
      const rows = (messages.get(sid) ?? []).filter((m) => !before || Number(m.timestamp) < before)
      return json({ messages: rows.slice(-limit), failed_runs: failedRuns.get(sid) ?? [] })
    }
    if (/^\/agent\/sessions\/[^/]+\/config$/.test(p)) {
      const sid = seg(3)
      if (method === 'PUT' || method === 'PATCH') {
        const patch = await body()
        // 应答同真引擎 = 落库后的整份配置:PUT 整对象替换,PATCH 并进(null 删键)
        const merged = method === 'PUT' ? patch : { ...configOf(sid), ...patch }
        const stored = Object.fromEntries(Object.entries(merged).filter(([, v]) => v !== null))
        configs.set(sid, stored)
        const s = sessions.get(sid)
        if (s) s.agent_config = stored
        return json({ agent_config: stored })
      }
      return json({ agent_config: configOf(sid) })
    }
    // ── 个人日历 human/CALENDAR.db:报文同真引擎 routes/human.ts(GET 的 missing 是 200;PUT 按 version 比对交换,null = 新建)──
    if (p === '/agent/human/CALENDAR.db' && method === 'GET') {
      return json(calendar ? { status: 'ok', data: calendar.data, version: calendar.version, legacy: null } : { status: 'missing', legacy: null })
    }
    if (p === '/agent/human/CALENDAR.db' && method === 'PUT') {
      const b = await body()
      const version = b.version
      if (!isCalendarDb(b.data) || (version !== null && typeof version !== 'string')) return json({ error: 'HUMAN_BAD_CALENDAR', detail: 'data must be a database file and version a string or null.' }, 400)
      const text = JSON.stringify(b.data)
      if (Buffer.byteLength(text) > STAGE_CALENDAR_MAX_BYTES) return json({ error: 'HUMAN_CALENDAR_TOO_LARGE', detail: 'The calendar is too large.' }, 413)
      if ((calendar?.version ?? null) !== version) return json({ error: 'HUMAN_CONFLICT', detail: 'The calendar changed since it was read.' }, 409)
      calendar = { data: JSON.parse(text) as Json, version: calVersion(text) }
      return json({ ok: true, version: calendar.version })
    }
    if (/^\/agent\/sessions\/[^/]+\/background$/.test(p)) return json({ background: [] })
    if (p === '/agent/models') return json({ models, defaultModelId, directProviders: script.directProviders, ...script.modelsMeta })
    if (p === '/agent/agents') return json({ agents: script.agents })
    if (p === '/agent/agents-meta') return json({ defaultSlug: 'xyra', order: [] })
    if (p === '/agent/engines') return json({ engines: script.engines })
    if (/^\/agent\/engines\/[^/]+\/capabilities$/.test(p)) return json({ models: [], commands: [] })
    // 通道轮询:不给这个端点的话 catch-all 缺 channels 字段,毒化 channelsStore → 侧栏崩「not iterable」
    if (p === '/agent/channels') return json({ channels: [], available: false })

    return json(CATCH_ALL)
  }

  const server = createServer((req, res) => {
    // 只认这个舞台的令牌(父进程每次起舞台现生成,写进舞台的引擎配置):本机别的程序连上来读不到演示数据、也占不了资源
    if (opts.token && req.headers.authorization !== `Bearer ${opts.token}`) {
      res.writeHead(401, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ detail: 'unauthorized' }))
      req.resume()
      return
    }
    handle(req, res).catch((e) => {
      const status = e instanceof HttpError ? e.status : 500
      if (status === 500) log(`request ${req.method} ${req.url} failed: ${errText(e)}`)
      if (!res.headersSent) {
        res.writeHead(status, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ detail: e instanceof HttpError ? e.message : 'stage engine error' }))
      } else {
        try { res.end() } catch { /* 已断 */ }
      }
    })
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => { server.off('error', reject); resolve() })
  })
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  log(`scripted engine listening on ${url} (${script.runs.length} scripted runs, ${script.sessions.length} sessions)`)

  let closing: Promise<void> | null = null
  return {
    url,
    close: () => {
      closing ??= new Promise<void>((resolve) => {
        closed = true
        for (const run of runs.values()) {
          if (run.timer) clearTimeout(run.timer)
          run.timer = null
          for (const s of run.subs) endSub(s)
          run.subs.clear()
        }
        for (const s of promptSubs) endSub(s)
        promptSubs.clear()
        server.close(() => resolve())
        server.closeAllConnections()
        log(`scripted engine on ${url} closed`)
      })
      return closing
    },
  }
}
