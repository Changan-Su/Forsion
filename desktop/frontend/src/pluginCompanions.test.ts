import { beforeEach, describe, expect, it, vi } from 'vitest'

const mock = vi.hoisted(() => ({ state: {} as any, registered: null as null | ((type: string) => boolean) }))
vi.mock('@lcl/engine', () => ({ getView: (type: string) => (mock.registered && !mock.registered(type) ? undefined : { displayName: 'Native view' }), useWorkspace: { getState: () => mock.state } }))
vi.mock('@lcl/engine/dockviewStore', () => ({ withPreservedSideWidths: (_api: unknown, change: () => unknown) => change() }))
import { pruneStalePluginCompanions, setPluginCompanions } from './pluginCompanions'
import type { ViewContribution } from './amadeus/plugins/types'

const def = { id:'folder',mainCompanions: [{ type: 'amadeus-editor', key: 'bluebird-document', split: 'right' }] } as ViewContribution
function panel(id: string, group: any, params: any = {}) {
  const p: any = { id, group, params, api: {} }
  p.api.updateParameters = vi.fn((next: any) => { p.params = next })
  p.api.moveTo = vi.fn((opts: any) => { p.group = opts.position === 'center' ? opts.group : { api: { setSize: vi.fn() } } })
  p.api.setActive = vi.fn()
  return p
}
describe('native plugin companions', () => {
  let owner: any, editor: any
  beforeEach(() => {
    owner = panel('owner', { api: { width: 900, height: 700 } }, { __loc: 'main' })
    editor = panel('editor', { api: { width: 510, height: 700 } }, { __loc: 'main', __type: 'amadeus-editor', reuseKey: 'bluebird-document' })
    mock.state = { api: { width: 1400, panels: [owner, editor], getPanel: () => owner }, leafById: () => owner,
      refreshTabs: vi.fn(), saveCurrent: vi.fn(), mainTabs: [], activateLeaf: vi.fn(), openView: vi.fn() }
  })
  it('folds an editor without closing or replacing its content and restores its width', () => {
    setPluginCompanions('bluebird', 'owner', def, false)
    expect(editor.params.__companionSize.width).toBe(510)
    expect(editor.group).toBe(owner.group)
    setPluginCompanions('bluebird', 'owner', def, true)
    expect(editor.api.moveTo).toHaveBeenLastCalledWith({ group: owner.group, position: 'right', skipSetActive: true })
    expect(editor.group.api.setSize).toHaveBeenCalledWith({ width: 510 })
    expect(editor.api.setActive).toHaveBeenCalled()
  })
  it('does not take another view owner’s keyed editor', () => {
    editor.params.__companionOwner = 'other-owner'
    mock.state.leafById=(id:string)=>id==='other-owner'?{type:'plugin:bluebird:folder'}:owner
    setPluginCompanions('bluebird', 'owner', def, false)
    expect(editor.api.moveTo).not.toHaveBeenCalled()
  })
  it('adopts an orphaned editor while keeping the native note state',()=>{
    editor.params.__companionOwner='closed-owner';editor.params.notePath='user-note.md'
    mock.state.leafById=(id:string)=>id==='owner'?owner:null
    setPluginCompanions('bluebird','owner',def,false)
    expect(editor.params.__companionOwner).toBe('owner')
    expect(editor.params.notePath).toBe('user-note.md')
    expect(editor.group).toBe(owner.group)
  })
  it('does not reset a reader’s manually resized split', () => {
    setPluginCompanions('bluebird', 'owner', def, true)
    expect(editor.api.moveTo).not.toHaveBeenCalled()
  })
  it('uses tabs on narrow hosts', () => {
    mock.state.api.width = 390
    setPluginCompanions('bluebird', 'owner', def, true)
    expect(editor.group).toBe(owner.group)
  })
})

