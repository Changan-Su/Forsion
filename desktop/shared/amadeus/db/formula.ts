/** 公式列引擎:极小表达式语言(无 eval、无依赖),渲染层按行求值,结果不落盘。
 *
 *  语法:
 *  - 列引用 `{列名}`(也认列 id);字符串 "…" / '…';数字;true/false
 *  - 运算 + - * / %、比较 == != > < >= <=、逻辑 && || !、括号
 *  - `+` 两侧都是数值系(number/null/boolean)才做加法,否则字符串拼接
 *  - 空单元格(null)参与算术按 0、参与拼接按 ''(飞书口径)
 *  - 函数(小写):if(c,a,b) and or not empty round(n[,d]) floor ceil abs min max
 *    len lower upper trim contains(a,b) replace(s,a,b) concat number text today() days(a,b)
 *
 *  错误(未知列/未知函数/语法/非数字算术/循环引用)抛 FormulaError;
 *  evalRowFormulas 把单列错误折算成 '#错误' 字符串,不连坐整行。 */
import type { CellValue, DbColumn } from './schema'

export class FormulaError extends Error {}

// ── 词法 ────────────────────────────────────────────────────────────────────

type Tok =
  | { t: 'num'; v: number }
  | { t: 'str'; v: string }
  | { t: 'ref'; v: string }
  | { t: 'ident'; v: string }
  | { t: 'op'; v: string }

function lex(src: string): Tok[] {
  const toks: Tok[] = []
  let i = 0
  while (i < src.length) {
    const ch = src[i]
    if (/\s/.test(ch)) { i++; continue }
    if (ch === '{') {
      const j = src.indexOf('}', i + 1)
      if (j < 0) throw new FormulaError('列引用未闭合:缺 }')
      const name = src.slice(i + 1, j).trim()
      if (!name) throw new FormulaError('空的列引用 {}')
      toks.push({ t: 'ref', v: name })
      i = j + 1
      continue
    }
    if (ch === '"' || ch === "'") {
      let j = i + 1
      let s = ''
      while (j < src.length && src[j] !== ch) {
        s += src[j] === '\\' && j + 1 < src.length ? src[++j] : src[j]
        j++
      }
      if (j >= src.length) throw new FormulaError('字符串未闭合')
      toks.push({ t: 'str', v: s })
      i = j + 1
      continue
    }
    if (/[0-9]/.test(ch) || (ch === '.' && /[0-9]/.test(src[i + 1] ?? ''))) {
      const m = /^\d*\.?\d+/.exec(src.slice(i))!
      toks.push({ t: 'num', v: Number(m[0]) })
      i += m[0].length
      continue
    }
    if (/[A-Za-z_一-鿿]/.test(ch)) {
      const m = /^[A-Za-z_一-鿿][A-Za-z0-9_一-鿿]*/.exec(src.slice(i))!
      toks.push({ t: 'ident', v: m[0] })
      i += m[0].length
      continue
    }
    const two = src.slice(i, i + 2)
    if (['==', '!=', '>=', '<=', '&&', '||'].includes(two)) {
      toks.push({ t: 'op', v: two })
      i += 2
      continue
    }
    if ('+-*/%><!(),'.includes(ch)) {
      toks.push({ t: 'op', v: ch })
      i++
      continue
    }
    throw new FormulaError(`无法识别的字符:${ch}`)
  }
  return toks
}

// ── 语法(递归下降;优先级 || < && < 比较 < 加减 < 乘除 < 一元) ──────────────────

type Ast =
  | { t: 'lit'; v: CellValue }
  | { t: 'ref'; name: string }
  | { t: 'un'; op: string; a: Ast }
  | { t: 'bin'; op: string; a: Ast; b: Ast }
  | { t: 'call'; fn: string; args: Ast[] }

