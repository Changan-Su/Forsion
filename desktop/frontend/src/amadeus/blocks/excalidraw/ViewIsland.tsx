/** 底部视图岛:网格 · 吸附 · 查看 · 禅 · 全屏(检测到手写笔时最前面多一颗笔模式)。
 *  方案 A,2026-10-17 用户选定,方案页 docs/ToBeImproved/白板操作借鉴方案_2026-10-17/。
 *
 *  挂在引擎的 `<Footer>` 槽(.footer-center)里:紧贴撤销岛,禅模式下随引擎自带的过渡一起滑走,
 *  不用像工具胶囊那样盯着引擎 DOM 补挂点。开关都由画布经 `api.updateScene` 改 appState ——
 *  **不传受控 prop**,传了引擎对应的快捷键和右键项就失效。 */
import { useEffect, useRef, useState } from 'react'
import { Eye, Focus, Grid3x3, Magnet, Maximize2, Minimize2, PenLine } from 'lucide-react'
import { registerMessages, useI18n } from '../../../i18n'
import { GRID_MAX, GRID_MIN, type GridDir } from '@amadeus-shared/excalidraw/board'
import type { BoardGrid } from './useBoardGrid'
import type { BoardUi } from './boardUi'

registerMessages({
  'boardview.island': { zh: '视图', en: 'View' },
  'boardview.grid': { zh: '网格', en: 'Grid' },
  'boardview.snap': { zh: '吸附至对象', en: 'Snap to objects' },
  'boardview.view': { zh: '查看模式', en: 'View mode' },
  'boardview.zen': { zh: '禅模式', en: 'Zen mode' },
  'boardview.full': { zh: '全屏', en: 'Full screen' },
  'boardview.exitFull': { zh: '退出全屏', en: 'Exit full screen' },
  'boardview.pen': { zh: '笔模式', en: 'Pen mode' },
  'boardview.gridShow': { zh: '显示网格，拖动时吸附到格点', en: 'Show grid and snap to it' },
  'boardview.gridShowPaper': { zh: '显示网格', en: 'Show grid' },
  'boardview.gridSize': { zh: '格距', en: 'Grid size' },
  'boardview.gridMajor': { zh: '粗线间隔', en: 'Major every' },
  'boardview.gridMajorPost': { zh: '格', en: 'cells' },
  'boardview.gridDir': { zh: '方向', en: 'Direction' },
  'boardview.dirBoth': { zh: '方格', en: 'Both' },
  'boardview.dirH': { zh: '只横线', en: 'Horizontal' },
  'boardview.dirV': { zh: '只竖线', en: 'Vertical' },
  'boardview.opacity': { zh: '淡浓', en: 'Opacity' },
  'boardview.noSnapHint': { zh: '拖动时按住 {key} 临时不吸附', en: 'Hold {key} while dragging to skip snapping' },
  'boardview.paperNoSnap': { zh: '纸张模式下网格只画线，不吸附', en: 'In paper mode the grid is drawn only, without snapping' },
})

const MAC = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.userAgent)
const MOD = MAC ? 'Cmd' : 'Ctrl'
const ALT = MAC ? 'Option' : 'Alt'

/** 存**键**不存文案:模块作用域的文案会在加载时冻住,切语言不更新。 */
const DIRS: { id: GridDir; labelKey: string }[] = [
  { id: 'both', labelKey: 'boardview.dirBoth' },
  { id: 'h', labelKey: 'boardview.dirH' },
  { id: 'v', labelKey: 'boardview.dirV' },
]

export type ViewToggle = 'snap' | 'view' | 'zen' | 'pen'

