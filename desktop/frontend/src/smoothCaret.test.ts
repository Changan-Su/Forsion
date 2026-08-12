// @vitest-environment happy-dom
/**
 * 丝滑光标开关的**极性**契约。默认是「关」,判定 `=== '1'` —— 三个读点(启动 / 设置勾选框 /
 * 命令面板取反)必须都走 isSmoothCaretOn,漏掉一个的表现是「命令面板第一次按没反应」
 * (旧读点算出 true,取反又得到 false=已经是的状态)。
 */
import { beforeEach, describe, expect, it } from 'vitest'
import { isSmoothCaretOn } from './smoothCaret'
import { SMOOTH_CARET_KEY } from './types'

describe('isSmoothCaretOn', () => {
  beforeEach(() => localStorage.clear())

  it('没存过 = 关(默认关)', () => {
    expect(isSmoothCaretOn()).toBe(false)
  })

  it('显式关过 = 关', () => {
    localStorage.setItem(SMOOTH_CARET_KEY, '0')
    expect(isSmoothCaretOn()).toBe(false)
  })

  it('显式开过的 "1" 算开(默认翻回关不该把用户的「开」抹掉)', () => {
    localStorage.setItem(SMOOTH_CARET_KEY, '1')
    expect(isSmoothCaretOn()).toBe(true)
  })

  it('命令面板取反:首次按 = 开起来,再按 = 关回去', () => {
    const toggle = (): void => localStorage.setItem(SMOOTH_CARET_KEY, !isSmoothCaretOn() ? '1' : '0')
    toggle()
    expect(isSmoothCaretOn()).toBe(true)
    toggle()
    expect(isSmoothCaretOn()).toBe(false)
  })
})
