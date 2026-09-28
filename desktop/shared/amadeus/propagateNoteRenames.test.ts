// 评审 G2-04:web / 移动端改名 / 移动之后重写全库 [[链接]] 的宿主无关半边(读 → 重写 → 比对交换写 → 冲突重算)。
import { describe, expect, it } from 'vitest'
import { propagateNoteRenames, queueStructureOps, type RenamePropagationIO } from './propagateNoteRenames'
import { textFingerprint } from './writeConflict'

function memIO(files: Map<string, string>, hooks: { beforeWrite?: (p: string) => void; failWrite?: (p: string) => boolean } = {}): RenamePropagationIO & { writes: string[] } {
  const writes: string[] = []
  return {
    writes,
    read: async (p) => files.get(p) ?? null,
    write: async (p, text, base) => {
      hooks.beforeWrite?.(p)
      if (hooks.failWrite?.(p)) throw new Error('boom')
      const cur = files.get(p) ?? ''
      if (textFingerprint(cur) !== base) return { ok: false, current: cur }
      files.set(p, text)
      writes.push(p)
      return { ok: true }
    },
  }
}

describe('propagateNoteRenames', () => {
  it('改名:别的笔记里的 [[B]] / [[B#H]] / [[B|别名]] / ![[B]] 跟到新名;没提到的不写', async () => {
    const files = new Map([
      ['A.md', 'see [[B]] and [[B#H]] and [[B|alias]] and ![[B]]\n'],
      ['C.md', 'body\n'],
      ['Other.md', '[[Z]]\n'],
    ])
    const io = memIO(files)
    const r = await propagateNoteRenames(io, { 'B.md': 'C.md' }, ['A.md', 'B.md', 'Other.md'])
    expect(files.get('A.md')).toBe('see [[C]] and [[C#H]] and [[C|alias]] and ![[C]]\n')
    expect(r).toEqual({ rewritten: ['A.md'], failed: [] })
    expect(io.writes).toEqual(['A.md'])
  })
  it('移动:带路径的链接改成新路径,frontmatter 里的链接同样跟上', async () => {
    const files = new Map([
      ['sub/D.md', '---\nrelated: "[[sub/E]]"\n---\nsee [[sub/E]]\n'],
      ['E.md', 'e\n'],
    ])
    const r = await propagateNoteRenames(memIO(files), { 'sub/E.md': 'E.md' }, ['sub/D.md', 'sub/E.md'])
    expect(files.get('sub/D.md')).toBe('---\nrelated: "[[E]]"\n---\nsee [[E]]\n')
    expect(r.rewritten).toEqual(['sub/D.md'])
  })
  it('写前盘上被别人改过 → 按现文重算再写,对方的字不丢', async () => {
    const files = new Map([['A.md', 'x [[B]]\n'], ['C.md', '']])
    let raced = false
    const io = memIO(files, {
      beforeWrite: (p) => { if (p === 'A.md' && !raced) { raced = true; files.set('A.md', 'x [[B]]\n编辑器刚存的一行\n') } },
    })
    const r = await propagateNoteRenames(io, { 'B.md': 'C.md' }, ['A.md', 'B.md'])
    expect(files.get('A.md')).toBe('x [[C]]\n编辑器刚存的一行\n')
    expect(r).toEqual({ rewritten: ['A.md'], failed: [] })
  })
  it('冲突重试用尽 / 写抛错 → 记入 failed(交调用方提示),不吞', async () => {
    const files = new Map([['A.md', 'x [[B]]\n'], ['K.md', 'k [[B]]\n'], ['C.md', '']])
    let n = 0
    const io = memIO(files, {
      beforeWrite: (p) => { if (p === 'A.md') files.set('A.md', `x [[B]]\n${++n}\n`) },
      failWrite: (p) => p === 'K.md',
    })
    const r = await propagateNoteRenames(io, { 'B.md': 'C.md' }, ['A.md', 'B.md', 'K.md'])
    expect(r.rewritten).toEqual([])
    expect(r.failed.map((f) => f.path).sort()).toEqual(['A.md', 'K.md'])
    expect(r.failed.find((f) => f.path === 'K.md')?.error).toBe('boom')
  })
  it('(复核 P1)快照之后被删 / 挪走的待重写页 → 记入 failed(gone),不静默跳过', async () => {
    const files = new Map([['C.md', ''], ['A.md', 'x [[B]]\n']])
    const io = memIO(files)
    const r = await propagateNoteRenames(io, { 'B.md': 'C.md' }, ['A.md', 'B.md', 'Gone.md'])
    expect(r.rewritten).toEqual(['A.md'])
    expect(r.failed).toEqual([{ path: 'Gone.md', error: 'gone' }])
  })
})

describe('queueStructureOps', () => {
  it('结构操作按调用顺序一个跑完才开始下一个(前一个失败不堵后面);别的方法不受影响', async () => {
    const log: string[] = []
    const api = queueStructureOps({
      renamePageFile: async (a: string) => { log.push(`start ${a}`); await new Promise((r) => setTimeout(r, a === 'x' ? 20 : 0)); log.push(`end ${a}`); if (a === 'x') throw new Error('x failed'); return a },
      movePage: async (a: string) => { log.push(`start ${a}`); log.push(`end ${a}`); return a },
      readTextFile: async () => 'untouched',
    })
    const p1 = api.renamePageFile('x')
    const p2 = api.movePage('y')
    await expect(p1).rejects.toThrow('x failed')
    await expect(p2).resolves.toBe('y')
    expect(log).toEqual(['start x', 'end x', 'start y', 'end y'])
    expect(await api.readTextFile()).toBe('untouched')
  })
})
