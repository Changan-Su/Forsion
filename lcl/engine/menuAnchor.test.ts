import { describe, it, expect } from 'vitest'
import { clampMenu } from './clampMenu'

// 视口 1000x800,菜单 200x300,margin 8
describe('clampMenu', () => {
  it('放得下时原样落在锚点', () => {
    expect(clampMenu(100, 100, 200, 300, 1000, 800)).toEqual({ left: 100, top: 100 })
  })
  it('横向溢出→左移收进视口', () => {
    // x=900 → right=1100>1000,应左移到 1000-200-8=792
    expect(clampMenu(900, 100, 200, 300, 1000, 800).left).toBe(792)
  })
  it('纵向溢出→上移让下方选项可见', () => {
    // y=700 → bottom=1000>800,应上移到 800-300-8=492
    expect(clampMenu(100, 700, 200, 300, 1000, 800).top).toBe(492)
  })
  it('菜单比视口还高→顶到上边距(配合 CSS overflow 滚动)', () => {
    expect(clampMenu(100, 700, 200, 900, 1000, 800).top).toBe(8)
  })
  it('锚点在负区→夹到边距', () => {
    expect(clampMenu(-50, -50, 200, 300, 1000, 800)).toEqual({ left: 8, top: 8 })
  })
})
