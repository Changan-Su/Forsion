/** Ribbon 竖条(≈ Obsidian ribbon):固定在 Dockview 之外的最左侧,订阅 ribbonRegistry。
 *  - 折叠(默认)= 纯图标;展开 = 图标 + 名称(宽条)。切换钮常驻顶部。
 *  - 上区 = Spaces,下区 = 命令(二级面板同属命令);区内可拖拽改序,跨区禁止(均持久化)。
 *  - 收纳夹:同区图标拖到夹上收入;悬停夹图标在右侧浮层展开(icon + 文字),浮层内可重排/拖出。
 *  - 区内放不下时尾部收进「…」,悬停展开,行为同收纳夹;两区高度弹性分配,都挤时各保一半。
 *  - 右键空白/两区 + 号 = 新建 Space / 添加命令(从命令面板选)/ 新建收纳夹;账号卡(pinned)钉死最底。 */
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { PanelLeftClose, PanelLeftOpen, Folder as FolderIcon, MoreHorizontal, Plus, Zap } from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import { useRibbonStore, rankIds, reorderBase, unionOrder, moveTo, slotIndexAt, ribbonActions, type RibbonZone, type RibbonFolder } from './ribbonRegistry'
import { RIBBON_ICON_NAMES, iconByName } from './ribbonIcons'
import { useCommandStore, openCommandPicker, addCommand, removeCommand } from './commandRegistry'
import { setActiveSpace } from './spaceRegistry'
import { effectiveHotkey, formatHotkey, useShortcuts } from './shortcutStore'
import { label } from './types'
import type { Command, RibbonItem } from './types'
import { OverlayAt, zoomOf } from './menuAnchor'

type Entry =
  | { kind: 'item'; id: string; item: RibbonItem }
  | { kind: 'cmd'; id: string; cmd: Command } // id = 'cmd:<commandId>'
  | { kind: 'folder'; id: string; folder: RibbonFolder }

interface DragState { id: string; zone: RibbonZone; from: string | null } // from = 所在收纳夹 id
// 浮层只存「哪个夹 / 哪个区的溢出」的 id,内容每次 render 从 live store 派生(存快照会在拖出/重排后诈尸,见 codex#1)。
interface FlyState { key: string; zone: RibbonZone; folderId?: string; top: number }
interface MenuState { x: number; y: number; entries: { label: string; onClick(): void }[] }

const GAP = 4
const zh = (): boolean => document.documentElement.lang.startsWith('zh')
/** 与 desktop 的 ShortcutsTab 同一判据(宿主启动时写 data-platform)。 */
const isMac = (): boolean => { try { return document.documentElement.dataset.platform === 'mac' } catch { return false } }
/** 上区第 n 个槽(0 基)的快捷键显示文本;已解绑/超出前 9 个 → 空串(什么都不画)。 */
function slotHint(i: number): string {
  if (i >= 9) return ''
  const hk = effectiveHotkey({ id: `space-slot-${i + 1}`, hotkey: `mod+${i + 1}` })
  return hk ? formatHotkey(hk, isMac()) : ''
}

function RibbonItemView({ item, expanded }: { item: RibbonItem; expanded: boolean }) {
  if (item.component) {
    const C = item.component
    return <C expanded={expanded} />
  }
  const Icon = item.icon
  const name = item.tooltip ? label(item.tooltip) : ''
  return (
    <button className="rb-btn" title={expanded ? undefined : name} onClick={item.onClick}>
      {Icon && <Icon size={18} />}
      {expanded && <span className="rb-label">{name}</span>}
    </button>
  )
}

function CmdItemView({ cmd, expanded, overrideIcon }: { cmd: Command; expanded: boolean; overrideIcon?: LucideIcon }) {
  const Icon = overrideIcon ?? cmd.icon ?? Zap
  const name = label(cmd.title)
  return (
    <button className="rb-btn" title={expanded ? undefined : name} onClick={() => cmd.run()}>
      <Icon size={18} />
      {expanded && <span className="rb-label">{name}</span>}
    </button>
  )
}

