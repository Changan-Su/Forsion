// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from 'vitest'

const tracked: string[] = []
vi.mock('../../achievements/store', () => ({ track: (e: string) => { tracked.push(e) } }))
vi.mock('../../services/widgetClient', () => ({ listWidgets: vi.fn(async () => [
  { id: 'w_a1', title: 'Agent card', name: 'a', entry: 'widget.json' },
  { id: 'w_b2', title: '', name: 'page', entry: 'index.html' },
]) }))
// 卡头 / 卡芯模块很重(会话、收件箱、沙箱):这里只验接缝,挂载那半给个替身
vi.mock('../../views/homeWidgetMount', () => ({
  mountHomeWidget: vi.fn((el: HTMLElement, id: string, o: { part: string; editing: boolean }) => {
    el.textContent = `${o.part}:${id}:${o.editing}`
    return { update: (n: { part: string; editing: boolean }) => { el.textContent = `${n.part}:${id}:${n.editing}` }, dispose: () => { el.textContent = '' } }
  }),
  mountHomePart: vi.fn((el: HTMLElement, name: string) => (name === 'computer-history-ask' ? (el.textContent = 'ask', { dispose: () => { el.textContent = '' } }) : null)),
}))

import { createHomeApi, homeWidgetInfo } from './pluginHome'
import { HOME_WIDGETS_KEY, requestHomeEdit, sanitizeHomeLayout } from '../../views/homeWidgets'
import type { AmadeusPlugin } from './types'

const cal = { id: 'forsion-calendar', name: '日历', nameEn: 'Calendar', widgets: [{ id: 'today', title: '今天', titleEn: 'Today', layout: 'list', space: 'calendar' }] } as unknown as AmadeusPlugin
let plugins: AmadeusPlugin[] = [cal]
let alive = true
const listeners = new Set<() => void>()
const api = () => createHomeApi({
  alive: () => alive, own: (off) => off,
  plugins: () => plugins,
  subscribePlugins: (cb) => { listeners.add(cb); return () => { listeners.delete(cb) } },
})
const flush = () => new Promise((r) => setTimeout(r, 0))

beforeEach(() => {
  alive = true
  plugins = [cal]
  tracked.length = 0
  localStorage.clear()
})

