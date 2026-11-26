import { defineMainMessages, mt } from './mainI18n'

defineMainMessages({
  'main.restart.title': { zh: '重启更新', en: 'Restart to update' },
  'main.restart.busy': { zh: '还有未完成的任务，要强制退出并重启吗？', en: 'Tasks are still active. Force quit and restart?' },
  'main.restart.detail': { zh: '有 {tasks} 个运行中或排队中的任务，以及 {processes} 个后台进程。强制重启会中断它们；选择稍后重启可继续当前工作。', en: '{tasks} tasks are running or queued, with {processes} background processes. A forced restart will interrupt them. Choose Restart later to keep working.' },
  'main.restart.unknown': { zh: '暂时无法确认任务状态，要强制退出并重启吗？', en: 'Task status could not be checked. Force quit and restart?' },
  'main.restart.unknownDetail': { zh: '引擎暂时没有响应，可能仍有任务在运行。可以稍后重试，或强制退出并重启。', en: 'The engine is not responding and tasks may still be running. Try again later, or force quit and restart.' },
  'main.restart.later': { zh: '稍后重启', en: 'Restart later' },
  'main.restart.force': { zh: '强制退出并更新', en: 'Force quit and update' },
  // 开着「重启后自动接着做」时(中断任务续跑方案 B 第 7 节):任务不会白做,弹窗改说更新完会接着做,主按钮是「立即更新 / 立即重启」
  'main.restart.resumeUpdate': { zh: '现在更新吗？', en: 'Update now?' },
  'main.restart.resumeUpdateDetail': {
    zh: '有 {tasks} 个任务在跑。更新完重新打开后，它们会从停下的地方自动接着做。{processes} 个后台进程会被停掉。',
    en: '{tasks} tasks are running. After the update they will pick up where they left off. {processes} background processes will be stopped.',
  },
  'main.restart.resumeUpdateNow': { zh: '立即更新', en: 'Update now' },
  'main.restart.resumeRelaunch': { zh: '现在重启吗？', en: 'Restart now?' },
  'main.restart.resumeRelaunchDetail': {
    zh: '有 {tasks} 个任务在跑。重新打开后，它们会从停下的地方自动接着做。{processes} 个后台进程会被停掉。',
    en: '{tasks} tasks are running. After the restart they will pick up where they left off. {processes} background processes will be stopped.',
  },
  'main.restart.resumeRelaunchNow': { zh: '立即重启', en: 'Restart now' },
  'main.restart.resumeLater': { zh: '稍后', en: 'Later' },
  // 只有一部分能自动接着做(团队任务、ACP 会话、旧引擎建的 run 不续,评审 #10):如实说,主按钮照旧
  'main.restart.resumeSomeUpdateDetail': {
    zh: '有 {tasks} 个任务在跑，其中 {resumable} 个更新后会自动接着做，其余会被中断。',
    en: '{tasks} tasks are running; {resumable} of them will pick up where they left off after the update, the rest will be interrupted.',
  },
  'main.restart.resumeSomeRelaunchDetail': {
    zh: '有 {tasks} 个任务在跑，其中 {resumable} 个重启后会自动接着做，其余会被中断。',
    en: '{tasks} tasks are running; {resumable} of them will pick up where they left off after the restart, the rest will be interrupted.',
  },
})

/** resumable:引擎报的「此刻停机的话,本进程会自动接着做的任务数」;旧引擎不报 = undefined(按原来的弹窗)。 */
export interface RestartActivity { tasks: number; processes: number; unknown?: boolean; resumable?: number }
export interface RestartDialog {
  type: 'warning'; title: string; message: string; detail: string
  buttons: string[]; defaultId: number; cancelId: number; noLink: boolean
}
/**
 * 重启 / 装更新前的确认框。opts.autoResume(设置「重启后自动接着做未完成的任务」开着)、确实有任务在跑(不是查不到)、
 * 且引擎报了其中有几个会自动接着做(resumable > 0)时,换成「现在更新吗?」,主按钮(defaultId 1)= 立即更新 / 立即重启:
 *  - 全都会续(resumable ≥ tasks):「…会从停下的地方自动接着做」;
 *  - 只续一部分:如实说「其中 N 个会自动接着做,其余会被中断」(评审 #10)。
 * 旧引擎不报 resumable、或一个都不续:与原来一字不差。两种都是 0 = 稍后、1 = 继续,调用方按 response === 1 放行。
 */
