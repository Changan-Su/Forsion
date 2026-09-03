/** 白板引擎(@zsviczian/excalidraw fork,alias 成 @excalidraw/excalidraw)的运行时装载。
 *
 *  为什么不能直接 `import ... from '@excalidraw/excalidraw'`:fork 的 dist/prod 与 dist/dev 都留着
 *  `@excalidraw/element`、`@excalidraw/common` 这类**没发布到 npm** 的内部裸 import(上游 0.18.1
 *  是全打进去的,fork 没有),vite 一解析就炸。fork 唯一自包含的产物是给 Obsidian 用的那份 IIFE:
 *  它把自己挂到 `self.ExcalidrawLib`,并把 React 三件套做成**词法外部**(裸标识符 React /
 *  ReactDOM / ReactJSXRuntime,靠全局兜底)—— 名字与拆分口径照抄 fork 仓的 scripts/reactRuntimeEntry.mjs,
 *  不是我们发明的,别改。
 *
 *  于是:先塞全局,再用 <script> 从自托管副本(build/copy-excalidraw-assets.cjs)加载,最后取 lib。
 *  走 <script> 而不是 import 还顺带躲开了让 vite 转换 6MB 单文件。**必须与 React 同实例**,
 *  否则 hooks dispatcher 对不上,画布一挂载就 "Invalid hook call"。
 *
 *  类型仍来自包内 .d.ts(tsconfig paths 把 fork 那张写错的 exports 表兜回了真实布局)。
 */
import React from 'react'
import * as ReactDOMLegacy from 'react-dom'
import * as ReactDOMClient from 'react-dom/client'
import * as ReactJSXRuntime from 'react/jsx-runtime'
import type * as ExcalidrawLib from '@excalidraw/excalidraw'
import { registerMessages, translate } from '../../../i18n'
import { getBoardUiMode } from './boardUiMode'

registerMessages({
  'boardengine.assetLoadFailed': {
    zh: '画板引擎资源加载失败:{url}(自托管副本缺失?重跑 npm run postinstall)',
    en: 'Whiteboard engine assets failed to load: {url} (self-hosted copy missing? Re-run npm run postinstall)',
  },
  'boardengine.libMissing': {
    zh: '画板引擎已加载但没挂上 ExcalidrawLib',
    en: 'Whiteboard engine loaded but did not expose ExcalidrawLib',
  },
})

/** fork 的 obsidian 档还会伸手去全局 `app` 里拿宿主插件要配置(缩放上下限 / 笔模式手势 / 画布上限 /
 *  UI 模式)。我们不是 Obsidian,给它一份**纯配置**的假宿主:标量值逐个抄自插件的 DEFAULT_SETTINGS
 *  与 ExcalidrawConfig,方法一律返回空让引擎自己走兜底(每处调用点都写了 `??` 或 null 分支,已逐条核过)。
 *  ⚠️ 这是引擎唯一的宿主耦合面(下面这些成员就是全部)。升级 fork 版本时先 grep 一遍
 *  `app.plugins.plugins` 的读取点,多出来的字段会以 undefined 静默降级,不会报错。 */
