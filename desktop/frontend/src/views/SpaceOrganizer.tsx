/**
 * Space 收纳面板:主页坞上「全部 · N」/ 右键空白,和命令「切换 Space」(缺省 ⌘⇧O)打开的是同一块(2026-11-02 主页方案第四轮)。
 * 主页里由 HomepageView 挂(点收纳夹走主页自己的弹层、启动带退场动效);别的 Space 里由 SpaceOrganizerHost 挂在
 * AmadeusOverlays 里,外面套一层 .hp-root 拿到主页的玻璃 token 与格子样式(homepage.css 文末)。
 * 格子、顺序、收纳夹读写的都是 homeShelf(= Ribbon 上区),不另存。
 */
import { useEffect, useRef, useState } from 'react'
import { create } from 'zustand'
import {
  DndContext, DragOverlay, KeyboardSensor, PointerSensor, closestCenter, pointerWithin, useSensor, useSensors,
  type CollisionDetection, type DragEndEvent,
} from '@dnd-kit/core'
import { SortableContext, rectSortingStrategy, sortableKeyboardCoordinates, useSortable } from '@dnd-kit/sortable'
import { CSS as DndCSS } from '@dnd-kit/utilities'
import { ChevronLeft, FolderOpen, FolderPlus, Grid2X2, Search, X } from 'lucide-react'
import { commandHotkeyText, getDetachApi, label, setActiveSpace, useRibbonStore, useSpaceStore, WINDOW_SPACE_ID, type SpaceDefinition } from '@lcl/engine'
import { isImeKeyEvent } from '@lcl/engine/ime'
import { askString } from '@amadeus/components/askString'
import { registerMessages, useI18n } from '../i18n'
import { shelfAddFolder, shelfMove, shelfMoveIntoFolder, shelfTiles, type ShelfTile } from './homeShelf'
import './homepage.css'

registerMessages({
  'home.organizer.search': { zh: '输入名字跳转', en: 'Type to jump' },
  'home.organizer.hintKey': { zh: '拖动调整顺序，拖到收纳夹上即可归类；在任何 Space 按 {key} 都能叫出这里', en: 'Drag to reorder or drop onto a folder. Press {key} in any Space to open this.' },
  'home.organizer.select': { zh: '选择', en: 'Select' },
  'home.organizer.open': { zh: '打开', en: 'Open' },
  'home.organizer.back': { zh: '返回', en: 'Back' },
  'home.organizer.folderName': { zh: '收纳夹', en: 'Folder' },
  'home.organizer.noMatch': { zh: '没有叫这个名字的 Space', en: 'No Space matches' },
  'home.showAllKey': { zh: '全部 Spaces（{key}）', en: 'All Spaces ({key})' },
  'home.organizer.titleAll': { zh: '收纳', en: 'Organizer' },
  'home.organizer.tab.spaces': { zh: 'Space', en: 'Spaces' },
  'home.organizer.tab.widgets': { zh: '小组件', en: 'Widgets' },
  'home.organizer.tab.parts': { zh: '主页组件', en: 'Home parts' },
  'home.organizer.widgetCount': { zh: '{n} 个小组件', en: '{n} widgets' },
  'home.organizer.partCount': { zh: '{n} 个主页组件', en: '{n} Home parts' },
})

/** 主页里的收纳多两个标签(主页第三 / 四轮):小组件、主页组件;Space 标签就是原来这块。别处(⌘⇧O)只有 Space。 */
export type OrganizerTab = 'spaces' | 'widgets' | 'parts'
export interface OrganizerTabs {
  tab: OrganizerTab
  onTab: (tab: OrganizerTab) => void
  panes: Record<'widgets' | 'parts', { node: React.ReactNode; count: number; footer: string }>
}

/** 命令「切换 Space」的 id(bootstrapEngine 注册;缺省键 mod+shift+o)。提示里的键跟着用户改的键走。 */
export const SWITCH_SPACE_COMMAND = 'set-active-space'