export function restartDialog(activity: RestartActivity, opts: { install?: boolean; autoResume?: boolean } = {}): RestartDialog {
  const resumable = activity.resumable
  if (opts.autoResume && !activity.unknown && activity.tasks > 0 && resumable !== undefined && resumable > 0) {
    const all = resumable >= activity.tasks
    const vars = { tasks: activity.tasks, processes: activity.processes, resumable }
    const detail = all
      ? (opts.install ? 'main.restart.resumeUpdateDetail' : 'main.restart.resumeRelaunchDetail')
      : (opts.install ? 'main.restart.resumeSomeUpdateDetail' : 'main.restart.resumeSomeRelaunchDetail')
    return {
      type: 'warning', title: mt('main.restart.title'),
      message: mt(opts.install ? 'main.restart.resumeUpdate' : 'main.restart.resumeRelaunch'),
      detail: mt(detail, vars),
      buttons: [mt('main.restart.resumeLater'), mt(opts.install ? 'main.restart.resumeUpdateNow' : 'main.restart.resumeRelaunchNow')],
      defaultId: 1, cancelId: 0, noLink: true,
    }
  }
  return {
    type: 'warning', title: mt('main.restart.title'),
    message: mt(activity.unknown ? 'main.restart.unknown' : 'main.restart.busy'),
    detail: activity.unknown ? mt('main.restart.unknownDetail') : mt('main.restart.detail', { tasks: activity.tasks, processes: activity.processes }),
    buttons: [mt('main.restart.later'), mt('main.restart.force')], defaultId: 0, cancelId: 0, noLink: true,
  }
}

/** Read the engine-wide inventory, including queued runs and delegated work outside the current window. */
export async function readRestartActivity(url: string, token: string, fetchFn: typeof fetch = fetch): Promise<RestartActivity> {
  const res = await fetchFn(`${url.replace(/\/$/, '')}/agent/remote/restart-status`, {
    headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(5000),
  })
  if (!res.ok) throw new Error(`restart status: HTTP ${res.status}`)
  const data = await res.json() as RestartActivity
  if (![data.tasks, data.processes].every((n) => Number.isSafeInteger(n) && n >= 0)) throw new Error('Invalid restart status')
  // resumable 是新字段:旧引擎没有;不是 0..tasks 的整数也当没有(弹窗按原来的),不因它判整个状态无效
  const r = data.resumable
  const resumable = typeof r === 'number' && Number.isSafeInteger(r) && r >= 0 && r <= data.tasks ? r : undefined
  return { tasks: data.tasks, processes: data.processes, ...(resumable !== undefined ? { resumable } : {}) }
}

/**
 * One shutdown at a time across the interactive restart guard and the unattended install: whichever starts first owns it
 * until it settles (a restart dialog that is still open counts), and the other one refuses.
 */
export function createShutdownLock() {
  let owner: 'restart' | 'idle-install' | null = null
  return {
    tryAcquire(who: 'restart' | 'idle-install'): boolean { if (owner) return false; owner = who; return true },
    release(who: 'restart' | 'idle-install'): void { if (owner === who) owner = null },
    get owner() { return owner },
  }
}
export type ShutdownLock = ReturnType<typeof createShutdownLock>

/** All restart entry points share one inspection / confirmation / shutdown operation. */
export function createRestartGuard(deps: {
  inspect(): Promise<RestartActivity>
  confirm(options: RestartDialog): Promise<boolean>
  restart(install: boolean): Promise<void>
  /** 设置「重启后自动接着做未完成的任务」开着没有;不给 / 读不到 = 按关(原来的弹窗)。 */
  autoResume?(): Promise<boolean>
  /** Shared with the unattended install: while it is shutting down, a restart request is refused. */
  lock?: ShutdownLock
}) {
  let pending: Promise<{ ok: boolean }> | undefined
  return (install = false): Promise<{ ok: boolean }> => {
    if (pending) return pending
    if (deps.lock && !deps.lock.tryAcquire('restart')) return Promise.resolve({ ok: false })
    pending = (async () => {
      const activity = await deps.inspect().catch(() => ({ tasks: 0, processes: 0, unknown: true }))
      if (activity.unknown || activity.tasks || activity.processes) {
        const autoResume = await (deps.autoResume?.() ?? Promise.resolve(false)).catch(() => false)
        if (!await deps.confirm(restartDialog(activity, { install, autoResume }))) return { ok: false }
      }
      await deps.restart(install)
      return { ok: true }
    })().finally(() => { pending = undefined; deps.lock?.release('restart') })
    return pending
  }
}

