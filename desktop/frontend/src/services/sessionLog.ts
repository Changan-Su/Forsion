/**
 * 「当前会话日志」打包器 —— 设置·高级「导出日志」与「反馈弹窗附件」共用,保证两处口径一致。
 * 对话/会话配置走后端 REST(messages 取后端硬上限 500 条);后端日志走主进程托管缓冲(仅 managed 有)。
 */
import { listMessages, getSessionConfig } from './backendService'
import type { SessionRecord, TanguDesktopConfig } from '../types'

export async function buildSessionLogPayload(cfg: TanguDesktopConfig, session: SessionRecord): Promise<any> {
  const [messages, agentConfig, backendLogs, stored, appVersion] = await Promise.all([
    listMessages(cfg, session.id, 500).catch(() => []),
    getSessionConfig(cfg, session.id).catch(() => ({})),
    window.tangu?.backendLogs?.().catch(() => []) ?? Promise.resolve([]),
    window.tangu?.getConfig().catch(() => null) ?? Promise.resolve(null),
    window.tangu?.appVersion?.().catch(() => null) ?? Promise.resolve(null),
  ])
  const connectionMode = stored?.mode || 'external'
  return {
    exportedAt: new Date().toISOString(),
    app: 'Tangu Agent Desktop',
    appVersion: appVersion || null,
    connectionMode,
    backendLogsAvailable: connectionMode === 'managed',
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
