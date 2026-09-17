/**
 * 「当前会话日志」打包器 —— 设置·高级「导出日志」与「反馈弹窗附件」共用,保证两处口径一致。
 * 对话/会话配置走后端 REST(messages 取后端硬上限 500 条);后端日志走主进程托管缓冲(仅 managed 有)。
 *
 * 除对话本身,还带渲染端这一侧的**实况**:端/环境、界面实际状态、界面动作轨迹、渲染端错误、引擎状态、用量。
 * 2026-09-05 一份只有对话的导出,看得见模型说「还是深色」,看不见界面其实已经是浅色 —— 没有渲染端
 * 的真相就只能相信模型的转述。⚠️ 一律手挑字段:cfg / stored 里有 token,绝不整份序列化。
 */
import { listMessages, getSessionConfig, getSessionUsage, getSessionTimeline } from './backendService'
import { currentClientId } from './agentRunService'
import { readUiSettings, buildCommandCatalog } from '../agentCommands'
import { rendererErrors, uiActionLog } from '../diag'
import type { SessionRecord, TanguDesktopConfig } from '../types'

/** 导出那一刻界面的**实际**状态:设置值+值域、documentElement 上的主题属性(用户眼里的真相)、模型可见的命令目录。 */
function snapshotUiState(): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  try { out.settings = readUiSettings() } catch (e) { out.settingsError = String((e as Error)?.message || e) }
  try { out.dom = { ...document.documentElement.dataset } } catch { /* ignore */ }
  try { out.commands = buildCommandCatalog().map((c) => c.id) } catch { /* ignore */ }
  return out
}

function snapshotClient(): Record<string, unknown> {
  try {
    return {
      id: currentClientId(),
      userAgent: navigator.userAgent,
      language: navigator.language,
      online: navigator.onLine,
      viewport: [window.innerWidth, window.innerHeight],
      devicePixelRatio: window.devicePixelRatio,
      reducedMotion: (() => { try { return window.matchMedia('(prefers-reduced-motion: reduce)').matches } catch { return null } })(),
      systemDark: (() => { try { return window.matchMedia('(prefers-color-scheme: dark)').matches } catch { return null } })(),
    }
  } catch { return {} }
}

export interface SessionLogOptions {
  diagnostics?: boolean
  conversation?: boolean
  activity?: boolean
}

/** 选项只影响反馈；设置页不传选项时仍导出完整会话日志。未勾选的来源不会读取。 */
export async function buildSessionLogPayload(
  cfg: TanguDesktopConfig, session: SessionRecord | null,
  { diagnostics = true, conversation = true, activity = false }: SessionLogOptions = {},
): Promise<Record<string, any>> {
  const sources: Record<string, 'included' | 'unavailable' | 'failed'> = {}
  const read = async <T,>(key: string, task: (() => Promise<T>) | undefined, fallback: T): Promise<T> => {
    if (!task) { sources[key] = 'unavailable'; return fallback }
    try {
      // A stalled host must not keep the feedback panel waiting indefinitely.
      let timer: ReturnType<typeof setTimeout> | undefined
      try {
        const value = await Promise.race([task(), new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error('diagnostics-timeout')), 8000)
        })])
        sources[key] = 'included'
        return value
      } finally { clearTimeout(timer) }
    } catch { sources[key] = 'failed'; return fallback }
  }
  const host = window.tangu
  const [messages, agentConfig, backendLogs, stored, appVersion, backendStatus, usage, timeline, activityLog] = await Promise.all([
    conversation && session ? read('messages', () => listMessages(cfg, session.id, 500), []) : undefined,
    diagnostics && session ? read('agentConfig', () => getSessionConfig(cfg, session.id), {}) : undefined,
    diagnostics ? read('backendLogs', host?.backendLogs ? () => host.backendLogs!() : undefined, []) : undefined,
    diagnostics ? read('connection', host?.getConfig ? () => host.getConfig() : undefined, null) : null,
    read('appVersion', host?.appVersion ? () => host.appVersion!() : undefined, null),
    diagnostics ? read('backendStatus', host?.backendStatus ? () => host.backendStatus!() : undefined, null) : undefined,
    diagnostics && session ? read('usage', () => getSessionUsage(cfg, session.id)
      .then((u) => ({ tokensTotal: u.base, contextTokens: u.ctx })), null) : undefined,
    diagnostics && session ? read('timeline', () => getSessionTimeline(cfg, session.id), null) : undefined,
    activity ? read('activityLog', host?.exportActivity ? () => host.exportActivity!(2) : undefined, '') : undefined,
  ])
  const connectionMode = stored?.mode || 'external'
  const activityLines = activityLog?.split('\n').filter(Boolean)
  return {
    schemaVersion: 2,
    exportedAt: new Date().toISOString(),
    app: 'Tangu Agent Desktop',
    appVersion: appVersion || null,
    sources,
    ...(diagnostics ? {
      connectionMode,
      backendLogsAvailable: !!host?.backendLogs && connectionMode === 'managed',
      client: snapshotClient(),
      uiState: snapshotUiState(),
      uiActionLog: [...uiActionLog],
      rendererErrors: [...rendererErrors],
      backendStatusAvailable: !!host?.backendStatus,
      backendStatus, usage, timeline, agentConfig, backendLogs,
    } : {}),
    session: session ? {
      id: session.id, title: session.title, model_id: session.model_id,
      project_path: session.project_path ?? null, project_name: session.project_name ?? null,
      projectless: !!session.projectless,
      created_at: session.created_at, updated_at: session.updated_at,
    } : null,
    ...(conversation && session ? {
      messageCount: messages?.length ?? 0,
      messagesTruncated: (messages?.length ?? 0) >= 500,
      messages,
    } : {}),
    ...(activity ? {
      activityLog: activityLines?.slice(-500).join('\n') || '',
      activityLogTruncated: (activityLines?.length ?? 0) > 500,
      activityDays: 2,
    } : {}),
  }
}

/** 导出文件名:tangu-session-<id8>-<YYYY-MM-DD>.json。 */
export function sessionLogFilename(session: SessionRecord): string {
  return `tangu-session-${session.id.slice(0, 8)}-${new Date().toISOString().slice(0, 10)}.json`
}
