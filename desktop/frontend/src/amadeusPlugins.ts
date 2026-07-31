/** 桌面壳的 Amadeus 插件装载(vendored pluginStore 保持与独立版同构,桌面差异全部收在这里):
 *  - 选择性安装 builtins:callout 标注 + 字数统计。跳过 core-commands(指向未挂载的 Amadeus 面板/与壳重复)、
 *    outline(壳有原生大纲视图)、extra-themes(其 [data-theme=…] 选择器在桌面 EditorScope 下永不命中)。
 *  - 插件贡献的 commands 桥进 engine 命令面板(全局可见,id 前缀 amadeus:)。
 *  - 插件 API 的 openSearch/openSwitcher(uiStore.palette)映射到桌面等价物,外部插件不改也能用。 */
import { usePluginStore } from '@amadeus/plugins/pluginStore'
import { calloutBlocks, wordCount } from '@amadeus/plugins/builtins'
import { usePageStore } from '@amadeus/store/pageStore'
import { useUiStore } from '@amadeus/store/uiStore'
import { useUiOverlay } from './amadeusOverlayStore'
import { addCommand, removeCommand } from '@lcl/engine'
import { openSearchView } from './amadeusCommands'
import { syncPluginViews } from './pluginViews'
import { installPluginStatusBridge } from './pluginStatusBridge'
import { nudgeOnboardingOnce } from './stores/pluginOnboardingStore'
import { installAmadeusAutomationBridge } from './amadeusAutomation'

let installed = false

export function installAmadeusPlugins(): void {
  if (installed) return
  installed = true
  syncPluginViews() // 插件视图桥先就位:随后的 init/loadExternal 里注册的视图第一时间进 LCL 注册表
  installPluginStatusBridge() // 状态条项桥同理(→ 全局状态栏)
  installAmadeusAutomationBridge() // Amadeus「按钮」块 → 本地引擎自动化(云端/移动端不注册=按钮显示不支持)
  const store = usePluginStore.getState()
  store.init([calloutBlocks, wordCount])
  void store.loadExternal().then(() => {
    // 捆绑包内嵌的 Space 引用插件自己的视图,必须等插件装完(视图已注册)才过得了 parseSpaceJson 的
    // isViewRegistered 闸 —— bootstrapEngine 那次 loadUserSpaces 跑在插件之前,注定被「未注册视图」跳过。
    // 补跑一次:装了带 Space 的插件,ribbon 顶部(Space 区)末尾即自动出现,无需进设置页或重启。
    // 动态 import:userSpaces → spaces.tsx 在模块顶层读 window,静态引会把它拖进 Composer2 的
    // node 环境单测(ReferenceError: window is not defined)。这里只在真装载完时才需要它。
    void import('./userSpaces').then((m) => m.loadUserSpaces())
    // 启动期自动激活的插件不弹就绪卡(不伏击),待引导的只投一次 Inbox 提醒;徽标常驻设置页。
    const s = usePluginStore.getState()
    for (const p of s.plugins) if (s.activeIds.includes(p.id)) nudgeOnboardingOnce(p)
  })

  // 插件 commands → engine 命令面板(**全局可见**,2026-07-18 放开——插件视图可装进任意 Space,
  // 「打开视图」类命令必须随处可用;量小,整批撤了重加即可。id 前缀 amadeus: 保持稳定,快捷键绑定不破)。
  let bridged: string[] = []
  const sync = (): void => {
    for (const id of bridged) removeCommand(id)
    bridged = []
    for (const o of usePluginStore.getState().commands) {
      const id = `amadeus:${o.pluginId}:${o.item.id}`
      bridged.push(id)
      addCommand({ id, title: o.item.title, keywords: o.item.keywords, run: o.item.run })
    }
  }
  sync()
  usePluginStore.subscribe((s, p) => { if (s.commands !== p.commands) sync() })

  // 插件 API 的两个 palette 动作 → 桌面等价物(快切浮层 / 左栏搜索 tab)。
  useUiStore.subscribe((s, p) => {
    if (!s.palette || s.palette === p.palette) return
    const pal = s.palette
    useUiStore.getState().setPalette(null)
    if (pal === 'switch') useUiOverlay.getState().open('switcher')
    else if (pal === 'search') openSearchView()
  })
}

let amadeusBooted = false
/** 幂等应用引导:装插件 + 恢复上次 Vault。Amadeus 编辑器 或 Calendar/ToDo 视图 任一先挂载都触发一次
 *  —— 修复「重启后直接进 Calendar Space,vault 从未恢复 → 日历/待办一直空白,须先进一次 Amadeus」。 */
export function ensureAmadeusReady(): void {
  if (amadeusBooted) return
  amadeusBooted = true
  installAmadeusPlugins()
  void usePageStore.getState().restoreVault()
}
