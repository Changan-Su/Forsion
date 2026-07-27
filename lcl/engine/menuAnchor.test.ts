import { describe, it, expect } from 'vitest'
import { clampMenu } from './menuAnchor'

// 视口 1000x800,菜单 200x300,margin 8
describe('clampMenu', () => {
  it('放得下时原样落在锚点', () => {
    expect(clampMenu(100, 100, 200, 300, 1000, 800)).toEqual({ left: 100, top: 100 })
  })
  it('横向溢出→左移收进视口', () => {
    // x=900 → right=1100>1000,应左移到 1000-200-8=792
    expect(clampMenu(900, 100, 200, 300, 1000, 800).left).toBe(792)
  })
  it('下方没空间→翻到锚点上方(不是压着锚点上移)', () => {
    // y=700 → bottom=1000>800;anchorTop 默认 = y,翻面后 top=700-300=400
    expect(clampMenu(100, 700, 200, 300, 1000, 800).top).toBe(400)
  })
  it('给了 anchorTop(slash 的光标行顶)→ 菜单底贴行顶,不盖住正在打字的那行', () => {
    // 光标行 top=690 bottom=706:下方放不下 → top=690-300=390
    expect(clampMenu(100, 706, 200, 300, 1000, 800, { anchorTop: 690 }).top).toBe(390)
  })
  it('上下都放不下(菜单比视口还高)→ 顶到上边距,配合 CSS overflow 滚动', () => {
    expect(clampMenu(100, 700, 200, 900, 1000, 800).top).toBe(8)
  })
  it('锚点在负区→夹到边距', () => {
    expect(clampMenu(-50, -50, 200, 300, 1000, 800)).toEqual({ left: 8, top: 8 })
  })
  it("prefer:'above' → 默认展在锚点上方(行内工具栏)", () => {
    // 选区行 top=400 bottom=416:工具栏底贴 400-8 → top=392-300=92
    expect(clampMenu(500, 424, 200, 300, 1000, 800, { anchorTop: 392, prefer: 'above' }).top).toBe(92)
  })
  it("prefer:'above' 上方没空间 → 翻到下方", () => {
    expect(clampMenu(500, 60, 200, 300, 1000, 800, { anchorTop: 30, prefer: 'above' }).top).toBe(60)
  })
  it('center:水平以 x 为中心', () => {
    expect(clampMenu(500, 100, 200, 300, 1000, 800, { center: true }).left).toBe(400)
  })
  it('center 溢出右边→仍收进视口', () => {
    expect(clampMenu(980, 100, 200, 300, 1000, 800, { center: true }).left).toBe(792)
  })
})
