/**
 * Homepage View —— 内置插件「主页」的主区视图(旧 `apps/Archived/Forsion-Desktop` 桌面首页在 LCL 里的重写)。
 *
 * 四块,自上而下:
 *  · **标志性标题** 「Forsion is All You Need」,手写体(随包 Dancing Script 子集,见 assets/fonts/README)。
 *    旧版这句住在 CardZone 的 title 区(SloganCard),这里做成固定排版。
 *  · **标题区** 时钟 + 日期 + 问候(登录名来自 `window.tangu.authStatus`)。
 *  · **输入区** `newChatComposer.tsx` 的 NewChatComposer(Tangu 经 tanguSeam 交出;插件经 ctx.tangu.mountComposer 挂的是同一份),里面就是 Tangu Chat View 的 `Composer2`:模型、模式、附件、引用、语音和命令
 *    一条不少;提交后切到 Tangu Space 并强制建新会话,不再兼任浏览器搜索。
 *  · **Space 收纳架** 旧版底部 Dock 那排 app,在 Genesis 里对应的东西就是 Space;
 *    应用市场、成就和用户额外钉住的 Space 住在独立前置区,竖线后的普通区才与 Ribbon 排序同步。
 *    首屏只露出一排,其余收进参考旧 Desktop Launchpad 的二级收纳层;「全部 Spaces」和空白右键都能进入。
 *
 * ⚠️**坞 = ribbon 上区的另一个投影,不是第二份数据**:顺序、收纳夹全部读写 `useRibbonStore`
 * 的同一份 order/folders。在坞里拖一下,ribbon 上跟着变,反之亦然 —— 用户只需要维护一种排列。
 * 收纳的语汇也照 ribbon 抄(显式新建收纳夹 + 拖进去),**不搬**旧 Launchpad 那套「悬停 500ms 合并成文件夹」:
 * 那会让同一个产品里出现两种建夹语法。
 *
 * 壁纸沿用旧 Desktop 的「舞台」语义,但不碰 Genesis 三轴主题 token:主题背景、Bing 每日壁纸、
 * IndexedDB 自定义原图是三个可切换来源;没有图片时也由 Genesis 主题 token 生成可取样的简约舞台。
 * 旧版窗口管理器与账号角仍不搬;浏览器搜索也不再回来。
 */
import { useEffect, useRef, useState } from 'react'
import { flushSync } from 'react-dom'
import {
  DndContext, DragOverlay, KeyboardSensor, PointerSensor, closestCenter, pointerWithin,
  useDraggable, useDroppable, useSensor, useSensors,
  type CollisionDetection,
  type DragCancelEvent, type DragEndEvent, type DragOverEvent, type DragStartEvent,
} from '@dnd-kit/core'
import { SortableContext, rectSortingStrategy, sortableKeyboardCoordinates, useSortable } from '@dnd-kit/sortable'
import { CSS as DndCSS } from '@dnd-kit/utilities'
import {
  ArrowUp, Check, FolderMinus, FolderOpen, FolderPlus, Grid2X2, Image, LogOut,
  Mic, Pencil, RefreshCw, Upload, X,
} from 'lucide-react'
import { setActiveSpace, useSpaceStore, useRibbonStore, label, OverlayAt, useNativeChromeSpaces, useNativeSheetMenu, presentNativeChecklist, getDetachApi, WINDOW_SPACE_ID, type SheetMenuItem } from '@lcl/engine'
import { CtxMenuButtons } from '../components/CtxMenuButtons'
import { shelfAddFolder, shelfMove, shelfMoveIntoFolder, shelfMoveOut, shelfRemoveFolder, shelfRenameFolder, shelfReorderFolder, shelfTiles, type ShelfTile } from './homeShelf'
import type { SpaceDefinition, RibbonItem, ViewProps } from '@lcl/engine'
import { askString } from '@amadeus/components/askString'
import { readTanguNewChat, type TanguNewChatDispatch } from '../amadeus/plugins/tanguSeam'
import { registerMessages, useI18n, type Locale } from '../i18n'
import { formatLongDate, formatTime } from '../format/time'
import {
  clearCustomWallpaper, fetchBingWallpapers, loadHomepageWallpaperPrefs, onHomepageWallpaperPrefsChange, readCustomWallpaper,
  saveHomepageWallpaperPrefs, writeCustomWallpaper,
  type BingWallpaper, type HomepageThemePreset, type HomepageWallpaperPrefs, type HomepageWallpaperSource,
} from './homepageWallpaper'
import { HomeWallpaperArt } from './homepageWallpaperArt'
import { DeskCardStatus, useCardStatus } from './homeCardStatus'
import { watchAccountName } from '../services/accountName'
import { DESKTOP_HOME_CARDS_KEY, HOME_CARDS_MAX, loadHomeCards, saveHomeCards, shownHomeCards } from './homeCards'
import './homepage.css'

/** 本视图所在的 Space id(真源在 builtins/homepage.tsx);坞里要把它自己排掉 —— 但**排序时不能排**,见 dropOn。 */
const SELF_SPACE = 'home'
/** 切走前的退场动效时长,须与 homepage.css 的 `.hp-stack.leaving` 一致。 */
const LEAVE_MS = 140
/** 首屏只留一排;超出的项收进「全部 Spaces」。收纳夹本身只占一格。 */
const COMPACT_TILE_LIMIT = 6
/** 这里只记主页额外副本,永远不参与 Ribbon 的 order/folders。 */
const PINNED_SPACES_KEY = 'forsion.homepage.pinned-spaces.v1'
const PINNED_DROP_ID = 'homepage:pinned-spaces'
const PINNED_DRAG_PREFIX = 'homepage:pinned:'
const FIXED_HOME_ACTIONS = ['rb-market', 'rb-achievements'] as const
const THEME_PRESETS: HomepageThemePreset[] = ['orbit', 'path', 'paper', 'rings', 'glyph']
const WALLPAPER_SOURCES: HomepageWallpaperSource[] = ['theme', 'bing', 'image']

/** 指针拖放以「指针真正在谁里面」为准,避免 body zoom 下 active rect 中心偏移选错落点;
 * 键盘拖放没有 pointerCoordinates,回落 closestCenter 保留方向键可访问性。 */
const dockCollision: CollisionDetection = (args) => {
  const hits = pointerWithin(args)
  return hits.length ? hits : closestCenter(args)
}

type Tile = ShelfTile

