/** Agent Desk 两格手动控制(11-23 方案 A)的纯决策:钉住 × Agent 落位 × 直播 × 引用 × ▾ / ⋯ 动作 × 快照。
 *  #790 的那几条(没钉时的 replaceTop / placeLiveItem / clearLiveTop / liveKeepsDesk)在 deskPlan.test.ts,这里不重复。 */
import { describe, expect, it } from 'vitest'
import {
  agentSlot, deskIdentity, deskItemFor, deskMenuRows, deskReduce, packDeskMap, rememberRecent, replaceTop, unpackDeskMap, visibleSlots,
  type DeskCore, type DeskItem,
} from './deskPlan'

const notes = deskItemFor('/p/notes.txt', 10)
const report = deskItemFor('/p/report.md', 11)
const todo = deskItemFor('/p/todo.md', 12)
const data = deskItemFor('/p/data.csv', 13)
const draft = deskItemFor('/p/draft.md', 14)
const pin = (x: DeskItem): DeskItem => ({ ...x, pin: true })
const live = (toolId: string, path: string): DeskItem => ({ key: `live:${toolId}`, path, name: path ? path.split('/').pop()! : '…', at: 30, live: { msgId: 'm', toolId, tool: 'write_file' } })
const names = (xs: DeskItem[]) => xs.map((x) => `${x.name}${x.live ? '(live)' : ''}${x.pin ? '📌' : ''}`)
const core = (items: DeskItem[], extra: Partial<DeskCore> = {}): DeskCore => ({ items, ...extra })
const sameViewNever = () => false

describe('agentSlot(Agent 的下一样进哪一格)', () => {
  it('空 / 上格没钉 → 上格;只有一格且钉着 → 新开下格;上钉下没钉 → 下格;两格都钉 → -1', () => {
    expect(agentSlot([])).toBe(0)
    expect(agentSlot([notes, report])).toBe(0)
    expect(agentSlot([notes, pin(report)])).toBe(0)
    expect(agentSlot([pin(notes)])).toBe(1)
    expect(agentSlot([pin(notes), report])).toBe(1)
    expect(agentSlot([pin(notes), pin(report)])).toBe(-1)
  })
})

describe('land(Agent 编辑落盘)× 钉住', () => {
  const newReport = deskItemFor('/p/report.md', 50)
  const newData = deskItemFor('/p/data.csv', 51)
  it('一格都没钉 = replaceTop(#790 原样)', () => {
    expect(deskReduce(core([notes, report]), { type: 'land', item: newData }).items).toEqual(replaceTop([notes, report], newData))
  })
  it('上格钉住 → 新东西进下格,上格不动', () => {
    expect(names(deskReduce(core([pin(notes), report]), { type: 'land', item: newData }).items)).toEqual(['notes.txt📌', 'data.csv'])
  })
  it('只有一格且钉着 → 新开下格', () => {
    expect(names(deskReduce(core([pin(todo)]), { type: 'land', item: newData }).items)).toEqual(['todo.md📌', 'data.csv'])
  })
  it('两格都钉 → 两格不动;进「最近放过的」、亮点(fresh)', () => {
    const out = deskReduce(core([pin(data), pin(todo)]), { type: 'land', item: draft })
    expect(names(out.items)).toEqual(['data.csv📌', 'todo.md📌'])
    expect(out.fresh).toBe(deskIdentity(draft))
    expect(out.recent?.[0].path).toBe('/p/draft.md')
  })
  it('Agent 改的正是钉住那格的文件 → 那格原地刷新(仍钉住),另一格不动,不出重复', () => {
    const out = deskReduce(core([notes, pin(report)]), { type: 'land', item: newReport })
    expect(names(out.items)).toEqual(['notes.txt', 'report.md📌'])
    expect(out.items[1].key).toBe(newReport.key) // 换了 key = 重挂读新内容
    expect(out.fresh).toBeUndefined()
  })
  it('只看一格时落进了收起的那格 → 亮点', () => {
    const out = deskReduce(core([pin(notes), report], { solo: 0 }), { type: 'land', item: newData })
    expect(names(out.items)).toEqual(['notes.txt📌', 'data.csv'])
    expect(out.fresh).toBe(deskIdentity(newData))
  })
})

