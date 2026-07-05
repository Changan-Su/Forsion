/** 桌面壳的 Amadeus 插件装载(vendored pluginStore 保持与独立版同构,桌面差异全部收在这里):
 *  - 选择性安装 builtins:callout 标注 + 字数统计。跳过 core-commands(指向未挂载的 Amadeus 面板/与壳重复)、
 *    outline(壳有原生大纲视图)、extra-themes(其 [data-theme=…] 选择器在桌面 EditorScope 下永不命中)。
 *  - vault 切换 → 重载外部插件(.amadeus/plugins/,镜像独立版 App.tsx 的行为)。
 *  - 插件贡献的 commands 桥进 engine 命令面板(仅 Amadeus Space 激活时可见,id 前缀 amadeus:)。
 *  - 插件 API 的 openSearch/openSwitcher(uiStore.palette)映射到桌面等价物,外部插件不改也能用。 */
import { usePluginStore } from '@amadeus/plugins/pluginStore'
import { calloutBlocks, wordCount } from '@amadeus/plugins/builtins'
import { usePageStore } from '@amadeus/store/pageStore'
import { useUiStore } from '@amadeus/store/uiStore'
import { useUiOverlay } from './amadeusOverlayStore'
import { addCommand, removeCommand, useSpaceStore } from '@lcl/engine'
import { openSearchView } from './amadeusCommands'

let installed = false

export function installAmadeusPlugins(): void {
  if (installed) return
  installed = true
  const store = usePluginStore.getState()
  store.init([calloutBlocks, wordCount])
  void store.loadExternal()

  // vault 切换 → 外部插件重载。
  usePageStore.subscribe((s, p) => {
    if (s.vaultRoot && s.vaultRoot !== p.vaultRoot) void usePluginStore.getState().reloadExternal()
  })

  // 插件 commands → engine 命令面板(只在 Amadeus Space 内挂着;量小,整批撤了重加即可)。
  let bridged: string[] = []
  const sync = (): void => {
    for (const id of bridged) removeCommand(id)
    bridged = []
    if (useSpaceStore.getState().activeSpaceId !== 'amadeus') return
    for (const o of usePluginStore.getState().commands) {
      const id = `amadeus:${o.pluginId}:${o.item.id}`
      bridged.push(id)
      addCommand({ id, title: o.item.title, keywords: o.item.keywords, run: o.item.run })
    }
  }
  sync()
  usePluginStore.subscribe((s, p) => { if (s.commands !== p.commands) sync() })
  useSpaceStore.subscribe((s, p) => { if (s.activeSpaceId !== p.activeSpaceId) sync() })

  // 插件 API 的两个 palette 动作 → 桌面等价物(快切浮层 / 左栏搜索 tab)。
  useUiStore.subscribe((s, p) => {
    if (!s.palette || s.palette === p.palette) return
    const pal = s.palette
    useUiStore.getState().setPalette(null)
    if (pal === 'switch') useUiOverlay.getState().open('switcher')
    else if (pal === 'search') openSearchView()
  })
}
