import { useSpaceAmbient } from '@/theme/spaceAmbient'
import { amadeusAvailable } from '@/features/runtime'
/**
 * 移动端 App 根:启动副作用(连接/轮询,复用 desktop useBootstrap)+ 主题桥接给 MobileShell +
 * 设置浮层(账号/登录)+ 应用市场 + 插件就绪卡 + 首启引导 + Amadeus 对话框宿主 + 通知。刻意精简 desktop Root 的
 * 桌面专属浮层(反馈等);哪些故意不要、为什么,以 `desktop/scripts/platform-parity.check.cjs`
 * 的 SKIP 表为准 —— 那张表是唯一台账,别只在这里凭记忆增删。
 *
 * ⚠️ 本文件消费的是 **desktop 的 appStore/组件**,而 vite build 不做类型检查 —— 桌面侧删个字段
 * 或给组件加个必填 prop,这里不会报错,直接在真机上崩(2026-07-27 的 `a.toasts.map` 就是这么
 * 把 v2.7.1 的安卓包整个打不开的)。**改 desktop 渲染层后请跑 `npm run typecheck`**(mobile 目录下)。
 */
import { useEffect, useSyncExternalStore } from 'react'
import { App as CapApp } from '@capacitor/app'
import { useApp } from '@/stores/appStore'
import { useTheme, useVisualTheme } from '@/stores/themeStore'
import { useBootstrap } from '@/stores/bootstrap'
import { useInbox } from '@/stores/inboxStore'
import { pullInbox } from '@/services/backendService'
import { SettingsModal } from '@/components/SettingsModal'
import { MarketModal } from '@/components/MarketModal'
import { PluginOnboardingHost } from '@/components/PluginOnboardingModal'
import { OnboardingWizard } from '@/components/OnboardingWizard'
import { NotificationHost } from '@/components/NotificationHost'
import { WhatsNewHost } from '@/components/WhatsNewDialog'
import { AmadeusOverlays } from '@/amadeusOverlays'
import { AchievementToast } from '@/achievements/AchievementToast'
import { AchievementsModal } from '@/achievements/AchievementsModal'
import { BtwHost } from '@tangu/ui/views/chat2/BtwPanel'
import { VoiceCallBar } from '@/mini/VoiceCallView'
import { getCallLayer, openCallLayer, subscribeCallLayer } from '@/services/realtimeCall'
import { btwWebVisible, useBtw } from '@tangu/ui/views/chat2/btwStore'
import { QuickFind, useQuickFind } from '@/quickFind'
import { FindBar } from '@/findInPage'
import { installNotificationWiring } from '@/stores/notificationWiring'
import { ensureAmadeusReady } from '@/amadeusPlugins'
import { AnimatePresence, motion } from 'framer-motion'
import { useShallow } from 'zustand/react/shallow'
import { SingleColumnHost, listFirstNow, useWorkspace, useNav, useNativeChromeClaim, useNativeChromeSpaces, useRibbonStore, useSpaceStore, setActiveSpace, drawerPreview, type NativeChromeClaim } from '@lcl/engine'
// 命令面板:desktop 由 `Shell.tsx` 渲染,而移动端把 Shell 换成了空壳(vite.config engineSwap)——
// 于是 ribbon 的 rb-cmd 项(无条件注册,经「⋯」菜单在移动端可点)点了只是把 paletteOpen 置 true,
// 没有任何东西渲染它。宿主责任随外壳一起被换掉了,得在这儿接回来。
import { CommandPalette } from '@lcl/engine/CommandPalette'
import { buildDefaultLayout } from '@/bootstrapEngine'
import { MobileUnitsSheet, useUnitsSheet } from './UnitsSheet'
import { exitHint, onBackGesture } from './nativeBack'
import { homeTarget } from '@/services/engine/targets'

