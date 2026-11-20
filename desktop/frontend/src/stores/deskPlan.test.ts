import { describe, it, expect } from 'vitest'
import { resolveDeskPath, isDuplicateShow, replaceTop, deskItemFor, extractStreamingString, extractLiveBody, findLiveEdit, packDeskMap, unpackDeskMap, sameDeskFile, placeLiveItem, liveDeskPath, type DeskItem } from './deskPlan'

describe('resolveDeskPath', () => {
  it('绝对路径原样通过(posix + windows)', () => {
    expect(resolveDeskPath('/a/b.ts', '/cwd')).toBe('/a/b.ts')
    expect(resolveDeskPath('C:\\proj\\a.ts', '/cwd')).toBe('C:\\proj\\a.ts')
  })
  it('相对路径拼 cwd,cwd 尾部斜杠归一', () => {
    expect(resolveDeskPath('src/a.ts', '/cwd/')).toBe('/cwd/src/a.ts')
    expect(resolveDeskPath('a.ts', '/cwd')).toBe('/cwd/a.ts')
  })
  it('无 cwd 的相对路径 / 空路径 → null', () => {
    expect(resolveDeskPath('a.ts', undefined)).toBeNull()
    expect(resolveDeskPath('', '/cwd')).toBeNull()
  })
})

describe('isDuplicateShow', () => {
  const top = deskItemFor('/cwd/a.ts', 1000)
  it('同文件 1.5s 内 → 跳过', () => {
    expect(isDuplicateShow(top, '/cwd/a.ts', 2000)).toBe(true)
  })
  it('超窗 / 不同文件 / 空面板 → 不跳过', () => {
    expect(isDuplicateShow(top, '/cwd/a.ts', 2600)).toBe(false)
    expect(isDuplicateShow(top, '/cwd/b.ts', 1100)).toBe(false)
    expect(isDuplicateShow(undefined, '/cwd/a.ts', 1100)).toBe(false)
  })
})

describe('extractStreamingString(流式 JSON 字段前缀)', () => {
  it('未闭合字符串给出已到达前缀,闭合后 done', () => {
    expect(extractStreamingString('{"path": "src/a.ts", "content": "hello wo', 'content')).toEqual({ value: 'hello wo', done: false })
    expect(extractStreamingString('{"path": "src/a.ts"', 'path')).toEqual({ value: 'src/a.ts', done: true })
  })
  it('解转义:\\n \\" \\\\ \\uXXXX;悬空转义符等下一段', () => {
    expect(extractStreamingString('{"content": "a\\nb\\"c\\\\d', 'content')).toEqual({ value: 'a\nb"c\\d', done: false })
    expect(extractStreamingString('{"content": "中\\u4e2d', 'content')!.value).toBe('中中')
    expect(extractStreamingString('{"content": "abc\\', 'content')).toEqual({ value: 'abc', done: false })
    expect(extractStreamingString('{"content": "abc\\u4e', 'content')).toEqual({ value: 'abc', done: false })
  })
  it('键未出现 / 键名尚未流完 → null', () => {
    expect(extractStreamingString('{"pa', 'path')).toBeNull()
    expect(extractStreamingString('', 'content')).toBeNull()
  })
})

describe('extractLiveBody', () => {
  it('write_file 取 content,edit 系取 new_string', () => {
    expect(extractLiveBody('{"path":"a","content":"XX', 'write_file')).toBe('XX')
    expect(extractLiveBody('{"path":"a","old_string":"o","new_string":"NN', 'edit_file')).toBe('NN')
    expect(extractLiveBody('{"path":"a","old_string":"o', 'edit_file')).toBe('')
  })
})

describe('findLiveEdit', () => {
  const msg = (evs: any[]) => ({ toolEvents: evs })
  it('取最近一个未完结编辑事件的 path,相对路径拼 cwd', () => {
    const msgs = [msg([{ id: '1', name: 'edit_file', arguments: '{"path":"src/a.ts","new_string":"x', done: false }])]
    expect(findLiveEdit(msgs, '/cwd')).toEqual({ path: '/cwd/src/a.ts', name: 'a.ts' })
  })
  it('已完结 / 非编辑工具 / path 未流出 → null', () => {
    expect(findLiveEdit([msg([{ id: '1', name: 'edit_file', arguments: '{"path":"a"}', done: true }])], '/c')).toBeNull()
    expect(findLiveEdit([msg([{ id: '1', name: 'run_bash', arguments: '{"command":"ls"}', done: false }])], '/c')).toBeNull()
    expect(findLiveEdit([msg([{ id: '1', name: 'write_file', arguments: '{"pa', done: false }])], '/c')).toBeNull()
  })
})

