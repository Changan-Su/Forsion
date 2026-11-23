import { describe, expect, it } from 'vitest'
import { deskItemFor, type DeskItem } from './deskPlan'
import {
  adoptHumanDesk, deskSection, deskSideOf, humanDeskReduce, humanDeskSessionsChanged, humanMenuRows, humanWatching,
  packHumanDeskMap, unpackHumanDeskMap, type HumanDeskCore,
} from './humanDeskPlan'

const A = deskItemFor('/v/定价调研.md', 1000)
const B = deskItemFor('/p/竞品价格.csv', 2000)
const C = deskItemFor('/p/notes.txt', 3000)

describe('humanDeskReduce', () => {
  it('put:放上来就开始在看,原来那样进最近放过的(最新在前)', () => {
    const one = humanDeskReduce({}, { type: 'put', item: A })
    expect(one.item).toBe(A)
    expect(one.recent?.map((x) => x.path)).toEqual([A.path])
    const two = humanDeskReduce({ ...one, stopped: true }, { type: 'put', item: B })
    expect(two.item).toBe(B)
    expect(two.stopped).toBeUndefined()
    expect(two.recent?.map((x) => x.path)).toEqual([B.path, A.path])
  })
  it('put 同一样东西(路径归一后相同):条目不换,只是重新开始看', () => {
    const cur: HumanDeskCore = { item: A, recent: [A], stopped: true }
    const again = humanDeskReduce(cur, { type: 'put', item: deskItemFor('/v/./定价调研.md', 9000) })
    expect(again.item).toBe(A)
    expect(again.stopped).toBeUndefined()
    expect(humanDeskReduce({ item: A, recent: [A] }, { type: 'put', item: A })).toEqual({ item: A, recent: [A] })
  })
  it('put 去掉 pin / live(从 Agent Desk 挪过来的钉住格)', () => {
    const pinned: DeskItem = { ...B, pin: true }
    const out = humanDeskReduce({}, { type: 'put', item: pinned })
    expect(out.item?.pin).toBeUndefined()
    expect(out.recent?.[0].pin).toBeUndefined()
  })
  it('remove:空出来,最近放过的留着;stop / resume 只在有东西时生效', () => {
    const cur: HumanDeskCore = { item: A, recent: [A, B], stopped: true }
    const out = humanDeskReduce(cur, { type: 'remove' })
    expect(out.item).toBeUndefined()
    expect(out.stopped).toBeUndefined()
    expect('item' in out).toBe(true) // 清字段写 undefined,{ ...cur, ...next } 才清得掉
    expect(out.recent).toEqual([A, B])
    expect(humanDeskReduce({}, { type: 'stop' })).toEqual({})
    expect(humanDeskReduce({ item: A }, { type: 'stop' }).stopped).toBe(true)
    expect(humanDeskReduce({ item: A, stopped: true }, { type: 'resume' }).stopped).toBeUndefined()
  })
  it('没变 → 原对象(store 据此不写盘)', () => {
    const cur: HumanDeskCore = { item: A }
    expect(humanDeskReduce(cur, { type: 'resume' })).toBe(cur)
    expect(humanDeskReduce({}, { type: 'remove' })).toEqual({})
  })
})

describe('humanDeskReduce retarget(库里改名 / 挪走 / 删掉)', () => {
  const N = deskItemFor('/v/未命名.md', 5)
  it('改名:放着的那样和最近放过的都换成新路径(新 key → 编辑器按新路径重挂)', () => {
    const out = humanDeskReduce({ item: N, recent: [N, B] }, { type: 'retarget', from: '/v/未命名.md', to: '/v/定价调研.md' })
    expect(out.item?.path).toBe('/v/定价调研.md')
    expect(out.item?.name).toBe('定价调研.md')
    expect(out.item?.key).not.toBe(N.key)
    expect(out.recent?.map((x) => x.path)).toEqual(['/v/定价调研.md', B.path])
  })
  it('挪文件夹(prefix):子树里的跟过去;反斜杠路径也认', () => {
    const W = deskItemFor('C:\\v\\d\\a.md', 1)
    const out = humanDeskReduce({ item: W }, { type: 'retarget', from: 'C:/v/d', to: 'C:/v/e', prefix: true })
    expect(out.item?.path).toBe('C:/v/e/a.md')
  })
  it('删掉:放着的那样拿掉、最近放过的里也去掉;不相干 → 原对象', () => {
    const out = humanDeskReduce({ item: N, recent: [N, B], stopped: true }, { type: 'retarget', from: '/v/未命名.md', to: null })
    expect(out.item).toBeUndefined()
    expect(out.stopped).toBeUndefined()
    expect(out.recent).toEqual([B])
    const cur: HumanDeskCore = { item: B, recent: [B] }
    expect(humanDeskReduce(cur, { type: 'retarget', from: '/v/x.md', to: '/v/y.md' })).toBe(cur)
  })
})

