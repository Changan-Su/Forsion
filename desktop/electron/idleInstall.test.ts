/**
 * Unattended, version-bound install (restartGuard.createIdleInstall, main.ts `updater:installIfIdle`): every refusal reason, the
 * order of checks (nothing that can refuse runs after the point of no return), the shared lock with the restart guard, and the
 * cleanup on every refusal (pin, content flush, engine hold).
 */
import { describe, expect, it, vi } from 'vitest'

vi.mock('./mainI18n', () => ({ defineMainMessages: () => {}, mt: (k: string) => k }))
const { createIdleInstall, createRestartGuard, createShutdownLock, requestEngineHold, IDLE_INSTALL_HOLD_MS } = await import('./restartGuard')
type EngineHold = Awaited<ReturnType<typeof requestEngineHold>>

const V = '2.15.0'
const ARGS = { version: V, requireOsIdleSeconds: 600 }

function setup(over: Partial<Parameters<typeof createIdleInstall>[0]> = {}) {
  const calls: string[] = []
  const state = { pinned: null as string | null, quitting: false, flushed: false, held: false }
  const lock = createShutdownLock()
  const deps: Parameters<typeof createIdleInstall>[0] = {
    lock,
    supported: () => true,
    quitting: () => state.quitting,
    pin: (v) => { calls.push('pin'); if (v !== V) return 'version_mismatch'; state.pinned = v; return null },
    unpin: (v) => { calls.push('unpin'); if (state.pinned === v) state.pinned = null },
    pinValid: (v) => state.pinned === v,
    osIdleSeconds: () => 900,
    voiceCall: async () => false,
    extendBusy: () => false,
    engine: async () => ({ state: 'ready', activity: { tasks: 0, processes: 0 } }),
    holdEngine: async (ttl) => {
      calls.push(`hold:${ttl}`); state.held = true
      return { ok: true, release: async () => { calls.push('release'); state.held = false } }
    },
    prepare: async () => { calls.push('prepare'); return true },
    flush: async () => { calls.push('flush'); state.flushed = true; return true },
    resetFlush: () => { calls.push('resetFlush'); state.flushed = false },
    beginQuit: () => { calls.push('beginQuit'); state.quitting = true },
    stopEngine: async () => { calls.push('stopEngine') },
    install: (v) => { calls.push(`install:${v}`); return state.pinned === v },
    quitStarted: async () => { calls.push('quitStarted'); return true },
    abortQuit: () => { calls.push('abortQuit'); state.quitting = false },
    ...over,
  }
  return { run: createIdleInstall(deps), calls, state, lock }
}

