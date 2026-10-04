/**
 * M3 数据 API 薄封装(sessions/models/memory/skills/tools/workspace)。
 * 统一 Bearer + JSON 错误,错误信息抛 Error(detail)。
 */
import type {
  AgentConfig, AgentScheduleEntry, AgentScheduleEntryUpsert, AgentScheduleInfo, AgentsMeta, AutomationActionCatalogItem, AutomationExecutionInfo, AutomationRunInfo, AutomationSessionInfo, ChannelKind, HistorianActivityItem, MessageRecord, ModelsResponse, MuseLibraryEntry, MuseStatusInfo, MuseTodo, MuseTriggerInfo, MuseTriggerUpsert, PendingApprovalInfo,
  GitSettings, NormalAgentDef, ProjectContext, ProjectMemoryView, ProjectSettings, ProjectSkillInfo, SessionRecord, SkillInfo, SkillCatalogEntry, SpecialAgentsConfig,
  ToolsResponse, WorkspaceFileMeta, TeamDef } from '../types'
import { authFetch } from './http'
import { fetchOpts, type EngineTarget } from './engine/targets'
import { targetCaps, type TargetCaps } from './engine/targetCaps'
import { classify, noteReachable, noteVerdict } from './engine/health'
import './engine/messages'
import { AGENT_APP_ID, unitFailureMessage } from './agentRunService'
import { localInbox } from './localInbox' // 移动端(window.tangu?.mobile)下 inbox 走设备本地存储
import { registerMessages, translate } from '../i18n'
import { LOCAL_ONLY_CODE, localOnlyMessage, remoteRefusalMessage } from './localOnly'
import { saveResponseAs } from './nativeDownload'

registerMessages({
  'backendsvc.downloadFailed': { zh: '下载失败 ({status})', en: 'Download failed ({status})' },
})

/** P1-K6:基址与鉴权头都归目标(头与改造前的 `headers(cfg.token)` 同形同序)。S3 起所有服务函数只收解析层给的
 *  EngineTarget(homeTarget / targetForSession / focusTarget / connectionTarget),本文件不读 cfg(棘轮 R1 + 品牌类型钉住)。 */
async function request<T>(t: EngineTarget, path: string, init?: RequestInit, opts?: { timeoutMs?: number }): Promise<T> {
  // home 目标的第三参与改造前逐字一致(opts 原样,可能是 undefined);非 home 恒带 target(401 分流,K6 §3.5)。
  const r = await authFetch(`${t.base}${path}`, { ...init, headers: await t.headers(true) }, t.key === 'home' ? opts : fetchOpts(t, opts?.timeoutMs))
  if (!r.ok) {
    let detail = `HTTP ${r.status}`
    let code: string | undefined
    let info: string | undefined
    let j: any = null
    try {
      j = await r.json()
      detail = j?.detail || detail
      if (typeof j?.error === 'string') code = j.error // 机器可读错误码(如 claim_requirements_unmet),调用方据此本地化
      // 设备页打到远端不许用的路由(unitWeb 403 LOCAL_ONLY)、或引擎拒了远端请求(400 REMOTE_CWD_FORBIDDEN /
      // REMOTE_ARGS_OVERRIDE_FORBIDDEN)→ 换成本地化提示,而不是把英文 detail 原样上屏(见 services/localOnly.ts)
      const refusal = remoteRefusalMessage(j?.code, j) // P1-KF:REMOTE_CALLER_UNCONFIRMED 按 reason / state 分句
      if (refusal) { detail = refusal; code = j.code }
      if (typeof j?.info === 'string') info = j.info // 与错误码配套的原文(如 git 的 stderr),调用方按需展示
    } catch { /* keep */ }
    // P1-K6 S2:经 hub 打「我的电脑」的失败(离线 / 引擎没起 / 设备被移除 / 调用方身份 / 413)→ 人话 + 记健康表
    if (t.via === 'unit') {
      const hubCode = typeof j?.code === 'string' ? j.code : undefined
      const v = classify(r.status, j)
      // 执行设备的拒绝码(K4 REMOTE_SESSIONS_OFF / REMOTE_CALLER_UNCONFIRMED 只拒 session 层;K2 REMOTE_LOCKED 只拒非 GET)
      // 是**这一条请求**的事,读照常放行(K4 文案本身就说「可以查看、回答审批和停止任务」)—— 与 local-only / 413 同理
      // 不写健康表;写成整台 refused 会让轮询停摆、提示条卡住,那台点了「允许」/ 解锁之后也没人把它清掉。
      if (v !== 'refused') noteVerdict(t.key, v, hubCode ? { code: hubCode } : {})
      const msg = unitFailureMessage(t, v, hubCode, j)
      if (msg && v !== 'fatal' && v !== 'local-only') { detail = msg; if (hubCode) code = hubCode }
    }
    throw Object.assign(new Error(detail), { status: r.status }, code ? { code } : {}, info ? { info } : {})
  }
  if (t.via === 'unit') noteReachable(t.key) // 2xx:这台此刻是通的(离线类不必干等探针,见 health.noteReachable)
  return r.json() as Promise<T>
}

/** 头像 / 项目图标这类 blob 的 GET。home 与改造前逐字一致(两参);非 home 带目标键,让 401 拦截器知道是哪台拒的
 *  (§3.5 的 401 单一路径 —— 漏了第三参,unit 的 401 会被当成 home 的走本机过期流程)。 */
async function blobFetch(t: EngineTarget, url: string): Promise<Response> {
  const init = { headers: await t.headers(true) }
  const o = fetchOpts(t)
  return o ? authFetch(url, init, o) : authFetch(url, init)
}

// ── P1-K6:会话类(§3.3)由调用方传会话所在的目标(targetForSession(sid),S3 codemod 改好的调用点)──
/** 会话类里远端 deny-remote 的五个(硬删 / 回退 / 检查点恢复 / 整对象 PUT 配置 / 工作区删除):目标没有这项能力 →
 *  **不发请求**,直接给与 unitWeb 403 LOCAL_ONLY 同一句本地化提示(K6 §3.3「服务层预判」)。异步抛:调用方的 .catch 接得住。 */
async function requestCap<T>(t: EngineTarget, cap: keyof TargetCaps, path: string, init?: RequestInit): Promise<T> {
  if (!targetCaps(t)[cap]) throw Object.assign(new Error(localOnlyMessage()), { status: 403, code: LOCAL_ONLY_CODE })
  return request<T>(t, path, init)
}

// ── 记忆同步(本地 ↔ Forsion Brain)──
export interface SyncRunResult {
  ok: boolean
  /** 镜像的 agent 数(cloudSync 开的)+ 文件级推/拉/删/跳过计数(每-agent 云文件镜像)。 */
  agents?: number
  pushed?: number
  pulled?: number
  deleted?: number
  skipped?: number
  /** 旧全局 xyra 记忆/日志(AI Studio 网页共享)。 */
  memory: 'pushed' | 'pulled' | 'in-sync' | 'skipped'
  logs: Array<{ date: string; pushed: number; pulled: number }>
  error?: string
}
export interface SyncStatusResult {
  available: boolean
  running: boolean
  lastAt: number | null
  lastResult: SyncRunResult | null
}
/** 触发一次「立即同步」(后端在本地 store ↔ 云端 Brain 间推/拉)。 */
export const syncNow = (t: EngineTarget) =>
  request<SyncRunResult>(t, '/agent/sync', { method: 'POST' })
export const getSyncStatus = (t: EngineTarget) =>
  request<SyncStatusResult>(t, '/agent/sync/status')

// ── 百炼音色管理(声音复刻/声音设计;后端代理免 CORS,key 只在请求中过境)──
export type TtsVoiceKind = 'clone' | 'design' | 'cosy' // clone=qwen复刻 design=qwen设计 cosy=voice-enrollment 复刻(CosyVoice / Qwen-Audio-TTS)
export interface TtsVoiceInfo { voice: string; kind: TtsVoiceKind; targetModel?: string }
export const listTtsVoices = (t: EngineTarget, body: { baseUrl: string; apiKey: string }) =>
  request<{ voices: TtsVoiceInfo[] }>(t, '/agent/tts/voices/list', { method: 'POST', body: JSON.stringify(body) }).then((r) => r.voices)
// 复刻:targetModel 决定走哪个复刻服务(引擎 routes/tts.ts cloneService);audioData=data URI,本地录音各家都收。engine 是旧写法,新代码不用传。
// text / language:样本是照着文案念的时候带上(只对 qwen-voice-enrollment 那一类有用);对不上时百炼退回不用文案的方式,回 fallbackReason。
export const cloneTtsVoice = (t: EngineTarget, body: { baseUrl: string; apiKey: string; name: string; engine?: 'qwen' | 'cosy'; audioData?: string; audioUrl?: string; targetModel?: string; text?: string; language?: string }) =>
  request<{ voice: string; targetModel: string; fallbackReason?: string }>(t, '/agent/tts/voices/clone', { method: 'POST', body: JSON.stringify(body) })
export const designTtsVoice = (t: EngineTarget, body: { baseUrl: string; apiKey: string; name: string; voicePrompt: string; previewText?: string; targetModel?: string }) =>
  request<{ voice: string; targetModel: string; previewAudio?: { data: string; sampleRate: number; format: string } }>(t, '/agent/tts/voices/design', { method: 'POST', body: JSON.stringify(body) })
export const deleteTtsVoice = (t: EngineTarget, body: { baseUrl: string; apiKey: string; voice: string; kind: TtsVoiceKind }) =>
  request<{ ok: boolean }>(t, '/agent/tts/voices/delete', { method: 'POST', body: JSON.stringify(body) })
/** 实时语音通话的 WebSocket 地址(引擎 ws /agent/realtime;浏览器 WebSocket 设不了头,本机 token 只能走 query)。 */
export async function realtimeSocketUrl(t: EngineTarget): Promise<string> {
  const auth = (await t.headers()).Authorization || ''
  return `${t.base.replace(/^http/, 'ws')}/agent/realtime?token=${encodeURIComponent(auth.replace(/^Bearer\s+/i, ''))}`
}

/** 语音合成(POST /agent/tts → 音频字节;home 类:朗读 / 语音条 / 设置页试听)。以前 ttsService 自拼 URL(K6 §3.3「直连三处」之一),
 *  现在基址与鉴权头归目标。非 2xx 抛引擎的 detail(与改造前同一句)。 */
export async function synthesizeTts(
  t: EngineTarget,
  body: { text: string; model: string; voice?: string; speed?: number },
  signal?: AbortSignal,
): Promise<Blob> {
  const init: RequestInit = { method: 'POST', headers: await t.headers(true), ...(signal ? { signal } : {}), body: JSON.stringify(body) }
  const o = fetchOpts(t)
  const r = await (o ? authFetch(`${t.base}/agent/tts`, init, o) : authFetch(`${t.base}/agent/tts`, init))
  if (!r.ok) {
    let detail = `HTTP ${r.status}`
    try { detail = (await r.json())?.detail || detail } catch { /* keep */ }
    throw new Error(detail)
  }
  return r.blob()
}

// ── 会话 ──
// list/create 与 run 同源显式带 app_id:此前不带,云端落 worker 基线(ai-studio)→ 会话归属
// 与 run/用量(tangu)分叉。存量误标行由引擎 runMigration 按 run 证据归位(db/migrate.ts)。
export const listSessions = (t: EngineTarget, archived = false) =>
  request<{ sessions: SessionRecord[] }>(t, `/agent/sessions?archived=${archived}&app_id=${encodeURIComponent(AGENT_APP_ID)}`).then((r) => r.sessions)

export const createSession = (
  t: EngineTarget,
  init?: { title?: string; model_id?: string; emoji?: string; project_path?: string; project_name?: string; projectless?: boolean; agent_config?: AgentConfig },
) =>
  request<{ session: SessionRecord }>(t, '/agent/sessions', {
    method: 'POST',
    body: JSON.stringify({ app_id: AGENT_APP_ID, ...(init || {}) }),
  }).then((r) => r.session)

