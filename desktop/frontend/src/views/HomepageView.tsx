/**
 * Homepage View —— 内置插件「主页」的主区视图(旧 `apps/Archived/Forsion-Desktop` 桌面首页在 LCL 里的重写)。
 *
 * 四块,自上而下:
 *  · **标志性标题** 「Forsion is All You Need」,手写体(随包 Dancing Script 子集,见 assets/fonts/README)。
 *    旧版这句住在 CardZone 的 title 区(SloganCard),这里做成固定排版。
 *  · **标题区** 时钟 + 日期 + 问候(登录名来自 `window.tangu.authStatus`)。
 *  · **输入区** 直接复用 Tangu Chat View 的 `Composer2`:模型、模式、附件、引用、语音和命令
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
import { useEffect, useMemo, useRef, useState } from 'react'
import {
  DndContext, DragOverlay, KeyboardSensor, PointerSensor, closestCenter, pointerWithin,
  useDraggable, useDroppable, useSensor, useSensors,
  type CollisionDetection,
  type DragCancelEvent, type DragEndEvent, type DragOverEvent, type DragStartEvent,
} from '@dnd-kit/core'
import { SortableContext, rectSortingStrategy, sortableKeyboardCoordinates, useSortable } from '@dnd-kit/sortable'
import { CSS as DndCSS } from '@dnd-kit/utilities'
import {
  Check, FolderMinus, FolderOpen, FolderPlus, Grid2X2, Image, LogOut,
  Pencil, RefreshCw, Upload, X,
} from 'lucide-react'
import { setActiveSpace, useSpaceStore, useRibbonStore, useWorkspace, label, moveTo, OverlayAt } from '@lcl/engine'
import { rankIds, reorderBase, unionOrder } from '@lcl/engine/ribbonRegistry'
import type { SpaceDefinition, RibbonFolder, RibbonItem, ViewProps } from '@lcl/engine'
import { askString } from '@amadeus/components/askString'
import { useApp, newChatModelId, stickyDefaults, withAmadeusWorkspace } from '../stores/appStore'
import type { Attachment } from '../types'
import { usePageStore } from '../amadeus/store/pageStore'
import { Composer2 } from './chat2/Composer2'
import { useI18n } from '../i18n'
import { useShallow } from 'zustand/react/shallow'
import {
  clearCustomWallpaper, fetchBingWallpapers, loadHomepageWallpaperPrefs, readCustomWallpaper,
  saveHomepageWallpaperPrefs, writeCustomWallpaper,
  type BingWallpaper, type HomepageThemePreset, type HomepageWallpaperPrefs, type HomepageWallpaperSource,
} from './homepageWallpaper'
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
const THEME_PRESETS: HomepageThemePreset[] = ['rings', 'topography', 'weave', 'horizon']

/** 指针拖放以「指针真正在谁里面」为准,避免 body zoom 下 active rect 中心偏移选错落点;
 * 键盘拖放没有 pointerCoordinates,回落 closestCenter 保留方向键可访问性。 */
const dockCollision: CollisionDetection = (args) => {
  const hits = pointerWithin(args)
  return hits.length ? hits : closestCenter(args)
}

/** 坞里的一格:一个 Space,或一个收纳夹(含它当前能解析出来的成员)。 */
type Tile =
  | { kind: 'space'; id: string; space: SpaceDefinition }
  | { kind: 'folder'; id: string; folder: RibbonFolder; members: SpaceDefinition[] }

type HomeDispatch = (
  text: string,
  attachments: Attachment[],
  workspaceFiles?: Attachment[],
  skillIds?: string[],
  mentions?: { priorityAgent?: string; mentionAgents?: string[] },
) => void

/**
 * 主页只做「新对话」的宿主接线,输入 UI 和交互不复制:字面挂的就是 ChatView 里的 Composer2。
 * `sessionId={null}` 强制 slash / 引用菜单也按新对话语义跑,不误操作用户上次停留的会话。
 */
