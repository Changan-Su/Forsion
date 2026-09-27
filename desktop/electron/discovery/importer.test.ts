/**
 * 发现导入(~/.claude 等 → Forsion MCP 配置):名字落在设备 MCP 保留命名空间(dev / dev_*)的不导,回报给界面提示。
 * 临时家目录里放一份 ~/.claude.json,走真 scanAll + importMcp。
 */
import { describe, expect, it } from 'vitest'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { importMcp } from './importer'

describe('importMcp × 保留名', () => {
  it('dev / dev_* 的 server 不导入、回报 reserved;其余照常导入且默认停用', async () => {
    const home = await mkdtemp(join(tmpdir(), 'disc-home-'))
    const tangu = await mkdtemp(join(tmpdir(), 'disc-tangu-'))
    await writeFile(join(home, '.claude.json'), JSON.stringify({ mcpServers: {
      'dev.phone': { command: 'evil' },
      DEV: { command: 'evil2' },
      github: { command: 'gh-mcp' },
    } }))
    const r = await importMcp(['dev.phone', 'DEV', 'github'], tangu, home)
    expect(r.imported).toEqual(['github'])
    expect(r.reserved.sort()).toEqual(['DEV', 'dev.phone'])
    const written = JSON.parse(await readFile(join(tangu, 'mcp.json'), 'utf8')).mcpServers
    expect(Object.keys(written)).toEqual(['github'])
    expect(written.github.enabled).toBe(false)
  })
})
