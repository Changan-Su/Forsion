/**
 * 首启引导的匿名遥测(契约 §9 onboarding):在界面里攒(每屏停留、往回跳、模式、几项选择),引导关掉时发一条。
 * 逐屏发会全丢:引导走到一半多半还没登录、还没看过告知(发不发由 Extend 判,宿主照常转发)。
 * 只有次数、毫秒数、布尔与枚举;「关于你」写了什么、Agent 叫什么一概不碰。纯逻辑 + 一个发送口,单测 onboardingTelemetry.test.ts。
 */
import type { Step } from '../onboardingFlow'
import { sendTelemetry } from '../../telemetrySend'

export type OnboardingMode = 'full' | 'returning' | 'brief' | 'update'
export type OnboardingOutcome = 'finish' | 'skip' | 'error-skip'

/** 引导模式:升级短引导(第一屏是「已更新到 X」)= brief;升级进来但版本太老、走完整版 = update;以前走过 = returning;新装 = full。 */
export function onboardingMode(o: { brief: boolean; updateMode: boolean; returning: boolean }): OnboardingMode {
  return o.brief ? 'brief' : o.updateMode ? 'update' : o.returning ? 'returning' : 'full'
}

const MS_FIELD: Record<Step, string> = { welcome: 'msWelcome', start: 'msStart', theme: 'msTheme', you: 'msYou', team: 'msTeam' }

/** 屏里那几项选择:团队屏(Muse 开没开、电脑历史开没开)、关于你那屏(写没写)在各自保存时记一笔。 */
let notes: { museOn?: boolean; computerHistoryOn?: boolean; youWritten?: boolean } = {}
export function noteOnboarding(n: typeof notes): void { notes = { ...notes, ...n } }

export interface OnboardingTracker {
  /** 进了某一屏(idx = 它在这次步骤序里的位置)。 */
  enter(step: Step, idx: number): void
  /** 某一屏出错后点了「跳过这一步」。 */
  errorSkipped(): void
  /** 引导关掉:reason = 走完 / 点了「跳过引导」。只发一次。 */
  finish(reason: 'finish' | 'skip', extra: { signedIn?: boolean; sync?: { notes: boolean; agents: boolean; plugins: boolean } | null; addedAgent?: boolean }): Record<string, unknown> | null
}

export function createOnboardingTracker(mode: OnboardingMode, now: () => number = Date.now, send: (props: Record<string, unknown>) => void = (p) => sendTelemetry('onboarding', p)): OnboardingTracker {
  notes = {}
  const ms: Partial<Record<Step, number>> = {}
  const seen = new Set<Step>()
  let cur: { step: Step; idx: number; at: number } | null = null
  let backJumps = 0
  let errorSkip = false
  let done = false
  const leave = (): void => {
    if (cur) ms[cur.step] = (ms[cur.step] ?? 0) + Math.max(0, now() - cur.at)
  }
  return {
    enter(step, idx) {
      if (done || cur?.step === step) return
      leave()
      if (cur && idx < cur.idx) backJumps++
      seen.add(step)
      cur = { step, idx, at: now() }
    },
    errorSkipped() { errorSkip = true },
    finish(reason, extra) {
      if (done) return null
      done = true
      leave()
      cur = null
      const props: Record<string, unknown> = {
        mode,
        outcome: (reason === 'skip' ? 'skip' : errorSkip ? 'error-skip' : 'finish') satisfies OnboardingOutcome,
        screens: seen.size,
        backJumps,
      }
      for (const [step, v] of Object.entries(ms) as Array<[Step, number]>) props[MS_FIELD[step]] = Math.round(v)
      if (extra.signedIn !== undefined) props.signedIn = extra.signedIn
      if (extra.sync) { props.syncNotes = extra.sync.notes; props.syncAgents = extra.sync.agents; props.syncPlugins = extra.sync.plugins }
      if (extra.addedAgent !== undefined) props.addedAgent = extra.addedAgent
      for (const [k, v] of Object.entries(notes)) if (typeof v === 'boolean') props[k] = v
      try { send(props) } catch { /* 遥测不影响收尾 */ }
      return props
    },
  }
}
