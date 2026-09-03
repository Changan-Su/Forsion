// Built-in plugins — these ship with Amadeus and dogfood every contribution point
// (commands, slash items, themes). Users can disable them in Settings → 插件.
//
// i18n 口径(2026-09-03):
//  · 贡献点的**展示文案**(命令标题 / slash 标签与分组 / 主题名 / 面板标题 / notify 文案)走 translate()。
//    registerCommand / registerSlashItem / registerTheme 的契约字段是纯 `string`,既没有函数形态也没有
//    反注册口,所以它们在 **setup() 那一刻**定型(= 启用/冷启动时,读的是已持久化的语言),会中切语言不跟随;
//    run() 里的 notify 是回调,完全跟随。要让前者跟随得先给插件契约加更新口,那是 types.ts 的事。
//  · 插件 `name` **不翻**:它是 canonical 标识(默认工作文件夹由它派生,见 pluginStore.workFolder),
//    翻了等于给用户换数据目录。显示名/描述的语言解析走既有的 `nameEn` / `descriptionEn` 镜像字段
//    (display.ts 的 pluginDisplayName / pluginDisplayDescription,渲染期解析 = 切语言即时生效)。
//  · `keywords` 是模糊搜索别名(拼音+中英混排),按契约保持原样。

import { registerMessages, translate } from '../../i18n'
import type { AmadeusPlugin } from './types'
import { OutlinePanel } from './components/OutlinePanel'

registerMessages({
  'amadeusBuiltins.cmd.newPage': { zh: '新建页面', en: 'New page' },
  'amadeusBuiltins.cmd.search': { zh: '全文搜索', en: 'Full-text search' },
  'amadeusBuiltins.cmd.switch': { zh: '快速切换页面', en: 'Quick switch page' },
  'amadeusBuiltins.cmd.toggleMode': { zh: '切换深浅模式', en: 'Toggle light/dark mode' },
  'amadeusBuiltins.cmd.wordCount': { zh: '统计字数', en: 'Count words' },
  'amadeusBuiltins.wordCount.result': { zh: '本页约 {chars} 字 · {words} 词', en: 'About {chars} characters · {words} words on this page' },
  'amadeusBuiltins.panel.outline': { zh: '大纲', en: 'Outline' },
  'amadeusBuiltins.slash.group': { zh: '标注', en: 'Callouts' },
  'amadeusBuiltins.slash.note': { zh: '提示标注', en: 'Note callout' },
  'amadeusBuiltins.slash.info': { zh: '信息标注', en: 'Info callout' },
  'amadeusBuiltins.slash.warn': { zh: '警告标注', en: 'Warning callout' },
  'amadeusBuiltins.theme.slate': { zh: '石板', en: 'Slate' },
  'amadeusBuiltins.theme.crimson': { zh: '绯红', en: 'Crimson' },
})

export const coreCommands: AmadeusPlugin = {
  id: 'core-commands',
  name: '核心命令',
  nameEn: 'Core commands',
  version: '1.0.0',
  description: '在命令面板（⌘/Ctrl K）提供新建页面、搜索、快速切换、切换深浅模式。',
  descriptionEn: 'Adds new page, search, quick switch and light/dark toggle to the command palette (⌘/Ctrl K).',
  builtin: true,
  setup(ctx) {
    ctx.registerCommand({
      id: 'new-page',
      title: translate('amadeusBuiltins.cmd.newPage'),
      keywords: 'new page 新建 页面 xinjian',
      run: () => ctx.app.createPage(),
    })
    ctx.registerCommand({
      id: 'search',
      title: translate('amadeusBuiltins.cmd.search'),
      keywords: 'search find 搜索 quanwen',
      run: () => ctx.app.openSearch(),
    })
    ctx.registerCommand({
      id: 'switch',
      title: translate('amadeusBuiltins.cmd.switch'),
      keywords: 'switch goto 切换 跳转 kuaisu',
      run: () => ctx.app.openSwitcher(),
    })
    ctx.registerCommand({
      id: 'toggle-mode',
      title: translate('amadeusBuiltins.cmd.toggleMode'),
      keywords: 'theme dark light 深色 浅色 模式 moshi',
      run: () => ctx.app.toggleMode(),
    })
  },
}

