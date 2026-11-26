import { isCorePlugin } from '../../../shared/corePlugins'
import { CorePluginUpdates, EngineVersionHint } from './CorePluginUpdates'
import { APP_VERSION } from '../changelog'
import { hasNativeFeature } from '../features/runtime'
import { NativeFeaturesSection } from '../features/NativeFeaturesSection'
/**
 * 设置 → Forsion 插件:列表(卡片可点击)+ 详情页(manifest 信息/启停/依赖应用一键安装/插件命令/README)。
 * 依赖应用安全模型:manifest 只声明 requiresApp id,安装命令文本在宿主 KNOWN_APPS 白名单表,
 * 执行复用 env:run 通道(opaque installId+流式输出);连接探测由 renderer 直连(CSP 放行 localhost)。
 * 数据源是 vendored 的 usePluginStore(与 Amadeus Space 同一单例);样式照 PluginsTab 的 hint/btn 约定。
 */
import React, { useEffect, useRef, useState } from 'react'
import { ArrowLeft, Bot, CalendarDays, Cloud, Info, Languages, NotebookText, type LucideIcon } from 'lucide-react'
import { useSpaceStore } from '@lcl/engine'
import { pluginFootprint, pluginVaultFolder, pluginWanted, runningDependents, unmetPluginDeps, usePluginStore } from '@amadeus/plugins/pluginStore'
import { PluginUninstallDialog, SupersededCleanupDialog } from './UninstallDialog'
import { cleanupSupersededCopy, supersededVaultFolder, uninstallForsionPlugin } from './pluginUninstall'
import { amadeus } from '@amadeus/api'
import { installAmadeusPlugins, reloadPluginsAndAnnounce } from '../amadeusPlugins'
import { usePluginOnboarding, needsOnboarding, promptIfPending, isGate } from '../stores/pluginOnboardingStore'
import { pluginDataSyncOn, pluginDataSyncUserOff, setPluginDataSyncUserOff } from '../amadeus/plugins/pluginDataSync'
import { registerMessages, useI18n } from '../i18n'
import { PRODUCT } from '../product'
import { pluginDisplayName, pluginDisplayDescription, resolvePluginDetail, localizedOnboarding, pluginsWithSettingsPanel } from '../amadeus/plugins/display'
import { forsionPluginHasSettings, readKnownPluginSettings } from './pluginSettingsNav'
import { Markdown } from './Markdown'
import { SettingsSwitch } from './SettingsPrimitives'
import { ReasonSwitch, type LifecycleReason } from './PluginReasons'
import { sendTelemetry } from '../telemetrySend'
import { telemetryPluginRef } from '../telemetryPluginId'
import { KNOWN_APPS } from '../../../shared/knownApps'
import { rescanPlugins, setPluginEnabled, type PluginInfo } from '../services/backendService'
import { loadUserSpaces, pluginOfSpace } from '../userSpaces'
import { hiddenSpaceName, hiddenSpaceReason, useHiddenSpacesOf } from '../pluginSpaceHealth'
import { liveHostDenials, useHostDenials } from '../amadeus/plugins/hostDenials'
import { readTangu } from '../amadeus/plugins/tanguSeam'
import { formatTime } from '../format/time'
import { BuiltinPluginsSection } from '../builtins'
import { useApp } from '../stores/appStore'
import { track } from '../achievements/store'
import { panelToast } from './PanelNotice'
import { LocalPluginVersions } from './MarketPluginAutoUpdate'
import { afterMarketInstall } from '../marketPostInstall'
import { ipcErrorText } from '../ipcError'
import { windowKind } from '../windowKind'
import type { TanguDesktopConfig } from '../types'
import type { AmadeusPlugin, SettingContribution, SettingsViewContribution } from '@amadeus/plugins/types'
import type { PluginDependency } from '@amadeus-shared/ipc'
import type { UnmetDependency } from '../amadeus/plugins/pluginDeps'
import { PluginLogo } from './PluginLogo'
import { canOpenPluginsFolder, canRevealInFileManager } from '../amadeus/lib/hostCaps'
import { FileOpenersPanel } from './FileOpenersPanel'
import { homeTarget } from '../services/engine/targets'
import { internalsAvailable } from '../amadeus/plugins/pluginInternals'
import { capabilityLabels, internalsUnverified } from './pluginCapabilityLabels'

