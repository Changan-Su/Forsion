// @vitest-environment happy-dom
/**
 * 自绘单选组的键盘行为(Codex 第一轮 A-3):role=radio 的卡片以前每张都是独立 Tab 停点、方向键不动。
 * 这里渲染一组 role=radio 按钮 + onRadioGroupKeyDown,钉住 roving tabindex 与「方向键移动并选中」;
 * ThemeCard 把 roving tabindex 落到自己的按钮上(三处调用方:设置主题网格、引导主题网格、后端运行方式卡)。
 */
import React, { act, useState } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { onRadioGroupKeyDown, radioTabIndex } from './radioGroupKeys'
import { ThemeCard } from './ThemeCard'
import type { ThemeEntry } from '../theme/registry'

let host: HTMLDivElement
let root: Root
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  host = document.createElement('div'); document.body.append(host); root = createRoot(host)
})
afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.unstubAllGlobals() })

function Group({ initial, disabled = [] as string[] }: { initial: string | null; disabled?: string[] }) {
  const ids = ['a', 'b', 'c']
  const [sel, setSel] = useState<string | null>(initial)
  const any = ids.includes(sel ?? '')
  return React.createElement('div', { role: 'radiogroup', onKeyDown: onRadioGroupKeyDown },
    ids.map((id, i) => React.createElement('button', {
      key: id, type: 'button', role: 'radio', 'aria-checked': sel === id, 'data-id': id, disabled: disabled.includes(id),
      tabIndex: radioTabIndex(sel === id, i, any), onClick: () => setSel(id),
    }, id)))
}

const radios = () => [...host.querySelectorAll<HTMLButtonElement>('[role="radio"]')]
const checked = () => radios().find((r) => r.getAttribute('aria-checked') === 'true')?.dataset.id
const press = async (key: string) => {
  const target = document.activeElement as HTMLElement
  await act(async () => { target.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true })) })
}

it('roving tabindex:只有选中项进 Tab 序;没有选中项时第一项进', async () => {
  await act(async () => root.render(React.createElement(Group, { initial: 'b' })))
  expect(radios().map((r) => r.tabIndex)).toEqual([-1, 0, -1])
  await act(async () => root.render(React.createElement(Group, { key: 'none', initial: null })))
  expect(radios().map((r) => r.tabIndex)).toEqual([0, -1, -1])
})

it('方向键移动焦点并选中,首尾循环;Home / End 到两端', async () => {
  await act(async () => root.render(React.createElement(Group, { initial: 'a' })))
  radios()[0].focus()
  await press('ArrowRight')
  expect(checked()).toBe('b')
  expect((document.activeElement as HTMLElement).dataset.id).toBe('b')
  expect(radios().map((r) => r.tabIndex)).toEqual([-1, 0, -1])
  await press('ArrowDown'); await press('ArrowDown')
  expect(checked()).toBe('a') // c → 循环回 a
  await press('ArrowLeft')
  expect(checked()).toBe('c')
  await press('Home')
  expect(checked()).toBe('a')
  await press('End')
  expect(checked()).toBe('c')
})

it('禁用项跳过', async () => {
  await act(async () => root.render(React.createElement(Group, { initial: 'a', disabled: ['b'] })))
  radios()[0].focus()
  await press('ArrowRight')
  expect(checked()).toBe('c')
})

it('ThemeCard 把 roving tabindex 落到按钮上;缺省按 active', () => {
  const entry = { manifest: { id: 'x', name: 'X', preview: {} } } as unknown as ThemeEntry
  const html = (props: { active: boolean; tabIndex?: number }) => renderToStaticMarkup(React.createElement(ThemeCard, { entry, onSelect: () => {}, ...props }))
  expect(html({ active: false, tabIndex: 0 })).toContain('tabindex="0"')
  expect(html({ active: false })).toContain('tabindex="-1"')
  expect(html({ active: true })).toContain('tabindex="0"')
})
