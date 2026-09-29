/** 跨笔记嵌入解析(评审 L-15):`![[笔记#标题]]` / `![[笔记#^块]]` / `![[笔记|x]]` 原先一律「嵌入丢失」;
 *  整篇嵌入不按源目录就近解析,同名笔记嵌错。v3 标记块 `![[笔记#3]]` 的旧语义不能丢。 */
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { VaultIndex } from './vaultIndex'
import type { VaultManager } from './vaultManager'

let dir = ''
afterEach(async () => {
  if (dir) await fs.rm(dir, { recursive: true, force: true })
})

async function setup(files: Record<string, string>): Promise<VaultIndex> {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'vault-index-embed-'))
  for (const [p, text] of Object.entries(files)) {
    await fs.mkdir(path.dirname(path.join(dir, p)), { recursive: true })
    await fs.writeFile(path.join(dir, p), text)
  }
  const vault = {
    listPages: async () => Object.keys(files).filter((f) => f.endsWith('.md')).sort(),
    absPath: (p: string) => path.join(dir, p),
    getRoot: () => dir,
  } as unknown as VaultManager
  const index = new VaultIndex(vault)
  await index.build()
  return index
}

const FILES = {
  'Embedded.md': '# Embedded\n\n开头。\n\n## Sec\n\n小节正文。\n\n## Other\n\n一段话 ^abc\n',
  'Dup.md': '根目录的 Dup。\n',
  'dir/Dup.md': 'dir 里的 Dup。\n',
  'dir/Host.md': '![[Dup]]\n',
  'Legacy.md': '---\namadeus_page: 1\n---\n<!-- a 3 -->\n老块内容。\n',
}

describe('VaultIndex.resolveBlock(v4 嵌入)', () => {
  it('#标题 → 只读切出那一节;#^块 → 已有块锚那一段(去掉锚)', async () => {
    const ix = await setup(FILES)
    expect(ix.resolveBlock('Embedded#Sec')).toEqual({ path: 'Embedded.md', content: '## Sec\n\n小节正文。', type: 'markdown' })
    expect(ix.resolveBlock('Embedded#^abc')?.content).toBe('一段话')
    expect(ix.resolveBlock('Embedded#不存在')).toBeNull()
  })
  it('|别名 / |宽度 不参与解析', async () => {
    const ix = await setup(FILES)
    expect(ix.resolveBlock('Embedded|300')?.path).toBe('Embedded.md')
    expect(ix.resolveBlock('Embedded#Sec|别名')?.content).toBe('## Sec\n\n小节正文。')
  })
  it('带 sourcePath 按源目录就近解析(同名不嵌错);不带 = 全库第一篇(历史行为)', async () => {
    const ix = await setup(FILES)
    expect(ix.resolveBlock('Dup', 'dir/Host.md')?.content).toBe('dir 里的 Dup。\n')
    expect(ix.resolveBlock('Dup')?.path).toBe('Dup.md')
  })
  it('空笔记名 = 源笔记自己', async () => {
    const ix = await setup(FILES)
    expect(ix.resolveBlock('#Other', 'Embedded.md')?.content).toBe('## Other\n\n一段话 ^abc')
    expect(ix.resolveBlock('#Other')).toBeNull()
  })
  it('v3 标记块 `笔记#3` 旧语义不变', async () => {
    const ix = await setup(FILES)
    expect(ix.resolveBlock('Legacy#3')).toEqual({ path: 'Legacy.md', content: '老块内容。', type: 'markdown' })
  })
})
