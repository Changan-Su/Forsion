/** 首次引导的步骤编排(纯逻辑;单测 onboardingFlow.test.ts)。界面在 OnboardingWizard.tsx。 */
import { cmpVersion } from '@amadeus-shared/ipc'

export type Step = 'welcome' | 'connect' | 'model' | 'theme' | 'workspace' | 'env' | 'background' | 'permissions' | 'done'
export type PermissionTab = 'computer' | 'history' | 'media' | 'improve'

/**
 * 完整引导的步骤,按宿主能力收缩。桌面:后台 Agent 排在「权限与数据」前一步 —— Muse 的开关和电脑历史前后挨着
 * (Muse 说明里那句「可以在下一步开启电脑历史」指的就是这个相邻关系,挪顺序时一起改)。
 */
export function stepOrder(caps: { agentBackend: boolean; envCheck: boolean; config: boolean; permissions: boolean }): Step[] {
  const steps: Step[] = caps.agentBackend && caps.envCheck
    ? ['welcome', 'connect', 'model', 'theme', 'workspace', 'env', 'background', 'done']
    : caps.agentBackend && caps.config ? ['welcome', 'background', 'theme', 'done'] : ['welcome', 'theme', 'done']
  if (caps.permissions) steps.splice(steps.indexOf('done'), 0, 'permissions')
  return steps
}

/**
 * 哪一版起这一步里多了值得让老用户看一眼的设置(2.13.4:「权限与数据」里的电脑历史;2.13.8:「帮助改进」页签)。
 * 以后引导里再加新设置,在这里记上引入它的版本;不记 = 只有新装的人会在完整引导里看到。
 * ⚠️ 2.13.8 = 「帮助改进」预计随之发出的版本:发版时核对实际版本号,不是这一版就改成那一版(老用户靠它在升级短引导里看到告知)。
 */
export const STEP_SINCE: Partial<Record<Step, string>> = { permissions: '2.13.8' }

/**
 * 「权限与数据」的分页,按本机有什么收缩:帮助改进排在「语音与媒体」之后(契约 §5)。
 * @param computer 这台电脑能用 Computer Use(「操作电脑」);history 电脑历史;improve Extend 的 telemetry:get 答了 available。
 */
export function permissionTabList(o: { computer: boolean; history: boolean; improve: boolean }): PermissionTab[] {
  return [...(o.computer ? ['computer' as const] : []), ...(o.history ? ['history' as const] : []), 'media', ...(o.improve ? ['improve' as const] : [])]
}

/** 升级短引导里「权限与数据」这一步在本机算不算有新内容:有电脑历史或有帮助改进(两样都是 STEP_SINCE 记下的新设置)。 */
export const permissionsNewHere = (o: { history: boolean; improve: boolean }): boolean => o.history || o.improve

/**
 * 版本更新后的短引导:「更新了什么」一屏 + 上次看引导之后新增的步骤。没有新增就只有那一屏。
 * @param seen 上次走完 / 跳过引导时记下的版本;没有记录按「都没看过」。
 * @param available 这一步的新内容在本机有没有(电脑历史在不支持的系统上不出现,那一步就不算新)。
 */
export function updateOrder(full: Step[], seen: string | null, available: (step: Step) => boolean): Step[] {
  return ['welcome', ...full.filter((step) => {
    const since = STEP_SINCE[step]
    return !!since && available(step) && (!seen || cmpVersion(seen, since) < 0)
  })]
}
