import { describe, expect, it } from 'vitest'
import { accountMenuItems, allSheetItems, moreCommandGroups, moreCommandOn, moreCommandTitle, moreItems, moreRowLabel, phonePageItems, presentedCommand } from './moreSheet'
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

describe('on a phone ⋯ holds only the page\'s own things: where the app-wide entries go', () => {
  const rb = (id: string, extra: Partial<RibbonItem> = {}): RibbonItem => ({ id, side: 'bottom', onClick: () => {}, ...extra })
  // the app's own bottom zone, in registration order, plus a first-party ribbon action and a Space icon of the top zone
  const ALL = [
    rb('rb-achievements'), rb('rb-mode'), rb('rb-plugin-events'), rb('rb-market'), rb('rb-feedback'), rb('rb-cmd'),
    rb('rb-settings'), rb('rb-units', { mobileFoot: true }), rb('rb-account'), rb('space:x', { side: 'top' }),
  ]
  const ids = (list: RibbonItem[]): string[] => list.map((i) => i.id)
  const PHONE = { phone: true, allCell: true }

  it('the two app-wide switches follow settings into the avatar menu; every other launcher goes to the all-Spaces sheet; ⋯ keeps none', () => {
    expect(ids(accountMenuItems(ALL, true, true))).toEqual(['rb-settings', 'rb-units', 'rb-mode', 'rb-cmd'])
    expect(ids(allSheetItems(ALL, PHONE))).toEqual(['rb-achievements', 'rb-plugin-events', 'rb-market', 'rb-feedback'])
    expect(moreItems(ALL, true, PHONE)).toEqual([])
  })

  it('not a phone (a tablet in landscape, the drawer shell): nothing moves — the same lists as before', () => {
    for (const seats of [undefined, { phone: false, allCell: true }]) {
      expect(ids(moreItems(ALL, true, seats))).toEqual(['rb-achievements', 'rb-mode', 'rb-plugin-events', 'rb-market', 'rb-feedback', 'rb-cmd'])
      expect(ids(accountMenuItems(ALL, true, false))).toEqual(['rb-settings', 'rb-units'])
    }
    expect(allSheetItems(ALL, { phone: false, allCell: true })).toEqual([])
    expect(ids(moreItems(ALL, false, PHONE))).toEqual(['rb-achievements', 'rb-mode', 'rb-plugin-events', 'rb-market', 'rb-feedback', 'rb-cmd']) // no native bar = no phone seats at all
  })

  it('a dock without an "all" cell cannot open that sheet: the launchers stay in ⋯ (the switches still go to the avatar)', () => {
    const seats = { phone: true, allCell: false }
    expect(allSheetItems(ALL, seats)).toEqual([])
    expect(ids(moreItems(ALL, true, seats))).toEqual(['rb-achievements', 'rb-plugin-events', 'rb-market', 'rb-feedback'])
  })

  it('no avatar (no account item): settings and the switches have no menu to go to and stay in ⋯; the launchers still move', () => {
    const noAccount = ALL.filter((i) => i.id !== 'rb-account')
    expect(accountMenuItems(noAccount, true, true)).toEqual([])
    expect(ids(moreItems(noAccount, true, PHONE))).toEqual(['rb-settings', 'rb-units', 'rb-mode', 'rb-cmd'])
  })

  it('an entry is never lost: each bottom item is in exactly one of the three places, whatever the host has', () => {
    const odd = [...ALL, rb('rb-card', { onClick: undefined }), rb('rb-widget', { onClick: undefined, component: () => null })]
    for (const account of [true, false]) for (const allCell of [true, false]) {
      const list = account ? odd : odd.filter((i) => i.id !== 'rb-account')
      const seats = { phone: true, allCell }
      const placed = [...ids(moreItems(list, true, seats)), ...ids(accountMenuItems(list, true, true)), ...ids(allSheetItems(list, seats))]
      const want = list.filter((i) => i.side === 'bottom' && i.id !== 'rb-account').map((i) => i.id)
      expect([...placed].sort()).toEqual([...want].sort()) // no duplicates, none missing
    }
    // what a native sheet cannot draw (a component) or run (no onClick) stays in ⋯
    expect(ids(moreItems(odd, true, PHONE))).toEqual(['rb-card', 'rb-widget'])
  })

  it('a switch that carries a component stays in ⋯: the avatar menu draws an icon and a name, the component would be dropped', () => {
    const list = ALL.map((i) => (i.id === 'rb-mode' ? rb('rb-mode', { component: () => null }) : i))
    expect(ids(accountMenuItems(list, true, true))).toEqual(['rb-settings', 'rb-units', 'rb-cmd'])
    expect(ids(allSheetItems(list, PHONE))).not.toContain('rb-mode')
    expect(ids(moreItems(list, true, PHONE))).toEqual(['rb-mode'])
  })

  it('command groups: on a phone a group with `when` is listed only while it answers true; elsewhere `when` is not asked', () => {
    let here = false
    let asked = 0
    const mine = { id: 'amadeus:p', title: 'Plugin P', when: () => { asked++; return here } }
    const cmds = [
      cmd('amadeus:p:one', { moreGroup: mine }), cmd('amadeus:p:two', { moreGroup: { id: 'amadeus:p', title: 'x' } }),
      cmd('view:grid', { moreGroup: { id: 'lcl-view-mode', title: 'View' } }),
      cmd('amadeus:q:one', { moreGroup: { id: 'amadeus:q', title: 'Q', when: () => { throw new Error('boom') } } }),
    ]
    expect(moreCommandGroups(cmds, true).map((g) => g.id)).toEqual(['lcl-view-mode']) // P is elsewhere, Q throws = not here
    expect(asked).toBe(1) // once per group, not per command
    here = true
    expect(moreCommandGroups(cmds, true).map((g) => [g.id, g.commands.length])).toEqual([['amadeus:p', 2], ['lcl-view-mode', 1]])
    asked = 0
    expect(moreCommandGroups(cmds).map((g) => g.id)).toEqual(['amadeus:p', 'lcl-view-mode', 'amadeus:q'])
    expect(asked).toBe(0)
  })
})

