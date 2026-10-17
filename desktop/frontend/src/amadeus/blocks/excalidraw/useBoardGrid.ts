/** 网格的两条路由(规则见 board.ts「网格:两条路」),视图岛和画布都只认这里折出来的一份 GridModel。
 *
 *  | 情形 | 谁说了算 | Cmd+' / 右键「切换网格显示」 |
 *  |---|---|---|
 *  | 无限画布 | 引擎 appState(gridModeEnabled / gridSize / gridStep,进场景 JSON)+ frontmatter 的方向、淡浓 | 引擎自己切 |
 *  | 无限画布 + 老网格(gridH / gridV 还在) | 覆盖层,直到用户第一次碰网格 | 引擎一开 → 当场转成引擎网格,不留两层 |
 *  | 纸张模式 | 覆盖层(gridH / gridV),引擎网格恒关 | 引擎一开 → 关掉它、改切覆盖层 |
 *  | 纸张 ↔ 无限切换 | 开着的网格跟过去(引擎 ↔ 覆盖层互转) | — |
 *
 *  打开文件不写盘:老网格只在用户动手时才转;唯一例外是文件里已经存着「两层同时开」的坏状态,
 *  第一次 onChange 就把它收成一层。
 *
 *  ⚠️ 写设置是异步的(drawingStore.setSettings:先 flush 场景、预读盘面、写、再解析回 props),这期间
 *  props 还是旧值。自己发出去的改动先记进 `pend` 叠在 props 上:否则连点两下第二次基于旧值,
 *  老网格的迁移还会在每次 onChange 里重放(updateScene → onChange → updateScene,死循环)。 */
import { useCallback, useEffect, useReducer, useRef } from 'react'
import { CaptureUpdateAction } from './forkRuntime'
import type { AppState, ExcalidrawImperativeAPI } from '@excalidraw/excalidraw/types'
import {
  DEFAULT_MAJOR,
  clampGrid,
  engineDirection,
  engineGridColor,
  legacyToEngine,
  overlayFields,
  overlayModel,
  paperSize,
  type BoardSettings,
  type GridModel,
} from '@amadeus-shared/excalidraw/board'
import type { BoardUi } from './boardUi'

export type GridPatch = Partial<GridModel> & { major?: number }

export interface BoardGrid {
  model: GridModel
  /** 每几格一条粗线;纸张模式的覆盖层没有粗线 → null(面板藏掉这一行)。 */
  major: number | null
  /** 引擎网格才吸附;纸张覆盖层只是画出来的线。 */
  snaps: boolean
  /** 淡浓(含还没落盘的那次)。 */
  opacity: number
  set: (patch: GridPatch) => void
  /** 拖淡浓滑杆时的实时预览(不写盘)。 */
  previewOpacity: (v: number) => void
  /** 松手:结束预览并写盘。 */
  commitOpacity: (v: number) => void
  /** 画布 onChange 里调,见文件头的表。 */
  onAppState: (st: AppState) => void
}

const clampMajor = (n: number): number => Math.min(100, Math.max(1, Math.round(n) || DEFAULT_MAJOR))

