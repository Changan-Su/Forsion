/** 首次引导的步骤编排(纯逻辑;单测 onboardingFlow.test.ts)。界面在 OnboardingWizard.tsx 与 onboarding/ 下的四屏。
 *  方案:docs/ToBeImproved/首启引导第三轮方案_2026-11-04/revised.html(11-05 定稿):开始 → 外观 → 关于你 → 认识你的 Agents 团队。 */
import { cmpVersion } from '@amadeus-shared/ipc'

/** welcome 只在升级短引导里出现(「已更新到 X」那一屏);完整引导第一屏就是 start。 */
export type Step = 'welcome' | 'start' | 'theme' | 'you' | 'team'

/**
 * 完整引导的步骤,按宿主能力收缩。
 * - 桌面(本机引擎 + 配置接口):开始 → 外观 → 关于你 → 团队。
 * - 网页 / 手机:只有外观。账号跟着主机走(没有「开始」);human/ 与卜算子的设置都不接受远程写(没有「关于你」「团队」)。
 */
export function stepOrder(caps: { host: boolean }): Step[] {
  return caps.host ? ['start', 'theme', 'you', 'team'] : ['theme']
}

/**
 * 哪一版起有这一步(老用户在升级短引导里看到它)。以后引导里再加新屏,在这里记上引入它的版本;不记 = 只有完整引导里有。
 * ⚠️ 2.14.0 = 新引导预计随之发出的版本:发版时核对实际版本号。
 */
export const STEP_SINCE: Partial<Record<Step, string>> = { you: '2.14.0', team: '2.14.0' }

/** 上次看引导时记下的版本早于它(或没有记录)的老用户:新引导完整走一遍(11-05 用户定),之后才按更新内容。 */
export const FULL_GUIDE_BEFORE = '2.13.8'
export const needsFullGuide = (seen: string | null): boolean => !seen || cmpVersion(seen, FULL_GUIDE_BEFORE) < 0

/**
 * 版本更新后的短引导:「更新了什么」一屏 + 上次看引导之后新增的步骤。没有新增就只有那一屏。
 * @param seen 上次走完 / 跳过引导时记下的版本;没有记录按「都没看过」(实际走不到这里:没记录的走完整引导)。
 * @param available 这一步在本机有没有内容可看。
 */
export function updateOrder(full: Step[], seen: string | null, available: (step: Step) => boolean = () => true): Step[] {
  return ['welcome', ...full.filter((step) => {
    const since = STEP_SINCE[step]
    return !!since && available(step) && (!seen || cmpVersion(seen, since) < 0)
  })]
}

/** 「主动程度」三档 → 引擎 INTRO_PROACTIVITY 的键(非常 = 1h、普通 = 2h 缺省、一般 = 3h;界面不显示时间)。 */
export const PROACTIVITY = ['high', 'normal', 'low'] as const
export type Proactivity = typeof PROACTIVITY[number]
export const INTRO_WHEN = ['anytime', 'daytime', 'open'] as const
export const INTRO_FOCUS = ['schedule', 'study', 'projects', 'inbox'] as const
export const FOCUS_TEXT_MAX = 60