describe('live(流式直播)× 钉住', () => {
  it('上格钉住:直播进下格并记下它顶掉的那格;路径就位原地更新;落盘后下格 = 新文件', () => {
    const s1 = deskReduce(core([pin(notes), todo]), { type: 'live', item: live('t1', '') })
    expect(names(s1.items)).toEqual(['notes.txt📌', '…(live)'])
    expect(s1.items[1].live?.bumped?.name).toBe('todo.md')
    const s2 = deskReduce(s1, { type: 'live', item: live('t1', '/p/data.csv') })
    expect(names(s2.items)).toEqual(['notes.txt📌', 'data.csv(live)'])
    expect(s2.items[1].live?.bumped?.name).toBe('todo.md')
    const s3 = deskReduce(s2, { type: 'land', item: deskItemFor('/p/data.csv', 60), toolId: 't1' })
    expect(names(s3.items)).toEqual(['notes.txt📌', 'data.csv'])
  })
  it('直播改的正是钉住那格的文件:直播在另一格演;落盘 → 钉住那格刷新,直播那格还原成它顶掉的', () => {
    const s1 = deskReduce(core([pin(report), todo]), { type: 'live', item: live('t1', '') })
    const s2 = deskReduce(s1, { type: 'live', item: live('t1', '/p/report.md') }) // 路径闭合得晚
    expect(names(s2.items)).toEqual(['report.md📌', 'report.md(live)'])
    const newReport = deskItemFor('/p/report.md', 61)
    const s3 = deskReduce(s2, { type: 'land', item: newReport, toolId: 't1' })
    expect(names(s3.items)).toEqual(['report.md📌', 'todo.md'])
    expect(s3.items[0].key).toBe(newReport.key)
  })
  it('直播改钉住那格的文件、直播格没有可还的 → 落盘后只剩钉住那格', () => {
    const s1 = deskReduce(core([pin(report)]), { type: 'live', item: live('t1', '/p/report.md') })
    expect(names(s1.items)).toEqual(['report.md📌', 'report.md(live)'])
    expect(names(deskReduce(s1, { type: 'land', item: deskItemFor('/p/report.md', 62), toolId: 't1' }).items)).toEqual(['report.md📌'])
  })
  it('两格都钉 → 不上直播,只亮点(live:);落盘 → 进最近放过的、点换成那份文件', () => {
    const s1 = deskReduce(core([pin(data), pin(todo)]), { type: 'live', item: live('t1', '/p/draft.md') })
    expect(names(s1.items)).toEqual(['data.csv📌', 'todo.md📌'])
    expect(s1.fresh).toBe('live:t1')
    const s2 = deskReduce(s1, { type: 'land', item: draft, toolId: 't1' })
    expect(s2.fresh).toBe(deskIdentity(draft))
    expect(s2.recent?.[0].path).toBe('/p/draft.md')
  })
  it('两格都钉、直播失败 → 点撤掉', () => {
    const s1 = deskReduce(core([pin(data), pin(todo)]), { type: 'live', item: live('t1', '/p/draft.md') })
    expect(deskReduce(s1, { type: 'liveClear', toolId: 't1' }).fresh).toBeUndefined()
  })
  it('直播中用户把另一格换成了直播顶掉的那样,然后直播失败 → 不出重复', () => {
    const s1 = deskReduce(core([notes, report]), { type: 'live', item: live('t1', '/p/draft.md') }) // [直播[notes], report]
    expect(s1.items[0].live?.bumped?.name).toBe('notes.txt')
    const s2 = deskReduce(s1, { type: 'pick', slot: 1, item: notes })
    expect(names(s2.items)).toEqual(['draft.md(live)', 'notes.txt📌'])
    expect(names(deskReduce(s2, { type: 'liveClear', toolId: 't1' }).items)).toEqual(['notes.txt📌'])
  })
  it('直播在下格时上格被取消钉住:同一次调用的增量仍原地更新,不出第二个直播格', () => {
    const s1 = deskReduce(core([pin(notes), todo]), { type: 'live', item: live('t1', '') })
    const s2 = deskReduce(s1, { type: 'unpin', slot: 0 })
    const s3 = deskReduce(s2, { type: 'live', item: live('t1', '/p/data.csv') })
    expect(names(s3.items)).toEqual(['notes.txt', 'data.csv(live)'])
    expect(names(deskReduce(s3, { type: 'land', item: deskItemFor('/p/data.csv', 70), toolId: 't1' }).items)).toEqual(['notes.txt', 'data.csv'])
    expect(names(deskReduce(s3, { type: 'liveClear', toolId: 't1' }).items)).toEqual(['notes.txt', 'todo.md'])
  })
})

