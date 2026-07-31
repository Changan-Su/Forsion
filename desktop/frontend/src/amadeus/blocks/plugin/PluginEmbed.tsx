/** 通用「插件嵌入块」:`![[x.mindmap.md]]` 等由插件 registerEmbedRenderer 声称能渲染的目标,在笔记里
 *  内联成一个只读预览块。一个组件服务所有插件嵌入渲染器 —— 挂载时按 target 反查已注册渲染器,调其
 *  mount(el, { target, pagePath })。与 ExcalidrawEmbed 同一角色(BlockHost 的 embedPlugin 分支渲染它)。 */
import { useEffect, useRef } from 'react'
import { usePluginStore, findEmbedRenderer } from '../../plugins/pluginStore'
import { useBlockSelection } from '../../store/blockSelection'

export function PluginEmbed({ target, pagePath, blockId }: { target: string; pagePath: string; blockId?: string }) {
  // 订阅 embedRenderers:插件加载后新注册的渲染器会触发重渲染 → 从「无人能预览」变为正常挂载。
  const renderers = usePluginStore((s) => s.embedRenderers)
  const r = findEmbedRenderer(renderers, target)
  const hostRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    const el = hostRef.current
    if (!el || !r) return
    el.textContent = ''
    let cleanup: (() => void) | void
    try {
      // showSource:插件想在自己的 UI 里再开一个「看源码」入口时用(宿主已经在块右上角画了 `</>`)。
      const showSource = blockId ? () => useBlockSelection.getState().setActiveEmbed(blockId) : undefined
      cleanup = r.mount(el, { target, pagePath, showSource })
    } catch (e) {
      console.error('[amadeus] 插件嵌入块挂载失败', e)
    }
    return () => {
      try {
        cleanup?.()
      } catch {
        /* ignore */
      }
    }
  }, [r, target, pagePath, blockId])

  if (!r) return <div className="embed-missing">没有已启用的插件能预览「{target}」</div>
  return <div className="amx-plugin-embed" ref={hostRef} />
}
