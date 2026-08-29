/**
 * 移动端启动模块(被 main.tsx 在垫片就位后动态 import)。
 * 复用 desktop 的主题/i18n/引擎装配(installEngine 注册视图/命令/Space —— inbox/amadeus 的 host gate
 * 在移动端 M0 自然不注册),但渲染 MobileRoot(单列 MobileShell)而非 desktop 的 Dockview Root。
 */
import { createRoot } from 'react-dom/client'
import { MobileRoot } from './MobileRoot'
import { ErrorBoundary } from '@/components/ErrorBoundary'
import '@/styles/base.css'
import '@/amadeus-host.css'
import { applyTheme, preloadAllThemes } from '@/theme/loader'
import { resolveInitialMode, resolveInitialLang, resolveInitialSkin, resolveInitialBg } from '@/theme/registry'
import { useTheme } from '@/stores/themeStore'
import { useApp } from '@/stores/appStore'
import { LocaleProvider, resolveInitialLocale, translate } from '@/i18n'
import '@/i18n.generated'
import { installEngine } from '@/bootstrapEngine'
import { installSmoothCaret } from '@/smoothCaret'
import { installViewportLock } from '@/viewportLock'
import { applyUiFonts } from '@/uiFont'
import { installSpaceShortcuts } from './spaceShortcuts'
import { installUnitsEntry } from './UnitsSheet'

window.addEventListener('error', (e) => { console.error('[tangu-mobile] window error:', e.error || e.message) })
window.addEventListener('unhandledrejection', (e) => { console.error('[tangu-mobile] unhandledrejection:', e.reason) })

try { document.documentElement.lang = resolveInitialLocale() === 'zh' ? 'zh-CN' : 'en' } catch { /* ignore */ }

let initSeed: string | undefined
let persistedLang: string | null = null
try { initSeed = localStorage.getItem('forsion_theme_seed') || undefined } catch { /* ignore */ }
try { persistedLang = localStorage.getItem('forsion_theme_lang') } catch { /* ignore */ }
try {
  applyTheme(resolveInitialLang(), resolveInitialSkin(), resolveInitialBg(), resolveInitialMode(), { customColor: initSeed })
  try { document.documentElement.dataset.flat = localStorage.getItem('forsion_theme_flat') !== '0' ? '1' : '0' } catch { /* ignore */ }
  preloadAllThemes()
  document.documentElement.style.removeProperty('background')
  void useTheme.getState().initThemes(persistedLang)
  // ⚠️与 desktop main.tsx 同一行,不能只加一边:appStore 缺省 `tr` 是 `(k) => k`,LocaleProvider
  // 要等 React 挂载才 setTr,而 installEngine() 里的 Space.build() → openView() 跑在那之前 ——
  // 那一刻的 displayName 是裸键且被快照进标签标题(desktop 实测:主页标签写着 `space.home`)。
  // ⚠️check:parity 抓不到这条(`setTr(translate)` 不是「导入名直接调用」那种形态,属它已登记的假阴性)。
  useApp.getState().setTr(translate)
  installEngine()
  // 丝滑光标:desktop 在 main.tsx 装,移动端走的是本模块 —— 漏装过一轮(用户实报「移动端没生效」)。
  // 缺席即关(设置→外观里开);软键盘的重定位与偏移补偿在 smoothCaret 里接 visualViewport。
  // (旧注释写的「移动端没有设置开关」是错的:不列的只有「常规」页,「外观」页是共用的,
  //  丝滑光标与字体三档的开关在移动端照样渲染 —— 见 SettingsModal 的 theme tab。)
  installSmoothCaret()
  // 视口滚动锁:页面本身永不该滚;滚起来就弹回去(见 viewportLock.ts 的病理与实测)。
  installViewportLock()
  // 界面字体三档:设置→外观里的那三个输入框**没有桌面门控**,移动端本来就能改、改完当场生效
  // (setFont 自己调 applyUiFonts),但启动时没人读回 localStorage → 重启即回退。半坏比没有更糟。
  applyUiFonts()
  // 安卓 Space 快捷方式(长按 app 图标出 Space 列表 / 固定某个 Space 到桌面 / 接住点击)。
  // 必须排在 installEngine 之后:Space 是在那里面注册的,早了发布出去是空名单。
  installSpaceShortcuts()
  // 互联设备入口(⋯ 菜单,Forsion Unit):数据桥在才上架 —— App(mobileShim)有 unitsList,
  // 设备页(unitShim)没有(设备页里不套设备页),自然隐藏。
  installUnitsEntry()
} catch (err) {
  console.error('[tangu-mobile] init failed, continue to mount:', err)
}

createRoot(document.getElementById('root')!).render(
  <LocaleProvider>
    <ErrorBoundary>
      <MobileRoot />
    </ErrorBoundary>
  </LocaleProvider>,
)
