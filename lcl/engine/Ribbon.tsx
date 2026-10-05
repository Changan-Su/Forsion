/** Ribbon 竖条(≈ Obsidian ribbon):固定在 Dockview 之外的最左侧,订阅 ribbonRegistry。
 *  - 折叠(默认)= 纯图标;展开 = 图标 + 名称(宽条)。切换钮常驻顶部。
 *  - 上区 = Spaces,下区 = 命令(二级面板同属命令);区内可拖拽改序,跨区禁止(均持久化)。
 *  - 收纳夹:同区图标拖到夹上收入;悬停夹图标在右侧浮层展开(icon + 文字),浮层内可重排/拖出。
 *  - 区内放不下时尾部收进「…」;点「…」= 本区铺满整条(另一区让出来),点 Ribbon 图标以外任意处收回。
 *    两区高度弹性分配,都挤时各保一半。
 *  - 右键空白/两区 + 号 = 新建 Space / 添加命令(从命令面板选)/ 新建收纳夹;账号卡(pinned)钉死最底。 */
import { useEffect, useLayoutEffect, useReducer, useRef, useState } from 'react'
import { ChevronDown, ChevronUp, ChevronsLeft, ChevronsRight, Folder as FolderIcon, MoreHorizontal, Plus, Zap } from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import { useRibbonStore, rankIds, reorderBase, unionOrder, moveTo, slotIndexAt, ribbonActions, isRibbonAutoHome, recentRoom, type RibbonZone, type RibbonFolder } from './ribbonRegistry'
import { RIBBON_ICON_NAMES, iconByName } from './ribbonIcons'
import { useCommandStore, openCommandPicker, addCommand, removeCommand } from './commandRegistry'
import { setActiveSpace, useSpaceStore } from './spaceRegistry'
import { getDetachApi } from './detachSeam'
import { effectiveHotkey, formatHotkey, isMacPlatform, useShortcuts } from './shortcutStore'
import { engineTr, useEngineI18n } from './i18nSeam'
import { label } from './types'
import type { Command, RibbonItem } from './types'
import { OverlayAt, zoomOf } from './menuAnchor'

type Entry =
  | { kind: 'item'; id: string; item: RibbonItem }
  | { kind: 'cmd'; id: string; cmd: Command } // id = 'cmd:<commandId>'
  | { kind: 'folder'; id: string; folder: RibbonFolder }

interface DragState { id: string; zone: RibbonZone; from: string | null } // from = 所在收纳夹 id
// 收纳夹浮层只存夹 id,内容每次 render 从 live store 派生(存快照会在拖出/重排后诈尸,见 codex#1)。
interface FlyState { key: string; zone: RibbonZone; folderId?: string; top: number }
interface MenuState { x: number; y: number; entries: { label: string; onClick(): void }[] }
/** 一个区切出来的样子:露出的一窗 + 其余(进「…」);start = 窗口在整区里的起点,max = 滚轮最多挪几格。 */
interface Part { shown: Entry[]; tail: Entry[]; start: number; max: number }

const GAP = 4
/** 常驻上限:上区(Spaces)与命令区各露几项,超出的进「…」(见下面 capT / capB)。 */
const TOP_VISIBLE = 5
const BOTTOM_VISIBLE = 4
/** 收起态浮签时序 = desktop hoverTip 已拍板的那套(引擎不能 import 宿主,只能同值抄一份):
 *  悬停 1s 弹;刚收起 0.1s 内移到下一枚 → 立刻弹(连续扫图标时不必每枚重等 1s)。 */
const TIP_SHOW_DELAY = 1000
const TIP_SKIP_DELAY = 100
/** 上区第 n 个槽(0 基)的快捷键显示文本;已解绑/超出前 9 个 → 空串(什么都不画)。 */
function slotHint(i: number): string {
  if (i >= 9) return ''
  const hk = effectiveHotkey({ id: `space-slot-${i + 1}`, hotkey: `mod+${i + 1}` })
  return hk ? formatHotkey(hk, isMacPlatform()) : ''
}

function RibbonItemView({ item, expanded }: { item: RibbonItem; expanded: boolean }) {
  if (item.component) {
    const C = item.component
    return <C expanded={expanded} />
  }
  const Icon = item.icon
  const name = item.tooltip ? label(item.tooltip) : ''
  // 收起态不用原生 title(会与 Ribbon 自绘浮签叠成两层提示):名字走 aria-label,浮签读 data-rb-tip。
  return (
    <button className="rb-btn" aria-label={name || undefined} data-rb-tip={expanded ? undefined : name || undefined} onClick={item.onClick}>
      {Icon && <Icon size={18} />}
      {expanded && <span className="rb-label">{name}</span>}
    </button>
  )
}

function CmdItemView({ cmd, expanded, overrideIcon }: { cmd: Command; expanded: boolean; overrideIcon?: LucideIcon }) {
  // 开关类命令(声明了 checked):渲染期读状态。引擎不订阅宿主状态 → 点完、悬停进出时各重读一次。
  const [, recheck] = useReducer((n: number) => n + 1, 0)
  const Icon = overrideIcon ?? cmd.icon ?? Zap
  const name = label(cmd.title)
  let on: boolean | undefined
  if (cmd.checked) { try { on = !!cmd.checked() } catch { on = undefined } }
  return (
    <button
      className={`rb-btn${on ? ' is-on' : ''}`}
      aria-pressed={on}
      aria-label={name}
      data-rb-tip={expanded ? undefined : name}
      onMouseEnter={cmd.checked ? recheck : undefined}
      onMouseLeave={cmd.checked ? recheck : undefined}
      onClick={() => {
        const r = cmd.run()
        if (!cmd.checked) return
        recheck()
        if (r && typeof (r as Promise<void>).then === 'function') void (r as Promise<void>).then(recheck, recheck)
      }}
    >
      <Icon size={18} />
      {expanded && <span className="rb-label">{name}</span>}
    </button>
  )
}

/** 把 Space 拖出 Ribbon 开窗:贴着条边这么宽以内不算(改序时手滑出去几像素,别给人开一扇窗)。 */
const TEAR_MARGIN = 24
/** Ribbon 条目 id → Space id(不是 Space 图标则 null)。 */
const spaceIdOf = (id: string): string | null => (id.startsWith('space:') ? id.slice('space:'.length) : null)

// 滚轮翻看后,点了别处 / 点开一个条目,隔这么久再滑回原位。ponytail: 凭手感估的,嫌快嫌慢调这个数。
const HOME_DELAY = 600

