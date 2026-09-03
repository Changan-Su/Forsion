/** 自建工具胶囊。**为什么不改引擎自带的那条**:引擎是预编译的 IIFE(见 forkRuntime.ts),
 *  它的 ShapesSwitcher 在 bundle 里改不动,而 `UIOptions.tools` 只能开关 image 一项。
 *  所以这里整条自己画,经 `api.setActiveTool()` 驱动引擎;引擎那条用 CSS 藏掉(amadeus-host.css),
 *  但**壳还留着** —— 它那张 Island 的定位/圆角/投影/HintViewer 全部白捡,我们只换内容。
 *
 *  三段 = 两条分隔竖线。**只有中段有数字快捷键**,按位置从左到右 1..9、第 10 个 0;
 *  拖动会改快捷键,这是用户明确要的语义。顺序存在 toolbarOrder.ts(全局,localStorage)。
 *
 *  ⚠️ 数字键必须在 **window 捕获阶段**截下(见 ExcalidrawCanvas 的 useDigitKeys):引擎自己也绑了
 *     1..0,不 stopImmediatePropagation 就会两边都动,表现是「按 2 跳到别的工具」。
 */
import { useRef, useState, useSyncExternalStore } from 'react'
import {
  ArrowRight,
  Circle,
  Diamond,
  Eraser,
  Frame,
  Hand,
  Highlighter,
  Lock,
  Minus,
  MousePointer2,
  Pencil,
  Square,
  Type,
  Zap,
} from 'lucide-react'
import { clearPen, pickPen, type PenState } from './PenRow'
import {
  digitFor,
  getToolbarLayout,
  moveTool,
  setToolbarLayout,
  subscribeToolbarLayout,
  type Segment,
  type ToolId,
  type ToolbarLayout,
} from './toolbarOrder'
import { registerMessages, translate, useI18n } from '../../../i18n'
import type { ExcalidrawImperativeAPI } from '@excalidraw/excalidraw/types'
import type { BoardUi } from './boardUi'

registerMessages({
  'boardtoolbar.shapeRectangle': { zh: '矩形', en: 'Rectangle' },
  'boardtoolbar.shapeDiamond': { zh: '菱形', en: 'Diamond' },
  'boardtoolbar.shapeEllipse': { zh: '椭圆', en: 'Ellipse' },
  'boardtoolbar.lineArrow': { zh: '箭头', en: 'Arrow' },
  'boardtoolbar.lineSegment': { zh: '线段', en: 'Line' },
  'boardtoolbar.toolLock': { zh: '保持工具选中', en: 'Keep tool selected' },
  'boardtoolbar.toolHand': { zh: '抓手', en: 'Hand' },
  'boardtoolbar.toolSelection': { zh: '选择', en: 'Selection' },
  'boardtoolbar.toolShape': { zh: '形状', en: 'Shape' },
  'boardtoolbar.toolLine': { zh: '线', en: 'Line' },
  'boardtoolbar.toolFreedraw': { zh: '画笔', en: 'Draw' },
  'boardtoolbar.toolHighlighter': { zh: '荧光笔', en: 'Highlighter' },
  'boardtoolbar.toolText': { zh: '文字', en: 'Text' },
  'boardtoolbar.toolEraser': { zh: '橡皮', en: 'Eraser' },
  'boardtoolbar.toolFrame': { zh: '画框', en: 'Frame' },
  'boardtoolbar.toolLaser': { zh: '激光笔', en: 'Laser pointer' },
})

/** 合并按钮的成员。用户选的语义是「记忆最近用过的那个 + 数字键不循环」——
 *  换成员只能去左侧属性面板(见 PanelExtras),所以这里只需要记住当前是哪个。 */
export const SHAPE_MEMBERS = ['rectangle', 'diamond', 'ellipse'] as const
export const LINE_MEMBERS = ['arrow', 'line'] as const
export type ShapeMember = (typeof SHAPE_MEMBERS)[number]
export type LineMember = (typeof LINE_MEMBERS)[number]
export type GroupState = { shape: ShapeMember; line: LineMember }
export const newGroupState = (): GroupState => ({ shape: 'rectangle', line: 'arrow' })

const SHAPE_ICON: Record<ShapeMember, typeof Square> = { rectangle: Square, diamond: Diamond, ellipse: Circle }
const LINE_ICON: Record<LineMember, typeof Square> = { arrow: ArrowRight, line: Minus }

/** ⚠️ 这两张表**必须惰性求值**(getter),不能是字面量:模块作用域的字面量在加载那一刻就冻住,
 *  切语言不会跟着变。写成 getter 后类型仍是 `Record<…, string>`,消费方(PanelExtras)按下标读
 *  的写法一字不用改,只是取值时机挪到了渲染那一刻。 */