/** 指针拖放以「指针真正在谁里面」为准,避免 body zoom 下 active rect 中心偏移选错落点;
 * 键盘拖放没有 pointerCoordinates,回落 closestCenter 保留方向键可访问性。 */
export const dockCollision: CollisionDetection = (args) => {
  const hits = pointerWithin(args)
  return hits.length ? hits : closestCenter(args)
}

export function TileVisual({ tile }: { tile: ShelfTile }) {
  if (tile.kind === 'space') {
    return (
      <>
        <span className="hp-tile-icon">{tile.space.icon && <tile.space.icon size={21} />}</span>
        <span className="hp-tile-name">{label(tile.space.name)}</span>
      </>
    )
  }
  return (
    <>
      <span className="hp-tile-icon hp-fpreview">
        {tile.members.slice(0, 4).map((member) => (
          <span key={member.id} className="hp-fmini">{member.icon && <member.icon size={11} />}</span>
        ))}
        {tile.members.length === 0 && <FolderOpen size={19} />}
      </span>
      <span className="hp-tile-name">{tile.folder.name}</span>
      <span className="hp-folder-count">{tile.members.length}</span>
    </>
  )
}

export function SortableTile({
  tile, over, open, sel, current, disabled, onOpen, onLaunch, onMenu,
}: {
  tile: ShelfTile
  over: boolean
  open: boolean
  /** 键盘选中(收纳面板里方向键挪的那一格)。 */
  sel?: boolean
  /** 当前所在的 Space(名字下面一个小点)。 */
  current?: boolean
  /** 搜索结果 / 夹内成员不是顶层序,不能拿来重排。 */
  disabled?: boolean
  onOpen: (el: HTMLElement, id: string) => void
  onLaunch: (spaceId: string) => void
  onMenu?: (event: React.MouseEvent, id: string) => void
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: tile.id, disabled })
  const name = tile.kind === 'space' ? label(tile.space.name) : tile.folder.name
  const style: React.CSSProperties = {
    transform: DndCSS.Transform.toString(transform),
    transition: transition ? `${transition}, color var(--duration-fast) var(--ease-surface), background var(--duration-fast) var(--ease-surface)` : undefined,
  }
  return (
    <button
      ref={setNodeRef}
      type="button"
      style={style}
      className={`hp-tile${tile.kind === 'folder' ? ' hp-folder' : ''}${isDragging ? ' dragging' : ''}${open ? ' on' : ''}`}
      data-id={tile.id}
      data-over={over || undefined}
      data-sel={sel || undefined}
      data-current={current || undefined}
      aria-label={name}
      title={name}
      {...attributes}
      {...listeners}
      onClick={(event) => {
        if (isDragging) return
        if (tile.kind === 'folder') { event.stopPropagation(); onOpen(event.currentTarget, tile.id) }
        else onLaunch(tile.space.id)
      }}
      onContextMenu={tile.kind === 'folder' && onMenu ? (event) => onMenu(event, tile.id) : undefined}
    >
      <TileVisual tile={tile} />
    </button>
  )
}

const asTile = (space: SpaceDefinition): ShelfTile => ({ kind: 'space', id: `space:${space.id}`, space })