export function Ribbon() {
  const items = useRibbonStore((s) => s.items)
  const expanded = useRibbonStore((s) => s.expanded)
  const order = useRibbonStore((s) => s.order)
  const bottomOrder = useRibbonStore((s) => s.bottomOrder)
  const folders = useRibbonStore((s) => s.folders)
  const commandItems = useRibbonStore((s) => s.commandItems)
  const commandIcons = useRibbonStore((s) => s.commandIcons)
  const commands = useCommandStore((s) => s.commands)
  useShortcuts((s) => s.overrides) // 设置里改了键 → 槽位上的快捷键提示当场跟着变
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
  const pinnedRef = useRef<HTMLDivElement>(null)
  const flyRef = useRef<HTMLDivElement>(null)
  const flyTimer = useRef<number | null>(null)
  const geom = useRef<{ top: number; pitch: number; grabDy: number } | null>(null) // 落点几何(dragstart 拍一次)

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
  const pinned = items.filter((i) => i.side === 'bottom' && i.pinned)

  // ---- 溢出测算:两区弹性分配,总量不够时各保一半;超配区尾部收进「…」 ----
  const slotH = (expanded ? 34 : 32) + GAP
  useLayoutEffect(() => {
    const el = rootRef.current
    if (!el) return
    const recalc = (): void => {
      const cs = getComputedStyle(el)
      const fixed = (headRef.current?.offsetHeight ?? 0) + (pinnedRef.current?.offsetHeight ?? 0)
      // ponytail: 组间距/边角按 ~48px 粗扣(偏保守只会让「…」早一格出现,不会画半截图标)
      const avail = el.clientHeight - parseFloat(cs.paddingTop) - parseFloat(cs.paddingBottom) - fixed - 2 * slotH - 48
      setSlots(Math.max(2, Math.floor(avail / slotH)))
    }
    recalc()
    const ro = new ResizeObserver(recalc)
    ro.observe(el)
    return () => ro.disconnect()
  }, [expanded, slotH, items.length, folders.length, commandItems.length])
  let capT = topE.length
  let capB = botE.length
  if (capT + capB > slots) {
    // 空区给 0(否则 max(1,…) 白占一格,挤掉另一区,见 codex#5);两区都非空时各保至少一半。
    if (topE.length === 0) { capT = 0; capB = slots }
    else if (botE.length === 0) { capT = slots; capB = 0 }
    else {
      const half = Math.floor(slots / 2)
      capT = Math.max(1, Math.min(topE.length, Math.max(half, slots - botE.length)))
      capB = Math.max(1, Math.min(botE.length, slots - capT))
    }
  }
  /** 溢出从「…」那一端吃起 —— 上区「…」在下,吃列表尾;命令区「…」在上,吃列表头。
   *  两区都是「离锚点最远的先被收走」:上区锚在顶(head),命令区锚在底(账号卡)。 */
  const cut = (list: Entry[], cap: number, fromFront: boolean): { shown: Entry[]; tail: Entry[] } => {
    if (list.length <= cap) return { shown: list, tail: [] }
    const n = Math.max(0, cap - 1) // 留一格给「…」
    return fromFront
      ? { shown: list.slice(list.length - n), tail: list.slice(0, list.length - n) }
      : { shown: list.slice(0, n), tail: list.slice(n) }
  }
  const top = cut(topE, capT, false)
  const bot = cut(botE, capB, true)
  // 浮层内容一律从 live store / 当前溢出派生(FlyState 只存 id)——拖出/重排后自动跟随,不诈尸。
  const flyFolder = fly?.folderId ? folders.find((f) => f.id === fly.folderId) : undefined
  const flyTail = fly && !fly.folderId ? (fly.zone === 'top' ? top.tail : bot.tail) : undefined
  // 「…」浮层里的行仍是顶层条目:插入线方向必须按**完整顶层序**判(= dropOnBar 提交用的那一份),
  // 只拿局部 flyTail 判会反向 —— 条上的项拖进浮层时 indexOf 找不到,线画上沿而实际落在下面。
  const flyZoneIds = fly ? (fly.zone === 'top' ? topE : botE).map((e) => e.id) : []

  // ---- 浮层(收纳夹 / 「…」共用):悬停开,离开双方 150ms 后关;拖动中保持 ----
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
  }, [fly?.key, flyFolder?.items.length, flyTail?.length]) // eslint-disable-line react-hooks/exhaustive-deps
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
        title: () => (zh() ? `切到第 ${n} 个 Space` : `Switch to Space ${n}`),
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
    const els = group.querySelectorAll<HTMLElement>('.rb-slot')
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
    void ask(zh() ? '新建收纳夹' : 'New folder', zh() ? '收纳夹' : 'Folder').then((v) => {
      const name = v?.trim()
      if (name) st().addFolder(zone, name)
    })
  }
  const zoneMenu = (zone: RibbonZone): MenuState['entries'] => [
    ...(zone === 'top' && ribbonActions.newSpace ? [{ label: zh() ? '新建 Space' : 'New Space', onClick: ribbonActions.newSpace }] : []),
    ...(zone === 'bottom' ? [{ label: zh() ? '添加命令' : 'Add command', onClick: () => openCommandPicker((id) => st().addCommandItem(id)) }] : []),
    { label: zh() ? (zone === 'top' ? '新建收纳夹(Space 区)' : '新建收纳夹(命令区)') : zone === 'top' ? 'New folder (Spaces)' : 'New folder (commands)', onClick: () => createFolder(zone) },
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
        { label: zh() ? '更换图标' : 'Change icon', onClick: () => pickIcon(x, y, f.icon, (name) => st().setFolderIcon(f.id, name)) },
        { label: zh() ? '重命名' : 'Rename', onClick: () => { void ask(zh() ? '重命名收纳夹' : 'Rename folder', f.name).then((v) => { const n = v?.trim(); if (n) st().renameFolder(f.id, n) }) } },
        { label: zh() ? '解散收纳夹' : 'Dissolve folder', onClick: () => st().removeFolder(f.id) },
      ],
    })
  }
  const cmdCtx = (cmdId: string) => (e: React.MouseEvent): void => {
    e.preventDefault()
    e.stopPropagation()
    const x = e.clientX, y = e.clientY
    setMenu({ x, y, entries: [
      { label: zh() ? '设置图标' : 'Set icon', onClick: () => pickIcon(x, y, st().commandIcons[cmdId], (name) => st().setCommandIcon(cmdId, name)) },
      { label: zh() ? '从 Ribbon 移除' : 'Remove from ribbon', onClick: () => st().removeCommandItem(cmdId) },
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
        title={expanded ? undefined : `${f.name} (${f.items.length})`}
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
  const renderMoreBtn = (zone: RibbonZone): React.ReactNode => (
    <button
      className={`rb-btn rb-more${overFolder === `more:${zone}` ? ' drag-into' : ''}`}
      title={expanded ? undefined : zh() ? '更多' : 'More'}
      onMouseEnter={(e) => openFly(`more:${zone}`, zone, e.currentTarget)}
      onMouseLeave={scheduleClose}
      onDragOver={(e) => acceptOver(e, !!drag && drag.zone === zone, () => { setOver(null); setOverFolder(`more:${zone}`) })}
      onDragLeave={() => { if (overFolder === `more:${zone}`) setOverFolder(null) }}
      // 收进「…」= 挪到它吃的那一端:上区 = 区末尾,命令区 = 区开头。
      onDrop={(e) => { e.preventDefault(); e.stopPropagation(); dropOnBar(zone, zone === 'bottom' ? (botE[0]?.id ?? null) : null) }}
    >
      <MoreHorizontal size={18} />
      {expanded && <span className="rb-label">{zh() ? '更多' : 'More'}</span>}
    </button>
  )
  const renderEntry = (e: Entry, forceExpanded?: boolean): React.ReactNode => {
    const ex = forceExpanded ?? expanded
    if (e.kind === 'item') return <RibbonItemView item={e.item} expanded={ex} />
    if (e.kind === 'cmd') return <CmdItemView cmd={e.cmd} expanded={ex} overrideIcon={iconByName(commandIcons[e.cmd.id])} />
    return renderFolderBtn(e.folder)
  }
  /** i = 当前槽下标,preview = 落点预览后的 id 序;两者之差 = 让位位移(手机桌面那种排斥占位)。
   *  位移用布局 px(slotH)不是 rect 的视口 px —— transform 走的是未缩放坐标系。
   *  line = 被拖项不在本条上(从收纳夹/「…」浮层拖回来)时改画插入线:让位会把末槽压到「…」钮上。 */
  const renderSlot = (e: Entry, zone: RibbonZone, i: number, preview: string[] | null, line: boolean): React.ReactNode => {
    const to = preview ? preview.indexOf(e.id) : i
    return (
      <div
        key={e.id}
        data-id={e.id} /* 落点 e2e 用(scripts/ribbon-dnd.e2e.cjs) */
        className={`rb-slot${drag?.id === e.id ? ' dragging' : ''}${line ? ' drag-over' : ''}`}
        style={to !== i ? { transform: `translateY(${(to - i) * slotH}px)` } : undefined}
        draggable
        onDragStart={(ev) => { snapGeom(ev.currentTarget, ev.clientY); startDrag(ev, e.id, zone, null) }}
        onDragEnd={endDrag}
        onContextMenu={e.kind === 'cmd' ? cmdCtx(e.cmd.id) : undefined}
      >
        {renderEntry(e)}
        {/* 快捷键提示:只在展开态(收起态 32px 塞不下)、只给上区前 9 个。绝对定位 = 不进流,
            槽高常量 slotH 与拖拽落点几何一点不受影响。 */}
        {zone === 'top' && expanded && slotHint(i) && <span className="rb-key">{slotHint(i)}</span>}
      </div>
    )
  }
  const renderPlusBtn = (zone: RibbonZone): React.ReactNode => (
    <button
      className="rb-btn rb-plus"
      title={expanded ? undefined : zh() ? '添加' : 'Add'}
      onClick={(e) => {
        const r = e.currentTarget.getBoundingClientRect()
        setMenu({ x: r.right + 6, y: r.top, entries: zoneMenu(zone) })
      }}
    >
      <Plus size={16} />
      {expanded && <span className="rb-label">{zh() ? '添加' : 'Add'}</span>}
    </button>
  )
  // 命令区靠下贴账号卡,整组 = Spaces 区的镜像:[＋ / 「…」/ 图标…] ↔ [图标… / 「…」/ ＋],
  // 两个 ＋ 都贴着中间空隙,两个「…」都紧挨各自的图标列。
  // 拖放收在组这一层(不再逐槽挂):同一个 indexAt 既画让位预览又定提交落点 —— 提示在哪就落在哪。
  const renderZone = (zone: RibbonZone, part: { shown: Entry[]; tail: Entry[] }): React.ReactNode => {
    const ids = part.shown.map((e) => e.id)
    const preview = drag && over?.zone === zone && ids.includes(drag.id) ? moveTo(ids, drag.id, over.index) : null
    return (
      <div
        className={`rb-group rb-${zone}`}
        onContextMenu={onZoneCtx(zone)}
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
        {zone === 'bottom' && <>{renderPlusBtn(zone)}{part.tail.length > 0 && renderMoreBtn(zone)}</>}
        {part.shown.map((en, i) => renderSlot(en, zone, i, preview, !preview && over?.zone === zone && over.index === i))}
        {zone === 'top' && <>{part.tail.length > 0 && renderMoreBtn(zone)}{renderPlusBtn(zone)}</>}
      </div>
    )
  }

  // ---- 浮层内容:收纳夹成员 或 「…」尾部条目(其中的收纳夹内联铺开) ----
  //  list = 本行所在的 id 序;下移时落点在该行「之下」,插入线跟着画到下沿(否则线在骗人)。
  const flyRow = (e: Entry, folder: RibbonFolder | null, at: number, list: string[]): React.ReactNode => (
    <div
      key={e.id}
      className={`rb-fly-row${drag?.id === e.id ? ' dragging' : ''}${overId === e.id && drag?.id !== e.id ? ` drag-over${drag && list.indexOf(drag.id) >= 0 && list.indexOf(drag.id) < at ? ' below' : ''}` : ''}`}
      draggable
      onDragStart={(ev) => { ev.stopPropagation(); startDrag(ev, e.id, folder?.zone ?? fly!.zone, folder?.id ?? null) }}
      onDragOver={(ev) => acceptOver(ev, !!drag && drag.zone === (folder?.zone ?? fly!.zone) && drag.id !== e.id && !drag.id.startsWith('folder:'), () => setOverId(e.id))}
      onDragLeave={() => { if (overId === e.id) setOverId(null) }}
      onDrop={(ev) => {
        ev.preventDefault()
        ev.stopPropagation()
        if (folder) dropIntoFolder(folder, at)
        else dropOnBar(fly!.zone, e.id) // 「…」浮层里的行仍是顶层条目,重排走区顺序
      }}
      onDragEnd={endDrag}
      onContextMenu={e.kind === 'cmd' ? cmdCtx(e.cmd.id) : folder ? (ev) => {
        ev.preventDefault()
        ev.stopPropagation()
        setMenu({ x: ev.clientX, y: ev.clientY, entries: [{ label: zh() ? '移出收纳夹' : 'Move out', onClick: () => { st().moveOutOfFolder(e.id); const persisted = folder.zone === 'top' ? st().order : st().bottomOrder; st().setZoneOrder(folder.zone, [...reorderBase(persisted, (folder.zone === 'top' ? topE : botE).map((x) => x.id), e.id), e.id]) } }] })
      } : undefined}
    >
      {renderEntry(e, true)}
    </div>
  )

  return (
    // rb-dragging 只在拖动中挂:让位动画的 transition 也只在这期间生效。松手时 DOM 顺序变了、
    // transform 归零,若还带着 transition 就会从错误的偏移飞回来(旧位移是相对旧布局的)。
    <div
      ref={rootRef}
      className={`rb${expanded ? ' rb-expanded' : ''}${drag ? ' rb-dragging' : ''}`}
      onContextMenu={onRootCtx}
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
        <button className="rb-btn rb-toggle" title={expanded ? undefined : (zh() ? '展开' : 'Expand')} onClick={() => st().toggleExpanded()}>
          {expanded ? <PanelLeftClose size={18} /> : <PanelLeftOpen size={18} />}
          {expanded && <span className="rb-label">{zh() ? '折叠侧栏' : 'Collapse'}</span>}
        </button>
      </div>
      {renderZone('top', top)}
      {renderZone('bottom', bot)}
      <div ref={pinnedRef} className="rb-group rb-pinned">
        {pinned.map((i) => <RibbonItemView key={i.id} item={i} expanded={expanded} />)}
      </div>

      {fly && (
        <div
          ref={flyRef}
          className="rb-fly"
          /* rect/fly.top 是视口 px,fixed 的 left/top 会被祖先 zoom 再乘一遍 → 先除掉(见 menuAnchor.tsx)。 */
          style={(() => { const z = zoomOf(rootRef.current); return { left: ((rootRef.current?.getBoundingClientRect().right ?? 44) + 4) / z, top: fly.top / z } })()}
          onMouseEnter={cancelClose}
          onMouseLeave={scheduleClose}
          onDragOver={(e) => acceptOver(e, !!drag && drag.zone === fly.zone && !!flyFolder && !drag.id.startsWith('folder:') && e.target === e.currentTarget)}
          onDrop={(e) => { if (flyFolder && e.target === e.currentTarget) { e.preventDefault(); dropIntoFolder(flyFolder) } }}
        >
          <div className="rb-fly-head">{flyFolder ? flyFolder.name : zh() ? '更多' : 'More'}</div>
          {flyFolder && flyFolder.items.length === 0 && <div className="rb-fly-empty">{zh() ? '拖动图标到收纳夹图标放入' : 'Drag icons onto the folder to collect'}</div>}
          {flyFolder
            ? flyFolder.items.map((id, i) => { const e = byId.get(id); return e ? flyRow(e, flyFolder, i, flyFolder.items) : null })
            : flyTail?.map((e) => e.kind === 'folder'
              ? ( // 「…」里的收纳夹:标题行可拖出重排 + 可放入,下接成员行(修 codex#6)
                <div key={e.id}>
                  <div
                    className={`rb-fly-sub rb-fly-folderhead${overFolder === e.id ? ' drag-into' : ''}${drag?.id === e.id ? ' dragging' : ''}`}
                    draggable
                    onDragStart={(ev) => { ev.stopPropagation(); startDrag(ev, e.id, fly.zone, null) }}
                    onDragOver={(ev) => acceptOver(ev, !!drag && drag.zone === fly.zone && !drag.id.startsWith('folder:'), () => setOverFolder(e.id))}
                    onDragLeave={() => { if (overFolder === e.id) setOverFolder(null) }}
                    onDrop={(ev) => { ev.preventDefault(); ev.stopPropagation(); dropIntoFolder(e.folder) }}
                    onDragEnd={endDrag}
                    onContextMenu={folderCtx(e.folder)}
                  >
                    {(() => { const I = iconByName(e.folder.icon) ?? FolderIcon; return <I size={13} /> })()} {e.folder.name}
                  </div>
                  {e.folder.items.map((id, i) => { const m = byId.get(id); return m ? flyRow(m, e.folder, i, e.folder.items) : null })}
                </div>
              )
              : flyRow(e, null, flyZoneIds.indexOf(e.id), flyZoneIds))}
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
            <button className="rb-iconpick-reset" onClick={() => { const a = iconPick.apply; setIconPick(null); a('') }}>{zh() ? '默认图标' : 'Default'}</button>
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
