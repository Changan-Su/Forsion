// @vitest-environment happy-dom
// 网页卡片第二轮 1(10-28):本地网页卡 / 服务卡挂在哪次调用上;卡跟在工具行后面;ctx.ui.mountWebCard 的形状整理与 guard。
// 负对照(已实跑红):planWebCards 去掉 pkg 判定 →「写了 package.json 不出」红;lastWrite 改成只记第一次写 →「挂最后一次写」红;
// tidyCardActs 去掉 run 判定 →「没 run 的按钮丢掉」红。
import { act } from 'react'
import { describe, expect, it, vi } from 'vitest'
import type { ToolEvent } from '../../types'

vi.mock('../../amadeus/api', () => ({ amadeus: undefined }))
const { planWebCards, shortPath } = await import('./WebCards')
const { partitionToolSegment } = await import('./EditorialMessage')
const { usePluginStore } = await import('../../amadeus/plugins/pluginStore')
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const ev = (id: string, name: string, args: unknown, over: Partial<ToolEvent> = {}): ToolEvent =>
  ({ id, name, arguments: JSON.stringify(args), done: true, result: 'ok', ...over })

describe('planWebCards', () => {
  it('多个 HTML 只给入口(index.html 优先),挂在对它的最后一次写上;相对路径按 cwd 解析', () => {
    const plan = planWebCards([
      ev('a', 'write_file', { path: 'about.html', content: 'x' }),
      ev('b', 'write_file', { path: 'site/index.html', content: 'x' }),
      ev('c', 'edit_file', { path: '/w/site/index.html', old_string: 'x', new_string: 'y' }),
      ev('d', 'write_file', { path: 'style.css', content: 'x' }),
    ], '/w')
    expect([...plan]).toEqual([['c', { kind: 'local', path: '/w/site/index.html' }]])
  })

  it('没有 index.html 给第一个写的;apply_patch 里的 Add File 也算', () => {
    const patch = '*** Begin Patch\n*** Add File: b.html\n+<p>b</p>\n*** End Patch'
    const plan = planWebCards([ev('p', 'apply_patch', { patch }), ev('q', 'write_file', { path: 'a.html', content: 'x' })], '/w')
    expect([...plan]).toEqual([['p', { kind: 'local', path: '/w/b.html' }]])
  })

  it('同一回合写了 package.json 不出本地卡;失败 / 挂起的写不算', () => {
    expect(planWebCards([ev('a', 'write_file', { path: 'index.html', content: 'x' }), ev('b', 'write_file', { path: 'package.json', content: '{}' })], '/w').size).toBe(0)
    expect(planWebCards([ev('a', 'write_file', { path: 'index.html', content: 'x' }, { isError: true, result: 'Error: denied' })], '/w').size).toBe(0)
    expect(planWebCards([ev('a', 'write_file', { path: 'index.html', content: 'x' }, { result: 'Error: no space' })], '/w').size).toBe(0)
    expect(planWebCards([ev('a', 'write_file', { path: 'index.html', content: 'x' }, { parked: true })], '/w').size).toBe(0)
  })

  it('run_background 起成功 → 服务卡(带进程 id);起失败不出', () => {
    const ok = ev('r', 'run_background', { command: 'npm run dev' }, { result: 'started background process p7 (pid 4242)\n稍后用 read_process_output 查看输出。' })
    const bad = ev('s', 'run_background', { command: 'x' }, { result: 'Error: command is required' })
    expect([...planWebCards([ok, bad])]).toEqual([['r', { kind: 'service', processId: 'p7', command: 'npm run dev' }]])
  })
})

it('地址行的路径:~ 起头,太长只留首段和末两段', () => {
  expect(shortPath('/Users/lin/Forsion/tea/index.html')).toBe('~/Forsion/tea/index.html')
  expect(shortPath('/var/folders/tw/x/T/proj/tea/index.html')).toBe('/…/tea/index.html')
})

