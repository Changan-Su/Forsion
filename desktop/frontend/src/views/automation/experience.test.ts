import { describe, expect, it } from 'vitest'
import { blankStep, buildToolArgs, toSpec } from './lib'
import { starterSteps, stepIssue, templateVariables } from './experience'
import type { AutomationActionCatalogItem } from '../../types'

describe('workflow setup', () => {
  it('never invents an agent or saves a template before the user selects one', () => {
    const [step] = starterSteps('briefing', (key) => key)
    expect(stepIssue(step, 'timer', [])).toBe('agent')
    step.agentSlug = 'writer'
    expect(stepIssue(step, 'timer', [])).toBeNull()
  })
  it('keeps templates independent when users edit their steps', () => {
    const a = starterSteps('reminder', (key) => key)
    const b = starterSteps('reminder', (key) => key)
    a[0].title = 'Changed'
    expect(b[0].title).not.toBe(a[0].title)
    expect(b[0].key).not.toBe(a[0].key)
    expect(toSpec(b, [])[0].type).toBe('notify')
  })
  it('explains incomplete database targets and row-context mismatches', () => {
    const step = blankStep('db_row_edit')
    expect(stepIssue(step, 'manual', [])).toBe('table')
    step.dbPath = 'tasks.db'
    expect(stepIssue(step, 'manual', [])).toBe('cells')
    step.cells = [{ k: 'status', v: 'Done' }]
    expect(stepIssue(step, 'manual', [])).toBe('row')
    expect(stepIssue(step, 'db_changed', [])).toBeNull()
    step.matchColumn = 'name'
    expect(stepIssue(step, 'db_changed', [])).toBe('match')
  })
  it('does not treat explicit false as a missing required tool argument', () => {
    const cat: AutomationActionCatalogItem = { name: 'test', description: '', parameters: { required: ['enabled'], properties: { enabled: { type: 'boolean' }, config: { type: 'object' } } } }
    const step = { ...blankStep('tool_call'), tool: cat.name, argValues: { enabled: 'false', config: '{}' } }
    expect(stepIssue(step, 'manual', [cat])).toBeNull()
    expect(buildToolArgs(cat, step.argValues)).toEqual({ enabled: false, config: {} })
    step.argValues.config = '['
    expect(stepIssue(step, 'manual', [cat])).toBe('json')
    step.argValues.config = 'null'
    expect(stepIssue(step, 'manual', [cat])).toBe('json')
  })
  it('inserts stable IDs even when display names are not valid variable names', () => {
    expect(templateVariables([{ id: 'c-123', name: 'Client name / 客户名称' }])).toEqual([{ value: '{{row.c-123}}', label: 'Client name / 客户名称' }])
    expect(templateVariables()).toEqual([])
  })
})
