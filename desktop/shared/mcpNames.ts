/**
 * 设备 MCP 的保留命名空间(设备能力 MCP 方案 2026-09-26 §4.6-3):引擎把设备工具桥成 `mcp__dev_<alias>__<tool>`,
 * 第三方 MCP server 不得占用。按引擎桥接的消毒规则(tangu-agent mcp/toolBridge.ts sanitizePart:非 [A-Za-z0-9_-] → `_`)
 * 处理之后判、不分大小写:`dev` 或以 `dev_` 开头的一律不收 —— `dev.phone` / `DEV phone` 桥出来同样是 `mcp__dev_phone__…`,
 * 大小写不同也足以让模型与人混淆。引擎侧对存量配置改名兜底(user_<原名>),桌面在写入口直接拒,给用户看得懂的提示。
 */
export const sanitizeMcpServerName = (name: string): string => name.replace(/[^a-zA-Z0-9_-]/g, '_')

export function isReservedMcpServerName(name: string): boolean {
  const s = sanitizeMcpServerName(name).toLowerCase()
  return s === 'dev' || s.startsWith('dev_')
}

/** 主进程抛给界面的原因码(frontend/src/ipcError.ts 译成 zh/en);细节 = 逗号分隔的 server 名。 */
export const MCP_NAME_RESERVED = 'mcp-name-reserved'

/**
 * 一次 MCP 配置写入里**新出现**的保留名。已经在盘上的存量键放行(引擎加载时改名兜底;连它们一起拒会把用户
 * 锁在 MCP 设置外 —— 改别的 server 都存不上),只拦这次新加 / 改名进来的。
 */
export function newReservedMcpNames(next: Record<string, unknown>, prev: Record<string, unknown> | null | undefined): string[] {
  const had = new Set(Object.keys(prev ?? {}))
  return Object.keys(next).filter((k) => isReservedMcpServerName(k) && !had.has(k))
}
