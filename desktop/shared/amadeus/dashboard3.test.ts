/** 结构化布局(dashboard3:)纯逻辑:读写往返 / 严格三态 / 响应式列数与跨度比例 / 排序与重排 /
 *  自愈稠密编号 / 自由画布→网格迁移。与 dashboard2 的测试同款口径:每条负对照都要真能红。 */
import { describe, expect, it } from 'vitest'
import { readDash2Layout, readDashLayout } from './dashboard'
import {
  DASH3_COLS, DASH3_COL_STEPS, DASH3_FM_KEY, DASH3_GAP_PX, DASH3_MAX_ROWS, DASH3_MIN_COL_PX,
  DASH3_ROW_PX, clampCell, colsForWidth, composeDash3Rows, fitDash3Cell, grid3IsStale, migrateCanvasToGrid, moveCard, orderedIds,
  packDash3Rows, readDash3Layout, readDashMode, reconcileGrid, renumber, setDash3InFm, setDashModeInFm, spanFor,
  DASH3_PIN_KEY, colFor, dropIntoRow, fitRow, layoutDash3Rows, nextPinRow, readDash3Pins, reconcilePins, setDash3PinsInFm,
} from './dashboard3'

describe('dashboard3 读写往返', () => {
  it('写入 → 读回往返;dashboard: / dashboard2: 与别的键原样共存', () => {
    const before = 'dashboard: {"1": [0, 0, 8, 6]}\ndashboard2:\n  "1": [0, 0, 408, 216]\ntitle_extra: 保留我'
    const text = setDash3InFm(before, { '1': { order: 0, w: 6, h: 3 }, '2': { order: 1, w: 3, h: 2 } })
    expect(text).not.toBe(null)
    const back = readDash3Layout(text!)
    expect(back.ok && back.layout).toEqual({ '1': { order: 0, w: 6, h: 3 }, '2': { order: 1, w: 3, h: 2 } })
    // 前两版的键一个字节都没动 —— 它们是回滚保险
    expect(readDashLayout(text!)).toEqual({ ok: true, layout: { '1': { x: 0, y: 0, w: 8, h: 6 } } })
    expect(readDash2Layout(text!).ok).toBe(true)
    expect(text).toContain('title_extra: 保留我')
  })

  it('空布局 → 删键(不留 `dashboard3: {}` 这种垃圾)', () => {
    const text = setDash3InFm(`${DASH3_FM_KEY}:\n  "1": [0, 6, 3]\nx: 1`, {})
    expect(text).not.toContain(DASH3_FM_KEY)
    expect(text).toContain('x: 1')
  })
})

describe('readDash3Layout 的严格三态(照抄 dashboard2 的教训:合法 YAML 的坏值必须冻结)', () => {
  it('键不存在 / 显式 null / 空 frontmatter → 「还没排过版」,放行自愈', () => {
    expect(readDash3Layout('')).toEqual({ ok: true, layout: {} })
    expect(readDash3Layout('other: 1')).toEqual({ ok: true, layout: {} })
    expect(readDash3Layout(`${DASH3_FM_KEY}: null`)).toEqual({ ok: true, layout: {} })
  })

  it('坏 YAML → ok:false;写侧一并拒改返回 null', () => {
    expect(readDash3Layout(`${DASH3_FM_KEY}: [unclosed`).ok).toBe(false)
    expect(setDash3InFm(`${DASH3_FM_KEY}: [unclosed`, {})).toBe(null)
  })

  it('根不是映射 / 键不是映射 / 元组不是恰好三项 / 含非数值 → 一律冻结', () => {
    expect(readDash3Layout('- a\n- b').ok).toBe(false)
    expect(readDash3Layout(`${DASH3_FM_KEY}: [1, 2, 3]`).ok).toBe(false)
    expect(readDash3Layout(`${DASH3_FM_KEY}:\n  "1": [0, 6]`).ok).toBe(false)
    expect(readDash3Layout(`${DASH3_FM_KEY}:\n  "1": [0, 6, 3, 9]`).ok).toBe(false)
    // '6' 是字符串:Number() 强转能过,但写回时就把用户的表示悄悄改掉了 —— 与「读不懂即冻结」同纪律
    expect(readDash3Layout(`${DASH3_FM_KEY}:\n  "1": [0, "6", 3]`).ok).toBe(false)
  })

  it('负对照:去掉长度校验就会把 [0,6] 当成合法布局(证明上一条不是空过)', () => {
    const r = readDash3Layout(`${DASH3_FM_KEY}:\n  "1": [0, 6]`)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toContain('[order, w, h]')
  })
})

