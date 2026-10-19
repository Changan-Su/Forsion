import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { parseUIDraft, validateUIDocument, type UIDocument } from './intelligentUi.js'
import { applyUISteps, compileExpr, documentEnv, evaluate, uiDocumentIssues, uiTableRows, uiText, type UIValue } from './intelligentUiExpr.js'
// 画廊:手写的 v2 文档,一份三用 —— 这里当校验器单测,技能里的例子照它写,desktop 的回放台架拿它截图。
const gallery: Record<string, UIDocument> = JSON.parse(readFileSync(new URL('../../../desktop/scripts/fixtures/intelligent-ui-gallery.json', import.meta.url), 'utf8'))
const loan = () => structuredClone(gallery.loan) as unknown as Record<string, any>

const run = (src: string, names: Record<string, UIValue> = {}, inputs: Record<string, string | number> = {}): UIValue => {
  const env = documentEnv({ inputs: Object.keys(inputs).map(id => ({ id, kind: 'number', label: id, initial: 0, min: 0, max: 1, step: 1 })), state: Object.entries(names).map(([id, initial]) => ({ id, initial })), derived: [] }, inputs, new Map(Object.entries(names)), 'zh')
  const c = env.cell(src)
  if (!c.ok) throw new Error(c.error)
  return c.value
}

describe('Intelligent UI v2 gallery', () => {
  it('every gallery document validates and shows no failed value at its initial values', () => {
    for (const [name, doc] of Object.entries(gallery)) {
      const parsed = validateUIDocument(doc)
      expect(parsed.version, name).toBe(2)
      expect(uiDocumentIssues(parsed, 'zh'), name).toEqual([])
      expect(uiDocumentIssues(parsed, 'en'), name).toEqual([])
    }
  })
  it('computes the mortgage the plan page shows, and follows the inputs', () => {
    const doc = validateUIDocument(gallery.loan)
    const env = (inputs: Record<string, number>) => documentEnv(doc, inputs, new Map(), 'zh')
    const a = env({ loan: 120, rate: 3.2, years: 30 })
    expect(a.text("format(pay, 'number', 0)")).toBe('5,190')
    expect(a.text("format(interest, 'wan', 1)")).toBe('66.8 万')
    const rows = uiTableRows(a.cell((doc.blocks[3] as { rows: string }).rows).ok ? (a.cell((doc.blocks[3] as { rows: string }).rows) as { value: UIValue }).value : null, 2)
    expect(rows.map(r => r[1])).toEqual(['107.1 万', '91.9 万', '74.1 万', '53.2 万', '28.7 万', '0.0 万'])
    const b = env({ loan: 100, rate: 3, years: 25 })
    expect(b.text("format(pay, 'number', 0)")).toBe('4,742')
    expect(b.slots('每月 {{format(pay, \'number\', 0)}} 元，{{ nope }}')).toEqual({ markdown: '每月 \uE0000\uE001 元，\uE0001\uE001', values: ['4,742', '—'] })
    expect(documentEnv(doc, { loan: 120, rate: 3.2, years: 30 }, new Map(), 'en').text("format(interest, 'wan', 1)")).toBe('668.3K')
  })
  it('runs the flashcard buttons as ordered, all-or-nothing state changes', () => {
    const doc = validateUIDocument(gallery.vocab)
    let vars = new Map((doc.state || []).map(s => [s.id, s.initial]))
    const know = doc.blocks.flatMap(b => b.kind === 'actions' ? b.items : []).find(a => a.id === 'know')!
    if (know.kind !== 'set') throw new Error('expected a set action')
    vars = applyUISteps(doc, know.steps, {}, vars, 'zh')
    vars = applyUISteps(doc, know.steps, {}, vars, 'zh')
    expect(vars.get('known')).toEqual(['abate', 'aberrant'])
    expect(vars.get('i')).toBe(2)
    const env = documentEnv(doc, {}, vars, 'zh')
    expect(env.text('w.word')).toBe('abscond')
    // 背完以后 w 是 null:再点会在第一步失败,整组不落地
    const done = new Map(vars).set('i', 10)
    expect(() => applyUISteps(doc, know.steps, {}, done, 'zh')).toThrow()
  })
  it('streams a v2 document block by block without committing a partial one', () => {
    const full = JSON.stringify(gallery.loan)
    let count = 0
    for (let i = 1; i <= full.length; i++) {
      const parsed = parseUIDraft(full.slice(0, i))
      if (!parsed) continue
      expect(parsed.blocks.length).toBeGreaterThanOrEqual(count)
      count = parsed.blocks.length
    }
    expect(count).toBe(gallery.loan.blocks.length)
  })
})

