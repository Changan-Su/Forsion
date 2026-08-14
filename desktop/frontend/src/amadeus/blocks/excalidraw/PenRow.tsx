/** 自定义笔那一排(荧光笔 / 钢笔 / 马克笔 …)。
 *
 *  ⚠️ 2026-08-14 搬家:原来挂在引擎的 `renderTopLeftUI` 槽(汉堡菜单旁边一张浮岛),
 *     现在按用户要求收进**左侧属性面板**(选中自由画笔时才出现)—— 见 PanelExtras.tsx。
 *     主工具栏那颗「荧光笔」按钮走的是同一个 `pickPen`,笔的选中态**只有 penState 一个真源**。
 *
 *  笔的参数表见 pens.ts(抄自 obsidian-excalidraw-plugin);能吃这些参数的只有 zsviczian fork
 *  —— 上游把 perfect-freehand 的 options 写死在渲染器里,fork 把它挪到了 appState.currentStrokeOptions。
 *
 *  行为照插件的 ObsidianMenu:
 *  - 点一支笔 = 套上它的参数 + 切到自由画笔;再点同一支 = 还原成你自己的颜色/线宽。
 *  - `freedrawOnly` 的笔离开自由画笔时要**临时还原**(否则画个矩形也是荧光黄),切回来再套上。
 *    还原用的快照存在引擎的 `appState.resetCustomPen` 里(fork 专门为此加的字段),不是我们自己记的。
 *  ponytail: 不做「自定义笔槽」(把预设存进 appState.customPens 再开面板改参数)—— 那是插件里
 *    909 行的 PenSettingsModal。要调参数直接用引擎的属性面板,线宽/颜色/填充一个没少。
 */
import { useEffect } from 'react'
import { Brush, Feather, Highlighter, PenLine, PenTool, Pencil, Slash } from 'lucide-react'
import { CaptureUpdateAction } from './forkRuntime'
import { PENS, PEN_LABELS, PEN_ORDER, type PenStyle, type PenType } from './pens'
import type { AppState, ExcalidrawImperativeAPI } from '@excalidraw/excalidraw/types'
import type { ObsidianResetCustomPenState } from '@excalidraw/excalidraw/obsidianTypes'
import type { BoardUi } from './boardUi'

export const PEN_ICONS: Record<PenType, typeof Brush> = {
  default: Pencil,
  finetip: PenLine,
  fountain: Feather,
  marker: Brush,
  highlighter: Highlighter,
  'thick-thin': PenTool,
  'thin-thick-thin': Slash,
}

/** 线宽:0.25/0.5/1/2/4 走引擎的 5 档键,其它值落 currentItemStrokeWidth 这个自由数(fork 保留的旧字段)。 */
const WIDTH_KEYS: Record<number, string> = { 0.25: 'extraThin', 0.5: 'thin', 1: 'medium', 2: 'bold', 4: 'extraBold' }
const widthPatch = (w: number): Partial<AppState> => {
  const key = WIDTH_KEYS[w]
  // ⚠️ 没用上的那个必须显式写 null 把它清掉,否则和上一支笔的设定混在一起。
  return key
    ? ({ currentItemStrokeWidthKey: key, currentItemStrokeWidth: null } as unknown as Partial<AppState>)
    : ({ currentItemStrokeWidthKey: null, currentItemStrokeWidth: w } as unknown as Partial<AppState>)
}

/** 荧光笔档下的「快选色」:把引擎默认那排最后一颗橙 `#f08c00` 换成黄,其余四颗照旧(用户口径)。
 *
 *  ⚠️ 这是**唯一**的通道:`appState.colorPalette.topPicks.elementStroke`(fork 专门给 Obsidian 宿主
 *  留的口子)。`<Excalidraw>` 的 props / UIOptions / ImperativeAPI 里一个相关口子都没有,
 *  `getDefaultColorPalette` 是只读 getter 不是 setter。好处是它**不进存档** ——
 *  存储表里 `colorPalette: {browser:false, export:false, server:false}`,改它不污染 .excalidraw。
 *  ⚠️ 用户自己 pin 过的 `colorTopPicks` 优先级**高于**我们这份(引擎的三级设计:用户 > 宿主 > 默认)。
 *     pin 过的人看不到这颗黄,那是对的,别去压他。
 *  ⚠️ 紧凑档根本不画这条快选色(引擎判据:面板形态不是 full/tray 就不渲染),
 *     所以它只在**常规档**与紧凑档的「Stroke」合并弹层里露面。
 *  类型上 colorPalette 要求四个键齐全,但引擎读的时候每一层都是 `?.` + `??` 兜底 —— 只给 topPicks
 *  是运行时合法的,故这里带一个断言。 */