describe('clampCell 边界', () => {
  it('越界折回、NaN 不进网格、1e308 不写穿 grid-row', () => {
    expect(clampCell({ order: -5, w: 99, h: 1e308 })).toEqual({ order: 0, w: DASH3_COLS, h: DASH3_MAX_ROWS })
    expect(clampCell({ order: NaN, w: NaN, h: NaN })).toEqual({ order: 0, w: 4, h: 3 })
    expect(clampCell({ order: 2.6, w: 3.4, h: 2.5 })).toEqual({ order: 3, w: 3, h: 3 })
  })
})

describe('响应式:列数与跨度比例', () => {
  it('实际列数只取 12 的因数(半宽恒是半宽,不会变形)', () => {
    for (const n of DASH3_COL_STEPS) expect(DASH3_COLS % n).toBe(0)
    for (const n of DASH3_COL_STEPS) if (n > 1) expect(n % 2).toBe(0) // 偶数才保得住半宽
    expect(colsForWidth(4000)).toBe(12)
    expect(colsForWidth(0)).toBe(1)
    expect(colsForWidth(-1)).toBe(1)
    expect(DASH3_COL_STEPS.includes(colsForWidth(800) as never)).toBe(true)
  })

  it('每一档都真的放得下(列数 × 最小列宽 + 间距 ≤ 容器宽)', () => {
    for (const w of [1920, 1400, 1100, 900, 700, 500, 380, 240, 120]) {
      const n = colsForWidth(w)
      if (n > 1) expect(n * DASH3_MIN_COL_PX + (n - 1) * DASH3_GAP_PX).toBeLessThanOrEqual(w)
    }
  })

  it('列数单调不增:窗口越窄列数只会更少(不许来回跳)', () => {
    let prev = colsForWidth(2000)
    for (let w = 2000; w >= 100; w -= 17) {
      const n = colsForWidth(w)
      expect(n).toBeLessThanOrEqual(prev)
      prev = n
    }
  })

  it('跨度按比例折算:半宽在任何列数下都是半宽', () => {
    for (const n of DASH3_COL_STEPS) {
      expect(spanFor(6, n)).toBe(Math.max(1, n / 2)) // 候选列数全为偶数 → 半宽恒是整数格
      expect(spanFor(12, n)).toBe(n)
    }
    expect(spanFor(4, 12)).toBe(4) // 三分之一
    expect(spanFor(4, 6)).toBe(2)
    expect(spanFor(4, 4)).toBe(1) // 窄档里三分之一退成四分之一(无解,但不会变形成小数)
    expect(spanFor(1, 1)).toBe(1) // 最窄也至少占满一格,不会算出 0
  })
})

describe('顺序:排序 / 重排 / 稠密编号', () => {
  const L = { a: { order: 2, w: 4, h: 3 }, b: { order: 0, w: 4, h: 3 }, c: { order: 1, w: 4, h: 3 } }

  it('按 order 排;布局里没有的块排在末尾', () => {
    expect(orderedIds(L, ['a', 'b', 'c'])).toEqual(['b', 'c', 'a'])
    expect(orderedIds(L, ['a', 'b', 'c', 'z'])).toEqual(['b', 'c', 'a', 'z'])
  })

  it('moveCard 插到目标之前;beforeId=null 移到末尾;order 重新变稠密', () => {
    const moved = moveCard(L, ['a', 'b', 'c'], 'a', 'b')
    expect(orderedIds(moved, ['a', 'b', 'c'])).toEqual(['a', 'b', 'c'])
    expect(Object.values(moved).map((c) => c.order).sort()).toEqual([0, 1, 2])
    expect(orderedIds(moveCard(L, ['a', 'b', 'c'], 'b', null), ['a', 'b', 'c'])).toEqual(['c', 'a', 'b'])
  })

  it('moveCard 保住每张卡自己的尺寸(重排不该改大小)', () => {
    const sized = { a: { order: 0, w: 12, h: 4 }, b: { order: 1, w: 3, h: 2 } }
    const moved = moveCard(sized, ['a', 'b'], 'b', 'a')
    expect(moved.b).toEqual({ order: 0, w: 3, h: 2 })
    expect(moved.a).toEqual({ order: 1, w: 12, h: 4 })
  })

  it('renumber 对未知块给默认尺寸而不是 NaN', () => {
    expect(renumber({}, ['x'])).toEqual({ x: { order: 0, w: 4, h: 3 } })
  })
})

