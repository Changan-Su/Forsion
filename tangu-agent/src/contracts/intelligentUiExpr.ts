/** Forsion Intelligent UI v2 expressions: a small pure language over a fixed list of functions.
 * Shared by the engine validator and the native renderer. An expression reads only the document's
 * inputs, state and derived values; it cannot reach the network, the clock, randomness, the DOM or any
 * object it was not handed. Runs in the app's renderer process (not a sandbox), hence the own-property
 * reads and the caps on every value it produces. */
import type { UIDocument, UISetStep } from './intelligentUi.js'

export type UIValue = null | boolean | number | string | UIValue[] | { [key: string]: UIValue }
export const EXPR_LIMITS = { chars: 300, steps: 20_000, list: 200, text: 10_000, nest: 2, rows: 50 } as const

type Node =
  | { t: 'lit'; v: UIValue }
  | { t: 'name'; id: string }
  | { t: 'list'; items: Node[] }
  | { t: 'obj'; entries: [string, Node][] }
  | { t: 'un'; op: '-' | '!'; a: Node }
  | { t: 'bin'; op: string; a: Node; b: Node }
  | { t: 'cond'; c: Node; a: Node; b: Node }
  | { t: 'get'; a: Node; key: Node }
  | { t: 'call'; fn: string; args: Node[] }

export const UI_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,39}$/
const FORBIDDEN = new Set(['__proto__', 'constructor', 'prototype'])
const KEYWORDS = new Set(['and', 'or', 'not', 'true', 'false', 'null'])
const STYLES = new Set(['number', 'percent', 'wan', 'compact'])
const LOOPS = new Set(['each', 'filter', 'sortBy'])

// ── tokens and parsing ──
type Tok = { k: 'num' | 'str' | 'id' | 'var' | 'op' | 'end'; v: string }
function tokenize(src: string): Tok[] {
  const out: Tok[] = []
  let i = 0
  while (i < src.length) {
    const rest = src.slice(i), c = src[i]
    if (/\s/.test(c)) { i++; continue }
    let m = /^\d+(?:\.\d+)?(?:[eE][-+]?\d+)?/.exec(rest)
    if (m) { out.push({ k: 'num', v: m[0] }); i += m[0].length; continue }
    if (c === "'" || c === '"') {
      let s = '', j = i + 1
      for (; j < src.length && src[j] !== c; j++) {
        if (src[j] === '\\') { j++; s += src[j] === 'n' ? '\n' : src[j] ?? '' } else s += src[j]
      }
      if (j >= src.length) throw new Error('unterminated string')
      out.push({ k: 'str', v: s }); i = j + 1; continue
    }
    // `$name` and `name` are the same: models write `$` for every variable, not only for inputs.
    if ((m = /^\$[A-Za-z0-9_]+/.exec(rest))) { out.push({ k: 'var', v: m[0].slice(1) }); i += m[0].length; continue }
    if ((m = /^[A-Za-z_][A-Za-z0-9_]*/.exec(rest))) { out.push({ k: 'id', v: m[0] }); i += m[0].length; continue }
    if ((m = /^(?:==|!=|<=|>=|&&|\|\||[-+*/%<>!?:.,()[\]{}])/.exec(rest))) { out.push({ k: 'op', v: m[0] }); i += m[0].length; continue }
    throw new Error(`unexpected "${c}"`)
  }
  out.push({ k: 'end', v: '' })
  return out
}

