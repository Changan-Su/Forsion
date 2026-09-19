/** 搜索 / 标签 / 双链看**解码后**的正文;`@` 时间标记仍按原文逐行对齐(回写按 raw + occ 找行)。
 *  编辑器为了让 `**`/`~~` 往返,会把定界符旁的字写成数字字符引用(attentionFlanking),
 *  索引若读原文:「后面」搜不到 `**注意：**&#x540E;面`,`*工作 #项&#x76EE;***（重要）**` 的标签被截成 `#项`。 */
import { promises as fs, readdirSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { findMarkLine } from '../../../shared/amadeus/mdMarks'
import { VaultIndex } from './vaultIndex'
import type { VaultManager } from './vaultManager'

let dir = ''
afterEach(async () => {
  if (dir) await fs.rm(dir, { recursive: true, force: true })
})

async function setup(files: Record<string, string>): Promise<VaultIndex> {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'vault-index-charrefs-'))
  for (const [p, text] of Object.entries(files)) await fs.writeFile(path.join(dir, p), text)
  const vault = {
    listPages: async () => readdirSync(dir).filter((f) => f.endsWith('.md')).sort(),
    absPath: (p: string) => path.join(dir, p),
    getRoot: () => dir,
  } as unknown as VaultManager
  const index = new VaultIndex(vault)
  await index.build()
  return index
}

const NOTE = [
  '---',
  'icon: 📝',
  '---',
  '开头一行',
  '**注意：**&#x540E;面的事',
  '',
  '*工作 #项&#x76EE;***（重要）**',
  '',
  '- [ ] 交稿 @2026-09-20 **注意：**&#x540E;面',
  '```',
  '代码里的 &#x540E; 不解',
  '```',
].join('\n')

describe('VaultIndex:字符引用解码后再索引', () => {
  it('搜「后面」命中,摘要是解码后的字,行号与原文(剥 frontmatter 后)对齐', async () => {
    const index = await setup({ 'a.md': NOTE })
    const hits = index.search('后面')
    expect(hits.map((h) => h.path)).toEqual(['a.md'])
    expect(hits[0].snippet).toContain('**注意：**后面的事')
    expect(hits[0].snippet).not.toContain('**注意：**&#x540E;') // 正文里的解了(摘要窗口够到的代码块里那个刻意不解)
    expect(hits[0].line).toBe(2) // 剥掉 frontmatter 后:第 1 行「开头一行」,第 2 行是命中行
  })

  it('标签是完整的 `#项目`,不是被截断的 `#项`', async () => {
    const index = await setup({ 'a.md': NOTE })
    const tags = index.listTags().map((t) => t.tag)
    expect(tags).toContain('项目')
    expect(tags).not.toContain('项')
    expect(index.pagesByTag('项目')).toEqual(['a.md'])
  })

  it('双链目标解码后才对得上页面(反链能找到)', async () => {
    const index = await setup({ '笔记.md': '正文', 'b.md': '见 [[&#x7B14;记]] 与 **注意：**&#x540E;面' })
    const refs = index.backlinks('笔记.md')
    expect(refs.map((r) => r.path)).toEqual(['b.md'])
    expect(refs[0].snippet).not.toContain('&#x')
  })

  it('`@` 时间标记仍读原文:raw 保留字符引用,回写能在磁盘文件里按 raw + occ 找回同一行', async () => {
    const index = await setup({ 'a.md': NOTE })
    const marks = index.marks()
    expect(marks).toHaveLength(1)
    expect(marks[0].raw).toContain('&#x540E;') // 与磁盘逐字一致,不是解码后的
    expect(findMarkLine(NOTE, marks[0].raw, marks[0].occ)).toBe(8) // 0 起:第 9 行
  })
})
