// Database 文件格式纯逻辑:round-trip / 拒读 / 类型折算。格式一旦锁定,改动必须过这里。
import { describe, expect, it } from 'vitest'
import { coerceForDisplay, emptyDb, parseDb, serializeDb, DB_VERSION, type DbFile } from './schema'

const SAMPLE: DbFile = {
  version: 1,
  name: '任务表',
  columns: [
    { id: 'c1', name: '名称', type: 'text' },
    { id: 'c2', name: '完成', type: 'checkbox' },
    { id: 'c3', name: '标签', type: 'multiselect', options: ['红', '蓝'] },
    { id: 'c4', name: '链接', type: 'url' },
    { id: 'c5', name: '截止', type: 'date' },
    { id: 'c6', name: '数量', type: 'number' },
    { id: 'c7', name: '状态', type: 'select', options: ['进行中', '已完成'] },
  ],
  rows: [
    { id: 'r1', cells: { c1: '写文档', c2: true, c3: ['红'], c4: 'https://a.b', c5: '2026-07-02', c6: 3, c7: '进行中' } },
    { id: 'r2', cells: {} },
  ],
}

describe('db schema', () => {
  it('serialize ↔ parse 往返无损,两空格缩进 + 尾换行(git 友好)', () => {
    const text = serializeDb(SAMPLE)
    expect(text.endsWith('\n')).toBe(true)
    expect(text).toContain('  "version": 1')
    const r = parseDb(text)
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.data).toEqual(SAMPLE)
      expect(serializeDb(r.data)).toBe(text)
    }
  })

  it('emptyDb 种子:标题 + 文本两列 + 1 空行,当前版本号', () => {
    const db = emptyDb('未命名数据库')
    expect(db.version).toBe(DB_VERSION)
    expect(db.name).toBe('未命名数据库')
    // 只给一列身份列时,新建表的第一件事永远是手动加一列才能记东西 → 默认给到两列。
    expect(db.columns.map((c) => c.name)).toEqual(['标题', '文本'])
    expect(db.columns.every((c) => c.type === 'text')).toBe(true)
    expect(new Set(db.columns.map((c) => c.id)).size).toBe(2) // 列 id 必须各不相同
    expect(db.rows).toHaveLength(1)
    expect(parseDb(serializeDb(db)).ok).toBe(true)
  })

  it('损坏 JSON / 结构不符 / 版本过新 → 拒读(返回错误不抛异常)', () => {
    expect(parseDb('{oops').ok).toBe(false)
    expect(parseDb('{"foo":1}').ok).toBe(false)
    expect(parseDb(JSON.stringify({ ...SAMPLE, columns: [{ id: '', name: 'x', type: 'text' }] })).ok).toBe(false)
    expect(parseDb(JSON.stringify({ ...SAMPLE, version: DB_VERSION + 1 })).ok).toBe(false)
  })

  it('coerceForDisplay:类型互切宽容折算(重点 select↔multiselect)', () => {
    // select 列遇到 multiselect 存的数组 → 取首个
    expect(coerceForDisplay(['红', '蓝'], 'select')).toBe('红')
    expect(coerceForDisplay([], 'select')).toBe('')
    // multiselect 列遇到 select 存的字符串 → 包成单元素数组
    expect(coerceForDisplay('红', 'multiselect')).toEqual(['红'])
    expect(coerceForDisplay('', 'multiselect')).toEqual([])
    // text 遇数组/数字
    expect(coerceForDisplay(['a', 'b'], 'text')).toBe('a, b')
    expect(coerceForDisplay(42, 'text')).toBe('42')
    // number 遇字符串
    expect(coerceForDisplay('3.5', 'number')).toBe(3.5)
    expect(coerceForDisplay('abc', 'number')).toBeNull()
    // checkbox 只认 true
    expect(coerceForDisplay('yes', 'checkbox')).toBe(false)
    expect(coerceForDisplay(true, 'checkbox')).toBe(true)
    // date 只认 YYYY-MM-DD
    expect(coerceForDisplay('2026-07-02', 'date')).toBe('2026-07-02')
    expect(coerceForDisplay('昨天', 'date')).toBe('')
    // url / 空值
    expect(coerceForDisplay(undefined, 'url')).toBe('')
    expect(coerceForDisplay(null, 'text')).toBe('')
  })

  it('column.width(列宽拖拽落盘)往返无损;无 width 的旧文件照常解析(缺=弹性列)', () => {
    const db: DbFile = {
      ...SAMPLE,
      columns: SAMPLE.columns.map((c, i) => (i === 0 ? { ...c, width: 240 } : c)),
    }
    const r = parseDb(serializeDb(db))
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.data.columns[0].width).toBe(240)
      expect(r.data.columns[1].width).toBeUndefined()
      expect(r.data).toEqual(db)
    }
    // 旧文件(无 width 字段)向后兼容
    const legacy = parseDb(serializeDb(SAMPLE))
    expect(legacy.ok).toBe(true)
    if (legacy.ok) expect(legacy.data.columns.every((c) => c.width === undefined)).toBe(true)
    // 非正数宽度是坏数据,结构校验拒绝
    const bad = { ...SAMPLE, columns: [{ id: 'c1', name: 'x', type: 'text', width: -10 }] }
    expect(parseDb(JSON.stringify(bad)).ok).toBe(false)
  })

  it('views(多视图)往返无损;旧文件缺 views 照常解析;未知视图类型放行(前向兼容)', () => {
    const db: DbFile = {
      ...SAMPLE,
      views: [
        { id: 'v1', name: '表格', type: 'table' },
        { id: 'v2', name: '按状态', type: 'kanban', groupBy: 'c7' },
        { id: 'v3', name: '排期', type: 'calendar', dateCol: 'c5' },
        { id: 'v4', name: '将来的类型', type: 'timeline' }, // 未知类型:结构放行,渲染端回退表格
      ],
    }
    const r = parseDb(serializeDb(db))
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.data).toEqual(db)
    // 旧文件(无 views)向后兼容
    const legacy = parseDb(serializeDb(SAMPLE))
    expect(legacy.ok).toBe(true)
    if (legacy.ok) expect(legacy.data.views).toBeUndefined()
    // 空视图 id 是坏数据
    const bad = { ...SAMPLE, views: [{ id: '', name: 'x', type: 'table' }] }
    expect(parseDb(JSON.stringify(bad)).ok).toBe(false)
  })

  it('公式/关联表/引用列配置与 filterMode/sorts 往返无损(2.8 新字段)', () => {
    const db: DbFile = {
      ...SAMPLE,
      columns: [
        ...SAMPLE.columns,
        { id: 'f1', name: '小计', type: 'formula', formula: '{单价}*{数量}' },
        { id: 'l1', name: '项目', type: 'rowlink', refDb: '项目.db' },
        { id: 'k1', name: '项目状态', type: 'lookup', lookupRel: 'l1', lookupCol: 'st', lookupAgg: 'join' },
      ],
      views: [
        {
          id: 'v1', name: '表格', type: 'table',
          filters: [{ colId: 'c1', op: 'notempty' }], filterMode: 'or',
          sort: { colId: 'c1', dir: 'asc' },
          sorts: [{ colId: 'c1', dir: 'asc' }, { colId: 'f1', dir: 'desc' }],
        },
      ],
    }
    const r = parseDb(serializeDb(db))
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.data).toEqual(db)
  })

  it('multiple / lookupBackCol / prefix 三个新字段 parse 后还在(zod 默认 strip,漏一处=保存即丢)', () => {
    const db: DbFile = {
      ...SAMPLE,
      columns: [
        ...SAMPLE.columns,
        { id: 'l1', name: '配件', type: 'rowlink', refDb: '配件.db', multiple: true },
        { id: 'k1', name: '出库行', type: 'lookup', refDb: '出库.db', lookupBackCol: 'ord', lookupCol: 'n', lookupAgg: 'join' },
        { id: 'a1', name: '订单号', type: 'autonumber', prefix: 'PC-' },
      ],
      rows: [{ id: 'r1', cells: { l1: ['p1', 'p2'], a1: 7 } }],
    }
    const r = parseDb(serializeDb(db))
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.data).toEqual(db)
      // 逐字段点名,别只靠 toEqual(报错时一眼看出哪个被剥了)
      expect(r.data.columns[7].multiple).toBe(true)
      expect(r.data.columns[8].lookupBackCol).toBe('ord')
      expect(r.data.columns[9].prefix).toBe('PC-')
      expect(r.data.rows[0].cells.l1).toEqual(['p1', 'p2'])
    }
    // 类型错的值是坏数据(multiple 必须是布尔)
    const bad = { ...SAMPLE, columns: [{ id: 'c1', name: 'x', type: 'rowlink', multiple: 'yes' }] }
    expect(parseDb(JSON.stringify(bad)).ok).toBe(false)
  })

  it('lookupKind(可编辑投影列)往返无损;只认 links(别的串是坏数据,不是被静默剥掉)', () => {
    const db: DbFile = {
      ...SAMPLE,
      columns: [...SAMPLE.columns, { id: 'k1', name: '出库(投影)', type: 'lookup', refDb: '出库.db', lookupBackCol: 'ord', lookupKind: 'links' }],
    }
    const r = parseDb(serializeDb(db))
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.data).toEqual(db)
      expect(r.data.columns[7].lookupKind).toBe('links')
    }
    const bad = { ...SAMPLE, columns: [{ id: 'c1', name: 'x', type: 'lookup', lookupKind: 'mirror' }] }
    expect(parseDb(JSON.stringify(bad)).ok).toBe(false)
  })

  it('titleCol / refFilter / refFilterMode(关联芯片显示列 + 候选限定)往返无损;refFilterMode 只认 and/or', () => {
    const db: DbFile = {
      ...SAMPLE,
      columns: [
        ...SAMPLE.columns,
        {
          id: 'l1', name: 'CPU', type: 'rowlink', refDb: '库存表.db', titleCol: 's_name',
          refFilter: [{ colId: 's_type', op: 'eq', value: 'cpu' }, { colId: 's_qty', op: 'notempty' }],
          refFilterMode: 'or',
        },
      ],
    }
    const r = parseDb(serializeDb(db))
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.data).toEqual(db)
      expect(r.data.columns[7].titleCol).toBe('s_name')
      expect(r.data.columns[7].refFilter).toEqual(db.columns[7].refFilter)
      expect(r.data.columns[7].refFilterMode).toBe('or')
    }
    // 负对照:refFilterMode 不在 and/or 里、refFilter 条件缺 op 都是坏数据(不是被静默剥掉)
    const badMode = { ...SAMPLE, columns: [{ id: 'c1', name: 'x', type: 'rowlink', refFilterMode: 'xor' }] }
    expect(parseDb(JSON.stringify(badMode)).ok).toBe(false)
    const badFilter = { ...SAMPLE, columns: [{ id: 'c1', name: 'x', type: 'rowlink', refFilter: [{ colId: 's_type' }] }] }
    expect(parseDb(JSON.stringify(badFilter)).ok).toBe(false)
  })
  it('views[].form(表单视图嵌套配置)往返无损;after 只认 stay/table;旧文件缺 form 照常', () => {
    const db: DbFile = {
      ...SAMPLE,
      views: [{
        id: 'vf', name: '下单表单', type: 'form',
        form: { required: ['c1', 'c7'], defaults: { c7: '进行中', c2: false, c3: ['红'], c6: 0 }, desc: { c1: '写清楚' }, title: '新任务', submitText: '提交任务', after: 'table' },
      }],
    }
    const r = parseDb(serializeDb(db))
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.data.views?.[0].form).toEqual(db.views![0].form)
      expect(serializeDb(r.data)).toBe(serializeDb(db))
    }
    // 负对照:after 不在 stay/table 里、defaults 含 undefined 以外的非法值(对象)都是坏数据,不是被静默剥掉
    const badAfter = { ...SAMPLE, views: [{ id: 'vf', name: 'x', type: 'form', form: { after: 'later' } }] }
    expect(parseDb(JSON.stringify(badAfter)).ok).toBe(false)
    const badDefault = { ...SAMPLE, views: [{ id: 'vf', name: 'x', type: 'form', form: { defaults: { c1: { nested: 1 } } } }] }
    expect(parseDb(JSON.stringify(badDefault)).ok).toBe(false)
    // form 缺 → 仍是合法视图(旧文件 / 非表单视图)
    expect(parseDb(serializeDb({ ...SAMPLE, views: [{ id: 'v', name: 'x', type: 'form' }] })).ok).toBe(true)
  })
  it('views[].gantt(甘特视图嵌套配置)往返无损;scale 只认 day/week;旧文件缺 gantt 照常', () => {
    const db: DbFile = {
      ...SAMPLE,
      views: [{ id: 'vg', name: '排期', type: 'gantt', gantt: { startCol: 'c5', endCol: 'c5', scale: 'week' } }],
    }
    const r = parseDb(serializeDb(db))
    expect(r.ok).toBe(true)
    if (r.ok) {
      // 逐字段点名:zod strip 漏一处时 toEqual 报「少了一个键」不如这里一眼看出是哪个
      expect(r.data.views?.[0].gantt?.startCol).toBe('c5')
      expect(r.data.views?.[0].gantt?.endCol).toBe('c5')
      expect(r.data.views?.[0].gantt?.scale).toBe('week')
      expect(serializeDb(r.data)).toBe(serializeDb(db))
    }
    // 负对照:scale 不在 day/week 里是坏数据,不是被静默剥掉
    const badScale = { ...SAMPLE, views: [{ id: 'vg', name: 'x', type: 'gantt', gantt: { scale: 'month' } }] }
    expect(parseDb(JSON.stringify(badScale)).ok).toBe(false)
    // gantt 缺 → 仍是合法视图(旧文件 / 渲染端缺省挑第一个 calendarDate 列)
    expect(parseDb(serializeDb({ ...SAMPLE, views: [{ id: 'v', name: 'x', type: 'gantt' }] })).ok).toBe(true)
  })
  it('views[].order / widths(每视图列序 / 列宽)往返无损;widths 只收正数;`{}` 是合法的开了没拖过态', () => {
    const db: DbFile = {
      ...SAMPLE,
      views: [
        { id: 'v1', name: '表格', type: 'table', order: ['c7', 'c2', 'gone'], widths: { c2: 120, c7: 300.5 } },
        { id: 'v2', name: '空开关', type: 'table', order: [], widths: {} },
      ],
    }
    const r = parseDb(serializeDb(db))
    expect(r.ok).toBe(true)
    if (r.ok) {
      // 逐字段点名:zod strip 漏一处时 toEqual 报「少了一个键」不如这里一眼看出是哪个
      expect(r.data.views?.[0].order).toEqual(['c7', 'c2', 'gone'])
      expect(r.data.views?.[0].widths).toEqual({ c2: 120, c7: 300.5 })
      expect(r.data.views?.[1].order).toEqual([])
      expect(r.data.views?.[1].widths).toEqual({})
      expect(serializeDb(r.data)).toBe(serializeDb(db))
    }
    // 负对照:非正宽 / order 不是字符串数组都是坏数据,不是被静默剥掉
    expect(parseDb(JSON.stringify({ ...SAMPLE, views: [{ id: 'v', name: 'x', type: 'table', widths: { c2: 0 } }] })).ok).toBe(false)
    expect(parseDb(JSON.stringify({ ...SAMPLE, views: [{ id: 'v', name: 'x', type: 'table', widths: { c2: -5 } }] })).ok).toBe(false)
    expect(parseDb(JSON.stringify({ ...SAMPLE, views: [{ id: 'v', name: 'x', type: 'table', order: [1, 2] }] })).ok).toBe(false)
    // 两字段缺 → 仍是合法视图(旧文件 / 未开独立列序的视图)
    expect(parseDb(serializeDb({ ...SAMPLE, views: [{ id: 'v', name: 'x', type: 'table' }] })).ok).toBe(true)
  })

  it('views[].treeCol / groupUnit(表格层级树 + 日期分组档位)往返无损;groupUnit 只认 day/month;旧文件缺两者照常', () => {
    const db: DbFile = {
      ...SAMPLE,
      views: [
        { id: 'vt', name: '层级', type: 'table', treeCol: 'c9' },
        { id: 'vd', name: '按月', type: 'table', groupBy: 'c5', groupUnit: 'month' },
      ],
    }
    const r = parseDb(serializeDb(db))
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.data.views?.[0].treeCol).toBe('c9')
      expect(r.data.views?.[1].groupUnit).toBe('month')
      expect(r.data.views?.[1].groupBy).toBe('c5') // 分组列与档位是两个字段,别互相冲掉
      expect(serializeDb(r.data)).toBe(serializeDb(db))
    }
    // 负对照:groupUnit 只有两档,'year' 是坏数据而不是被静默剥掉(剥掉 = 用户选的档位保存即丢)
    expect(parseDb(JSON.stringify({ ...SAMPLE, views: [{ id: 'v', name: 'x', type: 'table', groupUnit: 'year' }] })).ok).toBe(false)
    expect(parseDb(JSON.stringify({ ...SAMPLE, views: [{ id: 'v', name: 'x', type: 'table', treeCol: 7 }] })).ok).toBe(false)
    // 两字段缺 → 仍是合法视图(旧文件 / 平铺表格)
    expect(parseDb(serializeDb({ ...SAMPLE, views: [{ id: 'v', name: 'x', type: 'table' }] })).ok).toBe(true)
  })
  it('precision / unitPrefix / unitSuffix(数字显示格式)往返无损;precision 只收 0-6 的整数(zod strip 漏一处 = 用户配的格式保存即丢)', () => {
    const db: DbFile = {
      ...SAMPLE,
      columns: SAMPLE.columns.map((c) => (c.id === 'c6' ? { ...c, precision: 2, unitPrefix: '¥', unitSuffix: '元' } : c)),
    }
    const r = parseDb(serializeDb(db))
    expect(r.ok).toBe(true)
    if (r.ok) {
      const c = r.data.columns.find((x) => x.id === 'c6')
      // 逐字段点名:zod strip 漏一个时,一眼看出是哪个
      expect(c?.precision).toBe(2)
      expect(c?.unitPrefix).toBe('¥')
      expect(c?.unitSuffix).toBe('元')
      expect(r.data.rows[0].cells.c6).toBe(3) // ⚠️ 格式是显示层的事:落盘 cell 仍是裸数字 3,不是「¥3.00元」
      expect(serializeDb(r.data)).toBe(serializeDb(db))
    }
    // 负对照:越界/小数/非数一律拒读,而不是被静默剥掉(剥掉 = 用户配的小数位保存即丢,零报错)
    const withPrec = (v: unknown) => JSON.stringify({ ...SAMPLE, columns: [{ id: 'c1', name: 'x', type: 'number', precision: v }] })
    expect(parseDb(withPrec(7)).ok).toBe(false)
    expect(parseDb(withPrec(-1)).ok).toBe(false)
    expect(parseDb(withPrec(1.5)).ok).toBe(false)
    expect(parseDb(withPrec('2')).ok).toBe(false)
    expect(parseDb(withPrec(0)).ok).toBe(true) // 0 位小数是合法配置,不是「没配」
    // 三字段全缺 → 旧文件照常(零迁移)
    expect(parseDb(serializeDb(SAMPLE)).ok).toBe(true)
  })

  it('附件列 cell 两形态(旧单值 string / 新多附件 string[])都读得进,且都不被改写', () => {
    const db: DbFile = {
      ...SAMPLE,
      columns: [...SAMPLE.columns, { id: 'c8', name: '附件', type: 'file' }],
      rows: [
        { id: 'r1', cells: { c8: '.amadeus/a.png' } },                    // 旧:单值
        { id: 'r2', cells: { c8: ['.amadeus/a.png', '.amadeus/b.pdf'] } }, // 新:多值
        { id: 'r3', cells: {} },                                           // 空:缺键
      ],
    }
    const r = parseDb(serializeDb(db))
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.data.rows[0].cells.c8).toBe('.amadeus/a.png')
      expect(r.data.rows[1].cells.c8).toEqual(['.amadeus/a.png', '.amadeus/b.pdf'])
      expect(r.data.rows[2].cells.c8).toBeUndefined()
      expect(serializeDb(r.data)).toBe(serializeDb(db)) // 旧单值不被升格成数组
    }
  })
})
