/**
 * Tangu 界面半身的运行时加载,主进程这一半(界面热更新 4b;施工图 docs/ToBeImproved/Tangu界面热更新落地计划_2026-10-23.md §1.2、§2、§5)。
 *
 * 渲染层每个窗口启动时问一次「这次用哪份界面」(coreTangu:load),这里答 —— 界面跟着引擎走:
 *  · 目标版本 = 正在跑的引擎是哪一版(就绪过才知道);还不知道就用启动器会挑中的那版(selectOverlay),并在这次运行里钉住,
 *    免得更新器中途落位了新版、后开的窗口拿到比引擎新的界面;
 *  · 目标是热更新版,且它带 ui/main.js、manifest.json 的 forDesktop 恰好等于这份桌面的版本、目录过了 checkOverlay
 *    (签名 / 依赖 / 建表),读进内存的这两份字节对着同一刻读到的 SIGNATURE 验签通过 → 用它;
 *  · 否则用安装包自带的 <引擎包根>/ui/main.js(引擎照跑热更新版也没关系:等于今天「只热更了引擎」);
 *  · 都没有(dev 没开 TANGU_UI=bundle、不带引擎的产品档案)→ null,渲染层走编进宿主的那份。
 * 每个窗口拿到的是哪一份记在这里(按 webContents id):失败 / 崩溃上报只认这份记录,不信渲染层传来的版本号。
 *  · 热更新那版求值 / 激活失败,或开头一分钟里崩两次(跨重载累计)→ 整版记坏(两半一起退,引擎下次拉起也退回自带的),重载;
 *  · 自带的那份失败 → 这个窗口之后一律答 null(走编进宿主的那份),重载;
 *  · 引擎就绪时跑的不是某个窗口拿到的热更新版(退回了 / 换了版)→ engineReady 列出这些窗口,调用方重载它们。
 *    拿到自带界面、引擎却跑热更新版的窗口不重载:和 forDesktop 对不上时一样,是引擎本来就得兼容的组合(门禁按基准桌面验),
 *    下次启动两半再对齐 —— 首启预取在第一个窗口之前跑完,预测已经算上它;只有会话中途引擎重启换了版才会这样,不为它打断用户。
 * 模块顶层不 import electron(vitest 直测)。
 */
import { promises as fs } from 'node:fs'
import path from 'node:path'

export const UI_ENTRY = 'ui/main.js'
export const UI_MANIFEST = 'manifest.json'
/** 开头一分钟里被 ErrorBoundary 接住几次就整版退(施工图 §1.2)。 */
export const CRASH_LIMIT = 2

export interface CoreTanguPackage {
  /** overlay = 引擎热更新那一版里带的;bundled = 安装包自带的。 */
  source: 'overlay' | 'bundled'
  /** 引擎包的版本号(两半同号)。 */
  version: string
  code: string
}

type OverlayDir = { version: string; dir: string }
type Served = { source: CoreTanguPackage['source']; version: string } | null

export interface CoreTanguDeps {
  /** 安装包里的引擎包根(打包 = resources/tangu-server;dev = 仓里的 tangu-agent)。 */
  bundledRoot: string
  /** 这份桌面的版本(app.getVersion())。 */
  desktopVersion: string
  /** 不带参数:启动器这次会挑中的热更新版;带版本号:这一版的目录(过了 checkOverlay 才返回)。没有 = null。 */
  overlay(version?: string): Promise<OverlayDir | null>
  /** 正在跑的引擎:热更新版本号 / null = 自带的 / undefined = 还没就绪过(不知道)。 */
  runningOverlay(): string | null | undefined
  /** 读进内存的字节对着 SIGNATURE 文本验签(引擎的 verifySignedBytes);null = 通过。 */
  verify(signature: string, files: Record<string, Uint8Array>): string | null
  /** 把一版整版记坏(引擎的 markBad)。 */
  demote(version: string, reason: string): void
  log?: (m: string) => void
}

/** 热更新目录里的界面能不能在这份桌面上用;能用返回代码,否则返回不用的原因。 */
async function readOverlayUi(dir: string, deps: CoreTanguDeps): Promise<{ code: string } | { skip: string }> {
  const read = (rel: string): Promise<Buffer | null> => fs.readFile(path.join(dir, rel)).catch(() => null)
  const [manifest, bytes, sig] = await Promise.all([read(UI_MANIFEST), read(UI_ENTRY), read('SIGNATURE')])
  if (!manifest || !bytes) return { skip: 'no UI half (engine-only update)' }
  if (!sig) return { skip: 'no SIGNATURE' }
  const bad = deps.verify(sig.toString('utf8'), { [UI_MANIFEST]: manifest, [UI_ENTRY]: bytes })
  if (bad) return { skip: bad }
  let forDesktop: unknown
  try { forDesktop = (JSON.parse(manifest.toString('utf8')) as { forDesktop?: unknown }).forDesktop } catch { return { skip: `${UI_MANIFEST} is not JSON` } }
  // 精确匹配(拍板 3):共享模块和构建时完全一致,才敢让它直接拿宿主的模块
  if (forDesktop !== deps.desktopVersion) return { skip: `built for Forsion ${String(forDesktop)}, this is ${deps.desktopVersion}` }
  return { code: bytes.toString('utf8') }
}