describe('humanWatching', () => {
  it('有东西、没停、没自动暂停才算在看', () => {
    expect(humanWatching(undefined)).toBe(false)
    expect(humanWatching({})).toBe(false)
    expect(humanWatching({ item: A })).toBe(true)
    expect(humanWatching({ item: A, stopped: true })).toBe(false)
    expect(humanWatching({ item: A, paused: true })).toBe(false)
  })
})

describe('humanMenuRows', () => {
  it('正放着的排第一并标出来,其余按最近、去重', () => {
    const rows = humanMenuRows({ item: B, recent: [B, A, C, A] })
    expect(rows.map((r) => [r.item.path, r.current])).toEqual([[B.path, true], [A.path, false], [C.path, false]])
    expect(humanMenuRows({ recent: [A] }).map((r) => r.current)).toEqual([false])
  })
})

describe('deskSideOf(右边一次只展开一块)', () => {
  it('Agent Desk 的 open 优先;否则看 Human Desk', () => {
    expect(deskSideOf(undefined, undefined)).toBeNull()
    expect(deskSideOf('open', undefined)).toBe('agent')
    expect(deskSideOf(undefined, true)).toBe('human')
    // 两扇窗写的快照恢复出两个都开着:只认一个,不会两块同时展开
    expect(deskSideOf('open', true)).toBe('agent')
  })
})

describe('deskSection(你在第几节)', () => {
  const doc = [
    { level: 1, text: '定价调研' }, { level: 2, text: '1. 背景' }, { level: 2, text: '2. 结论' },
    { level: 3, text: '细节' }, { level: 2, text: '3. 明细' }, { level: 2, text: '四、对我们的启发' },
  ]
  it('唯一的一级标题是题目,不算一节;最浅的一级是「节」', () => {
    expect(deskSection(doc, 4)).toEqual({ n: 3, title: '明细', idx: 4 })
    expect(deskSection(doc, 1)).toEqual({ n: 1, title: '背景', idx: 1 })
  })
  it('光标在小标题里 → 算它所在的那一节', () => {
    expect(deskSection(doc, 3)).toEqual({ n: 2, title: '结论', idx: 2 })
  })
  it('去掉标题自带的编号(数字 / 中文),没有编号原样', () => {
    expect(deskSection(doc, 5)?.title).toBe('对我们的启发')
    expect(deskSection([{ level: 2, text: '2024 年计划' }], 0)?.title).toBe('2024 年计划')
    expect(deskSection([{ level: 2, text: '3.5 版本说明' }], 0)?.title).toBe('3.5 版本说明')
  })
  it('光标在第一节之前 / 没有标题 → null', () => {
    expect(deskSection(doc, 0)).toBeNull()
    expect(deskSection(doc, -1)).toBeNull()
    expect(deskSection([], 0)).toBeNull()
  })
  it('没有题目(多个一级标题)时一级标题就是节', () => {
    const d = [{ level: 1, text: 'A' }, { level: 2, text: 'a' }, { level: 1, text: 'B' }]
    expect(deskSection(d, 2)).toEqual({ n: 2, title: 'B', idx: 2 })
    expect(deskSection([{ level: 1, text: '只有题目' }], 0)).toEqual({ n: 1, title: '只有题目', idx: 0 })
  })
})