describe('cite(点引用 / 「正在编辑」行)', () => {
  it('没钉、没直播 = 原来的顶格逻辑', () => {
    const it0 = deskItemFor('/p/x.md', 90)
    expect(deskReduce(core([notes, report]), { type: 'cite', path: it0.path, item: it0, sameView: sameViewNever }).items).toEqual(replaceTop([notes, report], it0))
  })
  it('直播中点 Desk 上没有的文件 → 进另一格,直播格不动', () => {
    const s1 = core([live('t1', '/p/draft.md'), notes])
    const x = deskItemFor('/p/x.md', 91)
    expect(names(deskReduce(s1, { type: 'cite', path: x.path, item: x, sameView: sameViewNever }).items)).toEqual(['draft.md(live)', 'x.md'])
    expect(names(deskReduce(core([live('t1', '/p/draft.md')]), { type: 'cite', path: x.path, item: x, sameView: sameViewNever }).items)).toEqual(['draft.md(live)', 'x.md'])
  })
  it('直播中点直播格那份 / 另一格那份 → 条目原样(同一个数组)', () => {
    const s1 = core([live('t1', '/p/draft.md'), notes])
    expect(deskReduce(s1, { type: 'cite', path: '/p/notes.txt', item: deskItemFor('/p/notes.txt', 92), sameView: sameViewNever }).items).toBe(s1.items)
    expect(deskReduce(s1, { type: 'cite', path: '/p/draft.md', item: deskItemFor('/p/draft.md', 92), sameView: sameViewNever }).items).toBe(s1.items)
  })
  it('上格钉住 → 引用进没钉的下格,不改变钉住', () => {
    const x = deskItemFor('/p/x.md', 93)
    expect(names(deskReduce(core([pin(notes), report]), { type: 'cite', path: x.path, item: x, sameView: sameViewNever }).items)).toEqual(['notes.txt📌', 'x.md'])
  })
  it('点的文件已在钉住的那格 → 留在原格(同一种视图只换参数,key 不变)', () => {
    const v: DeskItem = { ...deskItemFor('/p/report.md', 20), view: { type: 'wsfile', params: { path: '/p/report.md' } }, pin: true }
    const cited: DeskItem = { ...deskItemFor('/p/report.md', 94), view: { type: 'wsfile', params: { path: '/p/report.md', line: 7 } } }
    const out = deskReduce(core([notes, v]), { type: 'cite', path: '/p/report.md', item: cited, sameView: (x) => x.view?.type === 'wsfile' && x.view.params?.path === '/p/report.md' })
    expect(out.items[1].key).toBe(v.key)
    expect(out.items[1].view?.params?.line).toBe(7)
    expect(out.items[1].pin).toBe(true)
    expect(out.items[0]).toBe(notes)
  })
})