/** 私聊(Agent 轨道):该 Agent / 外部引擎的活动私聊会话,没有就建(引擎侧单点,多窗口同击只得一条)。host-only:云端 404。 */
export const soloOpen = (t: EngineTarget, kind: 'agent' | 'engine', id: string) =>
  request<{ session: SessionRecord; created: boolean }>(t, `/agent/solo/${kind}/${encodeURIComponent(id)}/open`, { method: 'POST', body: '{}' })

/** 独立团队(host-only,云端 [] / 404)。 */
export const listTeams = (t: EngineTarget) =>
  // 老引擎 / 桩引擎对未知路由可能回 200 空对象:形状不对一律当空表,别让 undefined 流进 store(OrbitsView .map 会炸掉整块侧栏)。
  request<{ teams: TeamDef[] }>(t, '/agent/teams').then((r) => (Array.isArray(r?.teams) ? r.teams : [])).catch(() => [] as TeamDef[])
export const getTeam = (t: EngineTarget, slug: string) =>
  request<{ team: TeamDef }>(t, `/agent/teams/${encodeURIComponent(slug)}`).then((r) => {
    if (!r.team || !Array.isArray(r.team.members)) throw new Error('Team unavailable')
    return r.team
  })
/** name 可省:引擎按成员名生成缺省(有 project 再 `@ 项目`)。 */
export const createTeam = (t: EngineTarget, input: { name?: string; project?: string; members: Array<{ slug: string; role?: string }>; lead?: string; avatar?: string; doc?: string; description?: string }) =>
  request<{ team: TeamDef }>(t, '/agent/teams', { method: 'POST', body: JSON.stringify(input) }).then((r) => r.team)
export const patchTeam = (t: EngineTarget, slug: string, patch: Partial<{ name: string; members: Array<{ slug: string; role?: string }>; lead: string; avatar: string; doc: string; description: string }>) =>
  request<{ team: TeamDef }>(t, `/agent/teams/${encodeURIComponent(slug)}`, { method: 'PATCH', body: JSON.stringify(patch) }).then((r) => r.team)
export const deleteTeam = (t: EngineTarget, slug: string) =>
  request<{ ok: boolean }>(t, `/agent/teams/${encodeURIComponent(slug)}`, { method: 'DELETE' })
export const uploadTeamAvatar = (t: EngineTarget, slug: string, data: string, mimeType: string) =>
  request<{ ok: boolean; avatar: string }>(t, `/agent/teams/${encodeURIComponent(slug)}/avatar`, { method: 'POST', body: JSON.stringify({ data, mimeType }) })
export const deleteTeamAvatar = (t: EngineTarget, slug: string) =>
  request<{ ok: boolean }>(t, `/agent/teams/${encodeURIComponent(slug)}/avatar`, { method: 'DELETE' })
export async function fetchTeamAvatar(t: EngineTarget, slug: string): Promise<string | null> {
  try {
    const response = await blobFetch(t, `${t.base}/agent/teams/${encodeURIComponent(slug)}/avatar`)
    if (!response.ok) return null
    return URL.createObjectURL(await response.blob())
  } catch { return null }
}
/** 该团队的活动会话,没有就建(引擎侧单点)。 */
export const teamSessionOpen = (t: EngineTarget, slug: string) =>
  request<{ session: SessionRecord; created: boolean }>(t, `/agent/teams/${encodeURIComponent(slug)}/session/open`, { method: 'POST', body: '{}' })

/** 私聊「新会话(先总结记忆)」:旧会话有活动 run → 409 run_active;memory:queued=后台采候选中 / skipped=Historian 没起来 / none=引擎或无旧会话。 */
export const soloRotate = (t: EngineTarget, kind: 'agent' | 'engine', id: string) =>
  request<{ session: SessionRecord; memory: 'queued' | 'skipped' | 'none' }>(t, `/agent/solo/${kind}/${encodeURIComponent(id)}/rotate`, { method: 'POST', body: '{}' })

