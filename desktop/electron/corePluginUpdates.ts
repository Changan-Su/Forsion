import type { CorePluginUpdate, CorePluginUpdates } from '../shared/corePlugins'

/** One process-wide run for the tray, settings, startup and timer. Failures remain visible per package. */
export function createCorePluginUpdater(options: {
  items: CorePluginUpdate[]
  enabled: boolean
  run: (report: (item: CorePluginUpdate) => void) => Promise<unknown>
  broadcast: (status: CorePluginUpdates) => void
}) {
  let items = options.items.map((item) => ({ ...item, phase: options.enabled ? item.phase : 'development' as const }))
  let running: Promise<void> | undefined
  let checking = false
  const snapshot = (): CorePluginUpdates => ({ checking, items: items.map((item) => ({ ...item })) })
  const emit = (): void => options.broadcast(snapshot())
  const check = (): Promise<void> => {
    if (running) return running
    if (!options.enabled) { emit(); return Promise.resolve() }
    checking = true
    items = items.map((item) => ({ ...item, phase: 'checking', error: undefined }))
    emit()
    running = Promise.resolve().then(() => options.run((item) => {
      items = items.map((before) => before.id === item.id ? { ...before, ...item } : before)
      emit()
    })).then(() => undefined).catch((error: unknown) => {
      items = items.map((item) => item.phase === 'checking' || item.phase === 'downloading'
        ? { ...item, phase: 'error', error: error instanceof Error ? error.message : String(error) } : item)
    }).finally(() => {
      checking = false
      running = undefined
      emit()
    })
    return running
  }
  return { snapshot, check }
}
