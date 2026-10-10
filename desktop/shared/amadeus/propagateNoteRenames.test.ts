// 评审 G2-04:web / 移动端改名 / 移动之后重写全库 [[链接]] 的宿主无关半边(读 → 重写 → 比对交换写 → 冲突重算)。
import { describe, expect, it } from 'vitest'
import { movedUnder, propagateNoteRenames, queueStructureOps, type RenamePropagationIO } from './propagateNoteRenames'
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
  it('movedUnder:文件夹之下的整棵树跟着走,同前缀的别的文件夹不动;宿主给的反斜杠路径照样认', () => {
    const m = movedUnder(['a/notes', 'b/notes'])
    expect([m('a/notes/x.png'), m('a/notes'), m('a/notes2/x.png'), m('c/x.png')]).toEqual(['b/notes/x.png', 'b/notes', 'a/notes2/x.png', 'c/x.png'])
    expect(movedUnder(['a\\notes', 'b\\notes'])('a/notes/x.png')).toBe('b/notes/x.png')
    expect(movedUnder()('a/x.png')).toBe('a/x.png')
  })
  // 图片 / 附件的相对引用(assets.rebaseFileRefs)跟 [[链接]] 走同一趟读写。负对照(实跑过):one() 里不调 rebaseFileRefs → 前 3 条红;
  // 提前返回改回只看 pairs → 第 3 条红。
  it('移动:挪走的笔记里按相对路径写的图片 / 附件引用按新位置重算;没给 exists 的宿主不做这件事', async () => {
    const seed = (): Map<string, string> => new Map([['other/a.md', '![](.amadeus/p.png) [[b]]\n'], ['notes/b.md', '![](.amadeus/p.png)\n']])
    const files = seed()
    const io = { ...memIO(files), exists: (f: string) => f === 'notes/.amadeus/p.png' }
    const r = await propagateNoteRenames(io, { 'notes/a.md': 'other/a.md' }, ['notes/a.md', 'notes/b.md'])
    expect(files.get('other/a.md')).toBe('![](../notes/.amadeus/p.png) [[b]]\n')
    expect(files.get('notes/b.md')).toBe('![](.amadeus/p.png)\n')
    expect(r).toEqual({ rewritten: ['other/a.md'], failed: [] })
    const plain = seed()
    expect((await propagateNoteRenames(memIO(plain), { 'notes/a.md': 'other/a.md' }, ['notes/a.md', 'notes/b.md'])).rewritten).toEqual([])
    expect(plain.get('other/a.md')).toBe('![](.amadeus/p.png) [[b]]\n')
  })
  it('写前被别的写者按新位置存过(引用已经指对)→ 重试时不拿旧目录再解释一遍,对方写的引用和字都留着', async () => {
    // 负对照(实跑过):重试不带 only → 红(改成 ../../.amadeus/p.png,指向库根的另一张图)
    const theirs = '![](../.amadeus/p.png)\nnew text\n'
    const files = new Map([['notes/deep/a.md', '![](.amadeus/p.png)\n']])
    let hit = 0
    const io = { ...memIO(files, { beforeWrite: () => { if (!hit++) files.set('notes/deep/a.md', theirs) } }), exists: (f: string) => f === 'notes/.amadeus/p.png' || f === '.amadeus/p.png' }
    const r = await propagateNoteRenames(io, { 'notes/a.md': 'notes/deep/a.md' }, ['notes/a.md'])
    expect(files.get('notes/deep/a.md')).toBe(theirs)
    expect(r.failed).toEqual([])
  })
  it('只装附件的文件夹改名(一对笔记都没有):别的笔记里指向它的引用照样跟上', async () => {
    const files = new Map([['notes/a.md', '![](../assets/x.png)\n']])
    const io = { ...memIO(files), exists: (f: string) => f === 'media/x.png' }
    const r = await propagateNoteRenames(io, {}, ['notes/a.md'], { folder: ['assets', 'media'] })
    expect(files.get('notes/a.md')).toBe('![](../media/x.png)\n')
    expect(r.rewritten).toEqual(['notes/a.md'])
  })
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
  it('(Codex 复核 inst P0-2)宿主的 CAS 报文件已不在(current:null)→ 记入 failed(gone),不拿 null 去重算', async () => {
    const files = new Map([['A.md', 'x [[B]]\n'], ['C.md', '']])
    const io: RenamePropagationIO = { read: async (p) => files.get(p) ?? null, write: async () => ({ ok: false, current: null }) }
    const r = await propagateNoteRenames(io, { 'B.md': 'C.md' }, ['A.md', 'B.md'])
    expect(r).toEqual({ rewritten: [], failed: [{ path: 'A.md', error: 'gone' }] })
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
