// Built-in plugins — these ship with Amadeus and dogfood every contribution point
// (commands, slash items, themes). Users can disable them in Settings → 插件.

import type { AmadeusPlugin } from './types'
import { OutlinePanel } from './components/OutlinePanel'

export const coreCommands: AmadeusPlugin = {
  id: 'core-commands',
  name: '核心命令',
  version: '1.0.0',
  description: '在命令面板（⌘/Ctrl K）提供新建页面、搜索、快速切换、切换深浅模式。',
  builtin: true,
  setup(ctx) {
    ctx.registerCommand({
      id: 'new-page',
      title: '新建页面',
      keywords: 'new page 新建 页面 xinjian',
      run: () => ctx.app.createPage(),
    })
    ctx.registerCommand({
      id: 'search',
      title: '全文搜索',
      keywords: 'search find 搜索 quanwen',
      run: () => ctx.app.openSearch(),
    })
    ctx.registerCommand({
      id: 'switch',
      title: '快速切换页面',
      keywords: 'switch goto 切换 跳转 kuaisu',
      run: () => ctx.app.openSwitcher(),
    })
    ctx.registerCommand({
      id: 'toggle-mode',
      title: '切换深浅模式',
      keywords: 'theme dark light 深色 浅色 模式 moshi',
      run: () => ctx.app.toggleMode(),
    })
  },
}

export const wordCount: AmadeusPlugin = {
  id: 'word-count',
  name: '字数统计',
  version: '1.0.0',
  description: '命令「统计字数」（字数 + 词数）。',
  builtin: true,
  setup(ctx) {
    // 状态栏实时字数已迁入桌面壳的全局状态栏内置项(statusbar/items.tsx 的 editor.wordCount,
    // 带编辑器视图 context 门控),此处不再注册 StatusItem,避免双份显示。
    ctx.registerCommand({
      id: 'count',
      title: '统计字数',
      keywords: 'word count 字数 统计 zishu',
      run: () => {
        const text = ctx.app.getActivePageText().replace(/\s+/g, ' ').trim()
        const chars = text.replace(/\s/g, '').length
        const words = text ? text.split(/\s+/).length : 0
        ctx.app.notify(`本页约 ${chars} 字 · ${words} 词`)
      },
    })
  },
}

export const outline: AmadeusPlugin = {
  id: 'outline',
  name: '大纲',
  version: '1.0.0',
  description: '在侧栏显示当前页面的标题大纲，点击跳转。',
  builtin: true,
  setup(ctx) {
    ctx.registerPanel({ id: 'outline', title: '大纲', component: OutlinePanel })
  },
}

export const calloutBlocks: AmadeusPlugin = {
  id: 'callout-blocks',
  name: 'Callout 标注',
  version: '1.0.0',
  description: '在 slash 菜单加入提示/信息/警告标注（Obsidian callout 语法，可被 Obsidian 渲染）。',
  builtin: true,
  setup(ctx) {
    // icon 一律写图标词表里的名字(不是 emoji):插件项和内置项在 slash 菜单里同一套 SVG。
    // 这三条也是新契约的样板 —— 外面照着写的人先看到的就是它们。
    ctx.registerSlashItem({
      id: 'callout-note',
      label: '提示标注',
      icon: 'callout-note',
      group: '标注',
      scaffold: '> [!note] ',
      keywords: 'callout note 提示 标注 biaozhu',
    })
    ctx.registerSlashItem({
      id: 'callout-info',
      label: '信息标注',
      icon: 'callout-info',
      group: '标注',
      scaffold: '> [!info] ',
      keywords: 'callout info 信息 xinxi',
    })
    ctx.registerSlashItem({
      id: 'callout-warn',
      label: '警告标注',
      icon: 'callout-warning',
      group: '标注',
      scaffold: '> [!warning] ',
      keywords: 'callout warning 警告 jinggao',
    })
  },
}

export const extraThemes: AmadeusPlugin = {
  id: 'extra-themes',
  name: '主题扩展包',
  version: '1.0.0',
  description: '额外强调色：石板、绯红。',
  builtin: true,
  setup(ctx) {
    ctx.registerTheme({
      id: 'slate',
      label: '石板',
      swatch: '#94a3b8',
      css: `[data-theme='slate'][data-mode='light']{--primary:#475569;--primary-2:#0f766e;--on-primary:#ffffff}
[data-theme='slate'][data-mode='dark']{--primary:#94a3b8;--primary-2:#5eead4;--on-primary:#0b1220}`,
    })
    ctx.registerTheme({
      id: 'crimson',
      label: '绯红',
      swatch: '#f43f5e',
      css: `[data-theme='crimson'][data-mode='light']{--primary:#be123c;--primary-2:#9f1239;--on-primary:#ffffff}
[data-theme='crimson'][data-mode='dark']{--primary:#fb7185;--primary-2:#f43f5e;--on-primary:#3b0a18}`,
    })
  },
}

export const BUILTIN_PLUGINS: AmadeusPlugin[] = [
  coreCommands,
  wordCount,
  outline,
  calloutBlocks,
  extraThemes,
]