const HL_COLOR_PALETTE = {
  topPicks: { elementStroke: ['#1e1e1e', '#e03131', '#2f9e44', '#1971c2', '#ffd43b'] },
} as unknown as AppState['colorPalette']

function applyPen(pen: PenStyle, api: ExcalidrawImperativeAPI): void {
  const st = api.getAppState()
  api.updateScene({
    appState: {
      // ⚠️ 必须传**副本**:引擎把 currentStrokeOptions 按引用烘焙进每条笔画的 customData
      //    —— 直接把模块级常量塞进去,以后谁原地改一下 PENS,已经画过的笔全会跟着变。
      currentStrokeOptions: { ...pen.penOptions, options: { ...pen.penOptions.options } },
      // 只有荧光笔换调色盘;其余笔显式写回 undefined,免得从荧光笔切过去还留着黄。
      colorPalette: pen.type === 'highlighter' ? HL_COLOR_PALETTE : undefined,
      ...(pen.strokeWidth ? widthPatch(pen.strokeWidth) : null),
      currentItemStrokeVariability: pen.penOptions?.constantPressure ? 'constant' : 'variable',
      ...(pen.backgroundColor ? { currentItemBackgroundColor: pen.backgroundColor } : null),
      ...(pen.strokeColor ? { currentItemStrokeColor: pen.strokeColor } : null),
      ...(pen.fillStyle ? { currentItemFillStyle: pen.fillStyle } : null),
      ...(pen.roughness !== null ? { currentItemRoughness: pen.roughness } : null),
      // 只在**第一次**套笔时记快照 —— 已经有快照说明当前这套是笔的,再记就把笔自己记进去了。
      ...(!st.resetCustomPen
        ? {
            resetCustomPen: {
              currentItemStrokeWidthKey: st.currentItemStrokeWidthKey ?? null,
              currentItemStrokeWidth: st.currentItemStrokeWidth ?? null,
              currentItemStrokeVariability: st.currentItemStrokeVariability ?? null,
              currentItemBackgroundColor: st.currentItemBackgroundColor ?? null,
              currentItemStrokeColor: st.currentItemStrokeColor ?? null,
              currentItemFillStyle: st.currentItemFillStyle ?? null,
              currentItemRoughness: st.currentItemRoughness ?? null,
            },
          }
        : null),
    } as Partial<AppState> as Pick<AppState, keyof AppState>,
    captureUpdate: CaptureUpdateAction.NEVER, // 换笔不是场景变更,别进 undo 栈
  })
}

function resetPen(snapshot: ObsidianResetCustomPenState | null, api: ExcalidrawImperativeAPI, clearStrokeOptions: boolean): void {
  api.updateScene({
    appState: {
      ...(snapshot
        ? {
            currentItemStrokeWidthKey: snapshot.currentItemStrokeWidthKey ?? null,
            currentItemStrokeWidth: snapshot.currentItemStrokeWidth ?? null,
            currentItemStrokeVariability: snapshot.currentItemStrokeVariability ?? null,
            currentItemBackgroundColor: snapshot.currentItemBackgroundColor ?? null,
            currentItemStrokeColor: snapshot.currentItemStrokeColor ?? null,
            currentItemFillStyle: snapshot.currentItemFillStyle ?? null,
            currentItemRoughness: snapshot.currentItemRoughness ?? null,
          }
        : null),
      resetCustomPen: null,
      ...(clearStrokeOptions ? { currentStrokeOptions: null, colorPalette: undefined } : null),
    } as Partial<AppState> as Pick<AppState, keyof AppState>,
    captureUpdate: CaptureUpdateAction.NEVER,
  })
}

/** 选中的笔 + 「刚点下、工具还没切过来」那一拍的挡板。
 *  ⚠️ **必须由画布持有,不能是组件自己的 ref**:笔排在面板里,而面板每次换工具都会重挂;
 *  ref 归零而引擎里的 `resetCustomPen`/`currentStrokeOptions` 还在 —— 结果是笔看着没选中、
 *  离开自由画笔也不还原(画个矩形还是荧光黄)。工具栏那颗荧光笔按钮读的也是这一份。 */
export type PenState = { active: PenType | null; pending: boolean }
export const newPenState = (): PenState => ({ active: null, pending: false })

/** 点一支笔(工具栏的荧光笔按钮和面板里的笔排共用)。再点同一支 = 还原。 */
export function pickPen(api: ExcalidrawImperativeAPI, state: React.RefObject<PenState>, type: PenType): void {
  const s = state.current
  const st = api.getAppState()
  if (s.active === type && st.activeTool.type === 'freedraw') {
    s.active = null
    s.pending = false
    resetPen(st.resetCustomPen as ObsidianResetCustomPenState | null, api, true)
    return
  }
  s.active = type
  s.pending = true
  // 顺序照插件:先套参数再切工具(两条都是异步落 appState,靠 pending 挡住中间那一拍)。
  applyPen(PENS[type], api)
  api.setActiveTool({ type: 'freedraw' })
}

