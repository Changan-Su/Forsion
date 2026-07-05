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

window.addEventListener('error', (e) => { console.error('[tangu-mobile] window error:', e.error || e.message) })
window.addEventListener('unhandledrejection', (e) => { console.error('[tangu-mobile] unhandledrejection:', e.reason) })

try { document.documentElement.lang = resolveInitialLocale() === 'zh' ? 'zh-CN' : 'en' } catch { /* ignore */ }

let initSeed: string | undefined
let persistedLang: string | null = null
try { initSeed = localStorage.getItem('forsion_theme_seed') || undefined } catch { /* ignore */ }
try { persistedLang = localStorage.getItem('forsion_theme_lang') } catch { /* ignore */ }
try {
  applyTheme(resolveInitialLang(), resolveInitialSkin(), resolveInitialMode(), { customColor: initSeed })
  try { document.documentElement.dataset.flat = localStorage.getItem('forsion_theme_flat') === '1' ? '1' : '0' } catch { /* ignore */ }
  preloadAllThemes()
  document.documentElement.style.removeProperty('background')
  void useTheme.getState().initThemes(persistedLang)
  installEngine()
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
