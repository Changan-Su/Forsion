/** P3a 画布版布局纯逻辑:dashboard2 键读写往返 / 旧网格迁移数学 / 画布自愈 / 与旧键互不相扰。 */
import { describe, expect, it } from 'vitest'
import {
  DASH2_FM_KEY, DASH_GAP_PX, DASH2_MIGRATE_STEP_X, DASH2_MIGRATE_STEP_Y, DASH2_MIN_W, DASH2_MIN_H,
  clampRect2, migrateGridToCanvas, readDash2Layout, readDashLayout, reconcileCanvas, setDash2InFm,
} from './dashboard'

describe('dashboard2(画布版布局)', () => {
  it('写入 → 读回往返;旧键 dashboard: 原样共存不受扰', () => {
    const legacy = 'dashboard:\n  "1": [0, 0, 14, 8]\ntitle_extra: 保留我'
    const text = setDash2InFm(legacy, { '1': { x: 10, y: 20, w: 400, h: 220 } })
    expect(text).not.toBe(null)
    const back = readDash2Layout(text!)
    expect(back.ok && back.layout['1']).toEqual({ x: 10, y: 20, w: 400, h: 220 })
    // 旧键与外来键逐字保留
    const old = readDashLayout(text!)
    expect(old.ok && old.layout['1']).toEqual({ x: 0, y: 0, w: 14, h: 8 })
    expect(text).toContain('title_extra: 保留我')
  })

  it('坏 YAML → ok:false 冻结(与旧键同款三态);写侧拒改返回 null', () => {
    const bad = 'dashboard2: [unclosed'
    expect(readDash2Layout(bad).ok).toBe(false)
    expect(setDash2InFm(bad, {})).toBe(null)
  })

  it('⚠️合法 YAML 但 schema 坏 → 也必须 ok:false(否则自愈会把用户布局覆盖掉)', () => {
    // 键不存在 = 还没排过版,ok:true 空布局(自愈可以正常排位)
    expect(readDash2Layout('title_extra: x')).toEqual({ ok: true, layout: {} })
    // 键在但不是映射:数组 / 标量 / 字符串 —— 一律冻结
    expect(readDash2Layout('dashboard2: [1, 2, 3]').ok).toBe(false)
    expect(readDash2Layout('dashboard2: 42').ok).toBe(false)
    expect(readDash2Layout('dashboard2: 随手写的字').ok).toBe(false)
    // 条目坏:短数组 / 非数值 / 标量条目 —— 同样冻结,不许「跳过坏的、其余照排」
    expect(readDash2Layout('dashboard2:\n  "1": [0, 0]').ok).toBe(false)
    expect(readDash2Layout('dashboard2:\n  "1": [0, 0, abc, 200]').ok).toBe(false)
    expect(readDash2Layout('dashboard2:\n  "1": 坏了').ok).toBe(false)
    // 混合:有一条合法也不放行(部分排位 = 另一半布局丢失)
    expect(readDash2Layout('dashboard2:\n  "1": [0, 0, 400, 200]\n  "2": [0]').ok).toBe(false)
  })

  it('clampRect2:NaN/1e308 不进布局;最小卡 80×60', () => {
    const r = clampRect2({ x: Number.NaN, y: 1e308, w: 1, h: 1 })
    expect(r.x).toBe(-1_000_000)
    expect(r.y).toBe(1_000_000)
    expect(r.w).toBe(DASH2_MIN_W)
    expect(r.h).toBe(DASH2_MIN_H)
  })

  it('迁移数学:格 → px 固定系数,比例保持;卡间 gap 折进尺寸', () => {
    const out = migrateGridToCanvas({ a: { x: 2, y: 3, w: 8, h: 6 } })
    expect(out.a).toEqual({
      x: 2 * DASH2_MIGRATE_STEP_X,
      y: 3 * DASH2_MIGRATE_STEP_Y,
      w: 8 * DASH2_MIGRATE_STEP_X - DASH_GAP_PX,
      h: 6 * DASH2_MIGRATE_STEP_Y - DASH_GAP_PX,
    })
  })

  it('自愈:新块排现有内容下方、孤儿键清理、无变化返回 null', () => {
    const layout = { '1': { x: 0, y: 0, w: 400, h: 200 }, ghost: { x: 5, y: 5, w: 100, h: 100 } }
    const next = reconcileCanvas(layout, ['1', '2'])
    expect(next).not.toBe(null)
    expect(next!['ghost']).toBeUndefined()
    expect(next!['2'].y).toBeGreaterThanOrEqual(200) // 排在 1 的下方
    expect(reconcileCanvas(next!, ['1', '2'])).toBe(null) // 已收敛
  })

  it(`空布局 → 删 ${DASH2_FM_KEY} 键`, () => {
    const text = setDash2InFm('dashboard2:\n  "1": [0, 0, 100, 100]', {})
    expect(text).not.toContain(DASH2_FM_KEY)
  })
})
