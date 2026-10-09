/** Forsion Intelligent UI v1. Pure data contract shared by the engine and native renderer.
 * No executable expressions, HTML, styles, network actions or arbitrary component names. */
export type UICondition = { input: string; equals: string | number }
export type UIInput =
  | { id: string; kind: 'number'; label: string; initial: number; min: number; max: number; step: number }
  | { id: string; kind: 'choice'; label: string; initial: string; options: { id: string; label: string; description?: string }[] }
export type UIResource =
  | { id: string; kind: 'image'; url: string; alt: string; sourceId?: string }
  | { id: string; kind: 'source'; url: string; title: string; description?: string }
export type UIQuantity = { value: number; unit: string; scaleBy?: string; base?: number }
export type UICheckItem = { id: string; label: string; itemKey?: string; quantity?: UIQuantity; when?: UICondition }
type BlockBase = { id: string; title?: string; when?: UICondition }
export type UIBlock = BlockBase & (
  | { kind: 'text'; markdown: string }
  | { kind: 'controls'; inputIds: string[] }
  | { kind: 'gallery'; resourceIds: string[] }
  | { kind: 'sources'; resourceIds: string[] }
  | { kind: 'comparison'; items: { id: string; title: string; description: string; imageId?: string; facts: string[] }[] }
  | { kind: 'checklist'; items: UICheckItem[] }
  | { kind: 'disclosure'; markdown: string }
  | { kind: 'actions'; items: ({ id: string; label: string } & (
      | { kind: 'model'; prompt: string } | { kind: 'copy'; text: string } | { kind: 'open'; resourceId: string }
    ))[] }
)
export type UIDocument = { version: 1; id: string; title: string; inputs: UIInput[]; resources: UIResource[]; blocks: UIBlock[] }
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
export function validateUIDocument(raw: unknown, options: { draft?: boolean } = {}): UIDocument {
  if (uiDocumentTooLarge(JSON.stringify(raw) || '')) fail('document', 'too large')
  const d = obj(raw, 'document')
  if (d.version !== 1) fail('version', 'expected 1')
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
        return { id: id(a.id, `${q}.id`), label: str(a.label, `${q}.label`, 160), ...(a.description === undefined ? {} : { description: str(a.description, `${q}.description`, 400) }) }
      }), `${p}.options`)
      const initial = id(o.initial, `${p}.initial`)
      if (!options.some(v => v.id === initial)) fail(p, 'initial must reference an option')
      return { ...common, kind: 'choice', options, initial }
    }
    return fail(p, 'unknown input kind')
  }), 'inputs')
  const inputMap = new Map(inputs.map(x => [x.id, x]))
  const condition = (x: unknown, p: string): UICondition | undefined => {
    if (x === undefined) return undefined
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
  const blocks = unique(list(d.blocks, 'blocks', 40, (v, p): UIBlock => {
    const o = obj(v, p), common: BlockBase = { id: id(o.id, `${p}.id`), ...(o.title === undefined ? {} : { title: str(o.title, `${p}.title`, 200) }), when: condition(o.when, `${p}.when`) }
    switch (o.kind) {
      case 'text': case 'disclosure':
        if (o.kind === 'disclosure' && !common.title) fail(p, 'disclosure requires title')
        return { ...common, kind: o.kind, markdown: str(o.markdown, `${p}.markdown`, 10000) }
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
        return { id: id(a.id, `${q}.id`), label: str(a.label, `${q}.label`, 300), ...(a.itemKey === undefined ? {} : { itemKey: id(a.itemKey, `${q}.itemKey`) }), quantity, when: condition(a.when, `${q}.when`) }
      }), `${p}.items`) }
      case 'actions': return { ...common, kind: 'actions', items: unique(list(o.items, `${p}.items`, 6, (v, q) => {
        const a = obj(v, q), base = { id: id(a.id, `${q}.id`), label: str(a.label, `${q}.label`, 160) }
        if (a.kind === 'model') return { ...base, kind: 'model' as const, prompt: str(a.prompt, `${q}.prompt`, 2000) }
        if (a.kind === 'copy') return { ...base, kind: 'copy' as const, text: str(a.text, `${q}.text`, 10000) }
        if (a.kind === 'open') return { ...base, kind: 'open' as const, resourceId: resourceRef(a.resourceId, `${q}.resourceId`, 'source') }
        return fail(q, 'unknown action kind')
      }), `${p}.items`) }
      default: return fail(p, 'unknown block kind')
    }
  }), 'blocks')
  const controls = blocks.filter((b): b is Extract<UIBlock, { kind: 'controls' }> => b.kind === 'controls')
  if (blocks.reduce((n, b) => n + (b.kind === 'checklist' ? b.items.length : 0), 0) > 200) fail('checklist', 'max 200 items per document')
  const boundInputs = controls.flatMap(b => b.inputIds)
  if (new Set(boundInputs).size !== boundInputs.length) fail('controls', 'each input must appear once')
  if (controls.some(b => b.when)) fail('controls', 'controls must remain visible (no when)')
  if (!options.draft && inputs.some(i => !boundInputs.includes(i.id))) fail('controls', 'every declared input must be included in a controls block')
  return { version: 1, id: id(d.id, 'id'), title: str(d.title, 'title', 200), inputs, resources, blocks }
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
