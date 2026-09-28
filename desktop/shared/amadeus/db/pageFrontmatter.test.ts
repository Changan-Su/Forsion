import { describe, it, expect } from 'vitest'
import {
  setFmExtraOnSource,
  patchFmExtraText,
  patchYamlText,
  renameYamlKey,
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

// D-20(评审 2026-09-27 P1):属性面板 / 封面 / 图标写 fm 时整块 parse→stringify,改一个键就把别的键改值
// (`007`→`7`、`1.10`→`1.1`、20 位整数丢精度、`0x1F`→`31`)、注释丢光、flow 改块状。现在只重写被改的那个条目。
// 真浏览器那一半:评审探针 verify-integrity-4/props.cjs、cover.cjs。
// 负对照:setFmExtraOnSource / patchYamlText 换回整块 stringify → 本组红。
describe('行级改写:只动被改的那个键(D-20)', () => {
  const FM = [
    'title: "Hello: world"',
    '# my comment',
    'tags: [alpha, beta]',
    'desc: |',
    '  multi',
    '  line',
    'zip: 007',
    'version: 1.10',
    'big: 12345678901234567890',
    'hex: 0x1F',
    'empty:',
    "quoted: 'single'",
  ].join('\n')

  it('改一个键:其余行(注释、007、1.10、大整数、0x1F、多行块、flow)逐字', () => {
    const out = patchYamlText(FM, { quoted: 'changed' })!
    expect(out).toBe(FM.replace("quoted: 'single'", 'quoted: changed'))
  })

  it('删键摘整条目(连同续行);加键追加在末尾', () => {
    expect(patchYamlText(FM, { desc: undefined })).toBe(FM.replace('desc: |\n  multi\n  line\n', ''))
    expect(patchYamlText(FM, { status: 'todo' })).toBe(`${FM}\nstatus: todo`)
  })

  it('flow 写法的数组改完仍是 flow;多行字符串改完仍是块状', () => {
    expect(patchYamlText(FM, { tags: ['alpha', 'gamma'] })).toBe(FM.replace('tags: [alpha, beta]', 'tags: [alpha, gamma]'))
    expect(patchYamlText(FM, { desc: 'multi\nline 2\n' })).toBe(FM.replace('desc: |\n  multi\n  line', 'desc: |\n  multi\n  line 2'))
  })

  it('新值与现值相同 → 整条逐字(`zip: 007` 设成 7 仍是 007)', () => {
    expect(patchYamlText(FM, { zip: 7, version: 1.1 })).toBe(FM)
  })

  it('改键名:只换键 token,值原文逐字、位置不动;带引号的键沿用引号', () => {
    expect(renameYamlKey(FM, 'zip', 'postcode')).toBe(FM.replace('zip: 007', 'postcode: 007'))
    expect(patchYamlText('"a b": 1\nc: 2', { 'a b': 3 })).toBe('"a b": 3\nc: 2')
  })

  it('CRLF 原文:改动行也用 CRLF,结尾换行照旧', () => {
    const crlf = 'a: 007\r\nb: x\r\n'
    expect(patchYamlText(crlf, { b: 'y' })).toBe('a: 007\r\nb: y\r\n')
    expect(patchYamlText(crlf, { c: 1 })).toBe('a: 007\r\nb: x\r\nc: 1\r\n')
  })

  it('认不出的键写法恰好就是要改的键 → 核对不过,退回整块重排(语义对,不写出重复键)', () => {
    const out = patchYamlText('? k\n: 1\nz: 2', { k: 5 })!
    expect(parseYaml(out)).toEqual({ k: 5, z: 2 })
  })

  it('setFmExtraOnSource(封面 / 图标 / 多维表单元格):栅栏、保留行、别的键、正文逐字', () => {
    const src = `---\namadeus_schema: amadeus.page/4\n${FM}\n---\n\nbody\n`
    expect(setFmExtraOnSource(src, { cover: 'https://x/y.jpg' })).toBe(`---\namadeus_schema: amadeus.page/4\n${FM}\ncover: https://x/y.jpg\n---\n\nbody\n`)
    const crlf = '---\r\nzip: 007\r\n---\r\nbody\r\n'
    expect(setFmExtraOnSource(crlf, { icon: 'x' })).toBe('---\r\nzip: 007\r\nicon: x\r\n---\r\nbody\r\n')
  })

  it('setFmExtraOnSource 行级核对不过 → 退回「保留行原样 + 外来区重排」,绝不整块重排(布局 JSON 不过 YAML 往返)', () => {
    const src = '---\namadeus_layout: {"type":"stack","children":[]}\n? icon\n: old\n---\nbody\n'
    const out = setFmExtraOnSource(src, { icon: 'new' })
    expect(out).toContain('amadeus_layout: {"type":"stack","children":[]}\n')
    expect(parseYaml(/^---\n([\s\S]*?)---\n/.exec(out)![1])).toEqual({ amadeus_layout: { type: 'stack', children: [] }, icon: 'new' })
    expect(out.endsWith('---\nbody\n')).toBe(true)
  })

  it('setFmExtraOnSource 在本就解析不了的 fm 上:只动被改的条目,别的行一概不碰(旧版折成 {} 抹光外来键)', () => {
    const broken = '---\ntitle: "未闭合\nrank: [1, 2\n---\nbody\n'
    expect(setFmExtraOnSource(broken, { status: 'done' })).toBe('---\ntitle: "未闭合\nrank: [1, 2\nstatus: done\n---\nbody\n')
  })
})
