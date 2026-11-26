import type { MiniSessionContext } from '../shared/miniPanel'
import type { ForegroundLease } from './miniForeground'

interface AutoMiniDeps {
  readForeground(): Promise<ForegroundLease | null>
  hasForsionFocus(): boolean
  manualMiniVisible(): boolean
  session(): MiniSessionContext
  open(sessionId: string): void
  close(): void
  restore(sessionId: string, targetPid: number): Promise<void>
}

/** The run owns the handback even when an existing manual Mini already shows the conversation. */
export function startMiniAutoPanel(deps: AutoMiniDeps) {
  let stopped = false, checking = false
  let context = deps.session()
  let owner: ForegroundLease | null = null, requested: string | null = null
  let dismissed = false, generation = 0
  let relinquished: string | undefined

  function display(next: string | null): void {
    if (requested === next) return
    requested = next
    if (next) deps.open(next)
    else deps.close()
  }
  async function finish(previous: MiniSessionContext, observed: ForegroundLease | null, token: number): Promise<void> {
    // A fast tool can finish between polls. Only a signal tagged for that exact run qualifies here.
    const last = observed ?? await deps.readForeground().catch(() => null)
    if (stopped || generation !== token || deps.hasForsionFocus() || !last?.targetPid || !previous.sessionId) return
    if ((!observed && last.runId !== previous.runId) || (last.id && last.id === relinquished)) return
    await deps.restore(previous.sessionId, last.targetPid)
  }
  function refresh(lease?: ForegroundLease | null): void {
    if (stopped) return
    const next = deps.session()
    if (context.sessionId !== next.sessionId || context.runId !== next.runId) {
      const previous = context, observed = owner, wasDismissed = dismissed
      context = { ...next }; generation++; owner = null; dismissed = false
      display(null)
      if (!wasDismissed && previous.runId && !next.runId && previous.sessionId === next.sessionId && !deps.hasForsionFocus()) {
        void finish(previous, observed, generation)
      }
    }
    if (deps.hasForsionFocus()) {
      if (owner?.id) relinquished = owner.id
      owner = null; display(null); return
    }
    if (!context.runId || dismissed) return
    if (lease && (!lease.id || lease.id !== relinquished) && (!lease.runId || lease.runId === context.runId)) owner = lease
    display(owner && !deps.manualMiniVisible() ? context.sessionId : null)
  }
  context = { ...context }
  async function poll(): Promise<void> {
    if (stopped || checking) return
    checking = true
    try { refresh(await deps.readForeground()) } catch { refresh() } finally { checking = false }
  }
  const timer = setInterval(() => void poll(), 60)
  void poll()
  return {
    refresh,
    dismiss(): void { dismissed = true; owner = null; generation++; display(null) },
    wants(sessionId: string): boolean { return !stopped && requested === sessionId },
    following(): boolean { return !stopped && !!owner && !deps.hasForsionFocus() },
    stop(): void { stopped = true; generation++; clearInterval(timer); owner = null; display(null) },
  }
}
