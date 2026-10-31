/**
 * 插件沙箱首屏的种子:把父进程带来的语言、主题写进本机 localStorage,并把首启引导标成走过 —— 沙箱一开就是插件。
 *
 * ⚠️ 必须是 main.tsx 的**第一个** import:主题 store(stores/themeStore)和 i18n 在被 import 时就读 localStorage,
 * 写晚了它们手里就是旧值(台架 check:pluginsandbox 1c 抓过)。所以本文件除了 types.ts(只有常量)什么都不 import。
 * 普通实例里 window.tangu.sandbox 不存在,这里什么也不做。
 */
import { LOCALE_KEY } from '../types'

/** 父进程带来的那几把主题键:只收主题 / 玻璃,别的键(登录、库、偏好)一律不写。 */
const SEED_KEY = /^forsion_(theme|glass)/
// 与 components/OnboardingWizard.tsx 的 ONBOARDING_DISMISS_KEY / ONBOARDING_VERSION_KEY 同值(那边一 import 就带进 store)
const ONBOARDING_DISMISS_KEY = 'forsion_tangu_onboarding_done'
const ONBOARDING_VERSION_KEY = 'forsion_tangu_onboarding_version'

const self = window.tangu?.sandbox?.self
if (self) {
  try {
    for (const [k, v] of Object.entries(self.ui?.storage ?? {})) if (SEED_KEY.test(k) && typeof v === 'string') localStorage.setItem(k, v)
    if (self.ui?.locale === 'zh' || self.ui?.locale === 'en') localStorage.setItem(LOCALE_KEY, self.ui.locale)
    localStorage.setItem(ONBOARDING_DISMISS_KEY, '1')
    if (self.appVersion) localStorage.setItem(ONBOARDING_VERSION_KEY, self.appVersion)
  } catch { /* 存不下:照常启动,只是会看到引导 */ }
}
