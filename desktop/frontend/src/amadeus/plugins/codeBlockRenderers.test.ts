// @vitest-environment happy-dom
import {describe, it, expect, vi} from 'vitest'
import {findCodeBlockRenderer, registerCodeBlockRenderer, subscribeCodeBlockRenderers} from './codeBlockRenderers'

describe('native fenced code renderer ownership',()=>{
 it('notifies registration changes and revokes mounted and retained callbacks',()=>{
  const change=vi.fn(), cleanup=vi.fn(), offChange=subscribeCodeBlockRenderers(change)
  let signal: AbortSignal | undefined
  const off=registerCodeBlockRenderer('fixture',{id:'fixture',language:'fixture',mount(_el,block){signal=block.signal;return cleanup}})
  const renderer=findCodeBlockRenderer('fixture')!
  renderer.item.mount(document.createElement('div'),{source:'untouched',language:'fixture',pagePath:'A.md',readOnly:false,signal:new AbortController().signal})
  off();off();expect(signal!.aborted).toBe(true);expect(cleanup).toHaveBeenCalledTimes(1)
  expect(findCodeBlockRenderer('fixture')).toBeUndefined();expect(change).toHaveBeenCalledTimes(2)
  expect(()=>renderer.item.mount(document.createElement('div'),{} as never)).toThrow('unregistered');offChange()
 })
 it('disposes an asynchronous mount that settles after its block is gone',async()=>{
  let resolve!: (fn:()=>void)=>void
  const cleanup=vi.fn(), controller=new AbortController()
  const off=registerCodeBlockRenderer('fixture',{id:'async',language:'async-fixture',mount:()=>new Promise(r=>resolve=r)})
  const pending=findCodeBlockRenderer('async-fixture')!.item.mount(document.createElement('div'),{source:'A',language:'async-fixture',pagePath:'A.md',readOnly:false,signal:controller.signal})
  controller.abort();resolve(cleanup);const dispose=await pending;dispose?.();off()
  expect(cleanup).toHaveBeenCalledTimes(1)
 })
 it('rejects reserved languages and lets another owner survive unregister',()=>{
  expect(()=>registerCodeBlockRenderer('fixture',{id:'x',language:'forsion-task',mount(){}})).toThrow('reserved')
  const first=registerCodeBlockRenderer('one',{id:'a',language:'shared-fixture',mount(){}})
  const second=registerCodeBlockRenderer('two',{id:'b',language:'shared-fixture',mount(){}})
  expect(findCodeBlockRenderer('shared-fixture')!.pluginId).toBe('one');first()
  expect(findCodeBlockRenderer('shared-fixture')!.pluginId).toBe('two');second()
 })
})
