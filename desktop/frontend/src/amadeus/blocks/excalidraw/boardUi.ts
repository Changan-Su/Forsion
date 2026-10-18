/** 我们自己的 UI 要用的那一小片 appState。
 *
 *  为什么不直接传 appState:自建工具栏/面板是 **portal 进引擎 DOM** 的,拿不到引擎的 React 数据流,
 *  只能从 `onChange` 回捞。而 onChange 在**一笔画的过程中每帧都来** —— 整份 appState 存进 state
 *  等于每帧重渲一次工具栏。所以只留下面这几个字段,并在画布里做「没变就不 setState」的比对,
 *  画画时一次重渲都不会有。
 */
import type { ObsidianResetCustomPenState } from '@excalidraw/excalidraw/obsidianTypes'

export type BoardUi = {
  /** activeTool.type;自定义工具也照原样带过来 */
  tool: string
  /** activeTool.locked = 「画完保持工具选中」 */
  locked: boolean
  /** 引擎替我们记的「套笔前长什么样」快照(fork 专有字段),笔的还原逻辑要它 */
  snapshot: ObsidianResetCustomPenState | null
  /** 当前笔迹的端头:true=圆头 / false=方头 / null=没套自定义笔。荧光笔面板的「笔触」两颗按钮读它。 */
  capRound: boolean | null
  /** 视图岛(ViewIsland)读的几个开关;都是引擎 appState 同名字段,只在切换时变,画画时不动。 */
  grid: boolean
  gridSize: number
  gridStep: number
  snap: boolean
  view: boolean
  zen: boolean
  pen: boolean
  penDetected: boolean
}

export const newBoardUi = (): BoardUi => ({
  tool: 'selection', locked: false, snapshot: null, capRound: null,
  grid: false, gridSize: 20, gridStep: 5, snap: false, view: false, zen: false, pen: false, penDetected: false,
})

const KEYS = Object.keys(newBoardUi()) as (keyof BoardUi)[]
export const sameBoardUi = (a: BoardUi, b: BoardUi): boolean => KEYS.every((k) => a[k] === b[k])
