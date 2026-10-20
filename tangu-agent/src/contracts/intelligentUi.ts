/** Forsion Intelligent UI v1 / v2. Pure data contract shared by the engine and native renderer.
 * No HTML, styles, network actions or arbitrary component names. v1 has no expressions; v2 adds
 * state, derived values and expressions over a fixed function list (intelligentUiExpr.ts). */
import { validAppCardId } from './intelligentCards.js'
import { compileExpr, documentScope, EXPR_LIMITS, interpolationSources, reservedUIName, UI_NAME, uiValueIssue, type ExprScope, type UIValue } from './intelligentUiExpr.js'
export type { UIValue } from './intelligentUiExpr.js'
export type UICondition = { input: string; equals: string | number } | { expr: string }
export type UIStateVar = { id: string; initial: UIValue }
export type UIDerived = { id: string; expr: string }
export type UISetStep = { set: string; to: string } | { toggle: string; value?: string } | { append: string; value: string } | { remove: string; value: string } | { reset: string }
export type UIInput =
  | { id: string; kind: 'number'; label: string; initial: number; min: number; max: number; step: number }
  | { id: string; kind: 'choice'; label: string; initial: string; options: { id: string; label: string; description?: string; imageId?: string }[] }
export type UIResource =
  | { id: string; kind: 'image'; url: string; alt: string; sourceId?: string }
  | { id: string; kind: 'source'; url: string; title: string; description?: string }
export type UIQuantity = { value: number; unit: string; scaleBy?: string; base?: number }
export type UICheckItem = { id: string; label: string; itemKey?: string; quantity?: UIQuantity; when?: UICondition }
type BlockBase = { id: string; title?: string; when?: UICondition }
export type UIBlock = BlockBase & (
  | { kind: 'text'; markdown: string }
  | { kind: 'app-card'; cardId: string; query?: string }
  | { kind: 'controls'; inputIds: string[] }
  | { kind: 'gallery'; resourceIds: string[] }
  | { kind: 'sources'; resourceIds: string[] }
  | { kind: 'comparison'; items: { id: string; title: string; description: string; imageId?: string; facts: string[] }[] }
  | { kind: 'checklist'; items: UICheckItem[] }
  | { kind: 'disclosure'; markdown: string }
  | { kind: 'stats'; items: { label: string; value: string }[] }
  /** rows: an expression giving one list of cells per row, or the rows written out (cell text may hold {{ }}). */
  | { kind: 'table'; columns: string[]; rows: string | string[][] }
  | { kind: 'actions'; items: ({ id: string; label: string } & (
      | { kind: 'model'; prompt: string } | { kind: 'copy'; text: string } | { kind: 'open'; resourceId: string }
      | { kind: 'set'; steps: UISetStep[]; disabled?: string }
    ))[] }
)
export type UIDocument = { version: 1 | 2; id: string; title: string; inputs: UIInput[]; state?: UIStateVar[]; derived?: UIDerived[]; resources: UIResource[]; blocks: UIBlock[] }
/** Highest document version this build reads. Engines accept 2 only from clients that announce intelligent-ui.v2. */
export const UI_VERSION = 2
export const UI_DOCUMENT_LIMIT = 65_536
export const uiDocumentTooLarge = (text: string): boolean => new TextEncoder().encode(text).length > UI_DOCUMENT_LIMIT
const ID = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,79}$/
const forbiddenId = new Set(['__proto__', 'constructor', 'prototype'])
function fail(path: string, expected: string): never { throw new Error(`${path}: ${expected}`) }
function obj(x: unknown, p: string): Record<string, unknown> {
  if (!x || typeof x !== 'object' || Array.isArray(x)) fail(p, 'expected object')
  return x as Record<string, unknown>
}
function str(x: unknown, p: string, max = 4000): string {
  if (typeof x !== 'string' || !x.trim() || x.length > max) fail(p, `expected nonempty string (max ${max})`)
  return x
}
function id(x: unknown, p: string): string {
  const s = str(x, p, 80)
  if (!ID.test(s) || forbiddenId.has(s)) fail(p, 'invalid ID')
  return s
}
function num(x: unknown, p: string, min = 0, max = 1e9): number {
  if (typeof x !== 'number' || !Number.isFinite(x) || x < min || x > max) fail(p, `expected number in ${min}…${max}`)
  return x
}
function list<T>(x: unknown, p: string, max: number, parse: (x: unknown, p: string) => T): T[] {
  if (!Array.isArray(x) || x.length > max) fail(p, `expected array (max ${max})`)
  return x.map((v, i) => parse(v, `${p}[${i}]`))
}
function unique<T extends { id: string }>(xs: T[], p: string): T[] {
  if (new Set(xs.map(x => x.id)).size !== xs.length) fail(p, 'duplicate IDs')
  return xs
}
/** Public HTTPS only. Browser loads images; engine never fetches model-supplied URLs.
 * Reject literal private addresses and credentials. DNS/redirect policy remains the browser's. */
