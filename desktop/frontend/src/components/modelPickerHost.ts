/** Optional host presentation. Content, catalog and mutations remain owned by each caller. */
export interface PickerOption { value: string; label: string; detail?: string; badge?: string }
export interface PickerGroup { label: string; options: PickerOption[] }
export interface PickerField { id: string; label: string; value: string; groups: PickerGroup[] }
export interface ModelPickerRequest {
  title: string
  labels: { done: string; search: string; empty: string; back: string; advanced: string }
  fields: PickerField[]
  footnote?: string
  theme: { dark: boolean; accent: string }
}
export type ModelPickerValues = Record<string, string>
export type ModelPickerPresenter = (request: ModelPickerRequest, signal: AbortSignal) => Promise<ModelPickerValues | null>
let presenter: ModelPickerPresenter | undefined
export function installModelPickerPresenter(next: ModelPickerPresenter): () => void {
  presenter = next
  return () => { if (presenter === next) presenter = undefined }
}
export function modelPickerPresenter(): ModelPickerPresenter | undefined { return presenter }

/** Fail the complete response if a native/old host returns values outside this request's catalog.
 * Unknown pre-existing selections may be preserved, never introduced. Only return changes. */
export function pickerChanges(request: ModelPickerRequest, result: unknown): ModelPickerValues | null {
  if (!result || typeof result !== 'object' || Array.isArray(result)) return null
  const values = result as Record<string, unknown>
  if (Object.keys(values).some(id => !request.fields.some(f => f.id === id))) return null
  const changes: ModelPickerValues = {}
  for (const f of request.fields) {
    const value = values[f.id]
    if (typeof value !== 'string') return null
    if (value === f.value) continue
    if (!f.groups.some(g => g.options.some(o => o.value === value))) return null
    changes[f.id] = value
  }
  return changes
}
