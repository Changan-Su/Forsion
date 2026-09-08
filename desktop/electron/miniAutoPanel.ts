import type { MiniSessionContext } from '../shared/miniPanel'

interface AutoMiniDeps {
  readForeground(): Promise<boolean>
  hasForsionFocus(): boolean
  manualMiniVisible(): boolean
  session(): MiniSessionContext
  open(sessionId: string): void
  close(): void
}

/** App-wide ownership of a temporary conversation panel. A physical-input lease starts
 * an episode; the same running conversation keeps it through tool/model pauses. */
export function startMiniAutoPanel(deps: AutoMiniDeps) {
  let stopped = false, checking = false, foreground = false
  let episode: string | null = null, suppressed: string | null = null
  let requested: string | null = null
  const refresh = (): void => {
    if (stopped) return
    const { sessionId, runId } = deps.session()
    const key = sessionId && runId ? JSON.stringify([sessionId, runId]) : null
    if (suppressed !== key) suppressed = null
    if (!key || deps.hasForsionFocus() || deps.manualMiniVisible()) episode = null
    else if (foreground && suppressed !== key) episode = key
    else if (episode !== key) episode = null
    const next = episode && episode === key && suppressed !== key ? sessionId : null
    if (next === requested) return
    requested = next
    if (next) deps.open(next)
    else deps.close()
  }
  const poll = async (): Promise<void> => {
    if (stopped || checking) return
    checking = true
    try { const active = await deps.readForeground(); if (!stopped) foreground = active }
    catch { foreground = false }
    finally { checking = false }
    refresh()
  }
  const timer = setInterval(() => void poll(), 60)
  void poll()
  return {
    refresh,
    /** Manual entry/dismissal wins for the remainder of this run. */
    dismiss(): void {
      const { sessionId, runId } = deps.session()
      suppressed = sessionId && runId ? JSON.stringify([sessionId, runId]) : null
      episode = null
      if (requested) { requested = null; deps.close() }
    },
    wants(sessionId: string): boolean { return !stopped && requested === sessionId },
    following(): boolean { return !stopped && foreground && !deps.hasForsionFocus() },
    stop(): void { stopped = true; clearInterval(timer); requested = episode = null; deps.close() },
  }
}
