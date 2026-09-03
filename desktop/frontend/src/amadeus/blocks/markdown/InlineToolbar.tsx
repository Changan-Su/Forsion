// 选中文字上浮的行内格式工具栏(“快捷编辑”,参考 AFFiNE / Notion)。纯展示组件:
// 所有动作经 props 回调交给 MarkdownBlock 调 Milkdown 命令。按钮一律 onMouseDown+preventDefault,
// 按下不夺走编辑器选区/焦点(同 SlashMenu 项)。位置由 selectionToolbarPlugin 报的选区坐标 fixed 定位。
import { useEffect, useState, type MouseEvent as ReactMouseEvent } from 'react'
import { AlignCenter, AlignLeft, AlignRight } from 'lucide-react'
import { OverlayAt } from '../../lib/clampMenu'
import { registerMessages, useI18n } from '../../../i18n'

// ⚠️ 文案一律经组件内的 `t()` 求值(useI18n),**不要**换成模块级 `translate()`:
// 表格是模块作用域,模块级求值会把文案冻在加载时的语言上,切语言不再更新。
registerMessages({
  'itb.turnInto': { zh: '转换为…', en: 'Turn into…' },
  'itb.bold': { zh: '加粗', en: 'Bold' },
  'itb.italic': { zh: '斜体', en: 'Italic' },
  'itb.underline': { zh: '下划线', en: 'Underline' },
  'itb.strike': { zh: '删除线', en: 'Strikethrough' },
  'itb.code': { zh: '行内代码', en: 'Inline code' },
  'itb.link': { zh: '链接', en: 'Link' },
  'itb.colorMenu': { zh: '文字 / 背景颜色', en: 'Text / background color' },
  'itb.clear': { zh: '清除格式', en: 'Clear formatting' },
  'itb.alignLeftTitle': { zh: '左对齐 (⌘L)', en: 'Align left (⌘L)' },
  'itb.alignLeft': { zh: '左对齐', en: 'Align left' },
  'itb.alignCenterTitle': { zh: '居中 (⌘E)', en: 'Align center (⌘E)' },
  'itb.alignCenter': { zh: '居中', en: 'Align center' },
  'itb.alignRightTitle': { zh: '右对齐 (⌘R)', en: 'Align right (⌘R)' },
  'itb.alignRight': { zh: '右对齐', en: 'Align right' },
  'itb.textColor': { zh: '文字颜色', en: 'Text color' },
  'itb.bgColor': { zh: '背景颜色', en: 'Background color' },
  'itb.color.default': { zh: '默认', en: 'Default' },
  'itb.color.red': { zh: '红', en: 'Red' },
  'itb.color.orange': { zh: '橙', en: 'Orange' },
  'itb.color.yellow': { zh: '黄', en: 'Yellow' },
  'itb.color.green': { zh: '绿', en: 'Green' },
  'itb.color.teal': { zh: '青', en: 'Teal' },
  'itb.color.blue': { zh: '蓝', en: 'Blue' },
  'itb.color.purple': { zh: '紫', en: 'Purple' },
  'itb.color.magenta': { zh: '品红', en: 'Magenta' },
  'itb.color.pink': { zh: '粉', en: 'Pink' },
  'itb.color.grey': { zh: '灰', en: 'Gray' },
  'itb.turn.text': { zh: '正文', en: 'Text' },
  'itb.turn.h1': { zh: '标题 1', en: 'Heading 1' },
  'itb.turn.h2': { zh: '标题 2', en: 'Heading 2' },
  'itb.turn.h3': { zh: '标题 3', en: 'Heading 3' },
  'itb.turn.h4': { zh: '标题 4', en: 'Heading 4' },
  'itb.turn.h5': { zh: '标题 5', en: 'Heading 5' },
  'itb.turn.h6': { zh: '标题 6', en: 'Heading 6' },
  'itb.turn.bullet': { zh: '无序列表', en: 'Bulleted list' },
  'itb.turn.ordered': { zh: '有序列表', en: 'Numbered list' },
  'itb.turn.todo': { zh: '待办', en: 'To-do' },
  'itb.turn.quote': { zh: '引用', en: 'Quote' },
  'itb.turn.fold': { zh: '折叠', en: 'Toggle' },
  'itb.turn.codeblock': { zh: '代码块', en: 'Code block' },
  'itb.turn.math': { zh: '公式', en: 'Equation' },
})

