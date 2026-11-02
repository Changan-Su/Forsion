import { describe, expect, it } from 'vitest'
import type { SessionRecord, UiMessage } from '../../types'
import { buildTurnTree, readSteps, splitTurns } from './canvasTree'

const u = (id: string, content: string, ts = 0): UiMessage => ({ id, role: 'user', content, status: 'done', timestamp: ts })
const a = (id: string, content: string, ts = 0): UiMessage => ({ id, role: 'assistant', content, status: 'done', timestamp: ts })
const br = (id: string, fork: string, from: string, created: string): SessionRecord =>
  ({ id, title: id, parent_session_id: 'R', fork_message_id: fork, fork_session_id: from, created_at: created } as SessionRecord)

// 主线:三轮。直播出来的,时间戳是客户端时刻 —— 和分支里的副本(服务端时刻)对不上,不能拿来对齐
const R = [u('u1', '离线同步怎么做?', 1001), a('a1', '三条路线', 1002), u('u2', '第一条改哪?', 1003), a('a2', '四处', 1004), u('u3', '冲突怎么提示?', 1005), a('a3', '横幅', 1006)]
// 分支 B1 从 a1 分出:前两条是复制的(新 id、服务端时间戳),然后自己问了两轮
const B1 = [u('b-u1', '离线同步怎么做?', 900), a('b-a1', '三条路线', 901), u('c1', '如果用 CRDT?', 2000), a('c2', 'Yjs', 2001), u('c3', '包多大?', 2002), a('c4', '一圈', 2003)]

describe('splitTurns', () => {
  it('一轮 = 问题 + 后面的回答;机器行跟着上一轮,系统行不进', () => {
    const turns = splitTurns([
      u('x1', 'Q'), a('x2', 'A'), u('x3', '<approval_update>…'), { id: 's', role: 'system', content: '投票', status: 'done', timestamp: 0 }, a('x4', 'A2'),
      u('x5', 'Q2'),
    ])
    expect(turns.map((t) => [t.user?.id, t.answers.map((m) => m.id)])).toEqual([['x1', ['x2', 'x3', 'x4']], ['x5', []]])
  })
  it('开头没有问题的几行自成一轮', () => {
    expect(splitTurns([a('x1', 'hi'), u('x2', 'Q')]).map((t) => t.user?.id ?? null)).toEqual([null, 'x2'])
  })
})

