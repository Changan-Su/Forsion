/**
 * 设置 → 快捷键 的「这个组合在哪被用着」:命令层由 ShortcutsTab 自己比(它手里有行和覆盖),
 * 这里管另外两层 —— 笔记编辑器正文里会先吃掉的键(只提示,能绑)和系统 / 应用菜单保留的键(拦下,不能绑)。
 * 方案:docs/ToBeImproved/快捷键录入与冲突方案_2026-10-17(选 A)。
 *
 * 两张表都是静态的、存 i18n key(渲染期再 t()):
 *  - 编辑器层取自 Milkdown commonmark / gfm 预设的 keymap + unified/blockLayer 的 Mod-d;
 *    编辑器 keymap 改了这里不会自动跟,漏一条只是少一句提示,不影响分发。
 *  - 系统层:eventToHotkey 把 ⌘ 和 Ctrl 都记成 'mod'(Windows 的 Win 键也是),所以只收「带 mod 也不会认错」的那几个。
 *    复制 / 粘贴 / 剪切 / 全选 / 撤销 / 重做也算保留:全局命令会 preventDefault,绑上去所有输入框都没法复制粘贴。
 *    急停那个可改的全局键不在表里(它由设置 → 远程安全自己管)。
 */

const MODS = ['mod', 'shift', 'alt'] as const

/** 'shift+mod+k' / 'Mod+K' → 'mod+shift+k'(修饰键排成 eventToHotkey 的顺序)。左右修饰键同按('mod+mod')原样。 */
export function normalizeHotkey(hk: string): string {
  const parts = hk.toLowerCase().split('+').map((p) => p.trim()).filter(Boolean)
  if (parts.length === 2 && parts[0] === parts[1]) return parts.join('+')
  const key = parts.filter((p) => !(MODS as readonly string[]).includes(p))
  return [...MODS.filter((m) => parts.includes(m)), ...key].join('+')
}

/** 光标在笔记正文里时编辑器先处理的键 → 动作的 i18n key。 */
const EDITOR: Record<string, string> = {
  'mod+b': 'settings.shortcuts.editor.bold',
  'mod+i': 'settings.shortcuts.editor.italic',
  'mod+e': 'settings.shortcuts.editor.inlineCode',
  'mod+shift+b': 'settings.shortcuts.editor.quote',
  'mod+alt+c': 'settings.shortcuts.editor.codeBlock',
  'mod+alt+x': 'settings.shortcuts.editor.strike',
  'mod+d': 'settings.shortcuts.editor.duplicateBlock',
  ...Object.fromEntries(['0', '1', '2', '3', '4', '5', '6'].map((n) => [`mod+alt+${n}`, 'settings.shortcuts.editor.heading'])),
  'mod+alt+7': 'settings.shortcuts.editor.list',
  'mod+alt+8': 'settings.shortcuts.editor.list',
}

/** 编辑操作 + 主进程写死注册的全局快捷键(electron/main.ts 的 Mini 窗口)。全局键在任何窗口都先被主进程拿走,绑给命令永远不会触发。 */
const EDIT_RESERVED: Record<string, string> = {
  'mod+shift+m': 'settings.shortcuts.system.miniWindow',
  'mod+c': 'settings.shortcuts.system.copy',
  'mod+v': 'settings.shortcuts.system.paste',
  'mod+x': 'settings.shortcuts.system.cut',
  'mod+a': 'settings.shortcuts.system.selectAll',
  'mod+z': 'settings.shortcuts.system.undo',
  'mod+shift+z': 'settings.shortcuts.system.redo',
}

const SYSTEM_MAC: Record<string, string> = {
  ...EDIT_RESERVED,
  'mod+q': 'settings.shortcuts.system.quit',
  'mod+h': 'settings.shortcuts.system.hide',
  'mod+m': 'settings.shortcuts.system.minimize',
  'mod+tab': 'settings.shortcuts.system.switchApp',
  'mod+space': 'settings.shortcuts.system.spotlight',
  'mod+alt+escape': 'settings.shortcuts.system.forceQuit',
  'mod+shift+3': 'settings.shortcuts.system.screenshot',
  'mod+shift+4': 'settings.shortcuts.system.screenshot',
  'mod+shift+5': 'settings.shortcuts.system.screenshot',
}

const SYSTEM_OTHER: Record<string, string> = {
  ...EDIT_RESERVED,
  'mod+y': 'settings.shortcuts.system.redo',
  'alt+f4': 'settings.shortcuts.system.closeWindow',
  'alt+tab': 'settings.shortcuts.system.switchApp',
  'mod+escape': 'settings.shortcuts.system.startMenu',
  'mod+shift+escape': 'settings.shortcuts.system.taskManager',
  'mod+alt+delete': 'settings.shortcuts.system.securityOptions',
}

/** 编辑器正文里这个键做什么(i18n key);不占用 → null。 */
export function editorUseOf(hk: string): string | null {
  return EDITOR[normalizeHotkey(hk)] ?? null
}

/** 系统 / 应用菜单保留的键做什么(i18n key);不保留 → null。 */
export function systemReservedOf(hk: string, mac: boolean): string | null {
  return (mac ? SYSTEM_MAC : SYSTEM_OTHER)[normalizeHotkey(hk)] ?? null
}

/** 生效热键相同的行分组:只留 ≥2 行的组(= 冲突)。key 是规范化后的热键。 */
export function conflictGroups<R>(rows: readonly R[], hotkeyOf: (r: R) => string): Map<string, R[]> {
  const byKey = new Map<string, R[]>()
  for (const r of rows) {
    const hk = hotkeyOf(r)
    if (!hk) continue
    const k = normalizeHotkey(hk)
    byKey.set(k, [...(byKey.get(k) ?? []), r])
  }
  for (const [k, list] of byKey) if (list.length < 2) byKey.delete(k)
  return byKey
}
