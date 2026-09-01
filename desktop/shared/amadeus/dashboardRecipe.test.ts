import { describe, expect, it } from 'vitest'
import { compileDashboardRecipe, type DashboardRecipe } from './dashboardRecipe'
import { parseBody } from './compiler/markers'
import { extractFrontmatterExtra, parseFrontmatter, stripFrontmatter } from './compiler/split'
import { parseWidget } from './dashboard'
import { readDash3Layout } from './dashboard3'
import { parseStatSpec } from './dashboardData'

const NOW = '2026-09-01T00:00:00.000Z'

const RECIPE: DashboardRecipe = {
  cards: [
    { kind: 'section', id: 'sec-kpi', label: '服务器状态' },
    { kind: 'stat', id: 's-users', label: '总用户数', value: '1,234' },
    { kind: 'stat', id: 's-req', label: 'API 请求(30天)', value: '56,789', unit: '次' },
    { kind: 'view', id: 'v-cal', type: 'calendar', params: { mode: 'month' } },
    { kind: 'text', id: 't-note', md: '数据取自打开一刻,点「总览」重新生成。' },
  ],
}

describe('compileDashboardRecipe:配方 → 真 .dashboard.md 字节', () => {
  it('round-trip:块标记/围栏/布局三层全部能被真解码器读回', () => {
    const r = compileDashboardRecipe(RECIPE, { pageId: 'p_test', now: NOW })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    // frontmatter 三件套 = 真笔记同构
    const fm = parseFrontmatter(r.text)
    expect(fm.amadeus_page).toBe('p_test')
    expect(fm.amadeus_schema).toContain('amadeus.page/3')
    // 布局层:dashboard3 键齐、order = 配方序
    const read = readDash3Layout(extractFrontmatterExtra(r.text))
    expect(read.ok).toBe(true)
    if (!read.ok) return
    expect(Object.keys(read.layout).sort()).toEqual(['s-req', 's-users', 'sec-kpi', 't-note', 'v-cal'].sort())
    expect(read.layout['sec-kpi'].order).toBe(0)
    expect(read.layout['sec-kpi'].w).toBe(12)
    expect(read.layout['s-users'].order).toBe(1)
    // 块层:parseBody 按标记切出全部块(无匿名前导)
    const blocks = parseBody(stripFrontmatter(r.text))
    expect(blocks.map((b) => b.id)).toEqual(['sec-kpi', 's-users', 's-req', 'v-cal', 't-note'])
    // 围栏层:widget 逐张可反解,literal stat 契约成立
    const stat = parseWidget(blocks[1].content)
    expect(stat?.kind).toBe('stat')
    const spec = parseStatSpec(stat!.opts)
    expect(spec.ok && spec.spec.literal).toBe('1,234')
    expect(spec.ok && spec.spec.label).toBe('总用户数')
    const statUnit = parseWidget(blocks[2].content)
    const spec2 = parseStatSpec(statUnit!.opts)
    expect(spec2.ok && spec2.spec.unit).toBe('次')
    const view = parseWidget(blocks[3].content)
    expect(view?.kind).toBe('view')
    expect(view?.opts.type).toBe('calendar')
    expect(view?.opts.mode).toBe('month')
    expect(parseWidget(blocks[4].content)).toBe(null) // text 卡 = 普通 markdown
  })

  it('再生成保布局:用户手排的 w/h、dashboard3x 行位、dashFilter、页 id 全部存活', () => {
    const v1 = compileDashboardRecipe(RECIPE, { pageId: 'p_keep', now: NOW })
    expect(v1.ok).toBe(true)
    if (!v1.ok) return
    // 模拟用户手排:把 s-users 改成 6×5,并加 pin 与页面筛选(排版台会写这些键)
    const edited = v1.text
      .replace('s-users: [ 1, 3, 2 ]', 's-users: [ 1, 6, 5 ]')
      .replace('amadeus_page: p_keep', 'amadeus_page: p_keep\ndashboard3x:\n  s-users: [0, 3]\ndashFilter:\n  - { prop: 状态, op: eq, value: 开 }')
    expect(edited).toContain('[ 1, 6, 5 ]') // 前置:替换真的发生了(防 silent no-op 假绿)
    // 再生成:数值变了 + 多一张新卡
    const v2recipe: DashboardRecipe = {
      cards: [...RECIPE.cards, { kind: 'stat', id: 's-new', label: '新指标', value: '7' }],
    }
    const v2 = compileDashboardRecipe(v2recipe, { existingFileText: edited, now: NOW })
    expect(v2.ok).toBe(true)
    if (!v2.ok) return
    const fm2 = parseFrontmatter(v2.text)
    expect(fm2.amadeus_page).toBe('p_keep') // 页 id 存活(链接/嵌入不断)
    const extra = extractFrontmatterExtra(v2.text)
    const read = readDash3Layout(extra)
    expect(read.ok).toBe(true)
    if (!read.ok) return
    expect(read.layout['s-users'].w).toBe(6) // 手排几何存活
    expect(read.layout['s-users'].h).toBe(5)
    expect(read.layout['s-new'].w).toBe(3) // 新卡拿默认
    expect(extra).toContain('dashboard3x') // pin 键逐字带过
    expect(extra).toContain('dashFilter')
  })

  it('拒绝面:坏 id / 重复 id / 现有布局读不懂 / 更新版本 schema', () => {
    expect(compileDashboardRecipe({ cards: [] }).ok).toBe(false)
    expect(compileDashboardRecipe({ cards: [{ kind: 'stat', id: 'a b', label: 'x', value: '1' }] }).ok).toBe(false)
    expect(compileDashboardRecipe({
      cards: [
        { kind: 'stat', id: 'dup', label: 'x', value: '1' },
        { kind: 'stat', id: 'dup', label: 'y', value: '2' },
      ],
    }).ok).toBe(false)
    // 现有 dashboard3 是坏值 → 拒(冻结纪律:坏值当空会永久覆盖用户布局)
    const frozen = compileDashboardRecipe(RECIPE, {
      existingFileText: '---\namadeus_page: p1\ndashboard3: 5\n---\n<!-- a x -->\nhi\n',
      now: NOW,
    })
    expect(frozen.ok).toBe(false)
    if (!frozen.ok) expect(frozen.error).toContain('拒绝覆盖')
    // 未来 schema → 拒(旧端修复未来格式 = 毁档)
    const future = compileDashboardRecipe(RECIPE, {
      existingFileText: '---\namadeus_page: p1\namadeus_schema: amadeus.page/4\n---\n',
      now: NOW,
    })
    expect(future.ok).toBe(false)
  })

  it('值消毒:换行折成空格,含反引号的值不拆围栏', () => {
    const r = compileDashboardRecipe({
      cards: [{ kind: 'stat', id: 's1', label: '两\n行', value: '```' }],
    }, { pageId: 'p_s', now: NOW })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    const blocks = parseBody(stripFrontmatter(r.text))
    const w = parseWidget(blocks[0].content)
    expect(w?.kind).toBe('stat')
    expect(w?.opts.label).toBe('两 行')
    expect(w?.opts.value).toBe('```')
  })
})
