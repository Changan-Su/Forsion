/** App 根:启动副作用(连接/轮询/更新)+ 主题桥接给纯引擎 Shell + 设置/引导/更新横幅浮层。 */
import { useEffect, useRef, useState } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import { Shell } from '@lcl/engine'
import { useApp } from './stores/appStore'
import { useTheme } from './stores/themeStore'
import { getLanguage } from './theme/registry'
import { useBootstrap } from './stores/bootstrap'
import { buildDefaultLayout } from './bootstrapEngine'
import { TopBar } from './views/TopBar'
import { SettingsModal } from './components/SettingsModal'
import { AmadeusOverlays } from './amadeusOverlays'
import { MarketModal } from './components/MarketModal'
import { OnboardingWizard, ONBOARDING_DISMISS_KEY } from './components/OnboardingWizard'
import { FeedbackModal } from './components/FeedbackModal'
import { useShallow } from 'zustand/react/shallow'

export function Root() {
  useBootstrap()
  const theme = useTheme()
  const a = useApp(useShallow((s) => ({
    updateAvailable: s.updateAvailable,
    updateDismissed: s.updateDismissed,
    sessions: s.sessions,
    archivedSessions: s.archivedSessions,
    activeId: s.activeId,
    settingsOpen: s.settingsOpen,
    settingsTab: s.settingsTab,
    onboarding: s.onboarding,
    feedbackOpen: s.feedbackOpen,
    marketOpen: s.marketOpen,
    closeMarket: s.closeMarket,
    toasts: s.toasts,
    cfg: s.cfg,
    tr: s.tr,
    openSettings: s.openSettings,
    dismissUpdate: s.dismissUpdate,
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

  return (
    <>
      <div className={`shell-host${revealMain ? ' main-enter' : ''}`}>
        <Shell dark={theme.mode === 'dark'} soft={!!getLanguage(theme.lang)?.manifest.panelGap} buildDefault={buildDefaultLayout} header={<TopBar />} />
      </div>

      {/* Amadeus 全局浮层(快速切换等):须在 shell-host 之后(拖窗区 DOM 顺序,同下)。 */}
      {window.amadeus && <AmadeusOverlays />}

      {/* 必须排在 shell-host 之后:拖窗区按 DOM 顺序合成,横幅的 no-drag 若早于 Shell 的 drag 区会失效(见 base.css「Electron 拖窗区兜底」)。 */}
      {a.updateAvailable && !a.updateDismissed && (
        <div className="update-banner" style={{ position: 'fixed', top: 0, left: 0, right: 0, zIndex: 40 }}>
          <span>{a.tr('app.update.bannerTitle', { version: a.updateAvailable.version || '' })}</span>
          <button className="btn primary sm" onClick={() => a.openSettings('about')}>{a.tr('app.update.bannerAction')}</button>
          <button className="update-banner-x" title={a.tr('app.update.bannerDismiss')} onClick={() => a.dismissUpdate()}>×</button>
        </div>
      )}

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
            open
            initialTab={a.settingsTab ?? undefined}
            cfg={a.cfg}
            activeSession={activeSession}
            themeLang={theme.lang}
            themeSkin={theme.skin}
            themeMode={theme.mode}
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

      <AnimatePresence>
        {a.marketOpen && (
        <motion.div
          key="market"
          style={{ position: 'fixed', inset: 0, zIndex: 50, display: 'flex', minWidth: 0, minHeight: 0, overflow: 'hidden', background: 'var(--bg)' }}
          initial={{ opacity: 0, scale: 0.985 }}
          animate={{ opacity: 1, scale: 1 }}
          exit={{ opacity: 0, scale: 0.985 }}
          transition={{ duration: 0.22, ease: [0.2, 0.8, 0.2, 1] }}
        >
          <MarketModal />
        </motion.div>
        )}
      </AnimatePresence>

      {a.feedbackOpen && (
        <FeedbackModal cfg={a.cfg} activeSession={activeSession} onClose={() => a.closeFeedback()} />
      )}

      <div className="toast-wrap" aria-live="polite" aria-atomic="true">
        {a.toasts.map((toast) => (
          <div key={toast.id} className={`toast${toast.error ? ' error' : ''}`}>
            {toast.text}
          </div>
        ))}
      </div>
    </>
  )
}
