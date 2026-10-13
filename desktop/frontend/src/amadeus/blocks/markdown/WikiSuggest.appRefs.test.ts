// @vitest-environment happy-dom
//
// `[[` 补全面板的应用 / 窗口候选与分类条(候选与分类的纯逻辑在 wikiAppRefs.test.ts,这里钉面板本身):
//  · 宿主没有 `window.tangu.appRefs` → 面板与从前一样:没有分类条,←/→ 一个都不拦。
//  · 有 → 多出「全部 / 窗口 / 应用 / 笔记」,←/→ 切类别,选中窗口 / 应用交出 `window://…|标题` / `app://…|名字`。
// 真应用里的观感(胶囊滑动、图标)只能在桌面端看。
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AppRefList } from '../../../../../shared/appRefs'
import { WikiSuggest } from './WikiSuggest'

const LIST: AppRefList = {
  windows: [
    { id: 'com.apple.Safari', app: 'Safari', title: '季度计划 — 飞书文档' },
    { id: 'com.microsoft.VSCode', app: 'Code', title: 'wikilink.ts — genesis' },
  ],
  apps: [
    { id: 'com.apple.Safari', name: 'Safari', running: true },
    { id: 'com.apple.Notes', name: 'Notes', running: false },
  ],
}

let host: HTMLDivElement
let root: Root
const onPick = vi.fn()
const onClose = vi.fn()

const stubHost = (list: AppRefList | null): void => {
  if (!list) { delete (window as unknown as { tangu?: unknown }).tangu; return }
  ;(window as unknown as { tangu: unknown }).tangu = {
    appRefs: { list: async () => list, status: async () => [], icons: async () => ({}), open: async () => ({ ok: true }), frontmost: async () => null },
  }
}
const show = async (query: string, extra: Record<string, unknown> = {}): Promise<void> => {
  await act(async () => {
    root.render(React.createElement(WikiSuggest, {
      query, left: 10, top: 10, getPageNames: () => ['Alpha.md', 'Safari 笔记.md'], onPick, onClose, editorFocused: () => true, ...extra,
    }))
  })
  await act(async () => { await Promise.resolve() }) // 等 list() 回来
}
const press = async (key: string, init: KeyboardEventInit = {}): Promise<boolean> => {
  const e = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...init })
  await act(async () => { window.dispatchEvent(e) })
  return e.defaultPrevented
}
const tabs = (): HTMLElement[] => [...host.querySelectorAll<HTMLElement>('.wiki-tabs [role="tab"]')]
const selectedTab = (): string | undefined => tabs().find((el) => el.getAttribute('aria-selected') === 'true')?.dataset.category
const rows = (): string[] => [...host.querySelectorAll<HTMLElement>('.wiki-item')].map((el) => (el.dataset.active !== undefined ? '*' : '') + el.querySelector('.wiki-item-name')!.textContent)
const labels = (): string[] => [...host.querySelectorAll<HTMLElement>('.slash-group-label')].map((el) => el.textContent ?? '')

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  onPick.mockClear()
  onClose.mockClear()
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
})
afterEach(async () => {
  await act(async () => root.unmount())
  host.remove()
  stubHost(null)
  vi.unstubAllGlobals()
})

describe('没有宿主接口:面板与从前一样', () => {
  it('没有分类条,外壳还是 role=menu;←/→ 不拦(光标照常在查询串里走)', async () => {
    stubHost(null)
    await show('')
    expect(host.querySelector('.wiki-suggest')?.getAttribute('role')).toBe('menu')
    expect(host.querySelector('.wiki-suggest-tabbed, .wiki-tabs, .wiki-suggest-list')).toBeNull()
    expect(rows()).toEqual(['*Alpha', 'Safari 笔记'])
    expect(labels()).toEqual([])
    expect(await press('ArrowRight')).toBe(false)
    expect(await press('ArrowLeft')).toBe(false)
    expect(await press('ArrowDown')).toBe(true)
    expect(rows()).toEqual(['Alpha', '*Safari 笔记'])
  })
  it('手写到一半的 `[[app://…` 不给「新建链接」行(面板不出现,回车照常)', async () => {
    stubHost(null)
    await show('app://com.apple')
    expect(host.querySelector('.wiki-suggest')).toBeNull()
    expect(await press('Enter')).toBe(false)
    await show('appx') // 普通名字照旧可以新建
    expect(rows()).toEqual(['*新建链接 “appx”'])
  })
})

