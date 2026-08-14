/**
 * 单列外壳:替换 desktop 的 engine/Shell(Dockview 三栏)为**单列**布局(2026-08-05 Obsidian 式改版)。
 * - 顶栏:极简 —— 左右抽屉开合钮 + 标签页切换钮(带 tab 计数) + 右上「⋯」;不再显示标题/Space 名。
 * - 主区:全屏渲染当前 active 主 leaf 的视图(getView(type).factory({leaf, params}))。
 * - 侧栏(loc:left/right):**push 连贯式**抽屉 —— 面板滑入的同时把 main 原尺寸推开(不是遮罩浮层),
 *   iOS 手感缓动;容器恒挂载(才有退场动画),内容首开后常驻(保树状态)。
 * - 左抽屉底部常驻:Space 切换条(原全局底栏移入)+ 账号卡 + 设置钮(读 ribbon 注册表,引擎不 import feature)。
 * - 「⋯」菜单:桌面 ribbon 底部功能的手机落点;账号/设置两项已迁去左抽屉底部,此处滤掉。
 * - 系统返回(Android):MobileRoot 派发可取消的 `forsion:mobile-back`,本壳先接管 tab sheet/「⋯」的关闭。
 * mobile 构建直接渲染它(MobileRoot);desktop/web 由 Shell 在 UI_MODE==='mobile' 时套「手机框」渲染。
 */
import { Suspense, useEffect, useRef, useState } from 'react'
import { PanelLeft, PanelRight, X, MoreHorizontal, Plus } from 'lucide-react'
import { useSpaceStore, setActiveSpace, getActiveSpace } from './spaceRegistry'
import { useRibbonStore } from './ribbonRegistry'
import { getView } from './viewRegistry'
import { label } from './types'
import { useWorkspace, restoreSingleColumnLayout } from './singleColumnStore'
import { Skeleton, ViewErrorBoundary, skeletonVariantOf } from './Skeleton'
import './singleColumn.css'
// ⚠️ 引擎 chrome 样式。移动端构建把 `Shell.tsx` 换成空壳(mobile/vite.config engineSwap),而
// `import './engine.css'` 原本挂在 Shell 上 —— 外壳一换,`.cmd-overlay/.cmd-panel` 这套命令浮层
// 样式在移动端就整个没了(CommandPalette 与 Amadeus 的 QuickSwitcher/TemplatePicker 三家共用)。
// 缺了它浮层不是不显示,而是**落进普通文档流**:没有 position:fixed / z-index,盖不住单列壳。
// 直接借整份而不是抽 .cmd-* 出来:engine.css 通篇是类选择器(.rb-/.dv-/.wb-/.cmd-),无 :root/html/body
// 全局规则,单列壳的 .mb-* 与之零交集 —— 不匹配的规则是惰性的,抽文件反而要动别的会话正在改的 engine.css。
import './engine.css'

/** 下滑收起浮动 chrome(顶部胶囊 + 编辑器底部悬浮条)、上滑立刻召回 —— 扩大阅读区,同时保证入口能快速找回。
 *  ⚠️ scroll 事件**不冒泡**,但捕获阶段照样经过祖先。所以一个挂在 .mb-main 上的捕获监听就吃下了全部子
 *  视图的滚动 —— 每个视图的滚动器都不一样(.t2-stream / .amx-editor / .newtab / 各种列表),逐视图接线
 *  既漏又要改二十几个文件。返回 true = 该收起;位移全在 CSS 的 [data-chrome='off'] 里。 */
