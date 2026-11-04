/**
 * Tangu 界面半身的运行时加载,主进程这一半(界面热更新 4b;施工图 docs/ToBeImproved/Tangu界面热更新落地计划_2026-10-23.md §1.2、§2、§5)。
 *
 * 渲染层每个窗口启动时问一次「这次用哪份界面」(coreTangu:load),这里答 —— 界面跟着引擎走:
 *  · 目标版本 = 正在跑的引擎是哪一版(就绪过才知道);还不知道就用启动器会挑中的那版(selectOverlay),并在这次运行里钉住,
 *    免得更新器中途落位了新版、后开的窗口拿到比引擎新的界面;
 *  · 目标是热更新版,且它带 ui/main.js、manifest.json 的 forDesktop 恰好等于这份桌面的版本、目录过了 checkOverlay
 *    (签名 / 依赖 / 建表),读进来的字节对得上 SIGNATURE 里的哈希 → 用它;
 *  · 否则用安装包自带的 <引擎包根>/ui/main.js(引擎照跑热更新版也没关系:等于今天「只热更了引擎」);
 *  · 都没有(dev 没开 TANGU_UI=bundle、不带引擎的产品档案)→ null,渲染层走编进宿主的那份。
 * 热更新那版的界面求值 / 激活失败,渲染层调 coreTangu:markBad:整版记坏(两半一起退,引擎下次拉起也退回自带的),随后重载。
 * 引擎就绪时若跑的不是界面那一版(退回了 / 换了版),engineSettled 返回 true,调用方让所有窗口重载一次。
 * 模块顶层不 import electron(vitest 直测)。
 */
import { createHash } from 'node:crypto'
import { promises as fs } from 'node:fs'
import path from 'node:path'

export const UI_ENTRY = 'ui/main.js'
export const UI_MANIFEST = 'manifest.json'

export interface CoreTanguPackage {
  /** overlay = 引擎热更新那一版里带的;bundled = 安装包自带的。 */
  source: 'overlay' | 'bundled'
  /** 引擎包的版本号(两半同号)。 */
  version: string
  code: string
}

type OverlayDir = { version: string; dir: string }

export interface CoreTanguDeps {
  /** 安装包里的引擎包根(打包 = resources/tangu-server;dev = 仓里的 tangu-agent)。 */
  bundledRoot: string
  /** 这份桌面的版本(app.getVersion())。 */
  desktopVersion: string
  /** 不带参数:启动器这次会挑中的热更新版;带版本号:这一版的目录(过了 checkOverlay 才返回)。没有 = null。 */
  overlay(version?: string): Promise<OverlayDir | null>
  /** 正在跑的引擎:热更新版本号 / null = 自带的 / undefined = 还没就绪过(不知道)。 */
  runningOverlay(): string | null | undefined
  /** 把一版整版记坏(引擎的 markBad)。 */
  demote(version: string, reason: string): void
  log?: (m: string) => void
}

const sha256 = (b: Buffer): string => createHash('sha256').update(b).digest('hex')

/** 热更新目录里的界面能不能在这份桌面上用;能用返回代码,否则返回不用的原因。
 *  ponytail: checkOverlay 验签和这里读文件之间隔着几毫秒;能在这几毫秒里改用户目录的,本来就能改用户目录里不验签的插件。 */
async function readOverlayUi(dir: string, desktopVersion: string): Promise<{ code: string } | { skip: string }> {
  let manifest: { forDesktop?: unknown }
  try {
    manifest = JSON.parse(await fs.readFile(path.join(dir, UI_MANIFEST), 'utf8'))
  } catch {
    return { skip: 'no UI half (engine-only update)' }
  }
  // 精确匹配(拍板 3):共享模块和构建时完全一致,才敢让它直接拿宿主的模块
  if (manifest.forDesktop !== desktopVersion) return { skip: `built for Forsion ${String(manifest.forDesktop)}, this is ${desktopVersion}` }
  const [bytes, sig] = await Promise.all([fs.readFile(path.join(dir, UI_ENTRY)), fs.readFile(path.join(dir, 'SIGNATURE'), 'utf8')])
  const signed = (JSON.parse(sig) as { files?: Record<string, string> }).files?.[UI_ENTRY]
  if (!signed || sha256(bytes) !== signed) return { skip: `${UI_ENTRY} does not match its signed hash` }
  return { code: bytes.toString('utf8') }
}

export function createCoreTangu(deps: CoreTanguDeps) {
  const log = deps.log ?? (() => {})
  /** 本进程里记过坏的版本:bad.json 写不进去、或引擎还在跑这一版时,界面这边照样不再给,免得重载转圈。 */
  const badUi = new Set<string>()
  /** 引擎还没就绪时预测的目标(undefined = 还没预测过),这次运行里不再变。 */
  let pinned: OverlayDir | null | undefined
  /** 上一次交给渲染层的热更新版界面(自带的 = null)。 */
  let servedOverlay: string | null = null

  async function target(): Promise<OverlayDir | null> {
    const running = deps.runningOverlay()
    if (running === undefined) return pinned !== undefined ? pinned : (pinned = await deps.overlay().catch(() => null))
    return running ? deps.overlay(running).catch(() => null) : null
  }

  return {
    async load(): Promise<CoreTanguPackage | null> {
      const overlay = await target()
      if (overlay && !badUi.has(overlay.version)) {
        const r = await readOverlayUi(overlay.dir, deps.desktopVersion).catch((e) => ({ skip: (e as Error)?.message || String(e) }))
        if ('code' in r) {
          servedOverlay = overlay.version
          return { source: 'overlay', version: overlay.version, code: r.code }
        }
        log(`[core-tangu] engine update ${overlay.version}: using the bundled UI (${r.skip})`)
      }
      servedOverlay = null
      try {
        const code = await fs.readFile(path.join(deps.bundledRoot, UI_ENTRY), 'utf8')
        const version = String(JSON.parse(await fs.readFile(path.join(deps.bundledRoot, 'package.json'), 'utf8')).version ?? '')
        return { source: 'bundled', version, code }
      } catch {
        return null
      }
    },
    /** 渲染层报:这一版的界面求值 / 激活失败,或者开头一分钟里崩了两次。 */
    markBad(version: unknown, reason: unknown): void {
      if (typeof version !== 'string' || !version) return
      badUi.add(version)
      if (servedOverlay === version) servedOverlay = null
      log(`[core-tangu] UI of engine update ${version} failed, disabling the whole version: ${String(reason)}`)
      try { deps.demote(version, `UI: ${String(reason).slice(0, 300)}`) } catch { /* 写不进去也有 badUi 兜着 */ }
    },
    /** 引擎就绪时调:界面用的是热更新版、引擎跑的却不是那一版 → true,调用方让窗口重载(重载后跟着引擎走)。
     *  界面是自带的而引擎是热更新版不重载:旧界面连新引擎和今天「只热更了引擎」一样,下次启动两半再对齐。 */
    engineSettled(): boolean {
      const running = deps.runningOverlay()
      if (!servedOverlay || running === undefined || running === servedOverlay) return false
      log(`[core-tangu] engine is running ${running ?? 'the bundled version'}, not ${servedOverlay}; reloading the UI to match`)
      servedOverlay = null
      return true
    },
  }
}
