/** 手机主页「继续」的取数(homeContinue.tsx):对话和笔记混排、按时间新的在前,最多三项。 */
import { describe, expect, it } from 'vitest'
import { continueRows } from './homeContinue'

const iso = (ms: number): string => new Date(ms).toISOString()
const T = Date.UTC(2026, 10, 19, 8, 0, 0)
const MIN = 60_000
const session = (id: string, ago: number, extra: Record<string, unknown> = {}) => ({
  id, title: `chat ${id}`, summary: `about ${id}`, model_id: null, archived: false, emoji: null, agent_config: null,
  created_at: iso(T - 100 * MIN), updated_at: iso(T - ago), ...extra,
}) as never
const base = { sessionTitle: (s: { title: string | null }) => s.title ?? '', pages: ['plan.md', 'proj/release 2.13.md', 'old.md'], files: ['proj/sketch.excalidraw.md'] }

describe('home Continue rows', () => {
  it('mixes chats and notes by time, newest first, three at most; a note keeps its folder as the second line', () => {
    const rows = continueRows({
      ...base,
      sessions: [session('a', 4 * MIN), session('b', 38 * MIN)],
      recents: [{ key: 'note:proj/release 2.13.md', kind: 'note', id: 'proj/release 2.13.md', title: 'x', ts: T - 25 * MIN }],
      prefsRecents: ['plan.md'],
    })
    expect(rows.map((r) => [r.kind, r.title, r.sub])).toEqual([['chat', 'chat a', 'about a'], ['note', 'release 2.13', 'proj'], ['chat', 'chat b', 'about b']])
  })

  it('skips archived chats, child sessions / branches, notes that are no longer in the vault; notes without a time come last', () => {
    const rows = continueRows({
      ...base,
      sessions: [session('arch', 1 * MIN, { archived: true }), session('kid', 2 * MIN, { parent_session_id: 'a' })],
      recents: [{ key: 'note:gone.md', kind: 'note', id: 'gone.md', title: 'gone', ts: T }, { key: 'chat:x', kind: 'chat', id: 'x', title: 'x', ts: T }],
      prefsRecents: ['old.md', 'plan.md'],
    })
    expect(rows.map((r) => [r.id, r.at])).toEqual([['old.md', 0], ['plan.md', 0]])
  })

  it('a drawing is a file row that reopens through its view type; nothing at all = no rows (the card is not drawn)', () => {
    const rows = continueRows({
      ...base, sessions: [],
      recents: [{ key: 'file:amadeus-drawing:proj/sketch.excalidraw.md', kind: 'file', id: 'proj/sketch.excalidraw.md', viewType: 'amadeus-drawing', title: 's', ts: T }],
      prefsRecents: [],
    })
    expect(rows).toMatchObject([{ kind: 'file', viewType: 'amadeus-drawing', title: 'sketch', sub: 'proj' }])
    expect(continueRows({ ...base, sessions: [], recents: [], prefsRecents: [] })).toEqual([])
  })
})