function useChromeAutoHide(ref: React.RefObject<HTMLElement | null>, enabled: boolean): boolean {
  const [off, setOff] = useState(false)
  // 换视图 / 开抽屉 → 无条件召回:换了页面 chrome 还藏着,用户会以为按钮没了。
  const activeId = useWorkspace((s) => s.activeMainId)
  const anyDrawer = useWorkspace((s) => s.leftVisible || s.rightVisible)
  useEffect(() => { setOff(false) }, [activeId, anyDrawer, enabled])
  useEffect(() => {
    const root = ref.current
    if (!root || !enabled) return
    let src: HTMLElement | null = null
    let last = 0
    let acc = 0
    const onScroll = (e: Event): void => {
      const el = e.target as HTMLElement | null
      if (!el || !(el instanceof HTMLElement)) return
      // 换了滚动器(切视图/切面板/抽屉里的列表)→ 这一帧的 delta 是跨元素的垃圾值,只重置基线不判方向。
      if (el !== src) { src = el; last = el.scrollTop; acc = 0; return }
      const top = el.scrollTop
      const dy = top - last
      last = top
      if (Math.abs(dy) < 2) return // 惯性尾巴 / 亚像素抖动
      if (top < 56) { acc = 0; setOff(false); return } // 顶部一段恒显示
      acc = dy > 0 === acc > 0 ? acc + dy : dy // 同向累积,换向清零(免得惯性回弹来回抽搐)
      if (acc > 44) {
        // 正在打字不收:编辑器底栏是此刻唯一的操作入口,收了等于把工具抽走。键盘弹出本身也会让页面滚。
        const a = document.activeElement as HTMLElement | null
        if (a && (a.isContentEditable || /^(input|textarea)$/i.test(a.tagName))) return
        setOff(true)
      } else if (acc < -28) setOff(false)
    }
    // 一落焦到可编辑处就召回:收起态下点正文 → 键盘弹出,而工具条还被 translate 推在屏外,
    // 用户就得先滚回顶才拿得到「+」。focusin 会冒泡(focus 不会),挂根上一处即可。
    const onFocusIn = (ev: Event): void => {
      const t = ev.target as HTMLElement | null
      if (t && (t.isContentEditable || /^(input|textarea)$/i.test(t.tagName))) { acc = 0; setOff(false) }
    }
    root.addEventListener('scroll', onScroll, true)
    root.addEventListener('focusin', onFocusIn)
    return () => {
      root.removeEventListener('scroll', onScroll, true)
      root.removeEventListener('focusin', onFocusIn)
    }
  }, [ref, enabled])
  return off
}

export function LeafHost() {
  // 订阅 active 的 id、type、以及 **params 的对象身份**。标题变化仍不重渲染宿主——视图渲染期
  // 调 leaf.setTitle 会触发宿主重渲染→再调 setTitle→无限循环(React #185)。
  // params 必须订阅:主区「就地导航」在同 id 同 type 时只换 params(amadeus-editor 换 notePath、
  // wsfile 换 path)——此前不订阅,LeafHost 不重渲、视图永远收不到新参数,移动端表现为
  // 「点了列表行没反应/编辑器还是旧笔记」(2026-08-05 用户实报,探针 note-open.e2e 复现)。
  // 不会回循环:setParams 有逐键相等守卫(没真变不 set),setTitle 不碰 params。
  const activeId = useWorkspace((s) => s.activeMainId)
  const activeType = useWorkspace((s) => s.mainLeaves.find((r) => r.id === s.activeMainId)?.type)
  const activeParams = useWorkspace((s) => s.mainLeaves.find((r) => r.id === s.activeMainId)?.params)
  if (!activeId || !activeType) return null
  const active = useWorkspace.getState().getActiveLeaf()
  const def = active ? getView(active.type) : null
  if (!active || !def) return null
  // 面板级兜底(与 desktop WorkspaceHost 同款):懒视图挂起 → 骨架屏;失败 → 本视图错误面可重试。
  // key 仍只含 id:type —— params 变化是「同面板换参数」(桌面 dockview 同语义),重渲不重挂,
  // 否则换一篇笔记就整棵编辑器树重建,滚动/光标/未存草稿全丢。
  return (
    // data-view:主区视图默认给浮动胶囊顶栏让出一条 --mb-top 的空位(见 singleColumn.css);
    // 自己想让内容从胶囊底下滚过去的视图(如 amadeus-editor)按 type 单独退订。
    <div className="mb-view" data-view={active.type} key={`${active.id}:${active.type}`}>
      <ViewErrorBoundary>
        <Suspense fallback={<Skeleton variant={skeletonVariantOf(active.type)} />}>
          {def.factory({ leaf: active, params: activeParams ?? active.params })}
        </Suspense>
      </ViewErrorBoundary>
    </div>
  )
}

