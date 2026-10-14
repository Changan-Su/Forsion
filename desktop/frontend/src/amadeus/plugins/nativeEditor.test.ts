// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
const pane=vi.hoisted(()=>({id:''}))
vi.mock('@lcl/engine/workspaceStore',()=>({useWorkspace:{getState:()=>({api:{}})},activeMainPanel:()=>pane}))
vi.mock('../api', () => ({ amadeus: {} }))
import { findCodeBlockRenderer } from './codeBlockRenderers'
import { usePluginStore } from './pluginStore'
import { activePageScope, usePageStore } from '../store/pageStore'
import { registerUnifiedPipe } from '../unified/lifecycle'
import type { PluginContext } from './types'
let ctx: PluginContext, off: () => void
const apply=vi.fn(()=>true)
beforeEach(()=>{
 for(const id of usePluginStore.getState().activeIds)usePluginStore.getState().disable(id)
 usePluginStore.setState({initialized:false}); localStorage.clear(); apply.mockClear()
 pane.id=activePageScope()
 usePageStore.setState({vaultRoot:'/fixture',activeNotePath:'Note.md',activePage:null})
 off=registerUnifiedPipe({path:'Note.md',scope:activePageScope(),flush:async()=>{},retire(){},captureEditor:()=>({path:'Note.md',text:'hello',anchor:0,head:0,isCurrent:()=>true,apply})})
 usePluginStore.getState().init([{id:'native-probe',name:'Native probe',version:'1',setup(c){ctx=c}}])
})
afterEach(()=>off())
describe('native editor public lifecycle',()=>{
 it('removes scoped code renderers when the parent plugin is disabled',()=>{
  ctx.registerCodeBlockRenderer!({id:'preview',language:'lifecycle-fixture',mount(){}})
  expect(findCodeBlockRenderer('lifecycle-fixture')).toBeDefined()
  usePluginStore.getState().disable('native-probe')
  expect(findCodeBlockRenderer('lifecycle-fixture')).toBeUndefined()
 })
 it('revokes a dynamic view and its stale mount callback',()=>{
  const mount=vi.fn();const remove=ctx.registerView({id:'temporary',title:'Temporary',mount})
  const view=usePluginStore.getState().views.find(v=>v.item.id==='temporary')!.item
  expect(typeof remove).toBe('function');remove?.()
  expect(usePluginStore.getState().views.some(v=>v.item.id==='temporary')).toBe(false)
  view.mount(document.createElement('div'));expect(mount).not.toHaveBeenCalled()
 })
 it('revokes captured edit and command closures on disable',()=>{
  const edit=ctx.app.captureEditor!()!; expect(edit).not.toBeNull()
  const run=vi.fn();ctx.registerCommand({id:'test-native',title:'test',run})
  const command=usePluginStore.getState().commands.find(c=>c.item.id==='test-native')!.item
  usePluginStore.getState().disable('native-probe')
  expect(edit.isCurrent?.()).toBe(false);expect(edit.apply({text:'changed'})).toBe(false);expect(apply).not.toHaveBeenCalled()
  command.run(); expect(run).not.toHaveBeenCalled(); expect(ctx.app.captureEditor!()).toBeNull()
 })
 it('does not target a visible old note when a non-note split is active',()=>{
  const edit=ctx.app.captureEditor!()!; pane.id='chat-pane'
  expect(ctx.app.captureEditor!()).toBeNull();expect(edit.isCurrent?.()).toBe(false);expect(edit.apply({text:'changed'})).toBe(false)
  expect(apply).not.toHaveBeenCalled()
 })
 it('refuses captured edits after switching vault, and removes one dynamic command',()=>{
  const edit=ctx.app.captureEditor!()!
  usePageStore.setState({vaultRoot:'/other'})
  expect(edit.isCurrent?.()).toBe(false);expect(edit.apply({text:'changed'})).toBe(false);expect(apply).not.toHaveBeenCalled()
  const offCmd=ctx.registerCommand({id:'test-native',title:'test',run(){}})
  expect(typeof offCmd).toBe('function');offCmd?.()
  expect(usePluginStore.getState().commands.some(c=>c.item.id==='test-native')).toBe(false)
 })
})