describe('▾ 换内容 / ⋯ 动作', () => {
  it('▾ 选另一格那样 = 对调:这一格钉住,换下去的那样带着自己的钉住状态', () => {
    const out = deskReduce(core([report, notes]), { type: 'pick', slot: 0, item: notes })
    expect(names(out.items)).toEqual(['notes.txt📌', 'report.md'])
  })
  it('▾ 选最近放过的 → 换进这一格并钉住;直播格不能换', () => {
    expect(names(deskReduce(core([report, notes]), { type: 'pick', slot: 1, item: todo }).items)).toEqual(['report.md', 'todo.md📌'])
    const lv = core([live('t1', '/p/d.md'), notes])
    expect(deskReduce(lv, { type: 'pick', slot: 0, item: todo })).toBe(lv)
  })
  it('拖进一格(同 pick):落进松手那格、钉住;pick 到还没有的下格 = 新开第二格', () => {
    expect(names(deskReduce(core([report, pin(todo)]), { type: 'pick', slot: 1, item: deskItemFor('/p/n2.txt', 1) }).items)).toEqual(['report.md', 'n2.txt📌'])
    expect(names(deskReduce(core([report]), { type: 'pick', slot: 1, item: todo }).items)).toEqual(['report.md', 'todo.md📌'])
  })
  it('⋯ 移到上面 / 下面:对调,挪动的那样钉住', () => {
    expect(names(deskReduce(core([report, notes]), { type: 'move', slot: 1 }).items)).toEqual(['notes.txt📌', 'report.md'])
    expect(names(deskReduce(core([pin(report), notes]), { type: 'move', slot: 0 }).items)).toEqual(['notes.txt', 'report.md📌'])
  })
  it('从 Desk 拿掉:拿到一样不剩 = 空 Desk;直播格拿不掉', () => {
    const one = deskReduce(core([report, notes]), { type: 'remove', slot: 0 })
    expect(names(one.items)).toEqual(['notes.txt'])
    expect(deskReduce(one, { type: 'remove', slot: 0 }).items).toEqual([])
    const lv = core([live('t1', '/p/d.md'), notes])
    expect(deskReduce(lv, { type: 'remove', slot: 0 })).toBe(lv)
  })
  it('只看这一格 / 恢复两格;只剩一格时 solo 自动作废', () => {
    const s = deskReduce(core([report, notes]), { type: 'solo', slot: 1 })
    expect(visibleSlots(s)).toEqual([1])
    expect(visibleSlots(deskReduce(s, { type: 'solo' }))).toEqual([0, 1])
    expect(deskReduce(s, { type: 'remove', slot: 0 }).solo).toBeUndefined()
  })
  it('点图钉 = 取消钉住;之后 Agent 的新东西又能进这一格', () => {
    const s = deskReduce(core([pin(report), pin(notes)]), { type: 'unpin', slot: 1 })
    expect(names(deskReduce(s, { type: 'land', item: data }).items)).toEqual(['report.md📌', 'data.csv'])
  })
  it('清空 Desk:钉住、只看一格、点、说明一起清;最近放过的留着', () => {
    const out = deskReduce(core([pin(report), notes], { solo: 0, fresh: 'f:/x', note: 'n', noteFor: ['f:/p/report.md'], recent: [todo] }), { type: 'clear' })
    expect(out).toMatchObject({ items: [] })
    expect(out.solo ?? out.fresh ?? out.note ?? out.noteFor).toBeUndefined()
    expect(out.recent?.length).toBe(1)
  })
})

describe('present(desk_present)× 钉住', () => {
  it('没钉 → 整个换掉(原样),只看一格作废', () => {
    expect(names(deskReduce(core([notes, report], { solo: 1 }), { type: 'present', items: [data, todo] }).items)).toEqual(['data.csv', 'todo.md'])
    expect(deskReduce(core([notes, report], { solo: 1 }), { type: 'present', items: [data, todo] }).solo).toBeUndefined()
  })
  it('一样钉住:钉住的格不动,第一样进没钉的格,第二样进最近放过的(看得见第一样,不亮点)', () => {
    const out = deskReduce(core([pin(notes), report]), { type: 'present', items: [data, todo] })
    expect(names(out.items)).toEqual(['notes.txt📌', 'data.csv'])
    expect(out.recent?.some((x) => x.path === '/p/todo.md')).toBe(true)
    expect(out.fresh).toBeUndefined()
  })
  it('两格都钉 → 都进最近放过的,第一样亮点', () => {
    const out = deskReduce(core([pin(notes), pin(report)]), { type: 'present', items: [data, todo] })
    expect(names(out.items)).toEqual(['notes.txt📌', 'report.md📌'])
    expect(out.fresh).toBe(deskIdentity(data))
  })
  it('说明:它摆的东西都被换走后撤掉;旧快照没有 noteFor 的不动', () => {
    const s = deskReduce(core([]), { type: 'present', items: [data, todo], note: '看这两份' })
    expect(s.note).toBe('看这两份')
    const s2 = deskReduce(s, { type: 'land', item: report }) // 顶掉 data,todo 还在
    expect(s2.note).toBe('看这两份')
    const s3 = deskReduce(s2, { type: 'pick', slot: 1, item: notes }) // todo 也被换走
    expect(s3.note).toBeUndefined()
    expect(deskReduce(core([notes], { note: '旧说明' }), { type: 'land', item: report }).note).toBe('旧说明')
  })
})

