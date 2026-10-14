/** Explicit per-call routing must override the global slot, without changing it. */
export function asrBackendFor(globalBackend: string | undefined, requested: 'local' | 'cloud' | undefined, localReady: boolean): 'local' | 'cloud' {
  if (requested != null && requested !== 'local' && requested !== 'cloud') throw new Error('Invalid speech recognition backend')
  if (requested === 'cloud') return 'cloud'
  if (requested === 'local') {
    if (!localReady) throw new Error('On-device speech recognition model is not ready')
    return 'local'
  }
  return globalBackend === 'local' && localReady ? 'local' : 'cloud'
}
