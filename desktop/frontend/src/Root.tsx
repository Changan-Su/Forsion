import { amadeusAvailable } from './features/runtime'
/** App 根:启动副作用(连接/轮询/更新)+ 主题桥接给纯引擎 Shell + 设置/引导/更新横幅浮层。 */
import { useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import { Shell, UI_MODE, useWorkspace } from '@lcl/engine'
import { useApp } from './stores/appStore'
import { useTheme } from './stores/themeStore'
import { getLanguage } from './theme/registry'
import { useBootstrap } from './stores/bootstrap'
import { buildDefaultLayout } from './bootstrapEngine'
import { TopBar } from './views/TopBar'
import { SettingsModal } from './components/SettingsModal'
import { sendTestNotification } from './components/NotificationsTab'
import { AmadeusOverlays } from './amadeusOverlays'
import { QuickFind } from './quickFind'
import { FindBar } from './findInPage'
import { HoverTip } from './hoverTip'
import { MarketModal } from './components/MarketModal'
import { PluginOnboardingHost } from './components/PluginOnboardingModal'
import { OnboardingWizard, ONBOARDING_DISMISS_KEY } from './components/OnboardingWizard'
import { FeedbackModal, draftInMainChat } from './components/FeedbackModal'
import { AchievementsModal } from './achievements/AchievementsModal'
import { AchievementToast } from './achievements/AchievementToast'
import { debugFireToast } from './achievements/store'
import { forgetUserSpace } from './userSpaces'
import { NotificationHost } from './components/NotificationHost'
import { DesktopStatusBar, installStatusBarItems } from './statusbar/items'
import { UnitRemoteSurface } from './components/UnitSwitcher'
import { installNotificationWiring } from './stores/notificationWiring'
import { useShallow } from 'zustand/react/shallow'
import { installFileDropGuard } from './fileDropGuard'
import { syncDevCommands } from './devCommands'
import { openAgentProfile } from './views/agentProfileNav'
import { listSkills } from './services/backendService'
import { FloatingPanelFrame } from './components/FloatingPanelFrame'
import { FloatingViewSurface } from './components/FloatingViewSurface'
import { closeWebFloatingPanel, getWebFloatingPanel, subscribeWebFloatingPanel } from './pluginPanelSeam'

const PREVIEW_SIZES: Array<[number, string]> = [[390, 'iPhone'], [414, 'Max'], [768, 'iPad']]
/** 桌面/web 移动预览「手机框」:套在整个 app 外(引擎壳 + 设置/商店/成就等 fixed 浮层),
 *  靠 .sc-device 的 transform 包含块把框内所有 fixed 后代收进设备框,二级界面不再撑满桌面窗口。
 *  非 mobile 预览态直接透传 children(桌面路径零改);真机走 MobileRoot 不经此处。 */
function MobilePreviewFrame({ children }: { children: ReactNode }) {
  const [w, setW] = useState(390)
  if (UI_MODE !== 'mobile') return <>{children}</>
  // 视口本身就是手机尺寸(真手机浏览器访问 web / 极窄窗口)→ 全屏裸壳,预览框只服务宽屏桌面预览。
  // 挂载时一次判定(UI_MODE 同为 reload 制,行为一致)。
  if (window.innerWidth <= 820) return <>{children}</>
  return (
    <div className="sc-frame">
      <div className="sc-bar">
        {PREVIEW_SIZES.map(([px, name]) => (
          <button key={px} className={`sc-size${w === px ? ' on' : ''}`} onClick={() => setW(px)}>{name} · {px}</button>
        ))}
      </div>
      <div className="sc-device" style={{ width: w }}>{children}</div>
    </div>
  )
}

export function Root() {
  useBootstrap()
  useEffect(() => installFileDropGuard(), []) // 全局 OS 文件拖放守卫:未被任何视图接手的拖放不再把 SPA 导航冲掉
  useEffect(() => { installStatusBarItems(); installNotificationWiring() }, []) // 状态栏内置项 + 通知事件接线(幂等)
  useEffect(() => window.tangu?.onMainAction?.((action, payload) => {
    if (action === 'onboarding') useApp.getState().setOnboarding(true)
    // 设置浮窗里拨了开发者选项的 ⌘K 开关:命令注册表每个渲染进程各一份,得由主窗自己重算。
    if (action === 'dev-commands') syncDevCommands()
    // 设置浮窗里点「发送测试通知」:通知卡只有主窗渲染,由主窗来弹才是真预览。
    if (action === 'test-notification') sendTestNotification()
    // 以下同理:浮窗 = 独立渲染进程 + 独立 store,作用在工作台上的动作由主窗自己做(09-21)。
    if (action === 'reset-layout') useWorkspace.getState().resetLayout()
    if (action === 'achievement-toast') debugFireToast()
    if (action === 'space-removed' && payload) forgetUserSpace(payload)
    if (action === 'chat-draft' && payload) draftInMainChat(payload)
    if (action === 'agents-changed') {
      void useApp.getState().refreshAgents()
      window.dispatchEvent(new Event('forsion:agents-changed'))
    }
    if (action === 'skills-changed') {
      void listSkills(useApp.getState().cfg).then((skillsList) => useApp.setState({ skillsList })).catch(() => {})
      window.dispatchEvent(new Event('forsion:skills-changed'))
    }
    if (action === 'open-agents') openAgentProfile(useApp.getState().defaultAgentSlug || '')
    if (action === 'open-agent' && payload && /^[a-z0-9][a-z0-9-]{0,63}$/.test(payload)) openAgentProfile(payload)
  }), [])
  const theme = useTheme()
  const a = useApp(useShallow((s) => ({
    sessions: s.sessions,
    archivedSessions: s.archivedSessions,
    activeId: s.activeId,
    settingsOpen: s.settingsOpen,
    settingsTab: s.settingsTab,
    settingsSkillKey: s.settingsSkillKey,
    onboarding: s.onboarding,
    feedbackOpen: s.feedbackOpen,
    marketOpen: s.marketOpen,
    closeMarket: s.closeMarket,
    achievementsOpen: s.achievementsOpen,
    cfg: s.cfg,
    tr: s.tr,
    openSettings: s.openSettings,
    closeSettings: s.closeSettings,
    patchConfig: s.patchConfig,
    connect: s.connect,
    setOnboarding: s.setOnboarding,
    closeFeedback: s.closeFeedback,
  })))
  const activeSession = a.sessions.find((s) => s.id === a.activeId) || a.archivedSessions.find((s) => s.id === a.activeId) || null
  const pluginFloating = useSyncExternalStore(subscribeWebFloatingPanel, getWebFloatingPanel, getWebFloatingPanel)

  // 引导结束 → 主界面入场动画(一次性):onboarding true→false 时给外壳挂 .main-enter,放完即移除。
  const [revealMain, setRevealMain] = useState(false)
  const prevOnboarding = useRef(a.onboarding)
  useEffect(() => {
    const was = prevOnboarding.current
    prevOnboarding.current = a.onboarding
    if (was && !a.onboarding) {
      setRevealMain(true)
      const id = setTimeout(() => setRevealMain(false), 650)
      return () => clearTimeout(id)
    }
  }, [a.onboarding])

  // 只有首启引导仍是全屏任务空间。设置/市场/成就/反馈改为 Floating Panel 后主工作台保持可见。
  const overlayOpen = a.settingsOpen || a.marketOpen || a.achievementsOpen || a.feedbackOpen || !!pluginFloating || a.onboarding

  return (
    <MobilePreviewFrame>
      <div
        className={`shell-host${revealMain ? ' main-enter' : ''}`}
        style={a.onboarding ? { visibility: 'hidden' } : undefined}
      >
        <Shell dark={theme.mode === 'dark'} soft={!!getLanguage(theme.lang)?.manifest.panelGap} buildDefault={buildDefaultLayout} header={<TopBar />} footer={<DesktopStatusBar />} />
      </div>

      {/* Amadeus 全局浮层(快速切换等):须在 shell-host 之后(拖窗区 DOM 顺序,同下)。 */}
      {amadeusAvailable() && <AmadeusOverlays />}
      {/* 设备远程面(Forsion Unit「整个主区切过去」):portal 进 .shell-work,未连过设备时渲染 null。
          web 复用本 Root 也带着它 —— 没有 units 桥就永远不激活,零可见影响。 */}
      <UnitRemoteSurface />
      <QuickFind />
      {/* 页内查找浮条(mod+f)。挂在这里而不是编辑器里 —— 它服务所有 View。 */}
      <FindBar />
      <HoverTip />


      {/* 更新提示已改为检测到新版自动弹出「更新」标签页(见 stores/bootstrap.ts),不再用顶部横幅。 */}

      <AnimatePresence>
        {a.settingsOpen && (
        <FloatingPanelFrame key="settings" title={a.tr('settings.title')} onClose={() => a.closeSettings()}>
          <SettingsModal
            open
            initialTab={a.settingsTab ?? undefined}
            initialSkillKey={a.settingsSkillKey ?? undefined}
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
            onRelaunchOnboarding={() => {
              a.closeSettings()
              try { localStorage.removeItem(ONBOARDING_DISMISS_KEY) } catch { /* ignore */ }
              a.setOnboarding(true)
            }}
          />
        </FloatingPanelFrame>
        )}
      </AnimatePresence>

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
            // 与设置页同一根语义:onThemeChange 只动主题色轴,背景色轴原样保留 ——
            // 引导里的背景色一排直接读写 themeStore.setBg,不经这条 props 链(2026-08-30 起两轴都露出)。
            onThemeChange={(lang, skin, mode) => theme.setTheme(lang, skin, theme.bg, mode)}
            onSeedChange={(hex) => theme.setSeedValue(hex)}
            onReconnect={() => {
              void window.tangu?.getConfig().then((c) => {
                const eff = { backendUrl: c.backendUrl, token: c.token, modelId: c.modelId }
                useApp.setState({ cfg: eff, desktopMode: 'managed' })
                void useApp.getState().connect(eff)
              })
            }}
            onFinish={() => {
              a.setOnboarding(false)
              void window.tangu?.getConfig().then((c) => {
                const eff = { backendUrl: c.backendUrl, token: c.token, modelId: c.modelId }
                useApp.setState({ cfg: eff, homeDir: c.homeDir, defaultWsDir: c.defaultWorkspaceDir || '' })
                void useApp.getState().connect(eff)
              })
            }}
          />
          </motion.div>
        )}
      </AnimatePresence>

      <AnimatePresence>
        {a.marketOpen && (
        <FloatingPanelFrame key="market" title={a.tr('market.title')} onClose={() => a.closeMarket()}>
          <MarketModal onClose={() => a.closeMarket()} />
        </FloatingPanelFrame>
        )}
      </AnimatePresence>

      <AnimatePresence>
        {a.achievementsOpen && (
        <FloatingPanelFrame key="achievements" title={a.tr('achievements.title')} onClose={() => useApp.getState().closeAchievements()}>
          <AchievementsModal onClose={() => useApp.getState().closeAchievements()} />
        </FloatingPanelFrame>
        )}
      </AnimatePresence>

      <AnimatePresence>
        {a.feedbackOpen && <FloatingPanelFrame key="feedback" compact title={a.tr('feedback.title')} onClose={() => a.closeFeedback()}>
          <FeedbackModal surface="panel" cfg={a.cfg} activeSession={activeSession} onClose={() => a.closeFeedback()} />
        </FloatingPanelFrame>}
      </AnimatePresence>

      <AnimatePresence>
        {pluginFloating?.view && <FloatingPanelFrame key={pluginFloating.id} title={pluginFloating.title} onClose={closeWebFloatingPanel}>
          <FloatingViewSurface target={pluginFloating.view} onUnavailable={closeWebFloatingPanel} />
        </FloatingPanelFrame>}
      </AnimatePresence>

      {/* 全屏二级界面是单任务空间:插件引导、成就延后到回到主应用后再出现(通知见下)。 */}
      {!overlayOpen && <PluginOnboardingHost />}

      {!overlayOpen && <AchievementToast onOpen={() => useApp.getState().openAchievements()} />}

      {/* 通知只在首启引导(仍是全屏)时让位:设置 / 市场 / 成就 / 反馈在 web 上是居中浮层、主工作台可见,
          卡片(z 100)压在浮层(z 55)上正常弹 —— 否则浮层开着时「发送测试通知」等于没按(Codex 评审 P1)。
          web 只有一个渲染进程,不存在与别的窗口重复;面板自己的操作结果照旧走面板提示条(panelToast)。 */}
      {!a.onboarding && <NotificationHost />}
    </MobilePreviewFrame>
  )
}