describe('installIfIdle', () => {
  it('success: pin → checks → prepare → flush → hold → stop engine → install the pinned version, in that order', async () => {
    const { run, calls, state } = setup()
    expect(await run(ARGS)).toEqual({ ok: true })
    expect(calls).toEqual(['pin', 'prepare', 'flush', `hold:${IDLE_INSTALL_HOLD_MS}`, 'beginQuit', 'stopEngine', `install:${V}`, 'quitStarted'])
    expect(state.pinned).toBe(V) // the pin stays through the shutdown
  })

  it('rejects malformed arguments before touching anything', async () => {
    for (const bad of [null, {}, { version: V }, { version: '', requireOsIdleSeconds: 1 }, { version: 'v 1', requireOsIdleSeconds: 1 },
      { version: V, requireOsIdleSeconds: -1 }, { version: V, requireOsIdleSeconds: Number.NaN }, { version: V, requireOsIdleSeconds: '600' }]) {
      const { run, calls } = setup()
      expect(await run(bad)).toEqual({ ok: false, reason: 'invalid_args' })
      expect(calls).toEqual([])
    }
    const { run } = setup()
    expect(await run({ version: V, requireOsIdleSeconds: 0 })).toEqual({ ok: true }) // 0 = "the person is right here"
  })

  it('unsupported build, a quit under way, or a restart already holding the lock → nothing happens', async () => {
    expect(await setup({ supported: () => false }).run(ARGS)).toEqual({ ok: false, reason: 'unsupported' })
    const q = setup(); q.state.quitting = true
    expect(await q.run(ARGS)).toEqual({ ok: false, reason: 'in_progress' })
    expect(q.calls).toEqual([])
    const l = setup(); l.lock.tryAcquire('restart')
    expect(await l.run(ARGS)).toEqual({ ok: false, reason: 'in_progress' })
    expect(l.calls).toEqual([])
  })

  it('refuses a version other than the downloaded one, or nothing downloaded', async () => {
    const { run, calls } = setup()
    expect(await run({ ...ARGS, version: '2.15.1' })).toEqual({ ok: false, reason: 'version_mismatch' })
    expect(calls).toEqual(['pin'])
    expect(await setup({ pin: () => 'not_downloaded' }).run(ARGS)).toEqual({ ok: false, reason: 'not_downloaded' })
  })

  // Each reason refuses before Squirrel staging / flush / hold, and unpins.
  const early: Array<[string, Partial<Parameters<typeof createIdleInstall>[0]>]> = [
    ['os_active', { osIdleSeconds: () => 599 }],
    ['os_idle_unknown', { osIdleSeconds: () => null }],
    ['os_idle_unknown', { osIdleSeconds: () => { throw new Error('linux session') } }],
    ['extend_busy', { extendBusy: () => true }],
    ['extend_busy', { extendBusy: () => { throw new Error('x') } }],
    // A folder Unit (local multi-Unit) shares the installation: running or unknown → refuse, never ask it to quit
    ['engine_busy', { otherInstancesRunning: () => true }],
    ['engine_busy', { otherInstancesRunning: () => { throw new Error('registry unreadable') } }],
    ['voice_call', { voiceCall: async () => true }],
    ['voice_unknown', { voiceCall: async () => null }],
    ['voice_unknown', { voiceCall: async () => { throw new Error('renderer gone') } }],
    ['engine_busy', { engine: async () => ({ state: 'ready', activity: { tasks: 1, processes: 0 } }) }],
    ['engine_busy', { engine: async () => ({ state: 'ready', activity: { tasks: 0, processes: 2 } }) }],
    ['engine_unknown', { engine: async () => ({ state: 'ready', activity: { tasks: 0, processes: 0, unknown: true } }) }],
    ['engine_unknown', { engine: async () => { throw new Error('HTTP 503') } }],
    ['engine_not_ready', { engine: async () => ({ state: 'not_ready' }) }],
  ]
  for (const [reason, over] of early) {
    it(`refuses with ${reason} before staging anything, and unpins`, async () => {
      const { run, calls, state } = setup(over)
      expect(await run(ARGS)).toEqual({ ok: false, reason })
      expect(calls).toEqual(['pin', 'unpin'])
      expect(state.pinned).toBeNull()
    })
  }

  it('mac staging failed → prepare_failed, unpinned, nothing flushed', async () => {
    const { run, calls } = setup({ prepare: async () => false })
    expect(await run(ARGS)).toEqual({ ok: false, reason: 'prepare_failed' })
    expect(calls).toEqual(['pin', 'unpin'])
  })

  it('a voice call that started during staging / flush refuses; the flush is reset', async () => {
    let n = 0
    const { run, calls, state } = setup({ voiceCall: async () => ++n > 1 })
    expect(await run(ARGS)).toEqual({ ok: false, reason: 'voice_call' })
    expect(calls).toEqual(['pin', 'prepare', 'flush', 'unpin', 'resetFlush'])
    expect(state.flushed).toBe(false)
  })

  for (const reason of ['engine_busy', 'engine_unknown', 'engine_not_ready', 'engine_no_hold'] as const) {
    it(`the engine refuses the hold (${reason}) → refused, flush reset, unpinned`, async () => {
      const { run, calls } = setup({ holdEngine: async (): Promise<EngineHold> => ({ ok: false, reason }) })
      expect(await run(ARGS)).toEqual({ ok: false, reason })
      expect(calls).toEqual(['pin', 'prepare', 'flush', 'unpin', 'resetFlush'])
    })
  }

  it('someone came back while the hold was taken → refused and the hold is released (the engine runs again)', async () => {
    let idle = 900
    const { run, calls, state } = setup({
      osIdleSeconds: () => idle,
      holdEngine: async () => { calls.push('hold'); idle = 3; state.held = true; return { ok: true, release: async () => { calls.push('release'); state.held = false } } },
    })
    expect(await run(ARGS)).toEqual({ ok: false, reason: 'os_active' })
    expect(calls).toEqual(['pin', 'prepare', 'flush', 'hold', 'release', 'unpin', 'resetFlush'])
    expect(state.held).toBe(false)
  })

  it('a transfer that started after the first check is caught at the last moment, hold released', async () => {
    let busy = false
    const { run, calls } = setup({
      extendBusy: () => busy,
      holdEngine: async () => { busy = true; return { ok: true, release: async () => { calls.push('release') } } },
    })
    expect(await run(ARGS)).toEqual({ ok: false, reason: 'extend_busy' })
    expect(calls).toContain('release')
    expect(calls).not.toContain('beginQuit')
  })

  it('a folder Unit started after the first check is caught at the last moment, hold released', async () => {
    let running = false
    const { run, calls } = setup({
      otherInstancesRunning: () => running,
      holdEngine: async () => { running = true; return { ok: true, release: async () => { calls.push('release') } } },
    })
    expect(await run(ARGS)).toEqual({ ok: false, reason: 'engine_busy' })
    expect(calls).toContain('release')
    expect(calls).not.toContain('beginQuit')
  })

  it('the pin no longer holds at the last moment → version_mismatch, hold released', async () => {
    const { run, calls, state } = setup({
      holdEngine: async () => { state.pinned = null; return { ok: true, release: async () => { calls.push('release') } } },
    })
    expect(await run(ARGS)).toEqual({ ok: false, reason: 'version_mismatch' })
    expect(calls).toContain('release')
    expect(calls).not.toContain('stopEngine')
  })

  it('install refused after the engine stopped → the quit is undone and the engine started again', async () => {
    const { run, calls, state } = setup({ install: (v) => { calls.push(`install:${v}`); return false } })
    expect(await run(ARGS)).toEqual({ ok: false, reason: 'install_failed' })
    expect(calls.slice(-3)).toEqual([`install:${V}`, 'abortQuit', 'unpin'])
    expect(state.quitting).toBe(false)
  })

  it('engine stop throws → the quit is undone', async () => {
    const { run, calls } = setup({ stopEngine: async () => { throw new Error('boom') } })
    expect(await run(ARGS)).toEqual({ ok: false, reason: 'install_failed' })
    expect(calls).toContain('abortQuit')
    expect(calls).not.toContain(`install:${V}`)
  })

  it('shares one lock with the restart guard, both ways', async () => {
    let releaseConfirm!: (v: boolean) => void
    const lock = createShutdownLock()
    const restart = vi.fn(async () => {})
    const guarded = createRestartGuard({
      lock,
      inspect: async () => ({ tasks: 1, processes: 0 }),
      confirm: () => new Promise<boolean>((r) => { releaseConfirm = r }),
      restart,
    })
    const pending = guarded(true) // a restart dialog is open
    await vi.waitFor(() => expect(releaseConfirm).toBeTypeOf('function'))
    const busy = setup({ lock } as any)
    expect(await busy.run(ARGS)).toEqual({ ok: false, reason: 'in_progress' })
    releaseConfirm(false)
    expect(await pending).toEqual({ ok: false })
    // and while an unattended install runs, a restart request is refused without asking anything
    let releaseFlush!: () => void
    const running = setup({ lock, flush: () => new Promise<boolean>((r) => { releaseFlush = () => r(true) }) } as any)
    const p = running.run(ARGS)
    await new Promise((r) => setTimeout(r, 0))
    expect(await guarded(true)).toEqual({ ok: false })
    releaseFlush()
    expect(await p).toEqual({ ok: true })
    expect(restart).not.toHaveBeenCalled()
  })

  it('two overlapping calls: the second refuses (in_progress)', async () => {
    let releaseFlush!: () => void
    const { run, lock } = setup({ flush: () => new Promise<boolean>((r) => { releaseFlush = () => r(true) }) })
    const a = run(ARGS)
    await new Promise((r) => setTimeout(r, 0))
    expect(await run(ARGS)).toEqual({ ok: false, reason: 'in_progress' })
    releaseFlush()
    expect(await a).toEqual({ ok: true })
    expect(lock.owner).toBe('idle-install') // kept through the shutdown: nothing else may start one
  })

  it('a content flush that timed out (a push may still be running) refuses', async () => {
    const { run, calls } = setup({ flush: async () => false })
    expect(await run(ARGS)).toEqual({ ok: false, reason: 'extend_busy' })
    expect(calls).not.toContain('beginQuit')
    expect(calls.slice(-2)).toEqual(['unpin', 'resetFlush'])
  })

  it('Windows all-users install (elevation needed) refuses before anything; unknown counts as needed', async () => {
    expect(await setup({ needsElevation: () => true }).run(ARGS)).toEqual({ ok: false, reason: 'needs_elevation' })
    const t = setup({ needsElevation: () => { throw new Error('x') } })
    expect(await t.run(ARGS)).toEqual({ ok: false, reason: 'needs_elevation' })
    expect(t.calls).toEqual([])
  })

  it('a hold that is no longer valid (lapsed / another engine) refuses and is released', async () => {
    const { run, calls } = setup({ holdEngine: async () => ({ ok: true, valid: () => false, release: async () => { calls.push('release') } }) })
    expect(await run(ARGS)).toEqual({ ok: false, reason: 'engine_unknown' })
    expect(calls).toContain('release')
    expect(calls).not.toContain('stopEngine')
  })

  it('the app did not start quitting after the hand-off → the quit is undone, the engine restarted, the lock freed', async () => {
    const { run, calls, state, lock } = setup({ quitStarted: async () => false })
    expect(await run(ARGS)).toEqual({ ok: false, reason: 'install_failed' })
    expect(calls.slice(-3)).toEqual([`install:${V}`, 'abortQuit', 'unpin'])
    expect(state.quitting).toBe(false)
    expect(lock.owner).toBeNull()
  })

  it('engine stop throws → the hold is released too', async () => {
    const { run, calls } = setup({
      holdEngine: async () => ({ ok: true, release: async () => { calls.push('release') } }),
      stopEngine: async () => { throw new Error('boom') },
    })
    expect(await run(ARGS)).toEqual({ ok: false, reason: 'install_failed' })
    expect(calls).toContain('release')
  })
})

