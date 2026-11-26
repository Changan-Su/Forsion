/**
 * 插件 manifest `capabilities` 的给人看的说法:设置 → 插件的详情页(「这个插件可以：…」)和商店详情页共用一份。
 * 能力名的白名单在 shared/amadeus/ipc.ts 的 PLUGIN_CAPABILITIES;那边加了这边也要加(没有说法的能力不列)。
 */
import { registerMessages } from '../i18n'
import type { PluginCapability } from '@amadeus-shared/ipc'

registerMessages({
  'settings.amadeusPlugins.capDatabases': { zh: '读写你的多维表', en: 'read and edit your databases' },
  'settings.amadeusPlugins.capNoteTasks': { zh: '读写笔记里的 @ 任务', en: 'read and edit @ tasks in your notes' },
  'settings.amadeusPlugins.capSpaces': { zh: '打开 Space，调整 Ribbon 上 Space 的顺序和收纳夹', en: 'open Spaces and rearrange Spaces and folders on the Ribbon' },
  'settings.amadeusPlugins.capCalendar': {
    zh: '读取 Agent 日程、.ics 订阅和另一侧库里的日历，管理 .ics 订阅并改日历设置',
    en: 'read Agent schedules, .ics subscriptions and calendars in your other vault, manage .ics subscriptions and change calendar settings',
  },
  'settings.amadeusPlugins.capAgentImport': { zh: '新建 Agent、导入聊天记录', en: 'create agents and import chats' },
  'settings.amadeusPlugins.capActiveWindow': { zh: '读取前台窗口', en: 'see which window is in front' },
  // 演示舞台(2026-11-20+,electron/pluginStage.ts):另起一份 Forsion 来截图录像,第一次用时还会再问
  // 插件桌面小窗(2026-11-26,pluginDesktopWindow.ts):画到 Forsion 外面、盖在别的应用上,第一次用时还会再问
  'settings.amadeusPlugins.capDesktopWindow': { zh: '在桌面上显示浮在其他应用上面的小窗', en: 'show small windows on your desktop, above other apps' },
  'settings.amadeusPlugins.capStage': { zh: '另起一份隔离的 Forsion 来演示、截图和录屏', en: 'start a separate, isolated copy of Forsion for demos, screenshots and recordings' },
  // 内部口子(2026-11-16+,amadeus/plugins/pluginInternals.ts):两级轻重不同,用户启用前有权知道
  'settings.amadeusPlugins.capInternals': { zh: '读取 Forsion 的内部状态', en: 'read Forsion internals' },
  'settings.amadeusPlugins.capInternalsRaw': { zh: '直接操作 Forsion 的内部对象', en: 'work on Forsion internals directly' },
})

/** 按这个顺序列(用户数据在前,敏感的前台窗口在后,内部接口最后)。 */
export const CAP_LABELS: Array<[PluginCapability, string]> = [
  ['databases', 'settings.amadeusPlugins.capDatabases'],
  ['noteTasks', 'settings.amadeusPlugins.capNoteTasks'],
  ['calendar', 'settings.amadeusPlugins.capCalendar'],
  ['spaces', 'settings.amadeusPlugins.capSpaces'],
  ['agentImport', 'settings.amadeusPlugins.capAgentImport'],
  ['activeWindow', 'settings.amadeusPlugins.capActiveWindow'],
  ['stage', 'settings.amadeusPlugins.capStage'],
  ['desktopWindow', 'settings.amadeusPlugins.capDesktopWindow'],
  ['internals', 'settings.amadeusPlugins.capInternals'],
  ['internals-raw', 'settings.amadeusPlugins.capInternalsRaw'],
]

/** 声明的能力 → 说法列表(白名单外的、没有说法的略去;只声明 internals-raw 不声明 internals 的,二级不生效,不列)。 */
export function capabilityLabels(caps: readonly unknown[] | null | undefined, t: (k: string) => string): string[] {
  if (!Array.isArray(caps)) return []
  return CAP_LABELS
    .filter(([c]) => caps.includes(c) && (c !== 'internals-raw' || caps.includes('internals')))
    .map(([, k]) => t(k))
}

/** 声明了内部接口、但作者验过的版本里没有当前这一版的次版本(只比 主.次;没写 = 没验过)。只用于标注,不拦。 */
export function internalsUnverified(p: { capabilities?: readonly string[]; internalsVerified?: readonly string[] }, appVersion: string): boolean {
  if (!p.capabilities?.includes('internals')) return false
  const m = /^(\d+)\.(\d+)/.exec(appVersion)
  if (!m) return false
  return !(p.internalsVerified ?? []).includes(`${Number(m[1])}.${Number(m[2])}`)
}
