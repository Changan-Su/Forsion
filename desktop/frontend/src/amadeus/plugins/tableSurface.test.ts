/**
 * 插件表格接缝的**纯**那一半:TableSpec → DbFile(specToDb)+ 富边料(tableCellMeta)+ 校验。
 * 钉的是几条会静默出错的口径:
 *   · DbFile 的 cell 只放基元 —— 装饰混进 cell 就等于把排序/筛选/统计喂成对象;
 *   · `sortValue` 在场时列类型跟着它走(不跟 = 数字列按字典序排,「10 < 9」);
 *   · 显示文案落 cellMeta.text(复合格的真值在 cell 里,渲染端不看 meta 就会把排序值画出来);
 *   · 非法规格**同步抛**(插件按抛 = 降级到经典表格;不抛 = 面板空一块还没报错)。
 * 刻意不 import tableSurface.tsx:那条会拖进 React / @amadeus/blocks / DatabaseEmbed,
 * 纯逻辑没必要为此进 happy-dom,也不该被隔壁正在改的渲染层带红。
 */
import { describe, expect, it } from 'vitest'
import { TABLE_ACTIONS_COL, specToDb, tableCellMeta, validateTableSpec } from './tableSpec'
import type { TableSpec } from './types'

const spec = (over: Partial<TableSpec> = {}): TableSpec => ({
  id: 'models',
  columns: [
    { key: 'name', label: '模型', kind: 'text' },
    { key: 'calls', label: '调用', kind: 'number' },
    { key: 'day', label: '日期', kind: 'date' },
    { key: 'state', label: '状态', kind: 'select', options: [{ value: 'on', label: '启用', color: 'green' }, { value: 'off', label: '停用', color: 'gray' }] },
    { key: 'pub', label: '公开', kind: 'check' },
    { key: 'site', label: '主页', kind: 'url' },
  ],
  rows: [
    {
      id: 'm1',
      cells: {
        name: { text: 'DeepSeek', sub: 'deepseek-v4', avatar: { letter: 'D', attrs: { 'data-hook': 'fb-avatar' } } },
        calls: { text: '58.5 万', sortValue: 585000 },
        day: '2026-09-05',
        state: 'on',
        pub: true,
        site: { text: 'example.com', href: 'https://example.com' },
      },
    },
    { id: 'm2', cells: { name: 'Qwen', calls: 9, day: '2026-09-01', state: { value: 'off' }, pub: false, site: null } },
  ],
  ...over,
})

describe('specToDb', () => {
  it('列序 = spec 列序;kind 折算成多维表列类型', () => {
    const db = specToDb(spec())
    expect(db.columns.map((c) => c.id)).toEqual(['name', 'calls', 'day', 'state', 'pub', 'site'])
    expect(db.columns.map((c) => c.type)).toEqual(['text', 'number', 'date', 'select', 'checkbox', 'url'])
    expect(db.columns.find((c) => c.id === 'state')?.options).toEqual(['on', 'off'])
  })

  it('cell 只放基元:sortValue 在场取 sortValue,否则按列类型折算', () => {
    const db = specToDb(spec())
    expect(db.rows[0].cells).toEqual({ name: 'DeepSeek', calls: 585000, day: '2026-09-05', state: 'on', pub: true, site: 'example.com' })
    expect(db.rows[1].cells).toEqual({ name: 'Qwen', calls: 9, day: '2026-09-01', state: 'off', pub: false, site: '' })
    for (const cells of db.rows.map((r) => r.cells)) {
      for (const v of Object.values(cells)) expect(['string', 'number', 'boolean']).toContain(typeof v)
    }
  })

  it('sortValue 是数字 → 该列恒 number(不跟就按字典序排,「585000 < 9」)', () => {
    const s = spec()
    s.columns[1] = { key: 'calls', label: '调用', kind: 'text' } // 声明成 text,但值是数字排序键
    expect(specToDb(s).columns.find((c) => c.id === 'calls')?.type).toBe('number')
  })

  it('actions 在场才追加保留列 __actions,表头取 actionsLabel', () => {
    expect(specToDb(spec()).columns.some((c) => c.id === TABLE_ACTIONS_COL)).toBe(false)
    const db = specToDb(spec({ actions: () => [{ act: 'm-edit', label: '编辑' }], actionsLabel: '操作' }))
    const col = db.columns[db.columns.length - 1]
    expect(col).toMatchObject({ id: TABLE_ACTIONS_COL, name: '操作', type: 'text' })
    expect(db.rows.every((r) => r.cells[TABLE_ACTIONS_COL] === '')).toBe(true)
  })

  it('列宽建议原样带过去;行 id 即多维表行 id', () => {
    const s = spec()
    s.columns[0].width = 180
    expect(specToDb(s).columns[0].width).toBe(180)
    expect(specToDb(s).rows.map((r) => r.id)).toEqual(['m1', 'm2'])
  })
})

