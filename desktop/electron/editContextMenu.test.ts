import { describe, expect, it, vi } from 'vitest'

// 导入即自挂 web-contents-created(main.ts 一行接入):这里接住那个监听,验「只挂应用窗口」。
const { listeners } = vi.hoisted(() => ({ listeners: [] as Array<(e: unknown, contents: unknown) => void> }))
vi.mock('electron', () => ({
  app: { on: (ev: string, fn: (e: unknown, c: unknown) => void) => { if (ev === 'web-contents-created') listeners.push(fn) }, getPreferredSystemLanguages: () => ['zh-CN'] },
  BrowserWindow: { fromWebContents: () => null },
  Menu: { buildFromTemplate: (t: unknown) => ({ popup: vi.fn(), template: t }) },
  Tray: class {}, nativeImage: { createFromPath: () => ({ isEmpty: () => true }) },
}))

import { buildEditMenuTemplate, type EditMenuActions } from './editContextMenu'

const flags = { canUndo: true, canRedo: true, canCut: true, canCopy: true, canPaste: true, canDelete: true, canSelectAll: true, canEditRichly: true }
const params = (over: Partial<Parameters<typeof buildEditMenuTemplate>[0]> = {}) =>
  ({ isEditable: true, selectionText: '', misspelledWord: '', dictionarySuggestions: [], editFlags: flags, ...over })
const acts = (): EditMenuActions => ({ replaceMisspelling: vi.fn(), addToDictionary: vi.fn(), lookUp: vi.fn() })
const labels = (t: Electron.MenuItemConstructorOptions[] | null) => (t ?? []).filter((i) => i.type !== 'separator').map((i) => i.label)

describe('编辑区系统右键菜单(G4-08 / B-09)', () => {
  it('可编辑处:剪切 / 复制 / 粘贴 / 全选,文案跟界面语言走(不用 role 自带的英文)', () => {
    expect(labels(buildEditMenuTemplate(params(), 'zh', acts(), 'darwin'))).toEqual(['剪切', '复制', '粘贴', '全选'])
    expect(labels(buildEditMenuTemplate(params(), 'en', acts(), 'darwin'))).toEqual(['Cut', 'Copy', 'Paste', 'Select all'])
    const t = buildEditMenuTemplate(params({ editFlags: { ...flags, canCut: false, canCopy: false } }), 'zh', acts(), 'win32')!
    expect(t.find((i) => i.role === 'cut')?.enabled).toBe(false)
    expect(t.find((i) => i.role === 'paste')?.enabled).toBe(true)
  })

  it('拼写:标红的词上右键给建议(点了原地替换)与「添加到词典」;没有建议时给一条灰的提示', () => {
    const a = acts()
    const t = buildEditMenuTemplate(params({ misspelledWord: 'quikc', dictionarySuggestions: ['quick', 'quirk'] }), 'zh', a, 'win32')!
    expect(labels(t).slice(0, 3)).toEqual(['quick', 'quirk', '添加到词典'])
    t[0].click?.({} as never, undefined, {} as never)
    t[2].click?.({} as never, undefined, {} as never)
    expect(a.replaceMisspelling).toHaveBeenCalledWith('quick')
    expect(a.addToDictionary).toHaveBeenCalledWith('quikc')
    const none = buildEditMenuTemplate(params({ misspelledWord: 'zzqx', dictionarySuggestions: [] }), 'en', acts(), 'win32')!
    expect(none[0]).toMatchObject({ label: 'No spelling suggestions', enabled: false })
  })

  it('查询:只在 macOS、有短选区时出现', () => {
    const a = acts()
    const mac = buildEditMenuTemplate(params({ selectionText: ' serendipity ' }), 'zh', a, 'darwin')!
    expect(labels(mac)[0]).toBe('查询「serendipity」')
    mac[0].click?.({} as never, undefined, {} as never)
    expect(a.lookUp).toHaveBeenCalled()
    expect(labels(buildEditMenuTemplate(params({ selectionText: 'serendipity' }), 'zh', acts(), 'win32'))).not.toContain('查询「serendipity」')
    expect(labels(buildEditMenuTemplate(params({ selectionText: 'a\nlong\nparagraph' }), 'zh', acts(), 'darwin'))[0]).toBe('剪切')
  })

  it('不可编辑处:有选中文字只给「复制」,没有选中(空白 / 按钮)不出菜单', () => {
    expect(labels(buildEditMenuTemplate(params({ isEditable: false, selectionText: '一段话' }), 'zh', acts(), 'win32'))).toEqual(['复制'])
    expect(buildEditMenuTemplate(params({ isEditable: false, selectionText: '  ' }), 'zh', acts(), 'darwin')).toBeNull()
  })

  it('只挂应用自己的窗口:内置浏览器 <webview> 等第三方页面不挂', () => {
    expect(listeners.length).toBe(1)
    const on = vi.fn()
    listeners[0]({}, { getType: () => 'webview', on })
    expect(on).not.toHaveBeenCalled()
    listeners[0]({}, { getType: () => 'window', on })
    expect(on).toHaveBeenCalledWith('context-menu', expect.any(Function))
  })
})
