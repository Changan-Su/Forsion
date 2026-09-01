// 写盘 ↔ 索引成对的出口门(2026-08-31)。用户实报「笔记图标有时候在工作区不显示」的真因:
// v4/unified 笔记只走 writeTextFile,索引不跟 → pageIcons/搜索/反链停在上次启动的样子。
// ⚠️ 负对照在最后一格:画板/插件文件类型**不许**进索引(进了就是被当页面解析 = 毁档那一族)。
import { describe, expect, it, vi } from 'vitest'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

vi.mock('electron', () => ({ dialog: {} })) // vaultManager 只用到 dialog.showOpenDialog(本测试不走)

const { VaultManager } = await import('./vaultManager')
const { VaultIndex } = await import('./vaultIndex')
const { writeVaultText } = await import('./pageWrite')

async function freshVault(): Promise<{ vault: InstanceType<typeof VaultManager>; index: InstanceType<typeof VaultIndex>; root: string }> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'amx-pagewrite-'))
  const vault = new VaultManager()
  vault.setRoot(root)
  const index = new VaultIndex(vault)
  return { vault, index, root }
}

describe('writeVaultText', () => {
  it('笔记写盘后索引立刻跟上:图标、全文搜索、出链都是新的', async () => {
    const { vault, index, root } = await freshVault()
    await fs.writeFile(path.join(root, 'a.md'), '# 甲\n\n旧正文。\n')
    await index.build()
    expect(index.pageIcons()).toEqual({})

    await writeVaultText(vault, index, 'a.md', '---\nicon: 📕\n---\n\n# 甲\n\n新正文关键词。\n')
    expect(index.pageIcons()).toEqual({ 'a.md': '📕' })
    expect(index.search('新正文关键词').length).toBe(1)
    expect(index.search('旧正文').length).toBe(0)
  })

  it('图标被删掉时索引也跟着掉(不是只增不减)', async () => {
    const { vault, index, root } = await freshVault()
    await fs.writeFile(path.join(root, 'a.md'), '---\nicon: 📕\n---\n\n正文。\n')
    await index.build()
    expect(index.pageIcons()).toEqual({ 'a.md': '📕' })
    await writeVaultText(vault, index, 'a.md', '正文。\n')
    expect(index.pageIcons()).toEqual({})
  })

  it('画板与插件文件类型不进索引(它们磁盘上是 .md,却不是笔记)', async () => {
    const { vault, index, root } = await freshVault()
    vault.setPluginFileExtensions(['.mindmap.md'])
    await index.build()
    await writeVaultText(vault, index, 'b.excalidraw.md', '---\nicon: 🎨\n---\n\n画板。\n')
    await writeVaultText(vault, index, 'c.mindmap.md', '---\nicon: 🧠\n---\n\n脑图。\n')
    expect(index.pageIcons()).toEqual({})
    expect(index.search('画板').length).toBe(0)
    expect(index.search('脑图').length).toBe(0)
    // 但文件确实写进去了(只是不进索引)
    expect(await fs.readFile(path.join(root, 'c.mindmap.md'), 'utf8')).toContain('脑图')
  })
})