registerMessages({
  // 插件请求被宿主拒掉(11-23,hostDenials.ts):设置卡上的注明与记录
  'settings.amadeusPlugins.engineNeedsManaged': {
    zh: '这个插件的引擎半身要本机托管引擎。现在连的是外部引擎，插件里靠引擎的部分用不了。',
    en: 'This plugin’s engine half needs the local engine that Forsion manages. Forsion is connected to an external engine, so the parts that rely on it won’t work.',
  },
  'settings.amadeusPlugins.hostRefusedTitle': { zh: '被拒绝的请求', en: 'Refused requests' },
  'settings.amadeusPlugins.hostRefused.external-engine': { zh: '{api} 被拒绝：现在连的是外部引擎，这个接口只在本机托管引擎下可用。（{time}）', en: '{api} was refused: Forsion is connected to an external engine, and this call only works with the local managed engine. ({time})' },
  'settings.amadeusPlugins.hostRefused.no-local-engine': { zh: '{api} 被拒绝：这台设备上没有本机引擎。（{time}）', en: '{api} was refused: there is no local engine on this device. ({time})' },
  'settings.amadeusPlugins.hostRefused.engine-unavailable': { zh: '{api} 被拒绝：本机引擎没有及时就绪。（{time}）', en: '{api} was refused: the local engine was not ready in time. ({time})' },
  // 带主进程半身的内置包(Forsion Extend):开关改的是下次开机装不装那一半
  'settings.amadeusPlugins.lockedHint': {
    zh: '关闭后，从下次启动起不再加载 Forsion 云端功能（账号、云同步、Connect 等），本机数据不受影响。',
    en: 'When turned off, Forsion cloud features (account, cloud sync, Connect, and more) stop loading from the next launch. Local data is not affected.',
  },
  'settings.amadeusPlugins.restartPending': { zh: '重启 Forsion 后生效。', en: 'Takes effect after Forsion restarts.' },
  'settings.amadeusPlugins.restartNow': { zh: '立即重启', en: 'Restart now' },
  // manifest syncData:插件数据随账号同步,每台设备各自的开关
  'settings.amadeusPlugins.syncData': { zh: '跨设备同步插件数据', en: 'Sync plugin data across devices' },
  'settings.amadeusPlugins.syncDataHint': {
    zh: '登录 Forsion 账号后，这个插件保存的数据会同步到你的其他设备。关掉后只存在这台设备上。',
    en: 'When you are signed in to Forsion, the data this plugin saves syncs to your other devices. Turn it off to keep it on this device only.',
  },
  'settings.amadeusPlugins.unitIntro': { zh: '查看已安装的功能和编辑器扩展。', en: 'View installed features and editor extensions.' },
  'settings.amadeusPlugins.unitBuiltinTitle': { zh: '编辑器扩展', en: 'Editor extensions' },
  'settings.amadeusPlugins.unitBuiltinHint': { zh: '此处开关仅控制编辑器扩展。Unit 已安装功能由部署配置管理。', en: 'These toggles control editor extensions. Installed Unit features are managed through deployment configuration.' },
  'settings.amadeusPlugins.unitExternalTitle': { zh: '额外插件', en: 'Additional plugins' },
  'settings.amadeusPlugins.unitHint': { zh: '由当前 Unit 发布的额外插件，点击可查看详情。', en: 'Additional plugins published by this Unit. Click a plugin for details.' },
  'settings.amadeusPlugins.unitEmpty': { zh: '此 Unit 暂未发布额外插件。', en: 'No additional plugins published.' },
  // Forsion Sandbox(开发态加载)。**不是隔离沙箱** —— 文案必须把这件事说明白,别让用户以为开发副本被关在笼子里。
  'settings.amadeusPlugins.devBadge': { zh: 'DEV', en: 'DEV' },
  'settings.amadeusPlugins.devHint': {
    zh: '开发态加载：直接运行在当前应用与真实智库中，权限与已安装插件完全相同。',
    en: 'Development load: runs in this app on your real vault, with the same privileges as an installed plugin.',
  },
  'settings.amadeusPlugins.devProject': { zh: '项目：{path}', en: 'Project: {path}' },
  // manifest capabilities:插件声明了要用的用户数据 / 敏感能力,详情页如实告诉用户(没声明的宿主不注入)
  'settings.amadeusPlugins.caps': { zh: '这个插件可以：{list}', en: 'This plugin can: {list}' },
  // manifest network(2026-11-16+):ctx.net 只代请求这些域名;用户在启用前有权知道它会连到哪
  'settings.amadeusPlugins.network': { zh: '会访问：{domains}', en: 'Accesses: {domains}' },
  'settings.amadeusPlugins.internalsBadge': { zh: '使用内部接口', en: 'Uses internal APIs' },
  'settings.amadeusPlugins.internalsRawBadge': { zh: '直接操作内部', en: 'Works on internals directly' },
  'settings.amadeusPlugins.internalsHint': {
    zh: '这个插件会读取 Forsion 的内部状态，Forsion 更新后它可能失效。',
    en: 'This plugin reads Forsion internals and may stop working after an update.',
  },
  'settings.amadeusPlugins.internalsRawHint': {
    zh: '这个插件直接操作 Forsion 的内部对象。Forsion 更新后它可能失效，出错时可能影响你的数据；停用后需要重载窗口。',
    en: 'This plugin works directly on Forsion internals. It may break after an update and can affect your data if it fails. Reload the window after turning it off.',
  },
  'settings.amadeusPlugins.internalsDesktopOnly': { zh: '内部接口只在桌面端提供，这里不会给它。', en: 'Internal APIs are only provided on desktop, so it does not get them here.' },
  // 插件桌面小窗(2026-11-26):第一次开时问过的答案,在这里看 / 收回
  'settings.amadeusPlugins.desktopWindow.allowed': { zh: '你已允许它在桌面上显示小窗。', en: 'You allowed it to show windows on your desktop.' },
  'settings.amadeusPlugins.desktopWindow.denied': { zh: '你没有允许它在桌面上显示小窗，它的小窗会留在 Forsion 窗口里。', en: 'You did not allow it to show windows on your desktop; they stay inside the Forsion window.' },
  'settings.amadeusPlugins.desktopWindow.unasked': { zh: '它第一次要在桌面上显示小窗时会先问你。', en: 'It will ask you the first time it wants to show a window on your desktop.' },
  'settings.amadeusPlugins.desktopWindow.revoke': { zh: '收回', en: 'Take back' },
  'settings.amadeusPlugins.desktopWindow.reset': { zh: '下次再问', en: 'Ask again next time' },
  'settings.amadeusPlugins.internalsUnverified': {
    zh: '作者没有在 Forsion {version} 上验过它用到的内部接口。',
    en: 'The author has not checked its use of internal APIs on Forsion {version}.',
  },
  'settings.amadeusPlugins.devShadows': {
    zh: '正遮蔽同名的已安装插件；撤下开发副本后，安装版会回来。',
    en: 'Shadowing the installed plugin with the same id; unload this dev copy and the installed one comes back.',
  },
  'settings.amadeusPlugins.devUnload': { zh: '卸载开发副本', en: 'Unload dev copy' },
  'settings.amadeusPlugins.devUnloaded': { zh: '已撤下「{name}」的开发副本', en: 'Unloaded the dev copy of "{name}"' },
  'settings.amadeusPlugins.devUnloadFailed': { zh: '撤下开发副本失败：{error}', en: 'Could not unload the dev copy: {error}' },
  'settings.amadeusPlugins.devShadowedUninstall': {
    zh: '请先撤下开发副本，再卸载已安装的版本。',
    en: 'Unload the dev copy first, then uninstall the installed version.',
  },
  'settings.amadeusPlugins.blockedDevFileExt': {
    zh: '开发副本不能声明自定义文件类型（fileExtensions）',
    en: 'A dev copy cannot claim custom file types (fileExtensions)',
  },
  // manifest isDesktopOnly:true 的插件在 Android App 上列出但不装载
  'settings.amadeusPlugins.blockedDesktopOnly': { zh: '仅支持桌面端', en: 'Desktop only' },
  // 没有可见插件目录的宿主(Android App):插件只经商店装
  'settings.amadeusPlugins.marketHint': {
    zh: '启用/禁用即时生效，点击插件可查看详情。插件从商店安装；标为「仅支持桌面端」的插件只能在 Forsion 桌面端使用。',
    en: 'Turning a plugin on or off takes effect immediately; tap a plugin for details. Plugins are installed from the store; plugins marked "Desktop only" work only in Forsion for desktop.',
  },
  'settings.amadeusPlugins.openMarket': { zh: '浏览商店', en: 'Browse the store' },
  // 前置插件(manifest requiresPlugins):装着但开不了 / 前置停了自动暂停、回来自动恢复
  'settings.amadeusPlugins.waitingDeps': { zh: '等待前置插件', en: 'Waiting for required plugins' },
  'settings.amadeusPlugins.loadFailed': { zh: '加载失败', en: 'Failed to load' },
  'settings.amadeusPlugins.needsDepsToEnable': { zh: '需要先安装并启用：{list}', en: 'Install and turn on these first: {list}' },
  'settings.amadeusPlugins.disableDependents': {
    zh: '停用「{name}」后，依赖它的插件也会暂停：{list}。重新启用后它们会自动恢复。继续吗？',
    en: 'Turning off "{name}" also pauses the plugins that require it: {list}. They resume when you turn it back on. Continue?',
  },
  'settings.amadeusPlugins.uninstallDependents': {
    zh: '以下插件依赖「{name}」，卸载后将无法运行：{list}。',
    en: 'These plugins require "{name}" and stop working once it is uninstalled: {list}.',
  },
  'settings.amadeusPlugins.requires': { zh: '前置插件', en: 'Required plugins' },
  'settings.amadeusPlugins.requiresHint': {
    zh: '这些插件运行时它才会运行；它们停下时它自动暂停，回来后自动恢复。',
    en: 'This plugin runs only while these are running. It pauses when they stop and resumes when they come back.',
  },
  'settings.amadeusPlugins.dep.ok': { zh: '运行中', en: 'Running' },
  'settings.amadeusPlugins.dep.missing': { zh: '未安装', en: 'Not installed' },
  'settings.amadeusPlugins.dep.blocked': { zh: '与当前版本不兼容', en: 'Not compatible with this version' },
  'settings.amadeusPlugins.dep.version': { zh: '需要 {min} 或更高，已安装 {have}', en: 'Needs {min} or later; {have} is installed' },
  'settings.amadeusPlugins.dep.cycle': { zh: '与它互相依赖，无法启用', en: 'Requires this plugin in turn, so neither can run' },
  'settings.amadeusPlugins.dep.off': { zh: '已关闭', en: 'Turned off' },
  'settings.amadeusPlugins.dep.waiting': { zh: '已开启，但尚未运行', en: 'Turned on but not running' },
  'settings.amadeusPlugins.dep.findInMarket': { zh: '在商店中查找', en: 'Find in store' },
  'settings.amadeusPlugins.dep.enable': { zh: '启用', en: 'Turn on' },
  // 运行占用(副作用账 + 注册项)
  'settings.amadeusPlugins.effects': { zh: '运行占用 · {n}', en: 'Active effects · {n}' },
  'settings.amadeusPlugins.effectsHint': {
    zh: '插件此刻挂在应用里的东西。停用或重载时按相反顺序全部撤掉；插件已写进智库的文件不受影响。',
    en: 'What this plugin currently holds in the app. Turning it off or reloading undoes all of it in reverse order. Files it already wrote to your vault are not affected.',
  },
  'settings.amadeusPlugins.effect.registrations': { zh: '注册项', en: 'Registrations' },
  'settings.amadeusPlugins.effect.subscription': { zh: '订阅', en: 'Subscriptions' },
  'settings.amadeusPlugins.effect.mount': { zh: '界面挂载', en: 'Embedded UI' },
  'settings.amadeusPlugins.effect.theme': { zh: '主题样式', en: 'Theme styles' },
  'settings.amadeusPlugins.effect.font': { zh: '字体', en: 'Fonts' },
  'settings.amadeusPlugins.effect.editorExtension': { zh: '编辑器扩展', en: 'Editor extensions' },
  'settings.amadeusPlugins.effect.propertyType': { zh: '属性类型', en: 'Property types' },
  'settings.amadeusPlugins.effect.achievements': { zh: '成就', en: 'Achievements' },
  'settings.amadeusPlugins.effect.request': { zh: '进行中的请求', en: 'Requests in flight' },
  'settings.amadeusPlugins.effect.deskCompanion': { zh: 'Agent Desk 伴随面', en: 'Agent Desk companions' },
  'settings.amadeusPlugins.effect.viewSurface': { zh: '视图文件通道', en: 'View file access' },
  // 商店安装取代了同一个包的旧普通目录(方案 B,2026-11-17):列表卡一行注记 + 详情「旧的本地安装」一节
  'settings.amadeusPlugins.superseded.note': { zh: '本机另有一份旧的本地安装 v{version}，已停用', en: 'An older local install (v{version}) is also on this device, turned off' },
  'settings.amadeusPlugins.superseded.noteMobile': { zh: '这台手机上另有一份旧的安装 v{version}，已停用', en: 'An older install (v{version}) is also on this phone, turned off' },
  'settings.amadeusPlugins.superseded.head': { zh: '旧的本地安装', en: 'Older local install' },
  'settings.amadeusPlugins.superseded.headMobile': { zh: '旧的安装', en: 'Older install' },
  'settings.amadeusPlugins.superseded.title': { zh: 'v{version} · 已停用', en: 'v{version} · Turned off' },
  'settings.amadeusPlugins.superseded.sub': {
    zh: '和商店安装的是同一个插件，现在只运行商店那份。它的设置和智库里 {folder} 的资料没有带过来，仍留在原处。',
    en: "It's the same plugin as the store install, and only the store install runs now. Its settings and the files in {folder} in your vault were not carried over. They're still where they were.",
  },
  'settings.amadeusPlugins.superseded.subNoFolder': {
    zh: '和商店安装的是同一个插件，现在只运行商店那份。它的设置没有带过来，仍留在原处。',
    en: "It's the same plugin as the store install, and only the store install runs now. Its settings were not carried over. They're still where they were.",
  },
  'settings.amadeusPlugins.superseded.subMobile': {
    zh: '和商店安装的是同一个插件，现在只运行商店那份。它的设置没有带过来，仍留在这台手机上。',
    en: "It's the same plugin as the store install, and only the store install runs now. Its settings were not carried over. They're still on this phone.",
  },
  'settings.amadeusPlugins.superseded.reveal': { zh: '在访达中显示', en: 'Show in Finder' },
  'settings.amadeusPlugins.superseded.revealWin': { zh: '在文件资源管理器中显示', en: 'Show in File Explorer' },
  'settings.amadeusPlugins.superseded.trash': { zh: '移到回收站', en: 'Move to Trash' },
  'settings.amadeusPlugins.superseded.delete': { zh: '删除旧副本', en: 'Delete old copy' },
  'settings.amadeusPlugins.superseded.deleteConfirm': { zh: '删除后不能恢复，它的设置仍留在这台手机上。', en: "This can't be undone. Its settings stay on this phone." },
  'settings.amadeusPlugins.superseded.done': { zh: '已把旧的本地安装「{name} v{version}」移到回收站', en: 'Moved the older local install of “{name}” (v{version}) to the Trash' },
  'settings.amadeusPlugins.superseded.doneMobile': { zh: '已删除旧副本「{name} v{version}」', en: 'Deleted the old copy of “{name}” (v{version})' },
})

/** 启停后的捆绑包级联:内嵌 Space 显隐同步 + 刷新引擎插件列表。内嵌引擎插件的开关**不在这里写** —— 这里多半是设置浮窗,
 *  它的运行态未必等于主窗的;由主窗收到偏好 / 开启戳后在 syncBundleEngines 里统一串行写(Codex 10-02)。 */
/** 核心插件卡:说明各自一条(别再落到电脑操作那条上),没有 logo 时的图标 = Ribbon / Space 里那个。 */
const CORE_DESCRIPTIONS: Record<string, string> = {
  'forsion-extend': 'plugins.core.extend',
  'tangu-computer-use': 'plugins.core.computerUse',
  'forsion-calendar': 'plugins.core.calendar',
  translation: 'plugins.core.translation',
}
const CORE_ICONS: Record<string, LucideIcon> = { 'forsion-extend': Cloud, 'forsion-calendar': CalendarDays, translation: Languages }

function cascadeAfterToggle(p: AmadeusPlugin, onEngineReload?: () => void): void {
  void loadUserSpaces() // 无 bundle 时幂等无害
  if (p.bundle?.enginePlugins?.length) onEngineReload?.()
}

