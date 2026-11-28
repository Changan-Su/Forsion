import { describe, expect, it, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import { createRendererQuitGateUi, createSyncQuitGate, mergeQuitChecks, onQuitProceeding, type QuitCheckResult, type QuitGateAnswer, type QuitGateUi } from './syncQuitGate'

const synced: QuitCheckResult = { state: 'synced', pending: 0, failed: [] }
const pending = (n: number): QuitCheckResult => ({ state: 'pending', pending: n, failed: [] })

function fakeUi(available = true) {
  let answer!: (a: QuitGateAnswer) => void
  const shown: QuitCheckResult[] = []
  const ui: QuitGateUi & { shown: QuitCheckResult[]; hidden: number; click(a: QuitGateAnswer): void } = {
    shown, hidden: 0,
    available: () => available,
    show: (r) => { shown.push(r) },
    answer: () => new Promise((r) => { answer = r }),
    hide: () => { ui.hidden++ },
    click: (a) => answer(a),
  }
  return ui
}

describe('sync quit gate', () => {
  it('no registered check = the old quit path: nothing asked, nothing shown', async () => {
    const ui = fakeUi()
    const gate = createSyncQuitGate({ ui })
    expect(gate.has()).toBe(false)
    expect(await gate.run()).toBe(true)
    expect(ui.shown).toEqual([])
    expect(await gate.unattended()).toBe(true)
  })

  it('synced quits at once; pending with no window to ask quits as before (pending work stays queued)', async () => {
    const ui = fakeUi(false)
    const gate = createSyncQuitGate({ ui })
    gate.add(async () => synced)
    expect(await gate.run()).toBe(true)
    const off = gate.add(async () => pending(3))
    expect(await gate.run()).toBe(true)
    expect(ui.shown).toEqual([])
    off()
  })

  it('pending: shows the card, re-checks, and quits by itself once synced', async () => {
    const ui = fakeUi()
    let left = 2
    const gate = createSyncQuitGate({ ui, pollMs: 5 })
    gate.add(async () => (left-- > 0 ? pending(left + 1) : synced))
    expect(await gate.run()).toBe(true)
    expect(ui.shown.map((r) => r.pending)).toEqual([2, 1])
    expect(ui.hidden).toBe(1)
  })

  it('"cancel" keeps the app running; "quit" leaves with work still pending', async () => {
    const ui = fakeUi()
    const gate = createSyncQuitGate({ ui, pollMs: 5 })
    gate.add(async () => pending(4))
    const run = gate.run()
    await vi.waitFor(() => expect(ui.shown.length).toBeGreaterThan(0))
    expect(gate.run()).toBe(run) // 再按一次退出:同一份
    ui.click('cancel')
    expect(await run).toBe(false)
    const seen = ui.shown.length
    const again = gate.run()
    await vi.waitFor(() => expect(ui.shown.length).toBeGreaterThan(seen))
    ui.click('quit')
    expect(await again).toBe(true)
  })

  it('a throwing check reads as failed (never as synced); a slow one as still pending; unattended installs skip only pending', async () => {
    const ui = fakeUi()
    const gate = createSyncQuitGate({ ui, pollMs: 5, checkTimeoutMs: 10 })
    const off = gate.add(async () => { throw new Error('engine gone') })
    expect(await gate.check()).toEqual({ state: 'failed', pending: 0, failed: [{ path: '', reason: 'engine gone' }] })
    expect(await gate.unattended()).toBe(true)
    off()
    gate.add(() => new Promise(() => {}))
    expect((await gate.check())?.state).toBe('pending')
    expect(await gate.unattended()).toBe(false)
  })

  it('merges several checks: failed beats pending beats synced', () => {
    expect(mergeQuitChecks([synced, pending(2), { state: 'failed', pending: 1, failed: [{ path: 'a.md', reason: 'too large' }] }]))
      .toEqual({ state: 'failed', pending: 3, failed: [{ path: 'a.md', reason: 'too large' }] })
    expect(mergeQuitChecks([synced, synced]).state).toBe('synced')
  })

  it('renderer bridge: only subscribed, trusted windows are asked and may answer', async () => {
    const handlers = new Map<string, (e: any, ...a: unknown[]) => unknown>()
    const sent: unknown[] = []
    const sender = { id: 7, isDestroyed: () => false, send: (_c: string, p: unknown) => { sent.push(p) } }
    const ui = createRendererQuitGateUi({ events: { handle: (c, fn) => { handlers.set(c, fn) } }, isTrusted: (e) => e.sender.id === 7 })
    expect(ui.available()).toBe(false)
    expect(() => handlers.get('remotesync:quitGate:subscribe')!({ sender: { ...sender, id: 8 } }, true)).toThrow('forbidden')
    handlers.get('remotesync:quitGate:subscribe')!({ sender }, true)
    expect(ui.available()).toBe(true)
    ui.show(pending(1))
    const a = ui.answer()
    handlers.get('remotesync:quitGate:answer')!({ sender }, 'cancel')
    expect(await a).toBe('cancel')
    ui.hide()
    expect(sent).toEqual([{ open: true, result: pending(1) }, { open: false }])
    handlers.get('remotesync:quitGate:subscribe')!({ sender }, false)
    expect(ui.available()).toBe(false)
  })

  it('"cancel" clicked while a re-check is still running wins, even if that check then comes back synced', async () => {
    const ui = fakeUi()
    let slow!: (r: QuitCheckResult) => void
    let calls = 0
    const gate = createSyncQuitGate({ ui, pollMs: 5 })
    gate.add(() => (++calls === 1 ? Promise.resolve(pending(1)) : new Promise<QuitCheckResult>((r) => { slow = r })))
    const run = gate.run()
    await vi.waitFor(() => expect(calls).toBe(2)) // 卡片开着,第二次扫描还在跑
    ui.click('cancel')
    await new Promise((r) => setTimeout(r, 5))
    slow(synced)
    expect(await run).toBe(false)
  })

  it('unattended installs wait while anything is still pending, whatever the merged state says', async () => {
    const gate = createSyncQuitGate({ ui: fakeUi() })
    gate.add(async () => ({ state: 'failed', pending: 0, failed: [{ path: 'a.md', reason: 'too large' }] }))
    expect(await gate.unattended()).toBe(true) // 只有失败:照旧装
    gate.add(async () => pending(1))
    expect((await gate.check())?.state).toBe('failed') // 合起来报 failed,但还有一件在传
    expect(await gate.unattended()).toBe(false)
  })

  it('one check failing while another times out still reads as pending > 0: unattended installs wait', async () => {
    const gate = createSyncQuitGate({ ui: fakeUi(), checkTimeoutMs: 10 })
    gate.add(async () => ({ state: 'failed', pending: 0, failed: [{ path: 'a.md', reason: 'too large' }] }))
    gate.add(() => new Promise(() => {}))
    const r = await gate.check()
    expect(r?.state).toBe('failed')
    expect(r?.pending).toBeGreaterThan(0)
    expect(await gate.unattended()).toBe(false)
  })

  it('the old engine\'s quit hook skips a before-quit that the gate is holding and fires once when the quit goes ahead', () => {
    const app = new EventEmitter()
    let held = false
    const cb = vi.fn()
    onQuitProceeding(app, () => held, cb)
    held = true
    app.emit('before-quit')
    expect(cb).not.toHaveBeenCalled() // 门禁拦着问:旧引擎接着同步
    held = false
    app.emit('before-quit')
    expect(cb).toHaveBeenCalledOnce()
    app.emit('before-quit')
    expect(cb).toHaveBeenCalledOnce() // 同 app.once:真退时只调一次
    const off = onQuitProceeding(app, () => false, cb)
    off()
    app.emit('before-quit')
    expect(cb).toHaveBeenCalledOnce()
  })
})
