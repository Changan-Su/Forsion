// 选中文字上浮的行内格式工具栏(“快捷编辑”,参考 AFFiNE / Notion)。纯展示组件:
// 所有动作经 props 回调交给 MarkdownBlock 调 Milkdown 命令。按钮一律 onMouseDown+preventDefault,
// 按下不夺走编辑器选区/焦点(同 SlashMenu 项)。位置由 selectionToolbarPlugin 报的选区坐标 fixed 定位。
import { useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type MouseEvent as ReactMouseEvent } from 'react'
import { AlignCenter, AlignLeft, AlignRight } from 'lucide-react'
import { OverlayAt } from '../../lib/clampMenu'
import { registerMessages, useI18n } from '../../../i18n'
import type { ToolbarShape } from './menuContext'

// ⚠️ 文案一律经组件内的 `t()` 求值(useI18n),**不要**换成模块级 `translate()`:
// 表格是模块作用域,模块级求值会把文案冻在加载时的语言上,切语言不再更新。
registerMessages({
  'itb.turnInto': { zh: '转换为…', en: 'Turn into…' },
  'itb.bold': { zh: '加粗', en: 'Bold' },
  'itb.italic': { zh: '斜体', en: 'Italic' },
  'itb.underline': { zh: '下划线', en: 'Underline' },
  'itb.strike': { zh: '删除线', en: 'Strikethrough' },
  'itb.code': { zh: '行内代码 (⌘E)', en: 'Inline code (⌘E)' },
  'itb.link': { zh: '链接', en: 'Link' },
  'itb.colorMenu': { zh: '文字 / 背景颜色', en: 'Text / background color' },
  'itb.clear': { zh: '清除格式', en: 'Clear formatting' },
  'itb.alignLeftTitle': { zh: '左对齐 (⌘⇧L)', en: 'Align left (⌘⇧L)' },
  'itb.alignLeft': { zh: '左对齐', en: 'Align left' },
  'itb.alignCenterTitle': { zh: '居中 (⌘⇧E)', en: 'Align center (⌘⇧E)' },
  'itb.alignCenter': { zh: '居中', en: 'Align center' },
  'itb.alignRightTitle': { zh: '右对齐 (⌘⇧R)', en: 'Align right (⌘⇧R)' },
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
  'itb.askTangu': { zh: '问 Tangu', en: 'Ask Tangu' },
  'itb.askTanguTitle': { zh: '把选中的文字带到侧栏对话里问', en: 'Ask about the selection in the side chat' },
  'itb.ai': { zh: 'AI', en: 'AI' },
  'itb.aiTitle': { zh: '用 AI 改写选中的文字（先预览，确认后才写入）', en: 'Rewrite the selection with AI (preview first, nothing is written until you confirm)' },
  'itb.aiPlugins': { zh: '插件', en: 'Plugins' },
  'itb.aria': { zh: '文字格式', en: 'Text formatting' },
})

/** 「AI ▾」菜单的一项(评审 G3-07):宿主给好当前语言的文案;plugin = 插件经 registerSelectionAction 注册的。 */
export interface ToolbarAiItem { id: string; label: string; plugin?: boolean }

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
/** 缺省 = 全部露出(老调用方不传 shape 时的形态)。 */
const FULL_SHAPE: ToolbarShape = { turnInto: true, format: true, link: true, color: true, align: true }

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
/** 「转换为」各项的文案键(宿主转换失败的提示里要说「转换为 X」)。 */
export const TURN_LABEL_KEYS: Partial<Record<ToolbarAction, string>> = Object.fromEntries(TURN_INTO.map((it) => [it.k, it.labelKey]))