/** 端头:方(`cap:false`,平切)/ 圆(`cap:true`)。
 *
 *  ⚠️⚠️ **`thinning` 必须一起钉成 0,否则这个开关是死的** —— 实测(2026-08-14,像素剖面):
 *    thinning=1 时 `cap:true` 与 `cap:false` 画出来**逐像素相同**,末端那段收拢是 thinning 造成的;
 *    thinning=0 之后才分得出「一刀切到 0」与「多一段圆顶」。所以这里显式写死,
 *    别改成「只翻 cap 不动别的」—— 那样万一预设里 thinning 被改回去,按钮就静默失效了。
 *  ⚠️ `taper` 同样钉 0:`cap:false` 配非零 taper 出来的是**尖头**不是方头。 */
export function setPenCap(api: ExcalidrawImperativeAPI, round: boolean): void {
  const cur = api.getAppState().currentStrokeOptions
  if (!cur?.options) return
  api.updateScene({
    appState: {
      currentStrokeOptions: {
        ...cur,
        options: {
          ...cur.options,
          thinning: 0,
          start: { ...cur.options.start, cap: round, taper: 0 },
          end: { ...cur.options.end, cap: round, taper: 0 },
        },
      },
    } as Partial<AppState> as Pick<AppState, keyof AppState>,
    captureUpdate: CaptureUpdateAction.NEVER, // 换端头不是场景变更
  })
}

/** 无条件把笔卸掉(主工具栏点「笔」时用:笔 ≠ 荧光笔,不能带着荧光参数进普通自由画笔)。 */
export function clearPen(api: ExcalidrawImperativeAPI, state: React.RefObject<PenState>): void {
  const s = state.current
  if (!s.active) return
  s.active = null
  s.pending = false
  resetPen(api.getAppState().resetCustomPen as ObsidianResetCustomPenState | null, api, true)
}

/** freedrawOnly 的笔:离开自由画笔临时还原(留着 currentStrokeOptions,切回来还是这支笔),切回来再套上。
 *  ⚠️ 必须挂在**画布**上而不是笔排组件里 —— 笔排只在选中自由画笔时才渲染,而这条恰恰要在
 *     「离开自由画笔」那一刻起作用,挂在笔排上等于永远不触发。 */
export function usePenRestore(api: ExcalidrawImperativeAPI | null, tool: string, snapshot: ObsidianResetCustomPenState | null, state: React.RefObject<PenState>): void {
  const s = state.current
  // ⚠️ 「刚点下笔」那一拍:`updateScene` 已经把快照写进去了,而 `setActiveTool` 还没落到 appState ——
  //    这一帧看到的是「有快照 + 工具还不是自由画笔」,正好命中下面的还原分支,笔就被自己撤销了
  //    (症状:第一次点荧光笔没反应,画出来还是上一个工具)。照插件的 pendingPenActivation 挡一拍。
  if (s.pending && tool === 'freedraw') s.pending = false
  useEffect(() => {
    const cur = s.active
    if (!api || !cur || s.pending) return
    const pen = PENS[cur]
    if (!pen.freedrawOnly) return
    if (tool !== 'freedraw' && snapshot) resetPen(snapshot, api, false)
    else if (tool === 'freedraw' && !snapshot) applyPen(pen, api)
  }, [api, s, tool, snapshot])
}

/** 属性面板里的笔排。7 支固定笔,选中态 = penState.active。 */
export default function PenRow({
  api,
  ui,
  state,
}: {
  api: ExcalidrawImperativeAPI | null
  ui: BoardUi
  state: React.RefObject<PenState>
}): React.JSX.Element | null {
  const s = state.current
  const tool = ui.tool
  if (!api) return null
  return (
    // ponytail: 图标一律 currentColor 不染成笔色 —— 「粗到细」两支是 #CECDCC(给深色底用的),
    //   染上去在浅色下几乎看不见,认笔靠 title 就够。
    <div className="amx-penrow buttonList">
      {PEN_ORDER.map((type) => {
        const Icon = PEN_ICONS[type]
        const on = s.active === type && tool === 'freedraw'
        return (
          <label key={type} className={on ? 'active' : ''} title={PEN_LABELS[type]} data-on={on || undefined} onClick={() => pickPen(api, state, type)}>
            <Icon size={16} aria-label={PEN_LABELS[type]} />
          </label>
        )
      })}
    </div>
  )
}
