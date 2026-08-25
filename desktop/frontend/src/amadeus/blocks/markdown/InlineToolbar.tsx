// 选中文字上浮的行内格式工具栏(“快捷编辑”,参考 AFFiNE / Notion)。纯展示组件:
// 所有动作经 props 回调交给 MarkdownBlock 调 Milkdown 命令。按钮一律 onMouseDown+preventDefault,
// 按下不夺走编辑器选区/焦点(同 SlashMenu 项)。位置由 selectionToolbarPlugin 报的选区坐标 fixed 定位。
import { useEffect, useState, type MouseEvent as ReactMouseEvent } from 'react'
import { AlignCenter, AlignLeft, AlignRight } from 'lucide-react'
import { OverlayAt } from '../../lib/clampMenu'

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
const TEXT_COLORS: Array<{ name: string; v: string }> = [
  { name: '默认', v: '' },
  { name: '红', v: '#c62222' },
  { name: '橙', v: '#b9450a' },
  { name: '黄', v: '#8f6203' },
  { name: '绿', v: '#117b38' },
  { name: '青', v: '#06748f' },
  { name: '蓝', v: '#2159d3' },
  { name: '紫', v: '#842ed3' },
  { name: '品红', v: '#941555' },
  { name: '灰', v: '#6a6a6a' },
]
const BG_COLORS: Array<{ name: string; v: string }> = [
  { name: '默认', v: '' },
  { name: '红', v: '#fed5d5' },
  { name: '橙', v: '#fedfbb' },
  { name: '黄', v: '#fef3a1' },
  { name: '绿', v: '#e1fab1' },
  { name: '青', v: '#adf8e9' },
  { name: '蓝', v: '#cce2fe' },
  { name: '紫', v: '#edddff' },
  { name: '粉', v: '#ffcece' },
  { name: '灰', v: '#eaecef' },
]
const TURN_INTO: Array<{ k: ToolbarAction; label: string }> = [
  { k: 'text', label: '正文' },
  { k: 'h1', label: '标题 1' },
  { k: 'h2', label: '标题 2' },
  { k: 'h3', label: '标题 3' },
  { k: 'h4', label: '标题 4' },
  { k: 'h5', label: '标题 5' },
  { k: 'h6', label: '标题 6' },
  { k: 'bullet', label: '无序列表' },
  { k: 'ordered', label: '有序列表' },
  { k: 'todo', label: '待办' },
  { k: 'quote', label: '引用' },
  { k: 'fold', label: '折叠' },
  // AFFiNE 的 Turn into 矩阵里有代码块与公式(分割线被它显式过滤掉,只留在 slash 菜单)。
  { k: 'codeblock', label: '代码块' },
  { k: 'math', label: '公式' },
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
        <button className="itb-btn itb-turn" title="转换为…" onMouseDown={down(() => setPanel(panel === 'turn' ? null : 'turn'))}>
          {kind} ▾
        </button>
        <span className="itb-sep" />
        <button className={`itb-btn${on('strong')}`} style={{ fontWeight: 700 }} title="加粗" data-act="bold" onMouseDown={down(() => onAct('bold'))}>B</button>
        <button className={`itb-btn${on('emphasis')}`} style={{ fontStyle: 'italic' }} title="斜体" data-act="italic" onMouseDown={down(() => onAct('italic'))}>I</button>
        <button className={`itb-btn${on('amadeusU')}`} style={{ textDecoration: 'underline' }} title="下划线" data-act="underline" onMouseDown={down(() => onAct('underline'))}>U</button>
        <button className={`itb-btn${on('strike_through')}`} style={{ textDecoration: 'line-through' }} title="删除线" data-act="strike" onMouseDown={down(() => onAct('strike'))}>S</button>
        <button className={`itb-btn${on('inlineCode')}`} title="行内代码" data-act="code" onMouseDown={down(() => onAct('code'))}>&lt;/&gt;</button>
        <button className="itb-btn" title="链接" data-act="link" onMouseDown={down(() => onAct('link'))}>🔗</button>
        <span className="itb-sep" />
        <button className="itb-btn itb-color" title="文字 / 背景颜色" onMouseDown={down(() => setPanel(panel === 'color' ? null : 'color'))}>
          A ▾
        </button>
        <button className="itb-btn" title="清除格式" data-act="clear" onMouseDown={down(() => onAct('clear'))}>T×</button>
        <span className="itb-sep" />
        <button className={`itb-btn${align === 'left' ? ' on' : ''}`} title="左对齐 (⌘L)" aria-label="左对齐" data-act="alignLeft" onMouseDown={down(() => onAct('alignLeft'))}><AlignLeft size={14} /></button>
        <button className={`itb-btn${align === 'center' ? ' on' : ''}`} title="居中 (⌘E)" aria-label="居中" data-act="alignCenter" onMouseDown={down(() => onAct('alignCenter'))}><AlignCenter size={14} /></button>
        <button className={`itb-btn${align === 'right' ? ' on' : ''}`} title="右对齐 (⌘R)" aria-label="右对齐" data-act="alignRight" onMouseDown={down(() => onAct('alignRight'))}><AlignRight size={14} /></button>
      </div>

      {panel === 'turn' && (
        <div className="itb-panel">
          {TURN_INTO.map((t) => (
            <button
              key={t.k}
              className="itb-menu-item"
              onMouseDown={down(() => {
                setPanel(null)
                onAct(t.k)
              })}
            >
              {t.label}
            </button>
          ))}
        </div>
      )}

      {panel === 'color' && (
        <div className="itb-panel itb-colors">
          <div className="itb-color-head">文字颜色</div>
          <div className="itb-swatches">
            {TEXT_COLORS.map((c) => (
              <button
                key={c.v || 'def'}
                className="itb-swatch"
                title={c.name}
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
          <div className="itb-color-head">背景颜色</div>
          <div className="itb-swatches">
            {BG_COLORS.map((c) => (
              <button
                key={c.v || 'def'}
                className="itb-swatch"
                title={c.name}
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