export function InlineToolbar({
  left,
  top,
  bottom,
  kind,
  active,
  align,
  shape = FULL_SHAPE,
  fg,
  bg,
  onAct,
  onColor,
  onBg,
  onClose,
  onReturnFocus,
  onAsk,
  ai,
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
  /** 这个上下文露哪几区(I-19,menuContext.toolbarShape 单源):代码块 / 单元格里不列点了无效或会劈表的按钮。 */
  shape?: ToolbarShape
  /** 选区处处相同的文字色 / 背景色:A▾ 上显示当前颜色。 */
  fg?: string
  bg?: string
  onAct: (a: ToolbarAction) => void
  onColor: (v: string) => void // '' = 清除文字色
  onBg: (v: string) => void // '' = 清除背景色
  onClose: () => void
  /** 焦点在工具栏里时按 Esc:关工具栏后把焦点还给编辑器(I-20)。 */
  onReturnFocus?: () => void
  /** 「问 Tangu」(评审 G3-04):宿主有侧栏对话时才传;不传 = 不出这个按钮(v3 块 / 整篇宿主 / 无对话的产品)。 */
  onAsk?: () => void
  /** 「AI ▾」(评审 G3-07):宿主能做正文 AI 时才传;选中一项交给宿主开预览面板。不传 = 不出按钮。 */
  ai?: { items: ToolbarAiItem[]; onPick: (id: string) => void }
}) {
  const { t } = useI18n()
  const [panel, setPanel] = useState<'color' | 'turn' | 'ai' | null>(null)
  const rootRef = useRef<HTMLDivElement | null>(null)
  /** 子面板是键盘打开的 → 打开后把焦点送进第一项(鼠标打开的不动焦点,编辑器选区照旧)。 */
  const panelByKey = useRef(false)

  // 键盘可达(I-20):编辑器里 Alt+F10 把焦点送进工具栏(宿主 keymap),工具栏内 ←→ / Home / End 移动,
  // Enter / 空格触发(原生 click,detail = 0),子面板里 ↑↓ 移动;Esc 先关子面板,再关工具栏并把焦点还给编辑器。
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.preventDefault()
        e.stopPropagation()
        const root = rootRef.current
        const inside = !!root && root.contains(document.activeElement)
        if (panel && inside) {
          const trigger = root!.querySelector<HTMLElement>(`[data-panel="${panel}"]`)
          setPanel(null)
          trigger?.focus()
          return
        }
        onClose()
        if (inside) onReturnFocus?.()
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [onClose, onReturnFocus, panel])

  useEffect(() => {
    if (!panel || !panelByKey.current) return
    panelByKey.current = false
    rootRef.current?.querySelector<HTMLElement>('.itb-panel button')?.focus()
  }, [panel])

  /** 全覆盖才点亮(半覆盖显示未激活 —— 与「再按一次是整段加粗」的语义一致)。 */
  const on = (mark: string): string => (active?.includes(mark) ? ' on' : '')

  // onMouseDown+preventDefault:保住选区/焦点(否则命令执行前编辑器已 blur、选区已丢)。
  const down = (fn: () => void) => (e: ReactMouseEvent): void => {
    e.preventDefault()
    fn()
  }
  /** 鼠标走 mousedown(保选区,既有仪器也按 mousedown 派发);键盘的 Enter / 空格是 detail = 0 的原生 click。
   *  两条入口互斥:鼠标点一下的 click 带 detail ≥ 1,不会再执行一遍。 */
  const act = (fn: () => void) => ({
    onMouseDown: down(fn),
    onClick: (e: ReactMouseEvent) => { if (e.detail === 0) fn() },
  })
  /** 开 / 关子面板;键盘打开的把焦点送进去。 */
  const toggle = (p: 'color' | 'turn' | 'ai') => ({
    onMouseDown: down(() => setPanel(panel === p ? null : p)),
    onClick: (e: ReactMouseEvent) => {
      if (e.detail !== 0) return
      panelByKey.current = panel !== p
      setPanel(panel === p ? null : p)
    },
    'aria-haspopup': 'menu' as const,
    'aria-expanded': panel === p,
    'data-panel': p,
  })
  /** 行内 ←→ / Home / End、子面板里 ↑↓ 在按钮间移动焦点(roving:只有首钮进 Tab 序,入口是 Alt+F10)。 */
  const onNav = (e: ReactKeyboardEvent<HTMLDivElement>): void => {
    const box = (e.target as HTMLElement).closest('.itb-row, .itb-panel')
    if (!box) return
    const inPanel = box.classList.contains('itb-panel')
    const keys = inPanel ? ['ArrowDown', 'ArrowUp', 'ArrowRight', 'ArrowLeft', 'Home', 'End'] : ['ArrowRight', 'ArrowLeft', 'Home', 'End']
    if (!keys.includes(e.key)) return
    const btns = [...box.querySelectorAll<HTMLElement>(':scope > button, :scope > * > button')]
    const i = btns.indexOf(document.activeElement as HTMLElement)
    const fwd = e.key === 'ArrowRight' || e.key === 'ArrowDown'
    const next = e.key === 'Home' ? 0 : e.key === 'End' ? btns.length - 1 : i < 0 ? 0 : (i + (fwd ? 1 : -1) + btns.length) % btns.length
    e.preventDefault()
    e.stopPropagation()
    btns[next]?.focus()
  }

  return (
    // 摆位一律交给 OverlayAt:默认浮在选区上方,上面没地方才翻到下方(同 slash)。
    // ⚠️别改回「CSS transform: translate(-50%,-100%)」那套 —— pop-in 动画也动 transform,
    // 会把摆位覆盖掉 120ms:工具栏先出现在选区右下、动画结束才跳到文字上方(用户实报)。
    <OverlayAt className="inline-toolbar" x={left} y={bottom + 8} anchorTop={top - 8} prefer="above" center role="toolbar" aria-label={t('itb.aria')} data-testid="inline-toolbar" innerRef={(el) => { rootRef.current = el }} onKeyDown={onNav}>
      <div className="itb-row">
        {/* 排在最前(Notion 的 Ask AI 同位):选区 AI 的入口,点了把选区交给侧栏对话,笔记一个字不动。 */}
        {onAsk && (
          <>
            <button className="itb-btn itb-ask" title={t('itb.askTanguTitle')} data-act="ask" {...act(onAsk)}>{t('itb.askTangu')}</button>
            {!ai && <span className="itb-sep" />}
          </>
        )}
        {ai && (
          <>
            <button className="itb-btn itb-ask" title={t('itb.aiTitle')} data-act="ai" {...toggle('ai')}>{t('itb.ai')} ▾</button>
            <span className="itb-sep" />
          </>
        )}
        {shape.turnInto && (
          <>
            <button className="itb-btn itb-turn" title={t('itb.turnInto')} aria-label={`${t('itb.turnInto')} ${kind}`} {...toggle('turn')}>
              {kind} ▾
            </button>
            <span className="itb-sep" />
          </>
        )}
        {shape.format && (
          <>
            <button className={`itb-btn${on('strong')}`} style={{ fontWeight: 700 }} title={t('itb.bold')} data-act="bold" aria-label={t('itb.bold')} aria-pressed={!!active?.includes('strong')} {...act(() => onAct('bold'))}>B</button>
            <button className={`itb-btn${on('emphasis')}`} style={{ fontStyle: 'italic' }} title={t('itb.italic')} data-act="italic" aria-label={t('itb.italic')} aria-pressed={!!active?.includes('emphasis')} {...act(() => onAct('italic'))}>I</button>
            <button className={`itb-btn${on('amadeusUnderline')}`} style={{ textDecoration: 'underline' }} title={t('itb.underline')} data-act="underline" aria-label={t('itb.underline')} aria-pressed={!!active?.includes('amadeusUnderline')} {...act(() => onAct('underline'))}>U</button>
            <button className={`itb-btn${on('strike_through')}`} style={{ textDecoration: 'line-through' }} title={t('itb.strike')} data-act="strike" aria-label={t('itb.strike')} aria-pressed={!!active?.includes('strike_through')} {...act(() => onAct('strike'))}>S</button>
            <button className={`itb-btn${on('inlineCode')}`} title={t('itb.code')} data-act="code" aria-label={t('itb.code')} aria-pressed={!!active?.includes('inlineCode')} {...act(() => onAct('code'))}>&lt;/&gt;</button>
          </>
        )}
        {shape.link && <button className={`itb-btn${on('link')}`} title={t('itb.link')} aria-label={t('itb.link')} aria-pressed={!!active?.includes('link')} data-act="link" {...act(() => onAct('link'))}>🔗</button>}
        {(shape.format || shape.link) && <span className="itb-sep" />}
        {shape.color && (
          // A 字本身染上选区的当前文字色 / 背景色(处处相同时;I-19:此前看不出选中的字是什么颜色)。
          <button className="itb-btn itb-color" title={t('itb.colorMenu')} aria-label={t('itb.colorMenu')} data-fg={fg || undefined} data-bg={bg || undefined} {...toggle('color')}>
            <span className="itb-color-cur" style={{ color: fg || undefined, background: bg || undefined }}>A</span> ▾
          </button>
        )}
        <button className="itb-btn" title={t('itb.clear')} aria-label={t('itb.clear')} data-act="clear" {...act(() => onAct('clear'))}>T×</button>
        {shape.align && (
          <>
            <span className="itb-sep" />
            <button className={`itb-btn${align === 'left' ? ' on' : ''}`} title={t('itb.alignLeftTitle')} aria-label={t('itb.alignLeft')} aria-pressed={align === 'left'} data-act="alignLeft" {...act(() => onAct('alignLeft'))}><AlignLeft size={14} /></button>
            <button className={`itb-btn${align === 'center' ? ' on' : ''}`} title={t('itb.alignCenterTitle')} aria-label={t('itb.alignCenter')} aria-pressed={align === 'center'} data-act="alignCenter" {...act(() => onAct('alignCenter'))}><AlignCenter size={14} /></button>
            <button className={`itb-btn${align === 'right' ? ' on' : ''}`} title={t('itb.alignRightTitle')} aria-label={t('itb.alignRight')} aria-pressed={align === 'right'} data-act="alignRight" {...act(() => onAct('alignRight'))}><AlignRight size={14} /></button>
          </>
        )}
      </div>

      {panel === 'turn' && (
        <div className="itb-panel" role="menu" aria-label={t('itb.turnInto')}>
          {TURN_INTO.map((item) => (
            <button
              key={item.k}
              className="itb-menu-item"
              role="menuitem"
              tabIndex={-1}
              {...act(() => {
                setPanel(null)
                onAct(item.k)
              })}
            >
              {t(item.labelKey)}
            </button>
          ))}
        </div>
      )}

      {panel === 'ai' && ai && (
        <div className="itb-panel itb-ai-menu" role="menu" data-testid="itb-ai-menu">
          {ai.items.filter((it) => !it.plugin).map((it) => (
            <button key={it.id} className="itb-menu-item" role="menuitem" tabIndex={-1} data-ai={it.id} {...act(() => { setPanel(null); ai.onPick(it.id) })}>{it.label}</button>
          ))}
          {ai.items.some((it) => it.plugin) && <div className="itb-color-head">{t('itb.aiPlugins')}</div>}
          {ai.items.filter((it) => it.plugin).map((it) => (
            <button key={it.id} className="itb-menu-item" role="menuitem" tabIndex={-1} data-ai={it.id} {...act(() => { setPanel(null); ai.onPick(it.id) })}>{it.label}</button>
          ))}
        </div>
      )}

      {panel === 'color' && (
        <div className="itb-panel itb-colors" role="menu" aria-label={t('itb.colorMenu')}>
          <div className="itb-color-head">{t('itb.textColor')}</div>
          <div className="itb-swatches">
            {TEXT_COLORS.map((c) => (
              <button
                key={c.v || 'def'}
                className="itb-swatch"
                title={t(c.nameKey)}
                role="menuitem"
                tabIndex={-1}
                aria-label={`${t('itb.textColor')}: ${t(c.nameKey)}`}
                data-fg={c.v || 'default'}
                {...act(() => {
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
                role="menuitem"
                tabIndex={-1}
                aria-label={`${t('itb.bgColor')}: ${t(c.nameKey)}`}
                data-bg={c.v || 'default'}
                {...act(() => {
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