export type ToolbarAction =
  | 'bold'
  | 'italic'
  | 'underline'
  | 'strike'
  | 'code'
  | 'link'
  | 'clear'
  | 'text'
  | 'h1'
  | 'h2'
  | 'h3'
  | 'h4'
  | 'h5'
  | 'h6'
  | 'bullet'
  | 'ordered'
  | 'todo'
  | 'quote'
  | 'fold'
  | 'codeblock'
  | 'math'
  | 'alignLeft'
  | 'alignCenter'
  | 'alignRight'

// 调色板(参考 AFFiNE 命名色;十六进制,后续可换 LCL token)。'' = 清除该颜色。
// 色板的色相沿用 AFFiNE **v1** 编辑器(--affine-text-highlight-*),但文字色为 Genesis 的
// 浅色纸面略微压暗到 AA;否则橙/黄/绿/青/灰会在某些 skin 下掉到 3–4:1。品红/粉为产品扩展。
// 落盘存字面亮色 hex(Obsidian 可渲染);暗色由 marks.ts 的 data-hl/data-hlc 语义名 + styles.css
// 覆盖切换 —— 改这里的值必须同步 marks.ts 的 HL_BG_NAMES/HL_FG_NAMES 与 styles.css 暗色段。
// ⚠️ `nameKey` / `labelKey` 存的是 i18n 键,不是文案 —— 模块作用域求值会把文案冻死在加载语言上。
const TEXT_COLORS: Array<{ nameKey: string; v: string }> = [
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
const BG_COLORS: Array<{ nameKey: string; v: string }> = [
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
const TURN_INTO: Array<{ k: ToolbarAction; labelKey: string }> = [
  { k: 'text', labelKey: 'itb.turn.text' },
  { k: 'h1', labelKey: 'itb.turn.h1' },
  { k: 'h2', labelKey: 'itb.turn.h2' },
  { k: 'h3', labelKey: 'itb.turn.h3' },
  { k: 'h4', labelKey: 'itb.turn.h4' },
  { k: 'h5', labelKey: 'itb.turn.h5' },
  { k: 'h6', labelKey: 'itb.turn.h6' },
  { k: 'bullet', labelKey: 'itb.turn.bullet' },
  { k: 'ordered', labelKey: 'itb.turn.ordered' },
  { k: 'todo', labelKey: 'itb.turn.todo' },
  { k: 'quote', labelKey: 'itb.turn.quote' },
  { k: 'fold', labelKey: 'itb.turn.fold' },
  // AFFiNE 的 Turn into 矩阵里有代码块与公式(分割线被它显式过滤掉,只留在 slash 菜单)。
  { k: 'codeblock', labelKey: 'itb.turn.codeblock' },
  { k: 'math', labelKey: 'itb.turn.math' },
]

export function InlineToolbar({
  left,
  top,
  bottom,
  kind,
  active,
  align,
  onAct,
  onColor,
  onBg,
  onClose,
}: {
  left: number
  /** 选区行上沿(视口 px) */
  top: number
  /** 选区行下沿(视口 px):上方没空间时翻到它之下 */
  bottom: number
  /** 选区所在块的当前类型名(selectionToolbarPlugin 实时算);此前这里写死「正文」。 */
  kind: string
  /** 选区**全覆盖**的格式名(schema mark name);半覆盖不算,按钮显示未激活。 */
  active?: string[]
  /** 当前块对齐；跨块且不一致时缺省，不误点亮任何一个。 */
  align?: 'left' | 'center' | 'right'
  onAct: (a: ToolbarAction) => void
  onColor: (v: string) => void // '' = 清除文字色
  onBg: (v: string) => void // '' = 清除背景色
  onClose: () => void
}) {
  const { t } = useI18n()
  const [panel, setPanel] = useState<'color' | 'turn' | null>(null)

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.preventDefault()
        e.stopPropagation()
        onClose()
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [onClose])

  /** 全覆盖才点亮(半覆盖显示未激活 —— 与「再按一次是整段加粗」的语义一致)。 */
  const on = (mark: string): string => (active?.includes(mark) ? ' on' : '')

  // onMouseDown+preventDefault:保住选区/焦点(否则命令执行前编辑器已 blur、选区已丢)。
  const down = (fn: () => void) => (e: ReactMouseEvent): void => {
    e.preventDefault()
    fn()
  }

  return (
    // 摆位一律交给 OverlayAt:默认浮在选区上方,上面没地方才翻到下方(同 slash)。
    // ⚠️别改回「CSS transform: translate(-50%,-100%)」那套 —— pop-in 动画也动 transform,
    // 会把摆位覆盖掉 120ms:工具栏先出现在选区右下、动画结束才跳到文字上方(用户实报)。
    <OverlayAt className="inline-toolbar" x={left} y={bottom + 8} anchorTop={top - 8} prefer="above" center role="toolbar" data-testid="inline-toolbar">
      <div className="itb-row">
        <button className="itb-btn itb-turn" title={t('itb.turnInto')} onMouseDown={down(() => setPanel(panel === 'turn' ? null : 'turn'))}>
          {kind} ▾
        </button>
        <span className="itb-sep" />
        <button className={`itb-btn${on('strong')}`} style={{ fontWeight: 700 }} title={t('itb.bold')} data-act="bold" onMouseDown={down(() => onAct('bold'))}>B</button>
        <button className={`itb-btn${on('emphasis')}`} style={{ fontStyle: 'italic' }} title={t('itb.italic')} data-act="italic" onMouseDown={down(() => onAct('italic'))}>I</button>
        <button className={`itb-btn${on('amadeusU')}`} style={{ textDecoration: 'underline' }} title={t('itb.underline')} data-act="underline" onMouseDown={down(() => onAct('underline'))}>U</button>
        <button className={`itb-btn${on('strike_through')}`} style={{ textDecoration: 'line-through' }} title={t('itb.strike')} data-act="strike" onMouseDown={down(() => onAct('strike'))}>S</button>
        <button className={`itb-btn${on('inlineCode')}`} title={t('itb.code')} data-act="code" onMouseDown={down(() => onAct('code'))}>&lt;/&gt;</button>
        <button className="itb-btn" title={t('itb.link')} data-act="link" onMouseDown={down(() => onAct('link'))}>🔗</button>
        <span className="itb-sep" />
        <button className="itb-btn itb-color" title={t('itb.colorMenu')} onMouseDown={down(() => setPanel(panel === 'color' ? null : 'color'))}>
          A ▾
        </button>
        <button className="itb-btn" title={t('itb.clear')} data-act="clear" onMouseDown={down(() => onAct('clear'))}>T×</button>
        <span className="itb-sep" />
        <button className={`itb-btn${align === 'left' ? ' on' : ''}`} title={t('itb.alignLeftTitle')} aria-label={t('itb.alignLeft')} data-act="alignLeft" onMouseDown={down(() => onAct('alignLeft'))}><AlignLeft size={14} /></button>
        <button className={`itb-btn${align === 'center' ? ' on' : ''}`} title={t('itb.alignCenterTitle')} aria-label={t('itb.alignCenter')} data-act="alignCenter" onMouseDown={down(() => onAct('alignCenter'))}><AlignCenter size={14} /></button>
        <button className={`itb-btn${align === 'right' ? ' on' : ''}`} title={t('itb.alignRightTitle')} aria-label={t('itb.alignRight')} data-act="alignRight" onMouseDown={down(() => onAct('alignRight'))}><AlignRight size={14} /></button>
      </div>

      {panel === 'turn' && (
        <div className="itb-panel">
          {TURN_INTO.map((item) => (
            <button
              key={item.k}
              className="itb-menu-item"
              onMouseDown={down(() => {
                setPanel(null)
                onAct(item.k)
              })}
            >
              {t(item.labelKey)}
            </button>
          ))}
        </div>
      )}

      {panel === 'color' && (
        <div className="itb-panel itb-colors">
          <div className="itb-color-head">{t('itb.textColor')}</div>
          <div className="itb-swatches">
            {TEXT_COLORS.map((c) => (
              <button
                key={c.v || 'def'}
                className="itb-swatch"
                title={t(c.nameKey)}
                data-fg={c.v || 'default'}
                onMouseDown={down(() => {
                  setPanel(null)
                  onColor(c.v)
                })}
              >
                <span className="itb-swatch-a" style={{ color: c.v || 'var(--text)' }}>A</span>
              </button>
            ))}
          </div>
          <div className="itb-color-head">{t('itb.bgColor')}</div>
          <div className="itb-swatches">
            {BG_COLORS.map((c) => (
              <button
                key={c.v || 'def'}
                className="itb-swatch"
                title={t(c.nameKey)}
                data-bg={c.v || 'default'}
                onMouseDown={down(() => {
                  setPanel(null)
                  onBg(c.v)
                })}
              >
                <span className="itb-swatch-bg" style={{ background: c.v || 'transparent' }} />
              </button>
            ))}
          </div>
        </div>
      )}
    </OverlayAt>
  )
}
