// @vitest-environment happy-dom
/**
 * 丝滑光标开关的**极性**契约。默认从「关」翻成「开」后,判定从 `=== '1'` 变成 `!== '0'` ——
 * 三个读点(启动 / 设置勾选框 / 命令面板取反)都改走 isSmoothCaretOn,漏掉一个的表现是
 * 「命令面板第一次按没反应」(旧读点算出 false,取反又得到 true=已经是的状态)。
 */
import { beforeEach, describe, expect, it } from 'vitest'
import { isSmoothCaretOn } from './smoothCaret'
import { SMOOTH_CARET_KEY } from './types'

describe('isSmoothCaretOn', () => {
  beforeEach(() => localStorage.clear())

  it('没存过 = 开(默认开)', () => {
    expect(isSmoothCaretOn()).toBe(true)
  })

  it('显式关过 = 关(升级不该把用户的「关」翻回去)', () => {
    localStorage.setItem(SMOOTH_CARET_KEY, '0')
    expect(isSmoothCaretOn()).toBe(false)
  })

  it('老用户手动开过的 "1" 照常算开', () => {
    localStorage.setItem(SMOOTH_CARET_KEY, '1')
    expect(isSmoothCaretOn()).toBe(true)
  })

  it('命令面板取反:首次按 = 关掉,再按 = 开回来', () => {
    const toggle = (): void => localStorage.setItem(SMOOTH_CARET_KEY, !isSmoothCaretOn() ? '1' : '0')
    toggle()
    expect(isSmoothCaretOn()).toBe(false)
    toggle()
    expect(isSmoothCaretOn()).toBe(true)
  })
})
