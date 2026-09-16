import { AccountChangedError } from './account'
import { createAccountFetch } from './accountFetch'
import { createCloudAmadeusBridge } from './amadeus/cloudBridge'
import { installCloudCollab } from './amadeus/cloudCollab'
import type { installUnitAccount } from './unitAccount'
import type { AmadeusApi } from '@amadeus-shared/ipc'

export interface UnitCloudCapabilities {
  amadeus?: { adapter: 'forsion-cloud-v1'; apiBase: string; collaboration?: boolean }
  tangu?: { adapter: 'forsion-cloud-v1'; apiBase: string; execution: 'fleet' }
}
type Visitor = Awaited<ReturnType<typeof installUnitAccount>>
type PluginData = { read(id: string): Promise<string | null>; write(id: string, data: string): Promise<void> }

/** Adapt installed cloud services to the existing renderer without creating an
 * account, opening a host filesystem, or changing the Unit's content scope. */
export function installUnitCloudTransport(options: {
  capabilities: UnitCloudCapabilities
  accountApiBase: string
  projectionBase: string
  visitor: Visitor
  pluginData: PluginData
}) {
  const { visitor, capabilities } = options
  const account = visitor.account
  const generation = account.generation
  const scope = new AbortController()
  const identity = account.getIdentity()
  if (!identity || !account.getToken()) throw new Error('Cloud services require a verified visitor account')
  const api = new URL(options.accountApiBase, location.origin)
  if (api.origin !== location.origin || api.username || api.password || api.search || api.hash) throw new Error('Unsupported account endpoint')
  if (!capabilities.amadeus && !capabilities.tangu) throw new Error('No cloud service was declared')
  for (const service of [capabilities.amadeus, capabilities.tangu]) {
    if (!service) continue
    const declared = new URL(service.apiBase, location.origin)
    if (service.adapter !== 'forsion-cloud-v1' || declared.origin !== location.origin || declared.username || declared.password ||
      declared.search || declared.hash || declared.href.replace(/\/+$/, '') !== api.href.replace(/\/+$/, '')) {
      throw new Error('Unsupported cloud service endpoint')
    }
  }
  if (capabilities.tangu && capabilities.tangu.execution !== 'fleet') throw new Error('Unsupported cloud execution mode')
  const apiBase = api.href.replace(/\/+$/, '')
  const assertActive = () => {
    if (scope.signal.aborted || account.generation !== generation || !account.getToken()) throw new AccountChangedError()
  }
  const getToken = () => { assertActive(); return account.getToken() }
  const request = async (path: string, init?: RequestInit) => {
    assertActive()
    return visitor.capability.request(path, init)
  }
  const nativeFetch = window.fetch.bind(window)
  const scopedFetch = createAccountFetch({ apiBase, getToken, request, fallback: nativeFetch })
  window.fetch = scopedFetch
  const offChange = account.subscribe(() => {
    if (account.generation !== generation) scope.abort(new AccountChangedError())
  })
  const stop = () => {
    scope.abort(new AccountChangedError())
    offChange()
    window.removeEventListener('pagehide', stop)
    if (window.fetch === scopedFetch) window.fetch = nativeFetch
  }
  window.addEventListener('pagehide', stop, { once: true })
  const onAuthError = () => {
    if (account.generation === generation) void account.clearSession({ prepare: false }).catch(() => {})
  }
  const bridgeConfig = { apiBase, getToken, request, signal: scope.signal, linkBase: options.projectionBase,
    getUserId: () => { assertActive(); return identity.userId }, onAuthError }
  function ownedMethods<T extends object>(value: T): T {
    return Object.fromEntries(Object.entries(value).map(([key, method]) => [key, typeof method !== 'function' ? method : (...args: unknown[]) => {
      // Unsubscribing/stopping must remain possible after the owner is retired.
      if (key === 'stopHeartbeat') return method(...args)
      assertActive()
      const guarded = args.map((arg) => typeof arg !== 'function' ? arg : (...values: unknown[]) => {
        if (!scope.signal.aborted && account.generation === generation) return arg(...values)
      })
      const result = method(...guarded)
      if (result && typeof result.then === 'function') return result.then((value: unknown) => { assertActive(); return value })
      assertActive()
      return result
    }])) as T
  }
  let amadeus: AmadeusApi | undefined
  if (capabilities.amadeus) {
    const bridge = createCloudAmadeusBridge(bridgeConfig)
    bridge.readPluginData = options.pluginData.read
    bridge.writePluginData = options.pluginData.write
    // Cached reads and callbacks need the same owner boundary as network calls.
    // Leave returned unsubscribe functions callable after disposal.
    amadeus = ownedMethods(bridge)
    if (capabilities.amadeus.collaboration) {
      installCloudCollab(bridgeConfig)
      if (window.amadeusCollab) window.amadeusCollab = ownedMethods(window.amadeusCollab)
    }
  }
  return {
    amadeus, stop,
    config: { mode: 'external' as const, backendUrl: apiBase, token: capabilities.tangu ? getToken() : '', cloudUrl: apiBase, sandbox: 'none' as const },
    getToken, signal: scope.signal,
  }
}
