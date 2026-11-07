import { describe, expect, it } from 'vitest'
import { closeDialogOptions, closeDialogPick, storedCloseAction } from './closeAction'

describe('closeAction', () => {
  it('只认 tray / quit;缺、坏、旧值一律当 ask(绝不当 quit)', () => {
    expect(storedCloseAction('tray')).toBe('tray')
    expect(storedCloseAction('quit')).toBe('quit')
    for (const v of [undefined, null, '', 'QUIT', 1, {}]) expect(storedCloseAction(v)).toBe('ask')
  })

  it('退出 / 后台运行按勾选记住;取消勾了也不记', () => {
    expect(closeDialogPick(0, false)).toEqual({ action: 'quit', remember: false })
    expect(closeDialogPick(1, true)).toEqual({ action: 'tray', remember: true })
    expect(closeDialogPick(2, true)).toEqual({ action: null, remember: false })
    expect(closeDialogPick(-1, true)).toEqual({ action: null, remember: false })
  })

  it('按钮下标与 pick 对齐:Esc = 取消,回车 = 后台运行', () => {
    const o = closeDialogOptions()
    expect(o.buttons).toHaveLength(3)
    expect(closeDialogPick(o.cancelId, true).action).toBeNull()
    expect(closeDialogPick(o.defaultId, false).action).toBe('tray')
  })
})
