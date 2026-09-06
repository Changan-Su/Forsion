import { describe, expect, it } from 'vitest'
import type { DockviewApi } from 'dockview-react'
import { withoutTransientPanels } from './transientLayout'

type Layout = ReturnType<DockviewApi['toJSON']>
const panel = (id: string, transient = false) => ({ id, contentComponent: transient ? '__extend' : '__frame', params: { __type: transient ? '__extend' : 'editor', path: `${id}.md` } })
const leaf = (id: string, views: string[]) => ({ type: 'leaf' as const, size: 400, data: { id, views, activeView: views.at(-1) } })

describe('transient panel persistence', () => {
  it('keeps regular tabs and their params while removing a temporary side group', () => {
    const live: Layout = {
      grid: { width: 1000, height: 700, orientation: 'HORIZONTAL' as Layout['grid']['orientation'], root: { type: 'branch', data: [leaf('main', ['note', 'new-note']), leaf('right', ['temp'])] } },
      panels: { note: panel('note'), 'new-note': panel('new-note'), temp: panel('temp', true) }, activeGroup: 'right',
    }
    const saved = withoutTransientPanels(live)
    expect(Object.keys(saved.panels)).toEqual(['note', 'new-note'])
    expect(saved.panels['new-note'].params?.path).toBe('new-note.md')
    expect(saved.activeGroup).toBeUndefined()
    expect(JSON.stringify(saved)).not.toContain('__extend')
    expect(JSON.stringify(saved.grid)).not.toContain('right')
    expect(live.panels.temp).toBeDefined()
    expect(live.activeGroup).toBe('right')
  })

  it('removes only the transient tab from a shared native right group', () => {
    const live: Layout = {
      grid: { width: 1000, height: 700, orientation: 'HORIZONTAL' as Layout['grid']['orientation'], root: { type: 'branch', data: [leaf('main', ['note']), leaf('right', ['files', 'temp'])] } },
      panels: { note: panel('note'), files: panel('files'), temp: panel('temp', true) }, activeGroup: 'right',
    }
    const saved = withoutTransientPanels(live)
    expect(saved.activeGroup).toBe('right')
    expect(JSON.stringify(saved.grid)).toContain('right')
    expect(JSON.stringify(saved.grid)).not.toContain('temp')
    expect(Object.keys(saved.panels)).toEqual(['note', 'files'])
    expect(saved.panels.files.params).toEqual(live.panels.files.params)
    expect(JSON.stringify(live.grid)).toContain('temp')
  })

  it('retains the previously selected regular tab when saving a transient active tab', () => {
    const live: Layout = {
      grid: { width: 1000, height: 700, orientation: 'HORIZONTAL' as Layout['grid']['orientation'], root: { type: 'branch', data: [leaf('main', ['note']), leaf('right', ['files', 'outline', 'temp'])] } },
      panels: { note: panel('note'), files: panel('files'), outline: panel('outline'), temp: panel('temp', true) },
    }
    const saved = withoutTransientPanels(live, { temp: 'outline' })
    expect(JSON.stringify(saved.grid)).toContain('"activeView":"outline"')
    expect(JSON.stringify(live.grid)).toContain('"activeView":"temp"')
  })

  it('prunes nested empty branches while keeping regular bottom/side views', () => {
    const live: Layout = {
      grid: { width: 1000, height: 700, orientation: 'HORIZONTAL' as Layout['grid']['orientation'], root: { type: 'branch', data: [
        leaf('left', ['files']), { type: 'branch', data: [leaf('main', ['note']), { type: 'branch', data: [leaf('bottom', ['temp'])] }] },
      ] } },
      panels: { note: panel('note'), files: panel('files'), temp: panel('temp', true) }, activeGroup: 'main',
    }
    const saved = withoutTransientPanels(live)
    expect(Object.keys(saved.panels)).toEqual(['note', 'files'])
    expect(saved.activeGroup).toBe('main')
    expect(JSON.stringify(saved.grid)).not.toContain('bottom')
  })
})
