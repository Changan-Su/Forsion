/**
 * workspace.open 的壳层接缝(LCL 表面规范方案 B 第三期,引擎侧见 lcl/engine/workspaceOpen.ts)。
 * 系统小窗那一档(`{ float: 'desktop' }`)在引擎里够不着 —— Mini 与 Floating Panel 都是壳层的东西:
 *   - 桌面:Mini = window.tangu.openMini(按实体复用、可多开,满了由 openMiniWindow 提示);Floating Panel = window.tangu.openFloatingPanel。
 *   - 网页:没有 Mini(引擎降成窗口作用域的浮层);Floating Panel = 页内浮层(pluginPanelSeam)。
 *   - 手机:两样都没有(插件的 openFloatingPanel 本来就不在手机上给)—— 引擎降级:Mini → 半屏抽屉,main → 停靠主区。
 * 用的时候现装(幂等):插件宿主、命令都经 hostWorkspaceOpen 进来,不依赖哪个入口先跑,手机 / 网页 / 桌面同一条路
 * (别在 main.tsx / Root.tsx 各加一行 —— 手机那份是重写的,会漏)。
 */
import { getView, setDesktopOpener, useWorkspace, workspaceOpen, type OpenOptions, type OpenResult, type OpenTarget, type ViewLocation } from '@lcl/engine'
import { openMiniWindow } from './mini/openMiniWindow'
import { openWebFloatingPanel } from './pluginPanelSeam'
import type { FloatingPanelOpenOptions } from '../../shared/floatingPanel'

let installed = false

export function installWorkspaceOpenHost(): void {
  if (installed || typeof window === 'undefined') return
  installed = true
  const t = window.tangu
  const mobile = !!(t as { mobile?: boolean } | undefined)?.mobile
  setDesktopOpener({
    ...(t?.openMini ? {
      mini: async (req) => {
        const r = await openMiniWindow({
          ...(req.spaceId ? { spaceId: req.spaceId } : { view: req.view, mainView: req.mainView }),
          params: req.params, key: req.key, title: req.title,
        })
        if (r && !r.ok) return r
        return r ? { ok: true as const } : undefined
      },
    } : {}),
    ...(!mobile ? {
      panel: (req) => {
        const target: FloatingPanelOpenOptions = {
          id: req.key ? `${req.view.type}#${req.key}` : req.view.type, title: req.title, view: req.view,
          width: req.size?.width, height: req.size?.height, minWidth: req.size?.minWidth, minHeight: req.size?.minHeight,
          ...(req.pin ? { pin: true } : {}),
        }
        if (t?.openFloatingPanel) void t.openFloatingPanel(target)
        else openWebFloatingPanel(target)
      },
    } : {}),
  })
}

/** 宿主侧(插件 ctx、命令)用的 workspace.open:先确保接缝在。 */
export function hostWorkspaceOpen(target: OpenTarget, opts?: OpenOptions): Promise<OpenResult> {
  installWorkspaceOpenHost()
  return workspaceOpen(target, opts)
}

/** 插件 ctx.openView 的打开器(pluginStore.viewOpener,syncPluginViews 注入,三端同一份):停靠经 workspace.open,
 *  View 声明了 forms 时按回落规则换位置。还没注册的类型照旧直接 openView(2.13.7 的行为:布局里先占位、注册后补上),
 *  不让 workspace.open 的 unknown-view 把它变成 no-op。 */
export function openDockedView(type: string, at: ViewLocation, params?: Record<string, unknown>): void {
  if (!getView(type)) { useWorkspace.getState().openView(type, params ?? {}, at); return }
  void hostWorkspaceOpen({ type, params: params ?? {} }, { layer: { dock: at } })
}

/** 测试用。 */
export function resetWorkspaceOpenHostForTest(): void { installed = false; setDesktopOpener(null) }
