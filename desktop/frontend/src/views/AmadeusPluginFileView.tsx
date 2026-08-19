/** 通用「插件文件类型」视图:树上点某个插件声明的文件(如 `.mindmap.md`)在应用内打开。
 *  一个引擎视图类型(amadeus-plugin-file)服务所有插件文件类型 —— 挂载时按 params.filePath 反查已
 *  注册的 FileTypeContribution,调它的 mount(el, { filePath }) 把编辑器画进容器。插件晚于 boot 加载
 *  也没关系(挂载/重渲即查表;fileTypes 变化会触发重挂)。与 AmadeusDrawingView 同一套契约域包裹。 */
import { useEffect, useRef } from 'react'
import type { ViewProps } from '@lcl/engine'
import { useTheme } from '../stores/themeStore'
import { usePageStore, pageStoreFor } from '../amadeus/store/pageStore'
import { usePluginStore, findFileType, fileTypeBaseName, addPluginViewTeardown } from '../amadeus/plugins/pluginStore'
import { createPluginViewSurface } from '../amadeus/plugins/viewSurface'
import { isBuiltinFileType } from '@amadeus-shared/builtinTypes'
import { openFile } from '../amadeusNav'

export function AmadeusPluginFileView({ leaf }: ViewProps) {
  const filePath = typeof leaf.params.filePath === 'string' ? leaf.params.filePath : ''
  const mode = useTheme((s) => s.mode)
  const flat = useTheme((s) => s.flat)
  // 订阅 fileTypes:插件加载后新注册的类型会触发重渲染 → 从「无人能开」变为正常挂载。
  const fileTypes = usePluginStore((s) => s.fileTypes)
  const ft = findFileType(fileTypes, filePath) // 引用稳定(=注册时存入的同一对象),effect 不会空转
  // 订阅 vaultRoot:切库(filePath 是 vault 相对路径,换库后同名会指向另一个库)或库首次就绪时重挂 →
  // 插件按新库重读(不存在则显示错误态,不会用旧内容写坏新库);也自愈「库未就绪时先挂 → 读到 null」的启动态(Codex #1)。
  const vaultRoot = usePageStore((s) => s.vaultRoot)
  const hostRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    if (filePath && ft) leaf.setTitle(fileTypeBaseName(filePath, ft.extensions) || ft.title || filePath)
  }, [filePath, ft]) // eslint-disable-line react-hooks/exhaustive-deps

  // 迁移旧标签页:某个文件类型被宿主收编成内置后(如 `.mindmap.md`),布局里存着的
  // `{amadeus-plugin-file, filePath}` 标签页会因 findFileType 被内置闸拒绝而变成「没有已启用的插件能打开」。
  // 认出内置类型就地导航到它自己的视图 —— 用户不该为一次内置化去手动关标签页(Codex)。
  useEffect(() => {
    if (filePath && isBuiltinFileType(filePath)) openFile(filePath)
  }, [filePath])

  useEffect(() => {
    const host = hostRef.current
    if (!host || !filePath || !ft) return
    // 每次挂载发一个**新的子容器**:插件普遍裸 createRoot(el) + 微任务延迟 unmount,同一 el 复用会
    // 撞出「重挂建第二个 root + 旧 root 延迟卸载对已摘除节点抛错」(评审 P2)。子容器一次一个,
    // 旧容器随旧 root 的延迟卸载自清自摘,互不相干。
    host.textContent = ''
    const el = document.createElement('div')
    el.className = 'amx-pluginfile-mount'
    el.style.height = '100%' // 插件根(amx-pane)按父高铺满,中间容器不能塌成 auto
    host.appendChild(el)
    // per-view 页表面(scope 化,2026-08-14):这个 tab 拿自己的 pageStore 作用域,与编辑器面板
    // 并存编辑。scope 用 leaf.id 前缀化 —— 与编辑器面板的 scope(裸 leaf.id)同一命名空间但不撞。
    // 吊销双保险:视图卸载走本 effect 的 cleanup;插件禁用走 pluginStore.teardown 的同步吊销
    // (fileTypes 一变 ft 就换 → 本 effect 也会重跑,但那是下一拍,空窗期不能留)。
    const pluginId = usePluginStore.getState().fileTypes.find((o) => o.item === ft)?.pluginId ?? 'unknown'
    const vs = createPluginViewSurface(pluginId, `plug:${leaf.id}`, ft.extensions ?? [])
    const dereg = addPluginViewTeardown(pluginId, vs.dispose)
    // 改名跟车(2026-08-14 完整笔记面后,标题栏/树上都能改名):改名会 remap 本视图 scope store
    // 的 activePage(renamePage 直改 / renameAt 的 remapScopePaths),leaf 参数不跟着换,重启/重开
    // 就指回旧路径。setParams 换 filePath → 本 effect 按新路径重挂(改名罕见,重挂代价可接受)。
    // 订阅住在主 effect 里与 surface 同源同灭 —— 单独 effect 无条件 pageStoreFor 会在 ft 缺席时
    // 凭空造出无人回收的 scope store(评审 P2)。
    const unsub = pageStoreFor(`plug:${leaf.id}`).subscribe((s, prev) => {
      if (prev.activePage === filePath && s.activePage && s.activePage !== filePath) {
        leaf.setParams({ ...leaf.params, filePath: s.activePage })
      }
    })
    let cleanup: (() => void) | void
    try {
      cleanup = ft.mount(el, { filePath, surface: vs.surface })
    } catch (e) {
      console.error('[amadeus] 插件文件视图挂载失败', e)
    }
    return () => {
      try {
        cleanup?.()
      } catch {
        /* ignore */
      }
      unsub()
      dereg()
      vs.dispose()
      // 微任务后再摘容器:插件的延迟 unmount 还要在它身上跑一拍(直接 remove 会让 React 卸到
      // 已摘除的节点上,历史上会抛 removeChild 错)。
      queueMicrotask(() => queueMicrotask(() => el.remove()))
    }
  }, [filePath, ft, vaultRoot]) // eslint-disable-line react-hooks/exhaustive-deps

  if (!filePath) return <div className="amx-draw-state">未指定文件。</div>
  if (!ft) return <div className="amx-draw-state">没有已启用的插件能打开「{filePath}」。</div>
  return (
    <div
      className="am-app tangu-lovable amx-pane amx-pluginfile"
      data-mode={mode}
      data-flat={flat ? '1' : '0'}
      ref={hostRef}
    />
  )
}