export function useBoardGrid(
  api: ExcalidrawImperativeAPI | null,
  ui: BoardUi,
  settings: BoardSettings,
  onSettings: (patch: Partial<BoardSettings>) => void,
  host: React.RefObject<HTMLElement | null>,
): BoardGrid {
  const pend = useRef<Partial<BoardSettings>>({})
  const [, bump] = useReducer((n: number) => n + 1, 0)
  // 落盘回来了的键就不用再叠。ponytail: 写失败的键会一直叠着(本次挂载内仍按用户的选择显示),重开白板即清
  for (const k of Object.keys(pend.current) as (keyof BoardSettings)[]) if (settings[k] === pend.current[k]) delete pend.current[k]
  const s: BoardSettings = { ...settings, ...pend.current }

  const paper = !!paperSize(s)
  const legacy = paper ? undefined : legacyToEngine(s)
  const overlay = paper || legacy !== undefined
  // 覆盖层「关」= 两个键都写 0,格距和方向就没了 —— 关掉前的样子记在这里,再打开 / 关着时改格距、方向都用它
  const om = overlayModel(s)
  const lastOverlay = useRef<GridModel>(om)
  if (om.on) lastOverlay.current = om
  const model: GridModel = overlay ? (om.on ? om : { ...lastOverlay.current, on: false }) : { on: ui.grid, size: ui.gridSize, dir: s.gridDir }
  const major = paper ? null : legacy !== undefined ? DEFAULT_MAJOR : ui.gridStep

  // onChange / updateScene 回调里要读最新值,不能被闭包冻住
  const live = useRef({ settings, onSettings })
  live.current = { settings, onSettings }
  /** 当下的有效设置:props + 还没落盘的(pend 是 ref,比这次渲染算出的 s 还新)。 */
  const now = (): BoardSettings => ({ ...live.current.settings, ...pend.current })
  /** 先记 pend 再发 —— 紧跟着的 updateScene 可能同步回调 onChange,那时就得看到这次改动。 */
  const write = (p: Partial<BoardSettings>): void => {
    Object.assign(pend.current, p)
    live.current.onSettings(p)
    bump()
  }

  const scene = useCallback(
    (appState: Partial<AppState>) => api?.updateScene({ appState: appState as AppState, captureUpdate: CaptureUpdateAction.NEVER }),
    [api],
  )

  const set = (patch: GridPatch): void => {
    if (!api) return
    if (paper) {
      const next = { ...model, ...patch, size: clampGrid(patch.size ?? model.size) }
      lastOverlay.current = { ...next, on: true }
      if (next.on || model.on) write(overlayFields(next))
      else bump() // 关着改格距 / 方向:只记住,不写盘
      return
    }
    // 老网格:第一次碰就转成引擎网格(以它当前的样子为起点)
    const base = legacy !== undefined ? { ...model, size: clampGrid(model.size) } : model
    const next = { ...base, ...patch, size: clampGrid(patch.size ?? base.size) }
    const sp: Partial<BoardSettings> = {}
    if (next.dir !== s.gridDir) sp.gridDir = next.dir
    if (legacy !== undefined) Object.assign(sp, { gridH: 0, gridV: 0 })
    if (Object.keys(sp).length) write(sp)
    scene({
      gridModeEnabled: next.on,
      gridSize: next.size,
      gridStep: clampMajor(patch.major ?? major ?? DEFAULT_MAJOR),
      gridDirection: engineDirection(next.dir),
      ...(next.on ? { objectsSnapModeEnabled: false } : {}), // 和引擎的 actionToggleGridMode 同一条互斥
    })
  }

  // 引擎网格的淡浓预览:onChange 里的漂移校正要认它,否则推上去的预览色立刻被按旧值打回
  const preview = useRef<number | null>(null)
  const previewOpacity = (v: number): void => {
    if (!overlay) {
      preview.current = v
      return void scene({ gridColor: engineGridColor(v) })
    }
    // 只改自己这块画布的层(同时开着别的白板时别串台)
    for (const g of host.current?.querySelectorAll<HTMLElement>('.amx-grid') ?? []) g.style.opacity = v >= 100 ? '' : String(v / 100)
  }
  const commitOpacity = (v: number): void => {
    preview.current = null
    if (v !== s.gridOpacity) write({ gridOpacity: v })
    else if (!overlay) scene({ gridColor: engineGridColor(v) })
  }

  // 方向 / 淡浓不落盘(引擎 APP_STATE_STORAGE_CONF 里 export:false):挂载和改设置时下发
  useEffect(() => {
    scene({ gridDirection: engineDirection(s.gridDir), gridColor: engineGridColor(s.gridOpacity) })
  }, [scene, s.gridDir, s.gridOpacity])

  // 纸张 ↔ 无限:开着的网格跟过去。首次挂载不算切换。
  const prevPaper = useRef(paper)
  useEffect(() => {
    const was = prevPaper.current
    prevPaper.current = paper
    if (!api || was === paper) return
    const st = api.getAppState()
    const cur = now()
    if (paper && st.gridModeEnabled) {
      write(overlayFields({ on: true, size: clampGrid(st.gridSize), dir: cur.gridDir }))
      scene({ gridModeEnabled: false })
    } else if (!paper && (cur.gridH > 0 || cur.gridV > 0)) {
      const m = overlayModel(cur)
      write({ gridH: 0, gridV: 0, gridDir: m.dir })
      scene({ gridModeEnabled: true, gridSize: clampGrid(m.size), gridDirection: engineDirection(m.dir), objectsSnapModeEnabled: false })
    }
  }, [api, paper]) // eslint-disable-line react-hooks/exhaustive-deps -- 只认 paper 的翻转

  const seen = useRef(false)
  const prevOn = useRef(false)
  const onAppState = (st: AppState): void => {
    const first = !seen.current
    seen.current = true
    const turnedOn = st.gridModeEnabled && !prevOn.current
    prevOn.current = st.gridModeEnabled
    const cur = now()
    if (paperSize(cur)) {
      if (!st.gridModeEnabled) return
      prevOn.current = false
      // 第一次 = 文件里存着的坏状态,只收掉;之后 = 用户按了 Cmd+' / 右键,改切覆盖层
      if (!first && turnedOn) {
        const m = overlayModel(cur)
        write(overlayFields(m.on ? { ...m, on: false } : { ...lastOverlay.current, on: true }))
      }
      scene({ gridModeEnabled: false })
      return
    }
    if (legacyToEngine(cur) !== undefined && st.gridModeEnabled) {
      // 老网格 + 引擎网格同时开 → 收成引擎网格一层(write 先清掉 gridH / gridV,所以只会走一次)
      const m = overlayModel(cur)
      write({ gridH: 0, gridV: 0, gridDir: m.dir })
      scene({ gridSize: clampGrid(m.size), gridDirection: engineDirection(m.dir) })
      return
    }
    // 重置画布 / 打开文件会把方向和颜色打回引擎缺省:漂了就补回
    const dir = engineDirection(cur.gridDir)
    const color = engineGridColor(preview.current ?? cur.gridOpacity)
    if (st.gridDirection?.horizontal !== dir.horizontal || st.gridDirection?.vertical !== dir.vertical || st.gridColor?.Regular !== color.Regular) {
      scene({ gridDirection: dir, gridColor: color })
    }
  }

  return { model, major, snaps: !paper, opacity: s.gridOpacity, set, previewOpacity, commitOpacity, onAppState }
}
