/** The host waits for every window before changing credentials or the cloud vault. */
export function installAccountTransition(): () => void {
  if (!window.tangu?.onAuthWillChange) return () => {}
  let cloudWasOpen = false
  let lockedRoot: HTMLElement | null = null
  let previousInert = false
  let version = 0
  let restoring: Promise<void> = Promise.resolve()
  let disposed = false
  const release = (): void => {
    if (lockedRoot) lockedRoot.inert = previousInert
    lockedRoot = null
  }
  const offPrepare = window.tangu.onAuthWillChange(async () => {
    const request = ++version
    if (!lockedRoot) {
      // Menus/dialogs are portaled outside #root; freeze those editors as well.
      lockedRoot = document.body
      previousInert = lockedRoot?.inert ?? false
      if (lockedRoot) lockedRoot.inert = true
    }
    try {
      // A second switch can arrive before the previous restore finishes loading.
      // Drain it before flushing; otherwise it can reopen old documents after our reset.
      await restoring
      if (request !== version || disposed) return
      if (!window.amadeus) return
      const [{ flushAllScopes, resetAllScopeDocs, usePageStore }, { useDbStore }, { useDrawStore }, lifecycle] = await Promise.all([
        import('../amadeus/store/pageStore'), import('../amadeus/store/dbStore'),
        import('../amadeus/store/drawingStore'), import('../amadeus/unified/lifecycle'),
      ])
      await Promise.all([flushAllScopes(true), useDbStore.getState().flushAll(true), useDrawStore.getState().flushAll(true)])
      if (request !== version) return // The host cancelled/timed out while saving.
      cloudWasOpen = usePageStore.getState().vaultSide === 'cloud'
      if (cloudWasOpen) {
        lifecycle.retireAllUnifiedScopes()
        resetAllScopeDocs()
        usePageStore.setState({ vaultRoot: null, pages: [], folders: [], files: [], icons: {} })
      }
    } catch (error) {
      if (request === version) release()
      throw error
    }
  })
  const offChanged = window.tangu.onAuthChanged?.(() => {
    const request = ++version
    if (!cloudWasOpen) {
      void restoring.finally(() => { if (request === version) release() })
      return
    }
    cloudWasOpen = false
    restoring = restoring.then(async () => {
      const { usePageStore } = await import('../amadeus/store/pageStore')
      if (disposed) return
      await usePageStore.getState().restoreVault()
      await usePageStore.getState().initVaultSide()
    }).catch((error) => console.error('[auth] Cannot restore vault after account change:', error))
      .finally(() => { if (request === version) release() })
  })
  return () => { disposed = true; ++version; offPrepare(); offChanged?.(); release() }
}