describe('Intelligent UI skill examples', () => {
  it('every JSON example in the skill validates, and the v2 example is the gallery card', () => {
    const skill = readFileSync(new URL('../../skills/intelligent-ui/SKILL.md', import.meta.url), 'utf8')
    const examples = [...skill.matchAll(/```json\n([\s\S]*?)\n```/g)].map(m => JSON.parse(m[1]))
    expect(examples.length).toBeGreaterThanOrEqual(2)
    for (const doc of examples) expect(uiDocumentIssues(validateUIDocument(doc), 'zh')).toEqual([])
    expect(examples).toContainEqual(gallery.loan)
  })
})

describe('Intelligent UI v2 validation', () => {
  it('reads version 2 only where the client renders it', () => {
    expect(() => validateUIDocument(gallery.loan, { maxVersion: 1 })).toThrow('version 1 only')
  })
  it('names unknown functions, names and inputs, and wrong argument counts, so the model can correct them', () => {
    const cases: [string, string][] = [['foo(1)', 'unknown function foo()'], ['pay2 + 1', 'unknown name pay2'], ['$nope', 'unknown name nope'], ['round()', 'round() takes 1-2 arguments'], ['format', 'is a function']]
    for (const [src, message] of cases) {
      const doc = loan(); doc.blocks[2].items[0].value = src
      expect(() => validateUIDocument(doc), src).toThrow(message)
    }
  })
  it('lets derived values read only earlier names, keeps names unique and off keywords', () => {
    let doc = loan(); doc.derived[0].expr = 'pay * 2'
    expect(() => validateUIDocument(doc)).toThrow('unknown name pay')
    doc = loan(); doc.state = [{ id: 'and', initial: 1 }]
    expect(() => validateUIDocument(doc)).toThrow('"and" is a keyword')
    doc = loan(); doc.state = [{ id: 'loan', initial: 1 }]
    expect(() => validateUIDocument(doc)).toThrow('"loan" is already declared')
    doc = loan(); doc.derived[1].id = 'p'
    expect(() => validateUIDocument(doc)).toThrow('"p" is already declared')
  })
  it('reads $name and name alike, and lets a value share a function name (live 10-20 habits)', () => {
    const doc = loan()
    doc.derived = [{ id: 'months', expr: '$years * 12' }, { id: 'monthly_rate', expr: '$rate / 1200' }, { id: 'payment', expr: 'payment($monthly_rate, $months, $loan * 10000)' }]
    doc.blocks = [doc.blocks[1], { id: 's', kind: 'stats', items: [{ label: '月供', value: "format($payment, 'number', 0)" }, { label: '月数', value: 'months' }] }]
    const parsed = validateUIDocument(doc)
    expect(documentEnv(parsed, { loan: 120, rate: 3.2, years: 30 }, new Map(), 'zh').text("format(payment, 'number', 0)")).toBe('5,190')
  })
  it('takes a plain JSON value as an expression, and {{ }} text as a stats value (live 10-20 habits)', () => {
    const doc = structuredClone(gallery.vocab) as unknown as Record<string, any>
    doc.blocks[5].items[2].steps = [{ set: 'i', to: 0 }, { set: 'known', to: [] }]
    doc.blocks[4].items[0].value = '{{count(known)}} 个'
    const parsed = validateUIDocument(doc)
    const restart = parsed.blocks.flatMap(b => b.kind === 'actions' ? b.items : []).find(a => a.id === 'restart')!
    expect(restart.kind === 'set' && restart.steps).toEqual([{ set: 'i', to: '0' }, { set: 'known', to: '[]' }])
    expect(documentEnv(parsed, {}, new Map((parsed.state || []).map(s => [s.id, s.initial])), 'zh').text('{{count(known)}} 个')).toBe('0 个')
    expect(uiDocumentIssues(parsed)).toEqual([])
  })
  it('points long data in an expression to state', () => {
    const doc = loan(); doc.derived[0].expr = `[${Array.from({ length: 60 }, (_, i) => `'w${i}'`).join(',')}]`
    expect(() => validateUIDocument(doc)).toThrow("put data such as word lists, steps or rows in a state value's initial")
  })
  it('keeps controls always visible, also against expression conditions', () => {
    const doc = loan(); doc.blocks[1].when = { expr: 'true' }
    expect(() => validateUIDocument(doc)).toThrow('controls must remain visible')
  })
  it('reads a version 1 document with version 2 parts as version 2 only where 2 is allowed', () => {
    const doc = loan(); doc.version = 1
    expect(validateUIDocument(doc).version).toBe(2)
    expect(() => validateUIDocument(doc, { maxVersion: 1 })).toThrow('unknown block kind "stats"')
    delete doc.state; delete doc.derived; doc.blocks = [doc.blocks[1], { id: 's', kind: 'stats', items: [{ label: 'x', value: '$loan' }] }]
    expect(validateUIDocument(doc).version).toBe(2)
    expect(() => validateUIDocument(doc, { maxVersion: 1 })).toThrow('unknown block kind "stats"')
  })
  it('bounds expression size, loop nesting and set-step targets', () => {
    let doc = loan(); doc.derived[3].expr = 'payment(r, n, p)' + ' + 0'.repeat(80)
    expect(() => validateUIDocument(doc)).toThrow('longer than 300 characters')
    doc = loan(); doc.blocks[3].rows = "each([1], 'a', each([1], 'b', each([1], 'c', c)))"
    expect(() => validateUIDocument(doc)).toThrow('nest at most 2')
    doc = loan(); doc.blocks[5].items.push({ id: 'x', kind: 'set', label: 'x', steps: [{ set: 'pay', to: '1' }] })
    expect(() => validateUIDocument(doc)).toThrow('expected a state name')
  })
})

