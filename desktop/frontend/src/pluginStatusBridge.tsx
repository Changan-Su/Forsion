/** 插件状态条项 → engine 全局状态栏桥(与 pluginViews 的视图桥同款结构):
 *  - id 命名空间 plugin:<pluginId>:<id>(防跨插件顶替;设置「通知与状态栏」按此 id 隐藏/排序)
 *  - 外置插件的数据驱动形态({text,title,onClick})在此合成组件:订阅 store,handle.update 改文案即重渲
 *  - 成员集变化才 add/remove(文案更新只换数组引用不动成员,循环自然 no-op);禁用插件切片清空即摘除 */
import { addStatusItem, removeStatusItem } from '@lcl/engine'
import { usePluginStore } from '@amadeus/plugins/pluginStore'

function PluginStatusText({ pluginId, itemId }: { pluginId: string; itemId: string }) {
  const owned = usePluginStore((s) => s.statusItems.find((o) => o.pluginId === pluginId && o.item.id === itemId))
  if (!owned) return null
  const it = owned.item
  return (
    <span className={it.onClick ? 'sb-click' : 'sb-plain'} title={it.title} onClick={it.onClick}>
      {it.text ?? ''}
    </span>
  )
}

let installed = false
export function installPluginStatusBridge(): void {
  if (installed) return
  installed = true
  // id → 注册时的指纹(component 引用 + side)。handle.update 只动 text/title(指纹不变,靠组件
  // 订阅自然重渲);同 id **重新注册**换了 component/side 时指纹变 → 摘掉重挂,engine 侧才跟上。
  const bridged = new Map<string, { component: unknown; side: 'left' | 'right' }>()
  const sync = (): void => {
    const items = usePluginStore.getState().statusItems
    const want = new Map<string, (typeof items)[number]>(items.map((o) => [`plugin:${o.pluginId}:${o.item.id}`, o]))
    for (const id of bridged.keys()) {
      if (!want.has(id)) {
        removeStatusItem(id)
        bridged.delete(id)
      }
    }
    for (const [id, o] of want) {
      const sig = { component: o.item.component as unknown, side: o.item.side ?? ('right' as const) }
      const prev = bridged.get(id)
      if (prev && (prev.component !== sig.component || prev.side !== sig.side)) {
        removeStatusItem(id)
        bridged.delete(id)
      }
      if (bridged.has(id)) continue
      bridged.set(id, sig)
      const C = o.item.component
      addStatusItem({
        id,
        side: sig.side,
        component: C ?? (() => <PluginStatusText pluginId={o.pluginId} itemId={o.item.id} />),
      })
    }
  }
  sync()
  usePluginStore.subscribe((s, p) => {
    if (s.statusItems !== p.statusItems) sync()
  })
}