export function safeUIUrl(x: unknown): x is string {
  if (typeof x !== 'string' || x.length > 2048) return false
  try {
    const u = new URL(x), h = u.hostname.toLowerCase().replace(/\.+$/, '')
    return u.protocol === 'https:' && !u.username && !u.password && (!u.port || u.port === '443')
      && h.includes('.') && !h.endsWith('.local') && !h.endsWith('.localhost') && !h.endsWith('.internal')
      && !/^[\d.]+$/.test(h) && !h.includes(':')
  } catch { return false }
}
const V2_BLOCKS = new Set(['stats', 'table'])
function usesVersion2(d: Record<string, unknown>): boolean {
  if (d.state !== undefined || d.derived !== undefined) return true
  const blocks = Array.isArray(d.blocks) ? d.blocks as Record<string, unknown>[] : []
  const exprWhen = (x: unknown): boolean => !!x && typeof x === 'object' && (x as Record<string, unknown>).expr !== undefined
  return blocks.some(b => !!b && (V2_BLOCKS.has(b.kind as string) || exprWhen(b.when)
    || (Array.isArray(b.items) && b.items.some((a: Record<string, unknown>) => a?.kind === 'set' || exprWhen(a?.when)
      || (b.kind === 'checklist' && typeof a?.label === 'string' && a.label.includes('{{'))))))
}
export function validateUIDocument(raw: unknown, options: { draft?: boolean; maxVersion?: number } = {}): UIDocument {
  if (uiDocumentTooLarge(JSON.stringify(raw) || '')) fail('document', 'too large')
  const d = obj(raw, 'document')
  const maxVersion = options.maxVersion ?? UI_VERSION
  if (d.version !== 1 && !(d.version === 2 && maxVersion >= 2)) fail('version', maxVersion >= 2 ? 'expected 1 or 2' : 'expected 1 (this client renders version 1 only)')
  // A version 1 document that uses version 2 parts is read as version 2 where 2 is allowed (live 10-20:
  // a model wrote version 1 with a stats block and gave up after the rejection).
  const v2 = d.version === 2 || (maxVersion >= 2 && usesVersion2(d))
  const expr = (x: unknown, p: string, scope: ExprScope): string => {
    // A plain JSON value where an expression goes ("to": 0, "value": true) is that value (live 10-20).
    const src = typeof x === 'string' || x === undefined ? x : JSON.stringify(x)
    try { compileExpr(src, scope) } catch (e) { fail(p, e instanceof Error ? e.message : String(e)) }
    return src as string
  }
  /** A shown value: an expression, or text with {{ }} slots (models write both for stats). */
  const display = (x: unknown, p: string, scope: ExprScope): string => {
    if (typeof x !== 'string' || !x.includes('{{')) return expr(x, p, scope)
    for (const src of interpolationSources(str(x, p, 400))) expr(src, `${p} {{${src.slice(0, 40)}}}`, scope)
    return x
  }
  const inputs = unique(list(d.inputs, 'inputs', 8, (v, p): UIInput => {
    const o = obj(v, p), common = { id: id(o.id, `${p}.id`), label: str(o.label, `${p}.label`, 160) }
    if (o.kind === 'number') {
      const min = num(o.min, `${p}.min`), max = num(o.max, `${p}.max`, min), step = num(o.step, `${p}.step`, 0.001)
      const initial = num(o.initial, `${p}.initial`, min, max)
      const ticks = (initial - min) / step
      if (Math.abs(ticks - Math.round(ticks)) > 1e-6 || step > Math.max(max - min, 1)) fail(p, 'initial must align to step')
      return { ...common, kind: 'number', min, max, step, initial }
    }
    if (o.kind === 'choice') {
      const options = unique(list(o.options, `${p}.options`, 8, (v, q) => {
        const a = obj(v, q)
        return { id: id(a.id, `${q}.id`), label: str(a.label, `${q}.label`, 160), ...(a.description === undefined ? {} : { description: str(a.description, `${q}.description`, 400) }), ...(a.imageId === undefined ? {} : { imageId: id(a.imageId, `${q}.imageId`) }) }
      }), `${p}.options`)
      // Picture options render as one row of selectable cards; a mixed row has no sensible layout.
      if (options.some(v => v.imageId) && !options.every(v => v.imageId)) fail(p, 'imageId must be set on every option or none')
      const initial = id(o.initial, `${p}.initial`)
      if (!options.some(v => v.id === initial)) fail(p, 'initial must reference an option')
      return { ...common, kind: 'choice', options, initial }
    }
    return fail(p, 'unknown input kind')
  }), 'inputs')
  const inputMap = new Map(inputs.map(x => [x.id, x]))
  // v2 names: declared after inputs, before blocks, so a streamed prefix knows them before any block uses them.
  const names = new Set<string>()
  const declare = (x: unknown, p: string): string => {
    const name = str(x, p, 40)
    if (!UI_NAME.test(name)) fail(p, `"${name}" is not a name (letters, digits, underscore; not starting with a digit)`)
    if (reservedUIName(name)) fail(p, `"${name}" is a keyword`)
    if (names.has(name) || inputMap.has(name)) fail(p, `"${name}" is already declared`)
    names.add(name)
    return name
  }
  const state = !v2 || d.state === undefined ? [] : list(d.state, 'state', 16, (v, p) => {
    const o = obj(v, p), issue = uiValueIssue(o.initial)
    if (o.initial === undefined || issue) fail(`${p}.initial`, issue || 'required')
    return { id: declare(o.id, `${p}.id`), initial: o.initial as UIValue }
  })
  const inputIds = new Set(inputs.map(i => i.id))
  const derived = !v2 || d.derived === undefined ? [] : list(d.derived, 'derived', 32, (v, p) => {
    const o = obj(v, p), source = expr(o.expr, `${p}.expr`, { inputs: inputIds, names: new Set(names) })
    return { id: declare(o.id, `${p}.id`), expr: source }
  })
  const scope = documentScope({ inputs, state, derived })
  const markdown = (x: unknown, p: string): string => {
    const text = str(x, p, 10000)
    if (v2) for (const src of interpolationSources(text)) expr(src, `${p} {{${src.slice(0, 40)}}}`, scope)
    return text
  }
  const condition = (x: unknown, p: string): UICondition | undefined => {
    if (x === undefined) return undefined
    if (v2 && (x as Record<string, unknown> | null)?.expr !== undefined) return { expr: expr(obj(x, p).expr, `${p}.expr`, scope) }
    const o = obj(x, p), input = id(o.input, `${p}.input`), target = inputMap.get(input)
    if (!target) fail(p, 'unknown input')
    if (target.kind === 'choice' ? !target.options.some(v => v.id === o.equals) : typeof o.equals !== 'number' || o.equals < target.min || o.equals > target.max) fail(p, 'invalid condition value')
    return { input, equals: o.equals as string | number }
  }
  const resources = unique(list(d.resources, 'resources', 24, (v, p): UIResource => {
    const o = obj(v, p), common = { id: id(o.id, `${p}.id`), url: str(o.url, `${p}.url`, 2048) }
    if (!safeUIUrl(common.url)) fail(p, 'expected public HTTPS URL without credentials')
    if (o.kind === 'image') return { ...common, kind: 'image', alt: str(o.alt, `${p}.alt`, 400), ...(o.sourceId === undefined ? {} : { sourceId: id(o.sourceId, `${p}.sourceId`) }) }
    if (o.kind === 'source') return { ...common, kind: 'source', title: str(o.title, `${p}.title`, 200), ...(o.description === undefined ? {} : { description: str(o.description, `${p}.description`) }) }
    return fail(p, 'unknown resource kind')
  }), 'resources')
  const resourceMap = new Map(resources.map(x => [x.id, x]))
  const resourceRef = (v: unknown, p: string, kind: UIResource['kind']): string => {
    const ref = id(v, p)
    if (resourceMap.get(ref)?.kind !== kind) fail(p, `expected ${kind} resource reference`)
    return ref
  }
  for (const r of resources) if (r.kind === 'image' && r.sourceId) resourceRef(r.sourceId, `${r.id}.sourceId`, 'source')
  for (const i of inputs) if (i.kind === 'choice') for (const o of i.options) if (o.imageId) resourceRef(o.imageId, `${i.id}.${o.id}.imageId`, 'image')
  const parsed = unique(list(d.blocks, 'blocks', 40, (v, p): UIBlock => {
    const o = obj(v, p), common: BlockBase = { id: id(o.id, `${p}.id`), ...(o.title === undefined ? {} : { title: str(o.title, `${p}.title`, 200) }), when: condition(o.when, `${p}.when`) }
    switch (o.kind) {
      case 'app-card':
        if (!validAppCardId(o.cardId)) fail(p, 'invalid registered card ID')
        return { ...common, kind: 'app-card', cardId: o.cardId as string, ...(o.query === undefined ? {} : { query: str(o.query, `${p}.query`, 200) }) }
      case 'text': case 'disclosure':
        if (o.kind === 'disclosure' && !common.title) fail(p, 'disclosure requires title')
        return { ...common, kind: o.kind, markdown: markdown(o.markdown, `${p}.markdown`) }
      case 'stats': if (!v2) break
        return { ...common, kind: 'stats', items: list(o.items, `${p}.items`, 4, (v, q) => {
          const a = obj(v, q)
          return { label: str(a.label, `${q}.label`, 80), value: display(a.value, `${q}.value`, scope) }
        }) }
      case 'table': {
        if (!v2) break
        // Models write a fixed table as {id,label} columns and rows of cell text (live 10-20); both are taken.
        const cols = list(o.columns, `${p}.columns`, 6, (v, q) => v && typeof v === 'object' ? obj(v, q) : { label: v })
        const columns = cols.map((c, i) => str(c.label ?? c.title ?? c.name, `${p}.columns[${i}]`, 80))
        const cell = (c: unknown, q: string): string => {
          if (c == null || c === '') return ''
          const text = typeof c === 'number' || typeof c === 'boolean' ? String(c) : str(c, q, 400)
          for (const src of interpolationSources(text)) expr(src, `${q} {{${src.slice(0, 40)}}}`, scope)
          return text
        }
        const rows = !Array.isArray(o.rows) ? expr(o.rows, `${p}.rows`, scope) : list(o.rows, `${p}.rows`, EXPR_LIMITS.rows, (r, q) => {
          const cells = Array.isArray(r) ? r : r && typeof r === 'object' ? cols.map(c => (r as Record<string, unknown>)[String(c.id)]) : fail(q, 'expected a list of cells')
          if (cells.length !== columns.length) fail(q, `${cells.length} cells for ${columns.length} columns`)
          return cells.map((c, i) => cell(c, `${q}[${i}]`))
        })
        return { ...common, kind: 'table', columns, rows }
      }
      case 'controls': return { ...common, kind: 'controls', inputIds: list(o.inputIds, `${p}.inputIds`, 8, (v, q) => {
        const ref = id(v, q); if (!inputMap.has(ref)) fail(q, 'unknown input'); return ref
      }) }
      case 'gallery': case 'sources': return { ...common, kind: o.kind, resourceIds: list(o.resourceIds, `${p}.resourceIds`, 12, (v, q) => resourceRef(v, q, o.kind === 'gallery' ? 'image' : 'source')) }
      case 'comparison': return { ...common, kind: 'comparison', items: unique(list(o.items, `${p}.items`, 6, (v, q) => {
        const a = obj(v, q)
        return { id: id(a.id, `${q}.id`), title: str(a.title, `${q}.title`, 200), description: str(a.description, `${q}.description`, 1000), facts: list(a.facts, `${q}.facts`, 8, (v, r) => str(v, r, 400)), ...(a.imageId === undefined ? {} : { imageId: resourceRef(a.imageId, `${q}.imageId`, 'image') }) }
      }), `${p}.items`) }
      case 'checklist': return { ...common, kind: 'checklist', items: unique(list(o.items, `${p}.items`, 100, (v, q): UICheckItem => {
        const a = obj(v, q)
        let quantity: UIQuantity | undefined
        if (a.quantity !== undefined) {
          const n = obj(a.quantity, `${q}.quantity`)
          quantity = { value: num(n.value, `${q}.quantity.value`), unit: str(n.unit, `${q}.quantity.unit`, 32) }
          if (n.scaleBy !== undefined) {
            quantity.scaleBy = id(n.scaleBy, `${q}.quantity.scaleBy`)
            if (inputMap.get(quantity.scaleBy)?.kind !== 'number') fail(q, 'scaleBy must reference number input')
            quantity.base = num(n.base, `${q}.quantity.base`, 0.001)
          }
        }
        // v2:条目文字里的 {{ }} 照算(live 10-20:模型把随人数变的量直接写进清单文字,原样显示成一串大括号)
        const label = str(a.label, `${q}.label`, 300)
        if (v2) for (const src of interpolationSources(label)) expr(src, `${q}.label {{${src.slice(0, 40)}}}`, scope)
        return { id: id(a.id, `${q}.id`), label, ...(a.itemKey === undefined ? {} : { itemKey: id(a.itemKey, `${q}.itemKey`) }), quantity, when: condition(a.when, `${q}.when`) }
      }), `${p}.items`) }
      case 'actions': return { ...common, kind: 'actions', items: unique(list(o.items, `${p}.items`, 6, (v, q) => {
        const a = obj(v, q), base = { id: id(a.id, `${q}.id`), label: str(a.label, `${q}.label`, 160) }
        if (a.kind === 'model') return { ...base, kind: 'model' as const, prompt: str(a.prompt, `${q}.prompt`, 2000) }
        if (a.kind === 'copy') return { ...base, kind: 'copy' as const, text: str(a.text, `${q}.text`, 10000) }
        if (a.kind === 'open') return { ...base, kind: 'open' as const, resourceId: resourceRef(a.resourceId, `${q}.resourceId`, 'source') }
        if (a.kind === 'set' && v2) {
          const target = (x: unknown, r: string): string => { const t = str(x, r, 40); if (!state.some(s => s.id === t)) fail(r, 'expected a state name'); return t }
          const steps = list(a.steps, `${q}.steps`, 8, (v, r): UISetStep => {
            const s = obj(v, r)
            if (s.set !== undefined) return { set: target(s.set, `${r}.set`), to: expr(s.to, `${r}.to`, scope) }
            if (s.toggle !== undefined) return { toggle: target(s.toggle, `${r}.toggle`), ...(s.value === undefined ? {} : { value: expr(s.value, `${r}.value`, scope) }) }
            if (s.append !== undefined) return { append: target(s.append, `${r}.append`), value: expr(s.value, `${r}.value`, scope) }
            if (s.remove !== undefined) return { remove: target(s.remove, `${r}.remove`), value: expr(s.value, `${r}.value`, scope) }
            if (s.reset !== undefined) return { reset: target(s.reset, `${r}.reset`) }
            return fail(r, 'expected one of set, toggle, append, remove, reset')
          })
          if (!steps.length) fail(`${q}.steps`, 'expected at least one step')
          return { ...base, kind: 'set' as const, steps, ...(a.disabled === undefined ? {} : { disabled: expr(a.disabled, `${q}.disabled`, scope) }) }
        }
        return fail(q, 'unknown action kind')
      }), `${p}.items`) }
    }
    return fail(p, `unknown block kind ${JSON.stringify(o.kind)} — use ${v2 ? 'text, controls, stats, table, gallery, sources, comparison, checklist, disclosure, actions, app-card' : 'text, controls, gallery, sources, comparison, checklist, disclosure, actions, app-card'}`)
  }), 'blocks')
  if (parsed.some(b => b.kind === 'controls' && b.when)) fail('controls', 'controls must remain visible (no when)')
  // An input shown again in a later controls block is dropped there, not rejected: models restate the
  // same inputs next to the closing action (live 2026-10-13), and a rejected call leaves a broken
  // first view above the rewritten one. The first place an input is shown wins. A block emptied this
  // way goes only if it carries no title of its own; a block written empty is left as it was.
  const shown = new Set<string>()
  const blocks = parsed.flatMap((b): UIBlock[] => {
    if (b.kind !== 'controls') return [b]
    const inputIds = b.inputIds.filter(i => !shown.has(i) && !!shown.add(i))
    return inputIds.length || b.title || !b.inputIds.length ? [{ ...b, inputIds }] : []
  })
  const controls = blocks.filter((b): b is Extract<UIBlock, { kind: 'controls' }> => b.kind === 'controls')
  if (blocks.reduce((n, b) => n + (b.kind === 'checklist' ? b.items.length : 0), 0) > 200) fail('checklist', 'max 200 items per document')
  const boundInputs = controls.flatMap(b => b.inputIds)
  if (!options.draft && inputs.some(i => !boundInputs.includes(i.id))) fail('controls', 'every declared input must be included in a controls block')
  const head = { id: id(d.id, 'id'), title: str(d.title, 'title', 200), inputs }
  return v2 ? { version: 2, ...head, state, derived, resources, blocks } : { version: 1, ...head, resources, blocks }
}