describe('Intelligent UI v2 expressions', () => {
  it('follows the usual precedence and short-circuits', () => {
    expect(run('1 + 2 * 3 - 4 / 2')).toBe(5)
    expect(run('-2 * 3 + 10 % 4')).toBe(-4)
    expect(run('1 < 2 and not (3 > 4) or false')).toBe(true)
    expect(run('false and x.y', { x: 1 })).toBe(false)
    expect(run("1 > 2 ? 'a' : 2 > 1 ? 'b' : 'c'")).toBe('b')
  })
  it('turns numbers into text without float noise and compares them with a tolerance', () => {
    expect(run("'第 ' + (0.1 + 0.2) + ' 年'")).toBe('第 0.3 年')
    expect(run('0.1 + 0.2 == 0.3')).toBe(true)
    expect(run('includes([[1, 2]], [1, 2])')).toBe(true)
    expect(run("join(range(0.1, 0.5, 0.1), '/')")).toBe('0.1/0.2/0.3/0.4/0.5')
    expect(uiText([1.5, 'a', null])).toBe('1.5, a, ')
  })
  it('maps, filters and sorts lists with a named item', () => {
    const items = [{ n: 'b', v: 2 }, { n: 'a', v: 3 }, { n: 'c', v: 1 }]
    expect(run("each(filter(items, 'x', x.v > 1), 'x', x.n)", { items })).toEqual(['b', 'a'])
    expect(run("each(sortBy(items, 'x', x.n), 'x', x.v)", { items })).toEqual([3, 2, 1])
    expect(run("each(range(1, 3), 'i', each(range(1, i), 'j', i * j))")).toEqual([[1], [2, 4], [3, 6, 9]])
  })
  it('formats by interface language', () => {
    expect(run("format(1234567.891, 'number', 1)")).toBe('1,234,567.9')
    expect(run("format(0.256, 'percent')")).toBe('25.6%')
    expect(run("format(12000000, 'compact')")).toBe('1200万')
    expect(run("format(668000, 'wan', 1)")).toBe('66.8 万')
  })
  it('only reads own fields: no prototype, constructor or inherited methods', () => {
    for (const src of ['o.constructor', "o['__proto__']", 'o.toString', 'o.hasOwnProperty', "'abc'.length", 'l.length', 'l.map']) {
      const doc = { inputs: [], state: [{ id: 'o', initial: { a: 1 } }, { id: 'l', initial: [1] }], derived: [] }
      const c = documentEnv(doc, {}, new Map<string, UIValue>([['o', { a: 1 }], ['l', [1]]]), 'en').cell(src)
      expect(c.ok, src).toBe(false)
    }
    expect(() => compileExpr('{constructor: 1}', { inputs: new Set(), names: new Set() })).toThrow('invalid key')
  })
  it('stops runaway values: text and list caps, and a step budget per render', () => {
    expect(() => run('s + s', { s: 'x'.repeat(6000) })).toThrow('longer than 10000')
    expect(() => run('range(1, 500)')).toThrow('longer than 200')
    expect(() => run("each(range(1, 200), 'a', each(range(1, 200), 'b', a * b))")).toThrow(/longer than 200|too much computation/)
    expect(() => run('1 / 0')).toThrow('not a finite number')
    expect(() => run('[1][3]')).toThrow('outside the list')
  })
  it('reports values that fail at the initial values next to a successful render', () => {
    const doc = loan(); doc.derived[3].expr = 'payment(r, 0, p)'
    expect(uiDocumentIssues(validateUIDocument(doc))).toEqual(['derived pay: payment needs a positive number of periods'])
    const table = loan(); table.blocks[3].rows = "[[1, 2, 3]]"
    expect(uiDocumentIssues(validateUIDocument(table))).toEqual(['balance.rows: row 1 has 3 cells for 2 columns'])
  })
  it('evaluates a compiled tree directly', () => {
    const node = compileExpr('$a * 2', { inputs: new Set(['a']), names: new Set() })
    expect(evaluate(node, { name: () => 21, locale: 'en', budget: { steps: 0 } })).toBe(42)
  })
})
