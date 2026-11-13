// 调色板(参考 AFFiNE 命名色;十六进制,后续可换 LCL token)。'' = 清除该颜色。
// 色板的色相沿用 AFFiNE **v1** 编辑器(--affine-text-highlight-*),但文字色为 Genesis 的
// 浅色纸面略微压暗到 AA;否则橙/黄/绿/青/灰会在某些 skin 下掉到 3–4:1。品红/粉为产品扩展。
// 落盘存字面亮色 hex(Obsidian 可渲染);暗色由 marks.ts 的 data-hl/data-hlc 语义名 + styles.css
// 覆盖切换 —— 改这里的值必须同步 marks.ts 的 HL_BG_NAMES/HL_FG_NAMES 与 styles.css 暗色段。
// ⚠️ `nameKey` / `labelKey` 存的是 i18n 键,不是文案 —— 模块作用域求值会把文案冻死在加载语言上。
export const TEXT_COLORS: Array<{ nameKey: string; v: string }> = [
  { nameKey: 'itb.color.default', v: '' },
  { nameKey: 'itb.color.red', v: '#c62222' },
  { nameKey: 'itb.color.orange', v: '#b9450a' },
  { nameKey: 'itb.color.yellow', v: '#8f6203' },
  { nameKey: 'itb.color.green', v: '#117b38' },
  { nameKey: 'itb.color.teal', v: '#06748f' },
  { nameKey: 'itb.color.blue', v: '#2159d3' },
  { nameKey: 'itb.color.purple', v: '#842ed3' },
  { nameKey: 'itb.color.magenta', v: '#941555' },
  { nameKey: 'itb.color.grey', v: '#6a6a6a' },
]
export const BG_COLORS: Array<{ nameKey: string; v: string }> = [
  { nameKey: 'itb.color.default', v: '' },
  { nameKey: 'itb.color.red', v: '#fed5d5' },
  { nameKey: 'itb.color.orange', v: '#fedfbb' },
  { nameKey: 'itb.color.yellow', v: '#fef3a1' },
  { nameKey: 'itb.color.green', v: '#e1fab1' },
  { nameKey: 'itb.color.teal', v: '#adf8e9' },
  { nameKey: 'itb.color.blue', v: '#cce2fe' },
  { nameKey: 'itb.color.purple', v: '#edddff' },
  { nameKey: 'itb.color.pink', v: '#ffcece' },
  { nameKey: 'itb.color.grey', v: '#eaecef' },
]

/** Card fills use the existing Canvas palette, which is mixed lightly by the renderer. */
export const CARD_COLORS = [
  { nameKey: 'itb.color.red', v: '1' }, { nameKey: 'itb.color.orange', v: '2' },
  { nameKey: 'itb.color.yellow', v: '3' }, { nameKey: 'itb.color.green', v: '4' },
  { nameKey: 'itb.color.teal', v: '5' }, { nameKey: 'itb.color.purple', v: '6' },
]