describe('packDeskMap / unpackDeskMap(会话快照持久化)', () => {
  it('直播格与空默认条目不落盘,磁盘格保真往返', () => {
    const map = {
      a: { items: [deskItemFor('/x/a.md', 5), { ...deskItemFor('', 6), live: { msgId: 'm', toolId: 't', tool: 'write_file' } }], size: 'half' as const, mode: 'open' as const, fraction: 0.5, note: 'n' },
      empty: { items: [], size: 'half' as const },
    }
    const out = unpackDeskMap(packDeskMap(map))
    expect(Object.keys(out)).toEqual(['a'])
    expect(out.a.items.map((x) => x.path)).toEqual(['/x/a.md'])
    expect(out.a).toMatchObject({ size: 'half', mode: 'open', fraction: 0.5, note: 'n' })
  })
  it('超容量按最近展示时间截断', () => {
    const map = Object.fromEntries(Array.from({ length: 5 }, (_, i) => [`s${i}`, { items: [deskItemFor(`/f${i}.md`, i)], size: 'half' as const }]))
    const out = unpackDeskMap(packDeskMap(map, 2))
    expect(Object.keys(out).sort()).toEqual(['s3', 's4'])
  })
  it('坏数据容忍:非 JSON / 畸形条目 → 丢弃不炸', () => {
    expect(unpackDeskMap('not json')).toEqual({})
    expect(unpackDeskMap(null)).toEqual({})
    const out = unpackDeskMap(JSON.stringify({ a: { items: [{ nope: 1 }, { path: '/ok.md' }], size: 'huge' }, b: 42 }))
    expect(out.a.items.map((x) => x.path)).toEqual(['/ok.md'])
    expect(out.a.size).toBe('half')
    expect(out.b).toBeUndefined()
  })
  it('视图格(item.view)保真往返;畸形 view 丢弃', () => {
    const map = {
      a: {
        items: [{ key: 'view:calendar@1:0', path: '', name: '日历', at: 1, view: { type: 'calendar', params: { month: '2026-07' } } }],
        size: 'half' as const,
      },
    }
    const out = unpackDeskMap(packDeskMap(map))
    expect(out.a.items[0].view).toEqual({ type: 'calendar', params: { month: '2026-07' } })
    expect(out.a.items[0].name).toBe('日历')
    const bad = unpackDeskMap(JSON.stringify({ a: { items: [{ view: { nope: 1 } }, { view: { type: 'todo-list' } }], size: 'half' } }))
    expect(bad.a.items.map((x) => x.view?.type)).toEqual(['todo-list'])
  })
})

describe('replaceTop', () => {
  const a = deskItemFor('/a', 1)
  const b = deskItemFor('/b', 2)
  const c = deskItemFor('/c', 3)
  it('空面板 → 单格', () => {
    expect(replaceTop(undefined, a)).toEqual([a])
    expect(replaceTop([], a)).toEqual([a])
  })
  it('替换顶格,保留第二格,丢弃更多', () => {
    expect(replaceTop([a, b], c)).toEqual([c, b])
    expect(replaceTop([a], c)).toEqual([c])
  })
  const notes = deskItemFor('/p/notes.txt', 10)
  const reportOld = deskItemFor('/p/report.md', 11)
  const reportNew = deskItemFor('/p/report.md', 20)
  const liveReport: DeskItem = { key: 'live:t1', path: '/p/report.md', name: 'report.md', at: 12, live: { msgId: 'm', toolId: 't1', tool: 'write_file' } }
  it('第二格是同一份文件的旧版 → 不留旧版,改留原顶格', () => {
    expect(replaceTop([notes, reportOld], reportNew)).toEqual([reportNew, notes])
  })
  it('第二格不是同一份文件 → 照旧保留第二格', () => {
    expect(replaceTop([reportOld, notes], reportNew)).toEqual([reportNew, notes])
  })
  it('原顶格是直播格 / 也是这同一份文件 → 只剩一格', () => {
    expect(replaceTop([liveReport, reportOld], reportNew)).toEqual([reportNew])
    expect(replaceTop([reportOld, deskItemFor('/p/report.md', 5)], reportNew)).toEqual([reportNew])
  })
  it('没有 path 的条目(view / 插件工具卡)永不算同一份', () => {
    const v1: DeskItem = { key: 'view:cal@1:0', path: '', name: '日历', at: 1, view: { type: 'calendar' } }
    const tool: DeskItem = { key: 'tool:c1', path: '', name: '卡片', at: 2, tool: { callId: 'c1' } }
    const tool2: DeskItem = { key: 'tool:c2', path: '', name: '卡片 2', at: 3, tool: { callId: 'c2' } }
    expect(replaceTop([notes, v1], tool)).toEqual([tool, v1])
    expect(replaceTop([v1, tool], tool2)).toEqual([tool2, tool])
    expect(replaceTop([notes, tool], reportNew)).toEqual([reportNew, tool])
  })
})

