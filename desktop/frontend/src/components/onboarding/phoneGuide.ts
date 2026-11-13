/**
 * 手机首次引导的接缝(2026-11-13 定,方案在仓根 docs/ToBeImproved/手机首次引导方案_2026-11-13/index.html,做法 A):
 * 在哪运行 → 外观 → 想让它做哪些事。外壳还是 OnboardingWizard(进度点、跳过、上一步、底栏主按钮都是它的);
 * 手机特有的两屏和它们背后的原生能力,由手机入口登记进来(mobile/src/phoneGuide),
 * 所以共用代码不 import mobile/src,也不 import capacitor。
 *
 * 没登记 = 不是手机 App(桌面、网页版、设备页):各走各的步骤序,这里的东西一概不出现。
 * 手机 App 的包在普通浏览器里跑(台架)时也会登记,只是没有原生能力,「想让它做哪些事」那屏自然不出现。
 *
 * 本文件只有类型、几个本机记号和一段纯逻辑,不带界面也不带别的依赖:登录前那屏(还没有引擎、没有 store)也会读这里的记号。
 */
import type React from 'react'
import type { Step } from '../onboardingFlow'

/** 手机特有的两屏。「外观」是共用的那屏(theme),不在这里。 */
export type PhoneStep = 'where' | 'perms'

/** 手机屏从外壳拿到的东西。 */
export interface PhoneScreenProps {
  /**
   * 主按钮按下时先跑这个,跑完才往下走。
   * 返回 false = 留在这一屏(刚过完系统权限框,要让人看到结果);抛错 = 外壳在底栏报错并留在这一屏;没挂 = 直接往下走。
   * 屏卸载时自己置回 null。
   */
  commitRef: React.MutableRefObject<(() => Promise<void | boolean>) | null>
  /** 把主按钮的字换成这一句(已经翻译好的);null = 用外壳自己的「继续 / 开始使用」。 */
  setPrimaryLabel: (label: string | null) => void
  /** 系统框开着的那一会儿锁住底栏和「跳过引导」。连电脑那种可能等上一两分钟的事不要锁,离开这一屏时自己收掉。 */
  onBusyChange: (busy: boolean) => void
}

/** 手机入口登记进来的那一份。 */
export interface PhoneGuideHost {
  /**
   * 向导画出第一屏之前等它一下:去读「在哪运行」的名册,读到或者到时限就回来。不抛错。
   * 步骤序在它回来之后才定,定了就不再变。
   */
  prepare(): Promise<void>
  /**
   * 这一屏在这台手机上有没有内容。
   * - where:账号下除了云端还有别的地方可选。名册没读到(还在读 / 读失败)按「不知道」算有,屏上自己说明并给重试,
   *   不能当成「没有电脑」。
   * - perms:至少有一项原生能力可问(浏览器里跑时一项都没有)。
   */
  available(step: PhoneStep): boolean
  /** 两屏的内容(标题、说明、选项);外壳负责换屏、进度点和底栏。 */
  screens: Record<PhoneStep, React.ComponentType<PhoneScreenProps>>
  /** 第一屏上按系统返回 = 收起 App(下次从这一屏接着来)。只有原生壳给;没给 = 不动,和以前一样。 */
  minimize?: () => void
  /** 设置 › 设备权限 的手机版:同样三项,引导里没开的在这里补开。没给 = 设置里不出现这一页。 */
  PermissionsPanel?: React.ComponentType
}

let host: PhoneGuideHost | null = null

/** 手机入口在挂载前调一次。传 null = 撤掉(只给测试用)。 */
export function installPhoneGuide(next: PhoneGuideHost | null): void {
  host = next
}

/** 没登记返回 null。 */
export function phoneGuide(): PhoneGuideHost | null {
  return host
}

// ── 本机记号 ──────────────────────────────────────────────────────────────────

/** 引导走完 / 跳过过。和 OnboardingWizard.ONBOARDING_DISMISS_KEY 是同一个字面量(单测钉住两边相等)。 */
export const GUIDE_DONE_KEY = 'forsion_tangu_onboarding_done'
/** 上次走完引导时的版本。同 OnboardingWizard.ONBOARDING_VERSION_KEY。 */
export const GUIDE_VERSION_KEY = 'forsion_tangu_onboarding_version'

/**
 * 手机引导的版本:引导里每加一屏(或者某一屏多了要重新问的内容)就加一,并在 PHONE_STEP_SINCE 里记上那一屏。
 * 手机读不到 App 版本号(也不该为这件事去加 appVersion —— 那会把「每次发版全屏看更新日志」一起带到手机上),
 * 所以不和 CHANGELOG 的版本比,单独记一个整数。
 */