describe('ctx.home(主页插件化 B,2026-11-09)', () => {
  it('卡的头信息:插件卡按语言给标题和来源;插件不在 / 被拦 / 没声明 → show:false;Agent 卡标题空着交给卡头挂载', () => {
    expect(homeWidgetInfo('plugin:forsion-calendar/today', plugins)).toMatchObject({ kind: 'plugin', show: true, title: '今天', owner: '日历', canOpen: true })
    expect(homeWidgetInfo('plugin:forsion-calendar/todo', plugins).show).toBe(false)
    expect(homeWidgetInfo('plugin:gone/today', plugins)).toMatchObject({ show: false, owner: 'gone' })
    expect(homeWidgetInfo('plugin:forsion-calendar/today', [{ ...cal, blocked: 'api' } as AmadeusPlugin]).show).toBe(false)
    expect(homeWidgetInfo('w_a1', plugins)).toMatchObject({ kind: 'agent', show: true, title: '' })
    expect(homeWidgetInfo('builtin:inbox', plugins)).toMatchObject({ kind: 'builtin', show: true, canOpen: true })
    expect(homeWidgetInfo('builtin:muse', plugins).canOpen).toBe(false)
  })

  it('library:内置四张 + 插件声明的 + Agent 做的(只收 widget.json 那种)', async () => {
    const ids = (await api().library()).map((w) => w.id)
    expect(ids).toEqual(['builtin:muse', 'builtin:inbox', 'builtin:notes', 'builtin:sessions', 'plugin:forsion-calendar/today', 'w_a1'])
    expect((await api().library()).find((w) => w.id === 'w_a1')?.title).toBe('Agent card')
  })

  it('subscribe:插件列表变了就通知;退订后不再通知', async () => {
    const cb = vi.fn()
    const off = api().subscribe(cb)
    await flush()
    cb.mockClear()
    for (const f of listeners) f()
    expect(cb).toHaveBeenCalledOnce()
    off()
    expect(listeners.size).toBe(0)
  })

  it('layout:没摆过读出 null(缺省交给插件);写进去按格式校验,读回校验后的那份;别处改了会通知', () => {
    const home = api()
    expect(home.layout.read()).toBeNull()
    const cb = vi.fn()
    home.layout.subscribe(cb)
    const saved = home.layout.write({ left: [], center: ['dock'], row: [], right: ['builtin:inbox', 'builtin:inbox', 'builtin:nope'] } as never)
    expect(saved.center).toContain('composer')
    expect(saved.right).toEqual(['builtin:inbox'])
    expect(home.layout.read()).toEqual(saved)
    expect(JSON.parse(localStorage.getItem(HOME_WIDGETS_KEY)!)).toEqual(saved)
    expect(cb).toHaveBeenCalled()
  })

  it('layout:插件停用后写不进去,返回此刻存着的那份', () => {
    const home = api()
    home.layout.write(sanitizeHomeLayout({ right: ['builtin:notes'] }) as never)
    alive = false
    expect(home.layout.write({ left: [], center: ['composer'], row: [], right: [] } as never).right).toEqual(['builtin:notes'])
    expect(home.layout.read()!.right).toEqual(['builtin:notes'])
  })

  it('onEditRequest:主页还没挂上时的那一下,登记时补发;退订后不再收', () => {
    requestHomeEdit()
    const cb = vi.fn()
    const off = api().onEditRequest(cb)
    expect(cb).toHaveBeenCalledOnce()
    requestHomeEdit()
    expect(cb).toHaveBeenCalledTimes(2)
    off()
    requestHomeEdit() // 没人登记:记成待发
    const late = vi.fn()
    api().onEditRequest(late)
    expect(late).toHaveBeenCalledOnce()
    expect(cb).toHaveBeenCalledTimes(2)
  })

  it('track 只收白名单(home.edit),停用后不记', () => {
    api().track('home.edit')
    api().track('chat.send')
    alive = false
    api().track('home.edit')
    expect(tracked).toEqual(['home.edit'])
  })

  it('mount:宿主画进 el,update 换选项不重挂,卸载后清掉;不是元素就抛错', async () => {
    const el = document.createElement('div')
    const off = api().mount(el, 'builtin:inbox', { part: 'head' })
    await flush()
    expect(el.textContent).toBe('head:builtin:inbox:false')
    off.update!({ part: 'head', editing: true })
    expect(el.textContent).toBe('head:builtin:inbox:true')
    off()
    expect(el.textContent).toBe('')
    expect(() => api().mount(null as never, 'builtin:inbox')).toThrow(TypeError)
  })

  it('mount:模块还没载入就卸了,载入后也不画', async () => {
    const el = document.createElement('div')
    const off = api().mount(el, 'builtin:notes')
    off()
    await flush()
    expect(el.textContent).toBe('')
  })

  it('mount:模块还没载入时同一个 el 又挂了一张,先请求的那张作废', async () => {
    const { mountHomeWidget } = await import('../../views/homeWidgetMount')
    const calls = vi.mocked(mountHomeWidget)
    calls.mockClear()
    const el = document.createElement('div')
    api().mount(el, 'builtin:notes')
    api().mount(el, 'builtin:inbox')
    await flush()
    expect(calls.mock.calls.map((c) => c[1])).toEqual(['builtin:inbox'])
    expect(el.textContent).toBe('body:builtin:inbox:false')
  })

  it('layout:读出来的是拷贝,改它不影响下一次读', () => {
    const home = api()
    home.layout.write(sanitizeHomeLayout({ right: ['builtin:notes'] }) as never)
    const r = home.layout.read()!
    r.right.push('builtin:inbox')
    expect(home.layout.read()!.right).toEqual(['builtin:notes'])
  })

  it('layout:上一次读失败了,插件手里那份不写(回存储现状);再读成功后照常写', () => {
    const home = api()
    home.layout.write(sanitizeHomeLayout({ right: ['builtin:notes'] }) as never)
    const get = vi.spyOn(localStorage, 'getItem').mockImplementation(() => { throw new Error('denied') })
    expect(home.layout.read()).toBeNull()
    get.mockRestore()
    expect(home.layout.write(sanitizeHomeLayout({ right: [] }) as never).right).toEqual(['builtin:notes'])
    expect(JSON.parse(localStorage.getItem(HOME_WIDGETS_KEY)!).right).toEqual(['builtin:notes'])
    expect(home.layout.read()!.right).toEqual(['builtin:notes'])
    expect(home.layout.write(sanitizeHomeLayout({ right: [] }) as never).right).toEqual([])
  })

  it('mountPart:认识的名字画,不认识的什么都不画', async () => {
    const a = document.createElement('div'), b = document.createElement('div')
    api().mountPart(a, 'computer-history-ask')
    api().mountPart(b, 'nope')
    await flush()
    expect(a.textContent).toBe('ask')
    expect(b.textContent).toBe('')
  })
})