function Drawer({ side, docked, showFoot }: { side: 'left' | 'right'; docked?: boolean; showFoot?: boolean }) {
  const visible = useWorkspace((s) => (side === 'left' ? s.leftVisible : s.rightVisible))
  // 只订阅稳定量:该侧 leaf 的 id 签名(增删触发)+ active id(切换触发)。**不**订阅 title,
  // 否则视图渲染期调 leaf.setTitle → 宿主重渲染 → 再 setTitle 的无限循环(React #185)。
  const leavesSig = useWorkspace((s) => (side === 'left' ? s.leftLeaves : s.rightLeaves).map((r) => r.id).join(','))
  const activeId = useWorkspace((s) => (side === 'left' ? s.leftActiveId : s.rightActiveId))
  void leavesSig; void activeId // 仅用于订阅触发重渲染;真身走 getState() 读
  // 抽屉内反向横滑关闭(左抽屉左滑/右抽屉右滑;点被推开的 main 关闭在 Host 的 dim 层)。
  const swipe = useRef<{ x: number; y: number; t: number } | null>(null)
  // push 形态容器**恒挂载**(mount 即 open 就没有滑入过渡了);内容首开才挂、之后常驻(保树状态+退场动画)。
  const [warm, setWarm] = useState(visible)
  if (visible && !warm) setWarm(true)
  const leaves = side === 'left' ? useWorkspace.getState().leftLeaves : useWorkspace.getState().rightLeaves
  const active = useWorkspace.getState().getActiveSideLeaf(side)
  const def = active ? getView(active.type) : null
  const close = () => useWorkspace.getState().toggleSidebar(side)
  const inner = leaves.length === 0 ? null : (
    <>
      <div className="mb-drawer-bar">
        {/* 该侧多个视图 → 下拉切换(原生 select,真机走系统选择器);单个则显示标题。 */}
        {leaves.length > 1 ? (
          <select
            className="mb-drawer-select"
            value={active?.id ?? ''}
            onChange={(e) => useWorkspace.getState().activateLeaf(e.target.value)}
          >
            {leaves.map((r) => {
              const d = getView(r.type)
              return <option key={r.id} value={r.id}>{d ? label(d.displayName) : r.type}</option>
            })}
          </select>
        ) : (
          <div className="mb-drawer-title">{def ? label(def.displayName) : ''}</div>
        )}
        <button className="mb-icon-btn" onClick={close} aria-label="close"><X size={20} /></button>
      </div>
      <div className="mb-drawer-body">
        {def && active ? (
          <div className="mb-view" key={`${active.id}:${active.type}`}>
            <ViewErrorBoundary>
              <Suspense fallback={<Skeleton variant="list" />}>
                {def.factory({ leaf: active, params: active.params })}
              </Suspense>
            </ViewErrorBoundary>
          </div>
        ) : null}
      </div>
      {/* 左栏底部常驻:Space 切换 + 账号卡 + 设置(用户拍板 2026-08-05;docked 宽屏形态同样带)。
          mini 变体不带(顶部 MiniRibbon 已是 Space 入口,mini 契约=无底部 Space 栏)。 */}
      {side === 'left' && showFoot && <DrawerFoot />}
    </>
  )
  // 宽屏(>4:3)并排形态:与 main 同排的常驻列(仅左栏用;见 SingleColumnHost)。
  // docked 也要认 visible(顶栏钮/返回键关左栏后不能还杵在那,Codex 评审 P2)。
  if (docked) return !visible || leaves.length === 0 ? null : <aside className="mb-sidecol">{inner}</aside>
  return (
    <div
      className={`mb-drawer mb-drawer--${side}${visible && leaves.length > 0 ? ' open' : ''}`}
      onTouchStart={(e) => {
        const t0 = e.touches[0]
        swipe.current = t0 && e.touches.length === 1 ? { x: t0.clientX, y: t0.clientY, t: Date.now() } : null
      }}
      onTouchEnd={(e) => {
        const s = swipe.current
        swipe.current = null
        const t0 = e.changedTouches[0]
        if (!s || !t0 || Date.now() - s.t > 600) return
        const dx = t0.clientX - s.x
        const dy = t0.clientY - s.y
        if (Math.abs(dx) < 56 || Math.abs(dx) < 2 * Math.abs(dy)) return
        if ((side === 'left' && dx < 0) || (side === 'right' && dx > 0)) close()
      }}
    >
      {warm ? inner : null}
    </div>
  )
}

