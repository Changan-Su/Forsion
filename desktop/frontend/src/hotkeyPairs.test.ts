// @vitest-environment happy-dom
import { describe, expect, it, vi } from 'vitest'
import { addCommand, installHotkeys } from '@lcl/engine'

describe('成对修饰键热键的分发', () => {
  it('shift+shift:单按一个 Shift 不触发(通用匹配会把它当成「Shift + 主键 shift」),左右都按下才触发一次', () => {
    const run = vi.fn()
    addCommand({ id: 'test.shift-pair', title: 't', hotkey: 'shift+shift', run })
    const off = installHotkeys()
    const press = (code: string) => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Shift', code, shiftKey: true, bubbles: true }))
    press('ShiftLeft')
    expect(run).not.toHaveBeenCalled()
    press('ShiftRight')
    expect(run).toHaveBeenCalledTimes(1)
    window.dispatchEvent(new KeyboardEvent('keyup', { key: 'Shift', code: 'ShiftLeft' }))
    window.dispatchEvent(new KeyboardEvent('keyup', { key: 'Shift', code: 'ShiftRight' }))
    press('ShiftRight')
    expect(run).toHaveBeenCalledTimes(1)
    off()
  })
})
