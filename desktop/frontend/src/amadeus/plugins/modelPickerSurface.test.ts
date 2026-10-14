// @vitest-environment happy-dom
import { act } from 'react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { mountPluginModelPicker } from './modelPickerSurface'
import { installModelPickerPresenter } from '../../components/modelPickerHost'
import { modelCatalog } from '../../tanguProbe'
import { setLocaleGlobal } from '../../i18n'
import type { PluginModelPickerHandle } from '../../../../shared/pluginModelPicker'

vi.mock('../../tanguProbe', () => ({ modelCatalog: vi.fn() }))
let element: HTMLElement, picker: PluginModelPickerHandle | undefined
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true); setLocaleGlobal('en')
  Object.defineProperty(Element.prototype, 'getAnimations', { configurable: true, value: () => [] })
  vi.mocked(modelCatalog).mockResolvedValue({ defaultModelId: 'a', models: [{ id: 'a', name: 'Model A', provider: 'provider', source: 'direct', available: true, supportsCorrection: true }, { id: 'b', name: 'Model B', provider: 'provider', source: 'direct', available: true, supportsCorrection: true }] })
  element = document.createElement('div'); document.body.append(element)
})
afterEach(async () => { await act(async () => picker?.dispose()); picker = undefined; element.remove(); vi.unstubAllGlobals() })
it('reuses the native menu and keeps selection local until its owner accepts it', async () => {
  const onChange = vi.fn(); const remove = installModelPickerPresenter(async request => { expect(request.fields[0].groups.flatMap(g=>g.options).map(o=>o.value)).toContain('b'); return { model: 'b' } })
  try {
    await act(async () => { picker = mountPluginModelPicker(element, { kind: 'translation', value: 'a', label: 'Translation model', followLabel: 'Follow settings', onChange }) })
    await act(async () => { (element.querySelector('button') as HTMLButtonElement).click() })
    expect(onChange).toHaveBeenCalledWith('b'); expect(element.textContent).toContain('Model A')
    await act(async () => picker!.update({value:'b'})); expect(element.textContent).toContain('Model B')
  } finally { remove() }
})
it('rejects late native selections after the mount is disposed', async () => {
  let finish!: (value: {model:string})=>void
  const onChange=vi.fn(), remove=installModelPickerPresenter(()=>new Promise(resolve=>{finish=resolve}))
  try {
    await act(async()=>{picker=mountPluginModelPicker(element,{kind:'translation',value:'a',label:'Translation',followLabel:'Follow',onChange})})
    await act(async()=>{(element.querySelector('button') as HTMLButtonElement).click()})
    await act(async()=>picker!.dispose()); await act(async()=>finish({model:'b'}))
    expect(onChange).not.toHaveBeenCalled(); expect(element.children).toHaveLength(0)
  } finally {remove()}
})
it('does not accept an unavailable on-device model', async () => {
  vi.mocked(modelCatalog).mockResolvedValue({ defaultModelId:'',models:[{id:'local',name:'SenseVoice',provider:'',source:'local',available:false,supportsCorrection:false}] })
  const onChange=vi.fn(), remove=installModelPickerPresenter(async()=>({model:'local'}))
  try {
    await act(async()=>{picker=mountPluginModelPicker(element,{kind:'asr',value:'',label:'ASR',followLabel:'Follow',onChange})})
    await act(async()=>{(element.querySelector('button') as HTMLButtonElement).click()})
    expect(onChange).not.toHaveBeenCalled(); expect(element.querySelector('[role=alert]')?.textContent).toContain('Download')
  } finally { remove() }
})