/** 移动端本地 inbox 内容来自云端广播,但无服务端 inboxPull 调度器 → 客户端定时静默拉(绕开 inboxStore.pull 的 toast)。 */
function useInboxAutoPull(): void {
  useEffect(() => {
    const doPull = async () => {
      if (!window.tangu?.mobile || useApp.getState().connState !== 'ok') return
      try {
        const r = await pullInbox(homeTarget())
        if (r.added) { void useInbox.getState().refreshList(); void useInbox.getState().refreshUnread() }
      } catch { /* 静默 */ }
    }
    void doPull()
    const timer = window.setInterval(doPull, 5 * 60_000)
    let prev = useApp.getState().connState
    const unsub = useApp.subscribe((s) => { if (s.connState === 'ok' && prev !== 'ok') void doPull(); prev = s.connState })
    // P1-K3:回到前台立即拉(电脑上的远程会话等你批准时投的提醒信,要一打开 App 就看得到,别等 5 分钟那一轮)
    const onVisible = (): void => { if (!document.hidden) void doPull() }
    document.addEventListener('visibilitychange', onVisible)
    return () => { window.clearInterval(timer); unsub(); document.removeEventListener('visibilitychange', onVisible) }
  }, [])
}

/** 主页上两次返回之间最多隔多久算「再返回一次」(= 系统短 Toast 显示的时长)。 */
const EXIT_WINDOW_MS = 2000
let exitArmedAt = 0

/** 链底:这个 Space 的第一层上再按返回。不在主页 → 回主页;在主页 → 先提示「再返回一次退出」,两秒内再来一次才挂起 app。
 *  2026-10-13 用户实报「侧滑返回…一不小心就返回桌面了」:改之前每个 Space 的第一层(会话列表、笔记列表、日历…)
 *  都是一次返回就退到桌面,而全面屏的返回是**左右两条边**往里滑 —— 在列表上横着划一下、起手靠边就中。
 *  主页 = 排第一个的 Space,和底栏认「主页」是同一条(spaceDock.ts:按位置)。
 *  主页那一下用提示而不用系统的「缩小预览」:预览只有 Android 15 才默认有,提示在哪个版本上都一样(用户同日定:
 *  「不要管我手机型号,要确保安卓都有基本的一致体验」)。弹不了提示的宿主(浏览器)照旧一次就退。
 *  仪器:`emu:nativeshell` 的「back:」那条。 */
function leaveOrHome(): void {
  const { spaces, activeSpaceId } = useSpaceStore.getState()
  const home = spaces[0]?.id
  if (home && activeSpaceId !== home && spaces.some((x) => x.id === activeSpaceId)) { setActiveSpace(home); return }
  const now = Date.now()
  if (now - exitArmedAt < EXIT_WINDOW_MS || !exitHint()) { exitArmedAt = 0; void CapApp.minimizeApp(); return }
  exitArmedAt = now
}

/** 一下返回会做什么。`slide` = 它是把哪一侧的面板滑开 / 收起(手势进行中可以先画出来的那种);`run` = 真去做。
 *  ⚠️ 算这个不许有副作用:手势一开始就要问一遍(只为知道画不画预览),人可能中途放弃。
 *     壳和各浮层靠 `forsion:mobile-back` 接返回 —— 先派一个 `detail.probe` 的,监听方只答「我接」不动手。 */
