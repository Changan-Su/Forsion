/**
 * Tangu 入口从哪来(界面热更新 4b;施工图 docs/ToBeImproved/Tangu界面热更新落地计划_2026-10-23.md §1.2、§1.3)。
 *
 * - 桌面打包版(dev 开 TANGU_UI=bundle 也是):主进程交来引擎选中那份目录里的 ui/main.js(electron/coreTangu.ts),
 *   这里 `new Function('require', code)` 求值,require 查共享模块表(sharedModules.generated.ts),Tangu 的 CSS 在
 *   宿主样式之后整块注入;返回包里的 activateTangu。
 * - 其余(dev、网页、主进程答 null):动态 import 编进宿主的那份。手机不经这里,mobileEntry 直接静态引。
 *
 * 失败的退路 —— 从不原地重来(installTanguSlice 只装一次,视图也可能已经注册了一半),一律由主进程重载这个窗口:
 * - 热更新那版求值 / 激活抛错,或激活后 60 秒内被 ErrorBoundary 接住两次(栈里有这份包;主进程跨重载累计):整版记坏
 *   (主进程连引擎一起退)→ 重载,主进程下次给自带的;
 * - 自带的那份也坏了:主进程记下这个窗口、之后答 null(这里另记一个 sessionStorage 标记双保险)→ 重载,走编进宿主的那份
 *   (安装包本身的 bug,最后一道兜底)。
 * 上报只带原因,哪一份由主进程按它交给这个窗口的记录认。
 */
import type { TanguHost } from '../amadeus/plugins/tanguSeam'
import { createHostRequire } from './hostRequire'

type Activate = (host: TanguHost) => void
interface CorePackage { source: 'overlay' | 'bundled'; version: string; code: string }
interface Bridge { load(): Promise<CorePackage | null>; failed(reason: string): Promise<void>; crashed(reason: string): Promise<void> }

export const SOURCE_MARK = 'forsion-core://tangu/' // 包末尾的 sourceURL,栈帧里认这份包
const STATIC_FLAG = 'forsion.coreTangu.static'
const CRASH_WINDOW_MS = 60_000

let current: CorePackage | null = null
let activatedAt = 0
let failing = false

const bridge = (): Bridge | undefined => (typeof window === 'undefined' ? undefined : (window as unknown as { tangu?: { coreTangu?: Bridge } }).tangu?.coreTangu)
const readFlag = (): boolean => { try { return sessionStorage.getItem(STATIC_FLAG) === '1' } catch { return false } }

/** 这份包坏了:热更新版整版记坏,自带的改走编进宿主的那份;然后由主进程重载这个窗口
 *  (渲染层自己 location.reload() 不行:主进程 hardenNav 拦下一切 file: 导航,重载也算一次,静默无效)。 */
async function fail(pkg: CorePackage, error: unknown): Promise<void> {
  if (failing) return
  failing = true
  const reason = (error as Error)?.message || String(error)
  console.error(`[core-tangu] ${pkg.source} UI ${pkg.version} failed:`, error)
  if (pkg.source === 'bundled') { try { sessionStorage.setItem(STATIC_FLAG, '1') } catch { /* 存不住就只能指望主进程 */ } }
  await bridge()?.failed(reason).catch(() => {})
}

export async function loadTanguEntry(): Promise<Activate> {
  const b = bridge()
  const pkg = b && !readFlag() ? await b.load().catch((e) => { console.error('[core-tangu] load failed:', e); return null }) : null
  if (pkg) {
    const t0 = performance.now()
    try {
      const { SHARED_MODULES } = await import('./sharedModules.generated')
      const { exports, css, onCss } = new Function('require', pkg.code)(createHostRequire(SHARED_MODULES)) as { exports: { activateTangu?: Activate }; css: string; onCss?: (fn: (sheet: string) => void) => void }
      const activate = exports?.activateTangu
      if (typeof activate !== 'function') throw new Error('the bundle has no activateTangu')
      // 宿主样式之后整块插进去;之后动态 import 的模块带出来的 CSS 各插一块(同 Vite 懒加载 chunk 的 CSS)
      const addStyle = (text: string): void => {
        const style = document.createElement('style')
        style.dataset.forsionCore = 'tangu'
        style.textContent = text
        document.head.appendChild(style)
      }
      addStyle(css)
      onCss?.(addStyle)
      current = pkg
      const ms = Math.round(performance.now() - t0)
      // 诊断 / 台架看这里:<html data-core-tangu="bundled 2.13.14" data-core-tangu-ms="…">(编进宿主的那份没有)
      document.documentElement.dataset.coreTangu = `${pkg.source} ${pkg.version}`
      document.documentElement.dataset.coreTanguMs = String(ms)
      console.log(`[core-tangu] ${pkg.source} UI ${pkg.version} evaluated in ${ms} ms`)
      return (host) => {
        try {
          activate(host)
          activatedAt = Date.now()
        } catch (e) {
          void fail(pkg, e)
          throw e
        }
      }
    } catch (e) {
      await fail(pkg, e)
      return new Promise<Activate>(() => {}) // 主进程在重载这个窗口:启动停在这里,不装引擎、不挂界面,什么都不落盘
    }
  }
  return (await import('@tangu/ui/features/tangu')).activateTangu
}

/** ErrorBoundary 接住一次渲染崩溃时调。只报热更新那版、激活后一分钟内、栈里有这份包的;
 *  次数由主进程按版本跨重载累计(electron/coreTangu.ts,两次就整版退并重载),这里不计数 —— 重载一次就清零了(Codex 4b 评审)。 */
export function noteRenderCrash(error: unknown): void {
  const pkg = current
  if (!pkg || pkg.source !== 'overlay' || failing || !activatedAt || Date.now() - activatedAt > CRASH_WINDOW_MS) return
  if (!String((error as Error)?.stack ?? '').includes(SOURCE_MARK)) return
  console.error(`[core-tangu] overlay UI ${pkg.version} crashed while rendering:`, error)
  void bridge()?.crashed((error as Error)?.message || String(error)).catch(() => {})
}

/** 这个窗口用的是哪份 Tangu 界面(诊断用);编进宿主的那份 = null。 */
export const coreTanguInfo = (): { source: CorePackage['source']; version: string } | null => (current ? { source: current.source, version: current.version } : null)