const OPS: [Map<string, string>, Map<string, string>, Map<string, string>, Map<string, string>, Map<string, string>, Map<string, string>] = [
  new Map([['||', 'or'], ['or', 'or']]), new Map([['&&', 'and'], ['and', 'and']]), new Map([['==', '=='], ['!=', '!=']]),
  new Map([['<', '<'], ['<=', '<='], ['>', '>'], ['>=', '>=']]), new Map([['+', '+'], ['-', '-']]), new Map([['*', '*'], ['/', '/'], ['%', '%']]),
]
function parse(src: string): Node {
  const toks = tokenize(src)
  let p = 0
  const is = (v: string): boolean => (toks[p].k === 'op' || toks[p].k === 'id') && toks[p].v === v
  const eat = (v: string): void => { if (!is(v)) throw new Error(`expected "${v}"`); p++ }
  const items = <T>(close: string, one: () => T): T[] => {
    const out: T[] = []
    if (!is(close)) for (;;) { out.push(one()); if (!is(',')) break; p++ }
    eat(close)
    return out
  }
  const expr = (): Node => {
    const c = level(0)
    if (!is('?')) return c
    p++
    const a = expr(); eat(':')
    return { t: 'cond', c, a, b: expr() }
  }
  const level = (n: number): Node => {
    if (n === OPS.length) return unary()
    let a = level(n + 1)
    for (let op = OPS[n].get(toks[p].v); op && (toks[p].k === 'op' || toks[p].k === 'id'); op = OPS[n].get(toks[p].v)) { p++; a = { t: 'bin', op, a, b: level(n + 1) } }
    return a
  }
  const unary = (): Node => {
    if (is('-') || is('!') || is('not')) { const op = toks[p].v === '-' ? '-' : '!'; p++; return { t: 'un', op, a: unary() } }
    let a = primary()
    for (;;) {
      if (is('.')) {
        p++
        const t = toks[p]
        if (t.k !== 'id') throw new Error('expected a field name after "."')
        p++; a = { t: 'get', a, key: { t: 'lit', v: t.v } }
      } else if (is('[')) { p++; const key = expr(); eat(']'); a = { t: 'get', a, key } }
      else return a
    }
  }
  const primary = (): Node => {
    const t = toks[p]
    if (t.k === 'num') { p++; const v = Number(t.v); if (!Number.isFinite(v)) throw new Error(`number ${t.v} is too large`); return { t: 'lit', v } }
    if (t.k === 'var') { p++; return { t: 'name', id: t.v } } // $true is the value named true, never the keyword
    if (t.k === 'str') { p++; return { t: 'lit', v: t.v } }
    if (t.k === 'id') {
      p++
      if (t.v === 'true' || t.v === 'false') return { t: 'lit', v: t.v === 'true' }
      if (t.v === 'null') return { t: 'lit', v: null }
      if (is('(')) { p++; return { t: 'call', fn: t.v, args: items(')', expr) } }
      return { t: 'name', id: t.v }
    }
    if (is('(')) { p++; const e = expr(); eat(')'); return e }
    if (is('[')) { p++; return { t: 'list', items: items(']', expr) } }
    if (is('{')) {
      p++
      return { t: 'obj', entries: items('}', () => {
        const k = toks[p]
        if (k.k !== 'id' && k.k !== 'str') throw new Error('expected an object key')
        p++; eat(':')
        return [k.v, expr()] as [string, Node]
      }) }
    }
    throw new Error(t.k === 'end' ? 'unexpected end of expression' : `unexpected "${t.v}"`)
  }
  const root = expr()
  if (toks[p].k !== 'end') throw new Error(`unexpected "${toks[p].v}"`)
  return root
}

// ── functions ──
type Ev = (n: Node, locals?: Map<string, UIValue>) => UIValue
type Fn = { min: number; max: number; run: (args: UIValue[], locale: 'zh' | 'en') => UIValue }
const num = (x: UIValue): number => { if (typeof x !== 'number' || !Number.isFinite(x)) throw new Error(`expected a number, got ${kind(x)}`); return x }
const list = (x: UIValue): UIValue[] => { if (!Array.isArray(x)) throw new Error(`expected a list, got ${kind(x)}`); return x }
const nums = (args: UIValue[]): number[] => (args.length === 1 && Array.isArray(args[0]) ? args[0] : args).map(num)
const finite = (x: number): number => { if (!Number.isFinite(x)) throw new Error('result is not a finite number'); return x }
const kind = (x: UIValue): string => x === null ? 'null' : Array.isArray(x) ? 'list' : typeof x
const digits = (x: UIValue | undefined, fallback: number | undefined): number | undefined => x === undefined ? fallback : Math.max(0, Math.min(6, Math.round(num(x))))
/** Expanded size of a value: what copying, comparing or saving it costs. Lists and objects share
 * children (each(range(1, 200), 'x', big) holds big 200 times), so this counts the expansion, cached
 * per object, and stops counting past the limit. */
