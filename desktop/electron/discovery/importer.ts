/**
 * 发现资产导入 ~/.tangu:
 * - 技能 → ~/.tangu/skills/<安全化 id>/SKILL.md(目录源整目录复制;单 .md 源包成目录;
 *   frontmatter 追加 x-imported-from,同名覆盖)。后端按 mtime 重扫,导入即时生效。
 * - MCP → 合并进 ~/.tangu/mcp.json,**enabled:false 默认停用**(绝不自动运行外来命令),
 *   同名加 -imported 后缀避免覆盖用户已有;用户在 MCP 页显式启用。
 * tanguHome 由调用方传入(main.ts 的 tanguHomeDir();测试时可指向临时目录)。
 */
import { cp, chmod, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { scanAll } from './index'
import { isReservedMcpServerName } from '../../shared/mcpNames'
import type { DiscoveredSkill } from './types'

/** id → 文件系统安全的目录名(防路径穿越/非法字符)。 */
function sanitizeId(id: string): string {
  const safe = id.replace(/[^a-zA-Z0-9_.-]+/g, '-').replace(/^[-.]+|[-.]+$/g, '')
  return safe || 'imported-skill'
}

/** frontmatter 追加 x-imported-from;无 frontmatter 则补一个(name/description 单行标量,对齐 Tangu 技能格式)。 */
function withImportMark(raw: string, skill: DiscoveredSkill): string {
  const m = /^---\r?\n([\s\S]*?)\r?\n---[ \t]*(\r?\n|$)/.exec(raw)
  if (m) {
    const lines = m[1].split(/\r?\n/).filter((l) => !/^x-imported-from\s*:/.test(l))
    lines.push(`x-imported-from: ${skill.ecosystem}`)
    return `---\n${lines.join('\n')}\n---\n${raw.slice(m[0].length)}`
  }
  const scalar = (s: string): string => JSON.stringify(s.replace(/\s+/g, ' ').trim().slice(0, 500))
  return [
    '---',
    `name: ${scalar(skill.name)}`,
    `description: ${scalar(skill.description || skill.name)}`,
    `x-imported-from: ${skill.ecosystem}`,
    '---',
    '',
    raw,
  ].join('\n')
}

export async function importSkills(ids: string[], tanguHome: string, home = homedir()): Promise<{ imported: string[] }> {
  const wanted = new Set(ids)
  const { skills } = await scanAll(home)
  const imported: string[] = []
  for (const skill of skills) {
    if (!wanted.has(skill.id)) continue
    const destDir = join(tanguHome, 'skills', sanitizeId(skill.id))
    const destFile = join(destDir, 'SKILL.md')
    const src = await stat(skill.sourceDir).catch(() => null)
    if (!src) continue
    await rm(destDir, { recursive: true, force: true }) // 同名已存在 → 覆盖
    if (src.isDirectory()) {
      await cp(skill.sourceDir, destDir, { recursive: true })
    } else {
      await mkdir(destDir, { recursive: true })
      await cp(skill.sourceDir, destFile) // 单 .md 源 → <id>/SKILL.md
    }
    try {
      await writeFile(destFile, withImportMark(await readFile(destFile, 'utf8'), skill), 'utf8')
    } catch {
      // 目录源缺 SKILL.md 理论上不可能(扫描即以其为准);失败不回滚已复制内容
    }
    imported.push(skill.id)
  }
  return { imported }
}

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