export const SHAPE_LABELS: Record<ShapeMember, string> = {
  get rectangle() { return translate('boardtoolbar.shapeRectangle') },
  get diamond() { return translate('boardtoolbar.shapeDiamond') },
  get ellipse() { return translate('boardtoolbar.shapeEllipse') },
}
export const LINE_LABELS: Record<LineMember, string> = {
  get arrow() { return translate('boardtoolbar.lineArrow') },
  get line() { return translate('boardtoolbar.lineSegment') },
}

export type ToolRefs = {
  pen: React.RefObject<PenState>
  group: React.RefObject<GroupState>
}

/** 存**键**不存文案:模块作用域的文案字面量会在加载时冻住,切语言不更新(见 SHAPE_LABELS 注释)。
 *  真正的文案在渲染时用 `t(LABEL_KEYS[id])` 求。 */
const LABEL_KEYS: Record<ToolId, string> = {
  lock: 'boardtoolbar.toolLock',
  hand: 'boardtoolbar.toolHand',
  selection: 'boardtoolbar.toolSelection',
  shape: 'boardtoolbar.toolShape',
  line: 'boardtoolbar.toolLine',
  freedraw: 'boardtoolbar.toolFreedraw',
  highlighter: 'boardtoolbar.toolHighlighter',
  text: 'boardtoolbar.toolText',
  eraser: 'boardtoolbar.toolEraser',
  frame: 'boardtoolbar.toolFrame',
  laser: 'boardtoolbar.toolLaser',
}

/** 点一颗工具。工具栏按钮和数字快捷键**共用这一份** —— 分两处写迟早会分叉。 */
export function activateTool(id: ToolId, api: ExcalidrawImperativeAPI, refs: ToolRefs): void {
  const st = api.getAppState()
  switch (id) {
    case 'lock':
      // 锁 = 「画完保持工具选中」,不是一个工具。原样把当前工具再设一遍、只翻 locked。
      // 展开 activeTool 是为了带上自定义工具的 customType(联合类型里它是必填)。
      api.setActiveTool({ ...st.activeTool, locked: !st.activeTool.locked } as Parameters<ExcalidrawImperativeAPI['setActiveTool']>[0])
      return
    case 'shape':
      api.setActiveTool({ type: refs.group.current.shape })
      return
    case 'line':
      api.setActiveTool({ type: refs.group.current.line })
      return
    case 'freedraw':
      // ⚠️ 只有这颗清笔。「画笔」≠「荧光笔」,带着荧光参数进普通自由画笔就分不出这两颗按钮了。
      //    别顺手给别的工具也加上 clearPen —— 那会打死插件的 freedrawOnly 语义:选了荧光笔再去画
      //    个矩形,本该只是**临时**把颜色还回去(usePenRestore 干的),切回画笔时荧光笔自己回来;
      //    清掉就再也回不来了(2026-08-14 被 L16 抓到过一次)。
      clearPen(api, refs.pen)
      api.setActiveTool({ type: 'freedraw' })
      return
    case 'highlighter':
      pickPen(api, refs.pen, 'highlighter')
      return
    default:
      api.setActiveTool({ type: id })
  }
}

function iconOf(id: ToolId, g: GroupState): typeof Square {
  switch (id) {
    case 'lock':
      return Lock
    case 'hand':
      return Hand
    case 'selection':
      return MousePointer2
    case 'shape':
      return SHAPE_ICON[g.shape]
    case 'line':
      return LINE_ICON[g.line]
    case 'freedraw':
      return Pencil
    case 'highlighter':
      return Highlighter
    case 'text':
      return Type
    case 'eraser':
      return Eraser
    case 'frame':
      return Frame
    case 'laser':
      return Zap
  }
}

function isActive(id: ToolId, ui: BoardUi, pen: PenState): boolean {
  const t = ui.tool
  switch (id) {
    case 'lock':
      return ui.locked
    case 'shape':
      return (SHAPE_MEMBERS as readonly string[]).includes(t)
    case 'line':
      return (LINE_MEMBERS as readonly string[]).includes(t)
    case 'freedraw':
      return t === 'freedraw' && pen.active !== 'highlighter'
    case 'highlighter':
      return t === 'freedraw' && pen.active === 'highlighter'
    default:
      return t === id
  }
}

const SEGS: Segment[] = ['left', 'mid', 'right']

