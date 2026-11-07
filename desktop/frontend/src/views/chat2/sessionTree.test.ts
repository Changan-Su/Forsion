import { describe, expect, it } from 'vitest'
import { mergeStatus, nestSessions } from './sessionTree'

const s = (id: string, parent?: string, created = '2026-10-17 10:00:00', updated?: string) => ({ id, parent_session_id: parent ?? null, created_at: created, updated_at: updated ?? created })

describe('nestSessions', () => {
  it('子会话挂在同组列出的主会话下面,新的在上;主会话没列出来的平铺', () => {
    const tree = nestSessions([s('p'), s('k2', 'p', '2026-10-17 10:02:00'), s('x'), s('k1', 'p', '2026-10-17 10:01:00'), s('orphan', 'gone')])
    expect(tree.map((n) => [n.s.id, n.kids.map((k) => k.id)])).toEqual([['p', ['k2', 'k1']], ['x', []], ['orphan', []]])
  })
  it('子会话按最近活动排,与主会话列表同口径:后开的、但先停下的排在后面', () => {
    const tree = nestSessions([
      s('p'),
      s('old', 'p', '2026-10-17 10:01:00', '2026-10-17 11:30:00'), // 先开、刚刚还在动
      s('new', 'p', '2026-10-17 10:05:00', '2026-10-17 10:06:00'),
      s('same', 'p', '2026-10-17 10:07:00', '2026-10-17 10:06:00'), // 与 new 同一刻活动 → 后开的在上
    ])
    expect(tree[0].kids.map((k) => k.id)).toEqual(['old', 'same', 'new'])
  })
  it('只一层:孙会话按普通行平铺', () => {
    const tree = nestSessions([s('p'), s('k', 'p'), s('g', 'k')])
    expect(tree.map((n) => [n.s.id, n.kids.map((k) => k.id)])).toEqual([['p', ['k']], ['g', []]])
  })
})

describe('mergeStatus', () => {
  it('等你 > 在跑 > 做完了', () => {
    expect(mergeStatus(['done', 'run', ''])).toBe('run')
    expect(mergeStatus(['run', 'wait'])).toBe('wait')
    expect(mergeStatus(['', 'done'])).toBe('done')
    expect(mergeStatus(['', ''])).toBe('')
  })
})
