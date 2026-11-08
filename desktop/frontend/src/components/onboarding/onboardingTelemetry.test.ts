import { describe, expect, it } from 'vitest'
import { createOnboardingTracker, noteOnboarding, onboardingMode } from './onboardingTelemetry'

describe('onboardingMode', () => {
  it('brief > update > returning > full', () => {
    expect(onboardingMode({ brief: true, updateMode: true, returning: true })).toBe('brief')
    expect(onboardingMode({ brief: false, updateMode: true, returning: true })).toBe('update')
    expect(onboardingMode({ brief: false, updateMode: false, returning: true })).toBe('returning')
    expect(onboardingMode({ brief: false, updateMode: false, returning: false })).toBe('full')
  })
})

describe('createOnboardingTracker', () => {
  it('每屏停留累加、往回跳计数、几项选择一并带;只发一次', () => {
    let t = 0
    const sent: Array<Record<string, unknown>> = []
    const tr = createOnboardingTracker('full', () => t, (p) => sent.push(p))
    tr.enter('welcome', 0); t = 1000
    tr.enter('start', 1); t = 3000
    tr.enter('theme', 2); t = 3500
    tr.enter('start', 1); t = 4000 // 往回跳
    tr.enter('start', 1) // 同一屏重复进不算
    tr.enter('theme', 2); t = 4200
    tr.enter('you', 3); t = 6000
    noteOnboarding({ youWritten: true })
    tr.enter('team', 4); t = 7000
    noteOnboarding({ museOn: true, computerHistoryOn: false })
    const props = tr.finish('finish', { signedIn: true, sync: { notes: true, agents: false, plugins: true }, addedAgent: false })
    expect(props).toEqual({
      mode: 'full', outcome: 'finish', screens: 5, backJumps: 1,
      msWelcome: 1000, msStart: 2500, msTheme: 700, msYou: 1800, msTeam: 1000,
      signedIn: true, syncNotes: true, syncAgents: false, syncPlugins: true, addedAgent: false,
      youWritten: true, museOn: true, computerHistoryOn: false,
    })
    expect(tr.finish('skip', {})).toBeNull()
    expect(sent).toHaveLength(1)
  })
  it('点了跳过引导 = skip;出错跳过某屏后走完 = error-skip;没给的选择不带;新引导清掉上一次的选择', () => {
    noteOnboarding({ museOn: true })
    const a: Array<Record<string, unknown>> = []
    const tr = createOnboardingTracker('returning', () => 0, (p) => a.push(p))
    tr.enter('welcome', 0)
    expect(tr.finish('skip', {})).toEqual({ mode: 'returning', outcome: 'skip', screens: 1, backJumps: 0, msWelcome: 0 })
    const b = createOnboardingTracker('brief', () => 0, () => {})
    b.enter('welcome', 0)
    b.errorSkipped()
    expect(b.finish('finish', { sync: null })?.outcome).toBe('error-skip')
  })
  it('发送抛错不影响收尾', () => {
    const tr = createOnboardingTracker('full', () => 0, () => { throw new Error('ipc gone') })
    expect(() => tr.finish('finish', {})).not.toThrow()
  })
})