export const wordCount: AmadeusPlugin = {
  id: 'word-count',
  name: '字数统计',
  nameEn: 'Word count',
  version: '1.0.0',
  description: '命令「统计字数」（字数 + 词数）。',
  descriptionEn: 'Adds a "Count words" command (characters + words).',
  builtin: true,
  setup(ctx) {
    // 状态栏实时字数已迁入桌面壳的全局状态栏内置项(statusbar/items.tsx 的 editor.wordCount,
    // 带编辑器视图 context 门控),此处不再注册 StatusItem,避免双份显示。
    ctx.registerCommand({
      id: 'count',
      title: translate('amadeusBuiltins.cmd.wordCount'),
      keywords: 'word count 字数 统计 zishu',
      run: () => {
        const text = ctx.app.getActivePageText().replace(/\s+/g, ' ').trim()
        const chars = text.replace(/\s/g, '').length
        const words = text ? text.split(/\s+/).length : 0
        ctx.app.notify(translate('amadeusBuiltins.wordCount.result', { chars, words }))
      },
    })
  },
}

export const outline: AmadeusPlugin = {
  id: 'outline',
  name: '大纲',
  nameEn: 'Outline',
  version: '1.0.0',
  description: '在侧栏显示当前页面的标题大纲，点击跳转。',
  descriptionEn: 'Shows a heading outline of the current page in the sidebar; click to jump.',
  builtin: true,
  setup(ctx) {
    ctx.registerPanel({ id: 'outline', title: translate('amadeusBuiltins.panel.outline'), component: OutlinePanel })
  },
}

export const calloutBlocks: AmadeusPlugin = {
  id: 'callout-blocks',
  name: 'Callout 标注',
  nameEn: 'Callouts',
  version: '1.0.0',
  description: '在 slash 菜单加入提示/信息/警告标注（Obsidian callout 语法，可被 Obsidian 渲染）。',
  descriptionEn: 'Adds note, info and warning callouts to the slash menu (Obsidian callout syntax, renders in Obsidian too).',
  builtin: true,
  setup(ctx) {
    // icon 一律写图标词表里的名字(不是 emoji):插件项和内置项在 slash 菜单里同一套 SVG。
    // 这三条也是新契约的样板 —— 外面照着写的人先看到的就是它们。
    ctx.registerSlashItem({
      id: 'callout-note',
      label: translate('amadeusBuiltins.slash.note'),
      icon: 'callout-note',
      group: translate('amadeusBuiltins.slash.group'),
      scaffold: '> [!note] ',
      keywords: 'callout note 提示 标注 biaozhu',
    })
    ctx.registerSlashItem({
      id: 'callout-info',
      label: translate('amadeusBuiltins.slash.info'),
      icon: 'callout-info',
      group: translate('amadeusBuiltins.slash.group'),
      scaffold: '> [!info] ',
      keywords: 'callout info 信息 xinxi',
    })
    ctx.registerSlashItem({
      id: 'callout-warn',
      label: translate('amadeusBuiltins.slash.warn'),
      icon: 'callout-warning',
      group: translate('amadeusBuiltins.slash.group'),
      scaffold: '> [!warning] ',
      keywords: 'callout warning 警告 jinggao',
    })
  },
}

export const extraThemes: AmadeusPlugin = {
  id: 'extra-themes',
  name: '主题扩展包',
  nameEn: 'Extra themes',
  version: '1.0.0',
  description: '额外强调色：石板、绯红。',
  descriptionEn: 'Extra accent colors: slate and crimson.',
  builtin: true,
  setup(ctx) {
    ctx.registerTheme({
      id: 'slate',
      label: translate('amadeusBuiltins.theme.slate'),
      swatch: '#94a3b8',
      css: `[data-theme='slate'][data-mode='light']{--primary:#475569;--primary-2:#0f766e;--on-primary:#ffffff}
[data-theme='slate'][data-mode='dark']{--primary:#94a3b8;--primary-2:#5eead4;--on-primary:#0b1220}`,
    })
    ctx.registerTheme({
      id: 'crimson',
      label: translate('amadeusBuiltins.theme.crimson'),
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
