/** 白板引擎的文案 / 快捷键写法(走查续七 7.6)。引擎不导出 i18n,钩子是拷副本时插进去的
 *  (build/copy-excalidraw-assets.cjs 的 TEXT_PATCHES):引擎查文案、格式化快捷键之前先问这里,
 *  这里不答(undefined)就走引擎原路。**必须在引擎脚本执行前装好**(forkRuntime 顶上 import):
 *  引擎有几张快捷键表是模块初始化时就格式化好的。 */

import { registerMessages, translateFor } from '../../../i18n'

// 与快捷键表(ShortcutsDialog)共用这几条。
registerMessages({
  'boardkeys.copy': { zh: '复制', en: 'Copy' },
  'boardkeys.duplicate': { zh: '创建副本', en: 'Duplicate' },
  'boardkeys.copyStyles': { zh: '复制样式', en: 'Copy styles' },
  'boardkeys.stylesCopied': { zh: '样式已复制。', en: 'Copied styles.' },
})

const IS_MAC = /Mac/.test(navigator.userAgent) && !('ontouchend' in document)

/** 「复制」在图像工作室是 copy、「创建副本」是 duplicate;引擎中文包里这两个是「拷贝 / 复制」,正好反着。
 *  只改简体中文包(英文包本来就是 Copy / Duplicate),译文取应用词典的中文那份。 */
const LABELS: Record<string, string> = {
  'labels.copy': 'boardkeys.copy',
  'labels.duplicateSelection': 'boardkeys.duplicate',
  'labels.copyStyles': 'boardkeys.copyStyles',
  'toast.copyStyles': 'boardkeys.stylesCopied',
}

const MODS: Record<string, string> = { ctrl: '⌘', cmd: '⌘', command: '⌘', ctrlorcmd: '⌘', mod: '⌘', alt: '⌥', opt: '⌥', option: '⌥', shift: '⇧' }
const MOD_ORDER = ['⌃', '⌥', '⇧', '⌘']
const KEYS: Record<string, string> = { delete: '⌫', del: '⌫', enter: '↩', return: '↩', escape: 'Esc', esc: 'Esc' }

/** mac 写法:修饰键按系统顺序 ⌃⌥⇧⌘ 连写在前,后面接键(`CtrlOrCmd+Shift+E` → `⇧⌘E`,`CtrlOrCmd++` → `⌘+`)。
 *  其余平台原样(Mod 换成 Ctrl)。 */
export function formatShortcut(spec: string, mac = IS_MAC): string {
  const parts = spec.endsWith('++') ? [...spec.slice(0, -2).split('+'), '+'] : spec.split('+')
  if (!mac) return parts.map((p) => (/^(mod|ctrlorcmd)$/i.test(p) ? 'Ctrl' : p)).join('+')
  const mods: string[] = []
  const rest: string[] = []
  for (const p of parts) {
    const m = MODS[p.trim().toLowerCase()]
    if (m) mods.push(m)
    else rest.push(KEYS[p.trim().toLowerCase()] ?? p)
  }
  mods.sort((a, b) => MOD_ORDER.indexOf(a) - MOD_ORDER.indexOf(b))
  const key = rest.join('+')
  // 键是个词(「拖动」「Arrow Key」)时和符号之间空一格,单字符键直接连写。
  return mods.join('') + (mods.length && [...key].length > 1 && !/^[⌫↩]$/.test(key) ? ' ' : '') + key
}

declare global {
  // eslint-disable-next-line no-var
  var __forsionBoardText: { label(key: string, lang: string): string | undefined; shortcut(spec: string): string | undefined } | undefined
}

globalThis.__forsionBoardText = {
  label: (key, lang) => (lang === 'zh-CN' && LABELS[key] ? translateFor('zh', LABELS[key]) : undefined),
  // 钩子在引擎 gA 最开头:拿到的是原始写法(`CtrlOrCmd+Shift+E`),还没换成语言包里的 Cmd / Option。
  shortcut: (spec) => (IS_MAC ? formatShortcut(spec) : undefined),
}
