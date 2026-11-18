import { describe, expect, it } from 'vitest'
import type { UiMessage } from '../../../../../tangu-agent/src/contracts/clientTypes'
import { TIME_GAP_MS, isTeamConfig, quietMarksOf, quietTokens } from './messageQuiet'

const MIN = 60_000
const T0 = 1_700_000_000_000
const user = (id: string, min: number, content = 'hi'): UiMessage => ({ id, role: 'user', content, timestamp: T0 + min * MIN })
const asst = (id: string, min: number, extra: Partial<UiMessage> = {}): UiMessage => ({ id, role: 'assistant', content: 'ok', status: 'done', timestamp: T0 + min * MIN, ...extra })
const tokens = (rows: UiMessage[], cfg: Parameters<typeof quietTokens>[1] = {}) => Object.fromEntries(rows.map((m) => [m.id, quietTokens(rows, cfg, m.id)]))

describe('which messages write their time', () => {
  it('the first one, and each one more than five minutes after the one before it', () => {
    const rows = [user('u1', 0), asst('a1', 1), user('u2', 6), asst('a2', 6.5), user('u3', 12), asst('a3', 30)]
    expect(tokens(rows)).toEqual({ u1: 'gap', a1: 'solo', u2: '', a2: 'solo', u3: 'gap', a3: 'gap last solo' })
  })
  it('exactly five minutes is not "more than"', () => {
    const rows = [user('u1', 0), { ...user('u2', 0), timestamp: T0 + TIME_GAP_MS }, { ...user('u3', 0), timestamp: T0 + 2 * TIME_GAP_MS + 1 }]
    expect(tokens(rows)).toEqual({ u1: 'gap', u2: '', u3: 'gap' })
  })
  it('measured from the bubble before: system rows, machine rows and rows the list does not draw are not "the one before"', () => {
    const rows: UiMessage[] = [
      user('u1', 0),
      { id: 's1', role: 'system', content: 'compacted', timestamp: T0 + 4 * MIN },
      user('m1', 4, '<approval_update>…</approval_update>'),
      user('m2', 4, '<turn_interrupted>'),
      asst('w1', 4, { content: '', work: { state: 'working' } as UiMessage['work'] }),
      asst('sum', 4, { teamSummary: true }),
      asst('a1', 5.5),
    ]
    const got = tokens(rows)
    expect(got.a1).toBe('gap last solo') // 5.5 min after u1, though other rows sit in between
    expect([got.s1, got.m1, got.m2, got.w1, got.sum]).toEqual([undefined, undefined, undefined, undefined, undefined])
  })
  it('old messages stored without a time never write one and do not reset the count', () => {
    const rows = [user('u1', 0), { ...asst('a1', 0), timestamp: 0 }, user('u2', 3)]
    expect(tokens(rows)).toEqual({ u1: 'gap', a1: 'last solo', u2: '' })
  })
})

describe('the last answer', () => {
  it('is the last assistant bubble, whatever follows it', () => {
    const rows = [user('u1', 0), asst('a1', 1), user('u2', 2), asst('a2', 3), user('u3', 4)]
    const marks = quietMarksOf(rows)
    expect([...marks.bits].filter(([, b]) => b & 2).map(([id]) => id)).toEqual(['a2'])
  })
  it('a reply still streaming is already the last one: the row under the answer before it folds away', () => {
    const rows = [user('u1', 0), asst('a1', 1), user('u2', 2), asst('a2', 2, { status: 'streaming', content: '' })]
    expect(tokens(rows)).toMatchObject({ a1: 'solo', a2: 'last solo' })
  })
})

describe('one agent or several', () => {
  it('team, group and team-member sessions keep the names', () => {
    expect(isTeamConfig({})).toBe(false)
    expect(isTeamConfig(undefined)).toBe(false)
    expect(isTeamConfig({ soloAgentSlug: 'researcher' })).toBe(false)
    expect(isTeamConfig({ groupAgents: ['only'] })).toBe(false)
    for (const cfg of [{ groupChat: true }, { teamSlug: 'weekly' }, { teamMember: { teamSessionId: 't' } }, { groupAgents: ['a', 'b'] }]) expect(isTeamConfig(cfg)).toBe(true)
    const rows = [user('u1', 0), asst('a1', 1)]
    expect(tokens(rows, { teamSlug: 'weekly' }).a1).toBe('last')
  })
  it('several speakers among the answers keep the names even under a single-agent config', () => {
    const rows = [user('u1', 0), asst('a1', 1, { agentId: 'researcher' }), user('u2', 2), asst('a2', 3, { agentId: 'editor' })]
    expect(tokens(rows)).toMatchObject({ a1: '', a2: 'last' })
    const one = [user('u1', 0), asst('a1', 1, { agentId: 'researcher' }), asst('a2', 2, { agentId: 'researcher' })]
    expect(tokens(one)).toMatchObject({ a1: 'solo', a2: 'last solo' })
    // answers stored before the speaker was recorded belong to the session's own agent: they do not make a second speaker
    const old = [user('u1', 0), asst('a1', 1), user('u2', 2), asst('a2', 3, { agentId: 'researcher' })]
    expect(tokens(old)).toMatchObject({ a1: 'solo', a2: 'last solo' })
    // an external engine's answers carry a name and no id
    const engines = [asst('a1', 1, { agentName: 'Codex' }), asst('a2', 2, { agentName: 'Claude Code' })]
    expect(tokens(engines)).toMatchObject({ a1: 'gap', a2: 'last' })
  })
})

describe('quietTokens', () => {
  it('a message that is not in the list (a preview, a send not yet read) gets no marks at all', () => {
    const rows = [user('u1', 0)]
    expect(quietTokens(rows, {}, 'elsewhere')).toBeUndefined()
    expect(quietTokens(undefined, {}, 'u1')).toBeUndefined()
  })
  it('gives the same string for the same marks, so a subscriber sees no change', () => {
    const rows = [user('u1', 0), asst('a1', 1)]
    expect(quietTokens(rows, {}, 'a1')).toBe(quietTokens([...rows], {}, 'a1'))
  })
})
