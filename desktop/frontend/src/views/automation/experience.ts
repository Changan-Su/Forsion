import type { AutomationActionCatalogItem } from '../../types'
import { blankStep, type StepDraft } from './lib'

export type Starter = 'reminder' | 'briefing' | 'table' | 'button'
export const STARTERS: Starter[] = ['reminder', 'briefing', 'table', 'button']

/** Templates are editable drafts. Opening one never creates or enables a rule. */
export function starterSteps(starter: Starter | undefined, t: (key: string) => string): StepDraft[] {
  if (!starter) return [blankStep('notify')]
  if (starter === 'briefing' || starter === 'button') {
    return [{ ...blankStep('agent_run'), prompt: t(`automation.ux.${starter}.prompt`) }]
  }
  return [{ ...blankStep('notify'), title: t(`automation.ux.${starter}.name`), body: t(`automation.ux.${starter}.body`) }]
}

/** One actionable reason per step, shared by the outline and save checklist. */
export function stepIssue(s: StepDraft, kind: string, catalog: AutomationActionCatalogItem[]): string | null {
  if (s.type === 'notify') return s.title.trim() ? null : 'notify'
  if (s.type === 'agent_run') return !s.agentSlug ? 'agent' : !s.prompt.trim() ? 'prompt' : null
  if (s.type === 'db_row_add' || s.type === 'db_row_edit') {
    if (!/\.db$/i.test(s.dbPath.trim())) return 'table'
    if (!s.cells.some((c) => c.k.trim())) return 'cells'
    if (s.type === 'db_row_edit') {
      if (kind !== 'db_changed' && (!s.rowId.trim() && !s.matchColumn.trim() || s.rowFrom.trim())) return 'row'
      if (s.matchColumn.trim() && !s.matchValue.trim()) return 'match'
    }
    return null
  }
  const cat = catalog.find((c) => c.name === s.tool)
  if (!cat) return 'tool'
  if ((cat.parameters.required || []).some((k) => !(s.argValues[k] || '').trim())) return 'args'
  for (const [key, value] of Object.entries(s.argValues)) {
    if (!value.trim()) continue
    const schema = cat.parameters.properties?.[key]
    if (schema?.type === 'number' && !Number.isFinite(Number(value))) return 'args'
    if (schema?.type === 'object' || schema?.type === 'array') {
      try {
        const parsed: unknown = JSON.parse(value)
        if (schema.type === 'array' ? !Array.isArray(parsed) : !parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return 'json'
      } catch { return 'json' }
    }
  }
  return null
}

/** Use stable column IDs; names containing spaces aren't valid engine variable tokens. */
export function templateVariables(columns?: { id: string; name: string }[]): { value: string; label: string }[] {
  return (columns || []).map((c) => ({ value: `{{row.${c.id}}}`, label: c.name }))
}