const WEIGHTS = new WeakMap<object, number>()
export const UI_WEIGHT_LIMIT = 20_000
export function uiWeight(x: UIValue): number {
  if (typeof x === 'string') return 1 + (x.length >> 5)
  if (x === null || typeof x !== 'object') return 1
  let w = WEIGHTS.get(x)
  if (w === undefined) {
    w = 1
    for (const v of Array.isArray(x) ? x : Object.values(x)) { w += uiWeight(v); if (w > UI_WEIGHT_LIMIT) break }
    WEIGHTS.set(x, w)
  }
  return w
}
const sized = <T extends UIValue>(x: T): T => {
  if (typeof x === 'string' && x.length > EXPR_LIMITS.text) throw new Error(`text longer than ${EXPR_LIMITS.text} characters`)
  if (Array.isArray(x) && x.length > EXPR_LIMITS.list) throw new Error(`list longer than ${EXPR_LIMITS.list} items`)
  if (x && typeof x === 'object' && uiWeight(x) > UI_WEIGHT_LIMIT) throw new Error('value too large')
  return x
}
/** Trims binary noise (0.1 + 0.2) so text never shows 17 digits. */
const clean = (x: number): number => Number(x.toPrecision(12))
export function truthy(x: UIValue): boolean { return Array.isArray(x) ? x.length > 0 : x !== null && x !== false && x !== 0 && x !== '' }
export function sameValue(a: UIValue, b: UIValue): boolean {
  if (typeof a === 'number' && typeof b === 'number') return Math.abs(a - b) <= 1e-9 * Math.max(1, Math.abs(a), Math.abs(b))
  if (Array.isArray(a) || Array.isArray(b)) return Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((x, i) => sameValue(x, b[i]))
  if (a && b && typeof a === 'object' && typeof b === 'object') {
    const ka = Object.keys(a), kb = Object.keys(b)
    return ka.length === kb.length && ka.every(k => Object.hasOwn(b, k) && sameValue(a[k], b[k]))
  }
  return a === b
}
/** How a value reads as text: numbers without float noise, lists comma-joined, null empty. */
export function uiText(x: UIValue): string {
  if (typeof x === 'string') return x
  if (typeof x === 'number') return String(clean(x))
  if (typeof x === 'boolean') return String(x)
  if (x === null) return ''
  if (Array.isArray(x)) return sized(x.map(uiText).join(', '))
  throw new Error('an object cannot be shown as text')
}
const LOCALES = { zh: 'zh-CN', en: 'en-US' } as const
export function formatUINumber(x: number, style: string, d: number | undefined, locale: 'zh' | 'en'): string {
  const fixed = d === undefined ? { maximumFractionDigits: 2 } : { minimumFractionDigits: d, maximumFractionDigits: d }
  // 「万」只有中文界面读得顺;英文界面同一个写法换成 1.2M。
  if (style === 'wan' && locale === 'zh') return `${new Intl.NumberFormat('zh-CN', fixed).format(x / 10_000)} 万`
  if (style === 'wan' || style === 'compact') return new Intl.NumberFormat(LOCALES[locale], { notation: 'compact', maximumFractionDigits: d ?? 1 }).format(x)
  if (style === 'percent') return new Intl.NumberFormat(LOCALES[locale], { style: 'percent', maximumFractionDigits: d ?? 1, ...(d === undefined ? {} : { minimumFractionDigits: d }) }).format(x)
  if (style === 'number') return new Intl.NumberFormat(LOCALES[locale], fixed).format(x)
  throw new Error(`unknown format style "${style}"`)
}
const FNS = new Map<string, Fn>([
  ['round', { min: 1, max: 2, run: ([x, d]) => { const k = 10 ** (digits(d, 0) ?? 0); return finite(clean(Math.round(num(x) * k) / k)) } }],
  ['floor', { min: 1, max: 1, run: ([x]) => Math.floor(num(x)) }],
  ['ceil', { min: 1, max: 1, run: ([x]) => Math.ceil(num(x)) }],
  ['abs', { min: 1, max: 1, run: ([x]) => Math.abs(num(x)) }],
  ['min', { min: 1, max: 8, run: (a) => { const v = nums(a); if (!v.length) throw new Error('min of an empty list'); return Math.min(...v) } }],
  ['max', { min: 1, max: 8, run: (a) => { const v = nums(a); if (!v.length) throw new Error('max of an empty list'); return Math.max(...v) } }],
  ['clamp', { min: 3, max: 3, run: ([x, lo, hi]) => Math.min(num(hi), Math.max(num(lo), num(x))) }],
  ['pow', { min: 2, max: 2, run: ([a, b]) => finite(num(a) ** num(b)) }],
  ['sum', { min: 1, max: 1, run: ([l]) => finite(list(l).map(num).reduce((s, x) => s + x, 0)) }],
  ['avg', { min: 1, max: 1, run: ([l]) => { const v = list(l).map(num); if (!v.length) throw new Error('average of an empty list'); return finite(v.reduce((s, x) => s + x, 0) / v.length) } }],
  ['count', { min: 1, max: 1, run: ([l]) => typeof l === 'string' ? [...l].length : list(l).length }],
  ['percent', { min: 2, max: 2, run: ([a, b]) => finite(num(a) / num(b) * 100) }],
  // Level payment per period (PMT): rate per period, number of periods, principal.
  ['payment', { min: 3, max: 3, run: ([r, n, pv]) => {
    const rate = num(r), periods = num(n), p = num(pv)
    if (periods <= 0) throw new Error('payment needs a positive number of periods')
    return finite(rate === 0 ? p / periods : p * rate / (1 - (1 + rate) ** -periods))
  } }],
  ['format', { min: 1, max: 3, run: ([x, style, d], locale) => {
    if (style !== undefined && typeof style !== 'string') throw new Error('format style must be text')
    return formatUINumber(num(x), style ?? 'number', digits(d, undefined), locale)
  } }],
  ['join', { min: 1, max: 2, run: ([l, sep]) => sized(list(l).map(uiText).join(sep === undefined ? ', ' : uiText(sep))) }],
  ['range', { min: 2, max: 3, run: ([a, b, s]) => {
    const from = num(a), to = num(b), step = s === undefined ? 1 : num(s)
    if (step === 0 || (to - from) * step < 0) return []
    const n = Math.floor((to - from) / step + 1e-9) + 1
    if (n > EXPR_LIMITS.list) throw new Error(`range longer than ${EXPR_LIMITS.list} items`)
    return Array.from({ length: n }, (_, i) => clean(from + i * step))
  } }],
  ['includes', { min: 2, max: 2, run: ([l, v]) => typeof l === 'string' ? l.includes(uiText(v)) : list(l).some(x => sameValue(x, v)) }],
  // each / filter / sortBy bind their second argument as a name inside the third; evaluated in evaluate().
  ['each', { min: 3, max: 3, run: () => null }], ['filter', { min: 3, max: 3, run: () => null }], ['sortBy', { min: 3, max: 3, run: () => null }],
])
export const UI_FUNCTIONS: readonly string[] = [...FNS.keys()]
/** Names a document may not declare. Function names stay free: a call is written name(…), a value bare. */
export const reservedUIName = (id: string): boolean => KEYWORDS.has(id) || FORBIDDEN.has(id)