describe('有宿主接口:多出窗口 / 应用两类 + 分类条', () => {
  it('「全部」= 从前那一列在前(回车选中的还是第一篇笔记),窗口、应用跟在后面,各带分组标签', async () => {
    stubHost(LIST)
    await show('')
    expect(tabs().map((el) => `${el.dataset.category}:${el.textContent}`)).toEqual(['all:全部', 'window:窗口', 'app:应用', 'note:笔记'])
    expect(selectedTab()).toBe('all')
    expect(host.querySelector('.wiki-tabs')?.classList.contains('cap-tabs')).toBe(true)
    expect(rows()).toEqual(['*Alpha', 'Safari 笔记', '季度计划 — 飞书文档', 'wikilink.ts — genesis', 'Safari', 'Notes'])
    expect(labels()).toEqual(['链接到页面', '窗口', '应用'])
    await press('Enter')
    expect(onPick).toHaveBeenCalledWith('Alpha')
  })

  it('←/→ 切类别并循环;带修饰键的不拦', async () => {
    stubHost(LIST)
    await show('')
    expect(await press('ArrowRight')).toBe(true)
    expect(selectedTab()).toBe('window')
    expect(rows()).toEqual(['*季度计划 — 飞书文档', 'wikilink.ts — genesis'])
    expect(labels()).toEqual([])
    expect(await press('ArrowRight', { metaKey: true })).toBe(false)
    expect(await press('ArrowLeft', { shiftKey: true })).toBe(false)
    expect(selectedTab()).toBe('window')
    await press('ArrowRight')
    expect(selectedTab()).toBe('app')
    expect(rows()).toEqual(['*Safari', 'Notes'])
    await press('ArrowRight')
    expect(selectedTab()).toBe('note')
    expect(rows()).toEqual(['*Alpha', 'Safari 笔记'])
    await press('ArrowRight')
    expect(selectedTab()).toBe('all')
    await press('ArrowLeft')
    expect(selectedTab()).toBe('note')
  })

  it('选中窗口 / 应用 → 交出引用的内文(调用方补 `]]` 后就是契约里的 token)', async () => {
    stubHost(LIST)
    await show('')
    await press('ArrowRight')
    await press('ArrowDown')
    await press('Enter')
    expect(onPick).toHaveBeenLastCalledWith('window://com.microsoft.VSCode|wikilink.ts — genesis')
    await press('ArrowRight')
    await press('Tab')
    expect(onPick).toHaveBeenLastCalledWith('app://com.apple.Safari|Safari')
  })

  it('打字过滤:三类一起筛;点分类胶囊也能切', async () => {
    stubHost(LIST)
    await show('saf')
    expect(rows()).toEqual(['*Safari 笔记', '新建链接 “saf”', '季度计划 — 飞书文档', 'Safari'])
    await act(async () => { tabs()[2].click() })
    expect(selectedTab()).toBe('app')
    expect(rows()).toEqual(['*Safari'])
  })

  it('当前这一类没有匹配的:留着分类条和一句提示,回车 / ↑↓ 不拦,Esc 照关', async () => {
    stubHost(LIST)
    await show('alpha')
    await press('ArrowRight')
    expect(selectedTab()).toBe('window')
    expect(rows()).toEqual([])
    expect(host.querySelector('.slash-empty')?.textContent).toBe('这一类里没有匹配的')
    expect(await press('Enter')).toBe(false)
    expect(await press('ArrowDown')).toBe(false)
    expect(onPick).not.toHaveBeenCalled()
    expect(await press('Escape')).toBe(true)
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('写笔记的别名 / 锚点(查询里有 | #)、`@` 提及:不出分类条,也不拿窗口标题去撞', async () => {
    stubHost(LIST)
    await show('Alpha|季度')
    expect(host.querySelector('.wiki-suggest')).toBeNull() // 从前就不出面板:回车照常
    expect(await press('Enter')).toBe(false)
    await show('Alpha#')
    expect(tabs()).toEqual([])
    await show('', { dates: true, allowCreate: false, onPickRaw: () => {} })
    expect(tabs()).toEqual([])
    expect(rows().some((r) => r.includes('飞书文档'))).toBe(false)
  })

  it('非笔记库宿主(候选池里没有笔记):不出「笔记」这一格', async () => {
    stubHost(LIST)
    await show('', { getPageNames: () => [] })
    expect(tabs().map((el) => el.dataset.category)).toEqual(['all', 'window', 'app'])
    expect(rows()).toEqual(['*季度计划 — 飞书文档', 'wikilink.ts — genesis', 'Safari', 'Notes'])
  })
})