export const PHONE_GUIDE_REV = 1
export const PHONE_GUIDE_REV_KEY = 'forsion_phone_guide_rev'
/** 做到哪一屏了(App 被杀后回到那一屏)。走完 / 跳过时清掉。 */
export const PHONE_GUIDE_STEP_KEY = 'forsion_phone_guide_step'
/** 主页那四条建议:走完完整的手机引导后记上,发出第一条消息后清掉。只有手机引导会写它。 */
export const PHONE_GUIDE_SUGGEST_KEY = 'forsion_phone_guide_suggest'

/**
 * 哪一版手机引导起有这一屏 —— 走过旧引导的老用户只补看比他记下的版本新的屏。没记 = 只在完整引导里有。
 * 这一版只补「想让它做哪些事」;「在哪运行」等手机本机引擎上线那一版再记(那时多了「这台手机」一项,值得问一次)。
 */
export const PHONE_STEP_SINCE: Partial<Record<PhoneStep, number>> = { perms: 1 }

export interface PhoneGuideKeys {
  done: boolean
  version: string | null
  rev: string | null
}

const read = (key: string): string | null => localStorage.getItem(key)

/** 读不了 localStorage(隐私模式)返回 null:当「不知道」,调用方不据此弹补看,也不据此改写。 */
export function readPhoneGuideKeys(): PhoneGuideKeys | null {
  try {
    return { done: read(GUIDE_DONE_KEY) !== null, version: read(GUIDE_VERSION_KEY), rev: read(PHONE_GUIDE_REV_KEY) }
  } catch {
    return null
  }
}

/**
 * 这个人已经看到了第几版手机引导。
 * - 记过手机引导版本:就是它。记的东西认不出来,按「看过了」算,不反复打扰。
 * - 没记过、但有版本记号:走过旧引导的真实用户(版本记号从 2.0 起每次走完都写)= 第 0 版,补看之后新增的屏。
 * - 只有完成记号:台架种的(二十来个脚本只种这一个键),不补看。
 */
function seenRev(keys: PhoneGuideKeys): number {
  if (keys.rev !== null) {
    const n = Number(keys.rev)
    return Number.isInteger(n) && n >= 0 ? n : PHONE_GUIDE_REV
  }
  return keys.version ? 0 : PHONE_GUIDE_REV
}

const PHONE_FULL = ['where', 'theme', 'perms'] as const

export type PhoneGuidePlan =
  | { mode: 'full'; order: Step[] }
  | { mode: 'update'; order: Step[] }
  | { mode: 'none'; order: Step[] }

/**
 * 这次要不要出手机引导、出哪几屏。纯逻辑(单测 phoneGuide.test.ts)。
 * - 没走过引导:完整的,在哪运行 → 外观 → 想让它做哪些事,没内容的屏不出现(外观总在)。
 * - 走过:只补比他记下的版本新的屏;一屏都没有 = 不出。
 */
export function phoneGuidePlan(keys: PhoneGuideKeys, available: (step: PhoneStep) => boolean): PhoneGuidePlan {
  if (!keys.done) return { mode: 'full', order: PHONE_FULL.filter((s) => s === 'theme' || available(s)) }
  const seen = seenRev(keys)
  const order = PHONE_FULL.filter((s): s is PhoneStep => s !== 'theme' && (PHONE_STEP_SINCE[s] ?? 0) > seen && available(s))
  return order.length ? { mode: 'update', order } : { mode: 'none', order: [] }
}

/** App 被杀之前做到的那一屏在这次步骤序里的位置;没记、认不出、已经不在这次的步骤序里 = 0(从头)。 */
export function resumePhoneGuideAt(order: readonly Step[]): number {
  try {
    const at = order.indexOf(read(PHONE_GUIDE_STEP_KEY) as Step)
    return at > 0 ? at : 0
  } catch {
    return 0
  }
}

export function notePhoneGuideStep(step: Step): void {
  try { localStorage.setItem(PHONE_GUIDE_STEP_KEY, step) } catch { /* 隐私模式:记不下就每次从头 */ }
}

/**
 * 走完 / 跳过时调:记下看到了这一版,清掉「做到哪」。
 * @param suggest 走的是完整引导(不是老用户补看):主页出那四条建议。
 */
export function finishPhoneGuide(suggest: boolean): void {
  try {
    localStorage.setItem(PHONE_GUIDE_REV_KEY, String(PHONE_GUIDE_REV))
    localStorage.removeItem(PHONE_GUIDE_STEP_KEY)
    if (suggest) localStorage.setItem(PHONE_GUIDE_SUGGEST_KEY, '1')
  } catch { /* 隐私模式 */ }
}

export function phoneSuggestPending(): boolean {
  try { return read(PHONE_GUIDE_SUGGEST_KEY) === '1' } catch { return false }
}

export function clearPhoneSuggest(): void {
  try { localStorage.removeItem(PHONE_GUIDE_SUGGEST_KEY) } catch { /* 隐私模式 */ }
}