export function SpaceOrganizer({
  onClose, onLaunch, byKey = false, skip, onOpenFolder, onFolderMenu, onDragStart, tabs,
}: {
  tabs?: OrganizerTabs
  onClose: () => void
  onLaunch: (spaceId: string) => void
  /** 用快捷键 / 命令打开:搜索框聚焦、默认选中上一个用过的 Space、底部写按键。 */
  byKey?: boolean
  /** 不显示的 Space(主页里排掉主页自己)。 */
  skip?: string
  /** 点收纳夹:主页交给自己的弹层;没给 = 在面板里就地展开。 */
  onOpenFolder?: (el: HTMLElement, id: string) => void
  onFolderMenu?: (event: React.MouseEvent, id: string) => void
  /** 开始拖动(主页借它收掉收纳夹右键菜单)。 */
  onDragStart?: () => void
}) {
  const { t } = useI18n()
  const spaces = useSpaceStore((s) => s.spaces)
  const active = useSpaceStore((s) => s.activeSpaceId)
  const order = useRibbonStore((s) => s.order)
  const folders = useRibbonStore((s) => s.folders)
  const { tiles } = shelfTiles(spaces, order, folders, skip)
  const [query, setQuery] = useState('')
  const [scope, setScope] = useState<string | null>(null)
  const [drag, setDrag] = useState<string | null>(null)
  const [over, setOver] = useState<string | null>(null)
  const holds = (x: ShelfTile, id: string): boolean => (x.kind === 'space' ? x.space.id === id : x.members.some((m) => m.id === id))
  // 上一个用过的 Space(快捷键打开时默认选中它;它在收纳夹里就先选夹子,展开后再选中它)
  const [prevId] = useState(() => {
    if (!byKey) return null
    const { recent, activeSpaceId } = useSpaceStore.getState()
    return recent.find((id) => id !== activeSpaceId && tiles.some((x) => holds(x, id))) ?? null
  })
  const [sel, setSel] = useState(() => (byKey ? Math.max(0, prevId ? tiles.findIndex((x) => holds(x, prevId)) : 0) : -1))
  const gridRef = useRef<HTMLDivElement>(null)
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  )

  const q = query.trim().toLowerCase()
  const folder = scope ? tiles.find((x) => x.id === scope && x.kind === 'folder') : undefined
  // ponytail: 只按名字和 Space id 匹配(输入 cal 也能找到日历);拼音首字母要等仓里有拼音表再加
  const shown: ShelfTile[] = q
    ? tiles.flatMap((x) => (x.kind === 'space' ? [x.space] : x.members))
      .filter((s) => label(s.name).toLowerCase().includes(q) || s.id.toLowerCase().includes(q)).map(asTile)
    : folder?.kind === 'folder' ? folder.members.map(asTile) : tiles
  const sorting = !q && !folder
  const cur = Math.min(sel, shown.length - 1)
  const activeTile = drag ? tiles.find((x) => x.id === drag) : undefined

  const activate = (tile: ShelfTile, el?: HTMLElement | null): void => {
    if (tile.kind === 'space') { launched.current = true; onClose(); onLaunch(tile.space.id); return }
    if (onOpenFolder && el) { onOpenFolder(el, tile.id); return }
    setScope(tile.id)
    setSel(byKey ? Math.max(0, tile.members.findIndex((m) => m.id === prevId)) : -1)
  }

  // Esc:夹内 → 回顶层,否则收起。挂在捕获阶段 —— 用鼠标打开时焦点不在面板里。
  // 焦点在别的浮层里(收纳上面又开了 ⌘K 等)、新建收纳夹的输入框或收纳夹右键菜单开着、正在键盘拖放时,Esc 归它们。
  const live = useRef({ scope, drag, onClose })
  live.current = { scope, drag, onClose }
  useEffect(() => {
    const onEsc = (e: KeyboardEvent): void => {
      const a = document.activeElement
      const mine = !a || a === document.body || !!a.closest('.hp-root')
      if (e.key !== 'Escape' || isImeKeyEvent(e) || !mine || live.current.drag || [...document.querySelectorAll('.dialog-overlay, .ctx-menu')].some((x) => x.getClientRects().length)) return
      e.preventDefault()
      e.stopPropagation()
      if (live.current.scope) setScope(null)
      else live.current.onClose()
    }
    window.addEventListener('keydown', onEsc, true)
    return () => window.removeEventListener('keydown', onEsc, true)
  }, [])

  // 快捷键打开会抢走焦点(搜索框);没切走就收起时还给原来的输入框 / 编辑器。别的浮层接走了焦点就不抢。
  const launched = useRef(false)
  useEffect(() => {
    if (!byKey) return
    const from = document.activeElement as HTMLElement | null
    return () => {
      const a = document.activeElement
      if (!launched.current && from?.isConnected && (!a || a === document.body)) from.focus()
    }
  }, [byKey])

  const onKeyDown = (e: React.KeyboardEvent): void => {
    // 只管搜索框里的方向键 / 回车:焦点在格子上归 dnd-kit 的键盘拖放,在关闭 / 新建 / 返回钮上归按钮自己
    if (isImeKeyEvent(e) || !(e.target as HTMLElement).closest('.hp-organizer-search')) return
    const cols = gridRef.current ? getComputedStyle(gridRef.current).gridTemplateColumns.split(' ').filter(Boolean).length || 1 : 1
    const step = ({ ArrowLeft: -1, ArrowRight: 1, ArrowUp: -cols, ArrowDown: cols } as Record<string, number>)[e.key]
    if (step !== undefined && shown.length) {
      e.preventDefault()
      setSel((s) => (s < 0 ? 0 : Math.max(0, Math.min(shown.length - 1, s + step))))
    } else if (e.key === 'Enter' && cur >= 0) {
      e.preventDefault()
      const tile = shown[cur]
      activate(tile, gridRef.current?.querySelector<HTMLElement>(`[data-id="${CSS.escape(tile.id)}"]`))
    }
  }

  const dragEnd = (event: DragEndEvent): void => {
    const moved = String(event.active.id)
    const targetId = event.over ? String(event.over.id) : null
    setDrag(null)
    setOver(null)
    if (!targetId || moved === targetId) return
    const target = tiles.find((x) => x.id === targetId)
    if (!moved.startsWith('folder:') && target?.kind === 'folder') shelfMoveIntoFolder(targetId, moved)
    else shelfMove(moved, targetId)
  }

  const newFolder = (): void => {
    void askString(t('home.newFolder'), t('home.organizer.folderName')).then((v) => {
      const n = v?.trim()
      if (n) shelfAddFolder(n)
    })
  }

  const key = commandHotkeyText(SWITCH_SPACE_COMMAND)
  const count = spaces.filter((s) => s.id !== skip).length
  const tab: OrganizerTab = tabs?.tab ?? 'spaces'
  const pane = tab === 'spaces' ? null : tabs?.panes[tab] ?? null
  return (
    <div className="hp-organizer-stage" onClick={onClose}>
      <section className="hp-organizer-panel" aria-label={t('home.organizer.title')} onClick={(event) => event.stopPropagation()} onKeyDown={onKeyDown}>
        <header className="hp-organizer-head">
          <div>
            {folder?.kind === 'folder'
              ? <button type="button" className="hp-organizer-mark" onClick={() => setScope(null)} aria-label={t('home.organizer.back')}><ChevronLeft size={16} /></button>
              : <span className="hp-organizer-mark"><Grid2X2 size={16} /></span>}
            <span><strong>{t(tabs ? 'home.organizer.titleAll' : 'home.organizer.title')}</strong><small>{pane
              ? t(tab === 'widgets' ? 'home.organizer.widgetCount' : 'home.organizer.partCount', { n: pane.count })
              : folder?.kind === 'folder' ? folder.folder.name : t('home.spaceCount', { n: count })}</small></span>
          </div>
          {tabs && (
            <div className="hp-organizer-tabs" role="tablist">
              {(['spaces', 'widgets', 'parts'] as const).map((k) => (
                <button key={k} type="button" role="tab" aria-selected={tab === k} className={tab === k ? 'on' : ''} data-tab={k} onClick={() => tabs.onTab(k)}>{t(`home.organizer.tab.${k}`)}</button>
              ))}
            </div>
          )}
          {!pane && <label className="hp-organizer-search">
            <Search size={13} />
            <input
              value={query}
              autoFocus={byKey}
              spellCheck={false}
              placeholder={t('home.organizer.search')}
              aria-label={t('home.organizer.search')}
              onChange={(event) => { setQuery(event.target.value); setSel(event.target.value.trim() ? 0 : -1) }}
            />
          </label>}
          <button type="button" onClick={onClose} aria-label={t('common.close')}><X size={16} /></button>
        </header>
        {pane ? <div className="hp-organizer-pane" role="tabpanel">{pane.node}</div> : <DndContext
          sensors={sensors}
          collisionDetection={dockCollision}
          onDragStart={(event) => { setDrag(String(event.active.id)); onDragStart?.() }}
          onDragOver={(event) => setOver(event.over ? String(event.over.id) : null)}
          onDragCancel={() => { setDrag(null); setOver(null) }}
          onDragEnd={dragEnd}
        >
          <SortableContext items={shown.map((x) => x.id)} strategy={rectSortingStrategy}>
            <div ref={gridRef} className="hp-organizer-grid">
              {shown.map((tile, i) => (
                <SortableTile
                  key={tile.id}
                  tile={tile}
                  over={over === tile.id}
                  open={false}
                  sel={i === cur}
                  current={tile.kind === 'space' && tile.space.id === active}
                  disabled={!sorting}
                  onOpen={(el) => activate(tile, el)}
                  onLaunch={() => activate(tile)}
                  onMenu={onFolderMenu}
                />
              ))}
              {sorting && (
                <button type="button" className="hp-organizer-new" onClick={newFolder}>
                  <span><FolderPlus size={22} /></span>
                  <small>{t('home.newFolder')}</small>
                </button>
              )}
              {!shown.length && <div className="hp-organizer-empty">{t('home.organizer.noMatch')}</div>}
            </div>
          </SortableContext>
          <DragOverlay dropAnimation={null}>
            {activeTile && (
              <div className={`hp-tile hp-drag-overlay${activeTile.kind === 'folder' ? ' hp-folder' : ''}`}>
                <TileVisual tile={activeTile} />
              </div>
            )}
          </DragOverlay>
        </DndContext>}
        <footer>
          {pane ? pane.footer : byKey
            ? <span className="hp-organizer-keys"><span><kbd>← → ↑ ↓</kbd> {t('home.organizer.select')}</span><span><kbd>↵</kbd> {t('home.organizer.open')}</span><span><kbd>Esc</kbd> {t('common.close')}</span></span>
            : key ? t('home.organizer.hintKey', { key }) : t('home.organizer.hint')}
        </footer>
      </section>
    </div>
  )
}