describe('requestEngineHold', () => {
  const res = (status: number, body: unknown) => ({ status, ok: status >= 200 && status < 300, json: async () => body }) as Response
  it('maps the engine answers; 404 = an engine older than this host', async () => {
    const f = (r: Response | Error) => vi.fn(async () => { if (r instanceof Error) throw r; return r }) as unknown as typeof fetch
    expect(await requestEngineHold('http://e/', 't', 15000, f(res(404, {})))).toEqual({ ok: false, reason: 'engine_no_hold' })
    expect(await requestEngineHold('http://e', 't', 15000, f(res(409, { ok: false, reason: 'busy', tasks: 1, processes: 0 })))).toEqual({ ok: false, reason: 'engine_busy' })
    expect(await requestEngineHold('http://e', 't', 15000, f(res(409, { ok: false, reason: 'held' })))).toEqual({ ok: false, reason: 'engine_busy' })
    expect(await requestEngineHold('http://e', 't', 15000, f(res(503, {})))).toEqual({ ok: false, reason: 'engine_unknown' })
    expect(await requestEngineHold('http://e', 't', 15000, f(res(200, { ok: true })))).toEqual({ ok: false, reason: 'engine_unknown' })
    expect(await requestEngineHold('http://e', 't', 15000, f(new Error('ECONNREFUSED')))).toEqual({ ok: false, reason: 'engine_unknown' })
  })
  it('a granted hold releases with our lease id, and is valid only well inside its ttl', async () => {
    vi.useFakeTimers()
    try {
      const seen: Array<[string, any]> = []
      const f = vi.fn(async (url: string, init: any) => { seen.push([url, JSON.parse(init.body)]); return res(200, { ok: true, holdId: 'lease-1', ttlMs: 15000 }) }) as unknown as typeof fetch
      const h = await requestEngineHold('http://e/', 'tok', 15000, f, 'lease-1')
      expect(h.ok).toBe(true)
      if (!h.ok) return
      expect(h.valid!()).toBe(true)
      vi.advanceTimersByTime(7600)
      expect(h.valid!()).toBe(false)
      await h.release()
      expect(seen).toEqual([['http://e/agent/remote/restart-hold', { ttlMs: 15000, holdId: 'lease-1' }], ['http://e/agent/remote/restart-hold/release', { holdId: 'lease-1' }]])
    } finally { vi.useRealTimers() }
  })

  it('a reply that never arrives (or is unreadable) still releases the lease the engine may have granted', async () => {
    const seen: string[] = []
    let n = 0
    const f = vi.fn(async (url: string) => { seen.push(url); if (n++ === 0) throw new Error('timeout'); return res(200, {}) }) as unknown as typeof fetch
    expect(await requestEngineHold('http://e', 't', 15000, f, 'lease-2')).toEqual({ ok: false, reason: 'engine_unknown' })
    await new Promise((r) => setTimeout(r, 0))
    expect(seen).toEqual(['http://e/agent/remote/restart-hold', 'http://e/agent/remote/restart-hold/release'])
  })
})