/** 切 Space 但**留在左抽屉里**(用户拍板 2026-08-13:切完接着在面板里找东西,不要被甩回主区)。
 *  setActiveSpace 会走 applyNamed / resetLayout 整体重建布局,leftVisible 跟着复位 → 抽屉自动收回;
 *  它是同步的,所以重建之后再开一次即可。新 Space 压根没有左栏内容时不开(免得弹出个空抽屉)。 */
function switchSpaceKeepDrawer(id: string): void {
  setActiveSpace(id)
  const ws = useWorkspace.getState()
  if (ws.leftVisible) return
  if (ws.leftLeaves.length === 0 && ws.sidebarDefaults.left.length === 0) return
  ws.toggleSidebar('left')
}

/** 左抽屉底部常驻区:Space 切换条(原全局底栏移入)+ 账号卡与设置钮。
 *  账号/设置是 feature 层的 ribbon 注册项(rb-account / rb-settings),引擎按 id 取用不 import feature;
 *  同两项已从「⋯」菜单滤掉(不重复出现)。切 Space 会走 resetLayout → 抽屉自动收回。 */
function DrawerFoot() {
  const spaces = useSpaceStore((s) => s.spaces)
  const activeId = useSpaceStore((s) => s.activeSpaceId)
  const account = useRibbonStore((s) => s.items.find((i) => i.id === 'rb-account'))
  const settings = useRibbonStore((s) => s.items.find((i) => i.id === 'rb-settings'))
  const AccountC = account?.component
  const SettingsIcon = settings?.icon
  if (spaces.length <= 1 && !AccountC && !settings) return null
  return (
    <div className="mb-drawer-foot" style={{ paddingBottom: 'env(safe-area-inset-bottom)' }}>
      {spaces.length > 1 && (
        <nav className="mb-spacebar">
          {spaces.map((sp) => {
            const Icon = sp.icon
            const on = sp.id === activeId || (!spaces.some((x) => x.id === activeId) && sp === spaces[0])
            return (
              <button key={sp.id} className={`mb-tab${on ? ' on' : ''}`} onClick={() => switchSpaceKeepDrawer(sp.id)}>
                {Icon && <Icon size={20} />}
                <span className="mb-tab-label">{label(sp.name)}</span>
              </button>
            )
          })}
        </nav>
      )}
      {(AccountC || settings) && (
        <div className="mb-foot-row">
          <div className="mb-foot-account">{AccountC ? <AccountC expanded /> : null}</div>
          {settings && (
            <button className="mb-icon-btn" onClick={() => settings.onClick?.()} aria-label="settings">
              {SettingsIcon ? <SettingsIcon size={20} /> : null}
            </button>
          )}
        </div>
      )}
    </div>
  )
}

/** 底部弹出的「⋯」菜单:渲染 ribbon 底部注册项(明暗/语言/命令/反馈…)。
 *  账号(rb-account)与设置(rb-settings)已迁去左抽屉底部常驻(用户拍板 2026-08-05),此处滤掉防重复。 */
