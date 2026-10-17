import { describe, expect, it } from 'vitest'
import { createGlobalHotkeyPause } from './globalHotkeyPause'

function rig() {
  const timers: Array<{ fn: () => void; ms: number; live: boolean }> = []
  const p = createGlobalHotkeyPause({
    timeoutMs: 1000,
    setTimeout: (fn, ms) => { const t = { fn, ms, live: true }; timers.push(t); return t },
    clearTimeout: (t) => { (t as { live: boolean }).live = false },
  })
  const log: string[] = []
  const owner = (name: string) => ({ pause: () => log.push(`${name}:pause`), resume: () => log.push(`${name}:resume`), renew: () => log.push(`${name}:renew`) })
  const fire = () => { for (const t of timers.filter((x) => x.live)) { t.live = false; t.fn() } }
  return { p, log, owner, timers, fire }
}

describe('globalHotkeyPause', () => {
  it('pauses once, renews on repeat, resumes once', () => {
    const { p, log, owner } = rig()
    p.add(owner('mini')); p.add({ pause: () => log.push('estop:pause'), resume: () => log.push('estop:resume') })
    p.set(1, true); p.set(1, true)
    expect(log).toEqual(['mini:pause', 'estop:pause', 'mini:renew'])
    p.set(1, false); p.set(1, false)
    expect(log).toEqual(['mini:pause', 'estop:pause', 'mini:renew', 'mini:resume', 'estop:resume'])
    expect(p.isPaused()).toBe(false)
  })

  it('one holder releasing does not resume while another still holds', () => {
    const { p, log, owner } = rig()
    p.add(owner('mini'))
    p.set(1, true); p.set(2, true)
    p.set(1, false)
    expect(p.isPaused()).toBe(true)
    expect(log).toEqual(['mini:pause', 'mini:renew'])
    p.set(1, false) // 已释放的再释放:不动
    p.set(2, false)
    expect(log).toEqual(['mini:pause', 'mini:renew', 'mini:resume'])
  })

  it('an owner added while paused is paused right away', () => {
    const { p, log, owner } = rig()
    p.set(1, true)
    p.add(owner('mini'))
    expect(log).toEqual(['mini:pause'])
  })

  it('releases a lease by itself after the timeout; each set(true) extends it', () => {
    const { p, log, owner, timers, fire } = rig()
    p.add(owner('mini'))
    p.set(1, true)
    p.set(1, true) // 续期:旧计时器作废
    expect(timers.filter((t) => t.live)).toHaveLength(1)
    fire()
    expect(log).toEqual(['mini:pause', 'mini:renew', 'mini:resume'])
    expect(p.isPaused()).toBe(false)
  })

  it('a throwing owner does not block the others', () => {
    const { p, log, owner } = rig()
    p.add({ pause: () => { throw new Error('x') }, resume: () => { throw new Error('x') } })
    p.add(owner('mini'))
    p.set(1, true); p.set(1, false)
    expect(log).toEqual(['mini:pause', 'mini:resume'])
  })
})
