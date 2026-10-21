import { beforeEach, describe, expect, it, vi } from 'vitest'

const mock = vi.hoisted(() => ({ state: {} as any }))
vi.mock('@lcl/engine', () => ({ getView: () => ({ displayName: 'Native view' }), useWorkspace: { getState: () => mock.state } }))
import { setPluginCompanions } from './pluginCompanions'
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
