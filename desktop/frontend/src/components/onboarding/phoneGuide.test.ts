// @vitest-environment happy-dom
/** 手机引导的步骤序与本机记号(phoneGuide.ts)。界面那半在 OnboardingWizard.test.ts 的 phone 用例里。 */
import { beforeEach, describe, expect, it } from 'vitest'
import {
  GUIDE_DONE_KEY, GUIDE_VERSION_KEY, PHONE_GUIDE_REV, PHONE_GUIDE_REV_KEY, PHONE_GUIDE_STEP_KEY, PHONE_GUIDE_SUGGEST_KEY,
  clearPhoneSuggest, finishPhoneGuide, notePhoneGuideStep, phoneGuidePlan, phoneSuggestPending, readPhoneGuideKeys, resumePhoneGuideAt,
  type PhoneStep,
} from './phoneGuide'
import { ONBOARDING_DISMISS_KEY, ONBOARDING_VERSION_KEY } from '../OnboardingWizard'

const all = (): boolean => true
const only = (...steps: PhoneStep[]) => (s: PhoneStep): boolean => steps.includes(s)
const keys = (o: Partial<{ done: boolean; version: string | null; rev: string | null }> = {}) => ({ done: false, version: null, rev: null, ...o })

beforeEach(() => localStorage.clear())

describe('phoneGuidePlan', () => {
  it('新人:完整引导,在哪运行 → 外观 → 想让它做哪些事;没内容的屏不出,外观总在', () => {
    expect(phoneGuidePlan(keys(), all)).toEqual({ mode: 'full', order: ['where', 'theme', 'perms'] })
    expect(phoneGuidePlan(keys(), only('perms'))).toEqual({ mode: 'full', order: ['theme', 'perms'] })
    expect(phoneGuidePlan(keys(), only('where'))).toEqual({ mode: 'full', order: ['where', 'theme'] })
    expect(phoneGuidePlan(keys(), only())).toEqual({ mode: 'full', order: ['theme'] })
  })
  it('走过旧引导的真实用户(有版本记号、没有手机引导版本):只补「想让它做哪些事」,这台手机没东西可问就不出', () => {
    expect(phoneGuidePlan(keys({ done: true, version: '2.13.7' }), all)).toEqual({ mode: 'update', order: ['perms'] })
    expect(phoneGuidePlan(keys({ done: true, version: '2.13.7' }), only('where'))).toEqual({ mode: 'none', order: [] })
  })
  it('只有完成记号(台架种的)/ 已记这一版 / 记号认不出:都不出', () => {
    expect(phoneGuidePlan(keys({ done: true }), all).mode).toBe('none')
    expect(phoneGuidePlan(keys({ done: true, version: '2.13.7', rev: '1' }), all).mode).toBe('none')
    expect(phoneGuidePlan(keys({ done: true, rev: '1' }), all).mode).toBe('none')
    expect(phoneGuidePlan(keys({ done: true, version: '2.13.7', rev: 'garbage' }), all).mode).toBe('none')
    expect(phoneGuidePlan(keys({ done: true, version: '2.13.7', rev: '-1' }), all).mode).toBe('none')
  })
  it('记过更早的手机引导版本(0):补看', () => {
    expect(phoneGuidePlan(keys({ done: true, version: '2.14.0', rev: '0' }), all)).toEqual({ mode: 'update', order: ['perms'] })
  })
})

describe('本机记号', () => {
  it('和向导的完成 / 版本记号是同一个字面量', () => {
    expect(GUIDE_DONE_KEY).toBe(ONBOARDING_DISMISS_KEY)
    expect(GUIDE_VERSION_KEY).toBe(ONBOARDING_VERSION_KEY)
  })
  it('readPhoneGuideKeys 读三样', () => {
    expect(readPhoneGuideKeys()).toEqual({ done: false, version: null, rev: null })
    localStorage.setItem(GUIDE_DONE_KEY, '1')
    localStorage.setItem(GUIDE_VERSION_KEY, '2.13.7')
    localStorage.setItem(PHONE_GUIDE_REV_KEY, '1')
    expect(readPhoneGuideKeys()).toEqual({ done: true, version: '2.13.7', rev: '1' })
  })
  it('resumePhoneGuideAt:记下的那屏在这次步骤序里就从那儿接着来,否则从头', () => {
    const order = ['where', 'theme', 'perms'] as const
    expect(resumePhoneGuideAt([...order])).toBe(0)
    notePhoneGuideStep('perms')
    expect(resumePhoneGuideAt([...order])).toBe(2)
    expect(resumePhoneGuideAt(['theme', 'perms'])).toBe(1)
    expect(resumePhoneGuideAt(['where', 'theme'])).toBe(0)
    localStorage.setItem(PHONE_GUIDE_STEP_KEY, 'nonsense')
    expect(resumePhoneGuideAt([...order])).toBe(0)
  })
  it('finishPhoneGuide:记这一版、清「做到哪」;只有完整引导记主页建议', () => {
    notePhoneGuideStep('theme')
    finishPhoneGuide(false)
    expect(localStorage.getItem(PHONE_GUIDE_REV_KEY)).toBe(String(PHONE_GUIDE_REV))
    expect(localStorage.getItem(PHONE_GUIDE_STEP_KEY)).toBeNull()
    expect(localStorage.getItem(PHONE_GUIDE_SUGGEST_KEY)).toBeNull()
    expect(phoneSuggestPending()).toBe(false)
    finishPhoneGuide(true)
    expect(phoneSuggestPending()).toBe(true)
    clearPhoneSuggest()
    expect(phoneSuggestPending()).toBe(false)
    expect(localStorage.getItem(PHONE_GUIDE_SUGGEST_KEY)).toBeNull()
  })
})