describe('buildTurnTree', () => {
  it('分支按问题文字认回主线那一轮(不比时间戳),自己的几轮挂在分叉卡下', () => {
    const tree = buildTurnTree('R', [br('B1', 'a1', 'R', '2026-10-18 10:00:00')], (s) => ({ R, B1 } as Record<string, UiMessage[]>)[s])
    expect(tree.roots).toEqual(['R:u1'])
    expect(tree.paths.R).toEqual(['R:u1', 'R:u2', 'R:u3'])
    expect(tree.paths.B1).toEqual(['R:u1', 'B1:c1', 'B1:c3'])
    expect(tree.cards.get('R:u1')!.children).toEqual(['R:u2', 'B1:c1'])
    // 分支那份副本的 id 记在共用卡上(双击跳到分支里那一轮靠它)
    expect(tree.cards.get('R:u1')!.at.B1).toEqual({ first: 'b-u1', last: 'b-a1' })
  })

  it('分支的分支:分叉消息落在来源分支的复制段里 → 挂回主线那一轮', () => {
    const B3 = [u('d-u1', '离线同步怎么做?'), a('d-a1', '三条路线'), u('e1', '只做桌面端?'), a('e2', '砍到三处')]
    const tree = buildTurnTree('R', [br('B3', 'b-a1', 'B1', '2026-10-18 11:00:00'), br('B1', 'a1', 'R', '2026-10-18 10:00:00')], (s) => ({ R, B1, B3 } as Record<string, UiMessage[]>)[s])
    expect(tree.paths.B3).toEqual(['R:u1', 'B3:e1'])
    expect(tree.cards.get('R:u1')!.children).toEqual(['R:u2', 'B1:c1', 'B3:e1'])
  })

  it('分支的分支:从来源分支自己的一轮分出 → 挂在那张分支卡下', () => {
    const B4 = [u('f0', '离线同步怎么做?'), a('f1', '三条路线'), u('f2', '如果用 CRDT?'), a('f3', 'Yjs'), u('f4', '迁移怎么做?'), a('f5', '一次')]
    const tree = buildTurnTree('R', [br('B1', 'a1', 'R', '2026-10-18 10:00:00'), br('B4', 'c2', 'B1', '2026-10-18 12:00:00')], (s) => ({ R, B1, B4 } as Record<string, UiMessage[]>)[s])
    expect(tree.paths.B4).toEqual(['R:u1', 'B1:c1', 'B4:f4'])
    expect(tree.cards.get('B1:c1')!.at.B4).toEqual({ first: 'f2', last: 'f3' })
  })

  it('复制段不越过分叉卡:分支里接着问了和主线下一轮一样的话,仍是分支自己的一轮', () => {
    const B5 = [u('g0', '离线同步怎么做?'), a('g1', '三条路线'), u('g2', '第一条改哪?'), a('g3', '换个答法')]
    const tree = buildTurnTree('R', [br('B5', 'a1', 'R', '2026-10-18 10:00:00')], (s) => ({ R, B5 } as Record<string, UiMessage[]>)[s])
    expect(tree.paths.B5).toEqual(['R:u1', 'B5:g2'])
  })

  it('分支只拉到最近一段(复制段被截掉了):照样挂在分叉卡下', () => {
    const B6 = [u('h2', '只看最近的'), a('h3', '好')]
    const tree = buildTurnTree('R', [br('B6', 'a2', 'R', '2026-10-18 10:00:00')], (s) => ({ R, B6 } as Record<string, UiMessage[]>)[s])
    expect(tree.paths.B6).toEqual(['R:u1', 'R:u2', 'B6:h2'])
  })

  it('分叉消息在来源里找不到(回退过):按问题文字对齐到对上的最后一轮', () => {
    const B7 = [u('k0', '离线同步怎么做?'), a('k1', '三条路线'), u('k2', '第一条改哪?'), a('k3', '四处'), u('k4', '另一条路')]
    const tree = buildTurnTree('R', [br('B7', 'gone', 'R', '2026-10-18 10:00:00')], (s) => ({ R, B7 } as Record<string, UiMessage[]>)[s])
    expect(tree.paths.B7).toEqual(['R:u1', 'R:u2', 'B7:k4'])
  })

  it('主线后来把分叉那一轮重新生成了:分支存的是旧回答,不并进主线那张卡,自成一棵', () => {
    const R2 = [u('u1', '离线同步怎么做?'), a('a1x', '换了个答法'), u('u2', '第一条改哪?'), a('a2', '四处')]
    const tree = buildTurnTree('R', [br('B1', 'a1', 'R', '2026-10-18 10:00:00')], (s) => ({ R: R2, B1 } as Record<string, UiMessage[]>)[s])
    expect(tree.paths.B1).toEqual(['B1:b-u1', 'B1:c1', 'B1:c3'])
    expect(tree.roots).toEqual(['R:u1', 'B1:b-u1'])
  })

  it('两边窗口错开(主线只拉到后面一段,分支拉到更早的副本):早于主线窗口的副本不画,不重复挂到分叉卡后面', () => {
    const turn = (p: string, i: number) => [u(`${p}q${i}`, `问题 ${i}`), a(`${p}a${i}`, `回答 ${i}`)]
    const Rw = Array.from({ length: 6 }, (_, i) => turn('', i + 5)).flat() // 主线只拉到第 5–10 轮
    const Bw = [...Array.from({ length: 6 }, (_, i) => turn('b', i + 2)).flat(), u('own', '分支自己问的'), a('own-a', '好')] // 分支拉到第 2–7 轮的副本
    const tree = buildTurnTree('R', [br('Bw', 'a7', 'R', '2026-10-18 10:00:00')], (s) => ({ R: Rw, Bw } as Record<string, UiMessage[]>)[s])
    expect(tree.paths.Bw).toEqual(['R:q5', 'R:q6', 'R:q7', 'Bw:own'])
    expect(tree.cards.get('R:q5')!.at.Bw).toEqual({ first: 'bq5', last: 'ba5' })
    expect(tree.cards.size).toBe(7)
  })

  it('分叉点在一轮中间(这一轮后面还有回答):副本只抄到那条,照样认成同一轮', () => {
    const Rm = [u('u1', 'Q'), a('a1', 'A1'), a('a1b', 'A2')]
    const Bm = [u('m0', 'Q'), a('m1', 'A1'), u('m2', '另问')]
    const tree = buildTurnTree('R', [br('Bm', 'a1', 'R', '2026-10-18 10:00:00')], (s) => ({ R: Rm, Bm } as Record<string, UiMessage[]>)[s])
    expect(tree.paths.Bm).toEqual(['R:u1', 'Bm:m2'])
  })

  it('来源还没拉到历史:先不画这一支', () => {
    const tree = buildTurnTree('R', [br('B1', 'a1', 'R', '2026-10-18 10:00:00')], (s) => (s === 'B1' ? B1 : undefined))
    expect(tree.cards.size).toBe(0)
    expect(tree.paths.B1).toBeUndefined()
  })
})

