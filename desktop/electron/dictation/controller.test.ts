import { describe, expect, it, vi } from 'vitest'
import { createDictationController, type DictationDeps, type DictationTarget, type InsertResult } from './controller'

function harness(o: { platform?: string; target?: DictationTarget | null; insert?: InsertResult | (() => Promise<InsertResult>); ax?: boolean; registerOk?: boolean } = {}) {
  const timers = new Map<number, () => void>()
  let seq = 0
  const calls: string[] = []
  const hotkeys = new Map<string, () => void>()
  let esc: (() => void) | null = null
  let ax = o.ax ?? true
  const inserted: Array<{ target: DictationTarget; text: string }> = []
  const copied: string[] = []
  const states: ReturnType<DictationDeps['emit'] extends (s: infer S) => void ? () => S : never>[] = []
  const deps: DictationDeps = {
    platform: o.platform ?? 'darwin',
    captureTarget: async () => (o.target === undefined ? { kind: 'external', pid: 42, window: 7 } : o.target),
    insert: async (target, text) => {
      inserted.push({ target, text })
      const r = o.insert ?? { ok: true }
      return typeof r === 'function' ? r() : r
    },
    copy: (t) => { copied.push(t) },
    accessibility: () => ax,
    requestAccessibility: () => { calls.push('allow') },
    register: (hk, cb) => { calls.push(`register ${hk}`); if (o.registerOk === false) return false; hotkeys.set(hk, cb); return true },
    unregister: (hk) => { calls.push(`unregister ${hk}`); hotkeys.delete(hk) },
    registerEscape: (cb) => { calls.push('esc on'); esc = cb; return true },
    unregisterEscape: () => { calls.push('esc off'); esc = null },
    capsule: {
      prepare: () => calls.push('prepare'),
      show: () => calls.push('show'),
      hide: () => calls.push('hide'),
      send: () => {},
      dispose: () => calls.push('dispose'),
    },
    emit: (s) => { states.push(s as never) },
    locale: () => 'en',
    newId: () => `s${++seq}`,
    setTimeout: (fn) => { const id = ++seq; timers.set(id, fn); return id },
    clearTimeout: (t) => { timers.delete(t as number) },
  }
  const c = createDictationController(deps, { hotkey: 'alt+shift+space' })
  const flush = async () => { for (let i = 0; i < 5; i++) await Promise.resolve() }
  const fireTimers = () => { const all = [...timers.values()]; timers.clear(); all.forEach((f) => f()) }
  return { c, calls, hotkeys, get esc() { return esc }, inserted, copied, flush, fireTimers, setAx: (v: boolean) => { ax = v } }
}

