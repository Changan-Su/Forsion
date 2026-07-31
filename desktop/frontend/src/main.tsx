import { createRoot } from 'react-dom/client'
import { Root } from './Root'
import { ErrorBoundary } from './components/ErrorBoundary'
import './styles/base.css'
import './amadeus-host.css' // Amadeus Space:vendored 渲染层样式(均 scoped,不碰 Tangu :root)
import { applyTheme, preloadAllThemes } from './theme/loader'
import { resolveInitialEffectiveMode, resolveInitialLang, resolveInitialSkin } from './theme/registry'
import { useTheme } from './stores/themeStore'
import { LocaleProvider, resolveInitialLocale } from './i18n'
import './i18n.generated' // 注册全量翻译字典(渲染前)
import { installEngine } from './bootstrapEngine'
import { ChatPreview } from './views/chat2/ChatPreview'
import { windowKind } from './windowKind'
import { DetachedRoot } from './DetachedRoot'
import { MiniRoot } from './MiniRoot'
import { installMultiWindow } from './multiWindow'
import { installSmoothCaret } from './smoothCaret'
import { applyUiFonts } from './uiFont'
import { installScrollFade } from './scrollFade'

// 全局错误兜底:ErrorBoundary 只接 React 渲染期异常,接不到事件回调/异步里的未捕获错误,
// 也接不到渲染进程级崩溃。这里至少把它们记到 console(配合主进程崩溃自愈),便于诊断白屏。
window.addEventListener('error', (e) => { console.error('[tangu] window error:', e.error || e.message) })
window.addEventListener('unhandledrejection', (e) => { console.error('[tangu] unhandledrejection:', e.reason) })

// 仅设计预览:#preview 用样例数据渲染新视觉(无后端即可截图评审),正常 app 不受影响。
const isPreview = (() => { try { return location.hash === '#preview' } catch { return false } })()
// 多窗口分流:主进程开卫星窗时经 ?window= 注入(detached=无 ribbon dockview / mini=悬浮卡片)。
const kind = windowKind()

// 首屏即按持久化 locale 设 <html lang>(同 FOUC 主题)。
try { document.documentElement.lang = resolveInitialLocale() === 'zh' ? 'zh-CN' : 'en' } catch { /* ignore */ }

// macOS hiddenInset 标题栏:交通灯浮在左上,ribbon 顶部已留白。
try { if (window.tangu?.platform === 'darwin') document.documentElement.dataset.platform = 'mac' } catch { /* ignore */ }

// index.html 的 FOUC 脚本已设 data-theme/data-skin/.dark;这里接管为 registry 校验过的 语言×配色 并激活其 CSS。
let initSeed: string | undefined
let persistedLang: string | null = null
try { initSeed = localStorage.getItem('forsion_theme_seed') || undefined } catch { /* private mode */ }
// 在 applyTheme 覆写 forsion_theme_lang 之前先抓住原始值:磁盘语言(soft/用户主题)首屏未加载会被回退到 lovable,
// initThemes 据此把它接回来。
try { persistedLang = localStorage.getItem('forsion_theme_lang') } catch { /* private mode */ }
// 主题/引擎初始化是模块级副作用,跑在 React 挂载之前 —— 任一处抛错都会让 React 永不挂载 = 白屏。
// 包 try/catch:即便初始化失败也继续挂载(退化样式总好过白屏)。
try {
  applyTheme(resolveInitialLang(), resolveInitialSkin(), resolveInitialEffectiveMode(), { customColor: initSeed })
  try { document.documentElement.dataset.flat = localStorage.getItem('forsion_theme_flat') !== '0' ? '1' : '0' } catch { /* private mode */ }
  preloadAllThemes()
  document.documentElement.style.removeProperty('background') // 交还给主题 CSS
  // 合并 ~/.tangu/themes 的磁盘主题(soft 也在其中),并把首屏被回退的磁盘语言接回来。
  void useTheme.getState().initThemes(persistedLang)
  // 注册引擎贡献项(视图/命令/ribbon/状态项),须在 WorkspaceHost 挂载前。
  installEngine()
  // 多窗接线:把引擎 detach 缝接到 window.tangu(桌面);web/移动 no-op。须在任何 WbTab 渲染前设好缝。
  installMultiWindow()
  // 丝滑光标(默认开;设置→外观开关)。
  installSmoothCaret()
  // 界面字体覆盖(设置→外观;缺席=跟随主题,不注入任何声明)。
  applyUiFonts()
  // 滚动条自动隐现:静止透明,滚动中/悬停才显形(样式在 base.css 与 amadeus/styles.css)。
  installScrollFade()
} catch (err) {
  console.error('[tangu] init failed, continue to mount:', err)
}

// 不用 React.StrictMode:其开发期 double-invoke 会重复初始化 Amadeus Space 的 Milkdown 编辑器。
createRoot(document.getElementById('root')!).render(
  <LocaleProvider>
    <ErrorBoundary>
      {isPreview ? <ChatPreview /> : kind === 'mini' ? <MiniRoot /> : kind === 'detached' ? <DetachedRoot /> : <Root />}
    </ErrorBoundary>
  </LocaleProvider>,
)