type T = (k: string, v?: Record<string, string>) => string
type Loc = Parameters<typeof pluginDisplayName>[1]
/** 前置的显示名:装了用它自己的名字,没装用声明里的 name,再不行用 id。 */
const depName = (d: PluginDependency, plugins: AmadeusPlugin[], locale: Loc): string => {
  const installed = plugins.find((x) => x.id === d.id)
  return installed ? pluginDisplayName(installed, locale) : d.name || d.id
}

/** 卡片与详情页共用的开关动作。开关跟意图(偏好)走:在等前置 / 加载失败的插件开关是「开」的,再点一下是关掉它。
 *  关之前把会跟着暂停的依赖方说清楚;开了却没跑起来(setup 抛错)就地报 —— 宿主只发 Amadeus 吐司,只有主窗渲染,
 *  设置浮窗里拨开关就像没反应。 */
function flipPlugin(p: AmadeusPlugin, t: T, locale: Loc, cascade: () => void, reason?: LifecycleReason, want?: boolean): void {
  const wasOn = pluginWanted(p)
  // 停用先问理由:问的这会儿状态可能已经变了(熔断自动停用、别的窗口拨过)—— 已经是想要的状态就什么都不做,别反着拨回去
  if (want !== undefined && wasOn === want) return
  const name = pluginDisplayName(p, locale)
  if (wasOn) {
    const deps = runningDependents(p.id).map((x) => pluginDisplayName(x, locale))
    if (deps.length && !window.confirm(t('settings.amadeusPlugins.disableDependents', { name, list: deps.join(t('common.listSep')) }))) return
  }
  // 同 toggle(按意图翻),停用时带上用户选的理由(遥测 v3 plugin_lifecycle.reason)
  if (wasOn) usePluginStore.getState().disable(p.id, reason ? { reason } : undefined)
  else usePluginStore.getState().enable(p.id)
  const st = usePluginStore.getState()
  if (!wasOn && !st.isActive(p.id) && st.lastSetupError[p.id]) panelToast(t('pluginhost.setupFailed', { name }), true)
  if (!wasOn) void promptIfPending(p.id) // 手动启用 = 注意力在场:实测(连 check),确有未满足才弹检查卡
  cascade()
}

/** 普通插件的开关:勾选 = 想开。用户关着、前置又没齐 → 开不了(灰掉,悬停说缺什么)。 */
const PluginSwitch: React.FC<{ p: AmadeusPlugin; onFlip: (reason?: LifecycleReason, want?: boolean) => void }> = ({ p, onFlip }) => {
  const { t, locale } = useI18n()
  const plugins = usePluginStore((s) => s.plugins)
  const activeIds = usePluginStore((s) => s.activeIds)
  const disabledIds = usePluginStore((s) => s.disabledIds)
  const wanted = pluginWanted(p, disabledIds)
  const unmet = wanted ? [] : unmetPluginDeps(p, { plugins, activeIds, disabledIds })
  const stuck = !!p.blocked || unmet.length > 0
  return (
    <span title={unmet.length ? t('settings.amadeusPlugins.needsDepsToEnable', { list: unmet.map((u) => depName(u.dep, plugins, locale)).join(t('common.listSep')) }) : undefined} onClick={(e) => e.stopPropagation()}>
      <ReasonSwitch data-plugin-switch="" checked={wanted && !p.blocked} disabled={stuck} label={pluginDisplayName(p, locale)} onChange={(on, reason) => onFlip(reason, on)} />
    </span>
  )
}

/** 运行态徽标:想开却没在跑 —— 在等前置,或加载失败(错因放悬停);在跑、但它带的 Space 没出现也算(原因放悬停,详情页逐条列)。 */
const RunBadge: React.FC<{ p: AmadeusPlugin }> = ({ p }) => {
  const { t, locale } = useI18n()
  const plugins = usePluginStore((s) => s.plugins)
  const activeIds = usePluginStore((s) => s.activeIds)
  const disabledIds = usePluginStore((s) => s.disabledIds)
  const error = usePluginStore((s) => s.lastSetupError[p.id])
  const hidden = useHiddenSpacesOf(p.id)
  const warn = { ...badge, color: 'var(--warn, #b8860b)', borderColor: 'var(--warn, #b8860b)' }
  if (hidden.length) return <span data-plugin-space-hidden style={warn} title={hidden.map((h) => `${hiddenSpaceName(h, locale)}: ${hiddenSpaceReason(t, p.id, h)}`).join('\n')}>{t('plugins.spaceHidden.badge')}</span>
  if (p.blocked || activeIds.includes(p.id) || !pluginWanted(p, disabledIds)) return null
  const unmet = unmetPluginDeps(p, { plugins, activeIds, disabledIds })
  if (unmet.length) return <span data-plugin-waiting style={warn} title={unmet.map((u) => depName(u.dep, plugins, locale)).join(t('common.listSep'))}>{t('settings.amadeusPlugins.waitingDeps')}</span>
  if (error) return <span data-plugin-failed style={{ ...badge, color: 'var(--danger, #c0392b)', borderColor: 'var(--danger, #c0392b)' }} title={error}>{t('settings.amadeusPlugins.loadFailed')}</span>
  return null
}

/** 只有本机托管引擎才放行的接口:外部引擎模式下给带引擎半身的插件注明一句,另列这个插件被宿主拒掉的请求(hostDenials.ts)。
 *  拒绝的记录各窗口共用(设置是独立浮窗,插件多半跑在主窗)。请求后来成功了记录自己会撤掉。 */
