/**
 * 编辑区的系统右键菜单(评审 G4-08 / B-09):剪切 / 复制 / 粘贴 / 全选 + 拼写建议 / 加入词典 + 查询(macOS)。
 *
 * 为什么要主进程出:Electron 的窗口**没有**缺省右键菜单 —— 渲染层不 preventDefault 的 contextmenu 会变成
 * webContents 的 `context-menu` 事件,没人接就什么都不出(评审附录 A:「放行原生菜单」在 Electron 里什么都不会出)。
 * 笔记正文、标题框、源码模式、聊天输入框右键一片空白,拼写检查标了红线却没有地方改(G4-07 的更正出口)。
 *
 * 口径:
 *  - 只挂应用自己的窗口(`getType() === 'window'`):内置浏览器 `<webview>` 装的是第三方网页,不给它们塞菜单;
 *  - 只在**可编辑处**或**有选中文字**时出菜单;空白处 / 按钮上右键照旧什么都不出(否则全应用每一块都长出菜单);
 *  - 渲染层自己接管的右键(⠿ 块菜单、侧栏树、标签条……)已 preventDefault,根本到不了这里 —— 两边不打架;
 *  - 文案随界面语言(与托盘同一个判定 trayLang:渲染层手选 / IP 校正优先,否则系统首选语言);不用 role 自带的
 *    label(那是英文)。「粘贴为纯文本」走键盘 Mod+Shift+V(编辑器侧接管,见 MarkdownBlock),菜单不另放一份。
 *
 * main.ts 只 `import './editContextMenu'` 一行接入(导入即自挂 web-contents-created),本文件自成一体便于在途分支 rebase。
 */
import { app, BrowserWindow, Menu, type ContextMenuParams, type MenuItemConstructorOptions } from 'electron'
import { trayLang, type TrayLang } from './tray'

const COPY = {
  zh: {
    cut: '剪切', copy: '复制', paste: '粘贴', selectAll: '全选',
    noSuggestions: '没有拼写建议', addToDictionary: '添加到词典', lookUp: '查询「{word}」',
  },
  en: {
    cut: 'Cut', copy: 'Copy', paste: 'Paste', selectAll: 'Select all',
    noSuggestions: 'No spelling suggestions', addToDictionary: 'Add to dictionary', lookUp: 'Look up “{word}”',
  },
} as const

export interface EditMenuActions {
  replaceMisspelling: (word: string) => void
  addToDictionary: (word: string) => void
  lookUp: () => void
}

type MenuParams = Pick<ContextMenuParams, 'isEditable' | 'selectionText' | 'misspelledWord' | 'dictionarySuggestions' | 'editFlags'>

/** 查询项的词:选中文字去首尾空白,过长就不给(系统词典只查词 / 短语,整段选区弹出来没有意义)。 */
function lookUpWord(sel: string): string | null {
  const w = sel.trim()
  return w && w.length <= 40 && !w.includes('\n') ? w : null
}

/** 纯函数:菜单模板(单测直接断言)。null = 这次右键不出菜单。 */
export function buildEditMenuTemplate(params: MenuParams, lang: TrayLang, actions: EditMenuActions, platform: NodeJS.Platform = process.platform): MenuItemConstructorOptions[] | null {
  const hasSelection = params.selectionText.trim().length > 0
  if (!params.isEditable && !hasSelection) return null
  const c = COPY[lang]
  const items: MenuItemConstructorOptions[] = []
  // 拼写建议(只在可编辑处、右键落在被标红的词上):最多 5 条,点了原地替换;另给「添加到词典」。
  if (params.isEditable && params.misspelledWord) {
    const word = params.misspelledWord
    const sugg = params.dictionarySuggestions.slice(0, 5)
    if (sugg.length) for (const s of sugg) items.push({ label: s, click: () => actions.replaceMisspelling(s) })
    else items.push({ label: c.noSuggestions, enabled: false })
    items.push({ label: c.addToDictionary, click: () => actions.addToDictionary(word) })
    items.push({ type: 'separator' })
  }
  // 查询(macOS 系统词典 / 查询面板,与原生应用同位置)。
  const word = platform === 'darwin' && hasSelection ? lookUpWord(params.selectionText) : null
  if (word) {
    items.push({ label: c.lookUp.replace('{word}', word.length > 20 ? `${word.slice(0, 19)}…` : word), click: () => actions.lookUp() })
    items.push({ type: 'separator' })
  }
  const f = params.editFlags
  if (params.isEditable) {
    items.push({ role: 'cut', label: c.cut, enabled: f.canCut })
    items.push({ role: 'copy', label: c.copy, enabled: f.canCopy })
    items.push({ role: 'paste', label: c.paste, enabled: f.canPaste })
    items.push({ type: 'separator' })
    items.push({ role: 'selectAll', label: c.selectAll, enabled: f.canSelectAll })
  } else {
    items.push({ role: 'copy', label: c.copy, enabled: f.canCopy })
  }
  return items
}

/** 给之后创建的每个应用窗口挂上编辑区右键菜单(导入本模块即执行一次)。 */
export function installEditContextMenu(): void {
  app.on('web-contents-created', (_e, contents) => {
    if (contents.getType() !== 'window') return
    contents.on('context-menu', (_ev, params) => {
      const template = buildEditMenuTemplate(params, trayLang(), {
        replaceMisspelling: (w) => contents.replaceMisspelling(w),
        addToDictionary: (w) => contents.session.addWordToSpellCheckerDictionary(w),
        lookUp: () => contents.showDefinitionForSelection(),
      })
      if (!template) return
      Menu.buildFromTemplate(template).popup({ window: BrowserWindow.fromWebContents(contents) ?? undefined })
    })
  })
}

installEditContextMenu()