describe('tableCellMeta', () => {
  it('装饰(两行 / 头像 / 链接 / tooltip / 等宽)进边料,不进 cell', () => {
    const meta = tableCellMeta(spec())
    expect(meta.m1.name).toMatchObject({ sub: 'deepseek-v4' })
    expect(meta.m1.name.text).toBeUndefined() // 普通文本格的文案就在 cell 基元里,meta.text 只当显示覆盖
    expect(meta.m1.name.avatar).toEqual({ letter: 'D', attrs: { 'data-hook': 'fb-avatar' } })
    expect(meta.m1.site.href).toBe('https://example.com')
  })

  it('sortValue 复合格:显示文案必须留在 meta.text(cell 里只剩排序值)', () => {
    expect(tableCellMeta(spec()).m1.calls.text).toBe('58.5 万')
    expect(specToDb(spec()).rows[0].cells.calls).toBe(585000)
  })

  it('select:选项 label 补进 text、选项 color 折成 tone(yellow→amber、gray→muted)', () => {
    const meta = tableCellMeta(spec())
    expect(meta.m1.state).toMatchObject({ text: '启用', tone: 'green' })
    expect(meta.m2.state).toMatchObject({ text: '停用', tone: 'muted' })
  })

  it('列级 mono 落到每一格;actions 落在 __actions 那格', () => {
    const s = spec({ actions: (row) => (row.id === 'm1' ? [{ act: 'm-edit', label: '编辑', attrs: { 'data-id': row.id } }] : []) })
    s.columns[0].mono = true
    const meta = tableCellMeta(s)
    expect(meta.m1.name.mono).toBe(true)
    expect(meta.m1[TABLE_ACTIONS_COL].actions).toEqual([{ act: 'm-edit', label: '编辑', attrs: { 'data-id': 'm1' } }])
    expect(meta.m2[TABLE_ACTIONS_COL]).toBeUndefined() // 空按钮列表不占位
  })
})

describe('validateTableSpec:非法规格同步抛(调用方按抛 = 降级)', () => {
  const throws = (over: Partial<TableSpec>, re: RegExp) => expect(() => validateTableSpec(spec(over))).toThrow(re)

  it('空列 / 空行数组', () => {
    throws({ columns: [] }, /columns/)
    expect(() => validateTableSpec(spec({ rows: [] }))).not.toThrow() // 空表合法,由 empty 文案兜
    throws({ rows: undefined as unknown as TableSpec['rows'] }, /rows/)
  })

  it('列 key / 行 id 缺失、重复,以及保留列名', () => {
    throws({ columns: [{ key: '', label: 'x', kind: 'text' }] }, /key/)
    throws({ columns: [{ key: 'a', label: 'A', kind: 'text' }, { key: 'a', label: 'A2', kind: 'text' }] }, /duplicate column key/)
    throws({ columns: [{ key: TABLE_ACTIONS_COL, label: 'x', kind: 'text' }] }, /reserved/)
    throws({ rows: [{ id: '', cells: {} }] }, /row needs a non-empty id|每行都要有非空 id/)
    throws({ rows: [{ id: 'a', cells: {} }, { id: 'a', cells: {} }] }, /duplicate row id/)
  })

  it('单元格文案不是基元(塞了对象/数组/DOM)—— HTML 字符串走私的入口', () => {
    throws({ rows: [{ id: 'a', cells: { name: { text: { toString: () => 'x' } as unknown as string } } }] }, /text must be a primitive/)
    throws({ rows: [{ id: 'a', cells: { name: ['x'] as unknown as string } }] }, /primitive or an object/)
  })

  it('specToDb / tableCellMeta 自己也先校验(接缝的两个入口都不许绕过)', () => {
    expect(() => specToDb(spec({ columns: [] }))).toThrow(/columns/)
    expect(() => tableCellMeta(spec({ columns: [] }))).toThrow(/columns/)
  })
})

describe('tableCellMeta:meta.text 只当显示覆盖(评审 09-05)', () => {
  const spec = (cells: Record<string, unknown>, kinds: Record<string, 'text' | 'number' | 'date' | 'select'>): TableSpec => ({
    id: 't',
    columns: Object.entries(kinds).map(([key, kind]) => ({ key, label: key, kind })),
    rows: [{ id: 'r', cells: cells as TableSpec['rows'][number]['cells'] }],
  })
  it('date 列:对象格的 ISO 文案不进 meta.text,meta.format 缺省 datetime(否则渲染层拿裸 ISO 原样上屏)', () => {
    const m = tableCellMeta(spec({ at: { text: '2026-09-05T02:00:00.000Z', tone: 'muted' } }, { at: 'date' }))
    expect(m.r.at.text).toBeUndefined()
    expect(m.r.at.format).toBe('datetime')
    expect(specToDb(spec({ at: { text: '2026-09-05T02:00:00.000Z' } }, { at: 'date' })).rows[0].cells.at).toBe('2026-09-05T02:00:00.000Z')
  })
  it('number 列:纯数字对象格不进 meta.text(渲染层负责千分位);sortValue 复合格与「—」这类消化不了的文案才覆盖', () => {
    const m = tableCellMeta(spec({ n: { text: 12345 }, c: { text: '58.5 万', sortValue: 585000 }, d: { text: '—' } }, { n: 'number', c: 'number', d: 'number' }))
    expect(m.r.n?.text).toBeUndefined()
    expect(m.r.c.text).toBe('58.5 万')
    expect(m.r.d.text).toBe('—')
  })
  it('date 列的「永不」/ 空串:不是日期就原样显示,空串不覆盖', () => {
    const m = tableCellMeta(spec({ a: { text: '永不' }, b: { text: '' } }, { a: 'date', b: 'date' }))
    expect(m.r.a.text).toBe('永不')
    expect(m.r.b?.text).toBeUndefined()
  })
  it('select 列:option.label 仍进 meta.text(芯片文案),color 折成 tone', () => {
    const s = spec({ st: 'ok' }, { st: 'select' })
    s.columns[0].options = [{ value: 'ok', label: '成功', color: 'green' }]
    const m = tableCellMeta(s)
    expect(m.r.st.text).toBe('成功')
    expect(m.r.st.tone).toBe('green')
  })
})