export function createCoreTangu(deps: CoreTanguDeps) {
  const log = deps.log ?? (() => {})
  /** 本进程里记过坏的版本:bad.json 写不进去、或引擎还在跑这一版时,界面这边照样不再给,免得重载转圈。 */
  const badUi = new Set<string>()
  /** 引擎还没就绪时预测的目标(undefined = 还没预测过),这次运行里不再变。 */
  let pinned: OverlayDir | null | undefined
  /** 每个窗口(webContents id)这次拿到的是哪一份;null = 让它走编进宿主的那份。 */
  const served = new Map<number, Served>()
  /** 自带的那份在这些窗口里失败过:之后一律答 null(不靠渲染层的 sessionStorage,存不住也不转圈)。 */
  const bundledFailed = new Set<number>()
  /** 热更新版的渲染崩溃次数(按版本,这次运行里跨重载累计)。 */
  const crashes = new Map<string, number>()

  async function target(): Promise<OverlayDir | null> {
    const running = deps.runningOverlay()
    if (running === undefined) return pinned !== undefined ? pinned : (pinned = await deps.overlay().catch(() => null))
    return running ? deps.overlay(running).catch(() => null) : null
  }

  async function overlayCode(t: OverlayDir | null): Promise<string | null> {
    if (!t || badUi.has(t.version)) return null
    const r = await readOverlayUi(t.dir, deps).catch((e) => ({ skip: (e as Error)?.message || String(e) }))
    if ('code' in r) return r.code
    log(`[core-tangu] engine update ${t.version}: using the bundled UI (${r.skip})`)
    return null
  }

  function disable(windowId: number, reason: string): boolean {
    const s = served.get(windowId)
    if (!s) return false // 没给过它包(或给的是编进宿主的那份):没什么可退
    served.delete(windowId)
    if (s.source === 'bundled') {
      bundledFailed.add(windowId)
      log(`[core-tangu] bundled UI ${s.version} failed in window ${windowId}, falling back to the built-in copy: ${reason}`)
      return true
    }
    badUi.add(s.version)
    log(`[core-tangu] UI of engine update ${s.version} failed, disabling the whole version: ${reason}`)
    try { deps.demote(s.version, `UI: ${reason.slice(0, 300)}`) } catch { /* 写不进去也有 badUi 兜着 */ }
    return true
  }

  return {
    async load(windowId: number): Promise<CoreTanguPackage | null> {
      served.delete(windowId)
      let t: OverlayDir | null = null
      let code: string | null = null
      for (let attempt = 0; attempt < 3; attempt++) {
        t = await target()
        code = await overlayCode(t)
        // 读文件的这几毫秒里引擎可能就绪了,跑的却不是 t:按它跑的那版再来(Codex 4b 评审)。下面到 served.set 之间没有 await。
        const running = deps.runningOverlay()
        if (running === undefined || running === (t?.version ?? null)) break
      }
      if (t && code !== null) {
        served.set(windowId, { source: 'overlay', version: t.version })
        return { source: 'overlay', version: t.version, code }
      }
      if (bundledFailed.has(windowId)) { served.set(windowId, null); return null }
      try {
        const [bundledCode, pkg] = await Promise.all([
          fs.readFile(path.join(deps.bundledRoot, UI_ENTRY), 'utf8'),
          fs.readFile(path.join(deps.bundledRoot, 'package.json'), 'utf8'),
        ])
        const version = String(JSON.parse(pkg).version ?? '')
        served.set(windowId, { source: 'bundled', version })
        return { source: 'bundled', version, code: bundledCode }
      } catch {
        served.set(windowId, null)
        return null
      }
    },
    /** 渲染层报:这个窗口拿到的那份求值 / 激活失败。返回 true = 调用方重载这个窗口。 */
    failed(windowId: number, reason: unknown): boolean {
      return disable(windowId, String(reason ?? ''))
    },
    /** 渲染层报:开头一分钟里被 ErrorBoundary 接住一次(栈里有这份包)。够数了整版退,返回 true = 重载。 */
    crashed(windowId: number, reason: unknown): boolean {
      const s = served.get(windowId)
      if (s?.source !== 'overlay') return false
      const n = (crashes.get(s.version) ?? 0) + 1
      crashes.set(s.version, n)
      log(`[core-tangu] UI of engine update ${s.version} crashed (${n}/${CRASH_LIMIT})`)
      return n >= CRASH_LIMIT && disable(windowId, `render crashed ${n} times: ${String(reason ?? '')}`)
    },
    /** 窗口关了。 */
    forget(windowId: number): void {
      served.delete(windowId)
      bundledFailed.delete(windowId)
    },
    /** 引擎就绪时调:拿到热更新版界面、而引擎跑的不是那一版的窗口 → 调用方重载它们(重载后跟着引擎走)。 */
    engineReady(): number[] {
      const running = deps.runningOverlay()
      if (running === undefined) return []
      const stale = [...served].filter(([, s]) => s?.source === 'overlay' && s.version !== running).map(([id]) => id)
      for (const id of stale) served.delete(id)
      if (stale.length) log(`[core-tangu] engine is running ${running ?? 'the bundled version'}; reloading ${stale.length} window(s) to match`)
      return stale
    },
  }
}