export default function BoardToolbar({
  api,
  ui,
  refs,
}: {
  api: ExcalidrawImperativeAPI | null
  ui: BoardUi
  refs: ToolRefs
}): React.JSX.Element | null {
  const { t } = useI18n()
  const saved = useSyncExternalStore(subscribeToolbarLayout, getToolbarLayout, getToolbarLayout)
  // 拖动中渲染的是**预览布局**:每次 pointermove 直接算出新布局并渲染,让位效果就自然有了,
  // 不用再单独做一套「占位槽」的几何。松手才落盘。
  const [drag, setDrag] = useState<{ id: ToolId; layout: ToolbarLayout } | null>(null)
  const start = useRef<{ x: number; y: number; id: ToolId; moved: boolean } | null>(null)
  const rootRef = useRef<HTMLDivElement>(null)
  const layout = drag?.layout ?? saved

  if (!api) return null
  const g = refs.group.current
  const pen = refs.pen.current

  /** 落点:先按 x 找段(命中段矩形,否则取最近的),段内再按各按钮中心线定下标。 */
  const dropAt = (clientX: number, id: ToolId): { seg: Segment; index: number } | null => {
    const root = rootRef.current
    if (!root) return null
    let seg: Segment | null = null
    let best = Infinity
    for (const s of SEGS) {
      const el = root.querySelector<HTMLElement>(`[data-seg="${s}"]`)
      if (!el) continue
      const r = el.getBoundingClientRect()
      if (clientX >= r.left && clientX <= r.right) {
        seg = s
        break
      }
      const d = clientX < r.left ? r.left - clientX : clientX - r.right
      if (d < best) {
        best = d
        seg = s
      }
    }
    if (!seg) return null
    const btns = [...root.querySelectorAll<HTMLElement>(`[data-seg="${seg}"] [data-tool]`)]
    let index = btns.length
    for (let i = 0; i < btns.length; i++) {
      const r = btns[i].getBoundingClientRect()
      if (clientX < r.left + r.width / 2) {
        index = i
        break
      }
    }
    // 摘掉自己之后下标要往前挪一格(同段且在落点之前时)
    const from = btns.findIndex((b) => b.dataset.tool === id)
    if (from >= 0 && from < index) index--
    return { seg, index }
  }

  const onDown = (e: React.PointerEvent<HTMLButtonElement>, id: ToolId): void => {
    if (e.button !== 0) return
    start.current = { x: e.clientX, y: e.clientY, id, moved: false }
    e.currentTarget.setPointerCapture(e.pointerId)
  }
  const onMove = (e: React.PointerEvent<HTMLButtonElement>): void => {
    const s = start.current
    if (!s) return
    if (!s.moved && Math.hypot(e.clientX - s.x, e.clientY - s.y) < 5) return
    s.moved = true
    const at = dropAt(e.clientX, s.id)
    if (!at) return
    setDrag({ id: s.id, layout: moveTool(saved, s.id, at.seg, at.index) })
  }
  // ⚠️ 激活走 **click**,不走 pointerup:pointerup 版本键盘回车点不动,`el.click()` 也点不动
  //    (只派发 click,不派发 pointer 事件)—— 无障碍和仪器双输。pointer 三件只负责拖拽,
  //    拖过就用 skipClick 把随后那个 click 吃掉。
  //    ⚠️ 这个「吃掉一次 click」的闸必须是**时间窗**,不能是布尔标志:拖拽结束时指针多半已经不在
  //       起手那颗按钮上了,而浏览器在 down/up 落在不同元素时**根本不派发 click** —— 布尔标志就没人
  //       清,于是拖完之后下一次点任何工具都被吞掉(2026-08-14 被 L19 抓到)。
  const skipClickAt = useRef(0)
  const onUp = (e: React.PointerEvent<HTMLButtonElement>): void => {
    const s = start.current
    start.current = null
    e.currentTarget.releasePointerCapture?.(e.pointerId)
    skipClickAt.current = s?.moved ? Date.now() : 0
    if (s?.moved && drag) setToolbarLayout(drag.layout)
    setDrag(null)
  }
  const onClick = (id: ToolId): void => {
    if (Date.now() - skipClickAt.current < 400) {
      skipClickAt.current = 0
      return
    }
    activateTool(id, api, refs)
  }

  return (
    <div className="amx-toolbar" ref={rootRef} data-dragging={drag ? '' : undefined}>
      {SEGS.map((seg, si) => (
        <div key={seg} className="amx-toolbar-seg" data-seg={seg}>
          {si > 0 && <span className="amx-toolbar-sep" aria-hidden />}
          {layout[seg].map((id, i) => {
            const Icon = iconOf(id, g)
            const on = isActive(id, ui, pen)
            const digit = seg === 'mid' ? digitFor(i) : null
            const label = t(LABEL_KEYS[id])
            return (
              <button
                key={id}
                type="button"
                data-tool={id}
                data-on={on || undefined}
                data-drag={drag?.id === id || undefined}
                className="amx-tool"
                title={digit ? `${label} — ${digit}` : label}
                aria-label={label}
                aria-pressed={on}
                onPointerDown={(e) => onDown(e, id)}
                onPointerMove={onMove}
                onPointerUp={onUp}
                onClick={() => onClick(id)}
                onPointerCancel={() => {
                  start.current = null
                  skipClickAt.current = 0
                  setDrag(null)
                }}
              >
                <Icon size={17} />
                {digit && <span className="amx-tool-key">{digit}</span>}
              </button>
            )
          })}
        </div>
      ))}
    </div>
  )
}