function TileVisual({ tile }: { tile: Tile }) {
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

function loadPinnedSpaceIds(): string[] {
  try {
    const value = JSON.parse(localStorage.getItem(PINNED_SPACES_KEY) || '[]')
    return Array.isArray(value)
      ? [...new Set(value.filter((id): id is string => typeof id === 'string' && id !== SELF_SPACE))]
      : []
  } catch { return [] }
}

function FixedHomeAction({ item }: { item: RibbonItem }) {
  const Icon = item.icon
  const name = item.tooltip ? label(item.tooltip) : ''
  return (
    <button
      type="button"
      className="hp-tile hp-pinned-action"
      data-fixed-id={item.id}
      draggable={false}
      aria-label={name || undefined}
      title={name}
      onClick={item.onClick}
    >
      <span className="hp-tile-icon">{Icon && <Icon size={21} />}</span>
      <span className="hp-tile-name">{name}</span>
    </button>
  )
}

function PinnedSpaceTile({ space, onLaunch }: { space: SpaceDefinition; onLaunch: (spaceId: string) => void }) {
  const id = `${PINNED_DRAG_PREFIX}${space.id}`
  const { attributes, listeners, setNodeRef, transform, isDragging } = useDraggable({ id })
  const tile: Tile = { kind: 'space', id: `space:${space.id}`, space }
  return (
    <button
      ref={setNodeRef}
      type="button"
      className={`hp-tile hp-pinned-space${isDragging ? ' dragging' : ''}`}
      data-space-id={space.id}
      style={{ transform: DndCSS.Transform.toString(transform) }}
      aria-label={label(space.name)}
      title={label(space.name)}
      {...attributes}
      {...listeners}
      onClick={() => { if (!isDragging) onLaunch(space.id) }}
    >
      <TileVisual tile={tile} />
    </button>
  )
}

function PinnedSpaceZone({
  actions, spaces, onLaunch, labelText,
}: {
  actions: RibbonItem[]
  spaces: SpaceDefinition[]
  onLaunch: (spaceId: string) => void
  labelText: string
}) {
  const { isOver, setNodeRef } = useDroppable({ id: PINNED_DROP_ID })
  return (
    <div ref={setNodeRef} className="hp-pinned-zone" data-over={isOver || undefined} aria-label={labelText}>
      {actions.map((item) => <FixedHomeAction key={item.id} item={item} />)}
      {spaces.map((space) => <PinnedSpaceTile key={space.id} space={space} onLaunch={onLaunch} />)}
    </div>
  )
}

function SortableTile({
  tile, over, open, onOpen, onLaunch, onMenu,
}: {
  tile: Tile
  over: boolean
  open: boolean
  onOpen: (event: React.MouseEvent, id: string) => void
  onLaunch: (spaceId: string) => void
  onMenu: (event: React.MouseEvent, id: string) => void
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: tile.id })
  const name = tile.kind === 'space' ? label(tile.space.name) : tile.folder.name
  const style: React.CSSProperties = {
    transform: DndCSS.Transform.toString(transform),
    transition: transition ? `${transition}, color var(--duration-fast) var(--ease-out), background var(--duration-fast) var(--ease-out)` : undefined,
  }
  return (
    <button
      ref={setNodeRef}
      type="button"
      style={style}
      className={`hp-tile${tile.kind === 'folder' ? ' hp-folder' : ''}${isDragging ? ' dragging' : ''}${open ? ' on' : ''}`}
      data-id={tile.id}
      data-over={over || undefined}
      aria-label={name}
      title={name}
      {...attributes}
      {...listeners}
      onClick={(event) => {
        if (isDragging) return
        if (tile.kind === 'folder') { event.stopPropagation(); onOpen(event, tile.id) }
        else onLaunch(tile.space.id)
      }}
      onContextMenu={tile.kind === 'folder' ? (event) => onMenu(event, tile.id) : undefined}
    >
      <TileVisual tile={tile} />
    </button>
  )
}

/** 二级收纳层里的应用格。成员 id 仍是 ribbon 的 `space:*`,重排直接写同一个 folder.items。 */
function SortableFolderMember({
  member, onLaunch, onMenu,
}: {
  member: SpaceDefinition
  onLaunch: (id: string) => void
  onMenu: (event: React.MouseEvent, id: string) => void
}) {
  const id = `space:${member.id}`
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id })
  return (
    <button
      ref={setNodeRef}
      type="button"
      className={`hp-folder-app${isDragging ? ' dragging' : ''}`}
      style={{ transform: DndCSS.Transform.toString(transform), transition }}
      data-id={id}
      title={label(member.name)}
      {...attributes}
      {...listeners}
      onClick={() => { if (!isDragging) onLaunch(member.id) }}
      onContextMenu={(event) => onMenu(event, id)}
    >
      <span className="hp-folder-app-icon">{member.icon && <member.icon size={24} />}</span>
      <span>{label(member.name)}</span>
    </button>
  )
}

/** 时钟。`setV` 回同一个对象引用时 React 直接跳过重渲 —— 于是 1s 轮询也只在**分钟真的变了**时才画一次。 */
function useClock(locale: Locale): { time: string; date: string; hour: number; minute: number } {
  const calc = (): { time: string; date: string; hour: number; minute: number } => {
    const d = new Date()
    return {
      time: formatTime(d),
      // 月日与星期之间留一口气(「8月27日 星期四」),见 format/time 的 formatLongDate。
      date: formatLongDate(d, { locale }),
      hour: d.getHours(),
      minute: d.getMinutes(),
    }
  }
  const [v, setV] = useState(calc)
  useEffect(() => {
    const tick = (): void => setV((p) => { const n = calc(); return n.time === p.time && n.date === p.date ? p : n })
    tick()
    const id = setInterval(tick, 1000)
    return () => clearInterval(id)
  }, [locale])
  return v
}

/** 登录名(有就用来问候);未登录 / 拿不到 → 空串,问候语自己少一截。读法见 services/accountName。 */
function useAccountName(): string {
  const [name, setName] = useState('')
  useEffect(() => watchAccountName(setName), [])
  return name
}

/** 坞的条目 = ribbon 上区的顶层条目(口径与两条不变式见 homeShelf.ts 的 shelfTiles)。 */
function useDockTiles(): { tiles: Tile[]; topIds: string[] } {
  const spaces = useSpaceStore((s) => s.spaces)
  const order = useRibbonStore((s) => s.order)
  const folders = useRibbonStore((s) => s.folders)
  return shelfTiles(spaces, order, folders, SELF_SPACE)
}

interface MenuState { x: number; y: number; kind: 'folder' | 'member' | 'cards'; id?: string }

registerMessages({
  'home.folderMenu.renameTitle': { zh: '重命名收纳夹', en: 'Rename folder' },
  'home.folderMenu.rename': { zh: '重命名', en: 'Rename' },
  'home.folderMenu.dissolve': { zh: '解散收纳夹', en: 'Dissolve folder' },
  'home.folderMenu.moveOut': { zh: '移出收纳夹', en: 'Move out' },
  // 手机(布局「二」):收起的输入条 + 带一行近况的大卡片
  'home.pill': { zh: '问点什么…', en: 'Ask anything…' },
  'home.cards.editTitle': { zh: '主页卡片', en: 'Home cards' },
  'home.cards.editHint': { zh: '勾选的显示在主页，1 到 {max} 张，按勾选的先后排。', en: 'Checked ones show on Home (1 to {max}), in the order you check them.' },
  'home.cards.done': { zh: '完成', en: 'Done' },
})

interface HomeCard { id: string; name: string; statusId: string; spaceId?: string; icon?: SpaceDefinition['icon'] | RibbonItem['icon']; open: () => void }

/** 手机主页的大卡片。单独成组件:近况要订阅会话 / 笔记 / 成就 / 插件四份状态,桌面的主页不该为它们多重画。
 *  放哪几张由用户定(长按任意一张,见 homeCards.ts);没改过 = 架子上头两个 Space + 商店、成就。 */