describe('分段:网页卡排在这一段工具的最后', () => {
  it('写文件那行留在工具组,工具组不被切开,卡在整段之后', () => {
    const a = ev('a', 'read_file', {}), w = ev('w', 'write_file', { path: 'index.html', content: 'x' }), b = ev('b', 'run_bash', {})
    const spec = { kind: 'local' as const, path: '/w/index.html' }
    expect(partitionToolSegment([a, w, b], [], false, undefined, (e) => (e.id === 'w' ? spec : undefined))).toEqual([
      { t: 'tools', events: [a, w, b] },
      { t: 'web', event: w, spec },
    ])
  })
})

describe('ctx.ui.mountWebCard', () => {
  const ctxOf = (id: string) => {
    let ref: import('../../amadeus/plugins/types').PluginContext | null = null
    usePluginStore.setState({ initialized: false, plugins: [], activeIds: [], disabledIds: [], disposers: {} })
    usePluginStore.getState().init([{ id, name: id, version: '0', setup: (c) => { ref = c } }])
    return { ui: ref!.ui!, disable: () => usePluginStore.getState().disable(id) }
  }
  const settle = async () => { await act(async () => { await import('../../amadeus/plugins/partsSurface'); await new Promise((r) => setTimeout(r, 0)) }) }

  it('画宿主卡身;没 run 的按钮丢掉、非 http 缩略图不拍;按钮经 guard,停用后摘掉', async () => {
    const { ui, disable } = ctxOf('p-web')
    const el = document.createElement('div'); document.body.append(el)
    const run = vi.fn()
    const h = ui.mountWebCard!(el, {
      name: { zh: '下午茶接龙', en: 'Tea sign-up' }, status: { label: '已上线', tone: 'ok' },
      address: { text: 'forsion.net/apps/lin/tea/' }, note: '刚刚发布',
      thumbnail: { url: 'file:///etc/passwd' },
      actions: [{ label: '打开', run }, { label: '坏按钮' } as never], trailing: [{ label: '申请上架', run }],
    })
    await settle()
    expect(el.querySelector('.wc-name')!.textContent).toBe('下午茶接龙')
    expect(el.querySelector('.wc-pill.ok')!.textContent).toBe('已上线')
    expect(el.querySelector('.wc-thumb.ph')).not.toBeNull()
    expect([...el.querySelectorAll('.wc-acts .btn')].map((b) => b.textContent)).toEqual(['打开', '申请上架'])
    act(() => (el.querySelector('.wc-acts .btn') as HTMLButtonElement).click())
    expect(run).toHaveBeenCalledTimes(1)
    act(() => h.update({ thumbnail: { url: 'https://forsion.net/apps/lin/tea/' }, menu: [{ label: '下线', run }] }))
    expect(el.querySelector('[data-act="web-card-more"]')).not.toBeNull()
    // Extend 每次 update 整张卡传:带了键、值是 undefined / [] / null = 清掉(已下线那张靠这个去掉 ⋯ 和按钮)
    act(() => h.update({ status: { label: '已下线', tone: 'muted' }, actions: [], trailing: [], menu: undefined, thumbnail: null }))
    expect(el.querySelector('.wc-pill.muted')!.textContent).toBe('已下线')
    expect(el.querySelector('[data-act="web-card-more"]')).toBeNull()
    expect(el.querySelectorAll('.wc-acts .btn').length).toBe(0)
    expect(el.querySelector('.wc-thumb.ph')).not.toBeNull()
    act(() => disable())
    expect(el.querySelector('[data-web-card]')).toBeNull()
  })

  it('形状错同步抛', () => {
    const { ui } = ctxOf('p-web2')
    const el = document.createElement('div')
    expect(() => ui.mountWebCard!(el, {} as never)).toThrow(TypeError)
    expect(() => ui.mountWebCard!(el, { name: 'x', actions: 'no' } as never)).toThrow(TypeError)
  })
})
