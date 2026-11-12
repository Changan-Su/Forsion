/** Per-View navigation. Restores are serialized within one View; other Views stay independent.
 * Space layouts retain stable leaf ids, so their in-memory histories travel with that Space. */
import { create } from 'zustand'

export interface NavRestoreContext {
  signal: AbortSignal
  /** Check after asynchronous preparation and before committing View state. */
  isCurrent(): boolean
}
export interface NavEntry {
  key: string
  title?: string
  restore: (context?: NavRestoreContext) => unknown
}
export interface LeafStack { entries: NavEntry[]; idx: number; error?: boolean }
interface NavState {
  stacks: Record<string, LeafStack>
  record(leafId: string, entry: NavEntry): void
  back(leafId: string): void
  forward(leafId: string): void
  drop(leafId: string): void
  reset(): void
}
interface RestoreJob { controller: AbortController; committed: number; requested: number; active: boolean }
const jobs = new Map<string, RestoreJob>()
const spaces = new Map<string, Record<string, LeafStack>>()
let scope = ''
let switching = false
function cancel(id: string): void {
  const job = jobs.get(id)
  if (job) { job.active = false; job.controller.abort(); jobs.delete(id) }
}
function cancelAll(): void { for (const id of jobs.keys()) cancel(id) }

function go(get: () => NavState, set: (p: Partial<NavState>) => void, id: string, target: number): void {
  const stack = get().stacks[id]
  if (switching || !stack || target === stack.idx || target < 0 || target >= stack.entries.length) return
  set({ stacks: { ...get().stacks, [id]: { ...stack, idx: target, error: false } } })
  const previous = jobs.get(id)
  if (previous) {
    previous.requested = target
    previous.controller.abort()
    return // coalesce repeated clicks; a legacy async callback must settle before its successor starts
  }
  const job: RestoreJob = { controller: new AbortController(), committed: stack.idx, requested: target, active: true }
  jobs.set(id, job)
  const pump = (): void => {
    if (!job.active || jobs.get(id) !== job) return
    const destination = job.requested
    const entry = get().stacks[id]?.entries[destination]
    if (!entry) { cancel(id); return }
    const controller = new AbortController()
    job.controller = controller
    const context: NavRestoreContext = {
      signal: controller.signal,
      isCurrent: () => job.active && jobs.get(id) === job && !controller.signal.aborted && job.requested === destination,
    }
    const complete = (failed: boolean): void => {
      if (!job.active || jobs.get(id) !== job) return
      // Back → Back → Forward can return to the same destination after its first
      // transaction was aborted. It still needs a fresh controller and restore.
      if (controller.signal.aborted || job.requested !== destination) { pump(); return }
      if (!failed) job.committed = destination
      const current = get().stacks[id]
      if (current) set({ stacks: { ...get().stacks, [id]: { ...current, idx: failed ? job.committed : destination, error: failed } } })
      jobs.delete(id)
      job.active = false
    }
    const finish = (failed: boolean): void => {
      if (!job.active || jobs.get(id) !== job) return
      if (!failed || controller.signal.aborted || job.requested !== destination) { complete(failed); return }
      // A restore may swap the View type before asynchronous loading fails. Put
      // back the last successful entry as well as its cursor. A failed rollback
      // is reported once; never recursively retry an unavailable source.
      const rollback = destination !== job.committed ? get().stacks[id]?.entries[job.committed] : undefined
      if (!rollback) { complete(true); return }
      try { Promise.resolve(rollback.restore(context)).then(() => complete(true), () => complete(true)) }
      catch { complete(true) }
    }
    try {
      Promise.resolve(entry.restore(context)).then(() => finish(false), () => finish(true))
    } catch { finish(true) }
  }
  pump()
}

export const useNav = create<NavState>((set, get) => ({
  stacks: {},
  record(leafId, entry) {
    if (switching || jobs.has(leafId) || !leafId) return
    const st = get().stacks[leafId] ?? { entries: [], idx: -1 }
    if (st.entries[st.idx]?.key === entry.key) {
      const entries = [...st.entries]; entries[st.idx] = entry
      set({ stacks: { ...get().stacks, [leafId]: { ...st, entries } } })
      return
    }
    const entries = [...st.entries.slice(0, st.idx + 1), entry].slice(-100)
    set({ stacks: { ...get().stacks, [leafId]: { entries, idx: entries.length - 1 } } })
  },
  back(id) { go(get, set, id, (get().stacks[id]?.idx ?? 0) - 1) },
  forward(id) { go(get, set, id, (get().stacks[id]?.idx ?? -1) + 1) },
  drop(id) {
    if (switching) return
    cancel(id)
    const stacks = { ...get().stacks }; delete stacks[id]
    set({ stacks })
  },
  reset() {
    if (switching) return
    cancelAll(); spaces.delete(scope)
    set({ stacks: {} })
  },
}))

/** Before changing active Space or tearing down its layout. */
export function beginNavSpace(from: string, to: string): void {
  const stacks = Object.fromEntries(Object.entries(useNav.getState().stacks).map(([id, st]) => [id, { ...st, idx: jobs.get(id)?.committed ?? st.idx }]))
  spaces.set(from, stacks)
  while (spaces.size > 24) spaces.delete(spaces.keys().next().value!)
  cancelAll(); switching = true; scope = to
  useNav.setState({ stacks: {} })
}
/** Only histories whose stable View ids exist in the restored layout can return. */
export function finishNavSpace(leafIds?: string[]): void {
  const saved = spaces.get(scope) ?? {}
  const stacks = leafIds ? Object.fromEntries(Object.entries(saved).filter(([id]) => leafIds.includes(id))) : saved
  spaces.delete(scope)
  switching = false
  useNav.setState({ stacks })
}
export function forgetNavSpace(id: string): void { spaces.delete(id) }
export function recordNav(leafId: string | null | undefined, key: string, restore: NavEntry['restore'], title?: string): void {
  if (leafId) useNav.getState().record(leafId, { key, restore, title })
}