function planBack(): { slide?: 'left' | 'right'; run: () => void } {
  // 搜索面板开着时永远在最上面(下拉搜索 / 顶栏搜索钮 / 外接键盘的快捷键打开;z-index 高过设置、商店、旁聊那几张整页):
  // 返回先关它。排在后面的话,它盖着的那一层会先被关掉;不排的话,列表层上按返回直接把 app 退到后台。
  if (useQuickFind.getState().open) return { run: () => useQuickFind.getState().close() }
  // 再问壳:标签页 sheet /「⋯」菜单 / 编辑器浮层 / 设置二级页…开着 → 由它们接管(可取消事件)。
  const taken = !window.dispatchEvent(new CustomEvent('forsion:mobile-back', { cancelable: true, detail: { probe: true } }))
  if (taken) return { run: () => { window.dispatchEvent(new Event('forsion:mobile-back', { cancelable: true })) } }
  const app = useApp.getState()
  // 引导是全屏浮层(zIndex 60):不在这儿吃掉返回,它下面的 leaf 会被 closeLeaf 关掉/直接挂起 app。
  // 不自动关引导 —— 退出引导只走里面的「跳过」(那条会记 dismiss),否则下次启动又弹一遍。
  if (app.onboarding) return { run: () => {} }
  // 旁聊全屏页在最上层:返回先关它。判据与 BtwHost 同一条 —— 它因切了会话而隐着时不能白吞一次返回
  if (btwWebVisible(useBtw.getState().webOpen, app.activeId)) return { run: () => useBtw.getState().closeWeb() }
  // 应用市场全屏页(详情页开着时,MarketModal 自己在 forsion:mobile-back 里先退回列表)
  if (app.marketOpen) return { run: () => app.closeMarket() }
  if (app.settingsOpen) return { run: () => app.closeSettings() }
  const ws = useWorkspace.getState()
  // 两级导航(原生底栏,见 lcl 的 listFirstNow):左栏是这个 Space 的第一层 → 在列表层按返回 = 已在链底(见 leaveOrHome);
  // 在主区按返回 = 先页内后退(只退这一趟进来之后走过的页,见 lcl 的 listTrips),退无可退就回列表
  // (不关视图,再点同一条目即回)。
  const listFirst = listFirstNow()
  if (listFirst && ws.leftVisible) return { run: leaveOrHome }
  if (ws.leftVisible) return { slide: 'left', run: () => ws.toggleSidebar('left') }
  if (ws.rightVisible) return { slide: 'right', run: () => ws.toggleSidebar('right') }
  const active = ws.mainTabs.find((t) => t.active)
  if (active) {
    const st = useNav.getState().stacks[active.id]
    if (st && st.idx > 0) return { run: () => useNav.getState().back(active.id) }
    if (listFirst) return { slide: 'left', run: () => ws.toggleSidebar('left') }
    // 落地页(`home` 空态占位 / 主页 Space 的 `homepage`)不关 —— 已经在链底。
    // ⚠️ 漏掉 `homepage` 时:主页上按一下返回 = closeLeaf → 唯一主 leaf 就地变 `home` 空态
    // (只有 logo 的空页)并被存盘,重启也回不来 = 用户实报的「默认 Homepage 空白」。
    if (active.type !== 'home' && active.type !== 'homepage') { // 白板/PDF/会话等 → 关回列表/home
      return { run: () => {
        ws.closeLeaf(active.id)
        // 固定 View(Space 级 pinned,区内最后一个)关不掉,closeLeaf 是空操作 → 这就是链底,往下走。
        // 不这样判,返回键在日历 / 图像工作台 / 浏览器里的 Tangu 会话上按了什么都不发生(2026-10-04 合并 main 后 e2e:homeback 抓到)。
        const now = useWorkspace.getState().mainTabs.find((t) => t.active)
        if (now?.id === active.id && now.type === active.type) leaveOrHome()
      } }
    }
  }
  return { run: leaveOrHome } // 已在底
}

/** Android 系统返回(实体键/全面屏侧滑手势)接管:壳内 sheet→浮层→抽屉→tab 内后退→关视图→回主页→提示→挂起。
 *  此前无人监听 backButton,返回手势直接把 app 退到后台——「侧滑返回没反应」的根因。
 *  Manifest 已开 enableOnBackInvokedCallback(Capacitor App 插件走 androidx OnBackPressedDispatcher,自动桥到新 API)。
 *  手势进行中(Android 14 起系统才报,见 nativeBack.ts):这一下返回要是「滑开 / 收起一侧面板」(回列表、关抽屉),
 *  面板跟着手指走,和页内横滑同一个画法(lcl 的 drawerPreview);别的返回(关浮层、页内后退、回主页)过程中不动。
 *  ⚠️ 系统自己的「返回桌面」预览动画在这里**不会出现**(2026-10-13 模拟器实测,Android 15):返回回调一直启用着,
 *     系统就不画预览,连链底那一档也不画 —— 挂起是我们自己调 minimizeApp 做的。 */