/** Parse only complete JSON properties and complete array members. No repairs of model tokens.
 * The metadata must precede blocks. A truncated/invalid block cannot make later blocks interactive. */
export function parseUIDraft(text: string): UIDocument | undefined {
  if (uiDocumentTooLarge(text)) return undefined
  let quoted = false, escaped = false, depth = 0, arrayStart = -1
  const ends: number[] = []
  for (let i = 0; i < text.length; i++) {
    const c = text[i]
    if (quoted) { if (escaped) escaped = false; else if (c === '\\') escaped = true; else if (c === '"') quoted = false; continue }
    if (c === '"') { quoted = true; continue }
    if (c === '{' || c === '[') {
      // A top-level blocks array; JSON.parse below verifies its prefix and all required fields.
      if (c === '[' && depth === 1 && /"blocks"\s*:\s*$/.test(text.slice(0, i))) arrayStart = i
      depth++
    } else if (c === '}' || c === ']') {
      depth--
      if (arrayStart >= 0 && depth === 2 && c === '}') ends.push(i)
      if (arrayStart >= 0 && depth === 1) break
    }
  }
  if (arrayStart < 0) return undefined
  // The same recovery works during streaming and persisted replay: keep the longest valid prefix.
  for (const end of [...ends.reverse(), arrayStart]) {
    try { return validateUIDocument(JSON.parse(text.slice(0, end + 1) + ']}'), { draft: true }) } catch { /* try the previous complete unit */ }
  }
  return undefined
}

/** Keep values on the declared grid without accumulating IEEE-754 error on repeated clicks. */
export function snapUIValue(value: number, input: Extract<UIInput, { kind: 'number' }>): number {
  const maxTicks = Math.floor((input.max - input.min) / input.step + 1e-6)
  const ticks = Math.max(0, Math.min(maxTicks, Math.round((value - input.min) / input.step)))
  return Number((input.min + ticks * input.step).toPrecision(15))
}