export const updateSession = (
  t: EngineTarget,
  id: string,
  patch: {
    title?: string; archived?: boolean; model_id?: string; emoji?: string | null
    project_path?: string | null; project_name?: string | null; projectless?: boolean
  },
) =>
  request<{ session: SessionRecord }>(t, `/agent/sessions/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    body: JSON.stringify(patch),
  }).then((r) => r.session)

export const deleteSession = (t: EngineTarget, id: string) =>
  requestCap<{ ok: boolean }>(t, 'hardDeleteSession', `/agent/sessions/${encodeURIComponent(id)}`, { method: 'DELETE' })

/** 从某条消息(含)处分支出新会话:继承到该点为止的历史(区别于空的新会话)。返回新会话。 */
export const branchSession = (t: EngineTarget, sessionId: string, messageId: string, title?: string) =>
  request<{ session: SessionRecord; copied: number }>(
    t, `/agent/sessions/${encodeURIComponent(sessionId)}/branch`,
    { method: 'POST', body: JSON.stringify({ message_id: messageId, ...(title ? { title } : {}) }) },
  ).then((r) => r.session)

/** 某会话名下的 Background Session(@讨论 / Historian 辅助讨论等隐藏子会话,含最新 run 供回放)。 */
export interface BackgroundSessionInfo {
  sessionId: string
  kind: string
  title: string | null
  createdAt: string
  runId: string | null
  runStatus: string | null
  /** 团队成员的工作会话(kind=teamwork):归属的成员 slug;老引擎 / 其他 kind 没有。 */
  agentSlug?: string | null
}

export const getSessionDetail = (t: EngineTarget, sessionId: string) =>
  request<{ session: SessionRecord & { delegate_running?: boolean } }>(t, `/agent/sessions/${encodeURIComponent(sessionId)}/detail`).then((r) => r.session)
export const openTeamMemberSession = (t: EngineTarget, parentId: string, slug: string) =>
  request<{ session: SessionRecord }>(t, `/agent/sessions/${encodeURIComponent(parentId)}/team-members/${encodeURIComponent(slug)}`, { method: 'POST' }).then((r) => r.session)
export const getBackgroundSessions = (t: EngineTarget, sessionId: string, kind?: string) =>
  request<{ background: BackgroundSessionInfo[] }>(
    t, `/agent/sessions/${encodeURIComponent(sessionId)}/background${kind ? `?kind=${encodeURIComponent(kind)}` : ''}`,
  ).then((r) => r.background)

export const listMessages = (t: EngineTarget, sessionId: string, limit = 200, before?: number) =>
  request<{ messages: MessageRecord[] }>(
    t, `/agent/sessions/${encodeURIComponent(sessionId)}/messages?limit=${limit}${before ? `&before=${before}` : ''}`,
  ).then((r) => r.messages)

/** 按精确 id 列表删除会话内消息(编辑重发 / 重新生成前截断该点及之后的消息)。 */
export const deleteMessages = (t: EngineTarget, sessionId: string, ids: string[]) =>
  requestCap<{ ok: boolean; deleted: number }>(
    t, 'rewind', `/agent/sessions/${encodeURIComponent(sessionId)}/messages/delete`,
    { method: 'POST', body: JSON.stringify({ ids }) },
  )

/** 会话内容级检索的一条命中(P3):与模型侧 search_sessions 共用引擎里的同一条 SQL。 */
export interface SessionSearchHit {
  id: string
  title: string
  summary: string
  archived: boolean
  /** YYYY-MM-DD(引擎已按方言归一)。 */
  updatedAt: string
  /** 正文命中时带:可据 messageId 跳到那条消息。标题/摘要命中的行没有。 */
  hit?: { messageId: string; role: string; timestamp: number; snippet: string }
}
/** q 为空 = 最近会话列表(空壳会话不进榜);`"带空格短语"` 算一个词。
 *  客户端先截 500 字:粘一大段进搜索框会撑爆 URL,Node 在 handler 之前就 431(引擎侧另有词长闸)。
 *  ⚠️ 按**码点**截(`[...q]`):`String.slice` 会把代理对劈开,`encodeURIComponent` 当场抛,
 *  而这一抛发生在去抖定时器里、catch 还没挂上 → 搜索永远停在「正在搜索内容…」。 */
export const searchSessions = (t: EngineTarget, q: string, opts?: { limit?: number; signal?: AbortSignal }) =>
  request<{ hits: SessionSearchHit[] }>(
    t,
    // ⚠️`app_id` 必带(codex 2026-08-17 P2):路由 `resolveProfile(req.query.app_id)` 缺省会回落到
    // **基线 application**。云端/多 profile 后端的默认 profile 不是 `tangu` 时,搜的就成了别的应用的
    // 会话 —— 列表/新建(见上面 listSessions/createSession)一直都在传,只有搜索漏了。
    `/agent/sessions/search?q=${encodeURIComponent([...q].slice(0, 500).join(''))}&limit=${opts?.limit ?? 20}`
      + `&app_id=${encodeURIComponent(AGENT_APP_ID)}`,
    opts?.signal ? { signal: opts.signal } : {},
  ).then((r) => r.hits || [])

/** 代码检查点(写工具落盘前的 pre-image;时间轴按 at 比,files 为绝对路径)。 */
export interface CheckpointInfo {
  runId: string
  at: number
  files: string[]
  /** 快照过大未存字节 → 恢复不了,UI 需如实提示。 */
  skipped: string[]
}
export const listCheckpoints = (t: EngineTarget, sessionId: string) =>
  request<{ checkpoints: CheckpointInfo[] }>(
    t, `/agent/sessions/${encodeURIComponent(sessionId)}/checkpoints`,
  ).then((r) => r.checkpoints || [])

/** 把代码恢复到 `at` 时刻(该时刻之后所有写工具改动按最早 pre-image 回滚)。 */
export const restoreCheckpoint = (t: EngineTarget, sessionId: string, at: number) =>
  requestCap<{ restored: string[]; deleted: string[]; skipped: string[]; conflicts?: string[]; failed: Array<{ path: string; error: string }> }>(
    t, 'checkpointRestore', `/agent/sessions/${encodeURIComponent(sessionId)}/checkpoints/restore`,
    { method: 'POST', body: JSON.stringify({ at }) },
  )

export const getSessionConfig = (t: EngineTarget, sessionId: string) =>
  request<{ agent_config: AgentConfig }>(
    t, `/agent/sessions/${encodeURIComponent(sessionId)}/config`,
  ).then((r) => r.agent_config || {})

export const putSessionConfig = (t: EngineTarget, sessionId: string, config: AgentConfig) =>
  requestCap<{ agent_config: AgentConfig }>(t, 'putSessionConfig', `/agent/sessions/${encodeURIComponent(sessionId)}/config`, {
    method: 'PUT',
    body: JSON.stringify(config),
  }).then((r) => r.agent_config)

/** 按键合并写会话配置:只带要改的键(undefined 上线为 null = 删这个键),服务端并进存值。整对象 PUT 会把本地缓存里
 *  别的键的旧值一起写回去(另一窗口的陈旧缓存、同窗口先发后到的请求)—— 审批档是引擎审批时现读的存值,被盖回去 = 悄悄放宽。
 *  老引擎没有这个路由(404/405)→ 回落整对象 PUT,full() 给本地最新的整对象(旧行为)。会话不存在时 PUT 照样 404,不碍事。 */
export const patchSessionConfig = (t: EngineTarget, sessionId: string, patch: Partial<AgentConfig>, full: () => AgentConfig) => {
  return request<{ agent_config: AgentConfig }>(t, `/agent/sessions/${encodeURIComponent(sessionId)}/config`, {
    method: 'PATCH',
    body: JSON.stringify(Object.fromEntries(Object.entries(patch).map(([k, v]) => [k, v === undefined ? null : v]))),
  }).then((r) => r.agent_config, (e) => {
    if (e?.status !== 404 && e?.status !== 405) throw e
    // 远端目标没有整对象 PUT(deny-remote):回落不了就把 PATCH 的错原样交出去,别换成一句误导的「只能在本机」
    if (!targetCaps(t).putSessionConfig) throw e
    return putSessionConfig(t, sessionId, full())
  })
}

// ── custom 审批档规则(H2:此前只能手写 ~/.tangu/config.json)。规则是**全局**的(跨会话),
//    档位才是按会话;引擎每次工具调用现读 config.json → 保存后下一次调用即生效。
export interface ApprovalRules {
  base: 'readonly' | 'auto-edit' | 'full-auto'
  allow: string[]
  ask: string[]
  deny: string[]
}
export const getApprovalRules = (t: EngineTarget) =>
  request<ApprovalRules>(t, '/agent/approval-rules')
export const putApprovalRules = (t: EngineTarget, rules: Partial<ApprovalRules>) =>
  request<{ ok: boolean; rules: ApprovalRules }>(t, '/agent/approval-rules', {
    method: 'PUT',
    body: JSON.stringify(rules),
  }).then((r) => r.rules)

/** 本会话累计 token 消耗(跨 run 求和)+ 最近一次的上下文占用(重载会话后恢复上下文圈用)。 */
export const getSessionUsage = (t: EngineTarget, sessionId: string) =>
  request<{ tokensTotal: number; contextTokens?: number }>(t, `/agent/sessions/${encodeURIComponent(sessionId)}/usage`)
    .then((r) => ({ base: Number(r.tokensTotal) || 0, ctx: Number(r.contextTokens) || 0 }))

/** 会话事件时间线骨架(无正文;流式帧折叠成段):导出日志携带,tangu-agent 的 scripts/stall-timeline.mjs 据此归属秒数。 */
export const getSessionTimeline = (t: EngineTarget, sessionId: string) =>
  request<{ runs: any[] }>(t, `/agent/sessions/${encodeURIComponent(sessionId)}/timeline`).then((r) => r.runs || [])

/** 手动压缩上下文(生成并持久化总结检查点;后续 run 起步即精简)。 */
export const compactSession = (t: EngineTarget, sessionId: string, modelId?: string, instructions?: string) =>
  request<{ ok: boolean; reason?: string; summarizedCount?: number; contextTokens?: number }>(
    t, `/agent/sessions/${encodeURIComponent(sessionId)}/compact`,
    { method: 'POST', body: JSON.stringify({ ...(modelId ? { model_id: modelId } : {}), ...(instructions ? { instructions } : {}) }) },
  )

// ── 模型 / 技能 / 工具 ──
// 带 app_id:云端 worker 服务多 app,不带就按 worker 基线(ai-studio)解析「应用模型配置」→
// 列表/默认模型与 run 的记账 app 对不上(见 tangu-agent routes/models.ts)。
export const listModels = (t: EngineTarget) =>
  request<ModelsResponse>(t, `/agent/models?app_id=${encodeURIComponent(AGENT_APP_ID)}`)

/** 本机 per-model 覆盖:上下文窗口(tokens;null = 清除,交还自动识别)。落引擎 config.json 的 modelOverrides 段,对下一条消息生效。 */
export const setModelContextWindow = (t: EngineTarget, modelId: string, contextWindow: number | null) =>
  request<{ overrides: Record<string, { contextWindow?: number }> }>(t, '/agent/models/overrides', {
    method: 'PUT',
    body: JSON.stringify({ modelId, contextWindow }),
  })

/** 全局压缩旋钮(引擎 config.json 的 compaction 段)。settings 只含已设字段;writable=false(云端 worker)时设置页不露。 */
export const getCompactionSettings = (t: EngineTarget) =>
  request<{ settings: { thresholdPercent?: number }; defaults: { thresholdPercent: number }; writable: boolean }>(t, '/agent/compaction')
/** thresholdPercent:上下文占到窗口的 X% 就自动压缩(10–95;null = 交还缺省)。对下一条消息生效。 */
export const setCompactionSettings = (t: EngineTarget, patch: { thresholdPercent: number | null }) =>
  request<{ settings: { thresholdPercent?: number } }>(t, '/agent/compaction', { method: 'PUT', body: JSON.stringify(patch) })

/** host 端外部 agent 引擎清单(含 available 检测 + 每引擎默认模型;云端/非 host → 抛或空 → 调用方回退 [])。 */
export const listEngines = (t: EngineTarget) =>
  request<{ engines: Array<{ id: string; name: string; available?: boolean; status?: 'available' | 'needs-signin' | 'not-installed'; defaultModel?: string; setup?: string }> }>(t, '/agent/engines').then((r) => r.engines || [])

/** 设某引擎默认模型(设置页「Agent CLIs」;空串=清除)。 */
export const setEngineDefaultModel = (t: EngineTarget, engineId: string, defaultModel: string) =>
  request<{ ok: boolean }>(t, `/agent/engines/${encodeURIComponent(engineId)}`, {
    method: 'PUT',
    body: JSON.stringify({ defaultModel }),
  })

export interface EngineAssets {
  skills: Array<{ name: string; description: string; imported: boolean }>
  mcp: Array<{ name: string; command?: string; args?: string[]; url?: string; imported: boolean }>
}

/** 列出某引擎已装的 skills + mcp(设置页「Agent CLIs」二级面板)。云端/失败 → 空。 */
export const listEngineAssets = (t: EngineTarget, engineId: string) =>
  request<EngineAssets>(t, `/agent/engines/${encodeURIComponent(engineId)}/assets`)
    .then((r) => ({ skills: r.skills || [], mcp: r.mcp || [] }))
    .catch(() => ({ skills: [], mcp: [] } as EngineAssets))

/** 导入一个引擎资产到 Tangu(kind: 'skill' | 'mcp')。 */
export const importEngineAsset = (t: EngineTarget, engineId: string, kind: 'skill' | 'mcp', name: string) =>
  request<{ ok: boolean }>(t, `/agent/engines/${encodeURIComponent(engineId)}/import`, {
    method: 'POST',
    body: JSON.stringify({ kind, name }),
  })

/** 懒探测某引擎能力(模型 + slash 命令);首次会 spawn(慢),后端缓存。失败 → 空。 */
export const getEngineCapabilities = (t: EngineTarget, engineId: string) =>
  request<{
    models?: Array<{ id: string; name: string; description?: string }>
    currentModelId?: string
    commands?: Array<{ name: string; description: string; hint?: string }>
  }>(t, `/agent/engines/${encodeURIComponent(engineId)}/capabilities`, undefined, { timeoutMs: 45000 })
    .then((r) => ({ models: r.models || [], currentModelId: r.currentModelId, commands: r.commands || [] }))
    .catch(() => ({
      models: [] as Array<{ id: string; name: string; description?: string }>,
      currentModelId: undefined as string | undefined,
      commands: [] as Array<{ name: string; description: string; hint?: string }>,
    }))

/** 本地联网搜索(BYO-key)配置:engine /agent/websearch(写 config.json webSearch 段;云端 404)。 */
export interface LocalWebSearchRedacted {
  provider: string
  bochaHasKey: boolean
  tavilyHasKey: boolean
  zhipuHasKey: boolean
  zhipuEngine: string
  effectiveProvider: string
  configured: boolean
}

export const getLocalWebSearch = (t: EngineTarget) =>
  request<LocalWebSearchRedacted>(t, '/agent/websearch')

export const saveLocalWebSearch = (
  t: EngineTarget,
  body: { provider: string; bochaApiKey: string; tavilyApiKey: string; zhipuApiKey: string; zhipuEngine: string },
) =>
  request<{ success: boolean; config: LocalWebSearchRedacted }>(t, '/agent/websearch', {
    method: 'PUT',
    body: JSON.stringify(body),
  })

export const testLocalWebSearch = (
  t: EngineTarget,
  body: { provider: string; apiKey?: string; zhipuEngine?: string },
  signal?: AbortSignal,
) =>
  request<{ ok: boolean; provider: string; latencyMs: number; resultCount?: number; sampleTitle?: string; error?: string }>(
    t, '/agent/websearch/test',
    { method: 'POST', body: JSON.stringify(body), signal },
    { timeoutMs: 30000 },
  )

/** 探测一个 OpenAI 兼容端点(后端代理,避免 CORS):GET /models → 1-token chat。 */
export const testProviderConnection = (
  t: EngineTarget,
  probe: { baseUrl: string; apiKey?: string; modelId?: string },
  signal?: AbortSignal,
) =>
  request<{ success: boolean; message: string }>(t, '/agent/providers/test', {
    method: 'POST',
    body: JSON.stringify(probe),
    signal,
  }, { timeoutMs: 30000 })

/** 后端代拉上游 GET {baseUrl}/models(避 CORS),返回可选模型名列表;软失败回 []。 */
export const fetchProviderModels = (
  t: EngineTarget,
  probe: { baseUrl: string; apiKey?: string },
  signal?: AbortSignal,
) =>
  request<{ models: Array<{ id: string; name?: string }> }>(t, '/agent/providers/fetch-models', {
    method: 'POST',
    body: JSON.stringify(probe),
    signal,
  }, { timeoutMs: 30000 }).then((r) => r.models)

export const listSkills = (t: EngineTarget, agentSlug?: string) =>
  request<{ skills: SkillInfo[] }>(t, `/agent/skills${agentSlug ? `?agentSlug=${encodeURIComponent(agentSlug)}` : ''}`).then((r) => r.skills)

/** Host skill catalog: every physical user/agent copy, including shadowed versions. */
export const listSkillCatalog = (t: EngineTarget, agentSlug?: string) =>
  request<{ skills: SkillCatalogEntry[] }>(t, `/agent/skills/catalog${agentSlug ? `?agentSlug=${encodeURIComponent(agentSlug)}` : ''}`).then((r) => r.skills)

export const getSkillCatalogEntry = (t: EngineTarget, key: string, agentSlug?: string) =>
  request<{ skill: SkillCatalogEntry }>(t, `/agent/skills/catalog/${encodeURIComponent(key)}${agentSlug ? `?agentSlug=${encodeURIComponent(agentSlug)}` : ''}`).then((r) => r.skill)

export const createSkillCatalogEntry = (t: EngineTarget, body: { scope: 'user' | 'agent'; agentSlug?: string; slug: string; name: string; description?: string; content: string }) =>
  request<{ skill: SkillCatalogEntry }>(t, '/agent/skills/catalog', { method: 'POST', body: JSON.stringify(body) }).then((r) => r.skill)

export const updateSkillCatalogEntry = (t: EngineTarget, key: string, body: { name?: string; description?: string; content?: string; agentSlug?: string }) =>
  request<{ skill: SkillCatalogEntry }>(t, `/agent/skills/catalog/${encodeURIComponent(key)}`, { method: 'PATCH', body: JSON.stringify(body) }).then((r) => r.skill)

export const setSkillCatalogEntryDisabled = (t: EngineTarget, key: string, disabled: boolean, agentSlug?: string) =>
  request<{ ok: boolean }>(t, `/agent/skills/catalog/${encodeURIComponent(key)}/disabled`, { method: 'PUT', body: JSON.stringify({ disabled, ...(agentSlug ? { agentSlug } : {}) }) })

export const deleteSkillCatalogEntry = (t: EngineTarget, key: string, agentSlug?: string) =>
  request<{ ok: boolean; backupPath?: string }>(t, `/agent/skills/catalog/${encodeURIComponent(key)}${agentSlug ? `?agentSlug=${encodeURIComponent(agentSlug)}` : ''}`, { method: 'DELETE' })

export const copySkillCatalogEntry = (t: EngineTarget, key: string, body: { scope: 'user' | 'agent'; agentSlug?: string; slug?: string }, sourceAgentSlug?: string) =>
  request<{ skill: SkillCatalogEntry }>(t, `/agent/skills/catalog/${encodeURIComponent(key)}/copy${sourceAgentSlug ? `?agentSlug=${encodeURIComponent(sourceAgentSlug)}` : ''}`, { method: 'POST', body: JSON.stringify(body) }).then((r) => r.skill)

/** Copy a user-selected folder into the host library. The source path must be local to the host. */
export const importSkillCatalogEntry = (t: EngineTarget, body: { scope: 'user' | 'agent'; agentSlug?: string; sourcePath: string; slug?: string }) =>
  request<{ skill: SkillCatalogEntry }>(t, '/agent/skills/catalog/import', { method: 'POST', body: JSON.stringify(body) }).then((r) => r.skill)

/** 本地技能上云(owner=当前用户,云端 Tangu 会话即可启用)。 */
export const uploadSkillToCloud = (t: EngineTarget, localId: string) =>
  request<{ id: string; name: string }>(t, '/agent/skills/upload', {
    method: 'POST',
    body: JSON.stringify({ localId }),
  })

/** 删除本人上传的云端技能。 */
export const deleteUserCloudSkill = (t: EngineTarget, id: string) =>
  request<{ ok: boolean }>(t, `/agent/skills/user/${encodeURIComponent(id)}`, { method: 'DELETE' })

// 服务端 assets.ts 只认 camelCase appId(与 sessions 的 app_id 不同拼法,历史造成)。
export const listTools = (t: EngineTarget) =>
  request<ToolsResponse>(t, `/agent/tools?appId=${encodeURIComponent(AGENT_APP_ID)}`)

// ── WeChat Remote（本地后端）──
export interface WechatStatusResponse {
  enabled: boolean
  runtime: Array<{ accountId: string; running: boolean; peers: number }>
  bindings: Array<{
    id: string
    account_id: string
    peer_id: string | null
    session_id: string
    remote_approval_mode: string
    is_active: boolean
    status: string
    wx_user_id: string | null
    session_title: string | null
  }>
}

export const startWechatLogin = (
  t: EngineTarget,
  input: { session_id?: string; model_id?: string; approval_mode?: string },
) =>
  request<{ loginId: string; qrcode: string; qrcodeImg: string; expiresAt: number }>(t, '/agent/wechat/login/start', {
    method: 'POST',
    body: JSON.stringify(input),
  })

export const pollWechatLogin = (t: EngineTarget, loginId: string) =>
  request<{ status: string; accountId?: string; sessionId?: string; detail?: string }>(
    t,
    `/agent/wechat/login/status?loginId=${encodeURIComponent(loginId)}`,
  )

export const getWechatStatus = (t: EngineTarget) =>
  request<WechatStatusResponse>(t, '/agent/wechat/status')

export const disconnectWechat = (t: EngineTarget, accountId: string) =>
  request<{ ok: boolean }>(t, '/agent/wechat/disconnect', {
    method: 'POST',
    body: JSON.stringify({ account_id: accountId }),
  })

/** 「微信远程」Project 下的会话(connected=正在连接的那个)。 */
export interface WechatProjectSession {
  id: string
  title: string
  updated_at: string | number | null
  connected: boolean
  agentSlug?: string | null
}

/** 列出微信 Project(~/Tangu/webot)下的会话,供主界面选择「正在连接的 session」。 */
export const listWechatSessions = (t: EngineTarget) =>
  request<{ sessions: WechatProjectSession[] }>(t, '/agent/wechat/sessions').then((r) => r.sessions)

/** 切换「正在连接的 session」(微信 bot 收到的消息改走该会话)。 */
export const setWechatConnectedSession = (t: EngineTarget, sessionId: string) =>
  request<{ ok: boolean }>(t, '/agent/wechat/connect', { method: 'POST', body: JSON.stringify({ session_id: sessionId }) })

/** 设置某微信会话使用的 Normal Agent。 */
export const setWechatSessionAgent = (t: EngineTarget, sessionId: string, agentSlug: string) =>
  request<{ ok: boolean }>(t, '/agent/wechat/session-agent', { method: 'POST', body: JSON.stringify({ session_id: sessionId, agent_slug: agentSlug }) })

/** 在微信 Project 下新建会话并(默认)切为正在连接。 */
export const createWechatSession = (t: EngineTarget, title?: string) =>
  request<{ sessionId: string }>(t, '/agent/wechat/sessions/new', { method: 'POST', body: JSON.stringify({ title }) }).then((r) => r.sessionId)

// ── 多通道(Channels:微信/Telegram/QQ;本地后端)──
export type { ChannelKind } from '../types'

export interface ChannelStatus {
  kind: ChannelKind
  enabled: boolean
  sessions: boolean
  agentSlug: string
  modelId: string
  imageModelId: string
  ttsModelId: string
  ttsVoice: string
  approvalMode: string
  inboxForward: { enabled: boolean; senders: 'all' | string[] }
  credentials: { botTokenSet: boolean; appIdSet: boolean; appSecretSet: boolean; appId: string }
  runtime: Array<{ accountId: string; running: boolean; peers?: number; label?: string }>
  connectedSessionId: string | null
  /** 活跃绑定的账号 id(断开连接用;runtime[0] 未必是活跃绑定的账号)。 */
  accountId: string | null
  peerBound: boolean
  workspace: string
}

export interface ChannelConfigPatch {
  enabled?: boolean
  sessions?: boolean
  agentSlug?: string
  modelId?: string
  imageModelId?: string
  ttsModelId?: string
  ttsVoice?: string
  approvalMode?: string
  inboxForward?: { enabled: boolean; senders: 'all' | string[] }
  botToken?: string
  appId?: string
  appSecret?: string
}

/** Tangu for Chrome 扩展:桥的状态 + 连接码(连接码即配对凭据,只走带鉴权的本机引擎接口)。 */
export interface BrowserExtensionStatus {
  enabled: boolean; port: number; listening: boolean; error: string; connected: boolean
  clients: Array<{ version: string; connectedAt: number }>; extensionId: string; extensionDir: string; code: string
}
// 都带超时:引擎挂住不回时,轮询不叠请求、换码按钮不会永远置灰
export const getBrowserExtension = (t: EngineTarget) =>
  request<BrowserExtensionStatus>(t, '/agent/browser-extension', undefined, { timeoutMs: 5000 })
export const resetBrowserExtensionCode = (t: EngineTarget) =>
  request<BrowserExtensionStatus>(t, '/agent/browser-extension/reset-code', { method: 'POST', body: '{}' }, { timeoutMs: 10000 })

export const listChannels = (t: EngineTarget) =>
  request<{ available: boolean; channels: ChannelStatus[] }>(t, '/agent/channels')

export const saveChannelConfig = (t: EngineTarget, kind: ChannelKind, patch: ChannelConfigPatch) =>
  request<{ ok: boolean }>(t, `/agent/channels/${kind}/config`, { method: 'PUT', body: JSON.stringify(patch) })

export const connectChannel = (t: EngineTarget, kind: ChannelKind) =>
  request<{ ok: boolean; accountId: string; label: string; sessionId: string }>(t, `/agent/channels/${kind}/connect`, { method: 'POST', body: '{}' })

export const disconnectChannel = (t: EngineTarget, kind: ChannelKind, accountId?: string) =>
  request<{ ok: boolean }>(t, `/agent/channels/${kind}/disconnect`, { method: 'POST', body: JSON.stringify({ account_id: accountId }) })

export const newChannelSession = (t: EngineTarget, kind: ChannelKind, title?: string) =>
  request<{ sessionId: string }>(t, `/agent/channels/${kind}/sessions/new`, { method: 'POST', body: JSON.stringify({ title }) }).then((r) => r.sessionId)

/** 把某会话切为该通道「正在连接」的会话。 */
export const setChannelConnectedSession = (t: EngineTarget, kind: ChannelKind, sessionId: string) =>
  request<{ ok: boolean }>(t, `/agent/channels/${kind}/connect-session`, { method: 'POST', body: JSON.stringify({ session_id: sessionId }) })

// ── Normal Agent（本地自定义人格;仅本地后端可用,云端返回 404 → 调用方降级空列表）──
export const listAgents = (t: EngineTarget) =>
  request<{ agents: NormalAgentDef[] }>(t, '/agent/agents').then((r) => r.agents).catch(() => [] as NormalAgentDef[])

/** toolsMode/toolsList 传 null=显式清除(JSON 会剔掉 undefined 键=保留旧值)。 */
export const saveAgentDef = (t: EngineTarget, def: Omit<Partial<NormalAgentDef>, 'toolsMode' | 'toolsList' | 'enabledSkillIds' | 'enabledMcpServers'> & { enabledSkillIds?: string[] | null; enabledMcpServers?: string[] | null; toolsMode?: 'allow' | 'deny' | null; toolsList?: string[] | null }, slug?: string) =>
  request<{ agent: NormalAgentDef }>(
    t,
    slug ? `/agent/agents/${encodeURIComponent(slug)}` : '/agent/agents',
    { method: slug ? 'PATCH' : 'POST', body: JSON.stringify(def) },
  ).then((r) => r.agent)

/** keepFiles:只从名册移除,本机引擎把整个目录挪进 agents/.removed/ 并返回 keptAt(云端引擎忽略)。 */
export const deleteAgentDef = (t: EngineTarget, slug: string, opts?: { keepFiles?: boolean }) =>
  request<{ ok: boolean; keptAt?: string }>(t, `/agent/agents/${encodeURIComponent(slug)}${opts?.keepFiles ? '?keepFiles=1' : ''}`, { method: 'DELETE' })

/** 改 slug(= 文件夹名)。拒绝时 err.code = 引擎 agentRename.ts 的原因(builtin / exists / cloud_synced / plugin_seeded / busy …)。 */
export const renameAgentDef = (t: EngineTarget, slug: string, next: string) =>
  request<{ agent: NormalAgentDef; warnings: string[] }>(t, `/agent/agents/${encodeURIComponent(slug)}/rename`, { method: 'POST', body: JSON.stringify({ slug: next }) })

/** 工具目录:agent 编辑「工具黑白名单」的可勾选项(名单只约束这批无门禁内置工具)。 */
export const fetchToolCatalog = (t: EngineTarget) =>
  request<{ tools: { name: string; description: string }[] }>(t, '/agent/tool-catalog')
    .then((r) => r.tools).catch(() => [] as { name: string; description: string }[])

/** 上传头像(data URL 或纯 base64;≤1MB;后端写进该 agent 的 Library/ 并设 config.avatar)。 */
export const uploadAgentAvatar = (t: EngineTarget, slug: string, data: string, mimeType: string) =>
  request<{ ok: boolean; avatar: string }>(t, `/agent/agents/${encodeURIComponent(slug)}/avatar`,
    { method: 'POST', body: JSON.stringify({ data, mimeType }) })

/** 删除头像(移除文件并清空 config.avatar)。 */
export const deleteAgentAvatar = (t: EngineTarget, slug: string) =>
  request<{ ok: boolean }>(t, `/agent/agents/${encodeURIComponent(slug)}/avatar`, { method: 'DELETE' })

/** 拉头像为 object URL(带鉴权;无/失败返回 null)。调用方负责 URL.revokeObjectURL。 */
export async function fetchAgentAvatar(t: EngineTarget, slug: string): Promise<string | null> {
  try {
    const r = await blobFetch(t, `${t.base}/agent/agents/${encodeURIComponent(slug)}/avatar`)
    if (!r.ok) return null
    return URL.createObjectURL(await r.blob())
  } catch { return null }
}

/** 列表顺序 + 默认 agent。 */
export const getAgentsMeta = (t: EngineTarget) =>
  request<AgentsMeta>(t, '/agent/agents-meta').catch(() => ({ order: [], defaultSlug: 'xyra' } as AgentsMeta))
export const putAgentsMeta = (t: EngineTarget, patch: Partial<AgentsMeta>) =>
  request<AgentsMeta>(t, '/agent/agents-meta', { method: 'PUT', body: JSON.stringify(patch) })

// 某 agent 的 MEMORY / LOG(按 slug 读其文件夹)。读取失败必须显式呈现，禁止假空白后覆盖。
export interface AgentMemorySource { kind: string; sessionId?: string; messageId?: string; runId?: string }
export interface AgentMemoryEntry { id: string; content: string; source: AgentMemorySource; evidenceIds: string[]; createdAt: number; updatedAt: number }
export interface AgentMemorySnapshot {
  version: string; content: string; entries: AgentMemoryEntry[]; updatedAt: number
  tombstones: Array<{ id: string; forgottenAt: number }>
}
export interface AgentMemoryRevision { version: string; createdAt: number; source: AgentMemorySource; content: string }
export interface AgentMemoryDreamConfig { enabled: boolean; modelId: string; timeoutMs: number; maxOutputTokens: number; intervalHours: number }
export interface AgentMemoryDreamStatus {
  state: 'idle' | 'running' | 'cancelling' | 'completed' | 'skipped' | 'failed' | 'cancelled'
  running: boolean; detail?: string; startedAt?: string; finishedAt?: string; calls?: number
}
export interface AgentMemoryDream { config: AgentMemoryDreamConfig; status: AgentMemoryDreamStatus; candidates: number }
const agentMemoryPath = (slug: string) => `/agent/agents/${encodeURIComponent(slug)}/memory`
export const getAgentMemorySnapshot = (t: EngineTarget, slug: string) => request<AgentMemorySnapshot>(t, agentMemoryPath(slug))
export const getAgentMemory = (t: EngineTarget, slug: string) =>
  getAgentMemorySnapshot(t, slug).then((r) => r.content)
export const putAgentMemory = (t: EngineTarget, slug: string, content: string, expectedVersion: string) =>
  request<AgentMemorySnapshot>(t, agentMemoryPath(slug), { method: 'PUT', body: JSON.stringify({ content, expectedVersion }) })
export const mutateAgentMemoryEntry = (t: EngineTarget, slug: string, body: { action: 'add' | 'update' | 'forget'; id?: string; fact?: string; expectedVersion: string }) =>
  request<AgentMemorySnapshot>(t, `${agentMemoryPath(slug)}/entries`, { method: 'POST', body: JSON.stringify(body) })
export const listAgentMemoryRevisions = (t: EngineTarget, slug: string) =>
  request<{ revisions: AgentMemoryRevision[] }>(t, `${agentMemoryPath(slug)}/revisions`).then((r) => r.revisions)
export const restoreAgentMemory = (t: EngineTarget, slug: string, version: string, expectedVersion: string) =>
  request<AgentMemorySnapshot>(t, `${agentMemoryPath(slug)}/restore`, { method: 'POST', body: JSON.stringify({ version, expectedVersion }) })
export const getAgentMemoryDream = (t: EngineTarget, slug: string) => request<AgentMemoryDream>(t, `${agentMemoryPath(slug)}/dream`)
export const configureAgentMemoryDream = (t: EngineTarget, slug: string, patch: Partial<AgentMemoryDreamConfig>) =>
  request<AgentMemoryDream>(t, `${agentMemoryPath(slug)}/dream`, { method: 'PUT', body: JSON.stringify(patch) })
export const startAgentMemoryDream = (t: EngineTarget, slug: string) =>
  request<{ status: AgentMemoryDreamStatus }>(t, `${agentMemoryPath(slug)}/dream`, { method: 'POST' }).then((r) => r.status)
export const cancelAgentMemoryDream = (t: EngineTarget, slug: string) =>
  request<{ status: AgentMemoryDreamStatus }>(t, `${agentMemoryPath(slug)}/dream`, { method: 'DELETE' }).then((r) => r.status)
export const listAgentLogDates = (t: EngineTarget, slug: string) =>
  request<{ dates: string[] }>(t, `/agent/agents/${encodeURIComponent(slug)}/logs`).then((r) => r.dates)
export const getAgentLogSnapshot = (t: EngineTarget, slug: string, date: string) =>
  request<{ date: string; content: string; version: string }>(t, `/agent/agents/${encodeURIComponent(slug)}/log?date=${encodeURIComponent(date)}`)
export const getAgentLog = (t: EngineTarget, slug: string, date: string) =>
  getAgentLogSnapshot(t, slug, date).then((r) => r.content)
export const putAgentLog = (t: EngineTarget, slug: string, date: string, content: string, expectedVersion: string) =>
  request<{ ok: boolean }>(t, `/agent/agents/${encodeURIComponent(slug)}/log?date=${encodeURIComponent(date)}`, { method: 'PUT', body: JSON.stringify({ content, expectedVersion }) })

// 某 agent 的 Library 文件(列表 / 读 / 写 / 删;用 agent 自身 slug)。
export type AgentLibraryFile = { name: string; size: number; isBinary: boolean; mtimeMs: number }
export const listAgentLibrary = (t: EngineTarget, slug: string) =>
  request<{ files: AgentLibraryFile[] }>(t, `/agent/agents/${encodeURIComponent(slug)}/library`).then((r) => r.files).catch(() => [] as AgentLibraryFile[])
export const getAgentLibraryFile = (t: EngineTarget, slug: string, name: string) =>
  request<{ name: string; isBinary: boolean; content?: string; dataBase64?: string; mimeType?: string }>(
    t, `/agent/agents/${encodeURIComponent(slug)}/library/file?name=${encodeURIComponent(name)}`)
export const putAgentLibraryFile = (t: EngineTarget, slug: string, name: string, body: { content?: string; dataBase64?: string; isBinary?: boolean }) =>
  request<{ ok: boolean; name: string }>(t, `/agent/agents/${encodeURIComponent(slug)}/library/file`, { method: 'POST', body: JSON.stringify({ name, ...body }) })
export const deleteAgentLibraryFile = (t: EngineTarget, slug: string, name: string) =>
  request<{ ok: boolean }>(t, `/agent/agents/${encodeURIComponent(slug)}/library/file?name=${encodeURIComponent(name)}`, { method: 'DELETE' })

// 某 agent 的工作笔记进化史(HARNESS.md 条目 + 本机编辑史;journal 不跨设备同步)。
export type HarnessEntry = { id: string; kind: string; title: string; body: string; evidence?: string; createdAt: string; updatedAt: string; version: number; /** kind 'equip':收起的工具 / 技能 */ tools?: string[]; skills?: string[] }
/** by = 不是 agent 自己在对话里写的改动:'historian' 后台复盘的提名直接采纳,'muse' 用量巡检后代为收起;缺省 = agent 自己(或面板 / 撤销卡)。 */
export type HarnessJournalLine = { ts: string; rev?: string; action: 'upsert' | 'delete' | 'rollback'; entryId: string; before: HarnessEntry | null; after: HarnessEntry | null; by?: string }
/** candidates = Historian 自动档提名的待复盘候选(收件箱原始行 `- [YYYY-MM-DD s:xxxx] 正文`,只读;/refine 才取走);旧引擎没有这一键。 */
export const getAgentHarness = (t: EngineTarget, slug: string) =>
  request<{ entries: HarnessEntry[]; journal: HarnessJournalLine[]; candidates?: string[] }>(t, `/agent/agents/${encodeURIComponent(slug)}/harness`)
/** expectRev = 对话里更新卡带回的那一行编辑史:条目之后又改过 → 引擎回 409,不会撤掉后来的修改。面板里的「撤销最近一次改动」不带。 */
export const rollbackHarnessEntry = (t: EngineTarget, slug: string, id: string, expectRev?: string) =>
  request<{ ok: boolean; entry: HarnessEntry | null }>(t, `/agent/agents/${encodeURIComponent(slug)}/harness/rollback`, { method: 'POST', body: JSON.stringify({ id, ...(expectRev ? { expectRev } : {}) }) })

// 全局用户画像 USER.md。
export const getUserProfile = (t: EngineTarget) =>
  request<{ content: string }>(t, '/agent/user-profile').then((r) => r.content).catch(() => '')
export const putUserProfile = (t: EngineTarget, content: string) =>
  request<{ ok: boolean }>(t, '/agent/user-profile', { method: 'PUT', body: JSON.stringify({ content }) })

// ── 统一插件(设置 → 插件):列表 / 启用 / 设置(全局或按 agent)/ image-list 文件 ──
export type PluginField =
  | { key: string; type: 'toggle'; label: string; labelEn?: string; help?: string; helpEn?: string; default?: boolean }
  | { key: string; type: 'text' | 'textarea'; label: string; labelEn?: string; help?: string; helpEn?: string; default?: string; placeholder?: string }
  | { key: string; type: 'number'; label: string; labelEn?: string; help?: string; helpEn?: string; default?: number; min?: number; max?: number }
  | { key: string; type: 'select'; label: string; labelEn?: string; help?: string; helpEn?: string; default?: string; options: Array<{ value: string; label: string; labelEn?: string }> }
  | { key: string; type: 'image-list'; label: string; labelEn?: string; help?: string; helpEn?: string; itemFields: PluginField[] }
  // ── P3 声明式主题面板 DSL:展示/结构件(无设置值)。Tangu 渲染端用统一 token 渲染 → 天然继承
  //    主题/明暗/扁平,零样式泄漏。详见 desktop/PLUGIN_UI_CONTRACT.md。 ──
  | { key: string; type: 'section'; label: string; labelEn?: string; help?: string; helpEn?: string }
  | { key: string; type: 'note'; label: string; labelEn?: string; tone?: 'info' | 'warn' | 'success' }
  | { key: string; type: 'link'; label: string; labelEn?: string; url: string }
export type PluginInfo = {
  id: string; name: string; nameEn?: string; description: string; descriptionEn?: string;
  iconUrl?: string;
  scopes: Array<'global' | 'agent'>; settings: { fields: PluginField[] } | null; source: 'builtin' | 'folder'; enabled: boolean
  /** 磁盘上换了代码却没法热换(包里有 CommonJS / 自带 node_modules,或运行时没有模块钩子而入口有相对引入):
   *  老实例还在跑,重启后端才换上新版。 */
  needsRestart?: boolean
  /** 此刻在不在跑(2026-10-02 起的引擎才给;缺省按 enabled)。开着但前置没齐 → false。 */
  active?: boolean
  version?: string
  requiresPlugins?: Array<{ id: string; minVersion?: string }>
  /** 开着却因前置没齐而休眠时才给:缺哪些、为什么(missing / version / off / waiting / cycle,同桌面 pluginDeps)。 */
  waitingFor?: Array<{ id: string; reason: 'missing' | 'version' | 'off' | 'waiting' | 'cycle'; minVersion?: string; have?: string }>
  /** 上次 activate 抛错的消息(显式拨一次开关即清)。 */
  lastError?: string
  /** 上一次启动 / 停用超时、还在后台收尾:结束后引擎按开关自动收敛,这期间不会再启动它。 */
  settling?: boolean
}
/** 重扫 / 安装的结果。reloadedIds 有 = 引擎会热插拔(10-02 起):原地升级即生效,needsRestart 只剩「没法热换」那几种(见 needsRestart);
 *  旧引擎不给 reloadedIds,只激活全新 id,原地更新一律得重启。 */
export type PluginRescanResult = { addedIds: string[]; reloadedIds?: string[]; removedIds?: string[]; needsRestart: boolean; plugins: PluginInfo[] }
export const listPlugins = (t: EngineTarget) =>
  request<{ plugins?: PluginInfo[] }>(t, '/agent/plugins').then((r) => r.plugins ?? []).catch(() => [] as PluginInfo[])
/** 运行期重扫:市场装新插件后即生效(无需重启)。addedIds=新激活的;needsRestart=贡献路由的插件需重启。 */
export const rescanPlugins = (t: EngineTarget) =>
  request<{ ok: boolean } & PluginRescanResult>(t, '/agent/plugins/rescan', { method: 'POST' })
// npm 一条命令装引擎插件(仅 npm: 源)。confirm:true 由本函数代表 UI 已弹确认框;装后后端内联 rescan,返回最新列表。
export const installPluginFromNpm = (t: EngineTarget, spec: string, preferMirror?: boolean) =>
  request<{ ok: boolean; id: string; version: string } & PluginRescanResult>(
    t, '/agent/plugins/install', { method: 'POST', body: JSON.stringify({ spec, preferMirror, confirm: true }) })
export const setPluginEnabled = (t: EngineTarget, id: string, enabled: boolean) =>
  request<{ ok: boolean; enabled: boolean; active?: boolean; plugins?: PluginInfo[] }>(t, `/agent/plugins/${encodeURIComponent(id)}/enabled`, { method: 'PUT', body: JSON.stringify({ enabled }) })
/** 卸载:引擎先停掉在跑的实例(依赖者先休眠)、注销 meta、清设置/blob;文件夹由桌面侧 IPC 删。
 *  restartRequired:false(10-02 起)= 已运行期撤干净,不用重启;旧引擎给 true / 不给。 */
export const uninstallPlugin = (t: EngineTarget, id: string) =>
  request<{ ok: boolean; restartRequired: boolean }>(t, `/agent/plugins/${encodeURIComponent(id)}`, { method: 'DELETE' })
export const getPluginSettings = (t: EngineTarget, id: string, scope: string) =>
  request<{ values: Record<string, any> }>(t, `/agent/plugins/${encodeURIComponent(id)}/settings?scope=${encodeURIComponent(scope)}`).then((r) => r.values)
export const putPluginSettings = (t: EngineTarget, id: string, scope: string, patch: Record<string, any>) =>
  request<{ ok: boolean; values: Record<string, any> }>(t, `/agent/plugins/${encodeURIComponent(id)}/settings?scope=${encodeURIComponent(scope)}`, { method: 'PUT', body: JSON.stringify({ patch }) }).then((r) => r.values)
export type PluginFile = { name: string; size: number; mimeType: string; dataBase64?: string }
export const listPluginFiles = (t: EngineTarget, id: string, scope: string) =>
  request<{ files: PluginFile[] }>(t, `/agent/plugins/${encodeURIComponent(id)}/files?scope=${encodeURIComponent(scope)}`).then((r) => r.files).catch(() => [] as PluginFile[])
export const addPluginFile = (t: EngineTarget, id: string, scope: string, name: string, dataBase64: string) =>
  request<{ ok: boolean; name: string }>(t, `/agent/plugins/${encodeURIComponent(id)}/files?scope=${encodeURIComponent(scope)}`, { method: 'POST', body: JSON.stringify({ name, dataBase64 }) })
export const deletePluginFile = (t: EngineTarget, id: string, scope: string, name: string) =>
  request<{ ok: boolean }>(t, `/agent/plugins/${encodeURIComponent(id)}/files?scope=${encodeURIComponent(scope)}&name=${encodeURIComponent(name)}`, { method: 'DELETE' })

// ── Special Agents（Historian / Muse;本地后端）──
export const getSpecialConfig = (t: EngineTarget) =>
  request<import('../types').SpecialConfigResponse>(t, '/agent/special/config') // 远程来源只回摘要 + remote:true(P1-K10b)

export const saveSpecialConfig = (t: EngineTarget, patch: { historian?: Partial<SpecialAgentsConfig['historian']>; muse?: Partial<SpecialAgentsConfig['muse']> }) =>
  request<{ config: SpecialAgentsConfig }>(t, '/agent/special/config', { method: 'POST', body: JSON.stringify(patch) }).then((r) => r.config)

export interface SessionHistorianStatus {
  running: boolean
  activity: HistorianActivityItem[]
  records: Array<{ id: string; content: string; timestamp: number }>
}
export const getSessionHistorian = (t: EngineTarget, sessionId: string, detail = false) =>
  request<SessionHistorianStatus>(t, `/agent/special/historian/activity?limit=8&sessionId=${encodeURIComponent(sessionId)}${detail ? '&detail=1' : ''}`)

export const getHistorianActivity = (t: EngineTarget, limit = 50) =>
  request<{ activity: HistorianActivityItem[] }>(t, `/agent/special/historian/activity?limit=${limit}`).then((r) => r.activity)


export const getMuseTodos = (t: EngineTarget, status?: string) =>
  request<{ todos: MuseTodo[] }>(t, `/agent/special/muse/todos${status ? `?status=${encodeURIComponent(status)}` : ''}`).then((r) => r.todos)

/** from = CAS:当前状态不是 from → 409(Error.code = 'todo_not_pending');不带 = 无条件(MuseView)。 */
export const patchMuseTodo = (t: EngineTarget, id: string, status: MuseTodo['status'], from?: MuseTodo['status']) =>
  request<{ ok: boolean }>(t, `/agent/special/muse/todos/${encodeURIComponent(id)}`, { method: 'PATCH', body: JSON.stringify(from ? { status, from } : { status }) })

/** 单条 TODO(收件箱任务卡按真状态决定给不给按钮);404 → Error.code = 'todo_not_found'。
 *  12s 超时:authFetch 缺省不超时,挂住的请求会让卡片一直停在「正在确认」—— 超时按读失败处理(给重试)。 */
export const getMuseTodo = (t: EngineTarget, id: string) =>
  request<{ todo: Pick<MuseTodo, 'id' | 'title' | 'status'> }>(t, `/agent/special/muse/todos/${encodeURIComponent(id)}`, undefined, { timeoutMs: 12_000 }).then((r) => r.todo)

/** 批准 Muse TODO(收件箱任务卡「交给 Muse 执行」):引擎按 id 读库里的任务书、CAS pending→injected、建一次性 Muse 日程。
 *  409 的 error 码:muse_disabled / todo_not_pending(request() 把它挂在 Error.code 上)。 */
export const approveMuseTodo = (t: EngineTarget, id: string) =>
  request<{ ok: boolean }>(t, `/agent/special/muse/todos/${encodeURIComponent(id)}/approve`, { method: 'POST' })

export const injectMuseTodos = (t: EngineTarget, todoIds: string[], sessionId: string) =>
  request<{ ok: boolean; runId: string }>(t, '/agent/special/muse/todos/inject', { method: 'POST', body: JSON.stringify({ todoIds, sessionId }) })

export const getMuseStatus = (t: EngineTarget) =>
  request<{ status: MuseStatusInfo }>(t, '/agent/special/muse/status').then((r) => r.status)

// 异步审批(Muse ask/agent 档的越界动作):列表 / 批准(引擎按原参数代执行,结果随响应回)/ 拒绝。
export const listMuseApprovals = (t: EngineTarget, status?: string) =>
  request<{ approvals: PendingApprovalInfo[] }>(t, `/agent/special/approvals${status ? `?status=${encodeURIComponent(status)}` : ''}`, undefined, { timeoutMs: 30000 }).then((r) => r.approvals)

/** 按 id 读一行(收件箱审批卡;404 = 找不到 → 抛错,调用方区分「不存在」与「读失败」看 status)。 */
export const getMuseApproval = (t: EngineTarget, id: string) =>
  request<{ approval: PendingApprovalInfo }>(t, `/agent/special/approvals/${encodeURIComponent(id)}`, undefined, { timeoutMs: 30000 }).then((r) => r.approval)

export const decideMuseApproval = (t: EngineTarget, id: string, decision: 'approve' | 'reject', note?: string) =>
  request<{ ok: boolean; status: string; result?: string }>(t, `/agent/special/approvals/${encodeURIComponent(id)}/${decision}`, {
    method: 'POST', body: JSON.stringify({ note }),
  }, { timeoutMs: 120000 }) // approve 会同步执行工具(写文件通常毫秒级;bash 可能要跑一会)

/** 往 Muse 的 LOG 追加一条 [feedback] 行(任务卡落点回执等;下周期 read_log 即见)。 */
export const postMuseFeedback = (t: EngineTarget, text: string) =>
  request<{ ok: boolean }>(t, '/agent/special/muse/feedback', { method: 'POST', body: JSON.stringify({ text }) })

/** Muse Library 目录树(Agent Space 左栏;root=绝对路径,files 为相对路径)。 */
export const getMuseLibrary = (t: EngineTarget) =>
  request<{ root: string; files: MuseLibraryEntry[] }>(t, '/agent/special/muse/library', undefined, { timeoutMs: 30000 })

/** 读 Library 里一个文本文件(Muse 自建 Space 的 ctx.agent.library.read;越界 / 隐藏 / 超 1MB 引擎侧拒)。 */
export const getMuseLibraryFile = (t: EngineTarget, path: string) =>
  request<{ path: string; content: string; size: number; mtime: number }>(
    t, `/agent/special/muse/library/file?path=${encodeURIComponent(path)}`, undefined, { timeoutMs: 30000 },
  )


// ⚠️ 这两条是控制面(非流式),必须带超时:插件的「登记规则 / 停用规则」把它们放进了每插件串行链,
// 后端半死时一笔永不 settle 的请求会把整条链焊住 —— 停用永远排不上,等于 codex 抓的那条 bug 换了触发条件。
export const getMuseTriggers = (t: EngineTarget) =>
  request<{ triggers: MuseTriggerInfo[] }>(t, '/agent/special/muse/triggers', undefined, { timeoutMs: 30000 }).then((r) => r.triggers)

export const deleteMuseTrigger = (t: EngineTarget, id: string) =>
  request<{ ok: boolean }>(t, `/agent/special/muse/triggers/${encodeURIComponent(id)}`, { method: 'DELETE' })

// ── 自动化(watch 规则 upsert + agent 自动化会话/运行历史;「自动化」Space 数据面)──
export const saveMuseTrigger = (t: EngineTarget, input: MuseTriggerUpsert) =>
  request<{ trigger: MuseTriggerInfo; created: boolean }>(t, '/agent/special/muse/triggers', {
    method: 'POST', body: JSON.stringify(input),
  }, { timeoutMs: 30000 }).then((r) => r.trigger)

export const getAutomationSessions = (t: EngineTarget, triggerId?: string) =>
  request<{ sessions: AutomationSessionInfo[] }>(
    t, `/agent/special/automation/sessions${triggerId ? `?triggerId=${encodeURIComponent(triggerId)}` : ''}`,
  ).then((r) => r.sessions)

export const getAutomationRuns = (t: EngineTarget, sessionId: string, limit = 50) =>
  request<{ runs: AutomationRunInfo[] }>(
    t, `/agent/special/automation/runs?sessionId=${encodeURIComponent(sessionId)}&limit=${limit}`,
  ).then((r) => r.runs)

/**
 * 立即跑动作链(不动 lastFiredAt/enabled)。
 *   origin='manual'(默认)= 面板试跑,任意规则、允许已停用;
 *   origin='button'      = Amadeus 按钮块点击,引擎侧只放行 cond=manual 且启用的规则。
 * 并发同一规则 → 引擎单飞锁 409(前端应显示「正在执行」而非失败)。
 */
export const fireAutomationTrigger = (t: EngineTarget, id: string, origin: 'manual' | 'button' = 'manual') =>
  request<{ ok: boolean; execId?: string; status: string; steps?: AutomationExecutionInfo['steps'] }>(
    t, `/agent/special/automation/triggers/${encodeURIComponent(id)}/fire`,
    { method: 'POST', body: JSON.stringify({ origin }) },
  )

/** 踢一次巡检:桌面写完一张 .db 后调用,让 db_changed 触发从「最多等一个巡检周期」降到 ~2s。
 *  无 payload —— 引擎唤醒后自己重读磁盘判定,不信客户端报的内容。调用方自己节流(见 dbStore)。 */
export const kickAutomation = (t: EngineTarget) =>
  request<{ ok: boolean }>(t, '/agent/special/automation/kick', { method: 'POST' })

/** tool_call 动作目录(白名单内置 + automationSafe 插件工具,含参数 JSON schema)。 */
export const getAutomationActions = (t: EngineTarget) =>
  request<{ tools: AutomationActionCatalogItem[] }>(t, '/agent/special/automation/actions').then((r) => r.tools)

/** 动作链执行账本。 */
export const getAutomationExecutions = (t: EngineTarget, triggerId?: string, limit = 50) =>
  request<{ executions: AutomationExecutionInfo[] }>(
    t, `/agent/special/automation/executions?limit=${limit}${triggerId ? `&triggerId=${encodeURIComponent(triggerId)}` : ''}`,
  ).then((r) => r.executions)

// ── Agent 日程(agents/<slug>/SCHEDULE.db;Calendar 只读源 + 自动化 Space「Agent 日程」组)──
export const getAgentSchedules = (t: EngineTarget) =>
  request<{ schedules: AgentScheduleInfo[] }>(t, '/agent/special/schedule').then((r) => r.schedules)

export const saveAgentScheduleEntry = (t: EngineTarget, slug: string, input: AgentScheduleEntryUpsert) =>
  request<{ entry: AgentScheduleEntry; created: boolean }>(
    t, `/agent/special/schedule/${encodeURIComponent(slug)}/entries`,
    { method: 'POST', body: JSON.stringify(input) },
  ).then((r) => r.entry)

export const deleteAgentScheduleEntry = (t: EngineTarget, slug: string, id: string) =>
  request<{ ok: boolean }>(
    t, `/agent/special/schedule/${encodeURIComponent(slug)}/entries/${encodeURIComponent(id)}`,
    { method: 'DELETE' },
  )

// ── Lifecycle Hooks（本地后端；host-only shell 回调）──
export type HookDiscovered = {
  key: string; matcher: string; command: string; commandWindows: string; timeout: number;
  statusMessage: string; source: string; trust: 'trusted' | 'needs-review' | 'managed'; enabled: boolean; active: boolean
}
export type HooksData = { events: Record<string, any>; discovered: Record<string, HookDiscovered[]>; eventNames: string[] }

export const getHooks = (t: EngineTarget) =>
  request<HooksData>(t, '/agent/hooks')
export const saveHooks = (t: EngineTarget, events: Record<string, any>) =>
  request<Pick<HooksData, 'events' | 'discovered'>>(t, '/agent/hooks', { method: 'PUT', body: JSON.stringify({ events }) })
export const trustHookReq = (t: EngineTarget, key: string) =>
  request<{ discovered: Record<string, HookDiscovered[]> }>(t, '/agent/hooks/trust', { method: 'POST', body: JSON.stringify({ key }) })
export const enableHookReq = (t: EngineTarget, key: string, enabled: boolean) =>
  request<{ discovered: Record<string, HookDiscovered[]> }>(t, '/agent/hooks/enable', { method: 'POST', body: JSON.stringify({ key, enabled }) })

// ── 记忆 / 日志 ──
export const getMemory = (t: EngineTarget) =>
  request<{ content: string; updatedAt: any }>(t, '/agent/memory')

export const appendMemory = (t: EngineTarget, text: string, slug?: string) =>
  request<{ appended: boolean; reason?: string }>(t, '/agent/memory', {
    method: 'POST',
    body: JSON.stringify({ text, slug }),
  })

export const getLog = (t: EngineTarget, date?: string) =>
  request<{ date: string; content: string; updatedAt: any }>(
    t, `/agent/log${date ? `?date=${encodeURIComponent(date)}` : ''}`,
  )

// ── 云端 Project(Penzor Cloud-Workspaces/Projects/ 目录) ──
export const listProjects = (t: EngineTarget) =>
  request<{ projects: Array<{ name: string; isDefault?: boolean }> }>(t, '/agent/projects')
    .then((r) => r.projects.map((p) => p.name))

export const createProject = (t: EngineTarget, name: string) =>
  request<{ name: string }>(t, '/agent/projects', { method: 'POST', body: JSON.stringify({ name }) })

// ── 工作区 ──
// project 有值 = 按云端 Project 树取数(服务端 resolveScope 显式 project 优先,sessionId 仅形式必填,
// 调用方无会话时传 '__project__' 哑值即可)。
// appId 必须显式带上:'__project__' 哑值查不到 session 行时,服务端会落进程基线 appId
// (agent-core 基线=ai-studio)→ 读到另一棵空树,文件面板恒空(2026-08-19 实锤)。
const wsQ = (sessionId: string, project?: string) =>
  `sessionId=${encodeURIComponent(sessionId)}&appId=${encodeURIComponent(AGENT_APP_ID)}${project ? `&project=${encodeURIComponent(project)}` : ''}`

export const listWorkspace = (t: EngineTarget, sessionId: string, project?: string) =>
  request<{ files: WorkspaceFileMeta[] }>(
    t, `/agent/workspace/list?${wsQ(sessionId, project)}`,
  ).then((r) => r.files)

export const readWorkspaceFile = (t: EngineTarget, sessionId: string, path: string, project?: string) =>
  request<{ path: string; mimeType: string; content: string; encoding: 'base64'; size: number }>(
    t, `/agent/workspace/read?${wsQ(sessionId, project)}&path=${encodeURIComponent(path)}`,
  )

const downloadUrlOf = (t: EngineTarget, sessionId: string, path: string, project?: string): string =>
  `${t.base}/agent/workspace/download?${wsQ(sessionId, project)}&path=${encodeURIComponent(path)}`

/** 可以直接当 `<img src>` 的下载直链。目标不能直链(unit:隧道 cookie 对手机源是跨站,`<img>` 不带凭据)→ null,
 *  调用方改走 readWorkspaceFile 读字节做 blob(K6 §3.7;凭据永不进 URL)。 */
export const workspaceDownloadUrl = (t: EngineTarget, sessionId: string, path: string, project?: string): string | null => {
  return targetCaps(t).directAssetUrl ? downloadUrlOf(t, sessionId, path, project) : null
}

/** 下载工作区文件(fetch 带 Bearer → blob → 触发保存)。
 *  安卓 App(P1-DL):WebView 里 `<a download>` 是哑弹 → 有 window.tangu.saveDownload 就交原生存进「下载」并 toast 实际文件名;
 *  那条路上限 50 MB,超了抛本地化错误(见 services/nativeDownload.ts)。 */
export async function downloadWorkspaceFile(t: EngineTarget, sessionId: string, path: string, project?: string): Promise<void> {
  const url = downloadUrlOf(t, sessionId, path, project)
  const init = { headers: await t.headers(true) }
  const o = fetchOpts(t)
  const r = await (o ? authFetch(url, init, o) : authFetch(url, init))
  if (!r.ok) throw new Error(translate('backendsvc.downloadFailed', { status: r.status }))
  await saveResponseAs(path.split('/').filter(Boolean).pop() || 'file', r)
}

type UploadFile = { path: string; content: string; encoding?: 'base64'; mimeType?: string }
type UploadResult = { success: boolean; saved: number; total: number; errors: string[] }

/** 经 hub 中转的单次请求体上限:hub 收 10MB JSON(413 UNIT_BODY_TOO_LARGE),留 1MB 余量。 */
export const UNIT_UPLOAD_BATCH_BYTES = 9 * 1024 * 1024

/** 一个文件在上传 JSON 里大约占多少字节(内容是 base64 / 纯文本,都是 ASCII 或按 UTF-8 计)。 */
const uploadBytes = (f: UploadFile): number => new TextEncoder().encode(JSON.stringify(f)).length + 8

export const uploadWorkspaceFiles = async (t: EngineTarget, sessionId: string, files: UploadFile[]): Promise<UploadResult> => {
  const post = (batch: UploadFile[]): Promise<UploadResult> => request<UploadResult>(t, '/agent/workspace/upload', {
    method: 'POST',
    body: JSON.stringify({ sessionId, files: batch }),
  })
  if (t.via !== 'unit') return post(files)
  // unit 目标(K6 §3.7):按单次 ≤ 9MB 分批;单个文件本身就超 → 前端直接拒(不白传一趟换个 413)
  const tooLarge = (): Error => Object.assign(new Error(translate('engine.target.tooLarge')), { status: 413, code: 'UNIT_BODY_TOO_LARGE' })
  const overhead = uploadBytes({ path: '', content: '' }) + JSON.stringify({ sessionId, files: [] }).length
  const batches: UploadFile[][] = []
  let cur: UploadFile[] = []
  let size = overhead
  for (const f of files) {
    const n = uploadBytes(f)
    if (n + overhead > UNIT_UPLOAD_BATCH_BYTES) throw tooLarge()
    if (cur.length && size + n > UNIT_UPLOAD_BATCH_BYTES) { batches.push(cur); cur = []; size = overhead }
    cur.push(f)
    size += n
  }
  if (cur.length) batches.push(cur)
  const out: UploadResult = { success: true, saved: 0, total: 0, errors: [] }
  for (const b of batches) {
    const r = await post(b)
    out.success = out.success && r.success
    out.saved += r.saved
    out.total += r.total
    out.errors.push(...(r.errors || []))
  }
  return out
}

export const deleteWorkspaceFile = (t: EngineTarget, sessionId: string, path: string, project?: string) =>
  requestCap<{ ok: boolean }>(t, 'workspaceDelete', '/agent/workspace/delete', {
    method: 'POST',
    body: JSON.stringify({ sessionId, path, appId: AGENT_APP_ID, ...(project ? { project } : {}) }),
  })

// ── Inbox(收件箱)──
// 时间字段为 UTC 'YYYY-MM-DD HH:MM:SS' 无时区后缀,前端解析统一 new Date(s.replace(' ','T')+'Z')。
/** 广播附件物品:label 双语在服务端发送时冻结;kind 未知时前端用兜底图标+label 渲染(类型扩展零改动)。 */
export interface InboxAttachmentItem {
  kind: string
  label?: { zh?: string; en?: string }
  [k: string]: unknown
}
/** 广播附件的领取条件(服务端 claimRequirements.ts 同形);只用来展示 + 本地预判,裁决在服务端。
 *  不认识的键(服务端以后加的条件)按「另有条件」展示。 */
export interface InboxClaimRequirements {
  minVersion?: string
  tiers?: string[]
  [k: string]: unknown
}
/** 服务端按业务事件投递的定向消息的判别(引擎 routes/inbox.ts 只对 sender_kind='server' 的行解析;目前只有反馈中心)。
 *  阅读面板据此挂反馈线程面板(views/inbox/FeedbackThread.tsx)。移动端 localInbox 直存服务端行,这里可能仍是 JSON 串。 */
export interface InboxThread {
  kind: 'feedback'
  ticketId: string
  event?: string
}
export interface InboxMessage {
  id: string
  title: string
  body: string
  sender_kind: 'agent' | 'server' | 'system'
  sender_id: string | null
  origin_broadcast_id: string | null
  thread?: InboxThread | string | null
  read_at: string | null
  archived_at: string | null
  attachments?: { items: InboxAttachmentItem[]; claimed: boolean; requires?: InboxClaimRequirements } | null
  expires_at?: string | null
  created_at: string | null
}
export type InboxFilter = 'all' | 'unread' | 'archived'

// 移动端(window.tangu?.mobile)inbox 走设备本地存储(localInbox);桌面/web 走远程 /agent/inbox。
export const listInbox = (t: EngineTarget, filter: InboxFilter = 'all') =>
  window.tangu?.mobile
    ? localInbox.list(filter)
    : request<{ messages: InboxMessage[] }>(t, `/agent/inbox?filter=${filter}&limit=200`).then((r) => r.messages)

export const getInboxUnreadCount = (t: EngineTarget) =>
  window.tangu?.mobile
    ? localInbox.unreadCount()
    : request<{ count: number; latestId: string | null }>(t, '/agent/inbox/unread-count')

export const patchInboxMessage = (t: EngineTarget, id: string, patch: { read?: boolean; archived?: boolean }) =>
  window.tangu?.mobile
    ? localInbox.patch(id, patch)
    : request<{ ok: boolean }>(t, `/agent/inbox/${encodeURIComponent(id)}`, { method: 'PATCH', body: JSON.stringify(patch) })

export const readAllInbox = (t: EngineTarget) =>
  window.tangu?.mobile
    ? localInbox.readAll()
    : request<{ ok: boolean }>(t, '/agent/inbox/read-all', { method: 'POST' })

export const deleteInboxMessage = (t: EngineTarget, id: string) =>
  window.tangu?.mobile
    ? localInbox.remove(id)
    : request<{ ok: boolean }>(t, `/agent/inbox/${encodeURIComponent(id)}`, { method: 'DELETE' })

export const pullInbox = (t: EngineTarget) =>
  window.tangu?.mobile
    ? localInbox.pull(t)
    : request<{ pulled: boolean; added: number; detail?: string }>(t, '/agent/inbox/pull', { method: 'POST' })

/** 领取广播附件(发放全在服务端)。client=`desktop/2.10.1`,服务端按它判最低版本。移动端本地收件箱无广播,不承载。 */
export const claimInboxAttachment = (t: EngineTarget, id: string, client?: string) =>
  window.tangu?.mobile
    ? Promise.reject(new Error('not supported on mobile'))
    : request<{ ok: boolean; alreadyClaimed: boolean }>(t, `/agent/inbox/${encodeURIComponent(id)}/claim`, { method: 'POST', body: JSON.stringify({ client }) })

/** 本地系统消息(sender_kind='system';壳自用:插件引导提醒等)。移动端本地收件箱不承载,静默 no-op。 */
export const postInboxMessage = (t: EngineTarget, msg: { title: string; body?: string; sender_id?: string }) =>
  window.tangu?.mobile
    ? Promise.resolve({ ok: false, id: '' })
    : request<{ ok: boolean; id: string }>(t, '/agent/inbox', { method: 'POST', body: JSON.stringify(msg) })

// ── Slash 命令目录（内置来自引擎的 commandCatalog；custom 来自 ~/.tangu/commands/*.md）──
export interface CustomCommandInfo { name: string; description: string; argHint?: string }
export interface CommandsCatalogResponse {
  builtin: Array<{ name: string; key: string; zh: string; en: string; arg?: string; surfaces: string[]; aliases?: string[] }>
  custom: CustomCommandInfo[]
  dir: string | null
}

/** 用户自定义命令列表。引擎不可达/云端 profile 无此能力 → 空表（输入框照常可用）。 */
export const getCustomCommands = (t: EngineTarget) =>
  request<CommandsCatalogResponse>(t, '/agent/commands')
    .then((r) => r.custom || [])
    .catch(() => [] as CustomCommandInfo[])

/** 展开自定义命令（$ARGUMENTS/$1..$9 的替换在服务端做，两端不各写一份正则）。 */
export const expandCustomCommand = (t: EngineTarget, name: string, args: string) =>
  request<{ text: string }>(t, `/agent/commands/${encodeURIComponent(name)}/expand`, {
    method: 'POST',
    body: JSON.stringify({ args }),
  }).then((r) => r.text)

// ── 项目上下文(桌面「PROJECT 详情」;只有本地引擎有,按 sessionId 绑定项目 —— cwd 不从客户端传)──
/** 形状不对(老引擎 / 桩引擎对未知路由回 200 空对象)按 404 抛:面板显示「只在本地引擎上可用」,而不是拿 undefined.doc 崩掉整个右栏。 */
const projectContextShape = (r: ProjectContext): ProjectContext => {
  if (!r || typeof r !== 'object' || !r.doc || !r.git || !Array.isArray(r.skills)) throw Object.assign(new Error('Project context unavailable'), { status: 404 })
  return r
}
export const getProjectContext = (t: EngineTarget, sessionId: string) =>
  request<ProjectContext>(t, `/agent/project-context?sessionId=${encodeURIComponent(sessionId)}`).then(projectContextShape)
/** 有会话就按 sessionId 绑定;没有会话可借的项目(全删光又加回来)按路径读用户侧记录 —— 只有这个只读端点收 cwd。 */
export const getProjectSettings = (t: EngineTarget, ref: { sessionId: string } | { cwd: string }, opts?: { timeoutMs?: number }) =>
  request<{ settings: ProjectSettings | null }>(t, `/agent/project-context/settings?${'sessionId' in ref ? `sessionId=${encodeURIComponent(ref.sessionId)}` : `cwd=${encodeURIComponent(ref.cwd)}`}`, undefined, opts).then((r) => r.settings ?? null)
// ── 项目的 git 动作(PROJECT 详情「Git」页;用户点了才做)。失败带机器码 code(not_repo / nothing_to_commit / embedded_repo /
//    too_many_files / large_files / no_identity / invalid_branch / no_remote / git_failed …)+ info(git 原文 / 点名的文件)。
//    成功一律带回新的项目上下文,面板一次刷新。
//    context 为 null = 动作做完了、只是随后读上下文失败:调用方照「成功」处理并自己重读,别报成失败(用户会重试 → 重复提交)。
//    trust=true = 用户刚点了「信任并继续」(仓库自带会执行程序的配置)。
const withContext = <T extends { context: ProjectContext | null }>(r: T): T => ({ ...r, context: r.context ? projectContextShape(r.context) : null })
const gitPost = <T,>(t: EngineTarget, action: string, body: object, timeoutMs = 60_000) =>
  request<T>(t, `/agent/project-context/git/${action}`, { method: 'POST', body: JSON.stringify(body) }, { timeoutMs })
export const gitInitProject = (t: EngineTarget, sessionId: string) =>
  gitPost<{ createdGitignore: boolean; context: ProjectContext | null }>(t, 'init', { sessionId }).then(withContext)
export const gitTrustProject = (t: EngineTarget, sessionId: string) =>
  gitPost<{ trusted: boolean; context: ProjectContext | null }>(t, 'trust', { sessionId }).then(withContext)
/** 这次会提交的文件(有已暂存的只列已暂存的,stagedOnly=true)。 */
export const gitPendingProject = (t: EngineTarget, sessionId: string, trust = false) =>
  gitPost<{ files: Array<{ code: string; path: string; from?: string }>; total: number; stagedOnly: boolean; token: string; tooMany?: boolean }>(t, 'pending', { sessionId, trust })
/** 用会话自己的模型写一条提交信息(计入额度)。 */
export const generateGitCommitMessage = (t: EngineTarget, sessionId: string, trust = false) =>
  gitPost<{ message: string }>(t, 'message', { sessionId, trust }, 120_000).then((r) => r.message)
/** expect = 提交框里那份清单的指纹:用户看完之后改动又变了,引擎回 changes_changed,不会悄悄多提交。 */
export const gitCommitProject = (t: EngineTarget, sessionId: string, message: string, expect: string | undefined, trust = false) =>
  gitPost<{ commit: { sha: string; subject: string; stagedOnly: boolean }; context: ProjectContext | null }>(t, 'commit', { sessionId, message, trust, ...(expect ? { expect } : {}) }, 120_000).then(withContext)
export const gitCreateProjectBranch = (t: EngineTarget, sessionId: string, name: string, trust = false) =>
  gitPost<{ branch: string; context: ProjectContext | null }>(t, 'branch', { sessionId, name, trust }).then(withContext)
export const gitPushProject = (t: EngineTarget, sessionId: string, trust = false) =>
  gitPost<{ remote: string; branch: string; target: string; output: string; context: ProjectContext | null }>(t, 'push', { sessionId, trust }, 180_000).then(withContext)
/** 「设置 → Git」。writable=false(云端 worker 的 config.json 是所有用户共用的)时设置页只读说明、不给改。 */
export const getGitSettings = (t: EngineTarget) =>
  request<{ settings: GitSettings; defaults: GitSettings; writable: boolean }>(t, '/agent/git-settings')
/** 逐键改;某键给 null = 恢复缺省。 */
export const setGitSettings = (t: EngineTarget, patch: { [K in keyof GitSettings]?: GitSettings[K] | null }) =>
  request<{ settings: GitSettings }>(t, '/agent/git-settings', { method: 'PUT', body: JSON.stringify(patch) }).then((r) => r.settings)
/** 删一条项目记忆。409 = 记忆在读出之后被别处改过(没有删除);调用方重载后再删。 */
export const forgetProjectMemory = (t: EngineTarget, sessionId: string, id: string, expectedVersion: string) =>
  request<{ memory: ProjectMemoryView }>(t, '/agent/project-context/memory', { method: 'DELETE', body: JSON.stringify({ sessionId, id, expectedVersion }) }).then((r) => r.memory)
export const initProjectContext = (t: EngineTarget, sessionId: string) =>
  request<{ createdDir: boolean; createdDoc: boolean; context: ProjectContext }>(t, '/agent/project-context/init', { method: 'POST', body: JSON.stringify({ sessionId }) }).then((r) => ({ ...r, context: projectContextShape(r.context) }))
/** 409 = 文件在读出之后被别处改过(没有写入);调用方提示用户重载。 */
export const putProjectDoc = (t: EngineTarget, sessionId: string, content: string, expectedMtimeMs?: number | null) =>
  request<{ path: string; mtimeMs: number }>(t, '/agent/project-context/doc', { method: 'PUT', body: JSON.stringify({ sessionId, content, ...(expectedMtimeMs != null ? { expectedMtimeMs } : {}) }) })
export const putProjectSettings = (t: EngineTarget, sessionId: string, settings: ProjectSettings | null) =>
  request<{ settings: ProjectSettings | null }>(t, '/agent/project-context/settings', { method: 'PUT', body: JSON.stringify({ sessionId, settings }) }).then((r) => r.settings ?? null)
export const createProjectSkill = (t: EngineTarget, sessionId: string, input: { slug: string; name: string; description: string; content: string }) =>
  request<{ skill: ProjectSkillInfo }>(t, '/agent/project-context/skills', { method: 'POST', body: JSON.stringify({ sessionId, ...input }) }).then((r) => r.skill)
/** 图标只经这组端点改(PUT settings 保留 icon 现值)。导入图片:引擎按文件头认类型,写进项目的 `.tangu/icon.<ext>`;返回落盘后的默认项。 */
export const uploadProjectIcon = (t: EngineTarget, sessionId: string, data: string) =>
  request<{ settings: ProjectSettings | null }>(t, '/agent/project-context/icon', { method: 'POST', body: JSON.stringify({ sessionId, data }) }).then((r) => r.settings ?? null)
/** 设 emoji 图标(原来指向的图片由引擎删掉)。 */
export const setProjectIconEmoji = (t: EngineTarget, sessionId: string, emoji: string) =>
  request<{ settings: ProjectSettings | null }>(t, '/agent/project-context/icon', { method: 'POST', body: JSON.stringify({ sessionId, emoji }) }).then((r) => r.settings ?? null)
/** 移除图标(emoji 或图片都清)。 */
export const deleteProjectIcon = (t: EngineTarget, sessionId: string) =>
  request<{ settings: ProjectSettings | null }>(t, `/agent/project-context/icon?sessionId=${encodeURIComponent(sessionId)}`, { method: 'DELETE' }).then((r) => r.settings ?? null)
/** 图标图片 → objectURL;没有图片 / 云端引擎 / 网络错 → null。 */
export async function fetchProjectIcon(t: EngineTarget, ref: { sessionId: string } | { cwd: string }): Promise<string | null> {
  try {
    const q = 'sessionId' in ref ? `sessionId=${encodeURIComponent(ref.sessionId)}` : `cwd=${encodeURIComponent(ref.cwd)}`
    const response = await blobFetch(t, `${t.base}/agent/project-context/icon?${q}`)
    if (!response.ok) return null
    return URL.createObjectURL(await response.blob())
  } catch { return null }
}
