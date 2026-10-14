// @vitest-environment happy-dom
import {afterEach, expect, it, vi} from 'vitest'
import type {PluginContext} from './types'
vi.mock('../api', () => ({amadeus: undefined}))
const {usePluginStore} = await import('./pluginStore')
afterEach(() => { for (const id of [...usePluginStore.getState().activeIds]) usePluginStore.getState().disable(id) })
it('renders inert native Markdown synchronously and revokes the retained API on disable', () => {
  usePluginStore.setState({initialized:false,plugins:[],activeIds:[],disabledIds:[],disposers:{}})
  let ctx!: PluginContext
  usePluginStore.getState().init([{id:'render-fixture',name:'Renderer',version:'1',setup(c){ctx=c}}])
  const html = ctx.ui!.renderMarkdown!('# Heading\n\n**Body** and [note](Note.md).\n\n| A | B |\n| --- | --- |\n| 1 | 2 |\n\n<script>alert(1)</script>')
  expect(typeof html).toBe('string')
  const el=document.createElement('div');el.innerHTML=html
  expect(el.querySelector('h1')?.textContent).toBe('Heading')
  expect(el.querySelector('strong')?.textContent).toBe('Body')
  expect(el.querySelector('a')?.getAttribute('href')).toBe('Note.md')
  expect(el.querySelector('td')?.textContent).toBe('1')
  expect(el.querySelector('script')).toBeNull()
  expect(() => ctx.ui!.renderMarkdown!(null as never)).toThrow('Markdown string')
  usePluginStore.getState().disable('render-fixture')
  expect(() => ctx.ui!.renderMarkdown!('Retired')).toThrow('Plugin disabled')
})
