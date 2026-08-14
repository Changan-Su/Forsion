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
import { resolveInitialMode, resolveInitialLang, resolveInitialSkin } from '@/theme/registry'
import { useTheme } from '@/stores/themeStore'
import { LocaleProvider, resolveInitialLocale } from '@/i18n'
import '@/i18n.generated'
import { installEngine } from '@/bootstrapEngine'
import { installSmoothCaret } from '@/smoothCaret'
import { applyUiFonts } from '@/uiFont'

window.addEventListener('error', (e) => { console.error('[tangu-mobile] window error:', e.error || e.message) })
window.addEventListener('unhandledrejection', (e) => { console.error('[tangu-mobile] unhandledrejection:', e.reason) })

try { document.documentElement.lang = resolveInitialLocale() === 'zh' ? 'zh-CN' : 'en' } catch { /* ignore */ }

let initSeed: string | undefined
let persistedLang: string | null = null
try { initSeed = localStorage.getItem('forsion_theme_seed') || undefined } catch { /* ignore */ }
try { persistedLang = localStorage.getItem('forsion_theme_lang') } catch { /* ignore */ }
try {
  applyTheme(resolveInitialLang(), resolveInitialSkin(), resolveInitialMode(), { customColor: initSeed })
  try { document.documentElement.dataset.flat = localStorage.getItem('forsion_theme_flat') !== '0' ? '1' : '0' } catch { /* ignore */ }
  preloadAllThemes()
  document.documentElement.style.removeProperty('background')
  void useTheme.getState().initThemes(persistedLang)
  installEngine()
  // 丝滑光标:desktop 在 main.tsx 装,移动端走的是本模块 —— 漏装过一轮(用户实报「移动端没生效」)。
  // 缺席即关(设置→外观里开);软键盘的重定位与偏移补偿在 smoothCaret 里接 visualViewport。
  // (旧注释写的「移动端没有设置开关」是错的:不列的只有「常规」页,「外观」页是共用的,
  //  丝滑光标与字体三档的开关在移动端照样渲染 —— 见 SettingsModal 的 theme tab。)
  installSmoothCaret()
  // 界面字体三档:设置→外观里的那三个输入框**没有桌面门控**,移动端本来就能改、改完当场生效
  // (setFont 自己调 applyUiFonts),但启动时没人读回 localStorage → 重启即回退。半坏比没有更糟。
  applyUiFonts()
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