// ── Unattended, version-bound install (installIfIdle) ────────────────────────────────────────────────────────────────
/**
 * Why the unattended install did nothing. Every uncertainty is a refusal: the caller (Extend forced update) tries again later.
 *  · invalid_args       version / requireOsIdleSeconds malformed
 *  · unsupported        dev / sandbox / a build that cannot install in-app (ad-hoc mac, manual .dmg)
 *  · in_progress        a restart, a restart dialog, a quit or another unattended install is already under way
 *  · not_downloaded     no verified package is waiting (or a download is running)
 *  · version_mismatch   the waiting package is not `version`
 *  · os_active          OS input more recent than requireOsIdleSeconds
 *  · os_idle_unknown    the OS idle time cannot be read
 *  · voice_call         a voice call is up
 *  · voice_unknown      the voice-call state cannot be read
 *  · extend_busy        a quit guard (Extend content sync, Penzor Cloud transfers, ...) reports unfinished work, or a quit dialog is open
 *  · engine_busy        the managed engine has running / queued tasks, delegates or background processes
 *  · engine_unknown     the engine did not answer (or answered something unreadable)
 *  · engine_not_ready   no managed engine in the `ready` state (stopped, crashed, starting, external / cloud mode)
 *  · engine_no_hold     the engine cannot hold new runs (an engine older than this host)
 *  · prepare_failed     mac: Squirrel.Mac could not stage the package (the host fell back to the manual .dmg)
 *  · install_failed     the package could not be handed to the installer after the engine stopped (the engine is started again)
 *  · error              anything unexpected
 */
export type IdleInstallReason =
  | 'invalid_args' | 'unsupported' | 'in_progress' | 'not_downloaded' | 'version_mismatch'
  | 'os_active' | 'os_idle_unknown' | 'voice_call' | 'voice_unknown' | 'extend_busy'
  | 'engine_busy' | 'engine_unknown' | 'engine_not_ready' | 'engine_no_hold'
  | 'prepare_failed' | 'install_failed' | 'error'
export type IdleInstallResult = { ok: true } | { ok: false; reason: IdleInstallReason }
export type EngineCheck = { state: 'ready'; activity: RestartActivity } | { state: 'not_ready' }
export type EngineHold = { ok: true; release(): Promise<void> } | { ok: false; reason: 'engine_busy' | 'engine_unknown' | 'engine_not_ready' | 'engine_no_hold' }

/** How long the engine holds new runs: the host stops it a few milliseconds later; the ttl only covers a host that died. */
export const IDLE_INSTALL_HOLD_MS = 15_000
const VERSION_RE = /^[0-9A-Za-z.+-]{1,40}$/
const MAX_IDLE_SECONDS = 30 * 24 * 3600

