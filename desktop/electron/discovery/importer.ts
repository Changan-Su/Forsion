/**
 * 发现的 MCP 导入 ~/.tangu(技能 11-03 起归引擎 services/externalImport,同名绝不覆盖):
 * - MCP → 合并进 ~/.tangu/mcp.json,**enabled:false 默认停用**(绝不自动运行外来命令),
 *   同名加 -imported 后缀避免覆盖用户已有;用户在 MCP 页显式启用。
 * tanguHome 由调用方传入(main.ts 的 tanguHomeDir();测试时可指向临时目录)。
 */
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { scanAll } from './index'
import { isReservedMcpServerName } from '../../shared/mcpNames'

/** reserved = 名字落在设备 MCP 保留命名空间(dev / dev_*,shared/mcpNames.ts)而被拒的,界面据此提示改名后手动添加。 */
export async function importMcp(names: string[], tanguHome: string, home = homedir()): Promise<{ imported: string[]; reserved: string[] }> {
  const wanted = new Set(names)
  const { mcpServers } = await scanAll(home)
  const file = join(tanguHome, 'mcp.json')
  let existing: Record<string, unknown> = {}
  try {
    const parsed = JSON.parse(await readFile(file, 'utf8'))
    if (parsed?.mcpServers && typeof parsed.mcpServers === 'object') existing = parsed.mcpServers
  } catch {
    // 不存在/坏 JSON → 当空配置
  }
  const imported: string[] = []
  const reserved: string[] = []
  for (const mcp of mcpServers) {
    if (!wanted.has(mcp.name)) continue
    wanted.delete(mcp.name) // 跨生态同名只取先扫到的,避免一次导入互相覆盖
    if (isReservedMcpServerName(mcp.name)) { reserved.push(mcp.name); continue } // 冒充设备工具命名空间:不导
    let key = mcp.name
    if (key in existing) key = `${mcp.name}-imported` // 同名避让,不覆盖用户已有
    let n = 2
    while (key in existing) key = `${mcp.name}-imported-${n++}`
    existing[key] = { ...mcp.config, enabled: false } // 默认停用:绝不自动运行外来命令
    imported.push(key)
  }
  if (imported.length) {
    await mkdir(tanguHome, { recursive: true })
    await writeFile(file, JSON.stringify({ mcpServers: existing }, null, 2), 'utf8')
    await chmod(file, 0o600).catch(() => {}) // env/headers 可能含密钥
  }
  return { imported, reserved }
}
