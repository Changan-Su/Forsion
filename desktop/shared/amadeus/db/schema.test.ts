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

  it('emptyDb 种子:1 文本列 + 1 空行,当前版本号', () => {
    const db = emptyDb('未命名数据库')
    expect(db.version).toBe(DB_VERSION)
    expect(db.name).toBe('未命名数据库')
    expect(db.columns).toHaveLength(1)
    expect(db.columns[0].type).toBe('text')
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
})