describe('自愈 reconcileGrid', () => {
  it('清孤儿 + 补新块(接末尾)+ 稠密重编号', () => {
    const got = reconcileGrid({ a: { order: 0, w: 6, h: 3 }, gone: { order: 1, w: 4, h: 3 } }, ['a', 'fresh'])
    expect(got).toEqual({ a: { order: 0, w: 6, h: 3 }, fresh: { order: 1, w: 4, h: 3 } })
  })

  it('已经对齐 → 返回 null(不触发无谓落盘)', () => {
    expect(reconcileGrid({ a: { order: 0, w: 6, h: 3 } }, ['a'])).toBe(null)
  })

  it('order 有洞/重复 → 压平成 0..n-1', () => {
    const got = reconcileGrid({ a: { order: 9, w: 4, h: 3 }, b: { order: 9, w: 4, h: 3 } }, ['a', 'b'])
    expect(Object.values(got!).map((c) => c.order).sort()).toEqual([0, 1])
  })

  it('布局与块 id 完全不相交 → 判 stale,调用方停手(别当孤儿清掉)', () => {
    expect(grid3IsStale({ '9': { order: 0, w: 4, h: 3 } }, ['1', '2'])).toBe(true)
    expect(grid3IsStale({ '1': { order: 0, w: 4, h: 3 } }, ['1', '2'])).toBe(false)
    expect(grid3IsStale({}, ['1'])).toBe(false)
  })
})

describe('布局模式键', () => {
  it('缺省 = 没表态;canvas / grid 各自读得出;写入不动别的键', () => {
    expect(readDashMode('x: 1')).toBe(null)
    expect(readDashMode('dashLayout: canvas')).toBe('canvas')
    expect(readDashMode('dashLayout: 乱写')).toBe(null)
    const text = setDashModeInFm('dashboard2:\n  "1": [0, 0, 408, 216]', 'canvas')
    expect(readDashMode(text!)).toBe('canvas')
    expect(readDash2Layout(text!).ok).toBe(true)
  })
})

describe('自由画布 → 网格迁移', () => {
  it('顺序按阅读序(先上后左),跨度按 1152 宽画板的比例折算', () => {
    const got = migrateCanvasToGrid({
      right: { x: 600, y: 0, w: 288, h: 216 },
      left: { x: 0, y: 10, w: 576, h: 216 },   // 与 right 同一行(容差内),但更靠左
      below: { x: 0, y: 400, w: 1152, h: 60 },
    })
    expect(orderedIds(got, ['right', 'left', 'below'])).toEqual(['left', 'right', 'below'])
    expect(got.left.w).toBe(6)   // 576 / 96 = 半宽
    expect(got.right.w).toBe(3)  // 288 / 96 = 四分之一
    expect(got.below.w).toBe(12) // 铺满
    expect(got.left.h).toBe(Math.round((216 + DASH3_GAP_PX) / (DASH3_ROW_PX + DASH3_GAP_PX)))
    expect(got.below.h).toBe(1)  // 再矮也至少一行
  })

  it('迁移结果一律合法(可以直接落盘)', () => {
    const got = migrateCanvasToGrid({ huge: { x: -9999, y: -9999, w: 99999, h: 99999 } })
    expect(got.huge.w).toBeLessThanOrEqual(DASH3_COLS)
    expect(got.huge.h).toBeLessThanOrEqual(DASH3_MAX_ROWS)
    expect(setDash3InFm('', got)).not.toBe(null)
  })
})