const HostAccess: React.FC<{ p: AmadeusPlugin }> = ({ p }) => {
  const { t } = useI18n()
  useApp((s) => s.desktopConfig?.mode) // 切引擎模式时重算下面的判定
  const refused = liveHostDenials(useHostDenials((s) => s.byPlugin[p.id]))
  const external = !!p.bundle?.enginePlugins?.length && readTangu()?.hostExecutionBlock?.() === 'external-engine'
  if (!external && !refused.length) return null
  const card = { display: 'flex', flexDirection: 'column', gap: 4, fontSize: 'var(--ui-font-meta, 12px)' } as const
  return (
    <div data-plugin-host-access style={{ display: 'contents' }}>
      {external && <div className="plugin-card" data-plugin-engine-needs-managed style={{ ...card, color: 'var(--warn, #b8860b)' }}>{t('settings.amadeusPlugins.engineNeedsManaged')}</div>}
      {refused.length > 0 && (
        <>
          <div className="hint">{t('settings.amadeusPlugins.hostRefusedTitle')}</div>
          <div className="plugin-card" style={card}>
            {refused.map((d) => (
              <div key={`${d.api}:${d.code}`} data-plugin-host-refused>
                {t(`settings.amadeusPlugins.hostRefused.${d.code}`, { api: d.api, time: formatTime(d.at) })}
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  )
}

/** 开着、却没出现在功能条上的随包 Space:逐个说清原因。配方的原始校验信息是开发日志串,只放悬停。 */
const HiddenSpaces: React.FC<{ p: AmadeusPlugin }> = ({ p }) => {
  const { t, locale } = useI18n()
  const hidden = useHiddenSpacesOf(p.id)
  if (!hidden.length) return null
  return (
    <>
      <div className="hint">{t('plugins.spaceHidden.title')}</div>
      <div className="plugin-card" data-plugin-space-hidden-list style={{ display: 'flex', flexDirection: 'column', gap: 6, fontSize: 'var(--ui-font-meta, 12px)' }}>
        {hidden.map((h) => (
          <div key={h.slug} title={h.detail}>
            <b>{hiddenSpaceName(h, locale)}</b>
            <div style={{ color: 'var(--text-faint)', marginTop: 2 }}>{hiddenSpaceReason(t, p.id, h)}</div>
          </div>
        ))}
      </div>
    </>
  )
}

/** 商店详情页复用前置行时给的东西(MarketModal):整条未满足的链、每行商店里的情况、一键按钮。 */
export interface RequiredPluginsStore {
  unmet: UnmetDependency[]
  row(dep: PluginDependency): { note?: string; find?: boolean }
  find(query: string): void
  foot: React.ReactNode
}

/** 前置插件:逐条说清楚状态,给能做的那一步(去市场找 / 打开它)。设置页与商店详情页共用这些行,商店那边多一句商店里的情况和一键按钮。 */
export const RequiredPlugins: React.FC<{ p: AmadeusPlugin; store?: RequiredPluginsStore }> = ({ p, store }) => {
  const { t, locale } = useI18n()
  const plugins = usePluginStore((s) => s.plugins)
  const activeIds = usePluginStore((s) => s.activeIds)
  const disabledIds = usePluginStore((s) => s.disabledIds)
  const direct = p.requiresPlugins ?? []
  // 商店那边要补全整条链:前置自己缺的也列出来,否则按钮的数字和行对不上
  const deps = store ? [...direct, ...store.unmet.map((u) => u.dep).filter((d) => !direct.some((x) => x.id === d.id))] : direct
  if (!deps.length) return null
  const unmet = store?.unmet ?? unmetPluginDeps(p, { plugins, activeIds, disabledIds })
  const market = !!window.tangu?.marketList && !window.tangu?.unitPage
  const hint = <div style={{ color: 'var(--text-faint)', fontSize: 'var(--ui-font-caption, 11px)' }}>{t('settings.amadeusPlugins.requiresHint')}</div>
  const rows = deps.map((d) => {
    const u = unmet.find((x) => x.dep.id === d.id)
    const installed = plugins.find((x) => x.id === d.id)
    // 前置自己也缺前置时「启用」点了没反应 —— 那就不给按钮,状态行已经说了它关着
    const canEnable = u?.reason === 'off' && !!installed && !unmetPluginDeps(installed, { plugins, activeIds, disabledIds }).length
    const row = store?.row(d)
    const canFind = store ? !!row?.find : market && (u?.reason === 'missing' || u?.reason === 'version')
    return (
      <div key={d.id} data-dep-id={d.id} data-dep-state={u?.reason ?? 'ok'} style={store ? { display: 'flex', flexDirection: 'column', alignItems: 'flex-start', gap: 5 } : { display: 'flex', alignItems: 'center', gap: 8 }}>
        <div style={store ? undefined : { flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 'var(--ui-font-meta, 12px)' }}>
            {depName(d, plugins, locale)}
            {d.minVersion && <span style={{ color: 'var(--text-faint)' }}> ≥ {d.minVersion}</span>}
          </div>
          <div style={{ fontSize: 'var(--ui-font-caption, 11px)', color: u ? 'var(--warn, #b8860b)' : 'var(--text-faint)' }}>
            {!u ? t('settings.amadeusPlugins.dep.ok')
              : u.reason === 'version' ? t('settings.amadeusPlugins.dep.version', { min: d.minVersion ?? '', have: u.have ?? '' })
              : t(`settings.amadeusPlugins.dep.${u.reason}`)}
            {row?.note && <span data-dep-note> · {row.note}</span>}
          </div>
        </div>
        {canFind && (
          <button className="btn ghost sm" onClick={() => (store ? store.find(d.name || d.id) : useApp.getState().openMarket(d.market || d.name || d.id))}>{t('settings.amadeusPlugins.dep.findInMarket')}</button>
        )}
        {canEnable && <button className="btn ghost sm" onClick={() => usePluginStore.getState().enable(d.id)}>{t('settings.amadeusPlugins.dep.enable')}</button>}
      </div>
    )
  })
  if (store) return <div className="mk-deps" data-market-deps={p.id}><div className="mk-deps-head">{t('settings.amadeusPlugins.requires')}</div>{rows}{store.foot}{hint}</div>
  return (
    <>
      <div className="hint">{t('settings.amadeusPlugins.requires')}</div>
      <div className="plugin-card" data-plugin-requires style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        {rows}
        {hint}
      </div>
    </>
  )
}

/** 运行占用:插件此刻挂在应用里的东西。账不是响应式的 —— 展开那一刻现读。 */
const PluginFootprint: React.FC<{ p: AmadeusPlugin }> = ({ p }) => {
  const { t } = useI18n()
  const [, bump] = useState(0)
  const { registrations, effects } = pluginFootprint(p.id)
  const groups = new Map<string, { n: number; labels: Set<string> }>()
  for (const e of effects) {
    const g = groups.get(e.kind) ?? { n: 0, labels: new Set<string>() }
    g.n++
    if (e.label) g.labels.add(e.label)
    groups.set(e.kind, g)
  }
  return (
    <details data-plugin-footprint onToggle={() => bump((n) => n + 1)} style={{ borderTop: 'var(--border-width) solid var(--overlay-medium, rgba(127,127,127,.12))', paddingTop: 12 }}>
      <summary style={{ cursor: 'pointer', fontWeight: 600, fontSize: 'var(--ui-font-meta, 12px)', userSelect: 'none' }}>{t('settings.amadeusPlugins.effects', { n: String(registrations + effects.length) })}</summary>
      <div style={{ paddingTop: 8, display: 'flex', flexDirection: 'column', gap: 4, fontSize: 'var(--ui-font-meta, 12px)' }}>
        <div>{t('settings.amadeusPlugins.effect.registrations')} × {registrations}</div>
        {[...groups].map(([kind, g]) => (
          <div key={kind}>{t(`settings.amadeusPlugins.effect.${kind}`)} × {g.n}{g.labels.size ? <span style={{ color: 'var(--text-faint)' }}> · {[...g.labels].join(', ')}</span> : null}</div>
        ))}
        <div style={{ color: 'var(--text-faint)', fontSize: 'var(--ui-font-caption, 11px)' }}>{t('settings.amadeusPlugins.effectsHint')}</div>
      </div>
    </details>
  )
}

/** 捆绑内容徽章(计数;空捆绑不渲染)。 */
const BundleChips: React.FC<{ p: AmadeusPlugin }> = ({ p }) => {
  const { t } = useI18n()
  if (!p.bundle) return null
  const parts: Array<[string, number]> = [
    ['settings.amadeusPlugins.bundleEngine', p.bundle.enginePlugins.length],
    ['settings.amadeusPlugins.bundleAgents', p.bundle.agents.length],
    ['settings.amadeusPlugins.bundleSkills', p.bundle.skills.length],
    ['settings.amadeusPlugins.bundleSpaces', p.bundle.spaces.length],
  ]
  return (
    <>
      {parts.filter(([, n]) => n > 0).map(([k, n]) => (
        <span key={k} style={{ ...badge, color: 'var(--accent-ink, var(--accent, var(--text-faint)))', borderColor: 'var(--accent-ink, var(--accent, var(--border)))' }}>
          {t(k, { n: String(n) })}
        </span>
      ))}
    </>
  )
}

const badge: React.CSSProperties = {
  fontSize: 'var(--ui-font-caption, 11px)', color: 'var(--text-faint)', border: 'var(--border-width) solid var(--overlay-medium, rgba(127,127,127,.12))',
  borderRadius: 'var(--radius-xs)', padding: '0 4px', whiteSpace: 'nowrap',
}

/** 插件声明的设置项(registerSetting)表单行:值存 localStorage `plugin.<id>.<key>`(全存字符串,
 *  number=String(n)/boolean='true'|'false'),插件在使用处自行读取——轮询型插件下一轮生效。
 *  导出给首启引导就绪卡复用(PluginOnboardingModal)。 */
export const SettingRow: React.FC<{ pluginId: string; def: SettingContribution }> = ({ pluginId, def }) => {
  const lsKey = `plugin.${pluginId}.${def.key}`
  const [val, setVal] = useState<string>(() => {
    const raw = localStorage.getItem(lsKey)
    return raw === null ? String(def.default) : raw
  })
  const write = (next: string): void => {
    setVal(next)
    try {
      if (next === String(def.default)) localStorage.removeItem(lsKey) // 回到默认=清键,插件端 || default 兜底
      else localStorage.setItem(lsKey, next)
    } catch { /* 配额满等,忽略 */ }
    // 前置条件里可能有这一项(setting 类):徽标 / 检查卡的对勾要跟着这一笔走。非闸插件 evaluate 直接返回。
    void usePluginOnboarding.getState().evaluate(pluginId)
  }
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 'var(--ui-font-meta, 12px)' }}>{def.label}</div>
        {def.description && <div style={{ fontSize: 'var(--ui-font-caption, 11px)', color: 'var(--text-faint)' }}>{def.description}</div>}
      </div>
      {def.type === 'boolean' ? (
        <SettingsSwitch checked={val === 'true'} label={def.label} onChange={(on) => write(on ? 'true' : 'false')} />
      ) : def.type === 'number' ? (
        <input
          type="number" value={val} min={def.min} max={def.max}
          style={{ width: 90 }}
          onChange={(e) => write(e.target.value)}
        />
      ) : (
        <input type="text" value={val} style={{ width: 180 }} onChange={(e) => write(e.target.value)} />
      )}
    </div>
  )
}

/** 插件设置页(SettingsModal 的 `fplugin:<id>`)身份卡上的开关:和卡片 / 详情页同一个动作(普通插件 PluginSwitch,
 *  带主进程半身的内置包 BundleSwitch;没有那座桥就不给)。 */
export const PluginEnableSwitch: React.FC<{ p: AmadeusPlugin; onEngineReload?: () => void }> = ({ p, onEngineReload }) => {
  const { t, locale } = useI18n()
  if (p.locked) return window.tangu?.setBundleEnabled ? <BundleSwitch p={p} /> : null
  return <PluginSwitch p={p} onFlip={(reason, want) => flipPlugin(p, t, locale, () => cascadeAfterToggle(p, onEngineReload), reason, want)} />
}

/** 插件设置页「已停用 · 启用」那颗按钮:朝「开」拨(已经想开的不动)。locked 包没有桥就做不了 → false。 */
export function canTurnOnPlugin(p: AmadeusPlugin): boolean {
  return !p.blocked && (p.locked ? !!window.tangu?.setBundleEnabled : true)
}
export function turnOnPlugin(p: AmadeusPlugin, t: T, locale: Loc, onEngineReload?: () => void): void {
  if (!canTurnOnPlugin(p) || pluginWanted(p)) return
  if (p.locked) { void setBundleOn(p, true); return }
  flipPlugin(p, t, locale, () => cascadeAfterToggle(p, onEngineReload))
}

/** manifest `syncData: true` 的插件:这台设备上同不同步它的数据(pluginDataSync.ts;没有 cloudFetch 的宿主不画)。 */
const PluginSyncRow: React.FC<{ p: AmadeusPlugin }> = ({ p }) => {
  const { t } = useI18n()
  const [on, setOn] = useState(() => !pluginDataSyncUserOff(p.id))
  if (!p.syncData || !window.tangu?.cloudFetch) return null
  return (
    <div className="plugin-card" style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 'var(--ui-font-meta, 12px)' }}>{t('settings.amadeusPlugins.syncData')}</div>
        <div style={{ fontSize: 'var(--ui-font-caption, 11px)', color: 'var(--text-faint)' }}>{t('settings.amadeusPlugins.syncDataHint')}</div>
      </div>
      <SettingsSwitch data-plugin-sync="" checked={on} label={t('settings.amadeusPlugins.syncData')} onChange={(next) => { setPluginDataSyncUserOff(p.id, !next); setOn(next) }} />
    </div>
  )
}

/** 插件自绘设置面板(registerSettingsView)的挂载点。宿主只负责给一个干净的容器、
 *  在正确的时机 mount/dispose,里面画什么完全归插件。
 *
 *  ⚠️两条纪律,踩过同类坑:
 *  ①**一容器一次挂载**:mount 只跑在 el+def 变化时。把 def 放进 deps 而不是整个 owner 对象 ——
 *    zustand 每次 set 都产出新的 { pluginId, item } 包装对象,拿它当 deps 会每次 store 变动就
 *    重挂一次面板(用户正在输入的内容当场清零)。
 *  ②**dispose 必须接异常**:第三方 dispose 抛错不能把 React 的 cleanup 链带崩,否则下一个面板
 *    挂不上去。 */
export const PluginSettingsView: React.FC<{ pluginId: string; def: SettingsViewContribution; bare?: boolean; anchor?: string }> = ({ pluginId, def, bare, anchor }) => {
  const ref = useRef<HTMLDivElement | null>(null)
  useEffect(() => {
    const el = ref.current
    if (!el) return
    let dispose: (() => void) | void
    try {
      dispose = def.mount(el, { anchor })
    } catch (e) {
      console.error(`[amadeus] 插件 ${pluginId} 的设置面板 mount 抛错`, e)
      el.textContent = ''
      return
    }
    return () => {
      try {
        if (typeof dispose === 'function') dispose()
      } catch (e) {
        console.error(`[amadeus] 插件 ${pluginId} 的设置面板 dispose 抛错`, e)
      }
      el.textContent = '' // 插件没清干净也不给下一次挂载留残渣
    }
  }, [pluginId, def, anchor])
  // bare:挂进宿主一级页当整页(「Forsion 云端」的子页),版式归插件 —— 不套卡片、不画小标题(左栏子项就是标题)
  if (bare) return <div className="plugin-settings-page" data-plugin-settings={`${pluginId}:${def.id}`} ref={ref} />
  const title = typeof def.title === 'function' ? def.title() : def.title
  return (
    <>
      {title && <div className="hint">{title}</div>}
      <div className="plugin-card" ref={ref} />
    </>
  )
}

