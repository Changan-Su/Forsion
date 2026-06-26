import React from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './App'
import './styles/base.css'
import { applyTheme, preloadAllThemes } from './theme/loader'
import { resolveInitialMode, resolveInitialPreset } from './theme/registry'
import { LocaleProvider, resolveInitialLocale } from './i18n'
import './i18n.generated' // 注册全量翻译字典(渲染前)

// 同 FOUC 主题:首屏即按持久化 locale 设 <html lang>。
try { document.documentElement.lang = resolveInitialLocale() === 'zh' ? 'zh-CN' : 'en' } catch { /* ignore */ }

// 标记宿主平台:macOS 用 hiddenInset 标题栏,交通灯按钮浮在窗口左上角,需给左上品牌区让出留白。
try { if (window.tangu?.platform === 'darwin') document.documentElement.dataset.platform = 'mac' } catch { /* ignore */ }

// index.html 的 FOUC 脚本已设 data-theme/.dark/data-flat;这里接管为 registry 校验过的 preset 并激活其 CSS。
let initSeed: string | undefined
try { initSeed = localStorage.getItem('forsion_theme_seed') || undefined } catch { /* private mode */ }
applyTheme(resolveInitialPreset(), resolveInitialMode(), { customColor: initSeed })
try { document.documentElement.dataset.flat = localStorage.getItem('forsion_theme_flat') === '1' ? '1' : '0' } catch { /* private mode */ }
preloadAllThemes()
document.documentElement.style.removeProperty('background') // 交还给主题 CSS

createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <LocaleProvider>
      <App />
    </LocaleProvider>
  </React.StrictMode>,
)