describe('packHumanDeskMap / unpackHumanDeskMap', () => {
  it('只落 core:展开、暂停、点、小节这些每扇窗自己的不落', () => {
    const packed = packHumanDeskMap({ s1: { item: A, recent: [A, B], stopped: true, ...({ open: true, paused: true, agentDot: true, section: { n: 1, title: 'x', idx: 1 } } as object) } as HumanDeskCore })
    const back = unpackHumanDeskMap(packed)
    expect(back).toEqual({ s1: { item: A, recent: [A, B], stopped: true } })
  })
  it('空会话不落;插件工具卡 / 直播格不落;stopped 没东西时不落', () => {
    const live: DeskItem = { ...B, live: { msgId: 'm', toolId: 't', tool: 'write_file' } }
    const tool: DeskItem = { key: 'tool:1', path: '', name: 'card', at: 1, tool: { callId: '1' } }
    const back = unpackHumanDeskMap(packHumanDeskMap({ empty: {}, s1: { item: live, recent: [tool, C], stopped: true } }))
    expect(back).toEqual({ s1: { recent: [C] } })
  })
  it('超容量按最近放东西的时间截断', () => {
    const map: Record<string, HumanDeskCore> = {}
    for (let i = 0; i < 5; i++) map[`s${i}`] = { item: deskItemFor(`/f${i}.md`, i * 10) }
    expect(Object.keys(unpackHumanDeskMap(packHumanDeskMap(map, 2))).sort()).toEqual(['s3', 's4'])
  })
  it('读坏了 → 空表;畸形条目丢掉', () => {
    expect(unpackHumanDeskMap('{oops')).toEqual({})
    expect(unpackHumanDeskMap('[1,2]')).toEqual({})
    expect(unpackHumanDeskMap(JSON.stringify({ s: { item: { path: 3 }, recent: [{ path: '/a.md', name: 'a.md', key: 'k', at: 1 }, null] } }))).toEqual({ s: { recent: [{ path: '/a.md', name: 'a.md', key: 'k', at: 1 }] } })
  })
  it('视图条目带参数往返', () => {
    const v: DeskItem = { key: 'view:x@1', path: '', name: 'X', at: 1, view: { type: 'x', params: { a: 1 } } }
    expect(unpackHumanDeskMap(packHumanDeskMap({ s: { item: v } }))).toEqual({ s: { item: v } })
  })
})

describe('两扇窗同步', () => {
  it('只认这次写入真改了的会话', () => {
    expect(humanDeskSessionsChanged({ a: { item: A }, b: { item: B } }, { a: { item: A }, b: { item: C } })).toEqual(['b'])
  })
  it('收下对面换的东西:本窗没展开 → 本窗算暂停;本窗展开着 → 照看', () => {
    const away = adoptHumanDesk({ item: A, section: { n: 2, title: 't', idx: 2 } }, { item: B, recent: [B, A] })
    expect(away.item).toBe(B)
    expect(away.paused).toBe(true)
    expect(away.section).toBeUndefined()
    const here = adoptHumanDesk({ item: A, open: true }, { item: B })
    expect(here.paused).toBeUndefined()
    expect(here.open).toBe(true)
  })
  it('同一样东西:沿用本窗的条目对象;只改了停止 → 不动暂停', () => {
    const cur = { item: A, recent: [A], paused: true as const }
    const out = adoptHumanDesk(cur, { item: { ...A }, recent: [A], stopped: true })
    expect(out.item).toBe(A)
    expect(out.stopped).toBe(true)
    expect(out.paused).toBe(true)
    expect(adoptHumanDesk(cur, { item: A, recent: [A] })).toBe(cur)
  })
  it('对面点了「继续看」、本窗没展开 → 本窗算暂停(不挂引用);本窗展开着 → 照看', () => {
    expect(adoptHumanDesk({ item: A, stopped: true }, { item: A }).paused).toBe(true)
    expect(adoptHumanDesk({ item: A, stopped: true, open: true }, { item: A }).paused).toBeUndefined()
  })
  it('对面拿掉了 → 本窗也空', () => {
    const out = adoptHumanDesk({ item: A, open: true }, { recent: [A] })
    expect(out.item).toBeUndefined()
    expect(out.open).toBe(true)
  })
})