const blockedLabel = (t: (k: string, v?: Record<string, string>) => string, p: AmadeusPlugin): string =>
  p.blocked === 'api'
    ? t('settings.amadeusPlugins.blockedApi', { v: String(p.apiVersion ?? '?') })
    : p.blocked === 'invalid'
      ? t('settings.amadeusPlugins.blockedInvalid', { reason: p.blockedReason || '' })
      : p.blocked === 'dev-fileext'
        ? t('settings.amadeusPlugins.blockedDevFileExt')
        : p.blocked === 'desktopOnly'
          ? t('settings.amadeusPlugins.blockedDesktopOnly')
          : t('settings.amadeusPlugins.blockedMinApp', { v: p.minAppVersion || '?' })

/** 内部接口徽章(2026-11-16+):声明了 internals 才有;要了第二级的颜色更重。卡片与详情页同款。
 *  第二级要和第一级一起声明才生效,只声明了 internals-raw 的照「没声明」处理(宿主不注入)。 */
export const InternalsBadge: React.FC<{ t: (k: string) => string; p: AmadeusPlugin }> = ({ t, p }) => {
  if (!p.capabilities?.includes('internals')) return null
  const raw = p.capabilities.includes('internals-raw')
  return (
    <span data-plugin-internals={raw ? 'raw' : 'read'} style={raw ? { ...badge, color: 'var(--warn, #b8860b)', borderColor: 'var(--warn, #b8860b)' } : badge}>
      {t(raw ? 'settings.amadeusPlugins.internalsRawBadge' : 'settings.amadeusPlugins.internalsBadge')}
    </span>
  )
}

/** DEV 徽章:开发态加载的来源。卡片与详情页同款。 */
const DevBadge: React.FC<{ t: (k: string) => string }> = ({ t }) => (
  <span style={{ ...badge, color: 'var(--accent-ink, var(--accent, var(--text-faint)))', borderColor: 'var(--accent-ink, var(--accent, var(--border)))' }}>
    {t('settings.amadeusPlugins.devBadge')}
  </span>
)

/** 依赖应用区:探测 → 已连接/未检测到;一键安装(宿主白名单命令,envRun 执行) → 装完自动复测。 */
const CompanionApp: React.FC<{ appId: string }> = ({ appId }) => {
  const { t } = useI18n()
  const app = KNOWN_APPS[appId]
  const [state, setState] = useState<'probing' | 'ok' | 'missing' | 'installing' | 'failed'>('probing')
  const [info, setInfo] = useState('') // ok=版本;installing=输出尾行

  const rawProbe = async (): Promise<boolean> => {
    try {
      const r = await fetch(app.probeUrl, { signal: AbortSignal.timeout(3000) })
      const j = (await r.json().catch(() => null)) as { version?: string } | null
      setInfo(String(j?.version || ''))
      return true
    } catch {
      return false
    }
  }
  const probe = async (): Promise<void> => {
    setState('probing')
    setState((await rawProbe()) ? 'ok' : 'missing')
  }
  useEffect(() => { void probe() }, []) // eslint-disable-line react-hooks/exhaustive-deps

  const install = async (): Promise<void> => {
    const tangu = window.tangu
    const req = await tangu?.requestKnownAppInstall?.(appId).catch(() => null)
    if (!req || !tangu?.envRun) { window.open(app.homepage); return } // 无一键命令/无桥形态 → 官网
    setState('installing'); setInfo('')
    const off = tangu.onEnvOutput?.((ev) => {
      if (ev.installId === req.installId) setInfo(ev.line.trim().slice(-160))
    })
    try {
      const r = await tangu.envRun(req.installId)
      if (r.exitCode === 0) {
        // 装完应用刚拉起,轮询几次给它启动时间
        for (let i = 0; i < 4; i++) {
          if (await rawProbe()) { setState('ok'); return }
          await new Promise((res) => setTimeout(res, 2000))
        }
      }
      setState('failed')
    } finally {
      off?.()
    }
  }

  const dot =
    state === 'ok' ? 'var(--ok, #3aa675)' : state === 'missing' || state === 'failed' ? 'var(--warn, #b8860b)' : 'var(--text-faint)'
  const statusText =
    state === 'ok' ? t('settings.amadeusPlugins.depConnected', { v: info || '—' })
    : state === 'installing' ? t('settings.amadeusPlugins.depInstalling')
    : state === 'failed' ? t('settings.amadeusPlugins.depFail')
    : state === 'probing' ? '…'
    : t('settings.amadeusPlugins.depMissing')

  return (
    <div className="plugin-card" style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
        <span style={{ width: 8, height: 8, borderRadius: '50%', background: dot, flexShrink: 0 }} />
        <b style={{ fontSize: 'var(--ui-font-meta, 12px)' }}>{app.name}</b>
        <span style={{ fontSize: 'var(--ui-font-caption, 11px)', color: 'var(--text-faint)' }}>{statusText}</span>
      </div>
      {state === 'installing' && info && (
        <div style={{ fontSize: 'var(--ui-font-caption, 11px)', fontFamily: 'var(--font-mono, monospace)', color: 'var(--text-faint)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{info}</div>
      )}
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        <button className="btn ghost sm" disabled={state === 'probing' || state === 'installing'} onClick={() => void probe()}>
          {t('settings.amadeusPlugins.depCheck')}
        </button>
        {state !== 'ok' && (
          <button className="btn sm" disabled={state === 'installing' || state === 'probing'} onClick={() => void install()}>
            {t('settings.amadeusPlugins.depInstall')}
          </button>
        )}
        <button className="btn ghost sm" onClick={() => window.open(app.homepage)}>{t('settings.amadeusPlugins.depHomepage')}</button>
      </div>
    </div>
  )
}

/**
 * 使用说明:manifest onboarding 的 intro + steps,在详情页里**安静地**展示(折叠,不弹、不挂徽标)。
 * 2026-09-21 起弹窗 / 徽标 / Inbox 只留给带 requires 的「闸」;没有前置条件的那些卡里写的多是用法说明,
 * 它们不该伏击用户,但也不该丢 —— 有的只写在卡里(README 没有),有的是插件唯一的英文分步说明。
 */
const PluginGuide: React.FC<{ plugin: AmadeusPlugin }> = ({ plugin: p }) => {
  const { t, locale } = useI18n()
  const spec = localizedOnboarding(p.onboarding, locale)
  if (!spec?.intro && !spec?.steps?.length) return null
  return (
    <details className="plugin-guide" style={{ borderTop: 'var(--border-width) solid var(--overlay-medium, rgba(127,127,127,.12))', paddingTop: 12 }}>
      <summary style={{ cursor: 'pointer', fontWeight: 600, fontSize: 'var(--ui-font-meta, 12px)', userSelect: 'none' }}>{t('plugin.onboarding.guideTitle')}</summary>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8, paddingTop: 8 }}>
        {spec.intro && <div style={{ fontSize: 'var(--ui-font-meta, 12px)', color: 'var(--text-faint)' }}>{spec.intro}</div>}
        {!!spec.steps?.length && (
          <ol style={{ margin: 0, paddingLeft: 18, display: 'flex', flexDirection: 'column', gap: 6 }}>
            {spec.steps.map((st, i) => (
              <li key={i} style={{ fontSize: 'var(--ui-font-meta, 12px)' }}>
                {st.title}
                {st.description && <div style={{ fontSize: 'var(--ui-font-caption, 11px)', color: 'var(--text-faint)' }}>{st.description}</div>}
              </li>
            ))}
          </ol>
        )}
      </div>
    </details>
  )
}

/** 带主进程半身的内置包(Forsion Extend)的开关:那一半开窗前就装好、没法热卸,开关改的是**下次开机**装不装。
 *  读主进程的状态,不看渲染半身的 activeIds —— 本机 localStorage 里可能留着旧开关拨下的「关」,主进程半身其实在跑。 */
async function setBundleOn(p: AmadeusPlugin, on: boolean, reason?: LifecycleReason): Promise<void> {
  try {
    const was = !p.bundleOff
    const { restartPending } = await window.tangu!.setBundleEnabled!(p.id, on)
    usePluginStore.setState((s) => ({ plugins: s.plugins.map((x) => (x.id === p.id ? { ...x, bundleOff: !on, restartPending } : x)) }))
    // 匿名遥测 plugin_lifecycle(v3 补漏):locked 包的开 / 关只在这里报一次 —— 重启后它不在停用名单里,store 那边认不出「从关到开」
    if (was !== on) sendTelemetry('plugin_lifecycle', { ...telemetryPluginRef(p), action: on ? 'enable' : 'disable', ...(!on && reason ? { reason } : {}) })
    // 渲染半身跟着走:朝目标拨,别用 toggle(localStorage 里旧的「关」会让它反着来);上面报过了,这里不再报
    if (on) usePluginStore.getState().enable(p.id, { quiet: true })
    else usePluginStore.getState().disable(p.id, { quiet: true })
  } catch (e) {
    panelToast(ipcErrorText(e), true)
  }
}

const BundleSwitch: React.FC<{ p: AmadeusPlugin }> = ({ p }) => {
  const { locale } = useI18n()
  const [busy, setBusy] = useState(false)
  const flip = async (on: boolean, reason?: LifecycleReason): Promise<void> => {
    setBusy(true)
    try { await setBundleOn(p, on, reason) } finally { setBusy(false) }
  }
  return (
    <span onClick={(e) => e.stopPropagation()}>
      <ReasonSwitch data-bundle-switch="" checked={!p.bundleOff} disabled={busy || !!p.blocked} label={pluginDisplayName(p, locale)} onChange={(on, reason) => void flip(on, reason)} />
    </span>
  )
}

/** 拨过 locked 包的开关、还没重启:就地给「立即重启」。 */
const RestartPending: React.FC<{ p: AmadeusPlugin }> = ({ p }) => {
  const { t } = useI18n()
  if (!p.restartPending) return null
  return (
    <div className="hint" data-restart-pending style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 6 }} onClick={(e) => e.stopPropagation()}>
      <span>{t('settings.amadeusPlugins.restartPending')}</span>
      {window.tangu?.relaunchApp && (
        <button type="button" className="btn sm" onClick={() => void window.tangu!.relaunchApp!()}>{t('settings.amadeusPlugins.restartNow')}</button>
      )}
    </div>
  )
}

/** 从卡片列表点进去的详情页开着时 = 它的「返回列表」,否则 null。移动设置(SettingsModal)在 Android 原生顶栏的返回 /
 *  系统返回上先退这一层,与 Web「返回列表」钮是同一个动作(此前直接回到设置首页,详情页还开在底下)。
 *  受控详情(左栏 `fplugin:<id>` 直达)不登记:它不是从列表进来的,返回照旧回设置首页。 */