describe('dictation controller', () => {
  it('registers the hotkey only while a lease is held', () => {
    const h = harness()
    h.c.toggle()
    expect(h.c.state().phase).toBe('idle') // no lease: hotkey does nothing
    h.c.attach(1)
    expect(h.hotkeys.has('alt+shift+space')).toBe(true)
    expect(h.calls).toContain('prepare')
    h.c.attach(2)
    h.c.detach(1)
    expect(h.hotkeys.has('alt+shift+space')).toBe(true) // window 2 still holds it
    h.c.detach(2)
    expect(h.hotkeys.has('alt+shift+space')).toBe(false)
    expect(h.calls).toContain('dispose')
    expect(h.c.state().enabled).toBe(false)
  })

  it('reports a hotkey that could not be registered', () => {
    const h = harness({ registerOk: false })
    h.c.attach(1)
    expect(h.c.state()).toMatchObject({ enabled: true, registered: false })
  })

  it('press, speak, press: writes the text into the target captured at the first press', async () => {
    const h = harness()
    h.c.attach(1)
    h.c.toggle()
    const id = h.c.state().sessionId!
    expect(h.c.state().phase).toBe('listening')
    expect(h.esc).not.toBeNull() // Esc is only global while the capsule is up
    h.c.toggle()
    expect(h.c.state().phase).toBe('finishing')
    h.c.capsuleResult(id, '  hello world  ')
    await h.flush()
    expect(h.inserted).toEqual([{ target: { kind: 'external', pid: 42, window: 7 }, text: 'hello world' }])
    expect(h.c.state().phase).toBe('done')
    h.fireTimers()
    expect(h.c.state().phase).toBe('idle')
    expect(h.esc).toBeNull()
  })

  it('ignores results from a stale session and from the wrong phase', async () => {
    const h = harness()
    h.c.attach(1)
    h.c.toggle()
    const first = h.c.state().sessionId!
    h.c.cancel()
    h.c.toggle()
    h.c.capsuleResult(first, 'old words')
    await h.flush()
    expect(h.inserted).toEqual([])
    expect(h.c.state().phase).toBe('listening')
  })

  it('keeps the text for Copy when the target changed / is a password field', async () => {
    for (const failure of ['target-changed', 'secure-field', 'still-typing', 'paste-failed'] as const) {
      const h = harness({ insert: { ok: false, failure } })
      h.c.attach(1)
      h.c.toggle()
      const id = h.c.state().sessionId!
      h.c.toggle()
      h.c.capsuleResult(id, 'secret plan')
      await h.flush()
      expect(h.c.state()).toMatchObject({ phase: 'failed', failure, text: 'secret plan' })
      h.c.capsuleAction(id, 'copy')
      await h.flush()
      expect(h.copied).toEqual(['secret plan'])
      expect(h.c.state()).toMatchObject({ phase: 'done', copied: true })
    }
  })

  it('does not paste into another app without Accessibility (macOS)', async () => {
    const h = harness({ ax: false })
    h.c.attach(1)
    h.c.toggle()
    const id = h.c.state().sessionId!
    h.c.capsuleResult(id, 'note this')
    await h.flush()
    expect(h.inserted).toEqual([])
    expect(h.c.state()).toMatchObject({ phase: 'failed', failure: 'no-permission', text: 'note this' })
    h.c.capsuleAction(id, 'allow')
    expect(h.calls).toContain('allow')
  })

  it('writes into its own window without needing Accessibility', async () => {
    const h = harness({ ax: false, target: { kind: 'self', webContentsId: 3 } })
    h.c.attach(1)
    h.c.toggle()
    const id = h.c.state().sessionId!
    h.c.capsuleResult(id, 'inside forsion')
    await h.flush()
    expect(h.inserted).toEqual([{ target: { kind: 'self', webContentsId: 3 }, text: 'inside forsion' }])
  })

  it('Esc cancels a running dictation and is released afterwards', () => {
    const h = harness()
    h.c.attach(1)
    h.c.toggle()
    h.esc!()
    expect(h.c.state().phase).toBe('idle')
    expect(h.esc).toBeNull()
    expect(h.calls.filter((c) => c === 'hide').length).toBe(1)
  })

  it('cannot cancel while inserting, and a hotkey press then is ignored', async () => {
    let release!: (r: InsertResult) => void
    const h = harness({ insert: () => new Promise((r) => { release = r }) })
    h.c.attach(1)
    h.c.toggle()
    const id = h.c.state().sessionId!
    h.c.capsuleResult(id, 'slow app')
    await h.flush()
    expect(h.c.state().phase).toBe('inserting')
    h.c.cancel()
    h.c.toggle()
    expect(h.c.state().phase).toBe('inserting')
    release({ ok: true })
    await h.flush()
    expect(h.c.state().phase).toBe('done')
  })

  it('an empty transcript or a capture error ends without writing', async () => {
    const h = harness()
    h.c.attach(1)
    h.c.toggle()
    h.c.capsuleResult(h.c.state().sessionId!, '   ')
    expect(h.c.state()).toMatchObject({ phase: 'failed', failure: 'empty' })
    h.c.toggle() // a new press starts over
    h.c.capsuleError(h.c.state().sessionId!, 'Microphone access was denied')
    expect(h.c.state()).toMatchObject({ phase: 'failed', failure: 'capture', message: 'Microphone access was denied' })
    await h.flush()
    expect(h.inserted).toEqual([])
  })

  it('drops the session when the last lease goes away mid-dictation', () => {
    const h = harness()
    h.c.attach(1)
    h.c.toggle()
    h.c.detach(1)
    expect(h.c.state()).toMatchObject({ phase: 'idle', enabled: false })
    expect(h.esc).toBeNull()
  })

  it('changing the hotkey re-registers; pausing releases both keys', () => {
    const h = harness()
    h.c.attach(1)
    h.c.setHotkey('mod+shift+space')
    expect([...h.hotkeys.keys()]).toEqual(['mod+shift+space'])
    h.c.toggle()
    h.c.pause()
    expect(h.hotkeys.size).toBe(0)
    expect(h.esc).toBeNull()
    h.c.resume()
    expect([...h.hotkeys.keys()]).toEqual(['mod+shift+space'])
    expect(h.esc).not.toBeNull()
  })

  it('an unreadable target is never guessed', async () => {
    const h = harness({ target: null })
    h.c.attach(1)
    h.c.toggle()
    h.c.capsuleResult(h.c.state().sessionId!, 'where to')
    await h.flush()
    expect(h.inserted).toEqual([])
    expect(h.c.state()).toMatchObject({ phase: 'failed', failure: 'target-changed', text: 'where to' })
    const linux = harness({ target: null, platform: 'linux' })
    linux.c.attach(1)
    linux.c.toggle()
    linux.c.capsuleResult(linux.c.state().sessionId!, 'x')
    await linux.flush()
    expect(linux.c.state().failure).toBe('unsupported')
  })

  it('stops by itself after the maximum length', () => {
    vi.useFakeTimers()
    try {
      const h = harness()
      h.c.attach(1)
      h.c.toggle()
      h.fireTimers()
      expect(h.c.state().phase).toBe('finishing')
    } finally { vi.useRealTimers() }
  })
})
