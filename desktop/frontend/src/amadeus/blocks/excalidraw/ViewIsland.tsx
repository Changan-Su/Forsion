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
  'boardview.gridMajor': { zh: '粗线', en: 'Major lines' },
  'boardview.gridMajorPre': { zh: '每', en: 'every' },
  'boardview.gridMajorPost': { zh: '格一条', en: 'cells' },
  'boardview.gridDir': { zh: '方向', en: 'Direction' },
  'boardview.dirBoth': { zh: '方格', en: 'Square' },
  'boardview.dirH': { zh: '只横线', en: 'Horizontal only' },
  'boardview.dirV': { zh: '只竖线', en: 'Vertical only' },
  'boardview.opacity': { zh: '淡浓', en: 'Opacity' },
  'boardview.noSnapHint': { zh: '拖动时按住 {key} 临时不吸附', en: 'Hold {key} while dragging to skip snapping' },
  'boardview.paperNoSnap': { zh: '纸张模式下网格只画线，不吸附', en: 'In paper mode the grid is drawn only, without snapping' },
  'boardview.escHint': { zh: '按 Esc 退出全屏', en: 'Press Esc to exit full screen' },
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
      if (e.key === 'Escape') setPop(false)
    }
    window.addEventListener('pointerdown', down, true)
    window.addEventListener('keydown', key, true)
    return () => {
      window.removeEventListener('pointerdown', down, true)
      window.removeEventListener('keydown', key, true)
    }
  }, [pop])

  const btn = (key: string, Icon: typeof Eye, label: string, on: boolean, onClick: () => void, extra?: React.ButtonHTMLAttributes<HTMLButtonElement>): React.JSX.Element => (
    <button key={key} type="button" className="amx-tool" data-view={key} data-on={on || undefined} aria-pressed={on} aria-label={label} title={label} onClick={onClick} {...extra}>
      <Icon size={17} />
    </button>
  )

  return (
    <div className="amx-viewisle-wrap" ref={wrapRef}>
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
        <div className="amx-gridpop-row">
          <span className="amx-bs-lbl">{t('boardview.gridSize')}</span>
          <NumField value={model.size} min={GRID_MIN} max={GRID_MAX} onCommit={(v) => grid.set({ size: v })} />
          <span className="amx-bs-note">px</span>
        </div>
        {major !== null && (
          <div className="amx-gridpop-row">
            <span className="amx-bs-lbl">{t('boardview.gridMajor')}</span>
            <span className="amx-bs-note">{t('boardview.gridMajorPre')}</span>
            <NumField value={major} min={1} max={100} onCommit={(v) => grid.set({ major: v })} />
            <span className="amx-bs-note">{t('boardview.gridMajorPost')}</span>
          </div>
        )}
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
          <span className="amx-bs-note">{op}%</span>
        </label>
        <div className="amx-bs-note">{grid.snaps ? t('boardview.noSnapHint', { key: MOD }) : t('boardview.paperNoSnap')}</div>
      </div>
    </div>
  )
}

/** 数字框:打字时不夹,失焦 / 回车才夹进范围并提交。 */
function NumField({ value, min, max, onCommit }: { value: number; min: number; max: number; onCommit: (v: number) => void }): React.JSX.Element {
  const [txt, setTxt] = useState(String(value))
  useEffect(() => setTxt(String(value)), [value])
  const commit = (): void => {
    const n = Math.round(Number(txt))
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
      onChange={(e) => setTxt(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Enter') commit()
      }}
    />
  )
}