function parse(src: string): Ast {
  const toks = lex(src)
  let p = 0
  const peek = (): Tok | undefined => toks[p]
  const isOp = (v: string): boolean => peek()?.t === 'op' && (peek() as { v: string }).v === v
  const eat = (v: string): void => {
    if (!isOp(v)) throw new FormulaError(`期待 ${v}`)
    p++
  }
  const primary = (): Ast => {
    const tk = peek()
    if (!tk) throw new FormulaError('表达式意外结束')
    if (tk.t === 'num' || tk.t === 'str') { p++; return { t: 'lit', v: tk.v } }
    if (tk.t === 'ref') { p++; return { t: 'ref', name: tk.v } }
    if (tk.t === 'ident') {
      p++
      if (tk.v === 'true') return { t: 'lit', v: true }
      if (tk.v === 'false') return { t: 'lit', v: false }
      if (isOp('(')) {
        p++
        const args: Ast[] = []
        if (!isOp(')')) {
          args.push(expr())
          while (isOp(',')) { p++; args.push(expr()) }
        }
        eat(')')
        return { t: 'call', fn: tk.v.toLowerCase(), args }
      }
      // 裸标识符按列引用(单个词的列名可省 {}) —— {销量}*2 也能写 销量*2。
      return { t: 'ref', name: tk.v }
    }
    if (tk.t === 'op' && tk.v === '(') {
      p++
      const e = expr()
      eat(')')
      return e
    }
    if (tk.t === 'op' && (tk.v === '-' || tk.v === '!')) {
      p++
      return { t: 'un', op: tk.v, a: primary() }
    }
    throw new FormulaError(`意外的记号:${String(tk.v)}`)
  }
  const level = (ops: string[], next: () => Ast): (() => Ast) => (): Ast => {
    let a = next()
    for (;;) {
      const tk = peek()
      if (tk?.t === 'op' && ops.includes(tk.v)) {
        p++
        a = { t: 'bin', op: tk.v, a, b: next() }
      } else return a
    }
  }
  // 一元 -/! 由 primary 自己消化(前缀),这里直接以 primary 为最高优先级层。
  const mul = level(['*', '/', '%'], primary)
  const add = level(['+', '-'], mul)
  const cmp = level(['==', '!=', '>', '<', '>=', '<='], add)
  const and = level(['&&'], cmp)
  const or = level(['||'], and)
  const expr = or
  const root = expr()
  if (p < toks.length) throw new FormulaError('表达式尾部有多余内容')
  return root
}

const astCache = new Map<string, Ast>()
function parseCached(src: string): Ast {
  const hit = astCache.get(src)
  if (hit) return hit
  if (astCache.size > 500) astCache.clear() // ponytail: 简单封顶,LRU 等真有几百条公式再说
  const ast = parse(src)
  astCache.set(src, ast)
  return ast
}

// ── 求值 ────────────────────────────────────────────────────────────────────

/** 数值系操作数(可无损当数字):number/null(=0)/boolean(=1/0)。字符串不算 —— `+` 才能区分拼接。 */
const isNumeric = (v: CellValue): v is number | boolean | null => v == null || typeof v === 'number' || typeof v === 'boolean'
const toNum = (v: CellValue): number => {
  if (v == null || v === '') return 0
  if (typeof v === 'number') return v
  if (typeof v === 'boolean') return v ? 1 : 0
  if (typeof v === 'string') {
    const n = Number(v)
    if (Number.isFinite(n)) return n
    throw new FormulaError(`「${v}」不是数字`)
  }
  throw new FormulaError('多选值不能参与算术')
}
const toStr = (v: CellValue): string => (v == null ? '' : Array.isArray(v) ? v.join(', ') : String(v))
const toBool = (v: CellValue): boolean => !(v == null || v === false || v === 0 || v === '' || (Array.isArray(v) && v.length === 0))
const isEmptyV = (v: CellValue): boolean => v == null || v === '' || (Array.isArray(v) && v.length === 0)

export interface EvalOpts {
  /** today() 的返回值(测试注入);缺 = 本机当天 'YYYY-MM-DD'。 */
  today?: string
}