export function Ribbon() {
  const items = useRibbonStore((s) => s.items)
  const expanded = useRibbonStore((s) => s.expanded)
  const order = useRibbonStore((s) => s.order)
  const bottomOrder = useRibbonStore((s) => s.bottomOrder)
  const folders = useRibbonStore((s) => s.folders)
  const commandItems = useRibbonStore((s) => s.commandItems)
  const commandIcons = useRibbonStore((s) => s.commandIcons)
  const recentCount = useRibbonStore((s) => s.recentCount)
  const recentIds = useSpaceStore((s) => s.recent)
  const commands = useCommandStore((s) => s.commands)
  useShortcuts((s) => s.overrides) // 设置里改了键 → 槽位上的快捷键提示当场跟着变
  const { t } = useEngineI18n()
  const st = () => useRibbonStore.getState()

  const [drag, setDrag] = useState<DragState | null>(null)
  const [overId, setOverId] = useState<string | null>(null) // 浮层行插入线
  const [over, setOver] = useState<{ zone: RibbonZone; index: number } | null>(null) // 条上落点(槽下标),驱动让位预览
  const [overFolder, setOverFolder] = useState<string | null>(null) // 收纳夹/「…」高亮
  const [fly, setFly] = useState<FlyState | null>(null)
  const [menu, setMenu] = useState<MenuState | null>(null)
  // 图标选择器:current=当前图标名(高亮),apply(name)=选中回调(空串=清除回默认)。
  const [iconPick, setIconPick] = useState<{ x: number; y: number; current?: string; apply: (name: string) => void } | null>(null)
  const [slots, setSlots] = useState(99) // 两区合计可容纳的槽位数
  const rootRef = useRef<HTMLDivElement>(null)
  const headRef = useRef<HTMLDivElement>(null)
  const homeRef = useRef<HTMLDivElement>(null)
  const pinnedRef = useRef<HTMLDivElement>(null)
  const flyRef = useRef<HTMLDivElement>(null)
  const flyTimer = useRef<number | null>(null)
  const homeTimer = useRef<number | undefined>(undefined) // 待归位的那一下(见下面「自动归位」)
  const geom = useRef<{ top: number; pitch: number; grabDy: number } | null>(null) // 落点几何(dragstart 拍一次)
  // 滚轮翻看(10-02 用户要求,类 Agent 选择条):各区露出的那一窗往后挪了几格。不持久化,越界在 cut() 里夹回。
  const [scrollOff, setScrollOff] = useState<Record<RibbonZone, number>>({ top: 0, bottom: 0 })
  // 「…」展开(10-02 用户要求):该区铺满整条,另一区(连同它那侧的 ＋ /「…」)让出来;点 Ribbon 图标以外任意处收回。
  const [openZone, setOpenZone] = useState<RibbonZone | null>(null)
  // 滑动中(滚轮手势 + 吸附)的区:窗外格子临时画出图标(进场/离场看得见),吸附完清掉,DOM 回到「只有露出的那一窗」。
  const [live, setLive] = useState<Partial<Record<RibbonZone, boolean>>>({})
  // 手势进行中的连续位置(px,窗口起点 × 槽高)直写 .rb-strip-in 的 transform,不走 setState(每秒几十发,整条重渲太重)。
  const glide = useRef<Partial<Record<RibbonZone, { px: number; from: number; timer: number; at?: number }>>>({})
  const stripRefs = useRef<Partial<Record<RibbonZone, HTMLDivElement | null>>>({})
  useEffect(() => () => { for (const g of Object.values(glide.current)) window.clearTimeout(g?.timer) }, [])

  // ---- 收起态浮签(取代原生 title):根上事件委托,认 [data-rb-tip]。时序同 hoverTip(1s / 0.1s skip)。
  //      拖动、菜单、图标选择器、收纳夹浮层任一打开时不弹且立刻收;按下鼠标即收(点完别挂着)。 ----
  const [tip, setTip] = useState<{ text: string; mid: number } | null>(null)
  const tipFor = useRef<HTMLElement | null>(null) // 当前悬停(已弹或计时中)的按钮
  const tipTimer = useRef<number | undefined>(undefined)
  const tipShown = useRef(false)
  const tipHiddenAt = useRef(0)
  const hideTip = (): void => {
    window.clearTimeout(tipTimer.current)
    tipFor.current = null
    if (tipShown.current) { tipShown.current = false; tipHiddenAt.current = Date.now() }
    setTip(null)
  }
  const blockTip = !!drag || !!menu || !!iconPick || !!fly
  useEffect(() => { if (blockTip || expanded) hideTip() }, [blockTip, expanded]) // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => () => window.clearTimeout(tipTimer.current), [])
  const onTipOver = (e: React.MouseEvent): void => {
    const el = (e.target as Element).closest('[data-rb-tip]') as HTMLElement | null
    if (el === tipFor.current) return
    const warm = tipShown.current || Date.now() - tipHiddenAt.current <= TIP_SKIP_DELAY
    hideTip()
    if (!el || blockTip || expanded) return
    tipFor.current = el
    const fire = (): void => {
      if (tipFor.current !== el || !el.isConnected || !el.dataset.rbTip) return
      const r = el.getBoundingClientRect() // 视口 px;渲染时再按 zoom 折算
      tipShown.current = true
      setTip({ text: el.dataset.rbTip, mid: r.top + r.height / 2 })
    }
    if (warm) fire()
    else tipTimer.current = window.setTimeout(fire, TIP_SHOW_DELAY)
  }

  // ---- 数据整形:两区各自的顶层条目(收纳夹成员从条上隐藏,byId 供浮层反查) ----
  const inFolder = new Set(folders.flatMap((f) => f.items))
  const byId = new Map<string, Entry>()
  const zoneList = (zone: RibbonZone): Entry[] => {
    const list: Entry[] = []
    for (const i of items) if ((i.side ?? 'top') === zone && !i.pinned) list.push({ kind: 'item', id: i.id, item: i })
    if (zone === 'bottom') {
      for (const cid of commandItems) {
        const cmd = commands.find((c) => c.id === cid)
        if (cmd) list.push({ kind: 'cmd', id: `cmd:${cid}`, cmd })
      }
    }
    for (const f of folders) if (f.zone === zone) list.push({ kind: 'folder', id: f.id, folder: f })
    for (const e of list) byId.set(e.id, e)
    const ranked = rankIds(list.map((e) => e.id), zone === 'top' ? order : bottomOrder)
    return ranked.map((id) => byId.get(id)!).filter((e) => !inFolder.has(e.id))
  }
  const topE = zoneList('top')
  const botE = zoneList('bottom')
  /** 收纳夹成员表是持久化的,里面会留下**已解析不出来**的 id —— 图标退役(如 2026-08-31 撤下的
   *  rb-search/rb-locale;rb-feedback 09-17 已放回)、插件卸载、命令消失都会造成。计数与空态一律按能解析出来的
   *  成员算,否则用户看到「标着 (1) 的收纳夹打开却一片空白」,连「拖图标进来」的空态提示都不给。
   *  成员**行**照旧按原数组渲染(解析不出的渲染成 null):`flyRow` 拿的下标要与原数组对齐,
   *  过滤掉会让拖拽重排写回错位的顺序。 */
  const liveCount = (f: RibbonFolder): number => f.items.reduce((n, id) => n + (byId.has(id) ? 1 : 0), 0)
  const pinned = items.filter((i) => i.side === 'bottom' && i.pinned)
  // head 区:折叠钮下的固定件(zoneList 的 top/bottom 过滤天然排除它,不进拖拽/溢出/持久化)。
  const headItems = items.filter((i) => i.side === 'head')
  // home 区:Space 区的**第一格**(2026-08-28 用户要的「主位」槽;10-02 用户改判:从两区之间的正中挪到上区最前)。
  // 同 head,不进拖拽/溢出/持久化。
  const homeItems = items.filter((i) => i.side === 'home')

  // ---- 溢出测算:两区弹性分配,总量不够时各保一半;超配区尾部收进「…」 ----
  const slotH = (expanded ? 34 : 32) + GAP
  useLayoutEffect(() => {
    const el = rootRef.current
    if (!el) return
    const recalc = (): void => {
      const cs = getComputedStyle(el)
      const fixed = (headRef.current?.offsetHeight ?? 0) + (pinnedRef.current?.offsetHeight ?? 0)
      // ponytail: 组间距/边角按 ~48px 粗扣(偏保守只会让「…」早一格出现,不会画半截图标)
      // 主位槽(若有)也占一格实高,不扣掉的话两区会算多一格、把「…」往后推一格才出现。
      const avail = el.clientHeight - parseFloat(cs.paddingTop) - parseFloat(cs.paddingBottom) - fixed
        - (homeRef.current?.offsetHeight ?? 0) - 2 * slotH - 48
      setSlots(Math.max(2, Math.floor(avail / slotH)))
    }
    recalc()
    const ro = new ResizeObserver(recalc)
    ro.observe(el)
    // Conditional pinned controls (for example a ready update) change height without resizing the ribbon.
    if (pinnedRef.current) ro.observe(pinnedRef.current)
    return () => ro.disconnect()
  }, [expanded, slotH, items.length, folders.length, commandItems.length, openZone]) // openZone:命令区展开时主位槽让出来
  // 常驻上限(10-02 用户拍板「Ribbon 减负」):上区最多 5 个 Space、命令区最多 4 项,其余进各自的「…」。
  // 写成 `len ≤ N ? len : N + 1`,cut() 留一格给「…」后正好露 N 个。命令区从头吃起 → 注册序排在前面的
  // 反馈 / 市场 / 成就进「…」,明暗 / 设备互联 / 命令面板 / 设置常驻(钉死的账号卡不在 botE 里,不占名额)。
  // ponytail: 用户钉进命令区的命令与收纳夹也占名额,钉多了会把明暗挤进「…」;要按项豁免再给 RibbonItem 加标记。
  const cap = (len: number, max: number): number => (len <= max ? len : max + 1)
  const wantT = cap(topE.length, TOP_VISIBLE)
  const wantB = cap(botE.length, BOTTOM_VISIBLE)
  let capT = wantT
  let capB = wantB
  if (openZone) {
    // 展开区独占两区合计的槽数(另一区的 ＋ 也让出来了,正好留给「收起」钮);仍放不下就照旧滚轮翻看。
    if (openZone === 'top') capT = slots
    else capB = slots
  } else if (capT + capB > slots) {
    // 窗口矮到连上限都放不下:按高度两区分配(只会比上限更少)。
    // 空区给 0(否则 max(1,…) 白占一格,挤掉另一区,见 codex#5);两区都非空时各保至少一半。
    if (topE.length === 0) { capT = 0; capB = slots }
    else if (botE.length === 0) { capT = slots; capB = 0 }
    else {
      const half = Math.floor(slots / 2)
      capT = Math.max(1, Math.min(wantT, Math.max(half, slots - wantB)))
      capB = Math.max(1, Math.min(wantB, slots - capT))
    }
  }
  /** 溢出从「…」那一端吃起 —— 上区「…」在下,吃列表尾;命令区「…」在上,吃列表头。
   *  两区都是「离锚点最远的先被收走」:上区锚在顶(head),命令区锚在底(账号卡)。
   *  off = 滚轮挪过的格数(从锚点那一端往里数):露出的是连续一窗,窗外两侧的都进「…」。
   *  start / max 给快捷键提示与滚轮夹边用。 */
  const cut = (list: Entry[], cap: number, fromFront: boolean, off: number): Part => {
    if (list.length <= cap) return { shown: list, tail: [], start: 0, max: 0 }
    const n = Math.max(0, cap - 1) // 留一格给「…」
    const max = list.length - n
    const o = Math.min(Math.max(0, off), max)
    const start = fromFront ? list.length - n - o : o
    return { shown: list.slice(start, start + n), tail: [...list.slice(0, start), ...list.slice(start + n)], start, max }
  }
  const top = cut(topE, capT, false, scrollOff.top)
  const bot = cut(botE, capB, true, scrollOff.bottom)
  // ---- 中间那段空当:最近使用的 Space(10-05 用户要求),最近的在上。个数 = 设置的上限(缺省 3,最多 5)与中间还放得下的
  //      格数取小,窗口矮了就一个个减到没有;有一区展开(铺满整条)时不露。只是快捷入口:不进拖拽 / 溢出 / 快捷键编号,
  //      也不是 .rb-slot(拖拽量槽、台架数格子都按它)。
  //      只列此刻**没露在条上**的(同 macOS 程序坞的「最近使用」:钉在坞上的不再重复一遍):上区常驻的那一窗与主位槽里的
  //      不算 —— 它们本来就一点即达,再列一遍只是同一个图标亮两处。常驻的那一窗按没翻过的位置算,滚轮翻看时中间不跟着跳。
  //      要改成照字面「最近用过的都列」:去掉下面那行 filter 即可。
  const shownOnBar = new Set([...cut(topE, capT, false, 0).shown.map((e) => e.id), ...homeItems.map((i) => i.id)])
  const recentItems = recentIds
    .map((id) => items.find((i) => i.id === `space:${id}`))
    .filter((i): i is RibbonItem => !!i)
    .filter((i) => !shownOnBar.has(i.id))
    .slice(0, recentRoom(recentCount, slots, capT, capB, !!openZone))
  /** 滚轮在区上 = 平移露出的那一窗(DOM 不滚,拖拽落点、「…」、快捷键都照旧按条目算)。
   *  10-02 第二版「丝滑 + 吸附」:手势中按像素连续跟手(CSS 过渡把每发 delta 抹平),停手 120ms 后吸附到最近的整格,
   *  吸附完才把新窗口提交进 scrollOff。两区同一坐标:px = 窗口起点 × 槽高,往下滚 px 变大(内容跟着滚轮走:
   *  上区往下滚看后面的;命令区藏的在上面,往上滚露出来)。
   *  - 每发 delta 夹在 ±一格:鼠标滚轮一格 = 一个图标(Windows 一格 100–120px,不夹会一下滑 3 格,窗口才 5 格)。
   *  - 动过但四舍五入回原位 → 仍朝滚动方向挪一格(慢转的滚轮一格只有几 px,不然转了等于没转)。
   *  ponytail: 120ms 停顿 / 0.2s 过渡是凭手感估的参数,真机嫌黏嫌飘就调这两个数。 */
  const onZoneWheel = (zone: RibbonZone, part: Part) => (e: React.WheelEvent): void => {
    const el = stripRefs.current[zone]
    if (!part.max || drag || !e.deltaY || !el) return
    window.clearTimeout(homeTimer.current) // 又滚了 = 还在翻,待归位的那一下作废
    let g = glide.current[zone]
    if (!g) {
      g = glide.current[zone] = { px: part.start * slotH, from: part.start, timer: 0 }
      setLive((s) => ({ ...s, [zone]: true }))
    }
    window.clearTimeout(g.timer)
    const d = e.deltaMode ? Math.sign(e.deltaY) * slotH : Math.max(-slotH, Math.min(slotH, e.deltaY))
    g.px = Math.max(0, Math.min(part.max * slotH, g.px + d))
    el.style.transform = `translateY(${-g.px}px)`
    g.timer = window.setTimeout(() => snapZone(zone, part), 120)
  }
  const snapZone = (zone: RibbonZone, part: Part): void => {
    const g = glide.current[zone]
    const el = stripRefs.current[zone]
    if (!g || !el) return
    const origin = g.at ?? g.from // 上一次滑到的那一格(吸附 / 归位途中又滚,从那儿算起),没滑过就是手势起点
    const moved = g.px - origin * slotH
    let to = Math.round(g.px / slotH)
    if (to === origin && moved) to += Math.sign(moved)
    glideTo(zone, part, Math.max(0, Math.min(part.max, to)))
  }
  /** 把某区的窗口滑到第 to 格(吸附与自动归位共用):没在手势里就先起一段(窗外格子临时画出图标)。 */
  const glideTo = (zone: RibbonZone, part: Part, to: number): void => {
    const el = stripRefs.current[zone]
    if (!el) return
    let g = glide.current[zone]
    if (!g) {
      g = glide.current[zone] = { px: part.start * slotH, from: part.start, timer: 0 }
      setLive((s) => ({ ...s, [zone]: true }))
    }
    window.clearTimeout(g.timer)
    g.px = to * slotH
    g.at = to
    // 必须与渲染期 style 逐字相同(start=0 时 React 不写 transform):提交时 React 只比 props,不看 DOM,
    // 写成别的形状(如 translateY(0px))会留着这一笔、跟后续渲染对不上。
    el.style.transform = to ? `translateY(${-to * slotH}px)` : ''
    g.timer = window.setTimeout(() => { // 等 0.2s 过渡走完再换窗口,换窗口那一帧画面不动
      delete glide.current[zone]
      setLive((s) => ({ ...s, [zone]: false }))
      setScrollOff((s) => ({ ...s, [zone]: zone === 'top' ? to : part.max - to }))
    }, 240)
  }
  // 自动归位(10-04 用户要求,设置里可关):翻过以后,点了 Ribbon 以外的地方 / 点开条上的一个条目(跳转已发生),
  // 隔 HOME_DELAY 滑回原位;窗口失焦同理(点进 iframe / webview 时事件到不了本窗口)。「…」、＋、标签钮、
  // 右键菜单与图标选择器里的操作不算;用 click 而不是 pointerdown —— 拖动改序不产生 click。再滚一下就作废。
  useEffect(() => () => window.clearTimeout(homeTimer.current), [])
  const goHome = useRef<() => void>(() => {})
  goHome.current = () => { // 每次渲染刷新闭包,拿到最新的 top / bot
    if (drag) return
    for (const [zone, part] of [['top', top], ['bottom', bot]] as const) {
      if (!scrollOff[zone]) continue
      if (part.max && stripRefs.current[zone]) glideTo(zone, part, zone === 'top' ? 0 : part.max)
      else setScrollOff((s) => ({ ...s, [zone]: 0 })) // 条目少到不用翻了 / 该区被另一区的展开让出去了:没有画面可滑,直接清
    }
  }
  // 手势还没提交(吸附要 360ms)时点下去也要算 —— 滚一下马上点开翻出来的图标是最常见的用法。
  const scrolled = !!(scrollOff.top || scrollOff.bottom || live.top || live.bottom)
  useEffect(() => {
    if (!scrolled) return
    const arm = (): void => {
      if (!isRibbonAutoHome()) return
      window.clearTimeout(homeTimer.current)
      homeTimer.current = window.setTimeout(() => { if (isRibbonAutoHome()) goHome.current() }, HOME_DELAY)
    }
    const onClick = (e: MouseEvent): void => {
      const t = e.target as Element | null
      if (e.button !== 0 || t?.closest?.('.rb-menu, .rb-iconpick, [data-rb-overlay]')) return
      const own = !!t && (!!rootRef.current?.contains(t) || !!t.closest('.rb-fly'))
      // 条内只认「点了就走」的普通按钮;自带浮层的组件条目(设备互联胶囊)不是 .rb-btn,点它不归位。
      if (own && !t.closest('.rb-btn:not(.rb-more, .rb-plus, .rb-toggle, .rb-folder)')) return
      arm()
    }
    window.addEventListener('click', onClick, true)
    window.addEventListener('blur', arm)
    return () => {
      window.removeEventListener('click', onClick, true)
      window.removeEventListener('blur', arm)
    }
  }, [scrolled])
  // 浮层内容一律从 live store 派生(FlyState 只存 id)——拖出/重排后自动跟随,不诈尸。
  const flyFolder = fly?.folderId ? folders.find((f) => f.id === fly.folderId) : undefined

  // ---- 收纳夹浮层:悬停开,离开双方 150ms 后关;拖动中保持 ----
  const cancelClose = (): void => { if (flyTimer.current) { window.clearTimeout(flyTimer.current); flyTimer.current = null } }
  const scheduleClose = (): void => {
    cancelClose()
    flyTimer.current = window.setTimeout(() => { if (!drag) setFly(null) }, 150)
  }
  const openFly = (key: string, zone: RibbonZone, anchor: HTMLElement, folderId?: string): void => {
    cancelClose()
    setFly({ key, zone, folderId, top: anchor.getBoundingClientRect().top })
  }
  useLayoutEffect(() => { // 底边越界回拉
    const el = flyRef.current
    if (!el || !fly) return
    const over = el.getBoundingClientRect().bottom - (window.innerHeight - 8)
    if (over > 0) setFly({ ...fly, top: Math.max(8, fly.top - over) })
  }, [fly?.key, flyFolder?.items.length]) // eslint-disable-line react-hooks/exhaustive-deps
  // 键盘开的浮层没有「鼠标移开」这条退路(scheduleClose 只挂在 mouseleave)→ 补 Esc / 点别处关。
  const flyOpen = !!fly
  useEffect(() => {
    if (!flyOpen) return
    const onKey = (e: KeyboardEvent): void => { if (e.key === 'Escape') setFly(null) }
    const onDown = (e: MouseEvent): void => {
      const t = e.target as Node
      if (!flyRef.current?.contains(t) && !rootRef.current?.contains(t)) setFly(null)
    }
    window.addEventListener('keydown', onKey)
    window.addEventListener('mousedown', onDown)
    return () => { window.removeEventListener('keydown', onKey); window.removeEventListener('mousedown', onDown) }
  }, [flyOpen])
  // 展开的「…」:左键点 Ribbon 上的按钮(图标、＋、收起钮本身)以外的任何地方就收回,Esc 也收。
  // 点进 iframe / webview 的视图时事件到不了本窗口 → 靠窗口 blur 兜。右键不收(空白处右键要弹区菜单)。
  useEffect(() => {
    if (!openZone) return
    const close = (): void => setOpenZone(null)
    const onDown = (e: PointerEvent): void => {
      if (e.button !== 0) return
      const t = e.target as Element | null
      if (t?.closest?.('.rb-menu, .rb-iconpick, .rb-fly') || (t && rootRef.current?.contains(t) && t.closest('button'))) return
      close()
    }
    const onKey = (e: KeyboardEvent): void => { if (e.key === 'Escape') close() }
    window.addEventListener('pointerdown', onDown, true)
    window.addEventListener('keydown', onKey)
    window.addEventListener('blur', close)
    return () => {
      window.removeEventListener('pointerdown', onDown, true)
      window.removeEventListener('keydown', onKey)
      window.removeEventListener('blur', close)
    }
  }, [openZone])

  // ---- Space 快捷键:mod+1..9 = 上区第 N 个条目,**纯按当前排序**(拖动改序,号跟着走)。
  //      收纳夹同样占一个号,按下 = 弹它的浮层;溢出进「…」的条目也按得到(没有按钮锚点就贴条顶)。 ----
  const folderBtns = useRef(new Map<string, HTMLElement>())
  const runSlot = useRef<(i: number) => void>(() => {})
  useEffect(() => { // 无 deps:每次渲染刷新闭包,拿到最新的 topE / openFly
    runSlot.current = (i) => {
      const e = topE[i]
      if (!e) return
      if (e.kind === 'folder') {
        const anchor = folderBtns.current.get(e.id) ?? rootRef.current
        if (anchor) openFly(e.id, 'top', anchor, e.id)
        return
      }
      setFly(null) // 上一次按开的收纳夹浮层
      if (e.kind === 'cmd') e.cmd.run()
      else if (e.id.startsWith('space:')) setActiveSpace(e.id.slice('space:'.length))
      else e.item.onClick?.()
    }
  })
  const slotCount = Math.min(9, topE.length)
  useEffect(() => {
    for (let n = 1; n <= 9; n++) {
      if (n > slotCount) { removeCommand(`space-slot-${n}`); continue }
      addCommand({
        id: `space-slot-${n}`,
        title: () => engineTr('lcl.ribbon.switchSpace', { n }),
        keywords: `space switch ${n} 切换 空间`,
        hotkey: `mod+${n}`,
        run: () => runSlot.current(n - 1),
      })
    }
    return () => { for (let n = 1; n <= 9; n++) removeCommand(`space-slot-${n}`) }
  }, [slotCount])

  // ---- 拖拽:区内重排 / 拖入收纳夹 / 浮层内重排、拖出;跨区一律拒收 ----
  const startDrag = (e: React.DragEvent, id: string, zone: RibbonZone, from: string | null): void => {
    e.dataTransfer.effectAllowed = 'move'
    // 拖影对齐抓取点(与左栏分组拖动同款):默认幽灵图会带整槽留白偏移。
    const r = e.currentTarget.getBoundingClientRect()
    e.dataTransfer.setDragImage(e.currentTarget as Element, e.clientX - r.left, e.clientY - r.top)
    setDrag({ id, zone, from })
  }
  const endDrag = (): void => { geom.current = null; setDrag(null); setOverId(null); setOver(null); setOverFolder(null) }

  // ---- 把 Space 拖出 Ribbon = 在它自己的窗口里打开(10-05 用户要求;宿主能开窗才有)。
  //      条外不是任何人的落点,得自己在窗口级接:dragover 放行(不放行光标是禁止符,mac 上松手还要等拖影飞回去才收到
  //      dragend),drop 开窗。贴着条边 TEAR_MARGIN 以内照样放行但不开窗(= 取消)—— 于是本文档里松手必有 drop,
  //      「没有 drop 的 dragend」只剩两种:按 Esc 取消,或在本文档收不到事件的地方松的手(窗口外面、iframe / webview 上)。
  //      后者在 dragend 里补开:松手点在视口外,或者底下是 iframe / webview。
  //      ponytail: 指针停在窗口外 / iframe 上时按 Esc 也会开窗(那里分不出取消和松手);mac 的拖窗区(标题带)吞拖放事件,
  //      松在那儿当取消。要更准得让主进程按屏幕坐标判落点。
  const tearId = drag && getDetachApi()?.openSpace ? spaceIdOf(drag.id) : null
  const tear = useRef<{ dropped: boolean; gone: boolean }>({ dropped: false, gone: false })
  const nearBar = (x: number, y: number): boolean => {
    const r = rootRef.current?.getBoundingClientRect()
    if (!r) return true
    const inRect = (b: DOMRect): boolean => x >= b.left - TEAR_MARGIN && x <= b.right + TEAR_MARGIN && y >= b.top - TEAR_MARGIN && y <= b.bottom + TEAR_MARGIN
    const f = flyRef.current?.getBoundingClientRect()
    return inRect(r) || (!!f && inRect(f))
  }
  const onBar = (e: DragEvent): boolean => {
    const t = e.target as Node | null
    return !!t && (!!rootRef.current?.contains(t) || !!flyRef.current?.contains(t))
  }
  useLayoutEffect(() => { // layout:要赶在 dragstart 之后的第一发拖放事件之前挂上
    if (!tearId) return
    const st = { dropped: false, gone: false }
    tear.current = st
    const onOver = (e: DragEvent): void => {
      st.gone = false
      if (onBar(e)) return // 条上 / 收纳夹浮层里:照旧由它们自己接
      e.preventDefault()
      e.stopPropagation()
      if (e.dataTransfer) e.dataTransfer.dropEffect = 'move'
      setOver((o) => (o ? null : o)) // 出了条:让位预览收回去(图标回原位 = 「它要走了」)
      setOverFolder((o) => (o ? null : o))
    }
    const onDrop = (e: DragEvent): void => {
      st.dropped = true
      if (onBar(e)) return
      e.preventDefault()
      e.stopPropagation()
      if (!nearBar(e.clientX, e.clientY)) getDetachApi()?.openSpace?.(tearId, { screenX: e.screenX, screenY: e.screenY })
    }
    // 从视口边上出去的 dragleave = 拖出了窗口(dragend 的坐标万一不可信,靠它兜);回来的第一发 dragover 复位。
    const onLeave = (e: DragEvent): void => {
      if (e.clientX <= 0 || e.clientY <= 0 || e.clientX >= window.innerWidth || e.clientY >= window.innerHeight) st.gone = true
    }
    window.addEventListener('dragover', onOver, true)
    window.addEventListener('drop', onDrop, true)
    window.addEventListener('dragleave', onLeave, true)
    return () => {
      window.removeEventListener('dragover', onOver, true)
      window.removeEventListener('drop', onDrop, true)
      window.removeEventListener('dragleave', onLeave, true)
    }
  }, [tearId]) // eslint-disable-line react-hooks/exhaustive-deps
  const finishDrag = (e: React.DragEvent): void => {
    const st = tear.current
    if (tearId && !st.dropped) {
      const { clientX: x, clientY: y } = e
      const outside = x < 0 || y < 0 || x > window.innerWidth || y > window.innerHeight
      const frame = !outside && /^(IFRAME|WEBVIEW)$/.test(document.elementFromPoint(x, y)?.tagName ?? '')
      if (st.gone || outside || frame) getDetachApi()?.openSpace?.(tearId, e.screenX || e.screenY ? { screenX: e.screenX, screenY: e.screenY } : undefined)
    }
    endDrag()
  }
  const acceptOver = (e: React.DragEvent, ok: boolean, mark?: () => void): void => {
    if (!ok) return
    e.preventDefault()
    e.stopPropagation()
    e.dataTransfer.dropEffect = 'move'
    mark?.()
  }
  /** 量一个区的槽间距。条上拖动一律用 dragstart 拍的快照:让位动画给槽加了 transform,
   *  边拖边量会自反馈成抖动;从浮层/收纳夹拖进来时条上没 transform,当场量(抓取点按光标居中算)。 */
  const measure = (group: HTMLElement, grabDy?: number): { top: number; pitch: number; grabDy: number } => {
    const els = group.querySelectorAll<HTMLElement>('.rb-slot') // 窗外占位是 .rb-cell,不算槽
    const top = els[0]?.getBoundingClientRect().top ?? 0
    const pitch = els.length > 1 ? els[1].getBoundingClientRect().top - top : 0
    return { top, pitch, grabDy: grabDy ?? pitch / 2 }
  }
  const indexAt = (group: HTMLElement, clientY: number, count: number): number =>
    slotIndexAt(clientY, count, geom.current ?? measure(group))
  const snapGeom = (slot: HTMLElement, clientY: number): void => {
    const group = slot.parentElement
    if (group) geom.current = measure(group, clientY - slot.getBoundingClientRect().top)
  }
  /** 顶层重排:把 drag 项挪到 targetId 当下占的槽位(顶掉它,其余让位;target 缺省 = 区末尾);
   *  从收纳夹拖出时顺带去 membership。
   *  基准序取「持久序 ∪ 可见项」,保住异步未加载的 Space(否则拖动会抹掉其存档位置,见 codex#2)。 */
  const dropOnBar = (zone: RibbonZone, targetId: string | null): void => {
    const d = drag
    endDrag()
    if (!d || d.zone !== zone || d.id === targetId) return
    if (d.from) st().moveOutOfFolder(d.id)
    const persisted = zone === 'top' ? st().order : st().bottomOrder
    const full = unionOrder(persisted, (zone === 'top' ? topE : botE).map((x) => x.id))
    const ti = targetId ? full.indexOf(targetId) : -1
    st().setZoneOrder(zone, moveTo(full, d.id, ti >= 0 ? ti : full.length))
  }
  const dropIntoFolder = (f: RibbonFolder, at?: number): void => {
    const d = drag
    endDrag()
    if (!d || d.zone !== f.zone || d.id.startsWith('folder:')) return
    if (d.from === f.id) { // 夹内重排
      st().setFolderItems(f.id, moveTo(f.items, d.id, at ?? f.items.length))
    } else {
      st().moveIntoFolder(f.id, d.id) // 跨夹去重 + 追加末尾
      if (!d.from) st().setZoneOrder(f.zone, reorderBase(f.zone === 'top' ? st().order : st().bottomOrder, (f.zone === 'top' ? topE : botE).map((x) => x.id), d.id)) // 从条上移入:退出区顺序(同样保未加载项)
      if (at !== undefined) { // 指定落点:按 at 在 live items(已含 d.id 于末尾)里重排
        const live = st().folders.find((x) => x.id === f.id)
        if (live) st().setFolderItems(f.id, moveTo(live.items, d.id, at))
      }
    }
  }

  // ---- 菜单(右键 / + 号共用) ----
  const ask = ribbonActions.prompt ?? ((t: string, i?: string) => Promise.resolve(window.prompt(t, i)))
  const createFolder = (zone: RibbonZone): void => {
    void ask(t('lcl.ribbon.newFolder'), t('lcl.ribbon.folderDefaultName')).then((v) => {
      const name = v?.trim()
      if (name) st().addFolder(zone, name)
    })
  }
  const zoneMenu = (zone: RibbonZone): MenuState['entries'] => [
    ...(zone === 'top' && ribbonActions.newSpace ? [{ label: t('lcl.ribbon.newSpace'), onClick: ribbonActions.newSpace }] : []),
    ...(zone === 'bottom' ? [{ label: t('lcl.ribbon.addCommand'), onClick: () => openCommandPicker((id) => st().addCommandItem(id)) }] : []),
    { label: t(zone === 'top' ? 'lcl.ribbon.newFolderSpaces' : 'lcl.ribbon.newFolderCommands'), onClick: () => createFolder(zone) },
  ]
  const onZoneCtx = (zone: RibbonZone) => (e: React.MouseEvent): void => {
    if (e.defaultPrevented) return // 图标级菜单(用户 Space 删除/收纳夹/命令)优先
    e.preventDefault()
    setMenu({ x: e.clientX, y: e.clientY, entries: zoneMenu(zone) })
  }
  const onRootCtx = (e: React.MouseEvent): void => {
    if (e.defaultPrevented) return
    e.preventDefault()
    setMenu({ x: e.clientX, y: e.clientY, entries: [...zoneMenu('top'), ...zoneMenu('bottom')] })
  }
  // 菜单项点开图标选择器:关掉菜单、在原位弹网格。current 高亮当前图标,apply 落库。
  const pickIcon = (x: number, y: number, current: string | undefined, apply: (name: string) => void): void => {
    setMenu(null)
    setIconPick({ x, y, current, apply })
  }
  const folderCtx = (f: RibbonFolder) => (e: React.MouseEvent): void => {
    e.preventDefault()
    e.stopPropagation()
    const x = e.clientX, y = e.clientY
    setMenu({
      x, y, entries: [
        { label: t('lcl.ribbon.changeIcon'), onClick: () => pickIcon(x, y, f.icon, (name) => st().setFolderIcon(f.id, name)) },
        { label: t('lcl.ribbon.rename'), onClick: () => { void ask(t('lcl.ribbon.renameFolder'), f.name).then((v) => { const n = v?.trim(); if (n) st().renameFolder(f.id, n) }) } },
        { label: t('lcl.ribbon.dissolveFolder'), onClick: () => st().removeFolder(f.id) },
      ],
    })
  }
  /** 图标自己的右键项(条上的格子、收纳夹浮层的行、中间的最近使用共用):Space 图标先给「在新窗口中打开」(宿主能开窗才有),
   *  后面跟条目自带的(RibbonItem.menu,如用户 Space 的删除)。 */
  const itemMenu = (item: RibbonItem): MenuState['entries'] => {
    const sid = spaceIdOf(item.id)
    const open = getDetachApi()?.openSpace
    return [
      ...(sid && open ? [{ label: t('lcl.ribbon.openInNewWindow'), onClick: () => open(sid) }] : []),
      ...(item.menu?.() ?? []),
    ]
  }
  const itemCtx = (item: RibbonItem) => (e: React.MouseEvent): void => {
    if (e.defaultPrevented) return // 组件自己接了右键(主位槽)
    const entries = itemMenu(item)
    if (!entries.length) return // 没有自己的项 → 放它冒泡到区菜单
    e.preventDefault()
    e.stopPropagation()
    setMenu({ x: e.clientX, y: e.clientY, entries })
  }
  const cmdCtx = (cmdId: string) => (e: React.MouseEvent): void => {
    e.preventDefault()
    e.stopPropagation()
    const x = e.clientX, y = e.clientY
    setMenu({ x, y, entries: [
      { label: t('lcl.ribbon.setIcon'), onClick: () => pickIcon(x, y, st().commandIcons[cmdId], (name) => st().setCommandIcon(cmdId, name)) },
      { label: t('lcl.ribbon.removeCommand'), onClick: () => st().removeCommandItem(cmdId) },
    ] })
  }

  // ---- 渲染件(一律「渲染函数」而非组件:内部组件每次 setState 都是新引用 → React remount 整个子树,
  //      拖拽被打断、dragging/drag-over 的 CSS 过渡从头来 = 动画/落点预览「没了」。函数调用则内联进树按位置 diff。) ----
  const renderFolderBtn = (f: RibbonFolder): React.ReactNode => {
    const Icon = iconByName(f.icon) ?? FolderIcon // 自定义图标 → 回落文件夹
    return (
      <button
        // 记下按钮元素:mod+N 打开这个收纳夹时要拿它当浮层锚点(键盘路径没有 currentTarget)。
        ref={(el) => { el ? folderBtns.current.set(f.id, el) : folderBtns.current.delete(f.id) }}
        className={`rb-btn rb-folder${overFolder === f.id ? ' drag-into' : ''}`}
        aria-label={`${f.name} (${liveCount(f)})`} /* 悬停即弹浮层(浮层头就是名字)→ 不再挂浮签 */
        onMouseEnter={(e) => openFly(f.id, f.zone, e.currentTarget, f.id)}
        onMouseLeave={scheduleClose}
        onContextMenu={folderCtx(f)}
        onDragOver={(e) => acceptOver(e, !!drag && drag.zone === f.zone && !drag.id.startsWith('folder:'), () => { setOver(null); setOverFolder(f.id) })}
        onDragLeave={() => { if (overFolder === f.id) setOverFolder(null) }}
        /* 拖的是收纳夹本身 → 不认领,放它冒泡到组级走顶层重排。少了这个 return:dragover 已被拒
         * (走组级画了让位预览),drop 却被这里吃掉再被 dropIntoFolder 拒收 = 预览骗人、松手不动。 */
        onDrop={(e) => { if (!drag || drag.id.startsWith('folder:')) return; e.preventDefault(); e.stopPropagation(); dropIntoFolder(f) }}
      >
        <Icon size={18} />
        {expanded && <span className="rb-label">{f.name}</span>}
      </button>
    )
  }
  /** 「…」= 展开 / 收起本区。收起钮的箭头指向收回的方向:上区的钮在列下面(↑),命令区的在列上面(↓)。 */
  const renderMoreBtn = (zone: RibbonZone): React.ReactNode => {
    const open = openZone === zone
    const name = t(open ? 'lcl.ribbon.less' : 'lcl.ribbon.more')
    const Icon = !open ? MoreHorizontal : zone === 'top' ? ChevronUp : ChevronDown
    return (
      <button
        className={`rb-btn rb-more${open ? ' is-open' : ''}${overFolder === `more:${zone}` ? ' drag-into' : ''}`}
        aria-label={name}
        aria-expanded={open}
        data-rb-tip={expanded ? undefined : name}
        onClick={() => setOpenZone(open ? null : zone)}
        onDragOver={(e) => acceptOver(e, !!drag && drag.zone === zone, () => { setOver(null); setOverFolder(`more:${zone}`) })}
        onDragLeave={() => { if (overFolder === `more:${zone}`) setOverFolder(null) }}
        // 收进「…」= 挪到它吃的那一端:上区 = 区末尾,命令区 = 区开头。
        onDrop={(e) => { e.preventDefault(); e.stopPropagation(); dropOnBar(zone, zone === 'bottom' ? (botE[0]?.id ?? null) : null) }}
      >
        <Icon size={18} />
        {expanded && <span className="rb-label">{name}</span>}
      </button>
    )
  }
  const renderEntry = (e: Entry, forceExpanded?: boolean): React.ReactNode => {
    const ex = forceExpanded ?? expanded
    if (e.kind === 'item') return <RibbonItemView item={e.item} expanded={ex} />
    if (e.kind === 'cmd') return <CmdItemView cmd={e.cmd} expanded={ex} overrideIcon={iconByName(commandIcons[e.cmd.id])} />
    return renderFolderBtn(e.folder)
  }
  /** i = 当前槽下标,preview = 落点预览后的 id 序;两者之差 = 让位位移(手机桌面那种排斥占位)。
   *  位移用布局 px(slotH)不是 rect 的视口 px —— transform 走的是未缩放坐标系。
   *  line = 被拖项不在本条上(从收纳夹/「…」浮层拖回来)时改画插入线:让位会把末槽压到「…」钮上。 */
  const renderSlot = (e: Entry, zone: RibbonZone, i: number, preview: string[] | null, line: boolean, at: number): React.ReactNode => {
    const to = preview ? preview.indexOf(e.id) : i
    return (
      <div
        key={e.id}
        data-id={e.id} /* 落点 e2e 用(scripts/ribbon-dnd.e2e.cjs) */
        className={`rb-slot${drag?.id === e.id ? ' dragging' : ''}${line ? ' drag-over' : ''}`}
        style={to !== i ? { transform: `translateY(${(to - i) * slotH}px)` } : undefined}
        draggable
        onDragStart={(ev) => { snapGeom(ev.currentTarget, ev.clientY); startDrag(ev, e.id, zone, null) }}
        onDragEnd={finishDrag}
        onContextMenu={e.kind === 'cmd' ? cmdCtx(e.cmd.id) : e.kind === 'item' ? itemCtx(e.item) : undefined}
      >
        {renderEntry(e)}
        {/* 快捷键提示:只在展开态(收起态 32px 塞不下)、只给上区前 9 个。绝对定位 = 不进流,
            槽高常量 slotH 与拖拽落点几何一点不受影响。 */}
        {zone === 'top' && expanded && slotHint(at) && <span className="rb-key">{slotHint(at)}</span>}
      </div>
    )
  }
  // 两个 ＋ 各说各的:上区 = 新建 Space / 收纳夹,命令区 = 添加命令(原来都叫「添加」,分不清)。
  const plusName = (zone: RibbonZone): string => t(zone === 'top' ? 'lcl.ribbon.addSpaceOrFolder' : 'lcl.ribbon.addCommand')
  const renderPlusBtn = (zone: RibbonZone): React.ReactNode => (
    <button
      className="rb-btn rb-plus"
      aria-label={plusName(zone)}
      data-rb-tip={expanded ? undefined : plusName(zone)}
      onClick={(e) => {
        const r = e.currentTarget.getBoundingClientRect()
        setMenu({ x: r.right + 6, y: r.top, entries: zoneMenu(zone) })
      }}
    >
      <Plus size={16} />
      {expanded && <span className="rb-label">{plusName(zone)}</span>}
    </button>
  )
  // 命令区靠下贴账号卡,整组 = Spaces 区的镜像:[＋ / 「…」/ 图标…] ↔ [图标… / 「…」/ ＋],
  // 两个 ＋ 都贴着中间空隙,两个「…」都紧挨各自的图标列。
  // 拖放收在组这一层(不再逐槽挂):同一个 indexAt 既画让位预览又定提交落点 —— 提示在哪就落在哪。
  const renderZone = (zone: RibbonZone, part: Part): React.ReactNode => {
    const ids = part.shown.map((e) => e.id)
    const preview = drag && over?.zone === zone && ids.includes(drag.id) ? moveTo(ids, drag.id, over.index) : null
    return (
      <div
        className={`rb-group rb-${zone}`}
        onContextMenu={onZoneCtx(zone)}
        onWheel={onZoneWheel(zone, part)}
        /* 下标没变就还回原对象:dragover 每秒几十发,不这么挡会整条 ribbon 每帧重渲一次。 */
        onDragOver={(e) => {
          const ix = indexAt(e.currentTarget, e.clientY, ids.length)
          acceptOver(e, !!drag && drag.zone === zone, () => { setOverFolder(null); setOver((o) => (o?.zone === zone && o.index === ix ? o : { zone, index: ix })) })
        }}
        /* 刻意用 over 而不是在 drop 里拿 e.clientY 重算:over 也是让位预览的输入,
         * 「已画出来的那一帧」和提交必然一致。重算能贴指针贴得更紧,但会在最后一发 dragover
         * 还没 render 就松手时让提示≠落点 —— 那正是本次要根治的病。 */
        onDrop={(e) => { e.preventDefault(); e.stopPropagation(); dropOnBar(zone, (over?.zone === zone ? ids[over.index] : null) ?? null) }}
      >
        {zone === 'bottom' && <>{renderPlusBtn(zone)}{(part.tail.length > 0 || openZone === zone) && renderMoreBtn(zone)}</>}
        {/* 滑动框(滚轮翻看的平滑动画):整区条目排成一列,框只露 n 格高,列按窗口起点 translateY,过渡 0.2s。
            窗外的是等高空占位 .rb-cell(不是 .rb-slot:拖拽量槽、台架按 .rb-slot 认「露出的格子」都不受影响),
            只在滑动中(手势 + 吸附)临时画出图标(inert:滑动中也别让 Tab 落进去,Codex 评审)。 */}
        <div className="rb-strip" style={{ height: Math.max(0, part.shown.length * slotH - GAP) }}>
          <div ref={(el) => { stripRefs.current[zone] = el }} className="rb-strip-in" style={part.start ? { transform: `translateY(${-part.start * slotH}px)` } : undefined}>
            {(zone === 'top' ? topE : botE).map((en, k) => {
              const i = k - part.start
              if (i >= 0 && i < part.shown.length) return renderSlot(en, zone, i, preview, !preview && over?.zone === zone && over.index === i, k)
              return <div key={en.id} className="rb-cell" aria-hidden inert style={{ height: slotH - GAP }}>{live[zone] && renderEntry(en)}</div>
            })}
          </div>
        </div>
        {zone === 'top' && <>{(part.tail.length > 0 || openZone === zone) && renderMoreBtn(zone)}{renderPlusBtn(zone)}</>}
      </div>
    )
  }

  // ---- 浮层内容:收纳夹成员 ----
  //  list = 本行所在的 id 序;下移时落点在该行「之下」,插入线跟着画到下沿(否则线在骗人)。
  const flyRow = (e: Entry, folder: RibbonFolder, at: number, list: string[]): React.ReactNode => (
    <div
      key={e.id}
      data-id={e.id} /* 同条上格子的 data-id:台架按稳定 id 定位溢出行(未读角标会改可访问名;Codex 第三轮 H2-2) */
      className={`rb-fly-row${drag?.id === e.id ? ' dragging' : ''}${overId === e.id && drag?.id !== e.id ? ` drag-over${drag && list.indexOf(drag.id) >= 0 && list.indexOf(drag.id) < at ? ' below' : ''}` : ''}`}
      draggable
      onDragStart={(ev) => { ev.stopPropagation(); startDrag(ev, e.id, folder.zone, folder.id) }}
      onDragOver={(ev) => acceptOver(ev, !!drag && drag.zone === folder.zone && drag.id !== e.id && !drag.id.startsWith('folder:'), () => setOverId(e.id))}
      onDragLeave={() => { if (overId === e.id) setOverId(null) }}
      onDrop={(ev) => { ev.preventDefault(); ev.stopPropagation(); dropIntoFolder(folder, at) }}
      onDragEnd={finishDrag}
      onContextMenu={e.kind === 'cmd' ? cmdCtx(e.cmd.id) : (ev) => {
        ev.preventDefault()
        ev.stopPropagation()
        setMenu({ x: ev.clientX, y: ev.clientY, entries: [...(e.kind === 'item' ? itemMenu(e.item) : []), { label: t('lcl.ribbon.moveOut'), onClick: () => { st().moveOutOfFolder(e.id); const persisted = folder.zone === 'top' ? st().order : st().bottomOrder; st().setZoneOrder(folder.zone, [...reorderBase(persisted, (folder.zone === 'top' ? topE : botE).map((x) => x.id), e.id), e.id]) } }] })
      }}
    >
      {renderEntry(e, true)}
    </div>
  )

  return (
    // rb-dragging 只在拖动中挂:让位动画的 transition 也只在这期间生效。松手时 DOM 顺序变了、
    // transform 归零,若还带着 transition 就会从错误的偏移飞回来(旧位移是相对旧布局的)。
    <div
      ref={rootRef}
      className={`rb${expanded ? ' rb-expanded' : ''}${drag ? ' rb-dragging' : ''}${openZone ? ` rb-open-${openZone}` : ''}`}
      onContextMenu={onRootCtx}
      onMouseOver={onTipOver}
      onMouseLeave={hideTip}
      onMouseDownCapture={(e) => {
        // 点下即收;记住这枚按钮 → 点完鼠标还停在它上面时不再重新计时弹出(移到别处才重新武装)。
        hideTip()
        tipFor.current = (e.target as Element).closest('[data-rb-tip]') as HTMLElement | null
      }}
      /* 兜底:两区之间的空隙、head、边距……凡是没被组接住的地方也放行 drop,一律落到**当前预览**
       * 那格。少了这层,松手差几像素落在组外就静默弹回 = 用户报的「显示了落点却没落过去」。 */
      onDragOver={(e) => acceptOver(e, !!drag)}
      onDrop={(e) => {
        if (!drag) return
        e.preventDefault()
        const z = drag.zone
        const target = over?.zone === z ? (z === 'top' ? top : bot).shown[over.index]?.id : undefined
        if (target === undefined) { endDrag(); return } // 压根没画出落点 → 老实弹回,别静默滑到区末尾
        dropOnBar(z, target)
      }}
    >
      <div ref={headRef} className="rb-head">
        {/* 切的是 Ribbon 自己「带不带名称」,不是侧栏:文案说动作结果,图标用 Chevrons(PanelLeft* 与标签条的左栏钮撞脸)。 */}
        <button
          className="rb-btn rb-toggle"
          aria-label={t(expanded ? 'lcl.ribbon.iconsOnly' : 'lcl.ribbon.showLabels')}
          aria-expanded={expanded}
          data-rb-tip={expanded ? undefined : t('lcl.ribbon.showLabels')}
          onClick={() => st().toggleExpanded()}
        >
          {expanded ? <ChevronsLeft size={18} /> : <ChevronsRight size={18} />}
          {expanded && <span className="rb-label">{t('lcl.ribbon.iconsOnly')}</span>}
        </button>
        {headItems.map((i) => <RibbonItemView key={i.id} item={i} expanded={expanded} />)}
      </div>
      {/* 主位槽:**恒渲染**(空着也留),排在 Space 区最前。没有 home 件的宿主(如 Tangu Web)高度为 0。
          它属于 Space 那一侧:命令区展开时跟上区一起让出来(CSS 藏,不卸载)。 */}
      <div ref={homeRef} className="rb-group rb-home">
        {homeItems.map((i) => <RibbonItemView key={i.id} item={i} expanded={expanded} />)}
      </div>
      {openZone !== 'bottom' && renderZone('top', top)}
      {recentItems.length > 0 && (
        <div className="rb-group rb-recent" role="group" aria-label={t('lcl.ribbon.recentSpaces')}>
          {recentItems.map((i) => (
            <div key={i.id} className="rb-recent-slot" data-recent-id={i.id} /* 不叫 data-id:台架按它认上区的格子 */ onContextMenu={itemCtx(i)}>
              <RibbonItemView item={i} expanded={expanded} />
            </div>
          ))}
        </div>
      )}
      {openZone !== 'top' && renderZone('bottom', bot)}
      <div ref={pinnedRef} className="rb-group rb-pinned">
        {pinned.map((i) => <RibbonItemView key={i.id} item={i} expanded={expanded} />)}
      </div>

      {fly && flyFolder && (
        <div
          ref={flyRef}
          className="rb-fly"
          /* rect/fly.top 是视口 px,fixed 的 left/top 会被祖先 zoom 再乘一遍 → 先除掉(见 menuAnchor.tsx)。 */
          style={(() => { const z = zoomOf(rootRef.current); return { left: ((rootRef.current?.getBoundingClientRect().right ?? 44) + 4) / z, top: fly.top / z } })()}
          onMouseEnter={cancelClose}
          onMouseLeave={scheduleClose}
          onDragOver={(e) => acceptOver(e, !!drag && drag.zone === fly.zone && !drag.id.startsWith('folder:') && e.target === e.currentTarget)}
          onDrop={(e) => { if (e.target === e.currentTarget) { e.preventDefault(); dropIntoFolder(flyFolder) } }}
        >
          <div className="rb-fly-head">{flyFolder.name}</div>
          {liveCount(flyFolder) === 0 && <div className="rb-fly-empty">{t('lcl.ribbon.folderEmpty')}</div>}
          {flyFolder.items.map((id, i) => { const e = byId.get(id); return e ? flyRow(e, flyFolder, i, flyFolder.items) : null })}
        </div>
      )}

      {tip && !expanded && (
        <div
          className="rb-tip"
          role="tooltip"
          /* 同 .rb-fly:rect 是视口 px,fixed 的 left/top 会被祖先 zoom 再乘一遍 → 先除掉(见 menuAnchor.tsx)。 */
          style={(() => { const z = zoomOf(rootRef.current); return { left: ((rootRef.current?.getBoundingClientRect().right ?? 44) + 6) / z, top: tip.mid / z } })()}
        >
          {tip.text}
        </div>
      )}

      {menu && (
        <div className="rb-menu-backdrop" onMouseDown={() => setMenu(null)} onContextMenu={(e) => { e.preventDefault(); setMenu(null) }}>
          <OverlayAt className="rb-menu" x={menu.x} y={menu.y} onMouseDown={(e) => e.stopPropagation()}>
            {menu.entries.map((en, i) => (
              <button key={i} onClick={() => { setMenu(null); en.onClick() }}>{en.label}</button>
            ))}
          </OverlayAt>
        </div>
      )}

      {iconPick && (
        <div className="rb-menu-backdrop" onMouseDown={() => setIconPick(null)} onContextMenu={(e) => { e.preventDefault(); setIconPick(null) }}>
          <OverlayAt className="rb-iconpick" x={iconPick.x} y={iconPick.y} onMouseDown={(e) => e.stopPropagation()}>
            {/* 「默认」= 清除覆盖,回落各自默认图标 */}
            <button className="rb-iconpick-reset" onClick={() => { const a = iconPick.apply; setIconPick(null); a('') }}>{t('lcl.ribbon.defaultIcon')}</button>
            <div className="rb-iconpick-grid">
              {RIBBON_ICON_NAMES.map((name) => {
                const I = iconByName(name)!
                return (
                  <button
                    key={name}
                    className={`rb-iconpick-btn${iconPick.current === name ? ' on' : ''}`}
                    title={name}
                    onClick={() => { const a = iconPick.apply; setIconPick(null); a(name) }}
                  >
                    <I size={17} />
                  </button>
                )
              })}
            </div>
          </OverlayAt>
        </div>
      )}
    </div>
  )
}
