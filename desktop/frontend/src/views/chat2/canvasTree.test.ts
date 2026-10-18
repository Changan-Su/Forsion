import { describe, expect, it } from 'vitest'
import type { SessionRecord, UiMessage } from '../../types'
import { buildTurnTree, splitTurns } from './canvasTree'

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

  it('来源还没拉到历史:先不画这一支', () => {
    const tree = buildTurnTree('R', [br('B1', 'a1', 'R', '2026-10-18 10:00:00')], (s) => (s === 'B1' ? B1 : undefined))
    expect(tree.cards.size).toBe(0)
    expect(tree.paths.B1).toBeUndefined()
  })
})
