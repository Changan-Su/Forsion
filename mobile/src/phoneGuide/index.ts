/**
 * 手机首次引导的宿主登记(方案 A,2026-11-13;接缝 = desktop/frontend/src/components/onboarding/phoneGuide.ts)。
 * 共用的向导不 import mobile/src 也不 import capacitor:手机特有的两屏、名册的预读、第一屏的「收起 App」都从这里交进去。
 *
 * 只在手机 App 的包里登记(window.tangu?.mobile):桌面与网页版(webShim)没有这个标记,共用代码里 phoneGuide() 恒为 null,
 * 手机的屏一概不出现。手机包在普通浏览器里跑(台架)时也登记,只是没有原生能力 —— 「想让它做哪些事」那屏自然没有,
 * 第一屏按返回也不收起(浏览器桩的 isNativePlatform 恒 false)。
 */
import { Capacitor } from '@capacitor/core'
import { App as CapApp } from '@capacitor/app'
import { installPhoneGuide, type PhoneStep } from '@/components/onboarding/phoneGuide'
import { useDeviceSessions } from '@/stores/deviceSessionsStore'
import { rosterAvailable, runLocationsAvailable } from '@/features/runtime'
import { loadRoster, WhereScreen } from './WhereScreen'
import { PermissionsPanel, PermsScreen } from './PermsScreen'
import { phoneCaps } from './caps'

/** 向导画第一屏之前最多等名册这么久;过了就按「不知道」往下走(那屏自己说明并给重试)。 */
const PREPARE_LIMIT_MS = 2000

async function prepare(): Promise<void> {
  try {
    // 这一端建不了别处的会话(没登录 / 设备页):「在哪运行」没得选,不用等
    if (!runLocationsAvailable()) return
    if (useDeviceSessions.getState().units !== null) return // 底下已经读到过
    await Promise.race([loadRoster(), new Promise<void>((res) => setTimeout(res, PREPARE_LIMIT_MS))])
  } catch {
    /* 不抛错:读不到就是「不知道」 */
  }
}

function available(step: PhoneStep): boolean {
  if (step === 'perms') return phoneCaps().length > 0
  // where:除了云端还有没有别处可选
  if (!rosterAvailable()) return false // 没有名册桥
  const units = useDeviceSessions.getState().units
  // 名册没读到 ≠ 没有电脑:这一端能用别处运行就照样出这一屏(屏上说明并给重试),不能当成只剩云端
  if (units === null) return runLocationsAvailable()
  return units.length > 0
}

export function installPhoneGuideHost(): void {
  if (!window.tangu?.mobile) return
  const hasCaps = phoneCaps().length > 0
  installPhoneGuide({
    prepare,
    available,
    screens: { where: WhereScreen, perms: PermsScreen },
    // 第一屏按系统返回 = 收起 App(同 MobileRoot 的 leaveOrHome);只有原生壳能收
    ...(Capacitor.isNativePlatform() ? { minimize: () => { void CapApp.minimizeApp() } } : {}),
    ...(hasCaps ? { PermissionsPanel } : {}),
  })
}
