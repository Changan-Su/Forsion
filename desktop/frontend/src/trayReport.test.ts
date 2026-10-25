import { describe, expect, it } from 'vitest'
import { traySessionRows } from './trayReport'

const rec = (id: string, extra: Record<string, unknown> = {}) => ({ id, title: `T ${id}`, updated_at: '2026-10-25 10:00:00', ...extra }) as any
const t = (k: string) => (k === 'session.untitled' ? '新会话' : k)

describe('托盘清单(借鉴 Comma 2.6)', () => {
  it('只要在跑 / 等你;等你在前,同类按最近更新排;未命名显示成「新会话」', () => {
    const rows = traySessionRows([
      rec('a', { busy: true, updated_at: '2026-10-25 09:00:00' }),
      rec('b', { busy: true, updated_at: '2026-10-25 11:00:00' }),
      rec('c', { awaiting_user: true }),
      rec('d'),
      rec('e', { title: 'New Chat' }),
      rec('f'),
    ], new Map([['e', { n: 1 }]]), { f: 'run-1' }, new Set(['d']), t)
    expect(rows).toEqual([
      { id: 'c', title: 'T c', state: 'wait' },
      { id: 'e', title: '新会话', state: 'wait' },
      { id: 'b', title: 'T b', state: 'run' },
      { id: 'f', title: 'T f', state: 'run' },
      { id: 'a', title: 'T a', state: 'run' },
    ])
  })
  it('封顶 max 条', () => {
    const many = Array.from({ length: 10 }, (_, i) => rec(`s${i}`, { busy: true }))
    expect(traySessionRows(many, new Map(), {}, new Set(), t, 3)).toHaveLength(3)
  })
})