// ── static check ──
export type ExprScope = { inputs: ReadonlySet<string>; names: ReadonlySet<string> }
const parsed = new Map<string, Node>()
/** Parses (cached by source) and checks every name, function and arity against the scope. */
export function compileExpr(src: unknown, scope: ExprScope): Node {
  if (typeof src !== 'string' || !src.trim()) throw new Error('expected an expression')
  if (src.length > EXPR_LIMITS.chars) throw new Error(`expression longer than ${EXPR_LIMITS.chars} characters; put data such as word lists, steps or rows in a state value's initial and compute from it`)
  let node = parsed.get(src)
  if (!node) {
    try { node = parse(src) } catch (e) { throw new Error(`${e instanceof Error ? e.message : e} in "${src}"`) }
    if (parsed.size >= 1000) parsed.clear() // ponytail: crude cache bound; a streaming draft re-validates the same few hundred sources
    parsed.set(src, node)
  }
  const check = (n: Node, locals: ReadonlySet<string>, nest: number): void => {
    switch (n.t) {
      case 'name':
        if (!locals.has(n.id) && !scope.names.has(n.id) && !scope.inputs.has(n.id)) throw new Error(FNS.has(n.id) ? `${n.id} is a function; call it as ${n.id}(…)` : `unknown name ${n.id} — declare it as an input, a state value or a derived value before using it`)
        return
      case 'list': if (n.items.length > EXPR_LIMITS.list) throw new Error('list literal too long'); n.items.forEach(x => check(x, locals, nest)); return
      case 'obj':
        for (const [k, x] of n.entries) { if (FORBIDDEN.has(k) || !k) throw new Error(`invalid key "${k}"`); check(x, locals, nest) }
        return
      case 'un': check(n.a, locals, nest); return
      case 'bin': check(n.a, locals, nest); check(n.b, locals, nest); return
      case 'cond': check(n.c, locals, nest); check(n.a, locals, nest); check(n.b, locals, nest); return
      case 'get':
        if (n.key.t === 'lit' && typeof n.key.v === 'string' && FORBIDDEN.has(n.key.v)) throw new Error(`invalid field "${n.key.v}"`)
        check(n.a, locals, nest); check(n.key, locals, nest); return
      case 'call': {
        const fn = FNS.get(n.fn)
        if (!fn) throw new Error(`unknown function ${n.fn}() — available: ${UI_FUNCTIONS.join(', ')}`)
        if (n.args.length < fn.min || n.args.length > fn.max) throw new Error(`${n.fn}() takes ${fn.min === fn.max ? fn.min : `${fn.min}-${fn.max}`} arguments`)
        if (LOOPS.has(n.fn)) {
          const name = n.args[1]
          if (name.t !== 'lit' || typeof name.v !== 'string' || !UI_NAME.test(name.v) || reservedUIName(name.v)) throw new Error(`${n.fn}() needs a quoted item name as its second argument, e.g. ${n.fn}(items, 'x', …)`)
          if (nest >= EXPR_LIMITS.nest) throw new Error(`each/filter/sortBy nest at most ${EXPR_LIMITS.nest} deep`)
          check(n.args[0], locals, nest)
          check(n.args[2], new Set([...locals, name.v]), nest + 1)
          return
        }
        if (n.fn === 'format' && n.args[1]?.t === 'lit' && !STYLES.has(String(n.args[1].v))) throw new Error(`format style must be one of ${[...STYLES].join(', ')}`)
        n.args.forEach(x => check(x, locals, nest))
        return
      }
    }
  }
  check(node, new Set(), 0)
  return node
}