const host = {
  // ⚠️ 属性面板形态的**真出口**是这个:引擎每次布局都回调一次(不缓存),所以读我们的偏好即可
  //    实时生效,不必重挂画布,也不用再调 api.setDesktopUIMode()。
  getPreferredUIMode: getBoardUiMode,
  settings: {
    get desktopUIMode() {
      return getBoardUiMode()
    },
    tabletUIMode: 'compact',
    phoneUIMode: 'mobile',
    disableContextMenu: false,
    disableDoubleClickTextEditing: false,
    penModeCrosshairVisible: true,
    penModeDoubleTapEraser: true,
    penModeSingleFingerPanning: true,
    syncElementLinkWithText: false,
    zoomMax: 30,
    zoomMin: 0.1,
    zoomStep: 0.05,
    zoomToFitMaxLevel: 2,
  },
  excalidrawConfig: { areaLimit: 16777216, widthHeightLimit: 32767 },
  /** ⚠️ 这份画布**三端复用**(desktop / web / mobile),所以不能一律报 desktop:引擎拿它选
   *  phoneUIMode / 触摸手势 / 上下文菜单分支,写死 isDesktop 会让手机永远走桌面档。
   *  引擎内部自己也有一套 UA 嗅探,但只在拿不到宿主时才用 —— 我们既然给了宿主,就得把这份答对。
   *  它被引擎缓存(每页算一次),所以按 UA + 屏幕短边判一次就够。 */
  getObsidianDevice: () => {
    const ua = navigator.userAgent
    const android = /Android/i.test(ua)
    // iPadOS 13+ 的 UA 伪装成 Mac,靠触摸点区分(与引擎自己那段同款判据)
    const ios = /iPad|iPhone|iPod/.test(ua) || (/Mac/.test(ua) && 'ontouchend' in document)
    const mobileOS = android || ios
    const phone = mobileOS && Math.min(screen.width, screen.height) < 600
    return {
      isDesktop: !mobileOS,
      isPhone: phone,
      isTablet: mobileOS && !phone,
      isMobile: mobileOS,
      isMacOS: /Mac/.test(ua) && !ios,
      isWindows: /Win/.test(ua),
      isLinux: /Linux/.test(ua) && !android,
      isIOS: ios,
      isAndroid: android,
    }
  },
  getHighlightColor: () => undefined, // 引擎兜底 rgba(0,118,255,a)
  getMermaid: async () => null, // 没接 mermaid 转图
  loadFontFromFile: async () => null, // 本地字体库是 Obsidian 侧的东西
  activeExcalidrawView: null, // 引擎取不到就退回 document.body
  attachInlineLinkSuggester: () => ({ destroy: () => {} }), // Obsidian 的 [[ 补全,这里不提供
  runAction: () => {}, // 引擎回调宿主命令(脚本库之类),我们没有
  getLabel: (key: string) => key, // 宿主侧文案表,原样回显 key(引擎自己的 i18n 不走这里)
}

const g = globalThis as unknown as Record<string, unknown>
g.React = React
g.ReactDOM = Object.assign({}, ReactDOMLegacy, ReactDOMClient)
g.ReactJSXRuntime = ReactJSXRuntime
// `app` 是个很招人的名字 —— 别整个盖掉别人的:已经有就只往它的插件表里塞一条。
const existing = g.app as { plugins?: { plugins?: Record<string, unknown> } } | undefined
if (existing?.plugins?.plugins) existing.plugins.plugins['obsidian-excalidraw-plugin'] = host
else g.app = { plugins: { plugins: { 'obsidian-excalidraw-plugin': host } } }

// ExcalidrawEmbed 已把 EXCALIDRAW_ASSET_PATH 设成同一个目录(它在启动 bundle 里,先于本 chunk 执行)。
// ⚠️ 相对 document.baseURI 解析:desktop 打包后是 file://,**必须相对**(绝对 /excalidraw/ 会指到
//    文件系统根)。web 侧 base='/'、主应用恒在根路径,所以两边都对;哪天 web 改成路径式路由或部署到
//    子路径,这里要按 protocol 分叉。
//    不做版本 query:web 的 nginx 只给 /assets/ 长缓存,`/excalidraw/*` 落在 `location /`(expires -1,
//    每次 revalidate),换版拉得到新的;desktop 是 file://,无缓存问题。
const base = new URL('excalidraw/', document.baseURI).href

/** 两个资源都得等:CSS 挂了但 JS 好,画布会以「没样式」的错位形态挂上来,比直接报错更难查。 */
const load = (el: HTMLLinkElement | HTMLScriptElement, url: string): Promise<void> =>
  new Promise((resolve, reject) => {
    el.onload = () => resolve()
    el.onerror = () => reject(new Error(translate('boardengine.assetLoadFailed', { url })))
    document.head.appendChild(el)
  })

const css = document.createElement('link')
css.rel = 'stylesheet'
css.href = `${base}excalidraw.css`
const js = document.createElement('script')
js.src = `${base}excalidraw.js`

// ponytail: 失败(404 / CSP)不重试 —— 这两种都不是瞬时故障,重试只是把同一个错再犯一遍。
//   代价是本模块一旦 reject 就永久 rejected(ESM 语义),再 import 还是同一个失败,只能整页重载。
//   真出这种事说明自托管副本没进包,那是构建问题,不是运行时能自愈的。
await Promise.all([load(css, css.href), load(js, js.src)])

const lib = g.ExcalidrawLib as typeof ExcalidrawLib | undefined
if (!lib) throw new Error(translate('boardengine.libMissing'))

export const { Excalidraw, MainMenu, serializeAsJSON, restoreElements, newElementWith, CaptureUpdateAction } = lib