describe('buildTurnTree 子会话(方案「画布子会话显示」A)', () => {
  // 子会话 K1 由主线 a2 开出(第一句是简报);K2 认不到开出它的消息;K3 开在分支 B1 自己的那一轮(c2)里
  const K1 = [u('k1', '查 Obsidian Sync 的冲突处理(简报)'), a('k2', '按段合并'), u('k3', '附件呢?'), a('k4', '后写的赢')]
  const K2 = [u('m1', '数大文件(简报)'), a('m2', '41 个')]
  const K3 = [u('n1', '量一下 Yjs 包(简报)'), a('n2', '90 KB')]
  const rows = { R, B1, K1, K2, K3 } as Record<string, UiMessage[]>
  const tree = buildTurnTree('R', [br('B1', 'a1', 'R', '2026-10-18 10:00:00')], (s) => rows[s], [
    { sid: 'K1', from: 'R', at: 'a2' }, { sid: 'K2', from: 'R', at: 'gone' }, { sid: 'K3', from: 'B1', at: 'c2' },
  ])
  it('整份对话都是自己的轮次,挂在开出它的那张卡下,排在主线之后', () => {
    expect(tree.paths.K1).toEqual(['R:u1', 'R:u2', 'K1:k1', 'K1:k3'])
    expect(tree.cards.get('R:u2')!.children).toEqual(['R:u3', 'K1:k1'])
    expect(tree.cards.get('K1:k1')!.user?.id).toBe('k1')
  })
  it('认不到开出它的消息:挂在那一支最后一张卡下', () => {
    expect(tree.paths.K2).toEqual(['R:u1', 'R:u2', 'R:u3', 'K2:m1'])
  })
  it('开在分支里的:挂在那一支自己的卡下', () => {
    expect(tree.paths.K3).toEqual(['R:u1', 'B1:c1', 'K3:n1'])
  })
  it('子会话一轮都没有:不画,也不记路径', () => {
    const t2 = buildTurnTree('R', [], (s) => (s === 'R' ? R : []), [{ sid: 'K1', from: 'R', at: 'a2' }])
    expect(t2.paths.K1).toBeUndefined()
  })
  it('开出它的会话还没拉到历史:先不画', () => {
    const t2 = buildTurnTree('R', [], (s) => (s === 'R' ? undefined : rows[s]), [{ sid: 'K1', from: 'R', at: 'a2' }])
    expect(t2.paths.K1).toBeUndefined()
    expect(t2.cards.size).toBe(0)
  })
})

describe('readSteps(阅读栏顶上的轮次)', () => {
  it('不超过 8 轮全列,多了折成「1 2 … 7 8 9」,只隔一轮不折', () => {
    expect(readSteps(3, 1)).toEqual([0, 1, 2])
    expect(readSteps(8, 7)).toEqual([0, 1, 2, 3, 4, 5, 6, 7])
    expect(readSteps(9, 7)).toEqual([0, 1, -1, 6, 7, 8])
    expect(readSteps(12, 0)).toEqual([0, 1, -1, 11])
    expect(readSteps(12, 5)).toEqual([0, 1, -1, 4, 5, 6, -1, 11])
    expect(readSteps(12, 3)).toEqual([0, 1, 2, 3, 4, -1, 11])
  })
})
