// @vitest-environment happy-dom
/** 多维表 text 单元格里的 [[双链]]:真挂 DatabaseEmbed(dbStore 直接喂数据,不过 IPC)。
 *  存在的理由 —— 用户实报「打了不成链接」,而渲染分支读代码看着是好的:先用它证明渲染没坏
 *  (病在没有 [[ 补全、没有 Enter 提交、中文输入法出的是全角【【),再拿它钉住修好的三条。
 *  ponytail: 用 createElement 而非 JSX,免为一个用例把 vitest include 扩到 .tsx。 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import * as React from 'react'
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import type { DbFile } from '@amadeus-shared/db/schema'

vi.mock('../../api', () => ({ amadeus: {} }))
const g = globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean; React: typeof React }
g.IS_REACT_ACT_ENVIRONMENT = true
g.React = React // lcl/engine 的 .tsx 在 vitest 下按 classic runtime 编译,OverlayAt 要能取到全局 React

const REF = 'x.db'
const mkDb = (cell: string): DbFile => ({
  version: 1,
  name: 'T',
  columns: [{ id: 'c1', name: '名称', type: 'text' }],
  rows: [{ id: 'r1', cells: { c1: cell } }],
} as unknown as DbFile)

let root: Root | null = null
const host = (): HTMLElement => document.getElementById('host')!
const input = (): HTMLInputElement => host().querySelector<HTMLInputElement>('.amx-db-input')!

/** 受控 input 的「真打字」:必须走原生 setter + input 事件,直接改 .value 触发不了 React onChange。
 *  caret 省略 = 光标在末尾(常规打字);给了就模拟「在已有文字中间插入」。 */
async function type(el: HTMLInputElement, v: string, caret?: number): Promise<void> {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!
  await act(async () => {
    setter.call(el, v)
    el.selectionStart = el.selectionEnd = caret ?? v.length
    el.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

async function mount(cell: string): Promise<void> {
  const { DatabaseEmbed } = await import('./DatabaseEmbed')
  const { useDbStore } = await import('../../store/dbStore')
  const { usePageStore } = await import('../../store/pageStore')
  useDbStore.setState({ entries: { [REF]: { status: 'ok', path: REF, data: mkDb(cell) } } })
  usePageStore.setState({ pages: ['我的笔记.md', '别的.md'] })
  document.body.innerHTML = '<div id="host"></div>'
  root = createRoot(host())
  await act(async () => { root!.render(createElement(DatabaseEmbed, { target: REF, pagePath: 'n.md' })) })
}

const cellValue = async (): Promise<string> => {
  const { useDbStore } = await import('../../store/dbStore')
  const db = useDbStore.getState().entries[REF]?.data as DbFile
  return String(db.rows[0].cells.c1 ?? '')
}

describe('text 单元格的 [[双链]]', () => {
  beforeEach(() => { root?.unmount(); root = null })

  it('非编辑态渲染成可点链接(不是纯文本)', async () => {
    await mount('见 [[我的笔记]]')
    expect(host().querySelector('.amx-db-wikilink')?.textContent).toBe('我的笔记')
    expect(host().querySelector('.amx-db-richtext')?.textContent).toBe('见 我的笔记')
  })

  it('点单元格进编辑态 → 变回带方括号的输入框', async () => {
    await mount('见 [[我的笔记]]')
    await act(async () => { host().querySelector<HTMLElement>('.amx-db-urlcell')!.click() })
    expect(input().value).toBe('见 [[我的笔记]]')
  })

  it('打 [[ 弹笔记候选,选中即写成 [[名字]] 并渲染成链接', async () => {
    await mount('')
    await type(input(), '见 [[')
    expect(host().querySelector('.amx-db-pop')).toBeTruthy() // 补全弹层
    const opt = host().querySelectorAll<HTMLElement>('.amx-db-opt')[0]
    expect(opt.textContent).toContain('我的笔记')
    await act(async () => { opt.click() })
    expect(await cellValue()).toBe('见 [[我的笔记]]')
    expect(host().querySelector('.amx-db-wikilink')?.textContent).toBe('我的笔记')
  })

  it('Esc 关掉候选层后焦点回到单元格(不然接着打字打进虚空)', async () => {
    await mount('')
    await act(async () => { input().focus() })
    await type(input(), '[[')
    const search = host().querySelector<HTMLInputElement>('.amx-db-pop-input')!
    await act(async () => { search.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })) })
    expect(host().querySelector('.amx-db-pop')).toBeNull()
    expect(document.activeElement).toBe(input())
  })

  it('Enter 就提交 —— 不必点别处链接才现形', async () => {
    await mount('')
    const el = input()
    await act(async () => { el.focus() })
    await type(el, '[[我的笔记]]')
    expect(host().querySelector('.amx-db-wikilink')).toBeNull() // 编辑中仍是输入框
    await act(async () => { el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })) })
    expect(host().querySelector('.amx-db-wikilink')?.textContent).toBe('我的笔记')
  })

  // ── 以下四条来自 Codex 评审(2 Medium + 2 Low) ──
  it('拼音选词的 Enter 不当提交(组合态里按 Enter = 确认候选词,不是「打完了」)', async () => {
    await mount('')
    const el = input()
    await act(async () => { el.focus() })
    await type(el, '[[我的笔记]]')
    await act(async () => {
      el.dispatchEvent(Object.assign(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }), { isComposing: true }))
    })
    expect(document.activeElement).toBe(el) // 还在格子里
    expect(host().querySelector('.amx-db-wikilink')).toBeNull()
  })

  it('在已有文字中间插 [[ 也弹候选,选中后只替换光标前那段、保留后文', async () => {
    await mount('')
    const el = input()
    await act(async () => { el.focus() })
    await type(el, '前缀 后缀')
    await type(el, '前缀 [[后缀', 5) // 光标紧跟在 "[[" 之后(下标 5),后面还留着「后缀」
    expect(host().querySelector('.amx-db-pop')).toBeTruthy()
    await act(async () => { host().querySelectorAll<HTMLElement>('.amx-db-opt')[0].click() })
    expect(await cellValue()).toBe('前缀 [[我的笔记]]后缀')
  })

  it('中文输入法的全角【【】】失焦时归一成双链', async () => {
    await mount('')
    const el = input()
    await act(async () => { el.focus() })
    await type(el, '见 【【我的笔记】】')
    await act(async () => { el.blur() })
    expect(await cellValue()).toBe('见 [[我的笔记]]')
    expect(host().querySelector('.amx-db-wikilink')?.textContent).toBe('我的笔记')
  })
})