/** 进某个 Space。Space 窗口锁在自己的 Space 上,切不走:改成把那个 Space 开到它自己的窗口(同主页磁贴)。 */
export function launchSpace(spaceId: string): void {
  const open = WINDOW_SPACE_ID ? getDetachApi()?.openSpace : undefined
  if (open) open(spaceId)
  else setActiveSpace(spaceId)
}

const useHostStore = create<{ open: boolean }>(() => ({ open: false }))
let homeToggle: (() => void) | null = null

/** 主页开着时由主页自己开合(收纳夹弹层、退场动效都在那边)。返回注销函数;只清自己登记的那一个。 */
export function setHomeOrganizerToggle(fn: () => void): () => void {
  homeToggle = fn
  return () => { if (homeToggle === fn) homeToggle = null }
}

/** 命令「切换 Space」给人用的那一半:开合收纳面板(再按一次收起)。 */
export function toggleSpaceOrganizer(): void {
  if (homeToggle && useSpaceStore.getState().activeSpaceId === 'home') homeToggle()
  else useHostStore.setState((s) => ({ open: !s.open }))
}

/** 主页以外的 Space 里按 ⌘⇧O 弹出来的那一块(挂在主窗口的 AmadeusOverlays 里)。换了 Space 就收起。 */
export function SpaceOrganizerHost() {
  const open = useHostStore((s) => s.open)
  const active = useSpaceStore((s) => s.activeSpaceId)
  useEffect(() => { useHostStore.setState({ open: false }) }, [active])
  if (!open) return null
  const close = (): void => useHostStore.setState({ open: false })
  return (
    <div className="hp-root hp-organizer-host">
      <SpaceOrganizer byKey onClose={close} onLaunch={launchSpace} />
    </div>
  )
}
