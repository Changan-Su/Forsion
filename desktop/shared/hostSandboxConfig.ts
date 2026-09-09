export interface HostSandboxConfig {
  mode: 'off' | 'workspace-write' | 'read-only'
  network: 'deny' | 'allow'
}

/** Keep invalid persisted security settings visible as errors, never silently disable isolation. */
export function normalizeHostSandboxConfig(value: unknown): HostSandboxConfig {
  if (value == null) return { mode: 'off', network: 'deny' }
  if (typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid hostSandbox configuration')
  const input = value as Record<string, unknown>
  const mode = input.mode === undefined ? 'off' : input.mode
  const network = input.network === undefined ? 'deny' : input.network
  if (typeof mode !== 'string' || typeof network !== 'string' || !['off', 'workspace-write', 'read-only'].includes(mode) || !['deny', 'allow'].includes(network)) {
    throw new Error('Invalid hostSandbox mode or network policy')
  }
  return { mode: mode as HostSandboxConfig['mode'], network: network as HostSandboxConfig['network'] }
}