// ── evaluation ──
export type ExprEnv = {
  /** Input, state or derived value; throws when a derived value failed. */
  name(id: string): UIValue
  locale: 'zh' | 'en'
  budget: { steps: number }
}
export function evaluate(root: Node, env: ExprEnv): UIValue {
  // Work proportional to a value's size (comparing, joining, summing it) is charged to the same budget.
  const charge = (n: number): void => { if ((env.budget.steps += n) > EXPR_LIMITS.steps) throw new Error('too much computation') }
  const weighs = (x: UIValue): number => x !== null && typeof x === 'object' ? uiWeight(x) : 0
  const ev: Ev = (n, locals) => {
    charge(1)
    switch (n.t) {
      case 'lit': return n.v
      case 'name': return locals?.has(n.id) ? locals.get(n.id)! : env.name(n.id)
      case 'list': return sized(n.items.map(x => ev(x, locals)))
      case 'obj': return sized(Object.fromEntries(n.entries.map(([k, x]) => [k, ev(x, locals)])))
      case 'un': { const a = ev(n.a, locals); return n.op === '-' ? -num(a) : !truthy(a) }
      case 'cond': return truthy(ev(n.c, locals)) ? ev(n.a, locals) : ev(n.b, locals)
      case 'get': {
        const a = ev(n.a, locals), key = ev(n.key, locals)
        if (Array.isArray(a)) {
          if (typeof key !== 'number' || !Number.isInteger(key) || key < 0 || key >= a.length) throw new Error(`index ${uiText(key)} is outside the list (${a.length} items)`)
          return a[key]
        }
        if (a && typeof a === 'object' && typeof key === 'string' && !FORBIDDEN.has(key) && Object.hasOwn(a, key)) return a[key]
        throw new Error(`no field ${uiText(key)} on ${kind(a)}`)
      }
      case 'bin': {
        if (n.op === 'and') return truthy(ev(n.a, locals)) && truthy(ev(n.b, locals))
        if (n.op === 'or') return truthy(ev(n.a, locals)) || truthy(ev(n.b, locals))
        const a = ev(n.a, locals), b = ev(n.b, locals)
        switch (n.op) {
          case '==': charge(weighs(a) + weighs(b)); return sameValue(a, b)
          case '!=': charge(weighs(a) + weighs(b)); return !sameValue(a, b)
          case '+':
            if (typeof a === 'number' && typeof b === 'number') return finite(a + b)
            if (Array.isArray(a) && Array.isArray(b)) return sized([...a, ...b])
            if (typeof a === 'string' || typeof b === 'string') return sized(uiText(a) + uiText(b))
            throw new Error(`cannot add ${kind(a)} and ${kind(b)}`)
          case '-': return finite(num(a) - num(b))
          case '*': return finite(num(a) * num(b))
          case '/': return finite(num(a) / num(b))
          case '%': return finite(num(a) % num(b))
          default: {
            if (!((typeof a === 'number' && typeof b === 'number') || (typeof a === 'string' && typeof b === 'string'))) throw new Error(`cannot compare ${kind(a)} with ${kind(b)}`)
            return n.op === '<' ? a < b : n.op === '<=' ? a <= b : n.op === '>' ? a > b : a >= b
          }
        }
      }
      case 'call': {
        if (LOOPS.has(n.fn)) {
          const items = list(ev(n.args[0], locals)), name = (n.args[1] as { v: string }).v
          const scope = new Map(locals)
          const per = (x: UIValue): UIValue => { scope.set(name, x); return ev(n.args[2], scope) }
          if (n.fn === 'each') return sized(items.map(per))
          if (n.fn === 'filter') return items.filter(x => truthy(per(x)))
          const keys = items.map(per)
          if (!keys.every(k => typeof k === 'number') && !keys.every(k => typeof k === 'string')) throw new Error('sortBy keys must be all numbers or all text')
          return items.map((x, i) => [x, keys[i]] as const).sort((a, b) => a[1]! < b[1]! ? -1 : a[1]! > b[1]! ? 1 : 0).map(([x]) => x)
        }
        const args = n.args.map(x => ev(x, locals))
        charge(args.reduce((w: number, a) => w + weighs(a) * (n.fn === 'includes' ? 2 : 1), 0))
        return FNS.get(n.fn)!.run(args, env.locale)
      }
    }
  }
  return ev(root)
}