function MoreSheet({ onClose }: { onClose: () => void }) {
  const items = useRibbonStore((s) => s.items).filter((i) => i.side === 'bottom' && i.id !== 'rb-account' && i.id !== 'rb-settings')
  return (
    <div className="mb-sheet-scrim" onClick={onClose}>
      <div className="mb-sheet" onClick={(e) => e.stopPropagation()} style={{ paddingBottom: 'env(safe-area-inset-bottom)' }}>
        <div className="mb-sheet-grip" />
        {items.map((it) => {
          if (it.component) {
            const C = it.component
            return <div key={it.id} className="mb-sheet-card"><C expanded /></div>
          }
          const Icon = it.icon
          return (
            <button key={it.id} className="mb-sheet-row" onClick={() => { it.onClick?.(); onClose() }}>
              {Icon && <Icon size={20} />}
              <span>{it.tooltip ? label(it.tooltip) : it.id}</span>
            </button>
          )
        })}
      </div>
    </div>
  )
}

/** 标签页切换 sheet(顶栏 tab 计数钮点开,替代旧的顶栏标题下拉):列出所有主 tab
 *  (视图图标 + 标题,点选 activateLeaf、× 关 closeLeaf)+ 底部「＋ 新建标签页」。
 *  新建走 desktop 同款逻辑:当前 Space 有 newPage 则调,否则 openView('launcher', newTab)。 */
function TabSheet({ onClose }: { onClose: () => void }) {
  const tabs = useWorkspace((s) => s.mainTabs)
  const zh = document.documentElement.lang.startsWith('zh')
  const newTab = () => {
    const sp = getActiveSpace()
    if (sp?.newPage) sp.newPage()
    else useWorkspace.getState().openView('launcher', {}, 'main', { newTab: true })
    onClose()
  }
  return (
    <div className="mb-sheet-scrim" onClick={onClose}>
      <div className="mb-sheet" onClick={(e) => e.stopPropagation()} style={{ paddingBottom: 'env(safe-area-inset-bottom)' }}>
        <div className="mb-sheet-grip" />
        {tabs.map((t) => {
          const Icon = getView(t.type)?.icon
          return (
            <div
              key={t.id}
              role="button"
              className={`mb-sheet-row mb-tabrow${t.active ? ' on' : ''}`}
              onClick={() => { useWorkspace.getState().activateLeaf(t.id); onClose() }}
            >
              {Icon ? <Icon size={18} /> : null}
              <span className="mb-tabrow-label">{t.title}</span>
              {t.closable && tabs.length > 1 ? (
                <span
                  className="mb-tabrow-x"
                  role="button"
                  aria-label="close tab"
                  onClick={(e) => { e.stopPropagation(); useWorkspace.getState().closeLeaf(t.id) }}
                >
                  <X size={17} />
                </span>
              ) : null}
            </div>
          )
        })}
        <button className="mb-sheet-row mb-tabrow-new" onClick={newTab}>
          <Plus size={18} /> <span>{zh ? '新建标签页' : 'New tab'}</span>
        </button>
      </div>
    </div>
  )
}

/** 顶部横向 Space 切换条(mini 变体用):与左抽屉底部 Space 条同数据,搬到顶部;条本身可拖窗、按钮 no-drag。 */
function MiniRibbon() {
  const spaces = useSpaceStore((s) => s.spaces)
  const activeId = useSpaceStore((s) => s.activeSpaceId)
  if (spaces.length === 0) return null
  return (
    <div className="mini-ribbon">
      {spaces.map((sp) => {
        const Icon = sp.icon
        const on = sp.id === activeId || (!spaces.some((x) => x.id === activeId) && sp === spaces[0])
        return (
          <button key={sp.id} className={`mini-rib-btn${on ? ' on' : ''}`} title={label(sp.name)} onClick={() => setActiveSpace(sp.id)}>
            {Icon && <Icon size={18} />}
          </button>
        )
      })}
    </div>
  )
}

