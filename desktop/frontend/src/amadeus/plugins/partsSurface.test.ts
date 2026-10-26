// @vitest-environment happy-dom
// 走查续八 8.14–8.22:插件经 ctx 拿到的新零件 —— 文案跟语言、一张图标词表、菜单的图标 / 小节 / 分隔 / 锚点、
// 对话框与确认、工具栏控件、空态、弹出层、addStyle、视图头;停用时宿主统一收。
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { act } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { setLocaleGlobal as setLocale } from '../../i18n'
import { hostListSource, defineMessages, pluginText } from './pluginText'
import { hostListEmpty } from '../../views/hostListEmpty'

vi.mock('../api', () => ({ amadeus: undefined }))
const { usePluginStore } = await import('./pluginStore')
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const ctxOf = (id: string) => {
  let ref: import('./types').PluginContext | null = null
  usePluginStore.setState({ initialized: false, plugins: [], activeIds: [], disabledIds: [], disposers: {} })
  usePluginStore.getState().init([{ id, name: id, version: '0', setup: (c) => { ref = c } }])
  return { ctx: ref!, ui: ref!.ui!, disable: () => usePluginStore.getState().disable(id) }
}
/** 等宿主那次动态 import 落地。 */
const settle = async () => { await act(async () => { await import('./partsSurface'); await import('./contextMenuSurface'); await new Promise((r) => setTimeout(r, 0)) }) }

afterEach(() => { setLocale('zh'); document.body.replaceChildren() })

describe('8.20 文案', () => {
  it('pluginText:字符串 / 函数 / { zh, en } 按当前语言求值', () => {
    expect(pluginText({ zh: '清单', en: 'Items' })).toBe('清单')
    setLocale('en')
    expect(pluginText({ zh: '清单', en: 'Items' })).toBe('Items')
    expect(pluginText(() => 'fn')).toBe('fn')
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    expect(pluginText(() => { throw new Error('x') }, 'fb')).toBe('fb')
    err.mockRestore()
  })
  it('i18n.define:当前语言 → zh → key,{var} 占位;缺 en 的键警告一次', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const t = defineMessages('p', { zh: { a: '条目 {n}', b: '只有中文' }, en: { a: 'Item {n}' } })
    expect(warn).toHaveBeenCalledTimes(1)
    expect(warn.mock.calls[0][0]).toContain('b')
    expect(t('a', { n: 3 })).toBe('条目 3')
    setLocale('en')
    expect(t('a', { n: 3 })).toBe('Item 3')
    expect(t('b')).toBe('只有中文')
    expect(t('missing')).toBe('missing')
    warn.mockRestore()
  })
  it('列表源:标题与动作名切语言即变;empty 登记成宿主空态(插件自己的 Space 才不写「暂无内容」)', () => {
    const src = hostListSource({ id: 's', title: { zh: '清单', en: 'Items' }, items: () => [], subscribe: () => () => {}, open() {},
      actions: [{ id: 'n', label: () => (pluginText({ zh: '新建', en: 'New' })), run() {} }] })
    expect(src.title).toBe('清单')
    expect(src.actions![0].label).toBe('新建')
    const same = src.actions
    setLocale('en')
    expect(src.title).toBe('Items')
    expect(src.actions![0].label).toBe('New')
    expect(src.actions).toBe(same) // 动作数组身份稳定
    const { ctx } = ctxOf('p-list')
    ctx.registerListSource!({ id: 'x', title: 'X', items: () => [], subscribe: () => () => {}, open() {}, empty: { icon: 'list-checks', title: { zh: '还没有', en: 'None yet' } } })
    const stored = usePluginStore.getState().listSources.find((o) => o.pluginId === 'p-list')!.item
    const e = hostListEmpty(stored)!
    expect(e.title()).toBe('None yet')
    expect(typeof e.space === 'function' && e.space('tangu')).toBe(false)
  })
})

