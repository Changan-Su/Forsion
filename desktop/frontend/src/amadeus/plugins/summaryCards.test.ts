import { afterEach, describe, expect, it } from 'vitest'
import { __resetSummaryCards, __summaryCardKeys as keys, registerSummaryCard, revokeSummaryCards } from './summaryCards'

const mount = (): void => {}

afterEach(() => __resetSummaryCards())

describe('summaryCards registry', () => {
  it('re-registering the same id replaces in place and silences the old handle', () => {
    const a = registerSummaryCard('cal', { id: 'today', title: 'A', mount })
    registerSummaryCard('cal', { id: 'week', title: 'W', mount })
    registerSummaryCard('cal', { id: 'today', title: 'A2', mount })
    expect(keys()).toEqual(['plugin:cal:today', 'plugin:cal:week'])
    a.dispose() // 旧 handle:不许把新条目撤掉
    expect(keys()).toEqual(['plugin:cal:today', 'plugin:cal:week'])
  })
  it('revoke removes only that plugin', () => {
    registerSummaryCard('cal', { id: 'today', title: 'A', mount })
    registerSummaryCard('other', { id: 'x', title: { zh: '甲', en: 'X' }, mount })
    revokeSummaryCards('cal')
    expect(keys()).toEqual(['plugin:other:x'])
  })
  it('rejects a card without id or mount', () => {
    expect(() => registerSummaryCard('cal', { id: '', title: 'A', mount })).toThrow()
    expect(() => registerSummaryCard('cal', { id: 'a', title: 'A' } as never)).toThrow()
  })
})
