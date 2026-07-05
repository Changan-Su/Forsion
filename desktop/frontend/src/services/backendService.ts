/**
 * M3 数据 API 薄封装(sessions/models/memory/skills/tools/workspace)。
 * 统一 Bearer + JSON 错误,错误信息抛 Error(detail)。
 */
import type {
  AgentConfig, AgentsMeta, HistorianActivityItem, MessageRecord, ModelsResponse, MuseStatusInfo, MuseTodo,
  NormalAgentDef, SessionRecord, SkillInfo, SpecialAgentsConfig,
  TanguDesktopConfig, ToolsResponse, WorkspaceFileMeta,
} from '../types'
import { authFetch } from './http'
import { localInbox } from './localInbox' // 移动端(window.tangu?.mobile)下 inbox 走设备本地存储

function headers(token: string): Record<string, string> {
  return { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }
}

async function request<T>(cfg: TanguDesktopConfig, path: string, init?: RequestInit): Promise<T> {
  const r = await authFetch(`${cfg.backendUrl}${path}`, { ...init, headers: headers(cfg.token) })
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
export const syncNow = (cfg: TanguDesktopConfig) =>
  request<SyncRunResult>(cfg, '/agent/sync', { method: 'POST' })
export const getSyncStatus = (cfg: TanguDesktopConfig) =>
  request<SyncStatusResult>(cfg, '/agent/sync/status')

// ── 百炼音色管理(声音复刻/声音设计;后端代理免 CORS,key 只在请求中过境)──
export type TtsVoiceKind = 'clone' | 'design' | 'cosy' // clone=qwen复刻 design=qwen设计 cosy=CosyVoice复刻
export interface TtsVoiceInfo { voice: string; kind: TtsVoiceKind; targetModel?: string }
export const listTtsVoices = (cfg: TanguDesktopConfig, body: { baseUrl: string; apiKey: string }) =>
  request<{ voices: TtsVoiceInfo[] }>(cfg, '/agent/tts/voices/list', { method: 'POST', body: JSON.stringify(body) }).then((r) => r.voices)
// engine 缺省 qwen(audioData=base64);engine='cosy' 走 CosyVoice 复刻(audioUrl=公网 URL,百炼不收 base64)。
export const cloneTtsVoice = (cfg: TanguDesktopConfig, body: { baseUrl: string; apiKey: string; name: string; engine?: 'qwen' | 'cosy'; audioData?: string; audioUrl?: string; targetModel?: string }) =>
  request<{ voice: string; targetModel: string }>(cfg, '/agent/tts/voices/clone', { method: 'POST', body: JSON.stringify(body) })
export const designTtsVoice = (cfg: TanguDesktopConfig, body: { baseUrl: string; apiKey: string; name: string; voicePrompt: string; previewText?: string; targetModel?: string }) =>
  request<{ voice: string; targetModel: string; previewAudio?: { data: string; sampleRate: number; format: string } }>(cfg, '/agent/tts/voices/design', { method: 'POST', body: JSON.stringify(body) })
export const deleteTtsVoice = (cfg: TanguDesktopConfig, body: { baseUrl: string; apiKey: string; voice: string; kind: TtsVoiceKind }) =>
  request<{ ok: boolean }>(cfg, '/agent/tts/voices/delete', { method: 'POST', body: JSON.stringify(body) })

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

/** 从某条消息(含)处分支出新会话:继承到该点为止的历史(区别于空的新会话)。返回新会话。 */
export const branchSession = (cfg: TanguDesktopConfig, sessionId: string, messageId: string, title?: string) =>
  request<{ session: SessionRecord; copied: number }>(
    cfg, `/agent/sessions/${encodeURIComponent(sessionId)}/branch`,
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
}
export const getBackgroundSessions = (cfg: TanguDesktopConfig, sessionId: string) =>
  request<{ background: BackgroundSessionInfo[] }>(
    cfg, `/agent/sessions/${encodeURIComponent(sessionId)}/background`,
  ).then((r) => r.background)

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

export interface EngineAssets {
  skills: Array<{ name: string; description: string; imported: boolean }>
  mcp: Array<{ name: string; command?: string; args?: string[]; url?: string; imported: boolean }>
}

/** 列出某引擎已装的 skills + mcp(设置页「Agent CLIs」二级面板)。云端/失败 → 空。 */
export const listEngineAssets = (cfg: TanguDesktopConfig, engineId: string) =>
  request<EngineAssets>(cfg, `/agent/engines/${encodeURIComponent(engineId)}/assets`)
    .then((r) => ({ skills: r.skills || [], mcp: r.mcp || [] }))
    .catch(() => ({ skills: [], mcp: [] } as EngineAssets))

/** 导入一个引擎资产到 Tangu(kind: 'skill' | 'mcp')。 */
export const importEngineAsset = (cfg: TanguDesktopConfig, engineId: string, kind: 'skill' | 'mcp', name: string) =>
  request<{ ok: boolean }>(cfg, `/agent/engines/${encodeURIComponent(engineId)}/import`, {
    method: 'POST',
    body: JSON.stringify({ kind, name }),
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
  agentSlug?: string | null
}

/** 列出微信 Project(~/Tangu/webot)下的会话,供主界面选择「正在连接的 session」。 */
export const listWechatSessions = (cfg: TanguDesktopConfig) =>
  request<{ sessions: WechatProjectSession[] }>(cfg, '/agent/wechat/sessions').then((r) => r.sessions)

/** 切换「正在连接的 session」(微信 bot 收到的消息改走该会话)。 */
export const setWechatConnectedSession = (cfg: TanguDesktopConfig, sessionId: string) =>
  request<{ ok: boolean }>(cfg, '/agent/wechat/connect', { method: 'POST', body: JSON.stringify({ session_id: sessionId }) })

/** 设置某微信会话使用的 Normal Agent。 */
export const setWechatSessionAgent = (cfg: TanguDesktopConfig, sessionId: string, agentSlug: string) =>
  request<{ ok: boolean }>(cfg, '/agent/wechat/session-agent', { method: 'POST', body: JSON.stringify({ session_id: sessionId, agent_slug: agentSlug }) })

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

/** 上传头像(data URL 或纯 base64;≤1MB;后端写进该 agent 的 Library/ 并设 config.avatar)。 */
export const uploadAgentAvatar = (cfg: TanguDesktopConfig, slug: string, data: string, mimeType: string) =>
  request<{ ok: boolean; avatar: string }>(cfg, `/agent/agents/${encodeURIComponent(slug)}/avatar`,
    { method: 'POST', body: JSON.stringify({ data, mimeType }) })

/** 删除头像(移除文件并清空 config.avatar)。 */
export const deleteAgentAvatar = (cfg: TanguDesktopConfig, slug: string) =>
  request<{ ok: boolean }>(cfg, `/agent/agents/${encodeURIComponent(slug)}/avatar`, { method: 'DELETE' })

/** 拉头像为 object URL(带鉴权;无/失败返回 null)。调用方负责 URL.revokeObjectURL。 */
export async function fetchAgentAvatar(cfg: TanguDesktopConfig, slug: string): Promise<string | null> {
  try {
    const r = await authFetch(`${cfg.backendUrl}/agent/agents/${encodeURIComponent(slug)}/avatar`, { headers: headers(cfg.token) })
    if (!r.ok) return null
    return URL.createObjectURL(await r.blob())
  } catch { return null }
}

/** 列表顺序 + 默认 agent。 */
export const getAgentsMeta = (cfg: TanguDesktopConfig) =>
  request<AgentsMeta>(cfg, '/agent/agents-meta').catch(() => ({ order: [], defaultSlug: 'xyra' } as AgentsMeta))
export const putAgentsMeta = (cfg: TanguDesktopConfig, patch: Partial<AgentsMeta>) =>
  request<AgentsMeta>(cfg, '/agent/agents-meta', { method: 'PUT', body: JSON.stringify(patch) })

// 某 agent 的 MEMORY / LOG(按 slug 读其文件夹)。
export const getAgentMemory = (cfg: TanguDesktopConfig, slug: string) =>
  request<{ content: string }>(cfg, `/agent/agents/${encodeURIComponent(slug)}/memory`).then((r) => r.content).catch(() => '')
export const putAgentMemory = (cfg: TanguDesktopConfig, slug: string, content: string) =>
  request<{ ok: boolean }>(cfg, `/agent/agents/${encodeURIComponent(slug)}/memory`, { method: 'PUT', body: JSON.stringify({ content }) })
export const listAgentLogDates = (cfg: TanguDesktopConfig, slug: string) =>
  request<{ dates: string[] }>(cfg, `/agent/agents/${encodeURIComponent(slug)}/logs`).then((r) => r.dates).catch(() => [] as string[])
export const getAgentLog = (cfg: TanguDesktopConfig, slug: string, date: string) =>
  request<{ date: string; content: string }>(cfg, `/agent/agents/${encodeURIComponent(slug)}/log?date=${encodeURIComponent(date)}`).then((r) => r.content).catch(() => '')
export const putAgentLog = (cfg: TanguDesktopConfig, slug: string, date: string, content: string) =>
  request<{ ok: boolean }>(cfg, `/agent/agents/${encodeURIComponent(slug)}/log?date=${encodeURIComponent(date)}`, { method: 'PUT', body: JSON.stringify({ content }) })

// 某 agent 的 Library 文件(列表 / 读 / 写 / 删;用 agent 自身 slug)。
export type AgentLibraryFile = { name: string; size: number; isBinary: boolean; mtimeMs: number }
export const listAgentLibrary = (cfg: TanguDesktopConfig, slug: string) =>
  request<{ files: AgentLibraryFile[] }>(cfg, `/agent/agents/${encodeURIComponent(slug)}/library`).then((r) => r.files).catch(() => [] as AgentLibraryFile[])
export const getAgentLibraryFile = (cfg: TanguDesktopConfig, slug: string, name: string) =>
  request<{ name: string; isBinary: boolean; content?: string; dataBase64?: string; mimeType?: string }>(
    cfg, `/agent/agents/${encodeURIComponent(slug)}/library/file?name=${encodeURIComponent(name)}`)
export const putAgentLibraryFile = (cfg: TanguDesktopConfig, slug: string, name: string, body: { content?: string; dataBase64?: string; isBinary?: boolean }) =>
  request<{ ok: boolean; name: string }>(cfg, `/agent/agents/${encodeURIComponent(slug)}/library/file`, { method: 'POST', body: JSON.stringify({ name, ...body }) })
export const deleteAgentLibraryFile = (cfg: TanguDesktopConfig, slug: string, name: string) =>
  request<{ ok: boolean }>(cfg, `/agent/agents/${encodeURIComponent(slug)}/library/file?name=${encodeURIComponent(name)}`, { method: 'DELETE' })

// 全局用户画像 USER.md。
export const getUserProfile = (cfg: TanguDesktopConfig) =>
  request<{ content: string }>(cfg, '/agent/user-profile').then((r) => r.content).catch(() => '')
export const putUserProfile = (cfg: TanguDesktopConfig, content: string) =>
  request<{ ok: boolean }>(cfg, '/agent/user-profile', { method: 'PUT', body: JSON.stringify({ content }) })

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
  scopes: Array<'global' | 'agent'>; settings: { fields: PluginField[] } | null; source: 'builtin' | 'folder'; enabled: boolean
  /** 运行期激活但贡献了路由,需重启才完整生效。 */
  needsRestart?: boolean
}
export const listPlugins = (cfg: TanguDesktopConfig) =>
  request<{ plugins: PluginInfo[] }>(cfg, '/agent/plugins').then((r) => r.plugins).catch(() => [] as PluginInfo[])
/** 运行期重扫:市场装新插件后即生效(无需重启)。addedIds=新激活的;needsRestart=贡献路由的插件需重启。 */
export const rescanPlugins = (cfg: TanguDesktopConfig) =>
  request<{ ok: boolean; addedIds: string[]; needsRestart: boolean; plugins: PluginInfo[] }>(cfg, '/agent/plugins/rescan', { method: 'POST' })
export const setPluginEnabled = (cfg: TanguDesktopConfig, id: string, enabled: boolean) =>
  request<{ ok: boolean; enabled: boolean }>(cfg, `/agent/plugins/${encodeURIComponent(id)}/enabled`, { method: 'PUT', body: JSON.stringify({ enabled }) })
/** 卸载数据清理(注销 meta + 清设置/blob);文件夹删除与重启由桌面侧 IPC 负责。 */
export const uninstallPlugin = (cfg: TanguDesktopConfig, id: string) =>
  request<{ ok: boolean; restartRequired: boolean }>(cfg, `/agent/plugins/${encodeURIComponent(id)}`, { method: 'DELETE' })
export const getPluginSettings = (cfg: TanguDesktopConfig, id: string, scope: string) =>
  request<{ values: Record<string, any> }>(cfg, `/agent/plugins/${encodeURIComponent(id)}/settings?scope=${encodeURIComponent(scope)}`).then((r) => r.values)
export const putPluginSettings = (cfg: TanguDesktopConfig, id: string, scope: string, patch: Record<string, any>) =>
  request<{ ok: boolean; values: Record<string, any> }>(cfg, `/agent/plugins/${encodeURIComponent(id)}/settings?scope=${encodeURIComponent(scope)}`, { method: 'PUT', body: JSON.stringify({ patch }) }).then((r) => r.values)
export type PluginFile = { name: string; size: number; mimeType: string; dataBase64?: string }
export const listPluginFiles = (cfg: TanguDesktopConfig, id: string, scope: string) =>
  request<{ files: PluginFile[] }>(cfg, `/agent/plugins/${encodeURIComponent(id)}/files?scope=${encodeURIComponent(scope)}`).then((r) => r.files).catch(() => [] as PluginFile[])
export const addPluginFile = (cfg: TanguDesktopConfig, id: string, scope: string, name: string, dataBase64: string) =>
  request<{ ok: boolean; name: string }>(cfg, `/agent/plugins/${encodeURIComponent(id)}/files?scope=${encodeURIComponent(scope)}`, { method: 'POST', body: JSON.stringify({ name, dataBase64 }) })
export const deletePluginFile = (cfg: TanguDesktopConfig, id: string, scope: string, name: string) =>
  request<{ ok: boolean }>(cfg, `/agent/plugins/${encodeURIComponent(id)}/files?scope=${encodeURIComponent(scope)}&name=${encodeURIComponent(name)}`, { method: 'DELETE' })

// ── Special Agents（Historian / Muse;本地后端）──
export const getSpecialConfig = (cfg: TanguDesktopConfig) =>
  request<{ config: SpecialAgentsConfig; defaults?: { historianPrompt: string } }>(cfg, '/agent/special/config')

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

// ── Lifecycle Hooks（本地后端；host-only shell 回调）──
export type HookDiscovered = {
  key: string; matcher: string; command: string; commandWindows: string; timeout: number;
  statusMessage: string; source: string; trust: 'trusted' | 'needs-review' | 'managed'; enabled: boolean; active: boolean
}
export type HooksData = { events: Record<string, any>; discovered: Record<string, HookDiscovered[]>; eventNames: string[] }

export const getHooks = (cfg: TanguDesktopConfig) =>
  request<HooksData>(cfg, '/agent/hooks')
export const saveHooks = (cfg: TanguDesktopConfig, events: Record<string, any>) =>
  request<Pick<HooksData, 'events' | 'discovered'>>(cfg, '/agent/hooks', { method: 'PUT', body: JSON.stringify({ events }) })
export const trustHookReq = (cfg: TanguDesktopConfig, key: string) =>
  request<{ discovered: Record<string, HookDiscovered[]> }>(cfg, '/agent/hooks/trust', { method: 'POST', body: JSON.stringify({ key }) })
export const enableHookReq = (cfg: TanguDesktopConfig, key: string, enabled: boolean) =>
  request<{ discovered: Record<string, HookDiscovered[]> }>(cfg, '/agent/hooks/enable', { method: 'POST', body: JSON.stringify({ key, enabled }) })

// ── 记忆 / 日志 ──
export const getMemory = (cfg: TanguDesktopConfig) =>
  request<{ content: string; updatedAt: any }>(cfg, '/agent/memory')

export const appendMemory = (cfg: TanguDesktopConfig, text: string, slug?: string) =>
  request<{ appended: boolean; reason?: string }>(cfg, '/agent/memory', {
    method: 'POST',
    body: JSON.stringify({ text, slug }),
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
  const r = await authFetch(workspaceDownloadUrl(cfg, sessionId, path), { headers: headers(cfg.token) })
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

// ── Inbox(收件箱)──
// 时间字段为 UTC 'YYYY-MM-DD HH:MM:SS' 无时区后缀,前端解析统一 new Date(s.replace(' ','T')+'Z')。
export interface InboxMessage {
  id: string
  title: string
  body: string
  sender_kind: 'agent' | 'server' | 'system'
  sender_id: string | null
  origin_broadcast_id: string | null
  deliver_at: string | null
  read_at: string | null
  archived_at: string | null
  created_at: string | null
}
export type InboxFilter = 'all' | 'unread' | 'archived' | 'scheduled'

// 移动端(window.tangu?.mobile)inbox 走设备本地存储(localInbox);桌面/web 走远程 /agent/inbox。
export const listInbox = (cfg: TanguDesktopConfig, filter: InboxFilter = 'all') =>
  window.tangu?.mobile
    ? localInbox.list(filter)
    : request<{ messages: InboxMessage[] }>(cfg, `/agent/inbox?filter=${filter}&limit=200`).then((r) => r.messages)

export const getInboxUnreadCount = (cfg: TanguDesktopConfig) =>
  window.tangu?.mobile
    ? localInbox.unreadCount()
    : request<{ count: number; latestId: string | null }>(cfg, '/agent/inbox/unread-count')

export const patchInboxMessage = (cfg: TanguDesktopConfig, id: string, patch: { read?: boolean; archived?: boolean }) =>
  window.tangu?.mobile
    ? localInbox.patch(id, patch)
    : request<{ ok: boolean }>(cfg, `/agent/inbox/${encodeURIComponent(id)}`, { method: 'PATCH', body: JSON.stringify(patch) })

export const readAllInbox = (cfg: TanguDesktopConfig) =>
  window.tangu?.mobile
    ? localInbox.readAll()
    : request<{ ok: boolean }>(cfg, '/agent/inbox/read-all', { method: 'POST' })

export const deleteInboxMessage = (cfg: TanguDesktopConfig, id: string) =>
  window.tangu?.mobile
    ? localInbox.remove(id)
    : request<{ ok: boolean }>(cfg, `/agent/inbox/${encodeURIComponent(id)}`, { method: 'DELETE' })

export const pullInbox = (cfg: TanguDesktopConfig) =>
  window.tangu?.mobile
    ? localInbox.pull(cfg)
    : request<{ pulled: boolean; added: number; detail?: string }>(cfg, '/agent/inbox/pull', { method: 'POST' })
