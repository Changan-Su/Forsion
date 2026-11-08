/**
 * 「帮助改进 Forsion」(匿名遥测告知,契约 docs/ToBeImproved/默认数据采集方案_2026-10-28/contract.md §5)在宿主这边的读法。
 * 开关与「看过告知」都存在 Forsion Extend 那边(cloudInvoke 'telemetry:get' / 'telemetry:set'),这里只读视图;
 * 画的地方在首启引导「开始」屏账号卡底那一行(onboarding/StartScreen.tsx 的 ImproveRow)和升级短引导「更新了什么」那屏(OnboardingWizard)。
 * 旧引导「权限与数据」里的「帮助改进」分页组件已删(11-07),文件名沿用,两处 import 不动。
 */
/** Extend telemetry:get 的视图(只取引导用得到的几项)。 */
/** signedIn:新版 Extend 起,帮助改进只在登录 Forsion 后发送(11-05 用户定),Extend 在视图里报这一项;老版本没有 = 不知道。 */
export interface TelemetryView { available: true; enabled: boolean; noticeSeen: boolean; signedIn?: boolean }

export const asTelemetryView = (v: unknown): TelemetryView | null => {
  const o = v as { available?: unknown; enabled?: unknown; noticeSeen?: unknown; signedIn?: unknown } | null
  return o && typeof o === 'object' && o.available === true
    ? { available: true, enabled: o.enabled !== false, noticeSeen: o.noticeSeen === true, ...(typeof o.signedIn === 'boolean' ? { signedIn: o.signedIn } : {}) }
    : null
}

/** 同步判断:本机的 Extend 有没有遥测通道(preload 只在 Extend 注册了 telemetry:get 时留 telemetryReport 键)。
 *  ImproveRow 挂载时先靠它同步定「有没有这一行」;真有没有还要等 readTelemetry 答 available。 */
export const improveOnThisHost = (): boolean => typeof window.tangu?.telemetryReport === 'function' && typeof window.tangu?.cloudInvoke === 'function'

/** 读一次;没有通道 / 拒了 / 没答 available → null(那一行不出现)。 */
export async function readTelemetry(): Promise<TelemetryView | null> {
  if (!improveOnThisHost()) return null
  try { return asTelemetryView(await window.tangu!.cloudInvoke!('telemetry:get')) } catch { return null }
}
