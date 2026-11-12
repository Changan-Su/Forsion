import { describe, expect, it } from 'vitest'
import { mergeStatus, nestSessions, sessionAncestors, sessionDescendants } from './sessionTree'

const s = (id: string, parent?: string, created = '2026-10-17 10:00:00', updated?: string) => ({ id, parent_session_id: parent ?? null, created_at: created, updated_at: updated ?? created })

describe('nestSessions', () => {
  it('子会话挂在同组列出的主会话下面,新的在上;主会话没列出来的平铺', () => {
    const tree = nestSessions([s('p'), s('k2', 'p', '2026-10-17 10:02:00'), s('x'), s('k1', 'p', '2026-10-17 10:01:00'), s('orphan', 'gone')])
    expect(tree.map((n) => [n.s.id, n.kids.map((k) => k.s.id)])).toEqual([['p', ['k2', 'k1']], ['x', []], ['orphan', []]])
  })
  it('子会话按最近活动排,与主会话列表同口径:后开的、但先停下的排在后面', () => {
    const tree = nestSessions([
      s('p'),
      s('old', 'p', '2026-10-17 10:01:00', '2026-10-17 11:30:00'), // 先开、刚刚还在动
      s('new', 'p', '2026-10-17 10:05:00', '2026-10-17 10:06:00'),
      s('same', 'p', '2026-10-17 10:07:00', '2026-10-17 10:06:00'), // 与 new 同一刻活动 → 后开的在上
    ])
    expect(tree[0].kids.map((k) => k.s.id)).toEqual(['old', 'same', 'new'])
  })
  it('recursively keeps grandchildren under their real parent', () => {
    const input = [s('p'), s('k', 'p'), s('g', 'k'), s('deep', 'g')]
    const tree = nestSessions(input)
    expect(tree).toHaveLength(1)
    expect(tree[0].kids[0].kids[0].s.id).toBe('g')
    expect(sessionDescendants(tree[0]).map((x) => x.id)).toEqual(['k', 'g', 'deep'])
    expect(sessionAncestors(input[3], input).ancestors.map((x) => x.id)).toEqual(['p', 'k', 'g'])
  })
  it('keeps every record once when cyclic, missing or self parent links occur', () => {
    const input = [s('a', 'b'), s('b', 'a'), s('c', 'b'), s('self', 'self'), s('orphan', 'gone')]
    const before = JSON.stringify(input)
    const ids = nestSessions(input).flatMap((n) => [n.s, ...sessionDescendants(n)]).map((x) => x.id)
    expect(ids.sort()).toEqual(['a', 'b', 'c', 'orphan', 'self'])
    expect(JSON.stringify(input)).toBe(before)
    expect(sessionAncestors(input[0], input).cyclic).toBe(true)
    expect(sessionAncestors(input[4], input).missing).toBe(true)
  })
  it('displays pinned children once at the root without changing parent records', () => {
    const records = [s('p'), s('child', 'p'), s('grand', 'child')]
    const tree = nestSessions(records, new Set(['child']))
    expect(tree.map((n) => n.s.id)).toEqual(['p', 'child'])
    expect(tree[0].kids).toEqual([])
    expect(tree[1].kids[0].s.id).toBe('grand')
    expect(tree[1].s.parent_session_id).toBe('p')
  })
  it('promotes a filtered child only for display while keeping its source path', () => {
    const input = [s('p'), s('k', 'p'), s('g', 'k')]
    expect(nestSessions(input.slice(2))[0].s.parent_session_id).toBe('k')
    expect(sessionAncestors(input[2], input).ancestors.map((x) => x.id)).toEqual(['p', 'k'])
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
