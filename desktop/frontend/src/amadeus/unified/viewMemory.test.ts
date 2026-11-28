import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  DEFAULT_PAGE_STYLE,
  FOLD_PREFIX,
  flushNoteViews,
  migrateNoteMemoryRoot,
  noteMemoryId,
  readDocumentScroll,
  readNoteCaret,
  readNoteLocked,
  readNotePageStyle,
  readNoteSurfaceMode,
  remapNotePageStylePrefix,
  remapNoteViewMemory,
  writeDocumentScroll,
  writeNoteCaret,
  writeNoteLocked,
  writeNotePageStyle,
  writeNoteSurfaceMode,
} from './viewMemory'
import { recallViewport, rememberViewport } from './canvasKit/viewport'

describe('Amadeus note view memory', () => {
  let data = new Map<string, string>()
  beforeEach(() => {
    data = new Map<string, string>()
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => data.get(key) ?? null,
      setItem: (key: string, value: string) => data.set(key, value),
      removeItem: (key: string) => data.delete(key),
      // 前缀迁移要枚举键(文件夹改名 / 移动):没有这两个,扫描恒空 = 假绿。
      get length() { return data.size },
      key: (i: number) => [...data.keys()][i] ?? null,
    })
  })

  it('isolates the same relative note path across vaults', () => {
    expect(noteMemoryId('/a', 'untitled.md')).not.toBe(noteMemoryId('/b', 'untitled.md'))
    writeNoteSurfaceMode('/a', 'untitled.md', 'canvas')
    expect(readNoteSurfaceMode('/a', 'untitled.md')).toBe('canvas')
    expect(readNoteSurfaceMode('/b', 'untitled.md')).toBeNull()
  })

  it('remaps both surface mode and document scroll after rename', () => {
    writeNoteSurfaceMode('/vault', 'old.md', 'canvas')
    writeDocumentScroll('/vault', 'old.md', 712)
    remapNoteViewMemory('/vault', 'old.md', 'new.md')
    expect(readNoteSurfaceMode('/vault', 'new.md')).toBe('canvas')
    expect(readDocumentScroll('/vault', 'new.md')).toBe(712)
  })

  // V-15:画布视口的会话记忆与模式 / 滚动同一个键(库 + 路径),改名跟着走。
  it('keys the canvas viewport by vault and carries it across rename', () => {
    rememberViewport(noteMemoryId('/a', 'cv.md'), { x: -50, y: 98, z: 1 })
    expect(recallViewport(noteMemoryId('/b', 'cv.md'))).toBeUndefined()
    remapNoteViewMemory('/a', 'cv.md', 'cv2.md')
    expect(recallViewport(noteMemoryId('/a', 'cv2.md'))).toEqual({ x: -50, y: 98, z: 1 })
  })

  // C-07 锁定页面:本机视图状态(不写笔记),按库根隔离、改名跟着走、解锁即删键。
  it('keeps the page lock per vault, carries it across rename, and clears it on unlock', () => {
    writeNoteLocked('/a', 'note.md', true)
    expect(readNoteLocked('/a', 'note.md')).toBe(true)
    expect(readNoteLocked('/b', 'note.md')).toBe(false)
    remapNoteViewMemory('/a', 'note.md', 'renamed.md')
    expect(readNoteLocked('/a', 'renamed.md')).toBe(true)
    expect(readNoteLocked('/a', 'note.md')).toBe(false)
    writeNoteLocked('/a', 'renamed.md', false)
    expect(readNoteLocked('/a', 'renamed.md')).toBe(false)
  })

  // C-21 页面排版(拍板 #14):本机视图状态,按库根隔离;全缺省即删键;改名跟着走且旧键删掉(第二次调用是空操作)。
  it('keeps page typography per vault, drops the key at defaults, and carries it across rename', () => {
    expect(readNotePageStyle('/a', 'p.md')).toEqual(DEFAULT_PAGE_STYLE)
    writeNotePageStyle('/a', 'p.md', { wide: true, font: 'serif' })
    expect(readNotePageStyle('/a', 'p.md')).toEqual({ wide: true, small: false, centerLine: false, font: 'serif' })
    expect(readNotePageStyle('/b', 'p.md')).toEqual(DEFAULT_PAGE_STYLE)
    remapNoteViewMemory('/a', 'p.md', 'q.md')
    expect(readNotePageStyle('/a', 'q.md')).toEqual({ wide: true, small: false, centerLine: false, font: 'serif' })
    expect(readNotePageStyle('/a', 'p.md')).toEqual(DEFAULT_PAGE_STYLE)
    writeNotePageStyle('/a', 'q.md', { small: true, centerLine: true })
    remapNoteViewMemory('/a', 'p.md', 'q.md') // 行内改名之后 remapScopePaths 再调一次:不许拿旧的盖掉新的
    expect(readNotePageStyle('/a', 'q.md')).toEqual({ wide: true, small: true, centerLine: true, font: 'serif' })
    writeNotePageStyle('/a', 'q.md', { wide: false, small: false, centerLine: false, font: 'default' })
    expect([...data.keys()].filter((k) => k.startsWith('amx.notePage:'))).toEqual([])
  })

  it('moves page typography of a whole subtree on folder rename / move, only inside that vault', () => {
    writeNotePageStyle('/a', 'dir/sub/n.md', { font: 'mono' })
    writeNotePageStyle('/a', 'dir/top.md', { wide: true })
    writeNotePageStyle('/a', 'dirx/n.md', { small: true }) // 'dirx/…' 不在 'dir' 子树里
    writeNotePageStyle('/b', 'dir/sub/n.md', { wide: true }) // 别的库同路径
    remapNotePageStylePrefix('/a', 'dir', 'moved/dir')
    expect(readNotePageStyle('/a', 'moved/dir/sub/n.md').font).toBe('mono')
    expect(readNotePageStyle('/a', 'moved/dir/top.md').wide).toBe(true)
    expect(readNotePageStyle('/a', 'dir/sub/n.md')).toEqual(DEFAULT_PAGE_STYLE)
    expect(readNotePageStyle('/a', 'dirx/n.md').small).toBe(true)
    expect(readNotePageStyle('/b', 'dir/sub/n.md').wide).toBe(true)
  })

  it('moves note memory, including unflushed positions, while preserving destination entries', () => {
    const from = 'cloud://vault/vault:Amadeus/Notes/'
    const to = 'cloud://split'
    const rel = 'sub/n.md'
    const caret = { a: 3, h: 5, t: 'abc' }
    const vp = { x: 1, y: 2, z: 3 }
    writeDocumentScroll(from, rel, 240)
    writeNoteCaret(from, rel, caret)
    writeNoteSurfaceMode(from, rel, 'canvas')
    writeNoteLocked(from, rel, true)
    writeNotePageStyle(from, rel, { wide: true })
    rememberViewport(noteMemoryId(from, rel), vp)
    data.set(FOLD_PREFIX + noteMemoryId(from, rel), '["h1:Title#0"]')
    writeNoteSurfaceMode(from, 'conflict.md', 'canvas')
    writeNoteSurfaceMode(to, 'conflict.md', 'doc')
    writeDocumentScroll(to, 'conflict.md', 130)
    writeDocumentScroll(from, 'conflict.md', 500)

    migrateNoteMemoryRoot(from, to)
    const result = [...data]
    migrateNoteMemoryRoot(from, to)
    expect([...data]).toEqual(result)
    expect(readDocumentScroll(to, rel)).toBe(240)
    expect(readNoteCaret(to, rel)).toEqual(caret)
    expect(readNoteSurfaceMode(to, rel)).toBe('canvas')
    expect(readNoteLocked(to, rel)).toBe(true)
    expect(readNotePageStyle(to, rel).wide).toBe(true)
    expect(recallViewport(noteMemoryId(to, rel))).toEqual(vp)
    expect(data.get(FOLD_PREFIX + noteMemoryId(to, rel))).toBe('["h1:Title#0"]')
    expect(readNoteCaret(from, rel)).toEqual(caret)
    expect(recallViewport(noteMemoryId(from, rel))).toEqual(vp)
    expect(readNoteSurfaceMode(from, 'conflict.md')).toBe('canvas')
    expect(readNoteSurfaceMode(to, 'conflict.md')).toBe('doc')
    expect(readDocumentScroll(from, 'conflict.md')).toBe(500)
    expect(readDocumentScroll(to, 'conflict.md')).toBe(130)
    flushNoteViews()
  })

  it('keeps 300 migrated live positions and their sources after the next scroll flush', async () => {
    vi.resetModules()
    const memory = await import('./viewMemory')
    const from = 'cloud://vault/vault:Amadeus/Bulk/'
    const to = 'cloud://bulk'
    const source = Object.fromEntries(Array.from({ length: 300 }, (_, n) =>
      [memory.noteMemoryId(from, `${n}.md`), { s: n + 1, u: n + 1 }]))
    data.set('amx.noteView.v1', JSON.stringify(source))
    memory.migrateNoteMemoryRoot(from, to)
    memory.writeDocumentScroll(to, '0.md', 999)
    memory.flushNoteViews()
    vi.resetModules()
    const reopened = await import('./viewMemory')
    expect(reopened.readDocumentScroll(to, '0.md')).toBe(999)
    expect(Array.from({ length: 299 }, (_, n) => reopened.readDocumentScroll(to, `${n + 1}.md`))).toEqual(
      Array.from({ length: 299 }, (_, n) => n + 2))
    expect(JSON.parse(data.get('amx.noteView.v1')!)).toEqual(source)
  })

  it('copies positions without replacing another tab’s shared view table update', async () => {
    vi.resetModules()
    const memory = await import('./viewMemory')
    const from = 'cloud://vault/vault:Amadeus/Views/'
    const to = 'cloud://views'
    const id = memory.noteMemoryId(from, 'a.md')
    const unrelated = memory.noteMemoryId('/other', 'other.md')
    const initial = { [id]: { s: 50, u: 1 } }
    const newer = { ...initial, [unrelated]: { c: { a: 5, h: 6, t: 'updated' }, u: 2 } }
    data.set('amx.noteView.v1', JSON.stringify(initial))
    const getItem = localStorage.getItem
    let concurrentWrite = false
    localStorage.getItem = (key) => {
      const value = getItem(key)
      if (key === 'amx.noteView.v1' && !concurrentWrite) {
        concurrentWrite = true
        data.set(key, JSON.stringify(newer))
      }
      return value
    }
    memory.migrateNoteMemoryRoot(from, to)
    expect(JSON.parse(data.get('amx.noteView.v1')!)).toEqual(newer)
    expect(memory.readDocumentScroll(to, 'a.md')).toBe(50)
  })

  it('keeps invalid note records and a corrupt view table in place', () => {
    const from = 'cloud://vault/vault:Amadeus/Work/'
    const to = 'cloud://other-split'
    const key = 'amx.notePage:' + noteMemoryId(from, 'n.md')
    data.set(key, '{broken')
    data.set('amx.noteView.v1', 'truncated')
    writeDocumentScroll(from, 'n.md', 90)
    migrateNoteMemoryRoot(from, to)
    flushNoteViews()
    expect(data.get(key)).toBe('{broken')
    expect(data.get('amx.noteView.v1')).toBe('truncated')
    expect(readDocumentScroll(from, 'n.md')).toBe(90)
    expect(readDocumentScroll(to, 'n.md')).toBe(0)
  })

  it('keeps parseable entries with unknown note memory fields at the source', () => {
    const from = 'cloud://vault/vault:Amadeus/Unknown/'
    const to = 'cloud://unknown-split'
    const id = noteMemoryId(from, 'unknown.md')
    const views = JSON.stringify({ [id]: { u: 1, c: 'invalid' } })
    data.set('amx.notePage:' + id, '{"f":"decorative"}')
    data.set('amx.noteView.v1', views)
    migrateNoteMemoryRoot(from, to)
    expect(data.get('amx.notePage:' + id)).toBe('{"f":"decorative"}')
    expect(data.get('amx.noteView.v1')).toBe(views)
  })

  // Codex 复核 P1:改名搬走的滚动 / 光标不许复活 —— 旧键在盘上换成删除标记(不留原数据),另一个窗口(另一份模块缓存)
  // 拿它更旧的那份写回时输给标记;旧路径日后新建的笔记什么都读不到。模式 / 锁定 / 排版的旧键同样删掉。
  it('does not resurrect moved scroll / caret from storage or from another window cache after rename', async () => {
    const fresh = async (): Promise<typeof import('./viewMemory')> => { vi.resetModules(); return await import('./viewMemory') }
    const a = await fresh() // 发起改名的窗口
    a.writeDocumentScroll('/v', 'old.md', 640)
    a.writeNoteCaret('/v', 'old.md', { a: 3, h: 5, t: 'abc' })
    a.writeNoteSurfaceMode('/v', 'old.md', 'canvas')
    a.writeNotePageStyle('/v', 'old.md', { wide: true })
    a.flushNoteViews()
    const b = await fresh() // 另一个窗口:缓存里已经装着旧条目
    expect(b.readDocumentScroll('/v', 'old.md')).toBe(640)

    a.remapNoteViewMemory('/v', 'old.md', 'new.md')
    const oldId = a.noteMemoryId('/v', 'old.md')
    const disk = (): Record<string, { s?: number; c?: unknown; d?: number }> => JSON.parse(data.get('amx.noteView.v1') ?? '{}')
    expect(disk()[oldId]?.s).toBeUndefined()
    expect(disk()[oldId]?.c).toBeUndefined()
    expect(disk()[a.noteMemoryId('/v', 'new.md')]?.s).toBe(640)
    expect([...data.keys()].filter((k) => k.includes('old.md') && !k.startsWith('amx.noteView'))).toEqual([]) // 模式 / 排版旧键

    b.writeDocumentScroll('/v', 'other.md', 10) // 另一个窗口照常写别的笔记并落盘:不许把 old.md 写回来
    b.flushNoteViews()
    expect(disk()[oldId]?.s).toBeUndefined()

    const c = await fresh() // 之后在旧路径上新建的笔记
    expect(c.readDocumentScroll('/v', 'old.md')).toBe(0)
    expect(c.readNoteCaret('/v', 'old.md')).toBeNull()
    expect(c.readNoteSurfaceMode('/v', 'old.md')).toBeNull()
    expect(c.readDocumentScroll('/v', 'new.md')).toBe(640)
    expect(c.readNoteCaret('/v', 'new.md')).toEqual({ a: 3, h: 5, t: 'abc' })
    c.writeDocumentScroll('/v', 'old.md', 20) // 旧路径上的新笔记自己写的照常记得住(标记不挡新写入)
    expect(c.readDocumentScroll('/v', 'old.md')).toBe(20)
    c.flushNoteViews()
    expect(disk()[oldId]?.s).toBe(20)
  })
})
