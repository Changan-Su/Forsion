import { snapUIValue, type UIBlock, type UICondition, type UIDocument } from '../../../../tangu-agent/src/shared/intelligentUi'

export type UIUserState = {
  values: Record<string, string | number>
  purchased: Record<string, number | true>
  expanded: Record<string, boolean>
}
export const emptyUIState = (): UIUserState => ({ values: {}, purchased: {}, expanded: {} })
const STORAGE = 'forsion_intelligent_ui_v1'
const MAX_STATE = 65_536
type Entry = { key: string; state: UIUserState }
export const uiStateKey = (scope: string, callId: string, documentId: string): string => JSON.stringify([scope, callId, documentId, 1])
export const uiExpansionKey = (kind: 'source' | 'disclosure' | 'image', blockId: string, resourceId?: string): string => JSON.stringify([kind, blockId, resourceId || null])
function stateOf(raw: unknown): UIUserState {
  const out = emptyUIState()
  if (!raw || typeof raw !== 'object') return out
  for (const field of ['values', 'purchased', 'expanded'] as const) {
    const v = (raw as Record<string, unknown>)[field]
    if (!v || typeof v !== 'object' || Array.isArray(v)) continue
    for (const [k, x] of Object.entries(v)) {
      if (k === '__proto__' || k === 'constructor' || k === 'prototype' || k.length > 240) continue
      if (field === 'values' && (typeof x === 'string' && x.length <= 80 || typeof x === 'number' && Number.isFinite(x))) out.values[k] = x as string | number
      if (field === 'purchased' && (x === true || typeof x === 'number' && Number.isFinite(x) && x >= 0)) out.purchased[k] = x
      if (field === 'expanded' && typeof x === 'boolean') out.expanded[k] = x
    }
  }
  return out
}
function entries(storage: Storage): Entry[] {
  const raw = storage.getItem(STORAGE)
  if (!raw || raw.length > MAX_STATE * 48) return []
  let parsed: unknown
  try { parsed = JSON.parse(raw) } catch { return [] }
  return Array.isArray(parsed) ? parsed.filter((v): v is Entry => !!v && typeof v.key === 'string' && v.key.length < 1000).slice(-48) : []
}
export function readUIState(key: string, storage?: Storage): UIUserState {
  try { return stateOf(entries(storage ?? localStorage).find(e => e.key === key)?.state) } catch { return emptyUIState() }
}
export function writeUIState(key: string, state: UIUserState, storage?: Storage): void {
  try {
    if (new TextEncoder().encode(JSON.stringify(state)).length > MAX_STATE) return
    const target = storage ?? localStorage
    target.setItem(STORAGE, JSON.stringify([...entries(target).filter(e => e.key !== key).slice(-47), { key, state }]))
  } catch { /* Storage denied/full: in-memory interactions remain available. */ }
}
export function inputValues(doc: UIDocument, state: UIUserState): Record<string, string | number> {
  return Object.fromEntries(doc.inputs.map(input => {
    const v = state.values[input.id]
    return [input.id, input.kind === 'choice'
      ? input.options.some(o => o.id === v) ? v : input.initial
      : typeof v === 'number' && Number.isFinite(v)
        ? snapUIValue(v, input)
        : input.initial]
  }))
}
export function visible(when: UICondition | undefined, values: Record<string, string | number>): boolean { return !when || values[when.input] === when.equals }
export type ShoppingRow = { key: string; label: string; amount?: number; unit?: string; checked: boolean; shortfall?: number }
export function deriveChecklist(block: Extract<UIBlock, { kind: 'checklist' }>, values: Record<string, string | number>, state: UIUserState): ShoppingRow[] {
  const rows = new Map<string, ShoppingRow>()
  for (const item of block.items) {
    if (!visible(item.when, values)) continue
    const q = item.quantity
    const key = JSON.stringify([block.id, item.itemKey || item.id, q?.unit || null])
    const amount = q ? q.value * (q.scaleBy ? Number(values[q.scaleBy]) / q.base! : 1) : undefined
    const previous = rows.get(key)
    rows.set(key, { key, label: previous?.label || item.label, amount: amount === undefined ? undefined : amount + (previous?.amount || 0), unit: q?.unit, checked: false })
  }
  return [...rows.values()].map(row => {
    const bought = state.purchased[row.key]
    const checked = row.amount === undefined ? bought === true : typeof bought === 'number' && bought + 1e-8 >= row.amount
    return { ...row, checked, shortfall: !checked && typeof bought === 'number' && bought > 0 && row.amount !== undefined ? Math.max(0, row.amount - bought) : undefined }
  })
}
export function formatUIQuantity(value: number): string { return new Intl.NumberFormat(undefined, { maximumFractionDigits: 2 }).format(value) }
