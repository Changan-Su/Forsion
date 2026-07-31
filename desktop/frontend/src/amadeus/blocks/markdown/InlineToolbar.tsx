// 选中文字上浮的行内格式工具栏(“快捷编辑”,参考 AFFiNE / Notion)。纯展示组件:
// 所有动作经 props 回调交给 MarkdownBlock 调 Milkdown 命令。按钮一律 onMouseDown+preventDefault,
// 按下不夺走编辑器选区/焦点(同 SlashMenu 项)。位置由 selectionToolbarPlugin 报的选区坐标 fixed 定位。
import { useEffect, useState, type MouseEvent as ReactMouseEvent } from 'react'
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

// 调色板(参考 AFFiNE 命名色;十六进制,后续可换 LCL token)。'' = 清除该颜色。
const TEXT_COLORS: Array<{ name: string; v: string }> = [
  { name: '默认', v: '' },
  { name: '红', v: '#e03131' },
  { name: '橙', v: '#e8590c' },
  { name: '黄', v: '#f08c00' },
  { name: '绿', v: '#2f9e44' },
  { name: '青', v: '#0c8599' },
  { name: '蓝', v: '#1971c2' },
  { name: '紫', v: '#9c36b5' },
  { name: '灰', v: '#868e96' },
]
const BG_COLORS: Array<{ name: string; v: string }> = [
  { name: '默认', v: '' },
  { name: '灰', v: '#e9ecef' },
  { name: '红', v: '#ffe3e3' },
  { name: '橙', v: '#ffe8cc' },
  { name: '黄', v: '#fff3bf' },
  { name: '绿', v: '#d3f9d8' },
  { name: '青', v: '#c5f6fa' },
  { name: '蓝', v: '#d0ebff' },
  { name: '紫', v: '#f3d9fa' },
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
]

export function InlineToolbar({
  left,
  top,
  bottom,
  kind,
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
        <button className="itb-btn" style={{ fontWeight: 700 }} title="加粗" data-act="bold" onMouseDown={down(() => onAct('bold'))}>B</button>
        <button className="itb-btn" style={{ fontStyle: 'italic' }} title="斜体" data-act="italic" onMouseDown={down(() => onAct('italic'))}>I</button>
        <button className="itb-btn" style={{ textDecoration: 'underline' }} title="下划线" data-act="underline" onMouseDown={down(() => onAct('underline'))}>U</button>
        <button className="itb-btn" style={{ textDecoration: 'line-through' }} title="删除线" data-act="strike" onMouseDown={down(() => onAct('strike'))}>S</button>
        <button className="itb-btn" title="行内代码" data-act="code" onMouseDown={down(() => onAct('code'))}>&lt;/&gt;</button>
        <button className="itb-btn" title="链接" data-act="link" onMouseDown={down(() => onAct('link'))}>🔗</button>
        <span className="itb-sep" />
        <button className="itb-btn itb-color" title="文字 / 背景颜色" onMouseDown={down(() => setPanel(panel === 'color' ? null : 'color'))}>
          A ▾
        </button>
        <button className="itb-btn" title="清除格式" data-act="clear" onMouseDown={down(() => onAct('clear'))}>T×</button>
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
