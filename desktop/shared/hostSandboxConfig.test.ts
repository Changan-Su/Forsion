import { describe, expect, it } from 'vitest'
import { normalizeHostSandboxConfig } from './hostSandboxConfig'

describe('local sandbox persisted settings', () => {
  it('preserves legacy direct execution and defaults restricted modes to no network', () => {
    expect(normalizeHostSandboxConfig(undefined)).toEqual({ mode: 'off', network: 'deny' })
    expect(normalizeHostSandboxConfig({ mode: 'workspace-write' })).toEqual({ mode: 'workspace-write', network: 'deny' })
  })
  it('refuses malformed policy instead of silently disabling protection', () => {
    for (const value of ['read-only', [], { mode: 'workspce-write' }, { network: true }, { mode: null }, { network: null }, { mode: ['off'] }, { network: ['allow'] }]) {
      expect(() => normalizeHostSandboxConfig(value)).toThrow('Invalid hostSandbox')
    }
  })
})