export function createIdleInstall(deps: {
  lock: ShutdownLock
  /** dev / sandbox / not installable in-app → false */
  supported(): boolean
  /** A quit is already under way (isQuitting). */
  quitting(): boolean
  /** updater.pinDownloaded / unpinDownloaded / pinStillValid / installPinned */
  pin(version: string): 'unsupported' | 'not_downloaded' | 'version_mismatch' | null
  unpin(version: string): void
  pinValid(version: string): boolean
  /** OS idle seconds; null = cannot be read. Synchronous (powerMonitor). */
  osIdleSeconds(): number | null
  /** true = a call is up; null = cannot be read. */
  voiceCall(): Promise<boolean | null>
  /** quitGuards.peek(): true = unfinished work or unknown. */
  extendBusy(): boolean
  /** Engine restart status; throws = unknown. */
  engine(): Promise<EngineCheck>
  /** Atomic engine idle check + hold of new runs (POST /agent/remote/restart-hold). */
  holdEngine(ttlMs: number): Promise<EngineHold>
  /** mac Squirrel staging (updater.prepareInstall); true elsewhere. */
  prepare(): Promise<boolean>
  /** contentFlush.quit() / contentFlush.reset() */
  flush(): Promise<void>
  resetFlush(): void
  /** Point of no return, synchronous: isQuitting = true, quitGuards.pass(), cancel the deferred engine restart. */
  beginQuit(): void
  /** backend.stop('app_update'): writes the shutdown intent and signals the engine before its first await. */
  stopEngine(): Promise<void>
  /** updater.installPinned(version) */
  install(version: string): boolean
  /** The stop went through but the install did not: undo beginQuit and start the engine again. */
  abortQuit(): void
  log?(m: string): void
}) {
  /** Synchronous checks that are repeated right before the point of no return. */
  const presence = (needIdle: number): IdleInstallReason | null => {
    let idle: number | null
    try { idle = deps.osIdleSeconds() } catch { idle = null }
    if (idle === null || !Number.isFinite(idle) || idle < 0) return 'os_idle_unknown'
    if (idle < needIdle) return 'os_active'
    let busy = true
    try { busy = deps.extendBusy() } catch { busy = true }
    return busy ? 'extend_busy' : null
  }
  const voice = async (): Promise<IdleInstallReason | null> => {
    const v = await deps.voiceCall().catch(() => null)
    return v === null ? 'voice_unknown' : v ? 'voice_call' : null
  }
  const engine = async (): Promise<IdleInstallReason | null> => {
    let st: EngineCheck
    try { st = await deps.engine() } catch { return 'engine_unknown' }
    if (st.state !== 'ready') return 'engine_not_ready'
    const a = st.activity
    if (a.unknown) return 'engine_unknown'
    return a.tasks || a.processes ? 'engine_busy' : null
  }

  return async (args: unknown): Promise<IdleInstallResult> => {
    const a = (args && typeof args === 'object' ? args : {}) as { version?: unknown; requireOsIdleSeconds?: unknown }
    const version = typeof a.version === 'string' && VERSION_RE.test(a.version) ? a.version : null
    const needIdle = typeof a.requireOsIdleSeconds === 'number' && Number.isFinite(a.requireOsIdleSeconds)
      && a.requireOsIdleSeconds >= 0 && a.requireOsIdleSeconds <= MAX_IDLE_SECONDS ? a.requireOsIdleSeconds : null
    if (!version || needIdle === null) return { ok: false, reason: 'invalid_args' }
    try { if (!deps.supported()) return { ok: false, reason: 'unsupported' } } catch { return { ok: false, reason: 'unsupported' } }
    if (deps.quitting() || !deps.lock.tryAcquire('idle-install')) return { ok: false, reason: 'in_progress' }
    let pinned = false
    let flushed = false
    let committed = false
    const refuse = (reason: IdleInstallReason): IdleInstallResult => {
      deps.log?.(`[idle-install] ${version}: ${reason}`)
      return { ok: false, reason }
    }
    try {
      const why = deps.pin(version)
      if (why) return refuse(why)
      pinned = true
      // Everything that can refuse runs before Squirrel staging: a busy machine never gets a staged package.
      const first = presence(needIdle) ?? await voice() ?? await engine()
      if (first) return refuse(first)
      if (!(await deps.prepare())) return refuse('prepare_failed')
      // prepare() is unbounded on mac: everything checked before it is stale now, so the rest re-checks.
      flushed = true
      await deps.flush()
      const second = await voice()
      if (second) return refuse(second)
      const hold = await deps.holdEngine(IDLE_INSTALL_HOLD_MS).catch((): EngineHold => ({ ok: false, reason: 'engine_unknown' }))
      if (!hold.ok) return refuse(hold.reason)
      // From here to stopEngine() there is no await: nothing can start or change in between.
      const last = presence(needIdle) ?? (deps.pinValid(version) ? null : 'version_mismatch' as const) ?? (deps.quitting() ? 'in_progress' as const : null)
      if (last) { void hold.release().catch(() => {}); return refuse(last) }
      committed = true
      deps.beginQuit()
      try {
        await deps.stopEngine()
      } catch (e) {
        deps.log?.(`[idle-install] engine stop failed: ${String((e as Error)?.message || e)}`)
        deps.abortQuit()
        return { ok: false, reason: 'install_failed' }
      }
      if (!deps.install(version)) { deps.abortQuit(); return refuse('install_failed') }
      return { ok: true }
    } catch (e) {
      deps.log?.(`[idle-install] unexpected: ${String((e as Error)?.message || e)}`)
      if (committed) deps.abortQuit()
      return { ok: false, reason: 'error' }
    } finally {
      if (!committed) {
        if (pinned) deps.unpin(version)
        if (flushed) deps.resetFlush()
      } else if (!deps.quitting()) {
        // abortQuit ran: the package stays downloaded; let the next attempt pin it again
        deps.unpin(version)
      }
      deps.lock.release('idle-install')
    }
  }
}

/**
 * POST <engine>/agent/remote/restart-hold: the engine's own idle check and a hold on new runs in one step. 404 (an engine
 * older than this host) = engine_no_hold. Never throws.
 */
export async function requestEngineHold(url: string, token: string, ttlMs: number, fetchFn: typeof fetch = fetch): Promise<EngineHold> {
  const base = url.replace(/\/$/, '')
  const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }
  let res: Response
  try {
    res = await fetchFn(`${base}/agent/remote/restart-hold`, { method: 'POST', headers, body: JSON.stringify({ ttlMs }), signal: AbortSignal.timeout(5000) })
  } catch { return { ok: false, reason: 'engine_unknown' } }
  if (res.status === 404) return { ok: false, reason: 'engine_no_hold' }
  let data: any
  try { data = await res.json() } catch { return { ok: false, reason: 'engine_unknown' } }
  if (res.status === 409) return { ok: false, reason: data?.reason === 'busy' || data?.reason === 'held' ? 'engine_busy' : 'engine_unknown' }
  if (!res.ok || data?.ok !== true || typeof data.holdId !== 'string' || !data.holdId) return { ok: false, reason: 'engine_unknown' }
  const holdId = data.holdId as string
  return {
    ok: true,
    release: async () => {
      try {
        await fetchFn(`${base}/agent/remote/restart-hold/release`, { method: 'POST', headers, body: JSON.stringify({ holdId }), signal: AbortSignal.timeout(5000) })
      } catch { /* the hold lapses on its own */ }
    },
  }
}