describe('8.17 图标', () => {
  it('types.ts 的 PluginIconName 联合 = PLUGIN_ICONS 的键(加了图标两边一起改)', async () => {
    const { PLUGIN_ICONS } = await import('../components/icons')
    const src = readFileSync(join(__dirname, 'types.ts'), 'utf8')
    const union = src.slice(src.indexOf('export type PluginIconName ='), src.indexOf('/** One row of `ctx.ui.contextMenu`'))
    expect([...union.matchAll(/'([a-z0-9-]+)'/g)].map((m) => m[1]).sort()).toEqual(Object.keys(PLUGIN_ICONS).sort())
  })
  it('ctx.ui.icon:词表名 → 新的 <svg>;词表外 → null,每个名字只警告一次并给近似名', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { ui } = ctxOf('p-icon')
    const a = ui.icon!('plus', { size: 14 })!, b = ui.icon!('plus')!
    expect(a.tagName.toLowerCase()).toBe('svg')
    expect(a).not.toBe(b)
    expect(a.getAttribute('width')).toBe('14')
    expect(ui.icon!('inbox')).not.toBeNull() // Space 那张表的名字也在词表里
    expect(ui.icon!('list-check')).toBeNull()
    ui.icon!('list-check')
    expect(warn).toHaveBeenCalledTimes(1)
    expect(warn.mock.calls[0][0]).toContain('did you mean list-checks')
    warn.mockRestore()
  })
})

describe('8.16 菜单', () => {
  it('小节 / 图标 / 快捷键 / 分隔;没图标的行留同宽空位;锚在按钮右缘;多余的分隔与空小节被去掉', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { ui } = ctxOf('p-menu3')
    const more = document.createElement('button'); document.body.append(more)
    const run = vi.fn(), closed = vi.fn()
    ui.contextMenu!({ anchor: more, align: 'end' }, [
      { separator: true }, { section: { zh: '条目', en: 'Item' } },
      { label: '重命名', icon: 'pencil', shortcut: 'F2', run }, { label: '置顶', run() {} },
      { separator: true }, { separator: true }, { label: '删除', icon: 'trash-2', danger: true, run() {} }, { section: '空的' },
    ], { onClose: closed })
    await settle()
    const m = document.querySelector('.ctx-menu')!
    expect([...m.children].map((c) => c.className || c.tagName)).toEqual(['ctx-head', 'BUTTON', 'BUTTON', 'ctx-separator', 'danger'])
    expect(m.querySelector('.ctx-head')!.textContent).toBe('条目')
    const rows = [...m.querySelectorAll('button')]
    expect(rows[0].querySelector('svg.plugin-menu-ic')).not.toBeNull()
    expect(rows[1].querySelector('span.plugin-menu-ic')).not.toBeNull() // 空位
    expect(rows[0].querySelector('.ctx-shortcut')!.textContent).toBe('F2')
    act(() => rows[0].click())
    expect(run).toHaveBeenCalledTimes(1)
    expect(closed).toHaveBeenCalledTimes(1)
  })
  it('形态错同步抛', () => {
    const { ui } = ctxOf('p-menu4')
    expect(() => ui.contextMenu!({} as never, [])).toThrow(TypeError)
  })
})

describe('8.14 对话框', () => {
  it('confirm:主按钮 → true;Esc(cancel 事件)→ false;danger 时焦点在取消', async () => {
    const { ui } = ctxOf('p-dlg')
    const yes = ui.confirm!({ title: '导出', body: '导出为 Markdown', ok: '导出' })
    await settle()
    const dlg = document.querySelector('dialog.plugin-dialog') as HTMLDialogElement
    expect(dlg.querySelector('.plugin-dialog-title')!.textContent).toBe('导出')
    act(() => (dlg.querySelector('.btn.primary') as HTMLButtonElement).click())
    expect(await yes).toBe(true)
    expect(document.querySelector('dialog.plugin-dialog')).toBeNull()
    const no = ui.confirm!({ title: '删除?', danger: true })
    await settle()
    const d2 = document.querySelector('dialog.plugin-dialog') as HTMLDialogElement
    expect(d2.querySelector('.btn.primary')!.hasAttribute('data-danger')).toBe(true)
    expect(document.activeElement?.textContent).toBe('取消')
    act(() => { d2.dispatchEvent(new Event('cancel', { cancelable: true })) })
    expect(await no).toBe(false)
  })
  it('openDialog:run 返回 false 不关;mount 的清理在关时跑;停用即关', async () => {
    const { ui, disable } = ctxOf('p-dlg2')
    const cleanup = vi.fn(), onClose = vi.fn()
    let n = 0
    ui.openDialog!({ title: () => 'T', mount: (el) => { el.append('content'); return cleanup }, onClose,
      actions: [{ label: 'Go', primary: true, run: () => (++n < 2 ? false : undefined) }] })
    await settle()
    const btn = () => document.querySelector('dialog.plugin-dialog .btn.primary') as HTMLButtonElement | null
    expect(document.querySelector('.plugin-dialog-content')!.textContent).toBe('content')
    await act(async () => { btn()!.click(); await Promise.resolve() })
    expect(btn()).not.toBeNull()
    await act(async () => { btn()!.click(); await Promise.resolve() })
    expect(btn()).toBeNull()
    expect(cleanup).toHaveBeenCalledTimes(1)
    expect(onClose).toHaveBeenCalledTimes(1)
    ui.openDialog!({ title: 'again' })
    await settle()
    act(() => disable())
    expect(document.querySelector('dialog.plugin-dialog')).toBeNull()
  })
})

