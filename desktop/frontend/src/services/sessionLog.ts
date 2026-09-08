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

export async function buildSessionLogPayload(cfg: TanguDesktopConfig, session: SessionRecord): Promise<any> {
  const [messages, agentConfig, backendLogs, stored, appVersion, backendStatus, usage, timeline] = await Promise.all([
    listMessages(cfg, session.id, 500).catch(() => []),
    getSessionConfig(cfg, session.id).catch(() => ({})),
    window.tangu?.backendLogs?.().catch(() => []) ?? Promise.resolve([]),
    window.tangu?.getConfig().catch(() => null) ?? Promise.resolve(null),
    window.tangu?.appVersion?.().catch(() => null) ?? Promise.resolve(null),
    // 桌面独有(web/mobile 垫片没有,也是 isDesktop 的判定口):可选调用,null = 没有宿主,不是宿主挂了。
    window.tangu?.backendStatus?.().catch(() => null) ?? Promise.resolve(null),
    // 回到路由的原始字段名({tokensTotal, contextTokens}),方便对着 /agent/sessions/:id/usage 核对。
    getSessionUsage(cfg, session.id).then((u) => ({ tokensTotal: u.base, contextTokens: u.ctx })).catch(() => null),
    // 事件时间线骨架(无正文):回答「秒数去哪了」——没有它,导出只能看见模型说了什么,看不见等在哪。
    getSessionTimeline(cfg, session.id).catch(() => null),
  ])
  const connectionMode = stored?.mode || 'external'
  return {
    exportedAt: new Date().toISOString(),
    app: 'Tangu Agent Desktop',
    appVersion: appVersion || null,
    connectionMode,
    backendLogsAvailable: connectionMode === 'managed',
    client: snapshotClient(),
    uiState: snapshotUiState(),
    uiActionLog: [...uiActionLog],
    rendererErrors: [...rendererErrors],
    backendStatusAvailable: !!window.tangu?.backendStatus,
    backendStatus,
    usage,
    timeline,
    session: {
      id: session.id, title: session.title, model_id: session.model_id,
      project_path: session.project_path ?? null, project_name: session.project_name ?? null,
      projectless: !!session.projectless,
      created_at: session.created_at, updated_at: session.updated_at,
    },
    agentConfig,
    messageCount: messages.length,
    messagesTruncated: messages.length >= 500,
    messages,
    backendLogs,
  }
}

/** 导出文件名:tangu-session-<id8>-<YYYY-MM-DD>.json。 */
export function sessionLogFilename(session: SessionRecord): string {
  return `tangu-session-${session.id.slice(0, 8)}-${new Date().toISOString().slice(0, 10)}.json`
}
