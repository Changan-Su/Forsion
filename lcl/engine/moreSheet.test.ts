import { describe, expect, it } from 'vitest'
import { accountMenuItems, moreCommandGroups, moreCommandOn, moreCommandTitle, moreItems, moreRowLabel, presentedCommand } from './moreSheet'
import { useCommandStore } from './commandRegistry'
import type { Command, RibbonItem } from './types'

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
  it('ribbon row labels drop a trailing keyboard-shortcut hint (no keyboard on a phone); other parentheses stay', () => {
    expect(moreRowLabel('命令面板 (⌘K)')).toBe('命令面板')
    expect(moreRowLabel('Command palette (⌘K)')).toBe('Command palette')
    expect(moreRowLabel('查找（Ctrl+Shift+F）')).toBe('查找')
    expect(moreRowLabel('Theme (dark)')).toBe('Theme (dark)') // not a shortcut
    expect(moreRowLabel('(⌘K) first')).toBe('(⌘K) first') // only a trailing hint
    expect(moreRowLabel('(⌘K)')).toBe('(⌘K)') // never an empty row
    expect(moreRowLabel('Feedback')).toBe('Feedback')
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

describe('where settings and the foot entries live on a phone', () => {
  const rb = (id: string, extra: Partial<RibbonItem> = {}): RibbonItem => ({ id, side: 'bottom', onClick: () => {}, ...extra })
  const ALL = [rb('rb-theme'), rb('rb-settings'), rb('rb-units', { mobileFoot: true }), rb('rb-account'), rb('rb-palette'), rb('space:x', { side: 'top' })]
  const ids = (list: RibbonItem[]): string[] => list.map((i) => i.id)

  it('drawer shell (no native bottom bar): the drawer foot holds account / settings / foot entries → none of them in ⋯', () => {
    expect(ids(moreItems(ALL, false))).toEqual(['rb-theme', 'rb-palette'])
    expect(accountMenuItems(ALL, false)).toEqual([])
  })

  it('native bottom bar + an account item: settings and foot entries go to the avatar menu, not to ⋯', () => {
    expect(ids(accountMenuItems(ALL, true))).toEqual(['rb-settings', 'rb-units'])
    expect(ids(moreItems(ALL, true))).toEqual(['rb-theme', 'rb-palette'])
  })

  it('native bottom bar without an account item (no avatar): they stay in ⋯, leading', () => {
    const noAccount = ALL.filter((i) => i.id !== 'rb-account')
    expect(accountMenuItems(noAccount, true)).toEqual([])
    expect(ids(moreItems(noAccount, true))).toEqual(['rb-settings', 'rb-units', 'rb-theme', 'rb-palette'])
  })

  it('an entry is never lost: one the avatar menu cannot carry (no onClick) stays in ⋯', () => {
    const odd = [rb('rb-theme'), rb('rb-settings'), rb('rb-card', { mobileFoot: true, onClick: undefined }), rb('rb-account')]
    expect(ids(accountMenuItems(odd, true))).toEqual(['rb-settings'])
    expect(ids(moreItems(odd, true))).toEqual(['rb-card', 'rb-theme'])
    for (const native of [true, false]) {
      const noAccount = odd.filter((i) => i.id !== 'rb-account')
      const placed = new Set([...ids(moreItems(noAccount, native)), ...ids(accountMenuItems(noAccount, native))])
      // drawer shell: the foot row holds them; native: one of the two menus must
      if (native) expect([...placed].sort()).toEqual(['rb-card', 'rb-settings', 'rb-theme'])
    }
  })
})