function useAndroidBack(): void {
  useEffect(() => {
    if (!window.tangu?.mobile) return // 仅原生壳;浏览器无此事件
    let sliding: 'left' | 'right' | null = null
    const stop = (): void => { if (sliding) { sliding = null; drawerPreview.end(false) } }
    const offGesture = onBackGesture((e) => {
      if (e.phase === 'start') {
        stop() // 上一个手势没等到收尾(系统没报取消)→ 先弹回去,不然它的中间态一直留在屏上、下一次也起不了手
        const side = planBack().slide
        sliding = side && drawerPreview.begin(side) ? side : null
      } else if (e.phase === 'progress') {
        // 走了多远:从哪条边进来就按离那条边多远算(左边进来 = 手指的横向位置)
        if (sliding && typeof e.x === 'number') drawerPreview.move(e.edge === 'right' ? 1 - e.x : e.x)
      } else stop()
    })
    const sub = CapApp.addListener('backButton', () => {
      // 松手这一刻重新算一遍,不用起手时的那份:手指按着的这段时间里可能弹出了别的东西(搜索面板、审批、浮层),
      // 那一下返回该先关它 —— 和系统不报手势过程的版本(只在松手时算一次)是同一个结果。
      const plan = planBack()
      if (sliding) {
        const side = sliding
        sliding = null
        // 还是滑同一侧 → 按预览的方向落定(同页内横滑松手的那套顺序),不再另走一遍链
        if (plan.slide === side && drawerPreview.end(true)) return
        drawerPreview.end(false)
      }
      plan.run()
    })
    // 手势到一半 App 被切到后台:系统不保证报取消,回来时面板不能还停在半路
    const onHide = (): void => { if (document.hidden) stop() }
    document.addEventListener('visibilitychange', onHide)
    return () => { offGesture(); document.removeEventListener('visibilitychange', onHide); void sub.then((h) => h.remove()) }
  }, [])
}

/** 全屏 Web 浮层盖住单列壳时,原生顶栏(Android NativeChrome,可选宿主)收起,不能浮在浮层上面。
 *  没装原生宿主(web / 手机浏览器)时这个声明是空操作。
 *  设置页不在此列:SettingsModal 自己声明 page 模式(原生标题 + 返回 + ×)。⚠️ 别把 settingsOpen 加回来 ——
 *  子组件的 effect 先于父组件跑,这里的 hidden 会后入栈、盖掉设置页的 page 声明(最后一个声明生效)。 */
const CHROME_HIDDEN: NativeChromeClaim = { mode: 'hidden' }

