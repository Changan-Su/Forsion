/**
 * 连接器(商店「连接器」分类与设置 → MCP 服务器顶部那一块共用):主进程写 MCP 配置(electron/connectorCatalog.ts),
 * 登录 / 填 Key / 断开走本机引擎(/agent/mcp/:name/login|key|logout)。目录与令牌都和 Forsion 账号无关,不用登录。
 */
import type { ConnectorEntry, ToolsResponse } from '../types'
import { listTools, mcpLogin, mcpLogout, mcpSetKey } from './backendService'
import { homeTarget } from './engine/targets'

export type McpRow = NonNullable<ToolsResponse['mcp']>[number]
export const connectorsSupported = (): boolean => !!window.tangu?.connectorsList
export const connectorName = (c: ConnectorEntry, locale: string): string => (locale === 'zh' ? c.name.zh : c.name.en)
export const connectorDescription = (c: ConnectorEntry, locale: string): string => (locale === 'zh' ? c.description.zh : c.description.en)

/** 引擎里带连接器标记的那些行(按目录 id)。 */
export async function connectorRows(): Promise<Map<string, McpRow>> {
  const rows = (await listTools(homeTarget())).mcp ?? []
  return new Map(rows.filter((r) => r.connector && !r.origin).map((r) => [r.connector!, r]))
}

/** 等引擎接上刚写的条目、首次连接落定。有回复正在生成时引擎不重载配置(不在 run 中途换工具),等不到就如实报。 */
async function settled(name: string): Promise<McpRow | undefined> {
  const end = Date.now() + 30_000
  for (;;) {
    const row = (await listTools(homeTarget())).mcp?.find((r) => r.server === name)
    if ((row && row.status !== 'connecting') || Date.now() > end) return row
    await new Promise((r) => setTimeout(r, 500))
  }
}

export type ConnectResult =
  | { kind: 'connected'; name: string }
  | { kind: 'browser'; name: string } // 已开浏览器,等用户在那头登录完
  | { kind: 'needs-key'; name: string }
  | { kind: 'pending'; name: string } // 引擎还没接上(有回复在生成)
  | { kind: 'error'; name: string; message: string }

export async function connectConnector(c: ConnectorEntry): Promise<ConnectResult> {
  const { name } = await window.tangu!.connectorsConnect!(c.id)
  const row = await settled(name)
  if (!row) return { kind: 'pending', name }
  if (row.status === 'connected') return { kind: 'connected', name }
  if (row.auth === 'user-key') return { kind: 'needs-key', name }
  if (row.status === 'needs-login' || row.status === 'logging-in') return loginConnector(name)
  return { kind: 'error', name, message: row.error || '' }
}

export async function loginConnector(name: string): Promise<ConnectResult> {
  const r = await mcpLogin(homeTarget(), name)
  if (!r.url) return { kind: 'connected', name } // 刷新就成了
  await window.tangu?.openExternal?.(r.url)
  return { kind: 'browser', name }
}

export async function submitConnectorKey(name: string, key: string): Promise<ConnectResult> {
  const r = await mcpSetKey(homeTarget(), name, key)
  return r.status === 'connected' ? { kind: 'connected', name } : r.status === 'needs-login' ? { kind: 'needs-key', name } : { kind: 'error', name, message: r.error || '' }
}

/** 断开 = 删本机令牌 / Key,再从 MCP 配置里删掉这条。令牌删不掉就停下(不留一条删了配置、令牌还在的半截)。 */
export async function disconnectConnector(name: string): Promise<void> {
  await mcpLogout(homeTarget(), name).catch((e) => {
    if (!/is not a remote MCP server/.test(String(e?.message))) throw e // 引擎里本来就没有这条(没接上过):只删配置
  })
  await window.tangu!.connectorsRemove!(name)
  await listTools(homeTarget()).catch(() => {}) // 让引擎在空闲时接上删除
}
