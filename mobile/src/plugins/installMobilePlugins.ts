/**
 * Android App 插件体系的装配点(2026-10-02):插件宿主(window.amadeus 的 listPlugins / uninstallPlugin /
 * readPluginData / writePluginData)+ 应用市场数据层(window.tangu.market*)+ 插件包里带的 Space(window.tangu.spacesList)。
 *
 * ⚠️ 只由 mobile/src/main.tsx 调用,且必须在 `import('./mobileEntry')` **之前**:
 *   · bootstrapEngine 按 `window.tangu?.marketList` 决定注册不注册 rb-market / open-market —— 晚一拍入口就没了;
 *     `window.tangu?.spacesList` 同理(启动那一趟 loadUserSpaces 看它在不在);
 *   · 本链路引用 @capacitor/filesystem,而 web 包图(网页版手机视口也装 mobileEntry)没有它的桩 ——
 *     放进 mobileEntry / MobileRoot 的静态图会让 build-web CI 红。main.tsx 只属于 App。
 * 插件代码本身的求值(new Function)在渲染层 pluginStore;所以 mobile/index.html 的 CSP 带 'unsafe-eval'。
 */
import { registerMessages, translate } from '@/i18n'
import { APP_VERSION } from '@/changelog'
import { capacitorPluginFs, hasNativeMarketDownload, isDebuggableAndroid, nativeMarketDownload } from './capacitorPluginFs'
import { createPluginHost, type MobilePluginHost } from './pluginHost'
import { createFetchDownload, createMobileMarket, type MobileMarket } from './mobileMarket'

registerMessages({
  'mobilemarket.noCloud': { zh: '还没有连接 Forsion 云端，无法使用应用市场', en: 'Not connected to Forsion cloud, so the market is unavailable' },
  'mobilemarket.desktopOnlyType': {
    zh: '这一项需要在 Forsion 桌面端安装（手机上只能安装 Forsion 插件）',
    en: 'This item must be installed from Forsion for desktop (only Forsion plugins can be installed on a phone)',
  },
  'mobilemarket.desktopOnlyPlugin': {
    zh: '这个插件声明了「仅支持桌面端」，无法安装到手机上',
    en: 'This plugin is marked "Desktop only" and can’t be installed on a phone',
  },
  'mobilemarket.badArchive': { zh: '安装包已损坏，无法解压', en: 'The package is damaged and can’t be unpacked' },
  'mobilemarket.emptyArchive': { zh: '安装包是空的，没有可安装的文件', en: 'The package is empty' },
  'mobilemarket.unsafePath': { zh: '安装包里有越界路径（{path}），已拒绝安装', en: 'The package contains an unsafe path ({path}), so it was rejected' },
  'mobilemarket.tooLarge': { zh: '安装包解压后超过 {mb} MB，手机上无法安装', en: 'The unpacked package exceeds {mb} MB, too large for a phone' },
  'mobilemarket.tooManyFiles': { zh: '安装包里的文件超过 {n} 个，手机上无法安装', en: 'The package contains more than {n} files, too many for a phone' },
  'mobilemarket.badManifest': { zh: '安装包里没有有效的 manifest.json', en: 'The package has no valid manifest.json' },
  'mobilemarket.noMain': { zh: '安装包里缺少入口文件（{path}），无法安装', en: 'The package is missing its entry file ({path}) and can’t be installed' },
  'mobilemarket.builtin': { zh: '这个插件与内置插件同名，无法安装', en: 'This plugin has the same id as a built-in plugin and can’t be installed' },
  'mobilemarket.invalidTarget': { zh: '无法卸载：目标无效', en: 'Can’t uninstall: invalid target' },
  'mobilemarket.notInstalled': { zh: '这一项不在已安装目录中', en: 'This item isn’t in the installed folder' },
})

export interface MobilePluginWiring {
  host: MobilePluginHost
  market: MobileMarket
}

/** 装上市场桥(挂到 window.tangu)并返回插件宿主(由 main.tsx 叠在 window.amadeus 的转发壳上,两种库模式共用)。 */
export function installMobilePlugins(opts: { cloudApiBase: () => string }): MobilePluginWiring {
  const fs = capacitorPluginFs()
  // 门禁用的宿主版本 = 渲染层随包的 CHANGELOG 版本(移动端与桌面同一份渲染层源码,插件 API 能力按它算);
  // 顶节是 Unreleased 时 APP_VERSION 为空 → 传 null,不按 0.0.0 误杀声明了 minAppVersion 的插件。
  const host = createPluginHost(fs, { appVersion: () => APP_VERSION || null })
  const market = createMobileMarket({
    fs,
    cloudApiBase: opts.cloudApiBase,
    fetch: (input, init) => window.fetch(input, init),
    // 真机:原生下载(不吃 CORS、流式落盘、字节上限在传输中强制);浏览器台架 / dev 预览:fetch(下载主机得给 CORS,同样读到上限即停)。
    download: hasNativeMarketDownload() ? nativeMarketDownload() : createFetchDownload(),
    // 下载地址只认 https;debug 包额外放行回环明文(台架用 adb reverse 从宿主机发包,原生层按同一条件放行)。
    allowLoopbackHttp: isDebuggableAndroid(),
    mirror: async () => {
      const cfg = (await window.tangu?.getConfig?.().catch(() => null)) as { mirror?: unknown } | null
      return typeof cfg?.mirror === 'string' ? cfg.mirror : 'default'
    },
    reservedIds: async () => {
      const { usePluginStore } = await import('@/amadeus/plugins/pluginStore')
      return usePluginStore.getState().plugins.filter((p) => p.builtin).map((p) => p.id)
    },
    t: (key, vars) => translate(key, vars),
  })
  const t = window.tangu as unknown as Record<string, unknown> | undefined
  if (t) {
    t.marketTypes = market.marketTypes
    t.marketList = market.marketList
    t.marketDetail = market.marketDetail
    t.marketInstall = market.marketInstall
    t.onMarketInstallProgress = market.onMarketInstallProgress
    t.marketInstalled = market.marketInstalled
    t.marketUninstall = market.marketUninstall
    // 插件包里带的 Space 配方(userSpaces.loadUserSpaces 读它)。只有读:手机上没有用户自建 Space 的目录,
    // 所以不给 spacesSave / spacesDelete —— 「另存为 Space」「新建 Space」这些入口按它们在不在门控,照旧不出现。
    t.spacesList = host.listSpaces
  }
  return { host, market }
}
