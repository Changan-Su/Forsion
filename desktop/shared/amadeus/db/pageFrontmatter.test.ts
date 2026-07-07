import { describe, it, expect } from 'vitest'
import {
  setFmExtraOnSource,
  parseFmObject,
  inferColumnType,
  fmValueToCell,
  cellToFmValue,
  deriveColumns,
} from './pageFrontmatter'
import { PAGE_NAME_KEY } from './schema'

const V3 =
  '---\namadeus_page: pg_x\namadeus_schema: amadeus.page/3\namadeus_layout: {"type":"stack","children":[]}\n---\n\n<!-- a 1 -->\n\n# Hello\n'

describe('setFmExtraOnSource', () => {
  it('adds foreign keys, preserving amadeus_* lines verbatim and body', () => {
    const out = setFmExtraOnSource(V3, { status: 'todo', done: true })
    expect(out).toContain('amadeus_page: pg_x')
    // 关键:amadeus_layout 的单行 JSON 未被 YAML 往返重排/破坏
    expect(out).toContain('amadeus_layout: {"type":"stack","children":[]}')
    expect(out).toContain('status: todo')
    expect(out).toContain('done: true')
    expect(out).toContain('<!-- a 1 -->')
    expect(out).toContain('# Hello')
  })

  it('merges into existing foreign frontmatter and deletes on undefined', () => {
    const src =
      '---\namadeus_page: pg_y\namadeus_schema: amadeus.page/3\namadeus_layout: {"type":"stack","children":[]}\ntags:\n  - a\n  - b\nold: keep\n---\n\nbody\n'
    const out = setFmExtraOnSource(src, { old: undefined, status: 'done' })
    expect(out).not.toContain('old: keep')
    expect(out).toContain('status: done')
    expect(out).toContain('tags:') // 现存外来键保留
    expect(out).toContain('amadeus_layout: {"type":"stack","children":[]}')
    expect(out).toContain('body')
  })

  it('prepends a frontmatter block to a note that has none', () => {
    const out = setFmExtraOnSource('# Just markdown\n', { status: 'todo' })
    expect(out.startsWith('---\n')).toBe(true)
    expect(out).toContain('status: todo')
    expect(out).toContain('# Just markdown')
  })

  it('never lets a column named amadeus_layout hijack the reserved key', () => {
    const out = setFmExtraOnSource(V3, { amadeus_layout: 'HIJACK' })
    expect(out).not.toContain('HIJACK')
    expect(out).toContain('amadeus_layout: {"type":"stack","children":[]}')
  })

  it('round-trips a date string without quoting damage', () => {
    const out = setFmExtraOnSource(V3, { due: '2026-07-05' })
    expect(out).toMatch(/due:\s*"?2026-07-05"?/)
    expect(parseFmObject(parseFmObjectFixture(out))['due']).toBe('2026-07-05')
  })
})

// 从产物里抠出外来 frontmatter 段(去掉 --- 与 amadeus_* 行)喂给 parseFmObject 做往返校验
function parseFmObjectFixture(md: string): string {
  const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(md)
  if (!m) return ''
  return m[1]
    .split('\n')
    .filter((l) => !/^(amadeus_page|amadeus_schema|amadeus_layout):/.test(l))
    .join('\n')
}

describe('type mapping', () => {
  it('infers column types from values', () => {
    expect(inferColumnType(true)).toBe('checkbox')
    expect(inferColumnType(['x'])).toBe('multiselect')
    expect(inferColumnType(3)).toBe('number')
    expect(inferColumnType('2026-07-05')).toBe('date')
    expect(inferColumnType('hello')).toBe('text')
  })

  it('cellToFmValue omits empties (缺 key = 空)', () => {
    expect(cellToFmValue('', 'text')).toBeUndefined()
    expect(cellToFmValue(false, 'checkbox')).toBeUndefined()
    expect(cellToFmValue([], 'multiselect')).toBeUndefined()
    expect(cellToFmValue('todo', 'select')).toBe('todo')
    expect(cellToFmValue(true, 'checkbox')).toBe(true)
    expect(cellToFmValue(['a', 'b'], 'multiselect')).toEqual(['a', 'b'])
  })

  it('fmValueToCell coerces per type', () => {
    expect(fmValueToCell(true, 'checkbox')).toBe(true)
    expect(fmValueToCell('x', 'multiselect')).toEqual(['x'])
    expect(fmValueToCell(['x', 'y'], 'multiselect')).toEqual(['x', 'y'])
    expect(fmValueToCell(3, 'number')).toBe(3)
    expect(fmValueToCell('2026-07-05', 'date')).toBe('2026-07-05')
  })
})

describe('deriveColumns (并集列)', () => {
  it('always includes Page Name, unions unknown keys, infers types, seeds option pools', () => {
    const cols = deriveColumns([], [
      { status: 'todo', done: false, tags: ['a', 'b'] },
      { status: 'doing', due: '2026-07-05', tags: ['b', 'c'] },
    ])
    expect(cols[0]).toMatchObject({ id: PAGE_NAME_KEY, type: 'page' })
    const byId = Object.fromEntries(cols.map((c) => [c.id, c]))
    expect(byId['status'].type).toBe('text')
    expect(byId['done'].type).toBe('checkbox')
    expect(byId['tags'].type).toBe('multiselect')
    expect(byId['due'].type).toBe('date')
    expect(byId['tags'].options?.sort()).toEqual(['a', 'b', 'c'])
  })

  it('keeps existing columns and does not duplicate', () => {
    const existing = deriveColumns([], [{ status: 'x' }])
    const again = deriveColumns(existing, [{ status: 'y', extra: 1 }])
    expect(again.filter((c) => c.id === 'status')).toHaveLength(1)
    expect(again.some((c) => c.id === 'extra')).toBe(true)
  })
})