export default function ViewIsland({
  ui,
  grid,
  onToggle,
  full,
  onFull,
}: {
  ui: BoardUi
  grid: BoardGrid
  onToggle: (k: ViewToggle) => void
  full: boolean
  onFull: () => void
}): React.JSX.Element {
  const { t } = useI18n()
  const [pop, setPop] = useState(false)
  const wrapRef = useRef<HTMLDivElement>(null)

  // 点岛外 / Esc 收起浮层。捕获阶段:画布自己会吃掉 pointerdown。
  useEffect(() => {
    if (!pop) return
    const down = (e: PointerEvent): void => {
      if (!wrapRef.current?.contains(e.target as Node)) setPop(false)
    }
    const key = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape') return
      e.preventDefault() // 这一下只收浮层:全屏的 Esc 监听认 defaultPrevented,不会连全屏一起退
      setPop(false)
    }
    window.addEventListener('pointerdown', down, true)
    window.addEventListener('keydown', key, true)
    return () => {
      window.removeEventListener('pointerdown', down, true)
      window.removeEventListener('keydown', key, true)
    }
  }, [pop])

  // 禅模式下整座岛滑走并藏起来,焦点要是还在岛上就掉到 body —— 引擎只在自己的容器上听键,Option+Z / Cmd+' 全失灵。
  // 进禅时焦点在岛上(点了岛上任一颗再按 Option+Z,或直接点禅)→ 交回画布容器。
  useEffect(() => {
    const wrap = wrapRef.current
    if (ui.zen && wrap?.contains(document.activeElement)) wrap.closest<HTMLElement>('.excalidraw-container')?.focus({ preventScroll: true })
  }, [ui.zen])

  const btn = (key: string, Icon: typeof Eye, label: string, on: boolean, onClick: () => void, extra?: React.ButtonHTMLAttributes<HTMLButtonElement>): React.JSX.Element => (
    <button key={key} type="button" className="amx-tool" data-view={key} data-on={on || undefined} aria-pressed={on} aria-label={label} title={label} onClick={onClick} {...extra}>
      <Icon size={17} />
    </button>
  )

  return (
    <div className="amx-viewisle-wrap" ref={wrapRef} data-viewmode={ui.view || undefined}>
      {pop && <GridPopover grid={grid} />}
      <div className="amx-viewisle" role="toolbar" aria-label={t('boardview.island')}>
        {ui.penDetected && btn('pen', PenLine, t('boardview.pen'), ui.pen, () => onToggle('pen'))}
        {btn('grid', Grid3x3, `${t('boardview.grid')} — ${MOD}+'`, grid.model.on, () => {
          // 开的那一下顺带弹出设置;关就连浮层一起收。右键随时打开设置。
          grid.set({ on: !grid.model.on })
          setPop(!grid.model.on)
        }, {
          onContextMenu: (e) => {
            e.preventDefault()
            setPop(true)
          },
        })}
        {btn('snap', Magnet, `${t('boardview.snap')} — ${ALT}+S`, ui.snap, () => onToggle('snap'))}
        {btn('view', Eye, `${t('boardview.view')} — ${ALT}+R`, ui.view, () => onToggle('view'))}
        {btn('zen', Focus, `${t('boardview.zen')} — ${ALT}+Z`, ui.zen, () => onToggle('zen'))}
        {btn('full', full ? Minimize2 : Maximize2, full ? t('boardview.exitFull') : t('boardview.full'), full, onFull)}
      </div>
    </div>
  )
}

