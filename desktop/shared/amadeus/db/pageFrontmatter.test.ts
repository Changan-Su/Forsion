import { describe, it, expect } from 'vitest'
import {
  setFmExtraOnSource,
  patchFmExtraText,
  parseFmObject,
  inferColumnType,
  fmValueToCell,
  cellToFmValue,
  deriveColumns,
} from './pageFrontmatter'
import { PAGE_NAME_KEY } from './schema'
import { parse as parseYaml } from 'yaml'

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

  // D-01:文件头 BOM。修前 FM_BLOCK_RE 认不出 → 在 `BOM---…` 前面再叠一个新 fm 块,旧块沦为正文。
  it('BOM + fm:改的是原来那一块,BOM 留在字节 0,不叠第二个块', () => {
    const src = '\uFEFF---\ntags: [a]\n---\n\nbody\n'
    const out = setFmExtraOnSource(src, { status: 'todo' })
    expect(out.startsWith('\uFEFF---\n')).toBe(true)
    expect(out.slice(1).match(/^---$/gm)).toHaveLength(2)
    expect(out).toContain('tags:')
    expect(out).toContain('status: todo')
    expect(out.endsWith('\n\nbody\n')).toBe(true)
    // 删空 → 块消失、BOM 仍在字节 0
    expect(setFmExtraOnSource('\uFEFF---\nx: 1\n---\nbody\n', { x: undefined })).toBe('\uFEFFbody\n')
  })

  // V-01:块状写法的结构键。修前逐行分:键行进保留区、缩进续行进外来区 → 外来 YAML 解析失败折成 {} →
  // 改一个单元格就同时抹掉画布几何(只剩 `amadeus_canvas:` 空键)与全部外来键。
  it('块状 amadeus_canvas 整组留在保留区,外来键照常合并,结果仍是合法 YAML', () => {
    const src = [
      '---', 'amadeus_schema: amadeus.page/4', 'amadeus_canvas:', '  v: 1', '  cards:', '    - ref: k1', '      x: 480',
      'tags:', '  - a', 'status: todo', '---', '', 'body', '',
    ].join('\n')
    const out = setFmExtraOnSource(src, { status: 'done' })
    expect(out).toContain('amadeus_canvas:\n  v: 1\n  cards:\n    - ref: k1\n      x: 480\n')
    const fm = parseYaml(/^---\n([\s\S]*?)\n---\n/.exec(out)![1])
    expect(fm).toMatchObject({ amadeus_canvas: { v: 1, cards: [{ ref: 'k1', x: 480 }] }, tags: ['a'], status: 'done' })
    expect(out.endsWith('\n\nbody\n')).toBe(true)
  })

  it('BOM 无 fm:新块生在 BOM 之后', () => {
    const out = setFmExtraOnSource('\uFEFF# T\n', { status: 'todo' })
    expect(out).toBe('\uFEFF---\nstatus: todo\n---\n\n# T\n')
  })
})

describe('patchFmExtraText(内存 fmExtra 路径)', () => {
  it('空文本 + 增键;undefined 删键;删空返回 ""', () => {
    expect(patchFmExtraText('', { children: ['a.md'] })).toBe('children:\n  - a.md')
    expect(patchFmExtraText('children:\n  - a.md\ntag: x', { children: undefined })).toBe('tag: x')
    expect(patchFmExtraText('children:\n  - a.md', { children: undefined })).toBe('')
  })

  it('非空但坏 YAML → null 拒改(守住用户手写内容)', () => {
    expect(patchFmExtraText('foo: [broken', { children: ['a.md'] })).toBeNull()
    expect(patchFmExtraText('- 顶层是数组', { children: ['a.md'] })).toBeNull()
  })

  it('amadeus_* 保留键不被 patch 劫持', () => {
    expect(patchFmExtraText('tag: x', { amadeus_layout: 'evil', children: ['a.md'] })).toBe(
      'tag: x\nchildren:\n  - a.md',
    )
  })
})

// 从产物里抠出外来 frontmatter 段(去掉 --- 与 amadeus_* 行)喂给 parseFmObject 做往返校验
function parseFmObjectFixture(md: string): string {
  const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(md)
  if (!m) return ''
  return m[1]
    .split('\n')
    .filter((l) => !/^(amadeus_page|amadeus_schema|amadeus_layout|amadeus_next_id):/.test(l))
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