function HomeCards({ tiles, actions, onLaunch }: { tiles: Tile[]; actions: RibbonItem[]; onLaunch: (spaceId: string) => void }) {
  const { t } = useI18n()
  const status = useCardStatus()
  const [picked, setPicked] = useState(loadHomeCards)
  const spaceCard = (sp: SpaceDefinition): HomeCard => ({ id: `space:${sp.id}`, name: label(sp.name), statusId: sp.id, spaceId: sp.id, icon: sp.icon, open: () => onLaunch(sp.id) })
  const top = tiles.filter((tile): tile is Extract<Tile, { kind: 'space' }> => tile.kind === 'space').map((tile) => spaceCard(tile.space))
  // 可选的:架子上所有 Space(收纳夹里的也算)+ 商店、成就
  const all: HomeCard[] = [
    ...tiles.flatMap((tile) => (tile.kind === 'space' ? [tile.space] : tile.members)).map(spaceCard),
    ...actions.map((item): HomeCard => ({ id: item.id, name: item.tooltip ? label(item.tooltip) : '', statusId: item.id, icon: item.icon, open: () => item.onClick?.() })),
  ]
  const cards = shownHomeCards(picked, all, [...top.slice(0, 2), ...all.filter((c) => !c.spaceId)])

  /** 原生勾选清单:勾的时候半屏不动,关上时(完成 / 下滑 / 返回都算)一起生效;新勾的排在最后,至少留一张(没有卡片就没处长按)。
   *  没有原生宿主就什么都不出。 */
  const edit = async (): Promise<void> => {
    const ids = cards.map((c) => c.id)
    const out = await presentNativeChecklist({
      title: t('home.cards.editTitle'),
      items: all.map((c) => ({ id: `card:${c.id}`, label: c.name, icon: c.icon && 'imageUrl' in c.icon && c.icon.imageUrl ? c.icon.nativeFallback : c.icon })),
      checked: ids.map((id) => `card:${id}`),
      footer: t('home.cards.editHint', { max: String(HOME_CARDS_MAX) }),
      done: t('home.cards.done'),
      min: 1,
      max: HOME_CARDS_MAX,
    })
    const next = out.handled ? out.value?.checked.map((id) => id.slice('card:'.length)) : undefined
    // 原样关上 = 不记(没改过的人继续跟着缺省走)
    if (!next?.length || next.join('\n') === ids.join('\n')) return
    if (saveHomeCards(next)) setPicked(next)
  }

  return (
    <section className="hp-cards">
      {cards.map((c) => (
        <button
          key={c.id} type="button" className="hp-card"
          {...(c.spaceId ? { 'data-space-id': c.spaceId } : { 'data-fixed-id': c.id })}
          onClick={(event) => { event.stopPropagation(); c.open() }}
          // 长按(Android WebView 的 contextmenu,自带触感)= 改这几张卡片;松手不再算点击
          onContextMenu={(event) => { event.preventDefault(); event.stopPropagation(); void edit() }}
        >
          <span className="hp-card-icon">{c.icon && <c.icon />}</span>
          <span className="hp-card-name">{c.name}</span>
          <span className="hp-card-status">{status(c.statusId)}</span>
        </button>
      ))}
    </section>
  )
}