/** 长宽比 > 4:3(横屏手机/平板)→ 左栏与 main 并排推开而非悬浮(用户拍板:默认展开,右栏仍抽屉)。
 *  mini 变体不启用;desktop「手机框」预览是 3:4 竖比,天然不触发。 */
function useWideAspect(enabled: boolean): boolean {
  const [wide, setWide] = useState(() => enabled && window.matchMedia('(min-aspect-ratio: 4/3)').matches)
  useEffect(() => {
    if (!enabled) return
    const mq = window.matchMedia('(min-aspect-ratio: 4/3)')
    const on = (): void => setWide(mq.matches)
    on() // 旋转/分屏即时跟随
    mq.addEventListener('change', on)
    return () => mq.removeEventListener('change', on)
  }, [enabled])
  return enabled && wide
}

export const SingleColumnHost: React.FC<{ dark?: boolean; soft?: boolean; buildDefault?: () => void; variant?: 'full' | 'mini' }> = ({ buildDefault, variant = 'full' }) => {
  useEffect(() => {
    const ws = useWorkspace.getState()
    if (buildDefault) ws.setDefaultBuilder(buildDefault)
    // 冷启动先还原上次的标签 + 激活项(桌面是 WorkspaceHost.onReady 的 tryRestoreLayout,单列这边
    // 是三桶 leaf 的序列化);首启 / 整份不可用才构建当前 Space 的默认布局。
    if (ws.mainLeaves.length === 0 && !restoreSingleColumnLayout()) buildDefault?.()
    ws.refreshTabs()
  }, [])

  const mainRef = useRef<HTMLElement | null>(null)
  const [moreOpen, setMoreOpen] = useState(false)
  const [tabsOpen, setTabsOpen] = useState(false)
  const hasLeft = useWorkspace((s) => s.leftLeaves.length > 0 || s.sidebarDefaults.left.length > 0)
  const hasRight = useWorkspace((s) => s.rightLeaves.length > 0 || s.sidebarDefaults.right.length > 0)
  const leftVisible = useWorkspace((s) => s.leftVisible)
  const rightVisible = useWorkspace((s) => s.rightVisible)
  const tabCount = useWorkspace((s) => s.mainTabs.length)

  const mini = variant === 'mini'
  const wide = useWideAspect(!mini)
  // mini(桌面卫星窗)顶栏仍占一行、不是浮层,收起来会让内容跳一格 —— 只在手机形态启用。
  const chromeOff = useChromeAutoHide(mainRef, !mini)

  // Android 系统返回:MobileRoot 派发可取消的 forsion:mobile-back,壳先接管最上层的两个 sheet。
  const sheetsRef = useRef({ tabs: false, more: false })
  sheetsRef.current = { tabs: tabsOpen, more: moreOpen }
  useEffect(() => {
    const onBack = (e: Event): void => {
      if (sheetsRef.current.tabs) { setTabsOpen(false); e.preventDefault(); return }
      if (sheetsRef.current.more) { setMoreOpen(false); e.preventDefault() }
    }
    window.addEventListener('forsion:mobile-back', onBack)
    return () => window.removeEventListener('forsion:mobile-back', onBack)
  }, [])

  // 窄屏 push 形态一次只开一侧:两侧同开时收掉先开的那侧(宽屏 docked 左栏 + 右抽屉共存不受限)。
  const lastOpened = useRef<'left' | 'right'>('left')
  useEffect(() => { if (leftVisible) lastOpened.current = 'left' }, [leftVisible])
  useEffect(() => { if (rightVisible) lastOpened.current = 'right' }, [rightVisible])
  useEffect(() => {
    if (wide || !leftVisible || !rightVisible) return
    useWorkspace.getState().toggleSidebar(lastOpened.current === 'left' ? 'right' : 'left')
  }, [leftVisible, rightVisible, wide])
  // 进入宽屏布局:左栏默认并排展开(用户拍板);离开宽屏回抽屉形态(visible 状态原样保留)。
  useEffect(() => {
    useWorkspace.getState().setWideMode(wide) // store 据此决定主区导航后是否自动收左抽屉
    if (!wide) return
    const ws = useWorkspace.getState()
    if (!ws.leftVisible && (ws.leftLeaves.length > 0 || ws.sidebarDefaults.left.length > 0)) ws.toggleSidebar('left')
  }, [wide])

  // main view 横滑呼出侧栏(用户拍板:全域滑动;白板/PDF/横向可滚动区内只认屏幕边缘起手防误触)。
  // touch 事件专属 —— 桌面鼠标不触发;不 preventDefault,纵向滚动照常。
  const swipe = useRef<{ x: number; y: number; t: number; ok: boolean } | null>(null)
  const swipeStart = (e: React.TouchEvent): void => {
    const t0 = e.touches[0]
    if (!t0 || e.touches.length > 1) { swipe.current = null; return }
    let exempt = !!(e.target as HTMLElement).closest?.('.amx-draw, .pdfa-container')
    if (!exempt) {
      // 横向可滚动祖先(看板/表格):滑动是它的手势,只让边缘起手抢。向上最多走到 .mb-main。
      for (let el = e.target as HTMLElement | null; el && el !== e.currentTarget; el = el.parentElement) {
        const cs = getComputedStyle(el)
        if ((cs.overflowX === 'auto' || cs.overflowX === 'scroll') && el.scrollWidth > el.clientWidth + 1) { exempt = true; break }
      }
    }
    const EDGE = 24
    const edgeStart = t0.clientX < EDGE || t0.clientX > window.innerWidth - EDGE
    swipe.current = { x: t0.clientX, y: t0.clientY, t: Date.now(), ok: !exempt || edgeStart }
  }
  const swipeEnd = (e: React.TouchEvent): void => {
    const s = swipe.current
    swipe.current = null
    const t0 = e.changedTouches[0]
    if (!s || !s.ok || !t0 || Date.now() - s.t > 600) return
    const dx = t0.clientX - s.x
    const dy = t0.clientY - s.y
    if (Math.abs(dx) < 56 || Math.abs(dx) < 2 * Math.abs(dy)) return
    const ws = useWorkspace.getState()
    if (dx > 0) { if (hasLeft && !ws.leftVisible) ws.toggleSidebar('left') }
    else if (hasRight && !ws.rightVisible) ws.toggleSidebar('right')
  }

  // 关抽屉(dim 层点击/横滑):窄屏一次只开一侧,右优先(右开着必是最上)。
  const closeDrawers = (): void => {
    const ws = useWorkspace.getState()
    if (ws.rightVisible) ws.toggleSidebar('right')
    else if (ws.leftVisible && !wide) ws.toggleSidebar('left')
  }
  const dimSwipe = useRef<{ x: number; y: number; t: number } | null>(null)
  const pushed = !wide && (leftVisible || rightVisible)

  {/* 按钮收成左右两组胶囊(Obsidian 式)。顺序不许动:mobile e2e(note-open)靠
      `.mb-topbar .mb-icon-btn` 的第一个拿左抽屉钮 —— 胶囊只是中间多包了一层 div,后代选择器照命中。 */}
  const topbar = (
    <header className="mb-topbar">
      <div className="mb-cap">
        {hasLeft ? (
          <button className="mb-icon-btn" onClick={() => useWorkspace.getState().toggleSidebar('left')} aria-label="left panel"><PanelLeft size={20} /></button>
        ) : <span className="mb-icon-btn mb-icon-btn--ghost" />}
      </div>
      <div className="mb-topbar-spacer" />
      <div className="mb-cap">
        {hasRight ? (
          <button className="mb-icon-btn" onClick={() => useWorkspace.getState().toggleSidebar('right')} aria-label="right panel"><PanelRight size={20} /></button>
        ) : null}
        <button className="mb-icon-btn mb-tabsbtn" onClick={() => setTabsOpen(true)} aria-label="tabs">
          <span className="mb-tabcount">{tabCount || 1}</span>
        </button>
        <button className="mb-icon-btn" onClick={() => setMoreOpen(true)} aria-label="more"><MoreHorizontal size={20} /></button>
      </div>
    </header>
  )

  return (
    // ⚠️ 顶部**不再**在壳上留安全区:内容要画到屏幕最顶端(封面图/网页/白板 edge-to-edge),
    //    躲刘海是浮动胶囊自己的事(.mb-topbar 的 top、抽屉的 padding-top,见 singleColumn.css)。
    //    底部仍留 —— 底部 chrome 分散在各视图里,没法逐个保证自理,收窄爆炸半径。
    <div className={`mb-shell${mini ? ' mini-shell' : ''}`} data-chrome={chromeOff ? 'off' : undefined} style={{ paddingBottom: mini ? 0 : 'env(safe-area-inset-bottom)' }}>
      {/* mini:顶部横向 Space 切换条(ribbon 在顶部)+ 兼作 frameless 拖窗把手。 */}
      {mini && <MiniRibbon />}
      {/* mini 的顶栏仍占一行(卡片太小,浮层会盖住内容);手机端的挪进 .mb-main 里浮着 —— 见下。 */}
      {mini && topbar}

      {/* push 连贯式:左右抽屉都是 .mb-body 内的绝对定位面板,开侧把 main **原尺寸**推向另一边
          (translate 同一宽度,main 不缩放);dim 层盖在被推开的 main 上,点击/反向横滑收回。
          宽屏:左栏 docked 并排(sidecol),右栏滑入但不推 main。 */}
      <div className={`mb-body${!wide && leftVisible ? ' push-left' : ''}${!wide && rightVisible ? ' push-right' : ''}`}>
        <Drawer side="left" docked={wide} showFoot={!mini} />
        <main ref={mainRef} className="mb-main" onTouchStart={mini ? undefined : swipeStart} onTouchEnd={mini ? undefined : swipeEnd}>
          {/* ⚠️ 胶囊顶栏必须住在 .mb-main 里,不能挂在 .mb-shell 上:
              ① push 抽屉的 translate 只打在 .mb-main —— 挂外面胶囊就不跟着内容滑,视觉当场穿帮;
              ② 宽屏 docked 形态左栏(.mb-sidecol)与 main 并排,挂外面的 left:0 会盖到左栏头上。 */}
          {!mini && topbar}
          <LeafHost />
        </main>
        <div
          className={`mb-push-dim${pushed || (wide && rightVisible) ? ' on' : ''}`}
          onClick={closeDrawers}
          onTouchStart={(e) => {
            const t0 = e.touches[0]
            dimSwipe.current = t0 && e.touches.length === 1 ? { x: t0.clientX, y: t0.clientY, t: Date.now() } : null
          }}
          onTouchEnd={(e) => {
            const s = dimSwipe.current
            dimSwipe.current = null
            const t0 = e.changedTouches[0]
            if (!s || !t0 || Date.now() - s.t > 600) return
            const dx = t0.clientX - s.x
            const dy = t0.clientY - s.y
            if (Math.abs(dx) < 56 || Math.abs(dx) < 2 * Math.abs(dy)) return
            const ws = useWorkspace.getState()
            if (dx < 0 && ws.leftVisible && !wide) ws.toggleSidebar('left')
            else if (dx > 0 && ws.rightVisible) ws.toggleSidebar('right')
          }}
        />
        <Drawer side="right" />
      </div>

      {tabsOpen && <TabSheet onClose={() => setTabsOpen(false)} />}
      {moreOpen && <MoreSheet onClose={() => setMoreOpen(false)} />}
    </div>
  )
}