function GridPopover({ grid }: { grid: BoardGrid }): React.JSX.Element {
  const { t } = useI18n()
  const { model, major, opacity } = grid
  const [op, setOp] = useState(opacity)
  useEffect(() => setOp(opacity), [opacity])
  return (
    <div className="amx-gridpop" role="dialog" aria-label={t('boardview.grid')}>
      <div className="amx-bs">
        <div className="amx-gridpop-h">
          <span>{t('boardview.grid')}</span>
          <span className="amx-gridpop-kbd">{MOD}+'</span>
        </div>
        <label className="amx-bs-check">
          <input type="checkbox" checked={model.on} onChange={(e) => grid.set({ on: e.target.checked })} />
          <span className="amx-bs-lbl">{grid.snaps ? t('boardview.gridShow') : t('boardview.gridShowPaper')}</span>
        </label>
        {/* 三列网格:两行的数字框落在同一列(走查 P3-12) */}
        <div className="amx-gridpop-nums">
          <span className="amx-bs-lbl">{t('boardview.gridSize')}</span>
          <NumField value={model.size} min={GRID_MIN} max={GRID_MAX} onCommit={(v) => grid.set({ size: v })} />
          <span className="amx-bs-note">px</span>
          {major !== null && (
            <>
              <span className="amx-bs-lbl">{t('boardview.gridMajor')}</span>
              <NumField value={major} min={1} max={100} onCommit={(v) => grid.set({ major: v })} />
              <span className="amx-bs-note">{t('boardview.gridMajorPost')}</span>
            </>
          )}
        </div>
        <div className="amx-bs-h">{t('boardview.gridDir')}</div>
        <div className="amx-bs-row">
          {DIRS.map((d) => (
            <button key={d.id} type="button" className="amx-bs-chip" data-on={model.dir === d.id || undefined} onClick={() => grid.set({ dir: d.id })}>
              {t(d.labelKey)}
            </button>
          ))}
        </div>
        {/* 淡浓:拖动只预览,松手才写盘 —— 每动一格写一次文件太蠢 */}
        <label className="amx-gridpop-row">
          <span className="amx-bs-lbl">{t('boardview.opacity')}</span>
          <input
            className="amx-bs-range"
            type="range"
            min={10}
            max={100}
            step={5}
            value={op}
            onChange={(e) => {
              const n = Number(e.target.value)
              setOp(n)
              grid.previewOpacity(n)
            }}
            onPointerUp={() => grid.commitOpacity(op)}
            onKeyUp={() => grid.commitOpacity(op)}
          />
          <span className="amx-bs-note amx-gridpop-pct">{op}%</span>
        </label>
        <div className="amx-bs-note">{grid.snaps ? t('boardview.noSnapHint', { key: MOD }) : t('boardview.paperNoSnap')}</div>
      </div>
    </div>
  )
}

/** 数字框:打字时不夹,失焦 / 回车才夹进范围并提交;↑↓ 和框上的小箭头是整步改值,当场提交(走查 P3-5)。 */
function NumField({ value, min, max, onCommit }: { value: number; min: number; max: number; onCommit: (v: number) => void }): React.JSX.Element {
  const [txt, setTxt] = useState(String(value))
  useEffect(() => setTxt(String(value)), [value])
  // 这次改值来自 ↑↓ / 框右侧的小箭头(点小箭头没有按键事件,看按下的位置);接着打字的第一个键会把它清掉。
  // 步进的提交晚 150ms、只认最后一下:按住不放时不至于每一步都整份读写一次文件(纸张模式走 frontmatter)
  const stepping = useRef(false)
  const timer = useRef<number | undefined>(undefined)
  useEffect(() => () => window.clearTimeout(timer.current), [])
  const commit = (raw: string): void => {
    window.clearTimeout(timer.current)
    const n = Math.round(Number(raw))
    const v = Number.isFinite(n) && n > 0 ? Math.min(max, Math.max(min, n)) : value
    setTxt(String(v))
    if (v !== value) onCommit(v)
  }
  return (
    <input
      className="amx-bs-num"
      type="number"
      min={min}
      max={max}
      value={txt}
      onChange={(e) => {
        const raw = e.target.value
        setTxt(raw)
        if (!stepping.current) return
        window.clearTimeout(timer.current)
        timer.current = window.setTimeout(() => commit(raw), 150)
      }}
      onBlur={() => commit(txt)}
      onPointerDown={(e) => {
        // ponytail: 小箭头画在框右侧约 16px 里(Chromium / WebKit);别处按下 = 点进框里准备打字
        stepping.current = e.nativeEvent.offsetX > e.currentTarget.clientWidth - 18
      }}
      onKeyDown={(e) => {
        stepping.current = e.key === 'ArrowUp' || e.key === 'ArrowDown'
        if (e.key === 'Enter') commit(txt)
      }}
    />
  )
}
