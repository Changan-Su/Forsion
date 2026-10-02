/** 「复制为 Markdown」(C-24)的取文口径:先冲洗再取实例正文(防抖窗里的字也在);没有实例回落读盘;一律不含 frontmatter。 */
import { afterEach, describe, expect, it, vi } from 'vitest'

const readTextFile = vi.fn<(path: string) => Promise<string>>()
vi.mock('../api', () => ({ amadeus: { readTextFile: (p: string) => readTextFile(p) } }))

import { registerUnifiedPipe } from './lifecycle'
import { noteMarkdownBody } from './copyMarkdown'

const disposers: Array<() => void> = []
afterEach(() => {
  while (disposers.length) disposers.pop()!()
  readTextFile.mockReset()
})

const FM = '---\ntitle: 周报\namadeus_layout: {"cols":[["a","b"]]}\n---\n'

describe('noteMarkdownBody', () => {
  it('冲洗后取实例手里的正文:防抖窗里刚打的字也在,不读盘、不带 fm', async () => {
    const pipe = { body: '# 周报\n\n旧\n' }
    const flush = vi.fn(async () => { pipe.body = '# 周报\n\n旧新打的字\n' }) // = syncFromEditor 拉平最后几击
    disposers.push(registerUnifiedPipe({ path: 'a.md', flush, retire: () => {}, bodyNow: () => pipe.body }))
    await expect(noteMarkdownBody('a.md')).resolves.toBe('# 周报\n\n旧新打的字\n')
    expect(flush).toHaveBeenCalledTimes(1)
    expect(readTextFile).not.toHaveBeenCalled()
  })

  it('冲洗失败照样复制编辑器此刻的正文(非严格)', async () => {
    disposers.push(registerUnifiedPipe({ path: 'a.md', flush: async () => { throw new Error('EACCES') }, retire: () => {}, bodyNow: () => '正文\n' }))
    await expect(noteMarkdownBody('a.md')).resolves.toBe('正文\n')
  })

  it('没有 v4 实例:读盘并去掉 frontmatter(结构 JSON 绝不进剪贴板)', async () => {
    readTextFile.mockResolvedValue(`${FM}# 周报\n\n正文\n`)
    const out = await noteMarkdownBody('b.md')
    expect(out).toBe('# 周报\n\n正文\n')
    expect(out).not.toContain('amadeus_layout')
  })

  it('读不到 → null(调用方报错,不往剪贴板塞空串)', async () => {
    readTextFile.mockRejectedValue(new Error('ENOENT'))
    await expect(noteMarkdownBody('c.md')).resolves.toBeNull()
  })
})
