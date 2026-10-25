import { describe, expect, it } from 'vitest'
import { childPillCounts } from './ChildSessions'
import { rowStatus, type RowStatus } from './sessionTree'

const rec = (id: string, extra: Record<string, unknown> = {}) => ({ id, title: id, ...extra }) as any

describe('子会话药丸计数(借鉴 Comma 2.2)', () => {
  const sessions = [
    rec('p'),
    rec('k1', { parent_session_id: 'p', busy: true }),
    rec('k2', { parent_session_id: 'p', awaiting_user: true }),
    rec('k3', { parent_session_id: 'p' }), // 做完了
    rec('br', { parent_session_id: 'p', fork_message_id: 'm1', busy: true }), // 分支不算子会话
    rec('x', { parent_session_id: 'other', busy: true }),
  ]
  const st = (attention: Set<string> = new Set(), running: Set<string> = new Set(), unread: Set<string> = new Set()) =>
    (s: any): RowStatus => rowStatus(s, attention.has(s.id), running.has(s.id), unread.has(s.id))

  it('只数本会话的子会话,分支和别人的不算;做完了的不算', () => {
    expect(childPillCounts('p', sessions, st(new Set(), new Set(), new Set(['k3'])))).toEqual({ ids: ['k1', 'k2'], run: 1, wait: 1 })
  })
  it('审批在等 = 等你(压过在跑);本端订阅着的 run = 在跑', () => {
    expect(childPillCounts('p', sessions, st(new Set(['k1']), new Set(['k3'])))).toEqual({ ids: ['k1', 'k2', 'k3'], run: 1, wait: 2 })
  })
  it('全做完 / 没有会话 id:计数为 0', () => {
    const done = sessions.map((s) => ({ ...s, busy: false, awaiting_user: false }))
    expect(childPillCounts('p', done, st())).toEqual({ ids: [], run: 0, wait: 0 })
    expect(childPillCounts(null, sessions, st())).toEqual({ ids: [], run: 0, wait: 0 })
  })
})