describe('卡片尺寸契约与受控分行', () => {
  it('旧的任意尺寸会贴到视图支持的最近档，且不会无故放大', () => {
    expect(fitDash3Cell({ order: 4, w: 3, h: 2 }, ['lg', 'full'])).toEqual({ order: 4, w: 6, h: 5 })
    expect(fitDash3Cell({ order: 0, w: 6, h: 3 }, ['wide', 'lg'])).toEqual({ order: 0, w: 6, h: 3 })
    expect(fitDash3Cell({ order: 0, w: 5, h: 4 }, ['wide', 'lg'])).toEqual({ order: 0, w: 6, h: 3 })
  })

  it('交互编辑器可以声明整行工作区档，精确保留 12×8 的可操作高度', () => {
    expect(fitDash3Cell({ order: 2, w: 12, h: 8 }, ['lg', 'full', 'workspace']))
      .toEqual({ order: 2, w: 12, h: 8 })
    expect(fitDash3Cell({ order: 2, w: 6, h: 5 }, ['lg', 'full', 'workspace']))
      .toEqual({ order: 2, w: 6, h: 5 })
  })

  it('高度族不同就换行，不再把短卡拉到高卡的高度', () => {
    const rows = packDash3Rows([
      { id: 'clock', span: 3, h: 2 },
      { id: 'todo', span: 6, h: 5 },
      { id: 'calendar', span: 6, h: 5 },
      { id: 'section', span: 12, h: 1, chrome: true },
      { id: 'stat', span: 3, h: 2 },
    ], 12)
    expect(rows.map((row) => ({ h: row.h, ids: row.items.map((item) => item.id) }))).toEqual([
      { h: 2, ids: ['clock'] },
      { h: 5, ids: ['todo', 'calendar'] },
      { h: 1, ids: ['section'] },
      { h: 2, ids: ['stat'] },
    ])
  })

  it('同高度卡仍按跨度贪心铺满，窄屏自动一张一行', () => {
    const cards = [
      { id: 'a', span: 3, h: 2 },
      { id: 'b', span: 3, h: 2 },
      { id: 'c', span: 6, h: 2 },
    ]
    expect(packDash3Rows(cards, 12)).toHaveLength(1)
    expect(packDash3Rows(cards, 1).map((row) => row.items.map((item) => item.id))).toEqual([['a'], ['b'], ['c']])
  })

  it('自动编排会在声明尺寸内改档，把可兼容的相邻卡拼满', () => {
    const rows = composeDash3Rows([
      { id: 'clock', preferred: { order: 0, w: 3, h: 2 }, choices: [{ key: 'sm', w: 3, h: 2 }, { key: 'wide', w: 6, h: 3 }] },
      { id: 'text', preferred: { order: 1, w: 3, h: 2 }, choices: [{ key: 'md', w: 4, h: 3 }, { key: 'wide', w: 6, h: 3 }] },
      { id: 'view', preferred: { order: 2, w: 6, h: 5 }, choices: [{ key: 'wide', w: 6, h: 3 }, { key: 'lg', w: 6, h: 5 }, { key: 'full', w: 12, h: 4 }] },
    ], 12)
    expect(rows.map((row) => row.items.map((item) => `${item.id}:${item.size}`))).toEqual([
      ['clock:wide', 'text:wide'],
      ['view:lg'],
    ])
    expect(rows[0].items.reduce((sum, item) => sum + item.span, 0)).toBe(12)
    expect(rows[1].items[0]).toMatchObject({ span: 6, start: 4 })
  })

  it('自动编排不越过 section，且 1 列窄屏仍维持阅读顺序', () => {
    const rows = composeDash3Rows([
      { id: 'a', preferred: { order: 0, w: 6, h: 3 }, choices: [{ key: 'wide', w: 6, h: 3 }] },
      { id: 'section', preferred: { order: 1, w: 12, h: 1 }, choices: [{ key: 'full', w: 12, h: 4 }], chrome: true },
      { id: 'b', preferred: { order: 2, w: 6, h: 3 }, choices: [{ key: 'wide', w: 6, h: 3 }] },
    ], 1)
    expect(rows.map((row) => row.items.map((item) => item.id))).toEqual([['a'], ['section'], ['b']])
  })
})