/** What a stored state value may be: plain JSON, lists up to 200, objects up to 16 keys, 4 deep. */
export function uiValueIssue(x: unknown, depth = 0): string {
  if (depth > 4) return 'nested too deep'
  if (x === null || typeof x === 'boolean') return ''
  if (typeof x === 'number') return Number.isFinite(x) ? '' : 'not a finite number'
  if (typeof x === 'string') return x.length <= 1000 ? '' : 'text longer than 1000 characters'
  if (Array.isArray(x)) return x.length > EXPR_LIMITS.list ? `list longer than ${EXPR_LIMITS.list} items` : x.map(v => uiValueIssue(v, depth + 1)).find(Boolean) || ''
  if (typeof x === 'object') {
    const keys = Object.keys(x)
    if (keys.length > 16) return 'object with more than 16 keys'
    return keys.map(k => FORBIDDEN.has(k) || k.length > 80 ? `invalid key "${k}"` : uiValueIssue((x as Record<string, unknown>)[k], depth + 1)).find(Boolean) || ''
  }
  return `unsupported value ${typeof x}`
}

// ── interpolation ──
// A slot ends at the first }} outside a quoted string: {{'a}}b'}} shows a}}b.
const SLOT = /\{\{((?:'[^']*'|"[^"]*"|[^'"}]|\}(?!\}))*)\}\}/g
export const interpolationSources = (markdown: string): string[] => [...markdown.matchAll(SLOT)].map(m => m[1].trim())
/** Markers a renderer swaps for computed text after parsing the markdown: private-use characters, so
 * no markdown construct (link, autolink, emphasis, table cell) can form from a computed value. Escaping
 * is not enough: GFM autolink literals still fire through backslash escapes. */
export const UI_SLOT = /\uE000(\d+)\uE001/g

// ── a document's values ──
export type UICell = { ok: true; value: UIValue } | { ok: false; error: string }
export type DocumentEnv = ExprEnv & {
  /** Evaluate one expression of this document. */
  cell(src: string): UICell
  /** A cell as text; failures read as an em dash. */
  text(src: string): string
  /** Markdown with every {{ }} replaced by a UI_SLOT marker, and the text for each marker. */
  slots(markdown: string): { markdown: string; values: string[] }
}
export function documentScope(doc: Pick<UIDocument, 'inputs' | 'state' | 'derived'>): ExprScope {
  return { inputs: new Set(doc.inputs.map(i => i.id)), names: new Set([...(doc.state || []).map(s => s.id), ...(doc.derived || []).map(d => d.id)]) }
}
/** Values for one render: inputs as the user set them, state as stored, derived computed lazily once.
 * One step budget covers the whole render. */
export function documentEnv(doc: Pick<UIDocument, 'inputs' | 'state' | 'derived'>, inputs: Record<string, string | number>, vars: ReadonlyMap<string, UIValue>, locale: 'zh' | 'en'): DocumentEnv {
  const scope = documentScope(doc)
  const derived = new Map((doc.derived || []).map(d => [d.id, d.expr]))
  const memo = new Map<string, UICell>()
  const env: DocumentEnv = {
    locale, budget: { steps: 0 },
    name: id => {
      if (Object.hasOwn(inputs, id)) return inputs[id]
      if (vars.has(id)) return vars.get(id)!
      const src = derived.get(id)
      if (src === undefined) throw new Error(`unknown name ${id}`)
      let c = memo.get(id)
      if (!c) { c = env.cell(src); memo.set(id, c) }
      if (!c.ok) throw new Error(`${id}: ${c.error}`)
      return c.value
    },
    cell: src => {
      try { return { ok: true, value: evaluate(compileExpr(src, scope), env) } } catch (e) { return { ok: false, error: e instanceof Error ? e.message : String(e) } }
    },
    text: src => {
      if (src.includes('{{')) return src.replace(SLOT, (_, inner: string) => env.text(inner.trim()))
      const c = env.cell(src)
      if (!c.ok) return '—'
      try { return uiText(c.value) } catch { return '—' }
    },
    slots: markdown => {
      const values: string[] = []
      // Markers the model wrote itself are dropped first, so only this pass's slots get filled.
      return { markdown: markdown.replace(/[\uE000\uE001]/g, '').replace(SLOT, (_, src: string) => `\uE000${values.push(env.text(src.trim())) - 1}\uE001`), values }
    },
  }
  return env
}

/** A table block's rows: a list of rows, each a list with one cell per column (a bare value fills a one-column row). */
export function uiTableRows(value: UIValue, columns: number): string[][] {
  const rows = list(value)
  if (rows.length > EXPR_LIMITS.rows) throw new Error(`more than ${EXPR_LIMITS.rows} rows`)
  return rows.map((row, i) => {
    const cells = Array.isArray(row) ? row : [row]
    if (cells.length !== columns) throw new Error(`row ${i + 1} has ${cells.length} cells for ${columns} columns`)
    return cells.map(uiText)
  })
}

/** Runs a set button's steps in order, each seeing the state the previous one left. All or nothing:
 * any failing step throws and the caller keeps the old state. */
export function applyUISteps(doc: Pick<UIDocument, 'inputs' | 'state' | 'derived'>, steps: UISetStep[], inputs: Record<string, string | number>, vars: ReadonlyMap<string, UIValue>, locale: 'zh' | 'en'): Map<string, UIValue> {
  const next = new Map(vars), initial = new Map((doc.state || []).map(s => [s.id, s.initial]))
  for (const step of steps) {
    const env = documentEnv(doc, inputs, next, locale)
    const value = (src: string): UIValue => { const c = env.cell(src); if (!c.ok) throw new Error(c.error); return c.value }
    const target = 'set' in step ? step.set : 'toggle' in step ? step.toggle : 'append' in step ? step.append : 'remove' in step ? step.remove : step.reset
    const current = next.get(target) ?? null
    const items = (): UIValue[] => { if (!Array.isArray(current)) throw new Error(`${target} is not a list`); return current }
    let v: UIValue
    if ('set' in step) v = value(step.to)
    else if ('reset' in step) v = initial.get(target) ?? null
    else if ('append' in step) v = [...items(), value(step.value)]
    else if ('remove' in step) { const x = value(step.value); v = items().filter(y => !sameValue(y, x)) }
    else if (step.value === undefined) { if (typeof current !== 'boolean') throw new Error(`${target} is not true/false`); v = !current }
    else { const x = value(step.value), l = items(); v = l.some(y => sameValue(y, x)) ? l.filter(y => !sameValue(y, x)) : [...l, x] }
    const issue = uiWeight(v) > UI_WEIGHT_LIMIT ? 'value too large' : uiValueIssue(v)
    if (issue) throw new Error(`${target}: ${issue}`)
    next.set(target, v)
  }
  return next
}

/** Every expression a v2 document shows at its initial values, evaluated once. The engine reports the
 * failures to the model next to a successful render (they show as an em dash, which can be intended:
 * an average of a list the user has not filled yet). Blocks hidden at the initial values are skipped. */
export function uiDocumentIssues(doc: UIDocument, locale: 'zh' | 'en' = 'en'): string[] {
  if (doc.version !== 2) return []
  const env = documentEnv(doc, Object.fromEntries(doc.inputs.map(i => [i.id, i.initial])), new Map((doc.state || []).map(s => [s.id, s.initial])), locale)
  const out: string[] = [], failed: string[] = []
  const probe = (where: string, src: string, shape?: (v: UIValue) => void): boolean => {
    const c = env.cell(src)
    try { if (!c.ok) throw new Error(c.error); shape?.(c.value); return truthy(c.value) } catch (e) {
      const message = e instanceof Error ? e.message : String(e)
      // A value that fails only because a derived name above it failed is the same problem, reported once.
      if (!failed.some(id => message.startsWith(`${id}: `))) out.push(`${where}: ${message}`)
      return false
    }
  }
  const initial = Object.fromEntries(doc.inputs.map(i => [i.id, i.initial]))
  // 被条件藏起来的不报(input 条件按初值判,同渲染层 visible;Codex 10-20)
  const shown = (where: string, when: UIDocument['blocks'][number]['when']): boolean => !when || ('expr' in when ? probe(`${where}.when`, when.expr) : initial[when.input] === when.equals)
  // Through the name, so the memo the shown values use is filled once (a heavy derived value is not computed twice).
  for (const d of doc.derived || []) {
    const c = env.cell(d.id)
    if (c.ok) continue
    const message = c.error.replace(`${d.id}: `, '')
    if (!failed.some(id => message.startsWith(`${id}: `))) out.push(`derived ${d.id}: ${message}`)
    failed.push(d.id)
  }
  for (const b of doc.blocks) {
    if (b.when && 'input' in b.when && b.when.equals !== doc.inputs.find(i => i.id === (b.when as { input: string }).input)?.initial) continue
    if (!shown(b.id, b.when)) continue
    if (b.kind === 'text' || b.kind === 'disclosure') for (const src of interpolationSources(b.markdown)) probe(`${b.id} {{${src}}}`, src, uiText)
    if (b.kind === 'stats') b.items.forEach((item, i) => { for (const src of item.value.includes('{{') ? interpolationSources(item.value) : [item.value]) probe(`${b.id}.items[${i}]`, src, uiText) })
    if (b.kind === 'table') {
      if (typeof b.rows === 'string') { const rows = b.rows; probe(`${b.id}.rows`, rows, v => uiTableRows(v, b.columns.length)) }
      else for (const src of b.rows.flat().flatMap(interpolationSources)) probe(`${b.id} {{${src}}}`, src, uiText)
    }
    if (b.kind === 'checklist') for (const item of b.items) if (shown(`${b.id}.${item.id}`, item.when)) for (const src of interpolationSources(item.label)) probe(`${b.id}.${item.id} {{${src}}}`, src, uiText)
    if (b.kind === 'actions') for (const a of b.items) if (a.kind === 'set' && a.disabled) probe(`${b.id}.${a.id}.disabled`, a.disabled)
  }
  return [...new Set(out)].slice(0, 6)
}
