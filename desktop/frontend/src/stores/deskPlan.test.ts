import { describe, it, expect } from 'vitest'
import { resolveDeskPath, isDuplicateShow, replaceTop, deskItemFor, extractStreamingString, extractLiveBody, findLiveEdit, packDeskMap, unpackDeskMap, sameDeskFile, placeLiveItem, liveDeskPath, clearLiveTop, liveKeepsDesk, deskPathId, type DeskItem } from './deskPlan'

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
  it('路径没流完(半截)→ null,不出半截名字', () => {
    expect(findLiveEdit([msg([{ id: '1', name: 'write_file', arguments: '{"path":"/Users/fo', done: false }])], '/c')).toBeNull()
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
  it('带 bumped 的直播格整条不落盘(打包出来的 JSON 里既没有直播条目,也没有 bumped 那份)', () => {
    const lv = { ...deskItemFor('/x/r.md', 7), live: { msgId: 'm', toolId: 't', tool: 'write_file', bumped: deskItemFor('/x/n.txt', 3) } }
    const packed = packDeskMap({ a: { items: [lv, deskItemFor('/x/k.md', 4)], size: 'half' as const } })
    expect(packed).not.toContain('"live"')
    expect(packed).not.toContain('bumped')
    expect(packed).not.toContain('n.txt')
    expect(packed).not.toContain('/x/r.md')
    expect(JSON.parse(packed).a.items.map((x: DeskItem) => x.path)).toEqual(['/x/k.md'])
  })
  it('解包时剔掉混进来的直播条目(连同 bumped)', () => {
    const raw = JSON.stringify({ a: { items: [{ key: 'live:t', path: '/x/r.md', name: 'r.md', at: 7, live: { msgId: 'm', toolId: 't', tool: 'write_file', bumped: { key: 'n', path: '/x/n.txt', name: 'n.txt', at: 3 } } }, { key: 'k', path: '/x/k.md', name: 'k.md', at: 4 }], size: 'half' } })
    const out = unpackDeskMap(raw)
    expect(out.a.items.map((x) => x.path)).toEqual(['/x/k.md'])
    expect(JSON.stringify(out)).not.toContain('n.txt')
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
  it('按归一后的路径比(./、//、..、反斜杠、尾部斜杠),不碰大小写', () => {
    expect(sameDeskFile(deskItemFor('/p/./report.md', 1), deskItemFor('/p/report.md', 2))).toBe(true)
    expect(sameDeskFile(deskItemFor('/p//a/../report.md', 1), deskItemFor('/p/report.md', 2))).toBe(true)
    expect(sameDeskFile(deskItemFor('C:\\p\\report.md', 1), deskItemFor('C:/p/report.md', 2))).toBe(true)
    expect(sameDeskFile(deskItemFor('/p/Report.md', 1), deskItemFor('/p/report.md', 2))).toBe(false)
  })
})

describe('deskPathId(比较用的路径归一)', () => {
  it('折叠 // 与 /./、消掉 ..、去尾部斜杠、反斜杠转正斜杠', () => {
    expect(deskPathId('/p/./a//b/../c.md')).toBe('/p/a/c.md')
    expect(deskPathId('/p/dir/')).toBe('/p/dir')
    expect(deskPathId('C:\\p\\.\\x\\..\\a.md')).toBe('C:/p/a.md')
    expect(deskPathId('/../a.md')).toBe('/a.md')
    expect(deskPathId('C:/../a.md')).toBe('C:/a.md')
    expect(deskPathId('../a.md')).toBe('../a.md')
    expect(deskPathId('')).toBe('')
  })
})

describe('placeLiveItem(直播格上台 / 更新)', () => {
  const live = (toolId: string, path: string): DeskItem => ({ key: `live:${toolId}`, path, name: path ? path.split('/').pop()! : '…', at: 30, live: { msgId: 'm', toolId, tool: 'write_file' } })
  const bumped = (it: DeskItem, b: DeskItem): DeskItem => ({ ...it, live: { ...it.live!, bumped: b } })
  const notes = deskItemFor('/p/notes.txt', 10)
  const reportOld = deskItemFor('/p/report.md', 11)
  const reportNew = deskItemFor('/p/report.md', 40)
  const draft = deskItemFor('/p/draft.md', 41)
  const names = (xs: DeskItem[] | null) => (xs || []).map((x) => `${x.name}${x.live ? '(live)' : ''}${x.live?.bumped ? `[${x.live.bumped.name}]` : ''}`)
  it('新直播格进顶格:第二格是同一份文件 → 改留原顶格,下台的旧版记进 bumped', () => {
    expect(placeLiveItem([notes, reportOld], live('t1', '/p/report.md'))).toEqual([bumped(live('t1', '/p/report.md'), reportOld), notes])
  })
  it('没路径的直播格进顶格:第二格照留,原顶格记进 bumped', () => {
    expect(placeLiveItem([notes, reportOld], live('t1', ''))).toEqual([bumped(live('t1', ''), notes), reportOld])
  })
  it('同一次调用的直播格路径就位:原地替换,下格不同文件照留,bumped 带下去', () => {
    expect(placeLiveItem([bumped(live('t1', ''), reportOld), notes], live('t1', '/p/report.md'))).toEqual([bumped(live('t1', '/p/report.md'), reportOld), notes])
    expect(placeLiveItem([live('t1', ''), notes], live('t1', '/p/report.md'))).toEqual([live('t1', '/p/report.md'), notes])
  })
  it('同一次调用的直播格路径就位:下格正是这份文件的旧版 → 拿 bumped 换回下格,旧版改记为 bumped', () => {
    expect(placeLiveItem([bumped(live('t1', ''), notes), reportOld], live('t1', '/p/report.md'))).toEqual([bumped(live('t1', '/p/report.md'), reportOld), notes])
  })
  it('同一次调用的直播格路径就位:下格是旧版但没有可用的 bumped → 只剩直播格(旧版记为 bumped)', () => {
    expect(placeLiveItem([live('t1', ''), reportOld], live('t1', '/p/report.md'))).toEqual([bumped(live('t1', '/p/report.md'), reportOld)])
  })
  it('顶格是别的调用的直播格 → 按 replaceTop 顶替(被顶替的直播不落到第二格,也不记成 bumped);因此下台的下格记进 bumped', () => {
    expect(placeLiveItem([live('t0', '/p/report.md'), reportOld], live('t1', '/p/report.md'))).toEqual([bumped(live('t1', '/p/report.md'), reportOld)])
    expect(placeLiveItem([live('t0', '/p/x.md'), notes], live('t1', ''))).toEqual([live('t1', ''), notes])
  })
  it('整段:[notes, report] + 流式改 report → 起草 → 路径就位 → 落盘 = [report(新), notes]', () => {
    const s1 = placeLiveItem([notes, reportOld], live('t1', ''))
    expect(names(s1)).toEqual(['…(live)[notes.txt]', 'report.md'])
    const s2 = placeLiveItem(s1, live('t1', '/p/report.md'))
    expect(names(s2)).toEqual(['report.md(live)[report.md]', 'notes.txt'])
    expect(replaceTop(s2, reportNew)).toEqual([reportNew, notes])
  })
  it('整段:直播改别的文件 → 清场回到直播前 [notes, report];落盘只换顶格 [X, report]', () => {
    const s2 = placeLiveItem(placeLiveItem([notes, reportOld], live('t1', '')), live('t1', '/p/draft.md'))
    expect(names(s2)).toEqual(['draft.md(live)[notes.txt]', 'report.md'])
    expect(clearLiveTop(s2, 't1')).toEqual([notes, reportOld])
    expect(replaceTop(s2, draft)).toEqual([draft, reportOld])
  })
  it('整段:直播改顶格那份失败 → 清场回到 [report(旧), notes]', () => {
    const s2 = placeLiveItem(placeLiveItem([reportOld, notes], live('t1', '')), live('t1', '/p/report.md'))
    expect(clearLiveTop(s2, 't1')).toEqual([reportOld, notes])
  })
  it('整段:直播改下格那份失败 → 两格都回来(顺序对调为 [report(旧), notes])', () => {
    const s2 = placeLiveItem(placeLiveItem([notes, reportOld], live('t1', '')), live('t1', '/p/report.md'))
    expect(clearLiveTop(s2, 't1')).toEqual([reportOld, notes])
  })
  it('整段:路径一直没闭合、完整路径到落盘才有 → 落盘用上 bumped = [report(新), notes]', () => {
    const s1 = placeLiveItem([notes, reportOld], live('t1', ''))
    expect(replaceTop(s1, reportNew)).toEqual([reportNew, notes])
  })
  it('整段:./ 写法的相对路径改下格那份 → 不出重复', () => {
    const s2 = placeLiveItem(placeLiveItem([notes, reportOld], live('t1', '')), live('t1', '/p/./report.md'))
    expect(names(s2)).toEqual(['report.md(live)[report.md]', 'notes.txt'])
    expect(names(replaceTop(s2, deskItemFor('/p/./report.md', 50)))).toEqual(['report.md', 'notes.txt'])
  })
  describe('一轮里连发两个编辑:A 改 draft(Desk 上没有),B 改下格的 report', () => {
    const afterA = () => placeLiveItem(placeLiveItem([notes, reportOld], live('tA', '')), live('tA', '/p/draft.md'))
    it('B 的路径分段流出:就位后 [直播 B(report), notes];A、B 都失败 → 不空、不重复', () => {
      const b1 = placeLiveItem(afterA(), live('tB', ''))
      expect(names(b1)).toEqual(['…(live)[notes.txt]', 'report.md'])
      const b2 = placeLiveItem(b1, live('tB', '/p/report.md'))
      expect(names(b2)).toEqual(['report.md(live)[report.md]', 'notes.txt'])
      expect(clearLiveTop(b2, 'tA')).toBeNull() // A 的清场只认顶格是 A
      const cleared = clearLiveTop(b2, 'tB')!
      expect(names(cleared)).toEqual(['report.md', 'notes.txt'])
    })
    it('B 第一段就带闭合路径:同样 [直播 B(report), notes],失败后不空、不重复', () => {
      const b = placeLiveItem(afterA(), live('tB', '/p/report.md'))
      expect(names(b)).toEqual(['report.md(live)[report.md]', 'notes.txt'])
      expect(names(clearLiveTop(b, 'tB'))).toEqual(['report.md', 'notes.txt'])
    })
    it('A、B 先后落盘 → [report(新), notes]', () => {
      const b = placeLiveItem(placeLiveItem(afterA(), live('tB', '')), live('tB', '/p/report.md'))
      expect(replaceTop(replaceTop(b, draft), reportNew)).toEqual([reportNew, notes])
    })
  })
})

describe('clearLiveTop(直播格清场)', () => {
  const lv: DeskItem = { key: 'live:t1', path: '', name: '…', at: 1, live: { msgId: 'm', toolId: 't1', tool: 'write_file' } }
  const notes = deskItemFor('/p/notes.txt', 10)
  it('顶格不是这次调用的直播格 → null(不动)', () => {
    expect(clearLiveTop([notes, lv], 't1')).toBeNull()
    expect(clearLiveTop([lv], 't2')).toBeNull()
    expect(clearLiveTop(undefined, 't1')).toBeNull()
  })
  it('没有 bumped → 只去掉顶格', () => {
    expect(clearLiveTop([lv, notes], 't1')).toEqual([notes])
  })
})

describe('liveKeepsDesk(直播中点文件)', () => {
  const lv: DeskItem = { key: 'live:t1', path: '/p/draft.md', name: 'draft.md', at: 1, live: { msgId: 'm', toolId: 't1', tool: 'write_file' } }
  const notes = deskItemFor('/p/notes.txt', 10)
  it('点的是直播格那份 / 下格那份 → 不动', () => {
    expect(liveKeepsDesk([lv, notes], '/p/draft.md')).toBe(true)
    expect(liveKeepsDesk([lv, notes], '/p/notes.txt')).toBe(true)
  })
  it('点的是 Desk 上没有的文件 / 顶格不是直播格 → 照旧走 replaceTop', () => {
    expect(liveKeepsDesk([lv, notes], '/p/todo.md')).toBe(false)
    expect(liveKeepsDesk([notes, lv], '/p/notes.txt')).toBe(false)
    expect(liveKeepsDesk([{ ...lv, path: '' }, { ...notes, path: '' }], '')).toBe(false) // 被点的路径为空一律不算
  })
  it('按归一后的路径比:./ 写法 / 反斜杠也认得出', () => {
    expect(liveKeepsDesk([lv, notes], '/p/./notes.txt')).toBe(true)
    expect(liveKeepsDesk([{ ...lv, path: '/p/./draft.md' }, notes], '/p/draft.md')).toBe(true)
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