describe('8.15 / 8.18 / 8.19 / 8.22', () => {
  it('mountControl:分段 = 看法胶囊那一份;下拉 = 文字钮 + listbox,点了先挪过去再回调;选项数校验', async () => {
    const { ui } = ctxOf('p-ctl')
    const a = document.createElement('div'), b = document.createElement('div'); document.body.append(a, b)
    const onSeg = vi.fn(), onSel = vi.fn()
    ui.mountControl!(a, { type: 'segmented', value: 'all', options: [{ value: 'all', label: '全部' }, { value: 'open', label: { zh: '进行中', en: 'Open' } }], onChange: onSeg })
    ui.mountControl!(b, { type: 'select', value: 'new', options: [{ value: 'new', label: '最新' }, { value: 'name', label: '名称' }], onChange: onSel })
    await settle()
    expect(a.querySelector('.lcl-vmode')).not.toBeNull()
    act(() => (a.querySelectorAll('.lcl-vmode-pill > button')[1] as HTMLButtonElement).click())
    expect(onSeg).toHaveBeenCalledWith('open')
    const trigger = b.querySelector('.plugin-tbsel') as HTMLButtonElement
    expect(trigger.textContent).toBe('最新')
    act(() => trigger.click())
    const opts = [...document.querySelectorAll('.plugin-listbox [role="option"]')] as HTMLButtonElement[]
    expect(opts.map((o) => o.getAttribute('aria-selected'))).toEqual(['true', 'false'])
    act(() => opts[1].click())
    expect(onSel).toHaveBeenCalledWith('name')
    expect((b.querySelector('.plugin-tbsel') as HTMLElement).textContent).toBe('名称')
    expect(() => ui.mountControl!(a, { type: 'segmented', value: 'x', options: [{ value: 'x', label: 'x' }], onChange() {} })).toThrow(RangeError)
  })
  it('mountEmptyState:宿主 EmptyState 那一份,按钮经 guard;停用后点了不调', async () => {
    const { ui, disable } = ctxOf('p-empty')
    const el = document.createElement('div'); document.body.append(el)
    const run = vi.fn()
    ui.mountEmptyState!(el, { icon: 'list-checks', title: '还没有条目', line: '新建的条目会出现在这里。', action: { label: '新建', icon: 'plus', run } })
    await settle()
    expect(el.querySelector('[data-empty-state] .empty-state-title')!.textContent).toBe('还没有条目')
    act(() => (el.querySelector('.empty-state-action') as HTMLButtonElement).click())
    expect(run).toHaveBeenCalledTimes(1)
    act(() => disable())
    expect(el.querySelector('[data-empty-state]')).toBeNull()
  })
  it('popover:.ui-popover 外壳,Esc 关并跑清理;mount("icon") / addStyle 停用时摘掉', async () => {
    const { ctx, ui, disable } = ctxOf('p-pop')
    const btn = document.createElement('button'); document.body.append(btn)
    const cleanup = vi.fn()
    ui.popover!(btn, { mount: (el) => { el.append('filters'); return cleanup } })
    await settle()
    expect(document.querySelector('.ui-popover.plugin-popover')!.textContent).toBe('filters')
    act(() => { document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })) })
    expect(document.querySelector('.ui-popover.plugin-popover')).toBeNull()
    expect(cleanup).toHaveBeenCalledTimes(1)
    const slot = document.createElement('span'); document.body.append(slot)
    ui.mount!('icon', slot, { name: 'plus' })
    expect(slot.querySelector('svg')).not.toBeNull()
    const st = ctx.addStyle!('.x{color:red}')
    expect(document.querySelector('style[data-plugin="p-pop"]')!.textContent).toBe('.x{color:red}')
    st.update('.x{color:blue}')
    expect(document.querySelector('style[data-plugin="p-pop"]')!.textContent).toBe('.x{color:blue}')
    act(() => disable())
    expect(slot.querySelector('svg')).toBeNull()
    expect(document.querySelector('style[data-plugin="p-pop"]')).toBeNull()
    expect(() => ui.mount!('nope' as never, slot, {} as never)).toThrow(TypeError)
  })
})
