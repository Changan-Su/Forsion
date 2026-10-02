import { describe, expect, it } from 'vitest'
import { moreCommandGroups, moreCommandOn, moreCommandTitle, presentedCommand } from './moreSheet'
import { useCommandStore } from './commandRegistry'
import type { Command } from './types'

const cmd = (id: string, extra: Partial<Command> = {}): Command => ({ id, title: id, run: () => {}, ...extra })

describe('more sheet command groups', () => {
  it('only commands that declare moreGroup are listed; groups keep first-seen order and merge by id', () => {
    let lang = 'zh'
    const groups = moreCommandGroups([
      cmd('core:palette'),
      cmd('amadeus:a:one', { moreGroup: { id: 'amadeus:a', title: () => (lang === 'en' ? 'Plugin A' : '插件 A') } }),
      cmd('amadeus:b:one', { moreGroup: { id: 'amadeus:b', title: 'Plugin B' } }),
      cmd('amadeus:a:two', { moreGroup: { id: 'amadeus:a', title: 'ignored: first declaration names the group' } }),
    ])
    expect(groups.map((g) => [g.id, g.title, g.commands.map((c) => c.id)])).toEqual([
      ['amadeus:a', '插件 A', ['amadeus:a:one', 'amadeus:a:two']],
      ['amadeus:b', 'Plugin B', ['amadeus:b:one']],
    ])
    lang = 'en' // titles are evaluated per build (= per sheet open), so a language switch follows
    expect(moreCommandGroups([cmd('x', { moreGroup: { id: 'amadeus:a', title: () => (lang === 'en' ? 'Plugin A' : '插件 A') } })])[0].title).toBe('Plugin A')
  })

  it('no group declared anywhere → no sections (desktop / plain hosts render exactly as before)', () => {
    expect(moreCommandGroups([cmd('a'), cmd('b', { hotkey: 'mod+b' })])).toEqual([])
    expect(moreCommandGroups([cmd('c', { moreGroup: { id: '', title: 'empty id' } })])).toEqual([])
  })

  it('a throwing title never breaks the sheet: group title → empty, command title → its id', () => {
    const boom = (): string => { throw new Error('boom') }
    const [g] = moreCommandGroups([cmd('amadeus:p:x', { title: boom, moreGroup: { id: 'amadeus:p', title: boom } })])
    expect(g.title).toBe('')
    expect(moreCommandTitle(g.commands[0])).toBe('amadeus:p:x')
  })

  it('toggle state: only an on toggle is checked; missing or throwing checked() = off', () => {
    expect(moreCommandOn(cmd('a'))).toBe(false)
    expect(moreCommandOn(cmd('b', { checked: () => true }))).toBe(true)
    expect(moreCommandOn(cmd('c', { checked: () => false }))).toBe(false)
    expect(moreCommandOn(cmd('d', { checked: () => { throw new Error('x') } }))).toBe(false)
  })
  it('a pick only resolves to the command object that was presented (re-registered / removed ids do nothing)', () => {
    const ran: string[] = []
    const store = useCommandStore.getState()
    const shown = cmd('amadeus:p:go', { run: () => { ran.push('shown') }, moreGroup: { id: 'amadeus:p', title: 'P' } })
    const other = cmd('amadeus:p:other', { moreGroup: { id: 'amadeus:p', title: 'P' } })
    store.addCommand(shown)
    store.addCommand(other)
    try {
      const presented = moreCommandGroups(useCommandStore.getState().commands).flatMap((g) => g.commands) // sheet opens: snapshot
      const live = (): readonly Command[] => useCommandStore.getState().commands
      expect(presentedCommand(presented, live(), 'amadeus:p:go')).toBe(shown)
      // The plugin reloads while the sheet is open: same id, different handler.
      store.addCommand(cmd('amadeus:p:go', { run: () => { ran.push('replacement') }, moreGroup: { id: 'amadeus:p', title: 'P' } }))
      expect(presentedCommand(presented, live(), 'amadeus:p:go')).toBeNull()
      expect(presentedCommand(presented, live(), 'amadeus:p:other')).toBe(other) // untouched rows still work
      // Unregistered while open, or an id that was never on the sheet.
      store.removeCommand('amadeus:p:other')
      expect(presentedCommand(presented, live(), 'amadeus:p:other')).toBeNull()
      expect(presentedCommand(presented, live(), 'core:never-presented')).toBeNull()
      expect(ran).toEqual([])
    } finally {
      store.removeCommand('amadeus:p:go')
      store.removeCommand('amadeus:p:other')
    }
  })
})
