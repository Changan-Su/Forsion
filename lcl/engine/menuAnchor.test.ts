import { describe, it, expect } from 'vitest'
import { clampMenu, edgeNudge } from './menuAnchor'

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

// 锚定 absolute 菜单的横向兜底(useEdgeNudge 的算术核)。手机 390 宽 + body zoom 1.15 是真实工况。
describe('edgeNudge', () => {
  it('已在屏内 → 不动', () => {
    expect(edgeNudge(100, 200, 1000, 1)).toEqual({ dx: 0, maxWidth: undefined })
  })
  it('掉出左缘(ModelPill 菜单 right:0 + 224px 宽的真实症状)→ 推回边距内', () => {
    // 用户实报那张图:菜单左缘 -40 → 需要右推 48 才够 8px 边距
    expect(edgeNudge(-40, 224, 390, 1).dx).toBe(48)
  })
  it('捅出右缘 → 左推', () => {
    // left=300 width=264(ProjectSelector)→ right=564 > 390-8 → 推 -182
    expect(edgeNudge(300, 264, 390, 1).dx).toBe(-182)
  })
  it('⚠️ zoom≠1:dx 是局部 px,必须除以 zoom(手机 body zoom 恒 1.15,桌面恒 1 → 写错本地看不出来)', () => {
    expect(edgeNudge(-46, 224, 390, 1.15).dx).toBeCloseTo(46.956, 2)
  })
  it('比可用宽度还宽(mode 菜单 min-width:320 vs 手机可用 ~323)→ 给 maxWidth 且贴左边距', () => {
    const r = edgeNudge(60, 512, 390, 1)
    expect(r.maxWidth).toBe(374) // 390 - 2*8
    expect(r.dx).toBe(-52) // 收窄后按 374 宽重算,左缘落到 8
  })
  it('maxWidth 也是局部 px(同样除 zoom)', () => {
    expect(edgeNudge(60, 512, 390, 1.15).maxWidth).toBeCloseTo(325.217, 2)
  })
  it('⚠️ 隐藏中(display:none → rect 全零)不许推:否则一显示就整体歪掉 margin/zoom', () => {
    expect(edgeNudge(0, 0, 390, 1.15)).toEqual({ dx: 0 })
  })
})