describe('a phone with the Apps / Me pages (fixed five-cell dock, 2026-11-19): the avatar menu and the all-Spaces sheet are gone', () => {
  const rb = (id: string, extra: Partial<RibbonItem> = {}): RibbonItem => ({ id, side: 'bottom', onClick: () => {}, ...extra })
  const ALL = [
    rb('rb-achievements'), rb('rb-mode'), rb('rb-plugin-events'), rb('rb-plugin-biz'), rb('rb-market'), rb('rb-feedback'), rb('rb-cmd'),
    rb('rb-settings'), rb('rb-units', { mobileFoot: true }), rb('rb-account'), rb('rb-widget', { component: () => null }), rb('rb-dead', { onClick: undefined }),
    rb('space:x', { side: 'top' }),
  ]
  const ids = (list: RibbonItem[]): string[] => list.map((i) => i.id)
  const PAGES = { phone: true, allCell: true, pages: true }

  it('Me = settings, where it runs, the two switches, then achievements / events / feedback; Apps = the store first, then every other launcher', () => {
    const p = phonePageItems(ALL, PAGES)
    expect(ids(p.me.settings)).toEqual(['rb-settings', 'rb-units', 'rb-mode', 'rb-cmd'])
    expect(ids(p.me.launchers)).toEqual(['rb-achievements', 'rb-plugin-events', 'rb-feedback'])
    expect(ids(p.apps)).toEqual(['rb-market', 'rb-plugin-biz'])
    expect(accountMenuItems(ALL, true, true, true)).toEqual([]) // no avatar menu on such a phone: the rows are on the Me page
    expect(allSheetItems(ALL, PAGES)).toEqual([])
    expect(ids(moreItems(ALL, true, PAGES))).toEqual(['rb-widget', 'rb-dead']) // what no page can draw stays in ⋯
  })

  it('nothing is lost and nothing shows twice: every bottom item but the account is in exactly one of Apps, Me or ⋯', () => {
    for (const list of [ALL, ALL.filter((i) => i.id !== 'rb-account'), ALL.filter((i) => i.id !== 'rb-market' && i.id !== 'rb-settings')]) {
      const p = phonePageItems(list, PAGES)
      const placed = [...ids(p.apps), ...ids(p.me.settings), ...ids(p.me.launchers), ...ids(moreItems(list, true, PAGES))]
      expect(new Set(placed).size).toBe(placed.length)
      expect([...placed].sort()).toEqual(list.filter((i) => i.side === 'bottom' && i.id !== 'rb-account').map((i) => i.id).sort())
    }
  })

  it('not this layout (no pages installed, a tablet on its side): the pages hold nothing and the old seats apply', () => {
    for (const seats of [{ phone: true, allCell: true }, { phone: false, allCell: true, pages: true }]) {
      const p = phonePageItems(ALL, seats)
      expect([...p.apps, ...p.me.settings, ...p.me.launchers]).toEqual([])
    }
    expect(ids(accountMenuItems(ALL, true, false, true))).toEqual(['rb-settings', 'rb-units']) // the rail's avatar menu is unchanged
  })
})
