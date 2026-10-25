// @vitest-environment happy-dom
/**
 * Agent「运行设置」的下拉(10-25 第四轮 4.3):思考档位 / 审批模式和模型同一种触发器,不再是原生 select。
 *  · 键盘:触发器 ↓ 展开、焦点落在当前项;↓ / End 移动;Enter 选中并回到触发器;Esc 收起回到触发器;点外面收起。
 *  · 名字单源:审批档用输入框模式菜单那一套(询问我批准 / 替我批准 / 完全放行 / 自定义),Agent 页那套「只读 / 自动编辑 / 完全自动」已删;
 *    「跟随默认」括号里写当前缺省档。
 * i18n 用真的(vitest.config 的 setupFiles 钉 zh)。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import '../i18n.generated'
import { translate, translateFor } from '../i18n'
import { ProfileSelectField, approvalOptions, thinkingOptions } from './profileControls'

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })

const t = (k: string, v?: Record<string, string | number>) => translate(k, v)
let host: HTMLDivElement
let root: Root

beforeEach(() => { host = document.createElement('div'); document.body.append(host); root = createRoot(host) })
afterEach(() => { act(() => root.unmount()); host.remove() })

describe('运行设置的选项', () => {
  it('审批档的名字与输入框模式菜单同一套,「跟随默认」写出缺省档', () => {
    expect(approvalOptions(t).map((o) => o.label)).toEqual(['跟随默认（替我批准）', '询问我批准', '替我批准', '完全放行', '自定义（config.json）'])
    expect(approvalOptions(t).map((o) => o.value)).toEqual(['', 'readonly', 'auto-edit', 'full-auto', 'custom'])
    expect(thinkingOptions(t)[0]).toEqual({ value: '', label: '跟随默认（Medium）' })
    // 缺省取决于场合(团队临时成员)时不编一个括号
    expect(approvalOptions(t, { knownDefault: false })[0].label).toBe('跟随默认设置')
    expect(thinkingOptions(t, { knownDefault: false })[0].label).toBe('跟随默认设置')
  })
  it('英文界面同样成对,没有残留中文', () => {
    // translateIn 的回退链会把漏掉的 en 原样渲染成中文,这里逐项看有没有汉字。
    const labels = [...approvalOptions((k, v) => translateFor('en', k, v)), ...thinkingOptions((k, v) => translateFor('en', k, v))].map((o) => o.label)
    expect(labels.join(' ')).not.toMatch(/[一-鿿]/)
    expect(labels[0]).toBe('Follow default (Approve for me)')
  })
})

describe('ProfileSelectField', () => {
  const mount = (value: string, onChange = vi.fn()) => {
    act(() => root.render(createElement(ProfileSelectField, { field: 'approval', label: '审批模式', value, options: approvalOptions(t), onChange })))
    return onChange
  }
  const trigger = () => host.querySelector<HTMLButtonElement>('.profile-model-trigger')!
  const key = (el: Element, k: string) => act(() => { el.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true })) })

  it('不是原生 select;触发器显示当前项', () => {
    mount('full-auto')
    expect(host.querySelector('select')).toBeNull()
    expect(trigger().textContent).toBe('完全放行')
    expect(trigger().getAttribute('aria-haspopup')).toBe('listbox')
    expect(host.querySelector('[data-profile-field="approval"]')).not.toBeNull()
  })

  it('键盘:↓ 展开并聚焦当前项,End 移到最后,Enter 选中回到触发器', () => {
    const onChange = mount('readonly')
    trigger().focus()
    key(trigger(), 'ArrowDown')
    expect(trigger().getAttribute('aria-expanded')).toBe('true')
    const options = () => Array.from(host.querySelectorAll<HTMLButtonElement>('[role="option"]'))
    expect(options().map((o) => o.textContent)).toContain('询问我批准')
    expect(document.activeElement).toBe(options().find((o) => o.getAttribute('aria-selected') === 'true'))
    key(document.activeElement!, 'End')
    expect(document.activeElement).toBe(options()[options().length - 1])
    act(() => (document.activeElement as HTMLButtonElement).click())
    expect(onChange).toHaveBeenCalledWith('custom')
    expect(host.querySelector('[role="listbox"]')).toBeNull()
    expect(document.activeElement).toBe(trigger())
  })

  it('Esc 收起回到触发器;点外面收起;选同一项不触发 onChange', () => {
    const onChange = mount('')
    act(() => trigger().click())
    key(document.activeElement!, 'Escape')
    expect(host.querySelector('[role="listbox"]')).toBeNull()
    expect(document.activeElement).toBe(trigger())
    act(() => trigger().click())
    act(() => { document.body.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true })) })
    expect(host.querySelector('[role="listbox"]')).toBeNull()
    act(() => trigger().click())
    act(() => host.querySelector<HTMLButtonElement>('[aria-selected="true"]')!.click())
    expect(onChange).not.toHaveBeenCalled()
  })
})