describe('手工行位(dashboard3x:)', () => {
  it('写入 → 读回往返;与 dashboard3: 串在同一份 fm 上互不打扰', () => {
    const layout = setDash3InFm('title_extra: 保留我', { '1': { order: 0, w: 6, h: 5 }, '2': { order: 1, w: 3, h: 2 } })
    const text = setDash3PinsInFm(layout!, { '1': { row: 4, col: 0 }, '2': { row: 4, col: 8 } })
    expect(text).not.toBe(null)
    const back = readDash3Pins(text!)
    expect(back.ok && back.pins).toEqual({ '1': { row: 4, col: 0 }, '2': { row: 4, col: 8 } })
    expect(readDash3Layout(text!).ok).toBe(true)
    expect(text).toContain('title_extra: 保留我')
  })

  it('三态:没键=空 / 坏值=冻结(不当成空) / 清空=删键', () => {
    expect(readDash3Pins('dashboard3:\n  "1": [0, 6, 3]')).toEqual({ ok: true, pins: {} })
    expect(readDash3Pins(`${DASH3_PIN_KEY}:\n  "1": [0, 6, 3]`).ok).toBe(false) // 三项 ≠ [row,col]
    expect(readDash3Pins(`${DASH3_PIN_KEY}:\n  "1": [0, "x"]`).ok).toBe(false)
    expect(readDash3Pins(`${DASH3_PIN_KEY}: 7`).ok).toBe(false)
    const cleared = setDash3PinsInFm(`${DASH3_PIN_KEY}:\n  "1": [0, 6]\nx: 1`, {})
    expect(cleared).not.toContain(DASH3_PIN_KEY)
    expect(cleared).toContain('x: 1')
  })

  it('手工行:横向留白保留,且**不同高度**的卡可以并排(band 高=最高那张)', () => {
    const rows = layoutDash3Rows([
      { id: 'big', preferred: { order: 0, w: 6, h: 5 }, choices: [{ key: 'lg', w: 6, h: 5 }] },
      { id: 'mini', preferred: { order: 1, w: 3, h: 2 }, choices: [{ key: 'sm', w: 3, h: 2 }] },
    ], { big: { row: 0, col: 0 }, mini: { row: 0, col: 9 } }, 12)
    expect(rows).toHaveLength(1)
    expect(rows[0].h).toBe(5) // band 高 = 最高卡;矮卡按自己的 h 渲染,下方留白
    expect(rows[0].items.map((i) => [i.id, i.start, i.span, i.h])).toEqual([['big', 1, 6, 5], ['mini', 10, 3, 2]])
  })

  it('手工段与自动段互为硬边界:pin 的行不被自动卡挤进来,没 pin 的行行为逐字照旧', () => {
    const auto = [
      { id: 'a', preferred: { order: 1, w: 3, h: 2 }, choices: [{ key: 'sm' as const, w: 3, h: 2 }, { key: 'wide' as const, w: 6, h: 3 }] },
      { id: 'b', preferred: { order: 2, w: 3, h: 2 }, choices: [{ key: 'sm' as const, w: 3, h: 2 }, { key: 'wide' as const, w: 6, h: 3 }] },
    ]
    const pinned = { id: 'p', preferred: { order: 0, w: 6, h: 5 }, choices: [{ key: 'lg' as const, w: 6, h: 5 }] }
    const rows = layoutDash3Rows([pinned, ...auto], { p: { row: 0, col: 6 } }, 12)
    expect(rows.map((r) => r.items.map((i) => i.id))).toEqual([['p'], ['a', 'b']])
    expect(rows[0].items[0].start).toBe(7) // 独占一行、靠右摆,左半留白
    // 回归钉:自动那一行与「页面上没有任何 pin」时逐字一致(拍板「未动仍自动」的可证伪判据)
    expect(rows[1]).toEqual(composeDash3Rows(auto, 12)[0])
  })

  it('手工行冲突降级:重叠 / 装不下 → 挤到下一行,永不叠压', () => {
    const item = (id: string, w: number) => ({ id, preferred: { order: 0, w, h: 3 }, choices: [{ key: 'wide' as const, w, h: 3 }] })
    const rows = layoutDash3Rows(
      [item('a', 6), item('b', 6), item('c', 6)],
      { a: { row: 0, col: 0 }, b: { row: 0, col: 3 }, c: { row: 0, col: 0 } }, // b 与 a 重叠;c 想回列首
      12,
    )
    expect(rows.map((r) => r.items.map((i) => `${i.id}@${i.start}`))).toEqual([['a@1', 'b@7'], ['c@1']])
  })

  it('降列不溢出:x 与 w 各自取整会越过右边界(横向滚动条的真身)', () => {
    expect(colFor(7, spanFor(5, 6), 6)).toBe(3) // round(3.5)=4 + span 3 = 7 > 6 → 夹回 3
    expect(colFor(6, spanFor(6, 6), 6)).toBe(3)
    expect(colFor(11, spanFor(3, 4), 4)).toBe(3)
    const rows = layoutDash3Rows([
      { id: 'a', preferred: { order: 0, w: 5, h: 3 }, choices: [{ key: 'wide', w: 5, h: 3 }] },
    ], { a: { row: 0, col: 7 } }, 6)
    const it0 = rows[0].items[0]
    expect((it0.start ?? 1) - 1 + it0.span).toBeLessThanOrEqual(6)
  })

  it('fitRow:后来的被推开,行尾放不下的退出这一行;平手时首位(正在拖的那张)胜出', () => {
    expect(fitRow([{ id: 'drag', col: 0, w: 6 }, { id: 'old', col: 0, w: 6 }])).toEqual({
      row: [{ id: 'drag', col: 0, w: 6 }, { id: 'old', col: 6, w: 6 }], spilled: [],
    })
    // 插到中间:左边的保持,被拖的落到它右边(左边缘定序)
    expect(fitRow([{ id: 'drag', col: 3, w: 6 }, { id: 'old', col: 0, w: 6 }]).row)
      .toEqual([{ id: 'old', col: 0, w: 6 }, { id: 'drag', col: 6, w: 6 }])
    // 三张 6 宽塞一行 → 最右那张被挤出去
    expect(fitRow([{ id: 'x', col: 0, w: 6 }, { id: 'y', col: 6, w: 6 }, { id: 'z', col: 9, w: 6 }]).spilled).toEqual(['z'])
  })

  it('dropIntoRow:视觉序连带改 order;被挤出去的卡丢掉 pin(回自动流)', () => {
    const before = { z: { row: 0, col: 6 } }
    const out = dropIntoRow(['a', 'b', 'z'], before, [
      { id: 'b', col: 0, w: 6 }, // 正在拖的放首位
      { id: 'z', col: 6, w: 6 },
      { id: 'a', col: 6, w: 6 },
    ], 9)
    expect(out.ids).toEqual(['b', 'z', 'a']) // 整块落在最靠前那位成员(a)的原位
    expect(out.pins).toEqual({ b: { row: 9, col: 0 }, z: { row: 9, col: 6 } })
    expect(out.pins.a).toBeUndefined() // 溢出 = 回自动流,不冻结
    expect(nextPinRow(out.pins)).toBe(10)
  })

  it('手工行的几何取**选中档**(pin 蕴含尺寸铁,那一档已夹过下界),不是裸 preferred', () => {
    const rows = layoutDash3Rows([
      { id: 'old', preferred: { order: 0, w: 3, h: 2 }, choices: [{ key: 'md', w: 4, h: 3 }] }, // 存量小尺寸 → 夹到 4×3
    ], { old: { row: 0, col: 0 } }, 12)
    expect(rows[0].items[0]).toMatchObject({ span: 4, h: 3 })
  })

  it('pin 自愈只清孤儿;行号稀疏无所谓(同值才算同行)', () => {
    expect(reconcilePins({ '1': { row: 3, col: 0 } }, ['1'])).toBe(null)
    expect(reconcilePins({ '1': { row: 3, col: 0 }, '9': { row: 3, col: 6 } }, ['1'])).toEqual({ '1': { row: 3, col: 0 } })
  })
})