describe('最近放过的 / ▾ 菜单', () => {
  it('按身份去重、最新在前、≤8、不收直播格、不带钉住', () => {
    const many = Array.from({ length: 10 }, (_, i) => deskItemFor(`/p/f${i}.md`, i))
    const r = rememberRecent(many.slice(0, 5), [pin(deskItemFor('/p/f3.md', 99)), live('t', '/p/z.md'), ...many.slice(5)])
    expect(r.length).toBe(8)
    expect(r[0].path).toBe('/p/f3.md')
    expect(r[0].pin).toBeUndefined()
    expect(r.filter((x) => x.path === '/p/f3.md').length).toBe(1)
  })
  it('每次摆法变了,当前两格进最近放过的', () => {
    const s = deskReduce(core([notes, report]), { type: 'land', item: data })
    expect(s.recent?.map((x) => x.name)).toEqual(['data.csv', 'report.md'])
  })
  it('菜单:这一格、另一格、再按最近;「Agent 刚放的」单列顶上且不在下面重复;打开即看过', () => {
    const s = core([pin(data), pin(todo)], { recent: [draft, data, todo, report], fresh: deskIdentity(draft) })
    const m = deskMenuRows(s, 0)
    expect(m.fresh && 'key' in m.fresh ? m.fresh.name : null).toBe('draft.md')
    expect(m.rows.map((r) => `${r.item.name}:${r.where ?? ''}`)).toEqual(['data.csv:this', 'todo.md:other', 'report.md:'])
    expect(deskReduce(s, { type: 'seen' }).fresh).toBeUndefined()
    expect(deskMenuRows(core([pin(data), pin(todo)], { fresh: 'live:t9' }), 1).fresh).toEqual({ liveToolId: 't9' })
  })
})

describe('快照:钉住 / 最近放过的 / 分界 / 只看一格往返', () => {
  it('保真往返;直播那颗点不落盘;分界夹在 20%–80%', () => {
    const map = { a: { items: [pin(notes), report], size: 'half' as const, recent: [todo, live('t', '/p/z.md')], split: 0.64, solo: 1, fresh: 'f:/p/todo.md', noteFor: ['f:/p/notes.txt'], note: 'n' } }
    const out = unpackDeskMap(packDeskMap(map)).a
    expect(names(out.items)).toEqual(['notes.txt📌', 'report.md'])
    expect(out.recent?.map((x) => x.name)).toEqual(['todo.md'])
    expect(out).toMatchObject({ split: 0.64, solo: 1, fresh: 'f:/p/todo.md', noteFor: ['f:/p/notes.txt'] })
    expect(unpackDeskMap(packDeskMap({ a: { items: [notes], size: 'half' as const, fresh: 'live:t1' } })).a.fresh).toBeUndefined()
    expect(unpackDeskMap(JSON.stringify({ a: { items: [], size: 'half', split: 0.95 } })).a.split).toBe(0.8)
  })
  it('拿光了条目但有最近放过的 → 会话照样落盘(▾ 记录不丢)', () => {
    expect(Object.keys(unpackDeskMap(packDeskMap({ a: { items: [], size: 'half' as const, recent: [todo] } })))).toEqual(['a'])
  })
  it('旧快照(没有这些字段)解包后不多出字段', () => {
    const out = unpackDeskMap(JSON.stringify({ a: { items: [{ key: 'k', path: '/p/a.md', name: 'a.md', at: 1 }], size: 'half' } })).a
    expect(Object.keys(out).sort()).toEqual(['items', 'size'])
    expect(Object.keys(out.items[0]).sort()).toEqual(['at', 'key', 'name', 'path'])
  })
})

describe('结果铺在旧状态上(store 是 { ...cur, ...next })也清得掉', () => {
  it('恢复两格 / 拿掉 / 看见了:solo、fresh、note 都写成 undefined,铺上去会盖掉旧值', () => {
    const base = core([report, notes], { solo: 1, fresh: deskIdentity(notes), note: 'n', noteFor: ['f:/p/x.md'] })
    const merged = { ...base, ...deskReduce(base, { type: 'solo' }) }
    expect(merged.solo).toBeUndefined()
    const m2 = { ...base, ...deskReduce(base, { type: 'remove', slot: 0 }) }
    expect(m2.solo).toBeUndefined()
    expect(m2.note).toBeUndefined() // noteFor 指的那样不在 Desk 上了
  })
})
