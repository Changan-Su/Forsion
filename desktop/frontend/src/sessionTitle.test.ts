import { describe, expect, it } from 'vitest'
import { displaySessionTitle, workspaceGroupLabel } from './sessionTitle'

const t = (k: string) => `<${k}>`

describe('display-only session / group labels (U-30 A, U-38b)', () => {
  it('maps empty and the engine placeholder title to the localized untitled label', () => {
    expect(displaySessionTitle('New Chat', t)).toBe('<session.untitled>')
    expect(displaySessionTitle('', t)).toBe('<session.untitled>')
    expect(displaySessionTitle(null, t)).toBe('<session.untitled>')
    expect(displaySessionTitle('  ', t)).toBe('<session.untitled>')
  })
  it('keeps real titles untouched', () => {
    expect(displaySessionTitle('New Chat about taxes', t)).toBe('New Chat about taxes')
    expect(displaySessionTitle('周报', t)).toBe('周报')
  })
  it('only the rootless group header is renamed; the stored name is kept for everything else', () => {
    expect(workspaceGroupLabel({ kind: 'rootless', name: '不在项目中工作' }, t)).toBe('<session.rootlessGroup>')
    expect(workspaceGroupLabel({ kind: 'local', name: 'Forsion' }, t)).toBe('Forsion')
  })
})
