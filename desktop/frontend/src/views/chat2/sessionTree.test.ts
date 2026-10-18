import { describe, expect, it } from 'vitest'
import { mergeStatus, nestSessions } from './sessionTree'

const s = (id: string, parent?: string, created = '2026-10-17 10:00:00') => ({ id, parent_session_id: parent ?? null, created_at: created })

describe('nestSessions', () => {
  it('子会话挂在同组列出的主会话下面,按开出的先后排;主会话没列出来的平铺', () => {
    const tree = nestSessions([s('p'), s('k2', 'p', '2026-10-17 10:02:00'), s('x'), s('k1', 'p', '2026-10-17 10:01:00'), s('orphan', 'gone')])
    expect(tree.map((n) => [n.s.id, n.kids.map((k) => k.id)])).toEqual([['p', ['k1', 'k2']], ['x', []], ['orphan', []]])
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