export const pluginListDetailBack: { current: (() => void) | null } = { current: null }


/** 详情页「使用内部接口」那一段(2026-11-16+):两级的说明、桌面以外不给、作者没在这一版上验过。
 *  不列运行时取用了哪些模块:设置是独立窗口,这里的插件实例和主窗那份不是同一份,列出来会误导;静态清单看 check-plugin。 */
const InternalsDetail: React.FC<{ t: (k: string, vars?: Record<string, string | number>) => string; p: AmadeusPlugin }> = ({ t, p }) => {
  const raw = !!p.capabilities?.includes('internals-raw')
  return (
    <div data-plugin-internals-detail style={{ fontSize: 'var(--ui-font-meta, 12px)', color: 'var(--text-light)' }}>
      {t(raw ? 'settings.amadeusPlugins.internalsRawHint' : 'settings.amadeusPlugins.internalsHint')}
      {!internalsAvailable() && <> {t('settings.amadeusPlugins.internalsDesktopOnly')}</>}
      {internalsAvailable() && internalsUnverified(p, APP_VERSION) && <> {t('settings.amadeusPlugins.internalsUnverified', { version: APP_VERSION.replace(/^(\d+\.\d+).*$/, '$1') })}</>}
    </div>
  )
}

/** 桌面小窗的授权(2026-11-26):问过的答案 + 收回 / 下次再问。只在有主进程那座桥的桌面端出;收回 = 关掉它所有的小窗、下次再问。 */
const DesktopWindowGrant: React.FC<{ t: (k: string) => string; p: AmadeusPlugin }> = ({ t, p }) => {
  const bridge = window.tangu?.desktopWindow
  const [grant, setGrant] = useState<'allow' | 'deny' | null | undefined>(undefined)
  useEffect(() => {
    let live = true
    void bridge?.grant(p.id).then((g) => { if (live) setGrant(g) }).catch(() => { if (live) setGrant(undefined) })
    return () => { live = false }
  }, [bridge, p.id])
  if (!bridge || grant === undefined) return null
  const reset = async (): Promise<void> => { if (await bridge.revoke(p.id).catch(() => false)) setGrant(null) }
  return (
    <div data-plugin-desktop-window={grant ?? 'unasked'} style={{ fontSize: 'var(--ui-font-meta, 12px)', color: 'var(--text-light)', display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
      <span>{t(grant === 'allow' ? 'settings.amadeusPlugins.desktopWindow.allowed' : grant === 'deny' ? 'settings.amadeusPlugins.desktopWindow.denied' : 'settings.amadeusPlugins.desktopWindow.unasked')}</span>
      {grant && <button className="btn ghost sm" onClick={() => void reset()}>{t(grant === 'allow' ? 'settings.amadeusPlugins.desktopWindow.revoke' : 'settings.amadeusPlugins.desktopWindow.reset')}</button>}
    </div>
  )
}

/** 列表卡上那行注记:这份商店安装取代了同一个包的旧普通目录(已停用)。灰字 + 信息图标,不是警告 —— 旧副本已经不跑了。 */
const SupersededNote: React.FC<{ p: AmadeusPlugin; t: T }> = ({ p, t }) => {
  if (!p.supersedes) return null
  return (
    <div className="plugin-card-note" data-plugin-superseded-note={p.supersedes.dir}>
      <Info size={12} strokeWidth={2} aria-hidden />
      <span>{t(window.tangu?.mobile ? 'settings.amadeusPlugins.superseded.noteMobile' : 'settings.amadeusPlugins.superseded.note', { version: p.supersedes.version })}</span>
    </div>
  )
}

const IS_MAC = typeof navigator !== 'undefined' && /Mac/.test(navigator.platform)

/** 详情页「旧的本地安装」一节(方案 B):是哪一份、为什么停用、哪些数据没带过来,给「在访达中显示」和「移到回收站」。
 *  样式同详情页其他「左说明、右按钮」的卡;设备页(Unit)只说明不给按钮,手机没有回收站 → 「删除旧副本」+ 系统确认。 */
const SupersededSection: React.FC<{ p: AmadeusPlugin }> = ({ p }) => {
  const { t, locale } = useI18n()
  const [asking, setAsking] = useState(false)
  const [busy, setBusy] = useState(false)
  const old = p.supersedes
  if (!old) return null
  const mobile = !!window.tangu?.mobile
  const remote = !!window.tangu?.unitPage
  const hasTrash = typeof amadeus?.trashRestore === 'function'
  const folder = supersededVaultFolder(p) // 和商店那份同一个文件夹时不算它的(那是正在用的数据)
  const name = pluginDisplayName(p, locale)
  const canReveal = !remote && !mobile && canOpenPluginsFolder() && canRevealInFileManager()
  const canRemove = !remote && !!amadeus?.uninstallPlugin
  const run = (opts: { keepSettings: boolean; moveVault: boolean }): void => {
    setBusy(true)
    void cleanupSupersededCopy(p, name, opts).finally(() => setBusy(false))
  }
  const remove = (): void => {
    if (hasTrash) { setAsking(true); return }
    // 没有回收站(手机):删了就回不来,先问一句;它的设置(plugins-data)本来就不随卸载删
    if (window.confirm(t('settings.amadeusPlugins.superseded.deleteConfirm'))) run({ keepSettings: true, moveVault: false })
  }
  return (
    <>
      <div className="hint">{t(mobile ? 'settings.amadeusPlugins.superseded.headMobile' : 'settings.amadeusPlugins.superseded.head')}</div>
      <div className="plugin-card" data-plugin-superseded={old.dir} style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
          <div style={{ flex: '1 1 220px', minWidth: 0 }}>
            <div style={{ fontSize: 'var(--ui-font-meta, 12px)' }}>{t('settings.amadeusPlugins.superseded.title', { version: old.version })}</div>
            <div style={{ fontSize: 'var(--ui-font-caption, 11px)', color: 'var(--text-faint)', marginTop: 2, lineHeight: 1.5 }}>
              {mobile ? t('settings.amadeusPlugins.superseded.subMobile')
                : folder ? t('settings.amadeusPlugins.superseded.sub', { folder })
                  : t('settings.amadeusPlugins.superseded.subNoFolder')}
            </div>
          </div>
          {canReveal && (
            <button className="btn ghost sm" data-plugin-superseded-reveal onClick={() => void amadeus.openPluginsFolder(old.dir)}>
              {t(IS_MAC ? 'settings.amadeusPlugins.superseded.reveal' : 'settings.amadeusPlugins.superseded.revealWin')}
            </button>
          )}
          {canRemove && (
            <button className="btn ghost sm" data-plugin-superseded-remove disabled={busy} onClick={remove}>
              {t(hasTrash ? 'settings.amadeusPlugins.superseded.trash' : 'settings.amadeusPlugins.superseded.delete')}
            </button>
          )}
        </div>
      </div>
      {asking && <SupersededCleanupDialog name={name} version={old.version} storeVersion={p.version} vaultFolder={folder}
        onConfirm={run} onClose={() => setAsking(false)} />}
    </>
  )
}

const PluginDetail: React.FC<{
  plugin: AmadeusPlugin
  onBack: () => void
  /** 从卡片列表点进来的(非受控):原生顶栏在场时 Web「返回列表」钮让位给顶栏的返回(base.css 按这个标记藏)。 */
  fromList?: boolean
  cfg?: TanguDesktopConfig | null
  onEngineReload?: () => void
  enginePlugins?: PluginInfo[] | null
  onOpenSettings?: (id: string) => void
}> = ({ plugin: p, onBack, fromList, cfg, onEngineReload, enginePlugins, onOpenSettings }) => {
  const { t, locale } = useI18n()
  const activeIds = usePluginStore((s) => s.activeIds)
  const commands = usePluginStore((s) => s.commands).filter((o) => o.pluginId === p.id)
  // 设置只住一处(方案 P4,2026-11-18):插件的设置页在「设置 › 插件设置」,详情页只给一颗「设置」直达,不再画第二份。
  // 判据与左栏同一条(在跑看它注册了什么,关着看以前见过没有),挂进「Forsion 云端」的面板不算。
  const hasSettings = usePluginStore((s) => forsionPluginHasSettings(p.id, s.activeIds.includes(p.id),
    new Set(pluginsWithSettingsPanel([p], s.activeIds, s.settings, s.settingsViews, s.settingsPages).map((x) => x.id)), readKnownPluginSettings()))
  usePluginOnboarding((s) => s.version) // 实测结果一变,徽标即时跟上
  const on = activeIds.includes(p.id)
  // 进详情页实测一次本地两类(设置 / 授权):徽标以「此刻」为准,不以上次打开设置页时为准。
  useEffect(() => { if (on && isGate(p)) void usePluginOnboarding.getState().evaluate(p.id) }, [p, on])
  const dep = p.requiresApp && KNOWN_APPS[p.requiresApp] ? p.requiresApp : null
  const toggleHere = (reason?: LifecycleReason, want?: boolean): void => flipPlugin(p, t, locale, () => cascadeAfterToggle(p, onEngineReload), reason, want)
  // 卸载走统一确认框(components/UninstallDialog,10-28 手动卸载规范):插件文件与设置进回收站(可勾「保留设置」),
  // 库里的工作文件夹缺省留着(可勾「一并移到回收站」);删完 6 秒内可撤销。
  const [askUninstall, setAskUninstall] = useState(false)
  const uninstall = (opts: { keepSettings: boolean; moveVault: boolean; keepOld: boolean; reason?: string }): Promise<boolean> =>
    uninstallForsionPlugin(p, pluginDisplayName(p, locale), opts, { engine: !!cfg, onGone: onBack, onEngineReload })

  /** 撤下开发副本:关掉产物的 devLoad 开关,再只重载这一个 id —— 有安装版的话它会在同一拍回来。
   *  刻意不走 amadeus.uninstallPlugin:开发副本在用户自己的项目目录里,宿主绝不去删它。 */
  const unloadDev = async (): Promise<void> => {
    if (!p.devProductId) return
    try {
      await window.tangu?.productsUpdate?.(p.devProductId, { devLoad: false })
    } catch (e: any) {
      panelToast(t('settings.amadeusPlugins.devUnloadFailed', { error: ipcErrorText(e) }), true) // 设置是独立浮窗:全局 toast 在这里蒸发,走面板提示条
      return
    }
    onBack()
    await usePluginStore.getState().reloadOne(p.id)
    void loadUserSpaces()
    panelToast(t('settings.amadeusPlugins.devUnloaded', { name: pluginDisplayName(p, locale) }))
  }

  return (
    <div data-plugin-detail={p.id} style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <div data-plugin-back-row={fromList ? 'list' : undefined}>
        <button className="btn ghost sm" data-plugin-back onClick={onBack} style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}>
          <ArrowLeft size={13} /> {t('settings.amadeusPlugins.back')}
        </button>
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <PluginLogo url={p.iconUrl} size={52} />
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
            <b style={{ fontSize: 'var(--ui-font-heading, 14px)' }}>{isCorePlugin(p) && p.id === 'forsion-extend' ? 'Forsion Extend' : pluginDisplayName(p, locale)}</b>
            <span style={{ fontSize: 'var(--ui-font-caption, 11px)', color: 'var(--text-faint)' }}>v{p.version}</span>
            <span style={badge}>{isCorePlugin(p) ? t('plugins.core.title') : p.builtin || p.preinstalled ? t('settings.amadeusPlugins.builtin') : p.agent ? t('settings.amadeusPlugins.agentOwned', { agent: p.agent }) : t('settings.amadeusPlugins.external')}</span>
            {p.dev && <DevBadge t={t} />}
            <InternalsBadge t={t} p={p} />
            {p.blocked && (
              <span style={{ ...badge, color: 'var(--warn, #b8860b)', borderColor: 'var(--warn, #b8860b)' }}>{blockedLabel(t, p)}</span>
            )}
            {needsOnboarding(p) && (
              <span data-onboarding-badge style={{ ...badge, color: 'var(--warn, #b8860b)', borderColor: 'var(--warn, #b8860b)' }}>{t('plugin.onboarding.badge')}</span>
            )}
            <RunBadge p={p} />
            <BundleChips p={p} />
          </div>
          {pluginDisplayDescription(p, locale) && <div style={{ fontSize: 'var(--ui-font-meta, 12px)', color: 'var(--text-faint)', marginTop: 3 }}>{pluginDisplayDescription(p, locale)}</div>}
        </div>
        {/* 只有带 requires 的才是「闸」;没有前置条件的 onboarding 只是使用说明,在下面安静地展示,不给这个按钮。 */}
        {isGate(p) && on && (
          <button className="btn ghost sm" data-onboarding-run onClick={() => usePluginOnboarding.getState().open(p.id)}>{t('plugin.onboarding.run')}</button>
        )}
        {onOpenSettings && hasSettings && (
          <button className="btn ghost sm" data-plugin-open-settings onClick={() => onOpenSettings(p.id)}>{t('settings.amadeusPlugins.settings')}</button>
        )}
        {/* 设备页 uninstallPlugin 是 notSupported 桩(truthy)——按标志再挡一道,免得按钮点了才报不支持 */}
        {/* 随 App 播种的(preinstalled)同样不给卸载:删了下次启动会种回来,想不用就关开关 */}
        {/* agent 自建 Space 同样不给卸载:那是 agent 目录里的活文件,想不用就关开关 */}
        {/* 开发副本走「撤下」而不是「卸载」:文件是用户自己项目里的源码,宿主一个字节都不删 */}
        {p.dev ? (
          // 没有 productsUpdate 桥(旧壳 / 设备页)就别给按钮:await undefined 会一路走到「已撤下」的提示,
          // 而其实什么都没做 —— 谎报成功比没有按钮糟得多。
          !!p.devProductId && !!window.tangu?.productsUpdate && !window.tangu?.unitPage && (
            <button className="btn ghost sm" onClick={() => void unloadDev()}>{t('settings.amadeusPlugins.devUnload')}</button>
          )
        ) : !p.builtin && !p.preinstalled && !p.agent && !!amadeus?.uninstallPlugin && !window.tangu?.unitPage && (
          <button className="btn ghost sm" data-plugin-uninstall style={{ color: 'var(--danger, #c0392b)' }} onClick={() => setAskUninstall(true)}>
            {t('settings.amadeusPlugins.uninstall')}
          </button>
        )}
        {askUninstall && <PluginUninstallDialog
          name={pluginDisplayName(p, locale)}
          warning={runningDependents(p.id).length ? t('settings.amadeusPlugins.uninstallDependents', { name: pluginDisplayName(p, locale), list: runningDependents(p.id).map((x) => pluginDisplayName(x, locale)).join(t('common.listSep')) }) : undefined}
          vaultFolder={pluginVaultFolder(p.id, p.name)}
          cloudData={pluginDataSyncOn(p)}
          skills={p.bundle?.skills.length ?? 0}
          agents={p.bundle?.agents ?? []}
          superseded={p.supersedes}
          onConfirm={(opts) => void uninstall(opts)}
          onClose={() => setAskUninstall(false)} />}
        {/* 带主进程半身的内置包(Forsion Extend):开关管下次开机装不装那一半;没有这座桥(设备页 / 旧壳)就不给开关 */}
        {p.locked
          ? window.tangu?.setBundleEnabled && <BundleSwitch p={p} />
          : <PluginSwitch p={p} onFlip={toggleHere} />}
      </div>
      {!p.dev && !p.builtin && !p.preinstalled && !p.locked && !p.agent && (
        <LocalPluginVersions type="amadeus-plugin" pluginId={p.id} name={pluginDisplayName(p, locale)} say={panelToast}
          onRolledBack={async (res) => ({ restart: (await afterMarketInstall('amadeus-plugin', res, true, panelToast)).restart })} />
      )}
      {p.locked && !!window.tangu?.setBundleEnabled && (
        <div className="hint">
          {t('settings.amadeusPlugins.lockedHint')}
          <RestartPending p={p} />
        </div>
      )}
      {!!p.capabilities?.length && (
        <div data-plugin-caps style={{ fontSize: 'var(--ui-font-meta, 12px)', color: 'var(--text-light)' }}>
          {t('settings.amadeusPlugins.caps', { list: capabilityLabels(p.capabilities, t).join(t('common.listSep')) })}
        </div>
      )}
      {p.capabilities?.includes('internals') && <InternalsDetail t={t} p={p} />}
      {p.capabilities?.includes('desktopWindow') && <DesktopWindowGrant t={t} p={p} />}
      {!!p.network?.length && (
        <div data-plugin-network style={{ fontSize: 'var(--ui-font-meta, 12px)', color: 'var(--text-light)', overflowWrap: 'anywhere' }}>
          {t('settings.amadeusPlugins.network', { domains: p.network.join(t('common.listSep')) })}
        </div>
      )}
      {/* 开发态说明:它**不是**隔离沙箱,用户有权在启用它之前知道这件事 */}
      {p.dev && (
        <div className="plugin-card" style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 'var(--ui-font-meta, 12px)' }}>
          <div>{t('settings.amadeusPlugins.devHint')}</div>
          {p.devRoot && <div style={{ color: 'var(--text-faint)', fontSize: 'var(--ui-font-caption, 11px)' }}>{t('settings.amadeusPlugins.devProject', { path: p.devRoot })}</div>}
          {p.shadowsInstalled && <div style={{ color: 'var(--warn, #b8860b)', fontSize: 'var(--ui-font-caption, 11px)' }}>{t('settings.amadeusPlugins.devShadows')}</div>}
        </div>
      )}
      <SupersededSection p={p} />
      {p.bundle && (
        <>
          <div className="hint">{t('settings.amadeusPlugins.bundleTitle')}</div>
          <div className="plugin-card" style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 'var(--ui-font-meta, 12px)' }}>
            {p.bundle.enginePlugins.length > 0 && <div>{t('settings.amadeusPlugins.bundleEngineList', { list: p.bundle.enginePlugins.join(', ') })}</div>}
            {p.bundle.agents.length > 0 && <div>{t('settings.amadeusPlugins.bundleAgentsList', { list: p.bundle.agents.join(', ') })}</div>}
            {p.bundle.skills.length > 0 && <div>{t('settings.amadeusPlugins.bundleSkillsList', { list: p.bundle.skills.join(', ') })}</div>}
            {p.bundle.spaces.length > 0 && <div>{t('settings.amadeusPlugins.bundleSpacesList', { list: p.bundle.spaces.join(', ') })}</div>}
            <div style={{ color: 'var(--text-faint)', fontSize: 'var(--ui-font-caption, 11px)' }}>{t('settings.amadeusPlugins.bundleHint')}</div>
          </div>
        </>
      )}
      <HostAccess p={p} />
      <HiddenSpaces p={p} />
      <RequiredPlugins p={p} />
      {dep && (
        <>
          <div className="hint">{t('settings.amadeusPlugins.dep')}</div>
          <CompanionApp appId={dep} />
        </>
      )}
      {/* 命令跑在调用它的渲染进程里:设置在 Electron 下是独立浮窗,在这里点「统计字数」数的是浮窗的(空)当前页,
          结果吐司也只有主窗渲染 → 点了什么都看不见。卫星窗里不给这排按钮,命令照旧在主窗 ⌘K 里;web 仍同窗,保留。 */}
      {commands.length > 0 && windowKind() === 'main' && (
        <>
          <div className="hint">{t('settings.amadeusPlugins.commands')}</div>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            {commands.map((o) => (
              <button key={o.item.id} className="btn ghost sm" onClick={() => { try { o.item.run() } catch (e) { console.error(`[plugin] command "${o.item.id}" failed`, e) } }}>
                {typeof o.item.title === 'function' ? o.item.title() : o.item.title}
              </button>
            ))}
          </div>
        </>
      )}
      <PluginSyncRow p={p} />
      <PluginGuide plugin={p} />
      {on && <PluginFootprint p={p} />}
      {/* README / 更新日志:必须套 .md-body —— 裸 <Markdown> 吃的是浏览器默认样式(h1 2em、1em 段距),
          和设置页其余部分的行距对不上,观感就是「排版很乱」。同一个类也管着关于页的更新日志。 */}
      {p.readme && (
        <div className="md-body" style={{ borderTop: 'var(--border-width) solid var(--overlay-medium, rgba(127,127,127,.12))', paddingTop: 12 }}>
          <Markdown content={p.readme} />
        </div>
      )}
      {p.changelog && (
        <details style={{ borderTop: 'var(--border-width) solid var(--overlay-medium, rgba(127,127,127,.12))', paddingTop: 12 }}>
          <summary style={{ cursor: 'pointer', fontWeight: 600, fontSize: 'var(--ui-font-meta, 12px)', userSelect: 'none' }}>{t('settings.amadeusPlugins.changelog')}</summary>
          <div className="md-body" style={{ paddingTop: 8 }}><Markdown content={p.changelog} /></div>
        </details>
      )}
    </div>
  )
}