/** 本机当天 'YYYY-MM-DD'(渲染层的午夜换日键也用它,保持同一口径)。 */
export const todayStr = (): string => {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

/** 'YYYY-MM-DD…'(calendarDate 的 start 侧兼容:取前 10 位)→ UTC 毫秒;非日期抛错。 */
const dateMs = (v: CellValue): number => {
  const s = toStr(v).slice(0, 10)
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s)
  if (!m) throw new FormulaError(`「${toStr(v)}」不是日期`)
  return Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]))
}

function evalAst(ast: Ast, get: (name: string) => CellValue, opts: EvalOpts): CellValue {
  const ev = (a: Ast): CellValue => evalAst(a, get, opts)
  switch (ast.t) {
    case 'lit':
      return ast.v
    case 'ref':
      return get(ast.name)
    case 'un': {
      const v = ev(ast.a)
      return ast.op === '-' ? -toNum(v) : !toBool(v)
    }
    case 'bin': {
      const { op } = ast
      if (op === '&&') return toBool(ev(ast.a)) && toBool(ev(ast.b))
      if (op === '||') return toBool(ev(ast.a)) || toBool(ev(ast.b))
      const a = ev(ast.a)
      const b = ev(ast.b)
      if (op === '+') return isNumeric(a) && isNumeric(b) ? toNum(a) + toNum(b) : toStr(a) + toStr(b)
      if (op === '-') return toNum(a) - toNum(b)
      if (op === '*') return toNum(a) * toNum(b)
      if (op === '/') {
        const d = toNum(b)
        if (d === 0) throw new FormulaError('除以 0')
        return toNum(a) / d
      }
      if (op === '%') {
        const d = toNum(b)
        if (d === 0) throw new FormulaError('除以 0') // 不守这条,NaN 会让 == 比较悄悄判「相等」
        return toNum(a) % d
      }
      if (op === '==') return cmpV(a, b) === 0
      if (op === '!=') return cmpV(a, b) !== 0
      if (op === '>') return cmpV(a, b) > 0
      if (op === '<') return cmpV(a, b) < 0
      if (op === '>=') return cmpV(a, b) >= 0
      if (op === '<=') return cmpV(a, b) <= 0
      throw new FormulaError(`未知运算符 ${op}`)
    }
    case 'call': {
      const { fn } = ast
      const args = ast.args
      const n = (i: number): number => toNum(ev(args[i]))
      const s = (i: number): string => toStr(ev(args[i]))
      const need = (k: number): void => {
        if (args.length < k) throw new FormulaError(`${fn} 需要 ${k} 个参数`)
      }
      switch (fn) {
        case 'if': need(3); return toBool(ev(args[0])) ? ev(args[1]) : ev(args[2])
        case 'and': return args.every((a) => toBool(ev(a)))
        case 'or': return args.some((a) => toBool(ev(a)))
        case 'not': need(1); return !toBool(ev(args[0]))
        case 'empty': need(1); return isEmptyV(ev(args[0]))
        case 'round': { need(1); const d = args.length > 1 ? n(1) : 0; const f = 10 ** d; return Math.round(n(0) * f) / f }
        case 'floor': need(1); return Math.floor(n(0))
        case 'ceil': need(1); return Math.ceil(n(0))
        case 'abs': need(1); return Math.abs(n(0))
        case 'min': need(1); return Math.min(...args.map((_, i) => n(i)))
        case 'max': need(1); return Math.max(...args.map((_, i) => n(i)))
        case 'len': { need(1); const v = ev(args[0]); return Array.isArray(v) ? v.length : toStr(v).length }
        case 'lower': need(1); return s(0).toLowerCase()
        case 'upper': need(1); return s(0).toUpperCase()
        case 'trim': need(1); return s(0).trim()
        case 'contains': need(2); return s(0).includes(s(1))
        case 'replace': need(3); return s(0).split(s(1)).join(s(2))
        case 'concat': return args.map((_, i) => s(i)).join('')
        case 'number': need(1); return toNum(ev(args[0]))
        case 'text': need(1); return toStr(ev(args[0]))
        case 'today': return opts.today ?? todayStr()
        case 'days': need(2); return Math.round((dateMs(ev(args[0])) - dateMs(ev(args[1]))) / 86400000)
        default:
          throw new FormulaError(`未知函数 ${fn}`)
      }
    }
  }
}

