import { describe, it, expect } from 'vitest'
import { classifyCalKey } from './calKeys'

const k = (key: string, mods: Partial<{ metaKey: boolean; ctrlKey: boolean; altKey: boolean; shiftKey: boolean }> = {}) =>
  ({ key, metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, ...mods })

describe('classifyCalKey', () => {
  it('D/W/3/M 切模式', () => {
    expect(classifyCalKey(k('w'))).toEqual({ kind: 'mode', mode: 'week' })
    expect(classifyCalKey(k('M'))).toEqual({ kind: 'mode', mode: 'month' }) // 大小写不敏感
    expect(classifyCalKey(k('3'))).toEqual({ kind: 'mode', mode: '3day' })
  })

  it('←/→ 翻页', () => {
    expect(classifyCalKey(k('ArrowLeft'))).toEqual({ kind: 'prev' })
    expect(classifyCalKey(k('ArrowRight'))).toEqual({ kind: 'next' })
  })

  it('Cmd/Ctrl+C/V 复制粘贴(单独 c/v 是模式? 否——只 w/d/m/3 是模式,c/v 无修饰即忽略)', () => {
    expect(classifyCalKey(k('c', { metaKey: true }))).toEqual({ kind: 'copy' })
    expect(classifyCalKey(k('v', { ctrlKey: true }))).toEqual({ kind: 'paste' })
    // 无修饰的 c 自 2026-10-16 起 = 新建(见最后一条)
  })

  it('Delete/Backspace 删除(无修饰)', () => {
    expect(classifyCalKey(k('Delete'))).toEqual({ kind: 'delete' })
    expect(classifyCalKey(k('Backspace'))).toEqual({ kind: 'delete' })
  })

  it('其它修饰组合不劫持', () => {
    expect(classifyCalKey(k('w', { metaKey: true }))).toBeNull() // Cmd+W 关窗,不当模式键
    expect(classifyCalKey(k('ArrowLeft', { ctrlKey: true }))).toBeNull()
    expect(classifyCalKey(k('c', { metaKey: true, altKey: true }))).toBeNull() // Alt 组合排除
    expect(classifyCalKey(k('x'))).toBeNull()
  })

  it('2026-10-16:撤销 / 复制选中 / 新建 / 今天 / 改标题 / Esc', () => {
    expect(classifyCalKey(k('z', { metaKey: true }))).toEqual({ kind: 'undo' })
    expect(classifyCalKey(k('z', { metaKey: true, shiftKey: true }))).toEqual({ kind: 'redo' })
    expect(classifyCalKey(k('x', { ctrlKey: true }))).toEqual({ kind: 'cut' })
    expect(classifyCalKey(k('F10', { shiftKey: true }))).toEqual({ kind: 'menu' })
    expect(classifyCalKey(k('d', { ctrlKey: true }))).toEqual({ kind: 'duplicate' })
    expect(classifyCalKey(k('d'))).toEqual({ kind: 'mode', mode: 'day' }) // 单独 d 仍是切模式
    expect(classifyCalKey(k('c'))).toEqual({ kind: 'new' })
    expect(classifyCalKey(k('T'))).toEqual({ kind: 'today' })
    expect(classifyCalKey(k('Enter'))).toEqual({ kind: 'rename' })
    expect(classifyCalKey(k('Escape'))).toEqual({ kind: 'escape' })
  })
})
