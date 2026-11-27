/**
 * 网页端换版后的旧标签页。
 *
 * 每次部署都会换掉 assets/ 下带哈希的文件;部署前就开着的页面再去按需加载(预览里的编辑器、插件表面……)
 * 拿的还是旧文件名 → 404,报 `Failed to fetch dynamically imported module`,界面原地画出一行英文报错。
 * 这里不自动刷新(页面上可能有没存的草稿),只在确认「服务器上已经是新版」后弹一条常驻提示,让用户自己点刷新。
 *
 * 判新版:重新取一次入口 HTML(no-store),比对入口脚本地址。地址没变 = 只是网络断了一下,不提示「已更新」。
 * 只由网页入口(web/src/main.tsx)安装;桌面包走本地文件,不会出现这种情况。
 */
import { registerMessages, translate } from './i18n'

registerMessages({
  'app.staleBuild.text': { zh: 'Forsion 已更新，刷新页面后才能继续加载部分界面。', en: 'Forsion has been updated. Refresh the page to keep loading parts of it.' },
  'app.staleBuild.refresh': { zh: '刷新', en: 'Refresh' },
  'app.staleBuild.inline': { zh: '这部分界面没能加载，刷新页面后再试。', en: "This part couldn't load. Refresh the page and try again." },
})

// 各浏览器对「动态 import 的模块取不到」的报法;最后一条是 Vite 预加载样式失败。
const STALE_PATTERNS = [
  /Failed to fetch dynamically imported module/i, // Chromium
  /Importing a module script failed/i, // Safari
  /error loading dynamically imported module/i, // Firefox
  /Unable to preload CSS/i,
]

/** 这次失败是不是「按需加载的模块 / 样式没取到」(换版或断网都会这样)。 */
export function isStaleBuildError(e: unknown): boolean {
  const msg = e instanceof Error ? e.message : typeof e === 'string' ? e : ''
  return !!msg && STALE_PATTERNS.some((p) => p.test(msg))
}

/** 从一份入口 HTML 里取入口脚本的绝对地址;取不到给 null。 */
export function entryScriptOf(html: string, base: string): string | null {
  const m = /<script\b[^>]*\btype=["']module["'][^>]*\bsrc=["']([^"']+)["']|<script\b[^>]*\bsrc=["']([^"']+)["'][^>]*\btype=["']module["']/i.exec(html)
  const src = m?.[1] ?? m?.[2]
  if (!src) return null
  try { return new URL(src, base).href } catch { return null }
}

export interface StaleBuildDeps {
  /** 当前页面的入口脚本绝对地址。 */
  currentEntry(): string | null
  /** 取服务器上现在的入口 HTML;失败抛错。 */
  fetchIndex(): Promise<string>
  base(): string
  /** 弹「已更新 · 刷新」提示。 */
  prompt(): void
}

const RECHECK_MS = 30_000
const RETRY_MS = 5_000

/** 失败 → 查一次服务器版本 → 确认换版才提示。同一时刻只查一次;确认没换版 30 秒内不重查,没查成 5 秒后可再查。 */
export function createStaleBuildHandler(deps: StaleBuildDeps, now: () => number = Date.now): (e: unknown) => Promise<void> {
  let stale = false
  let checking: Promise<void> | null = null
  let quietUntil = -Infinity
  return (e) => {
    if (!isStaleBuildError(e)) return Promise.resolve()
    if (stale) { deps.prompt(); return Promise.resolve() }
    if (checking) return checking
    if (now() < quietUntil) return Promise.resolve()
    checking = (async () => {
      const current = deps.currentEntry()
      if (!current) return
      try {
        const latest = entryScriptOf(await deps.fetchIndex(), deps.base())
        if (latest && latest !== current) { stale = true; deps.prompt(); return }
        // 确认入口没变才长冷却;拿到的 HTML 认不出入口(部署中途 / 登录页)只短退避
        quietUntil = now() + (latest ? RECHECK_MS : RETRY_MS)
      } catch {
        // 取不到 HTML:断网,或部署正好删完旧文件、新页还没就位 —— 不说「已更新」,短退避后下次失败再查
        quietUntil = now() + RETRY_MS
      }
    })().finally(() => { checking = null })
    return checking
  }
}

// 不走应用通知:手机横幅点正文就会执行动作(误触即刷新、丢草稿),通知总开关关了或页面没挂通知区时又会不显示。
// 自己画一条只认「刷新」按钮的横条,也不用再按需取任何模块。
const BAR_ID = 'forsion-stale-build-bar'

/** 「已更新 · 刷新」横条:纯 DOM(照 unitBootError 的写法),已在就不重复画。 */
function showPrompt(): void {
  if (document.getElementById(BAR_ID)) return
  const bar = document.createElement('div')
  bar.id = BAR_ID
  bar.setAttribute('role', 'alert')
  const dark = document.documentElement.dataset.mode === 'dark'
  bar.style.cssText = 'position:fixed;left:50%;bottom:24px;transform:translateX(-50%);z-index:var(--z-palette,2147483647);display:flex;gap:12px;align-items:center;'
    + 'box-sizing:border-box;max-width:calc(100vw - 32px);padding:10px 10px 10px 16px;font:14px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;'
    + `border-radius:var(--radius-md,12px);border:1px solid var(--border,${dark ? '#3a3a3a' : '#e4e1da'});`
    + `background:var(--surface-float,${dark ? '#2a2a2a' : '#ffffff'});color:var(--text,${dark ? '#f2efe8' : '#1c1c1c'});box-shadow:var(--card-shadow,0 6px 24px rgba(0,0,0,.18))`
  const text = document.createElement('span')
  text.textContent = translate('app.staleBuild.text')
  const btn = document.createElement('button')
  btn.type = 'button'
  btn.textContent = translate('app.staleBuild.refresh')
  btn.style.cssText = 'font:inherit;padding:4px 12px;cursor:pointer;flex:none;border-radius:var(--radius-sm,8px)'
  btn.addEventListener('click', () => location.reload())
  bar.append(text, btn)
  document.body.appendChild(bar)
}

let installed = false

/** 网页入口调一次。监听 Vite 的预加载失败与没人接的 import 失败;不拦截原有的报错流程。 */
export function installStaleBuildRecovery(): void {
  if (installed || typeof window === 'undefined') return
  installed = true
  const handle = createStaleBuildHandler({
    currentEntry: () => (document.querySelector('script[type="module"][src]') as HTMLScriptElement | null)?.src || null,
    fetchIndex: async () => {
      const res = await fetch(document.baseURI, { cache: 'no-store', credentials: 'same-origin' })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      return res.text()
    },
    base: () => document.baseURI,
    prompt: showPrompt,
  })
  // 不 preventDefault:Vite 那边照常把错误抛回调用方(调用方各自的失败处理不变)。
  window.addEventListener('vite:preloadError', (ev) => { void handle((ev as Event & { payload?: unknown }).payload) })
  // 没有依赖的 import() 不经 Vite 包装,失败只会变成没人接的 rejection。
  window.addEventListener('unhandledrejection', (ev) => { void handle(ev.reason) })
}