export const AmadeusPluginsTab: React.FC<{
  /** 引擎连接配置:捆绑包启停级联内嵌引擎插件用(缺省 = 不级联,仅本地启停)。 */
  cfg?: TanguDesktopConfig | null
  section?: 'core' | 'installed'
  /** 级联改动引擎插件启用态后刷新引擎插件清单(SettingsModal 的 reloadPlugins)。 */
  onEngineReload?: () => void
  /** 引擎插件清单(SettingsModal 下传):级联时识别首方内置同 id,绝不去动它们。 */
  enginePlugins?: PluginInfo[] | null
  /** 受控详情面:左栏 `fplugin:<id>` 一级项直接落到该插件的设置页,不经卡片列表。
   *  id 与返回去处**必须成对**给 —— 拆成两个可选 prop 会出现「给了 id 没给 onBack、返回点不动」
   *  的半瘫状态(codex 评审 2026-08-21)。 */
  controlledDetail?: { id: string; onBack: () => void }
  /** 详情页的「设置」直达(插件有设置时才出):落到它在「设置 › 插件设置」里的那一页。不给 = 不出这颗按钮。 */
  onOpenSettings?: (id: string) => void
}> = ({ cfg, onEngineReload, enginePlugins, controlledDetail, onOpenSettings, section = 'installed' }) => {
  const { t, locale } = useI18n()
  const plugins = usePluginStore((s) => s.plugins)
  const activeIds = usePluginStore((s) => s.activeIds)
  const openFolder = usePluginStore((s) => s.openPluginsFolder)
  const scaffold = usePluginStore((s) => s.scaffoldSample)
  usePluginOnboarding((s) => s.version) // 「待引导」徽标随实测结果即时变化
  const spaces = useSpaceStore((s) => s.spaces)
  const [detail, setDetail] = useState<string | null>(null)
  const [query, setQuery] = useState('')
  useEffect(() => { setDetail(null); setQuery('') }, [section])
  // 列表里的「待引导」徽标以此刻实测为准:只测本地两类,不跑插件的 check(可能打远端)。
  useEffect(() => {
    for (const p of plugins) if (activeIds.includes(p.id) && isGate(p)) void usePluginOnboarding.getState().evaluate(p.id)
  }, [plugins, activeIds])

  // 设置页可能先于 Amadeus Space 打开 → 兜底装载(幂等,installed 闸在 amadeusPlugins 内)。
  useEffect(() => { installAmadeusPlugins() }, [])

  // 受控 id 解析得到才赢;插件被卸载/禁用后落回卡片列表,且**列表点得动**(见 resolvePluginDetail)。
  const { plugin: detailPlugin, controlled } = resolvePluginDetail(plugins, controlledDetail?.id, detail)
  const listDetailOpen = !!detailPlugin && !controlled
  useEffect(() => {
    if (!listDetailOpen) return
    const back = (): void => setDetail(null)
    pluginListDetailBack.current = back
    return () => { if (pluginListDetailBack.current === back) pluginListDetailBack.current = null }
  }, [listDetailOpen])
  if (detailPlugin) {
    const back = controlled && controlledDetail ? controlledDetail.onBack : () => setDetail(null)
    return <PluginDetail plugin={detailPlugin} onBack={back} fromList={!controlled} cfg={cfg} onEngineReload={onEngineReload} enginePlugins={enginePlugins} onOpenSettings={onOpenSettings} />
  }

  // 核心独立一页；已安装页把编辑器扩展、宿主内置能力与开发操作折叠收纳。
  const managedFeatures = PRODUCT.nativeFeatures !== undefined
  const matches = (p: AmadeusPlugin): boolean => !query.trim() || `${pluginDisplayName(p, locale)} ${pluginDisplayDescription(p, locale)} ${p.id}`.toLowerCase().includes(query.trim().toLowerCase())
  const core = plugins.filter(isCorePlugin)
  const builtins = plugins.filter((p) => p.builtin && !isCorePlugin(p) && matches(p))
  const externals = plugins.filter((p) => !p.builtin && !isCorePlugin(p) && matches(p))

  /** 没有 logo 的插件卡:核心插件用它在 Ribbon 里的图标,其余用它注册的第一个 Space 的图标,再没有才是拼图(走查续五 5.8)。 */
  const fallbackIcon = (p: AmadeusPlugin) => CORE_ICONS[p.id] ?? spaces.find((s) => pluginOfSpace(s.id) === p.id)?.icon

  /** 一张插件卡:内置区与外置区同款(区标题已说明归属,卡上不再重复挂「内置/外置」小标签)。 */
  const renderCard = (p: AmadeusPlugin): React.ReactNode => {
    return (
      <div
        key={p.id}
        className={`plugin-card plugin-card--link${p.blocked ? ' plugin-card--blocked' : ''}`}
        data-plugin-id={p.id}
        role="button"
        tabIndex={0}
        aria-label={pluginDisplayName(p, locale)}
        onKeyDown={(e) => { if (e.target === e.currentTarget && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); setDetail(p.id) } }}
        onClick={() => setDetail(p.id)}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <PluginLogo url={p.iconUrl} icon={fallbackIcon(p)} />
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
              <b style={{ fontSize: 'var(--ui-font-body, 13px)' }}>{isCorePlugin(p) && p.id === 'forsion-extend' ? 'Forsion Extend' : pluginDisplayName(p, locale)}</b>
              <span style={{ fontSize: 'var(--ui-font-caption, 11px)', color: 'var(--text-faint)' }}>v{p.version}</span>
              {p.dev && <DevBadge t={t} />}
              <InternalsBadge t={t} p={p} />
              {p.blocked && (
                <span style={{ ...badge, color: 'var(--warn, #b8860b)', borderColor: 'var(--warn, #b8860b)' }}>{blockedLabel(t, p)}</span>
              )}
              {needsOnboarding(p) && (
                <span data-onboarding-badge style={{ ...badge, color: 'var(--warn, #b8860b)', borderColor: 'var(--warn, #b8860b)' }}>{t('plugin.onboarding.badge')}</span>
              )}
              <RunBadge p={p} />
              <BundleChips p={p} />
            </div>
            {pluginDisplayDescription(p, locale) && <div className="plugin-card-description">{isCorePlugin(p) ? t(CORE_DESCRIPTIONS[p.id] ?? 'plugins.core.computerUse') : pluginDisplayDescription(p, locale)}</div>}
            <SupersededNote p={p} t={t} />
            {p.locked && <RestartPending p={p} />}
          </div>
          {/* 带主进程半身的内置包:同详情页,开关管下次开机装不装那一半 */}
          {p.locked
            ? window.tangu?.setBundleEnabled && <BundleSwitch p={p} />
            : <PluginSwitch p={p} onFlip={(reason, want) => flipPlugin(p, t, locale, () => cascadeAfterToggle(p, onEngineReload), reason, want)} />}
        </div>
      </div>
    )
  }

  if (section === 'core') return (
    <div className="plugin-management" data-plugin-section="core">
      <div className="hint">{t('plugins.core.hint')}</div>
      {!managedFeatures && hasNativeFeature('amadeus') && <div className="plugin-card plugin-core-native" data-plugin-id="amadeus-core">
        <PluginLogo icon={NotebookText} />
        <div className="plugin-core-native-copy"><strong>Amadeus</strong><div className="hint">{t('plugins.core.amadeus')}</div></div>
        <span className="hint">v{APP_VERSION} · {t('plugins.core.withApp')}</span>
      </div>}
      {!managedFeatures && PRODUCT.agentBackend && <div className="plugin-card plugin-core-native" data-plugin-id="tangu-core">
        <PluginLogo icon={Bot} />
        <div className="plugin-core-native-copy"><strong>Tangu</strong><div className="hint">{t('plugins.core.tangu')}</div></div>
        <EngineVersionHint />
      </div>}
      {core.map(renderCard)}
      <CorePluginUpdates controls />
      <NativeFeaturesSection />
    </div>
  )

  return (
    <div className="plugin-management" data-plugin-section="installed">
      <div className="hint">{t('plugins.installed.hint')}</div>
      <div className="plugin-management-toolbar">
        <input type="search" aria-label={t('plugins.search')} placeholder={t('plugins.search')} value={query} onChange={(e) => setQuery(e.target.value)} />
        {/* 没有插件文件夹的宿主(Android App)唯一的安装入口是市场:就地给一个,别让用户回去翻「⋯」菜单。 */}
        {!canOpenPluginsFolder() && !!window.tangu?.marketList && (
          <button className="btn ghost sm" data-plugins-open-market onClick={() => { useApp.getState().closeSettings(); useApp.getState().openMarket() }}>{t('settings.amadeusPlugins.openMarket')}</button>
        )}
      </div>
      {externals.map(renderCard)}
      {!externals.length && !builtins.length && <div className="hint">{t(query ? 'plugins.noResults' : managedFeatures ? 'settings.amadeusPlugins.unitEmpty' : 'settings.amadeusPlugins.empty')}</div>}
      {!!builtins.length && <details className="plugin-management-group" open={query ? true : undefined}>
        <summary>{t('plugins.editorExtensions')} · {builtins.length}</summary>
        {builtins.map(renderCard)}
      </details>}
      {!query && <FileOpenersPanel />}
      {!query && <details className="plugin-management-group">
        <summary>{t('plugins.bundledFeatures')}</summary>
        <BuiltinPluginsSection />
      </details>}
      <details className="plugin-management-group">
        <summary>{t('plugins.developer')}</summary>
        <div className="hint">{t(managedFeatures ? 'settings.amadeusPlugins.unitHint' : canOpenPluginsFolder() ? 'settings.amadeusPlugins.hint' : 'settings.amadeusPlugins.marketHint')}</div>
        <div className="plugin-management-toolbar" style={{ flexWrap: 'wrap' }}>
          {/* 设备页(unitPage):插件目录/脚手架都是对方机器上的 shell 行为 —— 藏。Android App(hostCaps.pluginsFolder=false):
              插件住在应用私有目录、只经市场装 —— 文件夹与脚手架两个按钮同样不给。 */}
          {!window.tangu?.unitPage && canOpenPluginsFolder() && <button className="btn ghost sm" onClick={() => openFolder()}>{t('settings.amadeusPlugins.openFolder')}</button>}
          <button className="btn ghost sm" onClick={() => void reloadPluginsAndAnnounce({ all: true }).then(({ fresh }) => { if (fresh.length) track('plugin.local'); return loadUserSpaces() })}>{t('settings.amadeusPlugins.reload')}</button>
          {!window.tangu?.unitPage && canOpenPluginsFolder() && <button className="btn ghost sm" onClick={() => void scaffold()}>{t('settings.amadeusPlugins.scaffold')}</button>}
        </div>
      </details>
    </div>
  )
}