describe('sameDeskFile', () => {
  it('path 非空且相等才算同一份', () => {
    expect(sameDeskFile(deskItemFor('/a', 1), deskItemFor('/a', 2))).toBe(true)
    expect(sameDeskFile(deskItemFor('/a', 1), deskItemFor('/b', 2))).toBe(false)
    expect(sameDeskFile({ key: 'v1', path: '', name: 'x', at: 1, view: { type: 'x' } }, { key: 't1', path: '', name: 'y', at: 1, tool: { callId: 'c' } })).toBe(false)
    expect(sameDeskFile(undefined, deskItemFor('/a', 1))).toBe(false)
  })
})

describe('placeLiveItem(直播格上台 / 更新)', () => {
  const live = (toolId: string, path: string): DeskItem => ({ key: `live:${toolId}`, path, name: path ? path.split('/').pop()! : '…', at: 30, live: { msgId: 'm', toolId, tool: 'write_file' } })
  const notes = deskItemFor('/p/notes.txt', 10)
  const reportOld = deskItemFor('/p/report.md', 11)
  it('新直播格进顶格:第二格是同一份文件 → 改留原顶格', () => {
    expect(placeLiveItem([notes, reportOld], live('t1', '/p/report.md'))).toEqual([live('t1', '/p/report.md'), notes])
  })
  it('没路径的直播格进顶格:第二格照留', () => {
    expect(placeLiveItem([notes, reportOld], live('t1', ''))).toEqual([live('t1', ''), reportOld])
  })
  it('同一次调用的直播格路径就位:原地替换,下格不同文件照留', () => {
    expect(placeLiveItem([live('t1', ''), notes], live('t1', '/p/report.md'))).toEqual([live('t1', '/p/report.md'), notes])
  })
  it('同一次调用的直播格路径就位:下格正是这份文件的旧版 → 只剩直播格', () => {
    expect(placeLiveItem([live('t1', ''), reportOld], live('t1', '/p/report.md'))).toEqual([live('t1', '/p/report.md')])
  })
  it('顶格是别的调用的直播格 → 按 replaceTop 顶替(被顶替的直播不落到第二格)', () => {
    expect(placeLiveItem([live('t0', '/p/report.md'), reportOld], live('t1', '/p/report.md'))).toEqual([live('t1', '/p/report.md')])
  })
})

describe('liveDeskPath(直播格只认闭合的路径)', () => {
  it('路径还没流完 → null', () => {
    expect(liveDeskPath('{"path": "/Users/fo', '/cwd')).toBeNull()
    expect(liveDeskPath('{"path": "/', '/cwd')).toBeNull()
    expect(liveDeskPath('{"path": "/a\\', '/cwd')).toBeNull()
    expect(liveDeskPath('{"pa', '/cwd')).toBeNull()
  })
  it('闭合后给完整路径;相对路径拼 cwd,无 cwd → null', () => {
    expect(liveDeskPath('{"path": "/Users/foo/draft.md", "content": "x', '/cwd')).toBe('/Users/foo/draft.md')
    expect(liveDeskPath('{"path": "src/a.ts"', '/cwd')).toBe('/cwd/src/a.ts')
    expect(liveDeskPath('{"path": "src/a.ts"', undefined)).toBeNull()
  })
})