export function HomepageView(_props: ViewProps) {
  const { t, locale } = useI18n()
  const zh = locale === 'zh'
  const clock = useClock(locale)
  const name = useAccountName()
  // 手机(原生外壳画 Dock):布局「二」—— 问候在上、四张带近况的大卡片在下、输入区收成一条(homepage.css 文末 .hp-phone)。
  const phone = useNativeChromeSpaces()
  const spaces = useSpaceStore((s) => s.spaces)
  const ribbonItems = useRibbonStore((s) => s.items)
  const { tiles } = useDockTiles()
  const [pinnedSpaceIds, setPinnedSpaceIds] = useState(loadPinnedSpaceIds)
  const [drag, setDrag] = useState<string | null>(null)
  const [over, setOver] = useState<string | null>(null)
  const [organizerOpen, setOrganizerOpen] = useState(false)
  const [openFolder, setOpenFolder] = useState<{ id: string; dx: number; dy: number } | null>(null)
  const [menu, setMenu] = useState<MenuState | null>(null)
  const [leaving, setLeaving] = useState(false)
  const [composerFocused, setComposerFocused] = useState(false)
  const [wallpaperOpen, setWallpaperOpen] = useState(false)
  const [wallpaperPrefs, setWallpaperPrefs] = useState<HomepageWallpaperPrefs>(loadHomepageWallpaperPrefs)
  const [deskPicked, setDeskPicked] = useState(() => loadHomeCards(DESKTOP_HOME_CARDS_KEY))
  // 窗口最小化 / 被挡住 / 锁屏:壁纸动效停在原地(切到别的 Space 时主页本来就卸掉了)
  const [pageHidden, setPageHidden] = useState(() => document.hidden)
  const [customWallpaperUrl, setCustomWallpaperUrl] = useState<string | null>(null)
  const [bingWallpapers, setBingWallpapers] = useState<BingWallpaper[]>([])
  const [bingLoading, setBingLoading] = useState(false)
  const [wallpaperError, setWallpaperError] = useState('')
  const [bingReload, setBingReload] = useState(0)
  const rootRef = useRef<HTMLDivElement>(null)
  const fileRef = useRef<HTMLInputElement>(null)
  const leaveTimer = useRef<number | null>(null)
  const pending = useRef<(() => void) | null>(null)
  // 跟着系统实时变:壁纸面板里的「动态效果」在系统「减弱动态效果」关掉后要恢复成用户原来的选择。
  const [reduceMotion, setReduceMotion] = useState(() => { try { return window.matchMedia('(prefers-reduced-motion: reduce)').matches } catch { return false } })
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  )

  useEffect(() => { saveHomepageWallpaperPrefs(wallpaperPrefs) }, [wallpaperPrefs])
  // 设置 → 外观里的「主页壁纸动效」写的是同一份偏好。只跟这一项:整份换掉会把另一扇窗选的「自己的图片」带过来,
  // 而那张图(IndexedDB)这边没读过,画出来是主题背景(Codex 评审)。
  useEffect(() => onHomepageWallpaperPrefsChange(() => setWallpaperPrefs((cur) => {
    const motion = loadHomepageWallpaperPrefs().motion
    return motion === cur.motion ? cur : { ...cur, motion }
  })), [])
  useEffect(() => {
    const onVisibility = (): void => setPageHidden(document.hidden)
    document.addEventListener('visibilitychange', onVisibility)
    let mq: MediaQueryList | null = null
    const onMotion = (): void => setReduceMotion(!!mq?.matches)
    try { mq = window.matchMedia('(prefers-reduced-motion: reduce)'); mq.addEventListener('change', onMotion) } catch { /* 没有 matchMedia 就当不减弱 */ }
    return () => { document.removeEventListener('visibilitychange', onVisibility); mq?.removeEventListener('change', onMotion) }
  }, [])
  useEffect(() => {
    try { localStorage.setItem(PINNED_SPACES_KEY, JSON.stringify(pinnedSpaceIds)) } catch { /* ignore */ }
  }, [pinnedSpaceIds])

  // 自定义原图从 IndexedDB 读成临时 object URL;组件卸载/换图即回收,不泄漏 Blob 引用。
  useEffect(() => {
    let alive = true
    void readCustomWallpaper()
      .then((blob) => {
        if (!alive) return
        if (!blob) {
          setWallpaperPrefs((prefs) => prefs.source === 'image' ? { ...prefs, source: 'theme' } : prefs)
          return
        }
        setCustomWallpaperUrl(URL.createObjectURL(blob))
      })
      .catch(() => {})
    return () => { alive = false }
  }, [])
  useEffect(() => () => { if (customWallpaperUrl) URL.revokeObjectURL(customWallpaperUrl) }, [customWallpaperUrl])

  // 正在使用 Bing 时取目录。每日模式拿第一张;手选模式保留用户选中的历史项。
  useEffect(() => {
    if (wallpaperPrefs.source !== 'bing') return
    let alive = true
    setBingLoading(true)
    setWallpaperError('')
    void fetchBingWallpapers(locale)
      .then((items) => {
        if (!alive) return
        setBingWallpapers(items)
        if (items[0]) setWallpaperPrefs((prefs) => prefs.source === 'bing' && prefs.bingDaily && prefs.bing?.id !== items[0].id
          ? { ...prefs, bing: items[0] }
          : prefs)
      })
      .catch(() => { if (alive) setWallpaperError(t('home.wallpaper.bingError')) })
      .finally(() => { if (alive) setBingLoading(false) })
    return () => { alive = false }
  }, [bingReload, locale, t, wallpaperPrefs.source])

  // 卸载:定时器要清,但**待执行的动作不能跟着一起丢** —— 退场动效是装饰,
  // 用户按下的那一下不能因为动画还没放完就静默消失(Codex 评审 high:
  // 140ms 窗口内被切走 = 消息没发出去、输入框也已经空了,两头落空)。
  useEffect(() => () => {
    if (leaveTimer.current) { window.clearTimeout(leaveTimer.current); leaveTimer.current = null }
    const run = pending.current
    pending.current = null
    run?.()
  }, [])

  /** 切走之前先放退场动效(整栈缩淡),动完再真的执行。
   *  ⚠️**整段动作**搬进回调,不是只搬 setActiveSpace —— 发 Tangu 那条链
   *  (setActiveSpace → openNewChat → send)的顺序契约不许被动画拆开。
   *  重入守卫用 ref 不用 state:连点两下不能排出两次跳转。 */
  const leaveThen = (run: () => void): boolean => {
    if (leaveTimer.current) return false
    if (reduceMotion) { run(); return true }
    setLeaving(true)
    pending.current = run // 卸载兜底要拿得到(见上面的 cleanup)
    leaveTimer.current = window.setTimeout(() => {
      leaveTimer.current = null
      pending.current = null
      run()
      // 平时走到这里主页已经随 Space 切换卸掉了(这一笔落空)。没切走(主页开在自己的窗口里、锁在主页上;或目标没切成)
      // 就把缩淡收回来,不然整页一直是淡出去的样子。
      setLeaving(false)
    }, LEAVE_MS)
    return true
  }
  /** 点磁贴进某个 Space。主页开在自己的窗口里时(Space 窗口锁在主页上,切不走):改成把那个 Space 开到它自己的窗口。 */
  const launchSpace = (spaceId: string): void => {
    const open = WINDOW_SPACE_ID ? getDetachApi()?.openSpace : undefined
    if (open) open(spaceId)
    else leaveThen(() => setActiveSpace(spaceId))
  }

  const hasTangu = spaces.some((s) => s.id === 'tangu')
  // 新对话输入区是 Tangu 交出来的(核心插件化 2e-3);没有 Tangu Space 或 Tangu 没激活 = 不摆
  const newChat = hasTangu ? readTanguNewChat() : null

  const greet = clock.hour < 5 ? 'home.greet.night' : clock.hour < 11 ? 'home.greet.morning' : clock.hour < 18 ? 'home.greet.afternoon' : 'home.greet.evening'
  const greetText = name ? t(greet + '.named', { name }) : t(greet)
  const closePops = (): void => { setOpenFolder(null); setOrganizerOpen(false); setMenu(null) }
  const wallpaperUrl = wallpaperPrefs.source === 'bing'
    ? wallpaperPrefs.bing?.url || null
    : wallpaperPrefs.source === 'image' ? customWallpaperUrl : null
  // 「图片」来源还没上传图片时 photo 为假,背景仍画主题图
  const photo = !!wallpaperUrl

  const patchWallpaperPrefs = (patch: Partial<HomepageWallpaperPrefs>): void => {
    setWallpaperPrefs((prefs) => ({ ...prefs, ...patch }))
  }

  const selectWallpaperSource = (source: HomepageWallpaperSource): void => {
    if (source === 'bing') {
      patchWallpaperPrefs({ source, bing: wallpaperPrefs.bing || bingWallpapers[0] || null })
      return
    }
    patchWallpaperPrefs({ source })
  }

  const uploadCustomWallpaper = (file: File | undefined): void => {
    if (!file) return
    setWallpaperError('')
    void writeCustomWallpaper(file)
      .then(() => {
        setCustomWallpaperUrl(URL.createObjectURL(file))
        patchWallpaperPrefs({ source: 'image' })
      })
      .catch((error) => {
        setWallpaperError(t(error instanceof Error && error.message === 'TOO_LARGE'
          ? 'home.wallpaper.tooLarge'
          : 'home.wallpaper.invalid'))
      })
  }

  const removeCustomWallpaper = (): void => {
    void clearCustomWallpaper().catch(() => {})
    setCustomWallpaperUrl(null)
    patchWallpaperPrefs({ source: 'theme' })
  }

  // ── 收纳:重排 / 拖进收纳夹 ────────────────────────────────────────────────
  // 收纳的写法(两条不变式)都在 homeShelf.ts;这里只管收纳层的开合。
  const moveOut = (itemId: string): void => {
    shelfMoveOut(itemId)
    setOrganizerOpen(true) // 移出即回到收纳层,让用户立刻看到它回到了顶层。
  }

  const newFolder = (): void => {
    setMenu(null)
    void askString(zh ? '新建收纳夹' : 'New folder', zh ? '收纳夹' : 'Folder').then((v) => {
      const n = v?.trim()
      if (n) { shelfAddFolder(n); setOrganizerOpen(true) }
    })
  }

  const clearDrag = (): void => { setDrag(null); setOver(null) }
  const dragStart = (event: DragStartEvent): void => { setOpenFolder(null); setMenu(null); setDrag(String(event.active.id)) }
  const dragOver = (event: DragOverEvent): void => setOver(event.over ? String(event.over.id) : null)
  const dragCancel = (_event: DragCancelEvent): void => clearDrag()
  const dragEnd = (event: DragEndEvent): void => {
    const moved = String(event.active.id)
    const targetId = event.over ? String(event.over.id) : null
    clearDrag()
    if (moved.startsWith(PINNED_DRAG_PREFIX)) {
      // 前置副本拖回前置区 = 不动;拖到普通区或任何区外 = 只删副本,不碰 Ribbon。
      if (targetId !== PINNED_DROP_ID) {
        const spaceId = moved.slice(PINNED_DRAG_PREFIX.length)
        setPinnedSpaceIds((ids) => ids.filter((id) => id !== spaceId))
      }
      return
    }
    if (targetId === PINNED_DROP_ID) {
      const tile = tiles.find((item) => item.id === moved)
      if (tile?.kind === 'space' && tile.space.id !== SELF_SPACE) {
        setPinnedSpaceIds((ids) => ids.includes(tile.space.id) ? ids : [...ids, tile.space.id])
      }
      return
    }
    if (!targetId || moved === targetId) return
    const target = tiles.find((tile) => tile.id === targetId)
    if (!moved.startsWith('folder:') && target?.kind === 'folder') shelfMoveIntoFolder(targetId, moved)
    else shelfMove(moved, targetId)
  }

  const menuAt = (e: React.MouseEvent, kind: MenuState['kind'], id?: string): void => {
    e.preventDefault(); e.stopPropagation()
    setOpenFolder(null)
    setMenu({ x: e.clientX, y: e.clientY, kind, id })
  }

  const openFolderTile = (e: React.MouseEvent, id: string): void => {
    const tileRect = (e.currentTarget as HTMLElement).getBoundingClientRect()
    const rootRect = rootRef.current?.getBoundingClientRect()
    setMenu(null)
    setOrganizerOpen(false)
    setOpenFolder((folder) => folder?.id === id ? null : {
      id,
      dx: rootRect ? tileRect.left + tileRect.width / 2 - (rootRect.left + rootRect.width / 2) : 0,
      dy: rootRect ? tileRect.top + tileRect.height / 2 - (rootRect.top + rootRect.height / 2) : 0,
    })
  }

  const folderOpen = openFolder ? tiles.find((x) => x.id === openFolder.id) : undefined
  const folderMembers = folderOpen?.kind === 'folder' ? folderOpen.members : []
  // 桌面近况卡:可选的是架子上所有 Space(收纳夹里的也算);没改过 = 架子上头四个。摆成卡片的不再在架子上重复一遍。
  const cardChoices = tiles.flatMap((tile) => (tile.kind === 'space' ? [tile.space] : tile.members)).map((space) => ({ id: `space:${space.id}`, space }))
  // 缺省先取顶层的,不够(Space 都收进了夹子)从夹内补:一张卡都没有就没处右键改了
  const topChoices = cardChoices.filter((choice) => tiles.some((tile) => tile.id === choice.id))
  const deskCards = phone ? [] : shownHomeCards(deskPicked, cardChoices, [...topChoices, ...cardChoices.filter((c) => !topChoices.includes(c))].slice(0, 4))
  const carded = new Set(deskCards.map((card) => card.id))
  const shelfTiles = tiles.filter((tile) => !carded.has(tile.id))
  const visibleTiles = shelfTiles.slice(0, COMPACT_TILE_LIMIT)
  const hiddenCount = Math.max(0, shelfTiles.length - visibleTiles.length)
  /** 右键近况卡 = 勾选摆哪几张(1 到 HOME_CARDS_MAX 张,新勾的排最后);菜单不关,勾完点别处收起。 */
  const toggleDeskCard = (id: string): void => {
    const ids = deskCards.map((card) => card.id)
    const next = ids.includes(id) ? ids.filter((x) => x !== id) : [...ids, id]
    if (!next.length || next.length > HOME_CARDS_MAX) return
    if (saveHomeCards(next, DESKTOP_HOME_CARDS_KEY)) setDeskPicked(next)
  }
  const activeTile = drag ? tiles.find((tile) => tile.id === drag) : undefined
  const activePinnedSpace = drag?.startsWith(PINNED_DRAG_PREFIX)
    ? spaces.find((space) => space.id === drag.slice(PINNED_DRAG_PREFIX.length))
    : undefined
  const pinnedSpaces = pinnedSpaceIds
    .map((id) => spaces.find((space) => space.id === id))
    .filter((space): space is SpaceDefinition => !!space)
  const fixedHomeActions = FIXED_HOME_ACTIONS
    .map((id) => ribbonItems.find((item) => item.id === id))
    .filter((item): item is RibbonItem => !!item)
  const spaceCount = Math.max(0, spaces.length - (spaces.some((space) => space.id === SELF_SPACE) ? 1 : 0))

  const reorderFolderMember = (event: DragEndEvent): void => {
    if (!folderOpen || folderOpen.kind !== 'folder' || !event.over) return
    shelfReorderFolder(folderOpen.id, String(event.active.id), String(event.over.id))
  }

  /** 主页输入始终开**新**会话(切 Space、发送的顺序契约见 newChatComposer 的 sendFromNewChat);退场动效包在外面。 */
  const dispatchChat: TanguNewChatDispatch = (...args) => {
    if (!newChat) return Promise.resolve(false)
    return new Promise<boolean>((resolve) => {
      const queued = leaveThen(() => resolve(newChat.send(...args)))
      if (!queued) resolve(false) // 连点第二下被重入守卫挡掉:没发
    })
  }

  /** 主页开通话 = 与发第一句同一条路:切到 Tangu、保证有主聊天视图,再建新会话;通话条随之出现在那边的输入框。 */
  const startCallSession = (): Promise<string | null> => {
    if (!newChat) return Promise.resolve(null)
    return new Promise<string | null>((resolve) => {
      const queued = leaveThen(() => resolve(newChat.startCall()))
      if (!queued) resolve(null)
    })
  }

  const exitComposerInputMode = (): void => {
    const active = document.activeElement
    if (active instanceof HTMLTextAreaElement && active.matches('.hp-composer .t2c-ta')) active.blur()
    setComposerFocused(false)
  }

  /** 手机:点收起的输入条 = 展开成完整的输入区并把光标放进去;点条上的话筒 = 展开并直接开始录音(按的就是输入区里那颗话筒)。
   *  同一次点击里同步做完:键盘、麦克风权限都只认用户的这一下。 */
  const openComposer = (voice = false): void => {
    flushSync(() => setComposerFocused(true))
    const box = rootRef.current?.querySelector('.hp-composer')
    if (voice) box?.querySelector<HTMLButtonElement>('.t2c-mic-control')?.click()
    else box?.querySelector<HTMLTextAreaElement>('.t2c-ta')?.focus()
  }
  // 收起时条上写着已经打的那句话(草稿在 Composer2 自己手里,这里只在收起的那一刻读一次输入框):不然打了一半的字就看不见了。
  const [pillDraft, setPillDraft] = useState('')
  useEffect(() => {
    if (phone && !composerFocused) setPillDraft(rootRef.current?.querySelector<HTMLTextAreaElement>('.hp-composer .t2c-ta')?.value.trim() ?? '')
  }, [phone, composerFocused])

  const showOrganizer = (): void => {
    exitComposerInputMode()
    setWallpaperOpen(false)
    setOpenFolder(null)
    setMenu(null)
    setOrganizerOpen(true)
  }

  /** 参考旧桌面的空白右键语义:不弹一枚孤立菜单,直接进入可见、可拖拽的二级收纳层。
   *  控件和壁纸表单有自己的右键语义,必须排除(格子本身都是 <button>,已被首条挡住)。
   *  ⚠️ 同一个手势必须能**原路退回**:二级层开着时右键空白 = 关掉当前那层,而不是再开一次
   *  (2026-08-30 用户实报「进得去出不来」)。
   *  层模型是**扁的不是叠的**:夹子/收纳层/壁纸面板三者互斥(openFolderTile 会 setOrganizerOpen(false),
   *  showOrganizer 会 setOpenFolder(null)),所以下面这串 else-if 任一时刻只会命中一支,退出即回主页
   *  —— 与点遮罩、点关闭钮的落点一致。写成链式是为了将来真叠起来时不至于一把清空。 */
  const showOrganizerFromBlank = (event: React.MouseEvent): void => {
    const target = event.target as HTMLElement
    if (target.closest('button, input, textarea, [contenteditable="true"], .hp-composer, .ctx-menu, .hp-wallpaper-sheet')) return
    event.preventDefault()
    event.stopPropagation()
    setMenu(null)
    if (openFolder) setOpenFolder(null)
    else if (organizerOpen) setOrganizerOpen(false)
    else if (wallpaperOpen) setWallpaperOpen(false)
    else showOrganizer()
  }

  /** 收纳夹 / 收纳夹成员菜单的唯一一份条目:Web 浮层与 Android 原生半屏(lcl nativeSheet 可选宿主)都从这里渲染。 */
  const menuItems = (m: MenuState): SheetMenuItem[] => {
    if (m.kind === 'cards') {
      return cardChoices.map((choice) => {
        const on = carded.has(choice.id)
        return { id: choice.id, label: label(choice.space.name), checked: on, icon: <Check size={13} style={{ opacity: on ? 1 : 0 }} />, run: () => toggleDeskCard(choice.id) }
      })
    }
    if (m.kind === 'member') {
      return [{ id: 'move-out', label: t('home.folderMenu.moveOut'), icon: <LogOut size={13} />, run: () => { moveOut(m.id!); setMenu(null); setOpenFolder(null) } }]
    }
    return [
      {
        id: 'rename', label: t('home.folderMenu.rename'), icon: <Pencil size={13} />,
        run: () => {
          const id = m.id!
          const cur = tiles.find((x) => x.id === id)
          setMenu(null)
          void askString(t('home.folderMenu.renameTitle'), cur?.kind === 'folder' ? cur.folder.name : '').then((v) => {
            const n = v?.trim()
            if (n) shelfRenameFolder(id, n)
          })
        },
      },
      { id: 'dissolve', label: t('home.folderMenu.dissolve'), icon: <FolderMinus size={13} />, run: () => { shelfRemoveFolder(m.id!); setMenu(null) } },
    ]
  }
  // Android:改由原生半屏呈现(Web 浮层此时不渲染);桌面 / 网页恒走 Web 浮层。
  const webMenu = useNativeSheetMenu(menu, () => {
    if (!menu) return null
    const tile = menu.kind === 'folder' ? tiles.find((x) => x.id === menu.id) : undefined
    return { ...(tile?.kind === 'folder' ? { title: tile.folder.name } : {}), sections: [{ items: menuItems(menu) }] }
  }, () => setMenu(null))

  return (
    <div
      ref={rootRef}
      className={`hp-root${phone ? ' hp-phone' : ''}${reduceMotion ? ' hp-still' : ''}${composerFocused ? ' hp-composer-focused' : ''}${wallpaperOpen ? ' hp-layer-focused' : ''}${openFolder || organizerOpen ? ' hp-secondary-open' : ''}`}
      data-wallpaper={photo ? 'true' : undefined}
      data-theme-preset={wallpaperPrefs.themePreset}
      data-motion={wallpaperPrefs.motion ? 'on' : 'off'}
      data-hidden={pageHidden || undefined}
      data-focus-blur={wallpaperPrefs.focusBlur ? 'true' : 'false'}
      data-vignette={wallpaperPrefs.vignette ? 'true' : 'false'}
      onPointerDown={(event) => {
        if (!(event.target as HTMLElement).closest('.hp-composer')) exitComposerInputMode()
      }}
      onContextMenu={showOrganizerFromBlank}
      onClick={closePops}
    >
      <div
        className="hp-wallpaper"
        style={wallpaperUrl ? { backgroundImage: `url(${JSON.stringify(wallpaperUrl)})` } : undefined}
        aria-hidden
      />
      <div className="hp-wallpaper-art" aria-hidden>
        {!photo && <HomeWallpaperArt preset={wallpaperPrefs.themePreset} hour={clock.hour} minute={clock.minute} still={!wallpaperPrefs.motion || reduceMotion || pageHidden} />}
      </div>
      <div className="hp-wallpaper-edge" aria-hidden />
      <div className="hp-wallpaper-tone" aria-hidden />
      <div className="hp-glow" aria-hidden />

      <button
        type="button"
        className={`hp-wallpaper-button${wallpaperOpen ? ' on' : ''}`}
        aria-label={t('home.wallpaper.open')}
        title={t('home.wallpaper.open')}
        onClick={(event) => { event.stopPropagation(); exitComposerInputMode(); setMenu(null); setOpenFolder(null); setOrganizerOpen(false); setWallpaperOpen((open) => !open) }}
      >
        <Image size={16} />
      </button>

      <div className={`hp-stack${leaving ? ' leaving' : ''}`}>
        <div className="hp-title">
          {/* 标志性标题:旧版 SloganCard 的默认文案与字体,原样搬过来。 */}
          <div className="hp-brand">Forsion is All You Need</div>
          <div className="hp-clock">{clock.time}</div>
          {/* 桌面:问候 · 日期并成一行(摆法 C)。手机靠 order 重排这几个兄弟节点(homepage.css 文末),保持原样。 */}
          {phone ? (
            <>
              <div className="hp-date">{clock.date}</div>
              <div className="hp-greet">{greetText}</div>
            </>
          ) : <div className="hp-meta">{greetText} · {clock.date}</div>}
        </div>

        {newChat && <newChat.Composer onDispatch={dispatchChat} onStartCall={startCallSession} onInputModeChange={setComposerFocused} liveSpaceId={SELF_SPACE} />}
        {/* 手机:输入区平时收成这一条(完整的那块留在页面里、只是不显示,草稿不丢),点一下展开。 */}
        {phone && hasTangu && (
          <button type="button" className="hp-pill" data-act="home-pill" onClick={(event) => { event.stopPropagation(); openComposer(!!(event.target as Element).closest('.hp-pill-mic')) }}>
            <span className="hp-pill-text" data-draft={pillDraft ? '' : undefined}>{pillDraft || t('home.pill')}</span>
            <span className="hp-pill-mic" aria-hidden><Mic /></span>
            <span className="hp-pill-send" aria-hidden><ArrowUp /></span>
          </button>
        )}

        {/* 手机:大卡片,各带一行近况。默认 = 架子上的头两个 Space + 商店、成就;长按任意一张改成自己要的那几张(见 HomeCards)。
            其余 Space 在 Dock 上,收纳层照旧长按空白处进。 */}
        {phone && <HomeCards tiles={tiles} actions={fixedHomeActions} onLaunch={launchSpace} />}

        {deskCards.length > 0 && (
          <section className="hp-status-cards" style={{ '--hp-card-cols': deskCards.length <= 4 ? deskCards.length : 3, '--hp-card-cols-narrow': Math.min(deskCards.length, 2) } as React.CSSProperties}>
            {deskCards.map(({ id, space }) => (
              <button
                key={id} type="button" className="hp-status-card" data-space-id={space.id}
                onClick={(event) => { event.stopPropagation(); launchSpace(space.id) }}
                onContextMenu={(event) => menuAt(event, 'cards')}
              >
                <span className="hp-status-card-icon">{space.icon && <space.icon />}</span>
                <span className="hp-status-card-name">{label(space.name)}</span>
                <span className="hp-status-card-status"><DeskCardStatus spaceId={space.id} /></span>
              </button>
            ))}
          </section>
        )}

        {/* 收纳架只保留一排摘要;“全部”与空白右键都进入独立二级收纳层。 */}
        {!phone && <section className="hp-spaces" data-total={tiles.length}>
          {/* 不再有标题行(「Spaces · N 个 Space」「新建收纳夹」):新建收纳夹在「全部 Spaces」里(10-02 用户拍板 v8)。 */}

          <DndContext
            sensors={sensors}
            collisionDetection={dockCollision}
            onDragStart={dragStart}
            onDragOver={dragOver}
            onDragCancel={dragCancel}
            onDragEnd={dragEnd}
          >
            <div className="hp-space-row">
              <PinnedSpaceZone
                actions={fixedHomeActions}
                spaces={pinnedSpaces}
                labelText={t('home.pinnedSpaces')}
                onLaunch={launchSpace}
              />
              <span className="hp-space-divider" aria-hidden />
              <div className="hp-space-main">
                {visibleTiles.length > 0 ? (
                  <SortableContext items={visibleTiles.map((tile) => tile.id)} strategy={rectSortingStrategy}>
                    <div className="hp-dock">
                      {visibleTiles.map((tile) => (
                        <SortableTile
                          key={tile.id}
                          tile={tile}
                          over={over === tile.id}
                          open={openFolder?.id === tile.id}
                          onOpen={openFolderTile}
                          onLaunch={launchSpace}
                          onMenu={(event, id) => menuAt(event, 'folder', id)}
                        />
                      ))}
                      {hiddenCount > 0 && (
                        <button
                          type="button"
                          className="hp-tile hp-more"
                          onClick={(event) => { event.stopPropagation(); showOrganizer() }}
                          title={t('home.showAll')}
                        >
                          <span className="hp-tile-icon"><Grid2X2 size={20} /></span>
                          <span className="hp-tile-name">{t('home.showAllCount', { n: String(hiddenCount) })}</span>
                        </button>
                      )}
                    </div>
                  </SortableContext>
                ) : tiles.length === 0 && (
                  <div className="hp-spaces-empty">{t('home.noSpaces')}</div>
                )}
              </div>
            </div>
            <DragOverlay dropAnimation={null}>
              {activeTile && !organizerOpen && (
                <div className={`hp-tile hp-drag-overlay${activeTile.kind === 'folder' ? ' hp-folder' : ''}`}>
                  <TileVisual tile={activeTile} />
                </div>
              )}
              {activePinnedSpace && !organizerOpen && (
                <div className="hp-tile hp-drag-overlay hp-pinned-space">
                  <TileVisual tile={{ kind: 'space', id: `space:${activePinnedSpace.id}`, space: activePinnedSpace }} />
                </div>
              )}
            </DragOverlay>
          </DndContext>
        </section>}
      </div>

      <input
        ref={fileRef}
        className="hp-wallpaper-file"
        type="file"
        accept="image/*"
        onChange={(event) => {
          uploadCustomWallpaper(event.currentTarget.files?.[0])
          event.currentTarget.value = ''
        }}
      />

      {wallpaperUrl && wallpaperPrefs.source === 'bing' && wallpaperPrefs.bing?.copyright && (
        <div className="hp-wallpaper-credit" title={wallpaperPrefs.bing.copyright}>{wallpaperPrefs.bing.copyright}</div>
      )}

      {wallpaperOpen && (
        <div className="hp-wallpaper-stage" onClick={() => setWallpaperOpen(false)}>
          <section className="hp-wallpaper-sheet" aria-label={t('home.wallpaper.title')} onClick={(event) => event.stopPropagation()}>
            <header className="hp-wallpaper-head">
              <div>
                <strong>{t('home.wallpaper.title')}</strong>
                <span>{t('home.wallpaper.subtitle')}</span>
              </div>
              <button type="button" onClick={() => setWallpaperOpen(false)} aria-label={t('common.close')}><X size={16} /></button>
            </header>

            <div className="hp-wallpaper-sources" aria-label={t('home.wallpaper.source')}>
              {WALLPAPER_SOURCES.map((source) => (
                <button
                  key={source}
                  type="button"
                  className={wallpaperPrefs.source === source ? 'on' : ''}
                  aria-pressed={wallpaperPrefs.source === source}
                  data-source={source}
                  onClick={() => selectWallpaperSource(source)}
                >
                  {wallpaperPrefs.source === source && <Check size={12} />}
                  {t(`home.wallpaper.${source}`)}
                </button>
              ))}
            </div>
            {wallpaperError && <div className="hp-wallpaper-error">{wallpaperError}</div>}

            {wallpaperPrefs.source === 'theme' && (
              <div className="hp-theme-presets">
                <p>{t('home.wallpaper.themeHint')}</p>
                <div>
                  {THEME_PRESETS.map((preset) => (
                    <button
                      key={preset}
                      type="button"
                      className={wallpaperPrefs.themePreset === preset ? 'on' : ''}
                      data-preset={preset}
                      aria-pressed={wallpaperPrefs.themePreset === preset}
                      onClick={() => patchWallpaperPrefs({ source: 'theme', themePreset: preset })}
                    >
                      {/* 缩略图 = 缩小的主页:同一个组件画壁纸,上面压一条时钟、一块输入区 */}
                      <span className="hp-theme-preview" data-preset={preset} aria-hidden>
                        <HomeWallpaperArt preset={preset} hour={clock.hour} minute={clock.minute} thumb />
                        <span className="hp-theme-mini-clock" />
                        <span className="hp-theme-mini-box" />
                      </span>
                      <span>{t(`home.wallpaper.preset.${preset}`)}</span>
                      {wallpaperPrefs.themePreset === preset && <i><Check size={11} /></i>}
                    </button>
                  ))}
                </div>
              </div>
            )}

            {wallpaperPrefs.source === 'bing' && (
              <div className="hp-wallpaper-bing">
                <div className="hp-wallpaper-row">
                  <button
                    type="button"
                    className={`hp-wallpaper-switch${wallpaperPrefs.bingDaily ? ' on' : ''}`}
                    role="switch"
                    aria-checked={wallpaperPrefs.bingDaily}
                    onClick={() => {
                      const daily = !wallpaperPrefs.bingDaily
                      patchWallpaperPrefs({ bingDaily: daily, bing: daily ? (bingWallpapers[0] || wallpaperPrefs.bing) : wallpaperPrefs.bing })
                    }}
                  >
                    <span aria-hidden /> {t('home.wallpaper.daily')}
                  </button>
                  <button
                    type="button"
                    className="hp-wallpaper-refresh"
                    disabled={bingLoading}
                    onClick={() => setBingReload((n) => n + 1)}
                  >
                    <RefreshCw size={13} /> {t('home.wallpaper.refresh')}
                  </button>
                </div>
                {bingLoading && bingWallpapers.length === 0 && <div className="hp-wallpaper-loading">{t('home.wallpaper.loading')}</div>}
                {bingWallpapers.length > 0 && (
                  <div className="hp-wallpaper-grid">
                    {bingWallpapers.map((item, index) => (
                      <button
                        key={item.id}
                        type="button"
                        className={wallpaperPrefs.bing?.id === item.id ? 'on' : ''}
                        title={item.copyright || item.title}
                        aria-label={item.title || item.copyright || t('home.wallpaper.bing')}
                        onClick={() => patchWallpaperPrefs({ source: 'bing', bing: item, bingDaily: index === 0 && wallpaperPrefs.bingDaily })}
                      >
                        <img src={item.thumbnailUrl} alt="" />
                        {wallpaperPrefs.bing?.id === item.id && <span><Check size={12} /></span>}
                      </button>
                    ))}
                  </div>
                )}
              </div>
            )}

            {wallpaperPrefs.source === 'image' && (
              <div className="hp-theme-presets hp-wallpaper-images">
                <div>
                  <button
                    type="button"
                    className={wallpaperUrl ? 'on' : ''}
                    data-image="custom"
                    aria-pressed={!!wallpaperUrl}
                    onClick={() => customWallpaperUrl ? patchWallpaperPrefs({ source: 'image' }) : fileRef.current?.click()}
                  >
                    <span className="hp-image-preview" style={customWallpaperUrl ? { backgroundImage: `url(${JSON.stringify(customWallpaperUrl)})` } : undefined} aria-hidden>
                      {!customWallpaperUrl && <Upload size={16} />}
                    </span>
                    <span>{t(customWallpaperUrl ? 'home.wallpaper.mine' : 'home.wallpaper.upload')}</span>
                    {wallpaperUrl && <i><Check size={11} /></i>}
                  </button>
                </div>
                {customWallpaperUrl ? (
                  <div className="hp-wallpaper-custom">
                    <div><span>{t('home.wallpaper.customHint')}</span></div>
                    <button type="button" onClick={() => fileRef.current?.click()}><Upload size={13} /> {t('home.wallpaper.replace')}</button>
                    <button type="button" onClick={removeCustomWallpaper}>{t('home.wallpaper.remove')}</button>
                  </div>
                ) : <p className="hp-theme-note">{t('home.wallpaper.customHint')}</p>}
              </div>
            )}

            <div className="hp-wallpaper-options">
              {/* 系统打开「减弱动态效果」时灰掉、显示成关;系统那边关掉后恢复成用户原来的选择(存的值不动)。 */}
              <button
                type="button"
                className={wallpaperPrefs.motion && !reduceMotion ? 'on' : ''}
                role="switch"
                data-option="motion"
                aria-checked={wallpaperPrefs.motion && !reduceMotion}
                disabled={reduceMotion}
                onClick={() => patchWallpaperPrefs({ motion: !wallpaperPrefs.motion })}
              >
                <span><strong>{t('home.wallpaper.motion')}</strong><small>{t(reduceMotion ? 'home.wallpaper.motionReduced' : 'home.wallpaper.motionHint')}</small></span>
                <i aria-hidden />
              </button>
              <button
                type="button"
                className={wallpaperPrefs.focusBlur ? 'on' : ''}
                role="switch"
                aria-checked={wallpaperPrefs.focusBlur}
                onClick={() => patchWallpaperPrefs({ focusBlur: !wallpaperPrefs.focusBlur })}
              >
                <span><strong>{t('home.wallpaper.focusBlur')}</strong><small>{t('home.wallpaper.focusBlurHint')}</small></span>
                <i aria-hidden />
              </button>
              <button
                type="button"
                className={wallpaperPrefs.vignette ? 'on' : ''}
                role="switch"
                aria-checked={wallpaperPrefs.vignette}
                onClick={() => patchWallpaperPrefs({ vignette: !wallpaperPrefs.vignette })}
              >
                <span><strong>{t('home.wallpaper.vignette')}</strong><small>{t('home.wallpaper.vignetteHint')}</small></span>
                <i aria-hidden />
              </button>
            </div>
          </section>
        </div>
      )}

      {/* 全部 Spaces 不是 Dock 的第二行,而是参考旧 Desktop 的独立应用抽屉。
          同一份 Tile / DnD 回写逻辑保证它仍只是 ribbon 数据的另一种视图。 */}
      {organizerOpen && (
        <div className="hp-organizer-stage" onClick={() => setOrganizerOpen(false)}>
          <section className="hp-organizer-panel" aria-label={t('home.organizer.title')} onClick={(event) => event.stopPropagation()}>
            <header className="hp-organizer-head">
              <div>
                <span className="hp-organizer-mark"><Grid2X2 size={16} /></span>
                <span><strong>{t('home.organizer.title')}</strong><small>{t('home.spaceCount', { n: spaceCount })}</small></span>
              </div>
              <button type="button" onClick={() => setOrganizerOpen(false)} aria-label={t('common.close')}><X size={16} /></button>
            </header>
            <DndContext
              sensors={sensors}
              collisionDetection={dockCollision}
              onDragStart={dragStart}
              onDragOver={dragOver}
              onDragCancel={dragCancel}
              onDragEnd={dragEnd}
            >
              <SortableContext items={tiles.map((tile) => tile.id)} strategy={rectSortingStrategy}>
                <div className="hp-organizer-grid">
                  {tiles.map((tile) => (
                    <SortableTile
                      key={tile.id}
                      tile={tile}
                      over={over === tile.id}
                      open={false}
                      onOpen={openFolderTile}
                      onLaunch={(spaceId) => { setOrganizerOpen(false); launchSpace(spaceId) }}
                      onMenu={(event, id) => menuAt(event, 'folder', id)}
                    />
                  ))}
                  <button type="button" className="hp-organizer-new" onClick={newFolder}>
                    <span><FolderPlus size={22} /></span>
                    <small>{t('home.newFolder')}</small>
                  </button>
                </div>
              </SortableContext>
              <DragOverlay dropAnimation={null}>
                {activeTile && (
                  <div className={`hp-tile hp-drag-overlay${activeTile.kind === 'folder' ? ' hp-folder' : ''}`}>
                    <TileVisual tile={activeTile} />
                  </div>
                )}
              </DragOverlay>
            </DndContext>
            <footer>{t('home.organizer.hint')}</footer>
          </section>
        </div>
      )}

      {/* 收纳夹从点击源放大到中央,形成独立的二级应用层。成员重排仍写 ribbon folder.items。 */}
      {openFolder && folderOpen?.kind === 'folder' && (
        <div className="hp-folder-stage" onClick={() => setOpenFolder(null)}>
          <section
            className="hp-folder-panel"
            style={{ '--hp-folder-dx': `${openFolder.dx}px`, '--hp-folder-dy': `${openFolder.dy}px` } as React.CSSProperties}
            aria-label={folderOpen.folder.name}
            onClick={(event) => event.stopPropagation()}
          >
            <header className="hp-folder-head">
              <div className="hp-folder-identity">
                <span className="hp-folder-hero"><TileVisual tile={folderOpen} /></span>
                <span><strong>{folderOpen.folder.name}</strong><small>{t('home.folderCount', { n: folderMembers.length })}</small></span>
              </div>
              <button type="button" onClick={() => setOpenFolder(null)} aria-label={t('common.close')}><X size={16} /></button>
            </header>
            {folderMembers.length === 0 && <div className="hp-folder-empty">{t('home.folderEmpty')}</div>}
            {folderMembers.length > 0 && (
              <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={reorderFolderMember}>
                <SortableContext items={folderOpen.folder.items} strategy={rectSortingStrategy}>
                  <div className="hp-folder-grid">
                    {folderMembers.map((member) => (
                      <SortableFolderMember
                        key={member.id}
                        member={member}
                        onLaunch={(id) => { setOpenFolder(null); launchSpace(id) }}
                        onMenu={(event, id) => menuAt(event, 'member', id)}
                      />
                    ))}
                  </div>
                </SortableContext>
              </DndContext>
            )}
            <footer>{t('home.folderHint')}</footer>
          </section>
        </div>
      )}

      {menu && webMenu && (
        <OverlayAt className={`ctx-menu${menu.kind === 'cards' ? ' hp-cards-menu' : ''}`} x={menu.x} y={menu.y} onClick={(e) => e.stopPropagation()}>
          <CtxMenuButtons items={menuItems(menu)} />
        </OverlayAt>
      )}
    </div>
  )
}