describe('stale plugin companions', () => {
  const OWNER_TYPE = 'plugin:bluebird:folder'
  const current = { id: 'folder' } as ViewContribution // the new version declares no companions
  let panels: any[], leaves: Record<string, any>
  const companion = (id: string, params: any) => ({ id, params: { __loc: 'main', ...params } })
  const opts = (views: ViewContribution[] = [current]) => ({ views, knownPluginIds: ['bluebird'] })
  beforeEach(() => {
    mock.registered = null
    leaves = { owner: { id: 'owner', type: OWNER_TYPE } }
    panels = [
      { id: 'owner', params: { __loc: 'main', __type: OWNER_TYPE } },
      companion('owner:bluebird-document', { __type: 'amadeus-editor', reuseKey: 'bluebird-document', notePath: 'Bluebird/a.md', __companionOwner: 'owner' }),
      companion('owner:bluebird-chat', { __type: 'chat-panel', reuseKey: 'bluebird-chat', __companionOwner: 'owner' }),
    ]
    mock.state = { api: { panels }, leafById: (id: string) => leaves[id] ?? null, closeLeaf: vi.fn(), saveCurrent: vi.fn() }
  })
  const closed = () => mock.state.closeLeaf.mock.calls.map((c: any[]) => c[0])

  it('closes host-opened companions the current version no longer declares', () => {
    expect(pruneStalePluginCompanions('bluebird', 'owner', current, opts())).toBe(2)
    expect(closed()).toEqual(['owner:bluebird-document', 'owner:bluebird-chat'])
    expect(mock.state.saveCurrent).toHaveBeenCalled()
  })
  it('keeps a companion that is still declared', () => {
    const declares = { id: 'folder', mainCompanions: [{ type: 'chat-panel', key: 'bluebird-chat', split: 'right' }] } as ViewContribution
    pruneStalePluginCompanions('bluebird', 'owner', declares, opts([declares]))
    expect(closed()).toEqual(['owner:bluebird-document'])
  })
  it('keeps a companion another view of the same plugin still declares', () => {
    const sibling = { id: 'reader', mainCompanions: [{ type: 'amadeus-editor', key: 'bluebird-document', split: 'right' }] } as ViewContribution
    pruneStalePluginCompanions('bluebird', 'owner', current, opts([current, sibling]))
    expect(closed()).toEqual(['owner:bluebird-chat'])
  })
  it('never closes a tab the user opened, even on the same note', () => {
    panels.splice(1, 2,
      companion('amadeus-editor#2', { __type: 'amadeus-editor', notePath: 'Bluebird/a.md' }),
      companion('amadeus-editor#3', { __type: 'amadeus-editor', reuseKey: 'bluebird-document', notePath: 'Bluebird/a.md' }))
    expect(pruneStalePluginCompanions('bluebird', 'owner', current, opts())).toBe(0)
    expect(mock.state.closeLeaf).not.toHaveBeenCalled()
  })
  it('closes orphans whose owner is gone, but leaves companions of another live owner alone', () => {
    panels[1].params.__companionOwner = 'closed-owner'
    leaves.other = { id: 'other', type: 'plugin:bluebird:folder' }
    panels[2].params.__companionOwner = 'other'
    pruneStalePluginCompanions('bluebird', 'owner', current, opts())
    expect(closed()).toEqual(['owner:bluebird-document'])
  })
  it('skips keys that belong to a longer plugin id', () => {
    panels.push(companion('x:bluebird-pro-chat', { __type: 'chat-panel', reuseKey: 'bluebird-pro-chat', __companionOwner: 'gone' }))
    pruneStalePluginCompanions('bluebird', 'owner', current, { views: [current], knownPluginIds: ['bluebird', 'bluebird-pro'] })
    expect(closed()).not.toContain('x:bluebird-pro-chat')
  })
  it('does nothing while the plugin view is not registered (still loading or failed to load)', () => {
    mock.registered = (type) => type !== OWNER_TYPE
    expect(pruneStalePluginCompanions('bluebird', 'owner', current, opts())).toBe(0)
    expect(mock.state.closeLeaf).not.toHaveBeenCalled()
  })
  it('does nothing when the owner leaf is a placeholder of another type or gone', () => {
    leaves.owner = { id: 'owner', type: 'plugin:bluebird:other' }
    expect(pruneStalePluginCompanions('bluebird', 'owner', current, opts())).toBe(0)
    delete leaves.owner
    expect(pruneStalePluginCompanions('bluebird', 'owner', current, opts())).toBe(0)
    expect(mock.state.closeLeaf).not.toHaveBeenCalled()
  })
  it('leaves the single-column store alone (it has no companion marker)', () => {
    mock.state.api = null
    expect(pruneStalePluginCompanions('bluebird', 'owner', current, opts())).toBe(0)
  })
})
