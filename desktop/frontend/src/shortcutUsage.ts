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

/** 插件命令 `hotkey` 声明 → 规范形(2026-11-16+);不合格 → ''。必须带 mod、恰好一个主键:热键分发没有输入焦点闸,
 *  裸键 / 只带 Shift 会在打字时触发;只带 Alt 在 mac 上是 ⌥ 出特殊字符(⌥E 打重音),同样会抢走打字。左右修饰键同按不收。 */
export function pluginDefaultHotkey(raw: unknown): string {
  if (typeof raw !== 'string' || raw.length > 64) return ''
  const hk = normalizeHotkey(raw)
  const parts = hk.split('+')
  const keys = parts.filter((p) => !(MODS as readonly string[]).includes(p))
  if (keys.length !== 1 || !parts.includes('mod')) return ''
  return canFire(keys[0], parts.includes('shift')) ? hk : ''
}

/** 热键分发按 e.key 认主键:带 Shift 时数字 / 标点给的是上档字符(⇧1 是 '!'),`space` 对不上 e.key 的 ' ' ——
 *  这些写进默认键永远按不出来,设置页却显示「已生效」,干脆不收。字母、具名键、[ ](分发里有别名)不受 Shift 影响。 */
const NAMED_KEYS = /^(arrow(up|down|left|right)|f([1-9]|1[0-9]|2[0-4])|enter|escape|tab|backspace|delete|insert|home|end|pageup|pagedown)$/
function canFire(key: string, shift: boolean): boolean {
  if (/^[a-z]$/.test(key) || NAMED_KEYS.test(key) || key === '[' || key === ']') return true
  return !shift && /^([0-9]|[-=\\;',./`])$/.test(key)
}

/** 插件默认键为什么没生效:撞上某条命令(id;命令面板伪命令是 'command-palette'),或撞上系统 / 编辑器那两层(i18n key)。 */
export type PluginHotkeyConflict = { kind: 'command'; id: string } | { kind: 'layer'; key: string }
export interface PluginHotkeyState { hotkey: string; active: boolean; conflict?: PluginHotkeyConflict }

/**
 * 插件命令默认键的生效判定(2026-11-16 用户定)。用户给这条命令设过键(含解绑)→ 用户的赢,那是 effectiveHotkey 的事,
 * 这里不管。否则默认键只在**没有任何别的东西用着这个键**时生效,撞上了就不生效(设置 → 快捷键里列成「未设置」+ 一行说明):
 *  ① 系统 / 应用菜单保留的键,以及笔记编辑器正文里会先吃掉的键 —— 用户自己能绑编辑器键(只给提示),插件默认不行:
 *    同一个键在编辑器里是加粗、出了编辑器是某个插件命令,用户没选过这件事;
 *  ② 任一非插件命令(内置命令、命令面板)的生效键 —— 包括用户给它们设的键;
 *  ③ 任一别的插件命令:它有用户设的键就看那个键,没有就看它声明的默认键(不管它自己生没生效)。两个插件默认同一个键 →
 *    两个都不生效,谁先装载都一样(不按加载顺序定胜负,不然每次启动可能换人)。
 * 键一空出来(用户把冲突那条改了 / 插件卸了)下一次判定就自动生效。
 * `plugins` = 全部插件命令(id 已带 amadeus: 前缀;没声明默认键的传 ''),`others` = 其余命令的生效键(已含用户覆盖)。
 */
export function resolvePluginHotkeys(
  plugins: ReadonlyArray<{ id: string; hotkey: string }>,
  others: ReadonlyArray<{ id: string; hotkey: string }>,
  overrides: Readonly<Record<string, string>>,
  mac: boolean,
): Map<string, PluginHotkeyState> {
  const overridden = (id: string): boolean => Object.prototype.hasOwnProperty.call(overrides, id)
  const used = new Map<string, string>()
  for (const o of others) {
    if (!o.hotkey) continue
    const k = normalizeHotkey(o.hotkey)
    if (!used.has(k)) used.set(k, o.id)
  }
  const claimOf = (p: { id: string; hotkey: string }): string => (overridden(p.id) ? normalizeHotkey(overrides[p.id] || '') : p.hotkey)
  const out = new Map<string, PluginHotkeyState>()
  for (const p of plugins) {
    if (!p.hotkey) continue
    const k = p.hotkey
    const layer = systemReservedOf(k, mac) ?? editorUseOf(k)
    const cmd = used.get(k) ?? plugins.find((q) => q.id !== p.id && claimOf(q) === k)?.id
    const conflict: PluginHotkeyConflict | undefined = layer ? { kind: 'layer', key: layer } : cmd ? { kind: 'command', id: cmd } : undefined
    out.set(p.id, conflict ? { hotkey: k, active: false, conflict } : { hotkey: k, active: true })
  }
  return out
}