/** 比较:双数值系走数字,其余走字符串(localeCompare 会把 '10'<'9',这里用普通字典序保持确定性)。 */
function cmpV(a: CellValue, b: CellValue): number {
  if (isNumeric(a) && isNumeric(b)) {
    const x = toNum(a)
    const y = toNum(b)
    return x < y ? -1 : x > y ? 1 : 0
  }
  const x = toStr(a)
  const y = toStr(b)
  return x < y ? -1 : x > y ? 1 : 0
}

/** 单表达式求值:get(名) 返回列值(未知列请抛 FormulaError)。 */
export function evalFormula(src: string, get: (name: string) => CellValue, opts: EvalOpts = {}): CellValue {
  return evalAst(parseCached(src), get, opts)
}

/** 整行公式列物化:返回 { 列id → 计算值 };单列出错 → '#错误'(不连坐);
 *  公式可引用公式列(按需递归),循环引用 → '#循环'。引用按列名优先、列 id 兜底。 */
export function evalRowFormulas(
  columns: DbColumn[],
  cells: Record<string, CellValue>,
  opts: EvalOpts = {},
): Record<string, CellValue> {
  const out: Record<string, CellValue> = {}
  // 出过错的列单独记账:后续列引用它时**重抛**而不是把 '#错误' 哨兵字符串当值参与运算。
  const errs = new Map<string, FormulaError>()
  const visiting = new Set<string>()
  const colByRef = (name: string): DbColumn | undefined =>
    columns.find((c) => c.name === name) ?? columns.find((c) => c.id === name)
  const valueOf = (col: DbColumn): CellValue => {
    if (col.type !== 'formula') return cells[col.id] ?? null
    const err = errs.get(col.id)
    if (err) throw err
    if (col.id in out) return out[col.id]
    if (visiting.has(col.id)) throw new FormulaError('循环引用')
    visiting.add(col.id)
    try {
      const v = col.formula?.trim() ? evalFormula(col.formula, get, opts) : null
      out[col.id] = v
      return v
    } catch (e) {
      const fe = e instanceof FormulaError ? e : new FormulaError(String(e))
      errs.set(col.id, fe)
      throw fe
    } finally {
      visiting.delete(col.id)
    }
  }
  const get = (name: string): CellValue => {
    const col = colByRef(name)
    if (!col) throw new FormulaError(`未知列 {${name}}`)
    return valueOf(col)
  }
  for (const col of columns) {
    if (col.type !== 'formula') continue
    try {
      valueOf(col)
    } catch {
      /* 已入 errs */
    }
  }
  for (const [id, e] of errs) out[id] = e.message === '循环引用' ? '#循环' : '#错误'
  return out
}

/** lookup 聚合:沿关联取到的目标值列表 → 单值。first=首个;join=顿号拼接;count/sum/avg 数值。 */
export function computeLookup(values: CellValue[], agg: string | undefined): CellValue {
  const present = values.filter((v) => !isEmptyV(v))
  switch (agg) {
    case 'count':
      return present.length
    case 'sum':
    case 'avg': {
      const nums = present.map((v) => (typeof v === 'number' ? v : Number(toStr(v)))).filter((x) => Number.isFinite(x))
      if (agg === 'sum') return nums.reduce((a, b) => a + b, 0)
      return nums.length ? nums.reduce((a, b) => a + b, 0) / nums.length : null
    }
    case 'join':
      return present.map(toStr).join('、')
    default:
      return present.length ? present[0] : null
  }
}