function HomepageChatbox({ onDispatch, onInputModeChange }: { onDispatch: HomeDispatch; onInputModeChange: (focused: boolean) => void }) {
  const vaultRoot = usePageStore((state) => state.vaultRoot)
  const s = useApp(useShallow((state) => ({
    cfg: state.cfg,
    desktopConfig: state.desktopConfig,
    modelsResp: state.modelsResp,
    newChatWs: state.newChatWs,
    newChatCfg: state.newChatCfg,
    newChatModel: state.newChatModel,
    engines: state.engines,
    engineCaps: state.engineCaps,
    agentDefs: state.agentDefs,
    defaultAgentSlug: state.defaultAgentSlug,
    skillsList: state.skillsList,
    connState: state.connState,
    voiceOnByAgent: state.voiceOnByAgent,
    ensureEngineCaps: state.ensureEngineCaps,
    refreshVoiceMode: state.refreshVoiceMode,
    setSessionModel: state.setSessionModel,
    setNewChatCfg: state.setNewChatCfg,
    setSessionThinking: state.setSessionThinking,
    setDefaultModel: state.setDefaultModel,
    setVoiceMode: state.setVoiceMode,
    setExecConfig: state.setExecConfig,
    openSettings: state.openSettings,
  })))

  const cloud = s.newChatWs?.kind === 'cloud' || s.newChatWs?.kind === 'rootless'
  const config = useMemo(() => withAmadeusWorkspace({
    execMode: cloud ? 'sandbox' : 'host',
    ...stickyDefaults(s.desktopConfig, !cloud),
    cwd: cloud ? undefined : (s.newChatWs?.path || undefined),
    ...s.newChatCfg,
  }, vaultRoot), [cloud, s.desktopConfig, s.newChatCfg, s.newChatWs?.path, vaultRoot])
  const modelId = newChatModelId(s) || ''
  const visibleModels = !s.modelsResp?.models
    ? null
    : s.modelsResp.models.filter((m) => (m.modelType || 'llm') === 'llm' && (!cloud || m.source === 'forsion'))
  const agentSlug = config.agentSlug || s.defaultAgentSlug
  const voiceOn = agentSlug ? !!s.voiceOnByAgent[agentSlug] : false

  useEffect(() => { void s.ensureEngineCaps(config.engineId || undefined) }, [config.engineId, s.ensureEngineCaps])
  useEffect(() => { if (agentSlug) void s.refreshVoiceMode(agentSlug) }, [agentSlug, s.refreshVoiceMode])

  return (
    <div
      className="hp-composer"
      onClick={(e) => e.stopPropagation()}
      // 模型/模式/附件和它们的菜单都属于输入准备,共用一个聚焦范围。
      onPointerDownCapture={() => onInputModeChange(true)}
      onPointerDown={(event) => event.stopPropagation()}
      onFocusCapture={() => onInputModeChange(true)}
      onBlurCapture={(event) => {
        // 内部焦点转移不退场;选项卸载/点菜单空白导致的 relatedTarget=null 也保留。
        // 真正点击外部由主页的 onPointerDown 收尾,Tab 到外部控件则在这里退出。
        if (event.relatedTarget instanceof Node && !event.currentTarget.contains(event.relatedTarget)) onInputModeChange(false)
      }}
      onKeyDownCapture={(event) => {
        if (event.key === 'Escape' && (event.target as HTMLElement).matches?.('.t2c-ta')) {
          ;(event.target as HTMLTextAreaElement).blur()
          onInputModeChange(false)
        }
      }}
    >
      <Composer2
        sessionId={null}
        autoFocus={false}
        disabled={s.connState !== 'ok'}
        running={false}
        execConfig={config}
        models={visibleModels}
        modelsResponse={s.modelsResp}
        modelId={modelId}
        onModelChange={(id) => s.setSessionModel(id, null)}
        engines={s.engines}
        engineId={config.engineId}
        engineModels={config.engineId ? (s.engineCaps[config.engineId]?.models ?? []) : undefined}
        engineModelId={config.engineModelId}
        onEngineModelChange={(id) => s.setNewChatCfg((c) => ({ ...c, engineModelId: id || undefined }))}
        engineCommands={config.engineId ? (s.engineCaps[config.engineId]?.commands ?? []) : undefined}
        thinkingLevel={config.thinkingLevel}
        onThinkingChange={(level) => s.setSessionThinking(level, null)}
        defaultModelIds={{
          backgroundModelId: s.desktopConfig?.backgroundModelId || '',
          imageModelId: s.cfg.imageModelId || '',
          visionModelId: s.cfg.visionModelId || '',
        }}
        onDefaultModelChange={s.setDefaultModel}
        maxIterations={config.maxIterations}
        onMaxIterationsChange={(n) => s.setNewChatCfg((c) => ({ ...c, maxIterations: n }))}
        verifyCommand={config.verifyCommand}
        onVerifyCommandChange={(cmd) => s.setNewChatCfg((c) => ({ ...c, verifyCommand: cmd || undefined }))}
        planMode={config.planMode}
        onPlanModeChange={(on) => s.setNewChatCfg((c) => ({ ...c, planMode: on }))}
        voiceMode={voiceOn}
        onVoiceModeChange={agentSlug ? (on) => void s.setVoiceMode(agentSlug, on) : undefined}
        groupChat={config.groupChat}
        groupAgents={config.groupAgents}
        groupTempAgents={config.groupTempAgents}
        groupIntensity={config.groupIntensity}
        groupMaxRounds={config.groupMaxRounds}
        onGroupChange={(patch) => s.setNewChatCfg((c) => ({ ...c, ...patch }))}
        skills={s.skillsList}
        agents={s.agentDefs}
        onOpenSettings={() => s.openSettings('skills')}
        onExecConfigChange={(patch) => s.setExecConfig(patch, null)}
        onSend={async (text, attachments, workspaceFiles, skillIds, mentions) => {
          onDispatch(text, attachments, workspaceFiles, skillIds, mentions)
          return true
        }}
        onStop={() => {}}
        autoRefFromMain={false}
      />
    </div>
  )
}

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
function useClock(locale: string): { time: string; date: string; hour: number } {
  const calc = (): { time: string; date: string; hour: number } => {
    const d = new Date()
    return {
      time: d.toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit', hour12: false }),
      // 分两趟拼:zh-CN 的 { month, day, weekday } 会连成「8月27日星期四」,中间要留一口气。
      date: `${d.toLocaleDateString(locale, { month: 'long', day: 'numeric' })} ${d.toLocaleDateString(locale, { weekday: 'long' })}`,
      hour: d.getHours(),
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

/** 登录名(有就用来问候);未登录 / 非 electron 宿主 → 空串,问候语自己少一截。 */
function useAccountName(): string {
  const [name, setName] = useState('')
  useEffect(() => {
    let alive = true
    const read = (): void => {
      void window.tangu?.authStatus?.()
        .then((a) => { if (alive) setName(a?.loggedIn ? (a.nickname || a.username || '') : '') })
        .catch(() => {})
    }
    read()
    const off = window.tangu?.onAuthChanged?.(read)
    return () => { alive = false; off?.() }
  }, [])
  return name
}

/**
 * 坞的条目 = ribbon 上区的顶层条目(Space + 收纳夹),按用户保存的顺序排。
 *
 * ⚠️与 `Ribbon.zoneList` 同一口径:遍历**活的** spaces ∪ folders 再按 `order` 排名,
 * 绝不去遍历 `order` 本身 —— 那份持久数组里留着停用插件、已删用户 Space 的陈年 id
 * (`removeRibbonIcon` 只在真正反注册时清,插件关掉那条路会清,但历史存档不保证干净),
 * 照着它渲染就会画出点不动的幽灵格。收纳夹成员同理:解析不到的成员静默丢掉。
 *
 * 返回的 `topIds` = 顶层序:**排掉夹内成员**(同 Ribbon 的 topE),但**含主页自己**
 * (它只是不显示,顺序上仍然占一格)。重排写回一律以它为基准,见 dropOn 的注释。
 */
function useDockTiles(): { tiles: Tile[]; topIds: string[]; order: string[] } {
  const spaces = useSpaceStore((s) => s.spaces)
  const order = useRibbonStore((s) => s.order)
  const folders = useRibbonStore((s) => s.folders)

  const topFolders = folders.filter((f) => f.zone === 'top')
  const spaceOf = (rid: string): SpaceDefinition | undefined => spaces.find((s) => `space:${s.id}` === rid)
  const inFolder = new Set(topFolders.flatMap((f) => f.items))

  // 夹内成员**不进顶层序** —— 与 Ribbon.zoneList 的 `.filter((e) => !inFolder.has(e.id))` 同一句。
  // (Codex 评审 high:不过滤的话,重排写回会把夹内成员当顶层项塞进持久 order,
  //  解散收纳夹时 removeFolder 又把 items 原样splice 回去 → 同一个 id 在 order 里出现两次。)
  const topIds = rankIds([...spaces.map((s) => `space:${s.id}`), ...topFolders.map((f) => f.id)], order)
    .filter((id) => !inFolder.has(id))
  const tiles: Tile[] = []
  for (const id of topIds) {
    if (id === `space:${SELF_SPACE}`) continue // 主页自己不进坞:点了等于原地不动(但**仍在 topIds 里**)
    const f = topFolders.find((x) => x.id === id)
    if (f) { tiles.push({ kind: 'folder', id, folder: f, members: f.items.map(spaceOf).filter((s): s is SpaceDefinition => !!s) }); continue }
    const sp = spaceOf(id)
    if (sp) tiles.push({ kind: 'space', id, space: sp })
  }
  return { tiles, topIds, order }
}

interface MenuState { x: number; y: number; kind: 'folder' | 'member'; id?: string }

export function HomepageView(_props: ViewProps) {
  const { t, locale } = useI18n()
  const zh = locale === 'zh'
  const clock = useClock(zh ? 'zh-CN' : 'en-US')
  const name = useAccountName()
  const spaces = useSpaceStore((s) => s.spaces)
  const ribbonItems = useRibbonStore((s) => s.items)
  const { tiles, topIds, order } = useDockTiles()
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
  const [customWallpaperUrl, setCustomWallpaperUrl] = useState<string | null>(null)
  const [bingWallpapers, setBingWallpapers] = useState<BingWallpaper[]>([])
  const [bingLoading, setBingLoading] = useState(false)
  const [wallpaperError, setWallpaperError] = useState('')
  const [bingReload, setBingReload] = useState(0)
  const rootRef = useRef<HTMLDivElement>(null)
  const fileRef = useRef<HTMLInputElement>(null)
  const leaveTimer = useRef<number | null>(null)
  const pending = useRef<(() => void) | null>(null)
  // 一次性读:动画偏好在会话中途变了也不值得重挂监听(下次进主页即生效)。
  const [reduceMotion] = useState(() => { try { return window.matchMedia('(prefers-reduced-motion: reduce)').matches } catch { return false } })
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  )

  useEffect(() => { saveHomepageWallpaperPrefs(wallpaperPrefs) }, [wallpaperPrefs])
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
          setWallpaperPrefs((prefs) => prefs.source === 'custom' ? { ...prefs, source: 'theme' } : prefs)
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
  const leaveThen = (run: () => void): void => {
    if (leaveTimer.current) return
    if (reduceMotion) { run(); return }
    setLeaving(true)
    pending.current = run // 卸载兜底要拿得到(见上面的 cleanup)
    leaveTimer.current = window.setTimeout(() => {
      leaveTimer.current = null
      pending.current = null
      run()
    }, LEAVE_MS)
  }

  const hasTangu = spaces.some((s) => s.id === 'tangu')

  const greet = clock.hour < 5 ? 'home.greet.night' : clock.hour < 11 ? 'home.greet.morning' : clock.hour < 18 ? 'home.greet.afternoon' : 'home.greet.evening'
  const rb = () => useRibbonStore.getState()
  const closePops = (): void => { setOpenFolder(null); setOrganizerOpen(false); setMenu(null) }
  const wallpaperUrl = wallpaperPrefs.source === 'bing'
    ? wallpaperPrefs.bing?.url || null
    : wallpaperPrefs.source === 'custom' ? customWallpaperUrl : null

  const patchWallpaperPrefs = (patch: Partial<HomepageWallpaperPrefs>): void => {
    setWallpaperPrefs((prefs) => ({ ...prefs, ...patch }))
  }

  const selectWallpaperSource = (source: HomepageWallpaperSource): void => {
    if (source === 'custom' && !customWallpaperUrl) { fileRef.current?.click(); return }
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
        patchWallpaperPrefs({ source: 'custom' })
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
  /** 把 `drag` 落到 `targetId` 那一格上 —— 与 Ribbon 的 `dropOnBar` 逐句同构。
   *  ⚠️两条都不能省:
   *   · 基准序含**主页自己**(它在坞上不显示,顺序上仍占一格)。漏了 = 它从持久数组消失 →
   *     `rankIds` 把未列出的排最后 → 主页图标第一次拖坞之后就掉进 ribbon 的「…」。
   *   · 基准序**不含夹内成员**(`topIds` 已过滤)。混进去 = 夹里的 id 被当顶层项写进 order,
   *     解散夹时 `removeFolder` 再 splice 一次 → order 里同一个 id 出现两次。 */
  const dropOn = (moved: string, targetId: string): void => {
    if (!moved || moved === targetId) return
    const full = unionOrder(order, topIds) // 保住持久序里「此刻不可见」的项(用户 Space 异步注册)
    const at = full.indexOf(targetId)
    rb().setZoneOrder('top', moveTo(full, moved, at >= 0 ? at : full.length))
  }

  /** 收进收纳夹 —— 同 Ribbon 的 `dropIntoFolder`:改夹成员**必须配一次区顺序写回**,
   *  把它从顶层序里摘掉,否则解散夹时会多出一个重复 id。 */
  const dropInto = (moved: string, folderId: string): void => {
    if (!moved || moved === folderId || moved.startsWith('folder:')) return // 夹套夹:ribbon 也不做
    rb().moveIntoFolder(folderId, moved)
    rb().setZoneOrder('top', reorderBase(order, topIds, moved))
  }

  /** 移出收纳夹 —— 同 Ribbon 浮层右键的那条:去 membership + 把它写回顶层序末尾。 */
  const moveOut = (itemId: string): void => {
    rb().moveOutOfFolder(itemId)
    rb().setZoneOrder('top', [...reorderBase(order, topIds, itemId), itemId])
    setOrganizerOpen(true) // 移出即回到收纳层,让用户立刻看到它回到了顶层。
  }

  const newFolder = (): void => {
    setMenu(null)
    void askString(zh ? '新建收纳夹' : 'New folder', zh ? '收纳夹' : 'Folder').then((v) => {
      const n = v?.trim()
      if (n) { rb().addFolder('top', n); setOrganizerOpen(true) }
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
    if (!moved.startsWith('folder:') && target?.kind === 'folder') dropInto(moved, targetId)
    else dropOn(moved, targetId)
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
  const visibleTiles = tiles.slice(0, COMPACT_TILE_LIMIT)
  const hiddenCount = Math.max(0, tiles.length - visibleTiles.length)
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
    const moved = String(event.active.id)
    const target = String(event.over.id)
    if (moved === target) return
    const at = folderOpen.folder.items.indexOf(target)
    rb().setFolderItems(folderOpen.id, moveTo(folderOpen.folder.items, moved, at < 0 ? folderOpen.folder.items.length : at))
  }

  /** 主页输入始终开**新**会话。先切 Space 再发,并显式传 `sessionId=null`:
   *  ① 不会把主页 leaf 就地换成 chat;② 不会把上次 activeId 当成续聊;
   *  ③ 不调 openNewChat,因此 Composer2 里刚选的模型/模式/工作区不会被它的「清新会话草稿」逻辑擦掉。 */
  const dispatchChat: HomeDispatch = (text, attachments, workspaceFiles, skillIds, mentions) => {
    if (!hasTangu) return
    leaveThen(() => {
      setActiveSpace('tangu')
      // 老用户的 Tangu 命名布局可能把主 chat 关过;首页发话就是显式要去聊天,这里保证有一张聊天视图接住新会话。
      useWorkspace.getState().openView('chat', { followActive: true, reuseKey: 'primary' }, 'main')
      void useApp.getState().send(text, attachments, workspaceFiles, skillIds, mentions, null)
    })
  }

  const exitComposerInputMode = (): void => {
    const active = document.activeElement
    if (active instanceof HTMLTextAreaElement && active.matches('.hp-composer .t2c-ta')) active.blur()
    setComposerFocused(false)
  }

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

  return (
    <div
      ref={rootRef}
      className={`hp-root${reduceMotion ? ' hp-still' : ''}${composerFocused ? ' hp-composer-focused' : ''}${wallpaperOpen ? ' hp-layer-focused' : ''}${openFolder || organizerOpen ? ' hp-secondary-open' : ''}`}
      data-wallpaper={wallpaperUrl ? 'true' : undefined}
      data-theme-preset={wallpaperPrefs.themePreset}
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
      <div className="hp-wallpaper-art" aria-hidden />
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
          <div className="hp-date">{clock.date}</div>
          <div className="hp-greet">{name ? t(greet + '.named', { name }) : t(greet)}</div>
        </div>

        {hasTangu && <HomepageChatbox onDispatch={dispatchChat} onInputModeChange={setComposerFocused} />}

        {/* 收纳架只保留一排摘要;“全部”与空白右键都进入独立二级收纳层。 */}
        <section className="hp-spaces" data-total={tiles.length}>
          <header className="hp-spaces-head">
            <div className="hp-spaces-title">
              <span>{t('home.spaces')}</span>
              <span className="hp-spaces-count">{t('home.spaceCount', { n: spaceCount })}</span>
            </div>
            <div className="hp-spaces-actions">
              <button type="button" onClick={(event) => { event.stopPropagation(); newFolder() }} title={t('home.newFolder')}>
                <FolderPlus size={13} /> <span>{t('home.newFolder')}</span>
              </button>
            </div>
          </header>

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
                onLaunch={(spaceId) => leaveThen(() => setActiveSpace(spaceId))}
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
                          onLaunch={(spaceId) => leaveThen(() => setActiveSpace(spaceId))}
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
                          <span className="hp-tile-name">{t('home.showAll')}</span>
                          <span className="hp-more-count">+{hiddenCount}</span>
                        </button>
                      )}
                    </div>
                  </SortableContext>
                ) : (
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
        </section>
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
              {(['theme', 'bing', 'custom'] as HomepageWallpaperSource[]).map((source) => (
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
                      <span className="hp-theme-preview" data-preset={preset} aria-hidden />
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

            {wallpaperPrefs.source === 'custom' && (
              <div className="hp-wallpaper-custom">
                <div className="hp-wallpaper-custom-preview" style={customWallpaperUrl ? { backgroundImage: `url(${JSON.stringify(customWallpaperUrl)})` } : undefined} />
                <div>
                  <strong>{t('home.wallpaper.customReady')}</strong>
                  <span>{t('home.wallpaper.customHint')}</span>
                </div>
                <button type="button" onClick={() => fileRef.current?.click()}><Upload size={13} /> {t('home.wallpaper.replace')}</button>
                <button type="button" onClick={removeCustomWallpaper}>{t('home.wallpaper.remove')}</button>
              </div>
            )}

            <div className="hp-wallpaper-options">
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
                      onLaunch={(spaceId) => { setOrganizerOpen(false); leaveThen(() => setActiveSpace(spaceId)) }}
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
                        onLaunch={(id) => { setOpenFolder(null); leaveThen(() => setActiveSpace(id)) }}
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

      {menu && (
        <OverlayAt className="ctx-menu" x={menu.x} y={menu.y} onClick={(e) => e.stopPropagation()}>
          {menu.kind === 'folder' && (
            <>
              <button onClick={() => {
                const id = menu.id!
                const cur = tiles.find((x) => x.id === id)
                setMenu(null)
                void askString(zh ? '重命名收纳夹' : 'Rename folder', cur?.kind === 'folder' ? cur.folder.name : '').then((v) => {
                  const n = v?.trim()
                  if (n) rb().renameFolder(id, n)
                })
              }}><Pencil size={13} /> {zh ? '重命名' : 'Rename'}</button>
              <button onClick={() => { rb().removeFolder(menu.id!); setMenu(null) }}><FolderMinus size={13} /> {zh ? '解散收纳夹' : 'Dissolve folder'}</button>
            </>
          )}
          {menu.kind === 'member' && (
            <button onClick={() => { moveOut(menu.id!); setMenu(null); setOpenFolder(null) }}><LogOut size={13} /> {zh ? '移出收纳夹' : 'Move out'}</button>
          )}
        </OverlayAt>
      )}
    </div>
  )
}
