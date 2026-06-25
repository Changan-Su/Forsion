/**
 * M3 数据 API 薄封装(sessions/models/memory/skills/tools/workspace)。
 * 统一 Bearer + JSON 错误,错误信息抛 Error(detail)。
 */
import type {
  AgentConfig, HistorianActivityItem, MessageRecord, ModelsResponse, MuseStatusInfo, MuseTodo,
  NormalAgentDef, SessionRecord, SkillInfo, SpecialAgentsConfig,
  TanguDesktopConfig, ToolsResponse, WorkspaceFileMeta,
} from '../types'

function headers(token: string): Record<string, string> {
  return { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }
}

async function request<T>(cfg: TanguDesktopConfig, path: string, init?: RequestInit): Promise<T> {
  const r = await fetch(`${cfg.backendUrl}${path}`, { ...init, headers: headers(cfg.token) })
  if (!r.ok) {
    let detail = `HTTP ${r.status}`
    try { detail = (await r.json())?.detail || detail } catch { /* keep */ }
    throw new Error(detail)
  }
  return r.json() as Promise<T>
}

// ── 记忆同步(本地 ↔ Forsion Brain)──
export interface SyncRunResult {
  ok: boolean
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
export const syncNow = (cfg: TanguDesktopConfig) =>
  request<SyncRunResult>(cfg, '/agent/sync', { method: 'POST' })
export const getSyncStatus = (cfg: TanguDesktopConfig) =>
  request<SyncStatusResult>(cfg, '/agent/sync/status')

// ── 会话 ──
export const listSessions = (cfg: TanguDesktopConfig, archived = false) =>
  request<{ sessions: SessionRecord[] }>(cfg, `/agent/sessions?archived=${archived}`).then((r) => r.sessions)

export const createSession = (
  cfg: TanguDesktopConfig,
  init?: { title?: string; model_id?: string; emoji?: string; project_path?: string; project_name?: string },
) =>
  request<{ session: SessionRecord }>(cfg, '/agent/sessions', {
    method: 'POST',
    body: JSON.stringify(init || {}),
  }).then((r) => r.session)

export const updateSession = (
  cfg: TanguDesktopConfig,
  id: string,
  patch: {
    title?: string; archived?: boolean; model_id?: string; emoji?: string | null
    project_path?: string | null; project_name?: string | null
  },
) =>
  request<{ session: SessionRecord }>(cfg, `/agent/sessions/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    body: JSON.stringify(patch),
  }).then((r) => r.session)

export const deleteSession = (cfg: TanguDesktopConfig, id: string) =>
  request<{ ok: boolean }>(cfg, `/agent/sessions/${encodeURIComponent(id)}`, { method: 'DELETE' })

export const listMessages = (cfg: TanguDesktopConfig, sessionId: string, limit = 200) =>
  request<{ messages: MessageRecord[] }>(
    cfg, `/agent/sessions/${encodeURIComponent(sessionId)}/messages?limit=${limit}`,
  ).then((r) => r.messages)

/** 按精确 id 列表删除会话内消息(编辑重发 / 重新生成前截断该点及之后的消息)。 */
export const deleteMessages = (cfg: TanguDesktopConfig, sessionId: string, ids: string[]) =>
  request<{ ok: boolean; deleted: number }>(
    cfg, `/agent/sessions/${encodeURIComponent(sessionId)}/messages/delete`,
    { method: 'POST', body: JSON.stringify({ ids }) },
  )

export const getSessionConfig = (cfg: TanguDesktopConfig, sessionId: string) =>
  request<{ agent_config: AgentConfig }>(
    cfg, `/agent/sessions/${encodeURIComponent(sessionId)}/config`,
  ).then((r) => r.agent_config || {})

export const putSessionConfig = (cfg: TanguDesktopConfig, sessionId: string, config: AgentConfig) =>
  request<{ agent_config: AgentConfig }>(cfg, `/agent/sessions/${encodeURIComponent(sessionId)}/config`, {
    method: 'PUT',
    body: JSON.stringify(config),
  }).then((r) => r.agent_config)

/** 本会话累计 token 消耗(跨 run 求和)。 */
export const getSessionUsage = (cfg: TanguDesktopConfig, sessionId: string) =>
  request<{ tokensTotal: number }>(cfg, `/agent/sessions/${encodeURIComponent(sessionId)}/usage`).then((r) => r.tokensTotal)

/** 手动压缩上下文(生成并持久化总结检查点;后续 run 起步即精简)。 */
export const compactSession = (cfg: TanguDesktopConfig, sessionId: string, modelId?: string) =>
  request<{ ok: boolean; reason?: string; summarizedCount?: number }>(
    cfg, `/agent/sessions/${encodeURIComponent(sessionId)}/compact`,
    { method: 'POST', body: JSON.stringify(modelId ? { model_id: modelId } : {}) },
  )

// ── 模型 / 技能 / 工具 ──
export const listModels = (cfg: TanguDesktopConfig) => request<ModelsResponse>(cfg, '/agent/models')

/** host 端外部 agent 引擎清单(含 available 检测 + 每引擎默认模型;云端/非 host → 抛或空 → 调用方回退 [])。 */
export const listEngines = (cfg: TanguDesktopConfig) =>
  request<{ engines: Array<{ id: string; name: string; available?: boolean; defaultModel?: string }> }>(cfg, '/agent/engines').then((r) => r.engines || [])

/** 设某引擎默认模型(设置页「Agent CLIs」;空串=清除)。 */
export const setEngineDefaultModel = (cfg: TanguDesktopConfig, engineId: string, defaultModel: string) =>
  request<{ ok: boolean }>(cfg, `/agent/engines/${encodeURIComponent(engineId)}`, {
    method: 'PUT',
    body: JSON.stringify({ defaultModel }),
  })

/** 懒探测某引擎能力(模型 + slash 命令);首次会 spawn(慢),后端缓存。失败 → 空。 */
export const getEngineCapabilities = (cfg: TanguDesktopConfig, engineId: string) =>
  request<{
    models?: Array<{ id: string; name: string; description?: string }>
    currentModelId?: string
    commands?: Array<{ name: string; description: string; hint?: string }>
  }>(cfg, `/agent/engines/${encodeURIComponent(engineId)}/capabilities`)
    .then((r) => ({ models: r.models || [], currentModelId: r.currentModelId, commands: r.commands || [] }))
    .catch(() => ({
      models: [] as Array<{ id: string; name: string; description?: string }>,
      currentModelId: undefined as string | undefined,
      commands: [] as Array<{ name: string; description: string; hint?: string }>,
    }))

/** 探测一个 OpenAI 兼容端点(后端代理,避免 CORS):GET /models → 1-token chat。 */
export const testProviderConnection = (
  cfg: TanguDesktopConfig,
  probe: { baseUrl: string; apiKey?: string; modelId?: string },
) =>
  request<{ success: boolean; message: string }>(cfg, '/agent/providers/test', {
    method: 'POST',
    body: JSON.stringify(probe),
  })

/** 后端代拉上游 GET {baseUrl}/models(避 CORS),返回可选模型名列表;软失败回 []。 */
export const fetchProviderModels = (
  cfg: TanguDesktopConfig,
  probe: { baseUrl: string; apiKey?: string },
) =>
  request<{ models: Array<{ id: string; name?: string }> }>(cfg, '/agent/providers/fetch-models', {
    method: 'POST',
    body: JSON.stringify(probe),
  }).then((r) => r.models)

export const listSkills = (cfg: TanguDesktopConfig) =>
  request<{ skills: SkillInfo[] }>(cfg, '/agent/skills').then((r) => r.skills)

/** 本地技能上云(owner=当前用户,云端 Tangu 会话即可启用)。 */
export const uploadSkillToCloud = (cfg: TanguDesktopConfig, localId: string) =>
  request<{ id: string; name: string }>(cfg, '/agent/skills/upload', {
    method: 'POST',
    body: JSON.stringify({ localId }),
  })

/** 删除本人上传的云端技能。 */
export const deleteUserCloudSkill = (cfg: TanguDesktopConfig, id: string) =>
  request<{ ok: boolean }>(cfg, `/agent/skills/user/${encodeURIComponent(id)}`, { method: 'DELETE' })

export const listTools = (cfg: TanguDesktopConfig) => request<ToolsResponse>(cfg, '/agent/tools')

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
  cfg: TanguDesktopConfig,
  input: { session_id?: string; model_id?: string; approval_mode?: string },
) =>
  request<{ loginId: string; qrcode: string; qrcodeImg: string; expiresAt: number }>(cfg, '/agent/wechat/login/start', {
    method: 'POST',
    body: JSON.stringify(input),
  })

export const pollWechatLogin = (cfg: TanguDesktopConfig, loginId: string) =>
  request<{ status: string; accountId?: string; sessionId?: string; detail?: string }>(
    cfg,
    `/agent/wechat/login/status?loginId=${encodeURIComponent(loginId)}`,
  )

export const getWechatStatus = (cfg: TanguDesktopConfig) =>
  request<WechatStatusResponse>(cfg, '/agent/wechat/status')

export const disconnectWechat = (cfg: TanguDesktopConfig, accountId: string) =>
  request<{ ok: boolean }>(cfg, '/agent/wechat/disconnect', {
    method: 'POST',
    body: JSON.stringify({ account_id: accountId }),
  })

/** 「微信远程」Project 下的会话(connected=正在连接的那个)。 */
export interface WechatProjectSession {
  id: string
  title: string
  updated_at: string | number | null
  connected: boolean
}

/** 列出微信 Project(~/Tangu/webot)下的会话,供主界面选择「正在连接的 session」。 */
export const listWechatSessions = (cfg: TanguDesktopConfig) =>
  request<{ sessions: WechatProjectSession[] }>(cfg, '/agent/wechat/sessions').then((r) => r.sessions)

/** 切换「正在连接的 session」(微信 bot 收到的消息改走该会话)。 */
export const setWechatConnectedSession = (cfg: TanguDesktopConfig, sessionId: string) =>
  request<{ ok: boolean }>(cfg, '/agent/wechat/connect', { method: 'POST', body: JSON.stringify({ session_id: sessionId }) })

/** 在微信 Project 下新建会话并(默认)切为正在连接。 */
export const createWechatSession = (cfg: TanguDesktopConfig, title?: string) =>
  request<{ sessionId: string }>(cfg, '/agent/wechat/sessions/new', { method: 'POST', body: JSON.stringify({ title }) }).then((r) => r.sessionId)

// ── Normal Agent（本地自定义人格;仅本地后端可用,云端返回 404 → 调用方降级空列表）──
export const listAgents = (cfg: TanguDesktopConfig) =>
  request<{ agents: NormalAgentDef[] }>(cfg, '/agent/agents').then((r) => r.agents).catch(() => [] as NormalAgentDef[])

export const saveAgentDef = (cfg: TanguDesktopConfig, def: Partial<NormalAgentDef>, slug?: string) =>
  request<{ agent: NormalAgentDef }>(
    cfg,
    slug ? `/agent/agents/${encodeURIComponent(slug)}` : '/agent/agents',
    { method: slug ? 'PATCH' : 'POST', body: JSON.stringify(def) },
  ).then((r) => r.agent)

export const deleteAgentDef = (cfg: TanguDesktopConfig, slug: string) =>
  request<{ ok: boolean }>(cfg, `/agent/agents/${encodeURIComponent(slug)}`, { method: 'DELETE' })

// ── Special Agents（Historian / Muse;本地后端）──
export const getSpecialConfig = (cfg: TanguDesktopConfig) =>
  request<{ config: SpecialAgentsConfig; defaults?: { historianPrompt: string; musePrompt: string } }>(cfg, '/agent/special/config')

export const saveSpecialConfig = (cfg: TanguDesktopConfig, patch: Partial<SpecialAgentsConfig>) =>
  request<{ config: SpecialAgentsConfig }>(cfg, '/agent/special/config', { method: 'POST', body: JSON.stringify(patch) }).then((r) => r.config)

export const getHistorianActivity = (cfg: TanguDesktopConfig, limit = 50) =>
  request<{ activity: HistorianActivityItem[] }>(cfg, `/agent/special/historian/activity?limit=${limit}`).then((r) => r.activity)

export const getMuseTodos = (cfg: TanguDesktopConfig, status?: string) =>
  request<{ todos: MuseTodo[] }>(cfg, `/agent/special/muse/todos${status ? `?status=${encodeURIComponent(status)}` : ''}`).then((r) => r.todos)

export const patchMuseTodo = (cfg: TanguDesktopConfig, id: string, status: MuseTodo['status']) =>
  request<{ ok: boolean }>(cfg, `/agent/special/muse/todos/${encodeURIComponent(id)}`, { method: 'PATCH', body: JSON.stringify({ status }) })

export const injectMuseTodos = (cfg: TanguDesktopConfig, todoIds: string[], sessionId: string) =>
  request<{ ok: boolean; runId: string }>(cfg, '/agent/special/muse/todos/inject', { method: 'POST', body: JSON.stringify({ todoIds, sessionId }) })

export const getMuseStatus = (cfg: TanguDesktopConfig) =>
  request<{ status: MuseStatusInfo }>(cfg, '/agent/special/muse/status').then((r) => r.status)

// ── 记忆 / 日志 ──
export const getMemory = (cfg: TanguDesktopConfig) =>
  request<{ content: string; updatedAt: any }>(cfg, '/agent/memory')

export const appendMemory = (cfg: TanguDesktopConfig, text: string) =>
  request<{ appended: boolean; reason?: string }>(cfg, '/agent/memory', {
    method: 'POST',
    body: JSON.stringify({ text }),
  })

export const getLog = (cfg: TanguDesktopConfig, date?: string) =>
  request<{ date: string; content: string; updatedAt: any }>(
    cfg, `/agent/log${date ? `?date=${encodeURIComponent(date)}` : ''}`,
  )

// ── 工作区 ──
export const listWorkspace = (cfg: TanguDesktopConfig, sessionId: string) =>
  request<{ files: WorkspaceFileMeta[] }>(
    cfg, `/agent/workspace/list?sessionId=${encodeURIComponent(sessionId)}`,
  ).then((r) => r.files)

export const readWorkspaceFile = (cfg: TanguDesktopConfig, sessionId: string, path: string) =>
  request<{ path: string; mimeType: string; content: string; encoding: 'base64'; size: number }>(
    cfg, `/agent/workspace/read?sessionId=${encodeURIComponent(sessionId)}&path=${encodeURIComponent(path)}`,
  )

export const workspaceDownloadUrl = (cfg: TanguDesktopConfig, sessionId: string, path: string) =>
  `${cfg.backendUrl}/agent/workspace/download?sessionId=${encodeURIComponent(sessionId)}&path=${encodeURIComponent(path)}`

/** 下载工作区文件(fetch 带 Bearer → blob → 触发保存)。 */
export async function downloadWorkspaceFile(cfg: TanguDesktopConfig, sessionId: string, path: string): Promise<void> {
  const r = await fetch(workspaceDownloadUrl(cfg, sessionId, path), { headers: headers(cfg.token) })
  if (!r.ok) throw new Error(`下载失败 (${r.status})`)
  const blob = await r.blob()
  const a = document.createElement('a')
  a.href = URL.createObjectURL(blob)
  a.download = path.split('/').filter(Boolean).pop() || 'file'
  a.click()
  setTimeout(() => URL.revokeObjectURL(a.href), 5000)
}

export const uploadWorkspaceFiles = (
  cfg: TanguDesktopConfig,
  sessionId: string,
  files: Array<{ path: string; content: string; encoding?: 'base64'; mimeType?: string }>,
) =>
  request<{ success: boolean; saved: number; total: number; errors: string[] }>(cfg, '/agent/workspace/upload', {
    method: 'POST',
    body: JSON.stringify({ sessionId, files }),
  })

export const deleteWorkspaceFile = (cfg: TanguDesktopConfig, sessionId: string, path: string) =>
  request<{ ok: boolean }>(cfg, '/agent/workspace/delete', {
    method: 'POST',
    body: JSON.stringify({ sessionId, path }),
  })