export function MobileRoot() {
  useBootstrap()
  useInboxAutoPull()
  useAndroidBack()
  // 通知事件接线(幂等)。三段里 A(amadeusSync)/B(remoteSync)在移动端是可选链 no-op,真正生效的是
  // C:后台会话跑完 → 右上角通知。此前只挂了 NotificationHost 外壳没接线,设置里的「通知」页
  // 一直在管一个永不触发的东西。desktop 在 Root 里装,移动端走本文件 → 必须自己装一份。
  useEffect(() => { installNotificationWiring() }, [])
  // 工作区预热:restoreVault 原本迟到「首次打开工作区抽屉」才发起(ensureAmadeusReady 只挂在
  // 抽屉里的 AmadeusPagesView)→ 用户体感「打开工作区加载半天」。启动空闲后先拉起 vault
  // (云端树快照命中时立即有内容,随后后台 revalidate),main view 不受阻。
  useEffect(() => {
    if (!amadeusAvailable()) return
    const t = window.setTimeout(() => { ensureAmadeusReady() }, 1200)
    return () => window.clearTimeout(t)
  }, [])
  const theme = useTheme()
  const visualTheme = useVisualTheme()
  useSpaceAmbient()
  const a = useApp(useShallow((s) => ({
    sessions: s.sessions,
    archivedSessions: s.archivedSessions,
    activeId: s.activeId,
    settingsOpen: s.settingsOpen,
    settingsTab: s.settingsTab,
    settingsNonce: s.settingsNonce,
    marketOpen: s.marketOpen,
    marketTarget: s.marketTarget,
    onboarding: s.onboarding,
    setOnboarding: s.setOnboarding,
    achievementsOpen: s.achievementsOpen,
    cfg: s.cfg,
    closeSettings: s.closeSettings,
    patchConfig: s.patchConfig,
    connect: s.connect,
  })))
  const activeSession = a.sessions.find((s) => s.id === a.activeId) || a.archivedSessions.find((s) => s.id === a.activeId) || null
  const unitsOpen = useUnitsSheet((s) => s.open)
  const callLayer = useSyncExternalStore(subscribeCallLayer, getCallLayer)
  const btwPage = useBtw((s) => btwWebVisible(s.webOpen, a.activeId))
  useNativeChromeClaim(a.onboarding || a.achievementsOpen || unitsOpen || btwPage ? CHROME_HIDDEN : null)
  // 原生外壳(Android)把账号入口画成顶栏右侧的头像,左栏底部那一排不再渲染 —— 账号卡在这儿隐身挂着:
  // 它自管登录态与菜单,头像显示什么、点了做什么由它发布(services/accountChip.ts → mobile/src/nativeChrome.ts)。
  const nativeSpaces = useNativeChromeSpaces()
  const AccountC = useRibbonStore((s) => s.items.find((i) => i.id === 'rb-account'))?.component

  return (
    <>
      <div className="shell-host">
        <SingleColumnHost dark={visualTheme.mode === 'dark'} buildDefault={buildDefaultLayout} />
      </div>
      {nativeSpaces && AccountC && <div hidden><AccountC expanded={false} /></div>}

      {/* Amadeus 全局浮层。⚠️ 名字像「快速切换器」,实为**对话框宿主**:AskStringHost / DeleteAssetsHost /
          NewDrawingHost / ConfirmDialog / AutomationBuilderHost / TemplatePicker 都住在里面。
          不挂它,移动端所有 askString()(新建文件夹、添加属性、存为集合…共 20 处)的 promise 永不 resolve
          —— 点了没反应且不报错。门控与 desktop Root 同款。 */}
      {amadeusAvailable() && <AmadeusOverlays />}

      {/* 下面三个的共同点:它们在移动端都点得到,不挂宿主就是「点完没有任何东西渲染」的静默死按钮
          (状态置了 true,宿主不在),不是「移动端没这功能」。到达路径两种:
           · rb-achievements / rb-cmd 无条件注册,SingleColumnHost 的「⋯」菜单把所有 side:'bottom'
             的 ribbon 项原样搬上来并调 onClick;
           · QuickFind 的 ribbon 项已撤(2026-08-31,见 bootstrapEngine 那段注释),但它仍从
             `quick-find` 命令(⋯ → 命令)与仪表盘的 openPicker 进来 —— **别跟着一起删**。 */}
      <QuickFind />
      {/* 页内查找浮条:移动端没物理键盘(installHotkeys 整个不装),但 `find-in-page`
          命令从「⋯ → 命令」点得到 —— 不挂宿主就是那种「点完什么都不出来」的静默死按钮。 */}
      <FindBar />
      <CommandPalette />
      {/* 互联设备弹层(Forsion Unit):入口由 mobileEntry 的 installUnitsEntry 按桥上架(左栏底部;原生外壳下在「⋯」最前)。 */}
      <MobileUnitsSheet />
      {/* 语音通话:手机没有 Mini 窗,通话卡是页面顶上的一条(输入框的通话键 → openCallLayer)。不是浮层:聊天区照常可用,
          返回键也不归它管 —— 挂断只走条上的按钮。设置 / 商店这类整屏页(z 50)盖在它上面,电话不断。 */}
      {callLayer && <VoiceCallBar params={callLayer} onClose={() => openCallLayer(null)} />}

      <AnimatePresence>
        {a.achievementsOpen && (
          <motion.div
            key="achievements"
            style={{ position: 'fixed', inset: 0, zIndex: 50, display: 'flex', minWidth: 0, minHeight: 0, overflow: 'hidden', background: 'var(--bg)' }}
            initial={{ opacity: 0, scale: 0.985 }}
            animate={{ opacity: 1, scale: 1 }}
            exit={{ opacity: 0, scale: 0.985 }}
            transition={{ duration: 0.22, ease: [0.2, 0.8, 0.2, 1] }}
          >
            <AchievementsModal />
          </motion.div>
        )}
      </AnimatePresence>

      {/* 应用市场(2026-10-02 起 Android 能装 Forsion 插件):入口 rb-market 经「⋯」菜单、open-market 命令与
          设置 → 插件页的「浏览应用市场」。手机上与设置同款全屏二级页;安装 / 卸载的结果由市场自己的提示条说。 */}
      <AnimatePresence>
        {a.marketOpen && (
          <motion.div
            key="market"
            data-mobile-market
            style={{ position: 'fixed', inset: 0, zIndex: 50, display: 'flex', minWidth: 0, minHeight: 0, overflow: 'hidden', background: 'var(--bg)' }}
            initial={{ opacity: 0, scale: 0.985 }}
            animate={{ opacity: 1, scale: 1 }}
            exit={{ opacity: 0, scale: 0.985 }}
            transition={{ duration: 0.22, ease: [0.2, 0.8, 0.2, 1] }}
          >
            <MarketModal key={a.marketTarget?.nonce} initialQuery={a.marketTarget?.q} initialItemId={a.marketTarget?.itemId} initialDetailTab={a.marketTarget?.detailTab} onClose={() => useApp.getState().closeMarket()} />
          </motion.div>
        )}
      </AnimatePresence>

      <AnimatePresence>
        {a.settingsOpen && (
          <motion.div
            key="settings"
            style={{ position: 'fixed', inset: 0, zIndex: 50, display: 'flex', minWidth: 0, minHeight: 0, overflow: 'hidden', background: 'var(--bg)' }}
            initial={{ opacity: 0, scale: 0.985 }}
            animate={{ opacity: 1, scale: 1 }}
            exit={{ opacity: 0, scale: 0.985 }}
            transition={{ duration: 0.22, ease: [0.2, 0.8, 0.2, 1] }}
          >
            <SettingsModal
              key={a.settingsNonce}
              open
              initialTab={a.settingsTab ?? undefined}
              cfg={a.cfg}
              activeSession={activeSession}
              themeLang={theme.lang}
              themeSkin={theme.skin}
              themeMode={theme.mode}
              themeModePref={theme.modePref}
              flatOn={theme.flat}
              glassOn={theme.glass}

              themeSeed={theme.seed}
              onClose={() => a.closeSettings()}
              onConfigChange={a.patchConfig}
              onThemeChange={(lang, skin, mode) => theme.setTheme(lang, skin, theme.bg, mode)}
              onFlatChange={theme.setFlat}
              onGlassChange={(on) => theme.setGlass(on)}

              onSeedChange={(hex) => theme.setSeedValue(hex)}
              onReloadThemes={() => theme.reloadThemes()}
              onReconnect={(patch) => void a.connect({ ...a.cfg, ...(patch || {}) })}
            />
          </motion.div>
        )}
      </AnimatePresence>

      {/* 首启引导:移动端走通用步(欢迎/后台 Agent/外观/完成),后台开关即时写入引擎 API。
          连接、模型、默认目录和环境检测依赖本机 host,步骤序按 OnboardingWizard.stepOrder 收缩。
          onFinish 不重连:后台开关已保存,引导不改变移动端的连接配置。 */}
      <AnimatePresence>
        {a.onboarding && (
          <motion.div
            key="onboarding"
            style={{ position: 'fixed', inset: 0, zIndex: 60, background: 'var(--bg)' }}
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0, scale: 1.06 }}
            transition={{ duration: 0.45, ease: [0.2, 0.8, 0.2, 1] }}
          >
            <OnboardingWizard
              themeLang={theme.lang}
              themeSkin={theme.skin}
              themeMode={theme.mode}
              themeModePref={theme.modePref}
              themeSeed={theme.seed}
              onThemeChange={(lang, skin, mode) => theme.setTheme(lang, skin, theme.bg, mode)}
              onSeedChange={(hex) => theme.setSeedValue(hex)}
              onReconnect={() => { /* 无 connect 步 */ }}
              onFinish={() => a.setOnboarding(false)}
            />
          </motion.div>
        )}
      </AnimatePresence>

      {/* 成就解锁提示:埋点(track)与存档(localStorage)在移动端本就照跑,缺的只是这块弹层。
          点它开成就总览 —— AchievementsModal 上面已挂(⋯ 菜单里的 rb-achievements 也进得去)。 */}
      {/* 旁聊(/btw):手机没有浮窗语义,走全屏二级页;只在它归属的会话仍是当前会话时显示 */}
      <BtwHost page />

      {/* 插件就绪检查卡(带 requires 的插件刚装好 / 手动启用时弹):全屏二级页开着时延后,回到主界面再出(同桌面 Root)。 */}
      {!a.settingsOpen && !a.marketOpen && !a.onboarding && <PluginOnboardingHost />}

      <AchievementToast onOpen={() => useApp.getState().openAchievements()} />

      {/* 旧 .toast-wrap 已随 appStore.toasts 一起下线;通知统一走 notificationStore + NotificationHost。 */}
      <NotificationHost />
      <WhatsNewHost />
    </>
  )
}
