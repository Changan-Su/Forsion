/** App 根:启动副作用(连接/轮询/更新)+ 主题桥接给纯引擎 Shell + 设置/引导/更新横幅浮层。 */
import { useEffect, useRef, useState, type ReactNode } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import { Shell, UI_MODE } from '@lcl/engine'
import { useApp } from './stores/appStore'
import { useTheme } from './stores/themeStore'
import { getLanguage } from './theme/registry'
import { useBootstrap } from './stores/bootstrap'
import { buildDefaultLayout } from './bootstrapEngine'
import { TopBar } from './views/TopBar'
import { SettingsModal } from './components/SettingsModal'
import { AmadeusOverlays } from './amadeusOverlays'
import { QuickFind } from './quickFind'
import { HoverTip } from './hoverTip'
import { MarketModal } from './components/MarketModal'
import { PluginOnboardingHost } from './components/PluginOnboardingModal'
import { OnboardingWizard, ONBOARDING_DISMISS_KEY } from './components/OnboardingWizard'
import { FeedbackModal } from './components/FeedbackModal'
import { AchievementsModal } from './achievements/AchievementsModal'
import { AchievementToast } from './achievements/AchievementToast'
import { NotificationHost } from './components/NotificationHost'
import { DesktopStatusBar, installStatusBarItems } from './statusbar/items'
import { installNotificationWiring } from './stores/notificationWiring'
import { useShallow } from 'zustand/react/shallow'
import { installFileDropGuard } from './fileDropGuard'

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
  const theme = useTheme()
  const a = useApp(useShallow((s) => ({
    sessions: s.sessions,
    archivedSessions: s.archivedSessions,
    activeId: s.activeId,
    settingsOpen: s.settingsOpen,
    settingsTab: s.settingsTab,
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

  // 全屏二级界面(设置/市场/成就/引导)盖住主窗时,把主窗藏掉(visibility 保留布局不触发 dockview 重排)。
  // 不透明主题下浮层本就遮死主窗,藏它零可见影响 + 省一次绘制;玻璃主题下浮层透明,藏主窗后其半透侧栏
  // 才是叠在窗口原生玻璃(壁纸)上而非叠在主窗 UI 上 —— 与主窗侧栏同一套「半透染色 + 原生材质」机理。
  // ⚠ 打开即藏,但**关闭要等浮层退场动画播完再显**(codex Medium-3):浮层退场那 220ms 仍挂在 DOM 上,
  //   若跟着 open flag 立刻显主窗,玻璃侧栏会在这段里叠回刚露出的主窗 UI(正是要避免的浑浊)。
  const overlayOpen = a.settingsOpen || a.marketOpen || a.achievementsOpen || a.onboarding
  const overlayOpenRef = useRef(overlayOpen); overlayOpenRef.current = overlayOpen
  const [shellHidden, setShellHidden] = useState(overlayOpen)
  useEffect(() => { if (overlayOpen) setShellHidden(true) }, [overlayOpen])
  const onOverlayExitComplete = (): void => { if (!overlayOpenRef.current) setShellHidden(false) }

  return (
    <MobilePreviewFrame>
      <div
        className={`shell-host${revealMain ? ' main-enter' : ''}`}
        style={shellHidden ? { visibility: 'hidden' } : undefined}
      >
        <Shell dark={theme.mode === 'dark'} soft={!!getLanguage(theme.lang)?.manifest.panelGap} buildDefault={buildDefaultLayout} header={<TopBar />} footer={<DesktopStatusBar />} />
      </div>

      {/* Amadeus 全局浮层(快速切换等):须在 shell-host 之后(拖窗区 DOM 顺序,同下)。 */}
      {window.amadeus && <AmadeusOverlays />}
      <QuickFind />
      <HoverTip />


      {/* 更新提示已改为检测到新版自动弹出「更新」标签页(见 stores/bootstrap.ts),不再用顶部横幅。 */}

      <AnimatePresence onExitComplete={onOverlayExitComplete}>
        {a.settingsOpen && (
        <motion.div
          key="settings"
          className="fs-overlay"
          style={{ position: 'fixed', inset: 0, zIndex: 50, display: 'flex', minWidth: 0, minHeight: 0, overflow: 'hidden' }}
          initial={{ opacity: 0, scale: 0.985 }}
          animate={{ opacity: 1, scale: 1 }}
          exit={{ opacity: 0, scale: 0.985 }}
          transition={{ duration: 0.22, ease: [0.2, 0.8, 0.2, 1] }}
        >
          <SettingsModal
            open
            initialTab={a.settingsTab ?? undefined}
            cfg={a.cfg}
            activeSession={activeSession}
            themeLang={theme.lang}
            themeSkin={theme.skin}
            themeMode={theme.mode}
            themeModePref={theme.modePref}
            glassOn={theme.glass}
            flatOn={theme.flat}
            themeSeed={theme.seed}
            onClose={() => a.closeSettings()}
            onConfigChange={a.patchConfig}
            onThemeChange={(lang, skin, mode) => theme.setTheme(lang, skin, mode)}
            onGlassChange={(on) => theme.setGlass(on)}
            onFlatChange={(on) => theme.setFlat(on)}
            onSeedChange={(hex) => theme.setSeedValue(hex)}
            onReloadThemes={() => theme.reloadThemes()}
            onReconnect={(patch) => void a.connect({ ...a.cfg, ...(patch || {}) })}
            onRelaunchOnboarding={() => {
              a.closeSettings()
              try { localStorage.removeItem(ONBOARDING_DISMISS_KEY) } catch { /* ignore */ }
              a.setOnboarding(true)
            }}
          />
        </motion.div>
        )}
      </AnimatePresence>

      <AnimatePresence onExitComplete={onOverlayExitComplete}>
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
            onThemeChange={(lang, skin, mode) => theme.setTheme(lang, skin, mode)}
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

      <AnimatePresence onExitComplete={onOverlayExitComplete}>
        {a.marketOpen && (
        <motion.div
          key="market"
          className="fs-overlay"
          style={{ position: 'fixed', inset: 0, zIndex: 50, display: 'flex', minWidth: 0, minHeight: 0, overflow: 'hidden' }}
          initial={{ opacity: 0, scale: 0.985 }}
          animate={{ opacity: 1, scale: 1 }}
          exit={{ opacity: 0, scale: 0.985 }}
          transition={{ duration: 0.22, ease: [0.2, 0.8, 0.2, 1] }}
        >
          <MarketModal />
        </motion.div>
        )}
      </AnimatePresence>

      <AnimatePresence onExitComplete={onOverlayExitComplete}>
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

      {a.feedbackOpen && (
        <FeedbackModal cfg={a.cfg} activeSession={activeSession} onClose={() => a.closeFeedback()} />
      )}

      {/* 全屏二级界面是单任务空间:插件引导、成就与同步通知延后到回到主应用后再出现。 */}
      {!overlayOpen && <PluginOnboardingHost />}

      {!overlayOpen && <AchievementToast />}

      {!overlayOpen && <NotificationHost />}
    </MobilePreviewFrame>
  )
}
