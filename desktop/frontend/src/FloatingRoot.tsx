import { useEffect, useState } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { useApp } from './stores/appStore'
import { useTheme } from './stores/themeStore'
import { useI18n } from './i18n'
import { SettingsModal } from './components/SettingsModal'
import { MarketModal } from './components/MarketModal'
import { AchievementsModal } from './achievements/AchievementsModal'
import { FeedbackModal } from './components/FeedbackModal'
import { ONBOARDING_DISMISS_KEY } from './components/OnboardingWizard'
import { ensureAmadeusReady } from './amadeusPlugins'
import { installFileDropGuard } from './fileDropGuard'
import { floatingId } from './windowKind'
import type { FloatingPanelOpenOptions } from '../../shared/floatingPanel'
import { FloatingViewSurface } from './components/FloatingViewSurface'

export function FloatingRoot() {
  const { t } = useI18n()
  const theme = useTheme()
  const [target, setTarget] = useState<FloatingPanelOpenOptions | null>(null)
  const app = useApp(useShallow((s) => ({
    sessions: s.sessions, archivedSessions: s.archivedSessions, activeId: s.activeId,
    cfg: s.cfg, closeSettings: s.closeSettings, closeMarket: s.closeMarket,
    closeAchievements: s.closeAchievements, closeFeedback: s.closeFeedback,
    patchConfig: s.patchConfig, connect: s.connect,
  })))
  const activeSession = app.sessions.find((s) => s.id === app.activeId)
    || app.archivedSessions.find((s) => s.id === app.activeId) || null
  const close = (): void => window.tangu?.closeSelf?.()

  useEffect(() => { useApp.getState().setTr((k, vars) => t(k, vars as Record<string, string | number> | undefined)) }, [t])
  useEffect(() => { void useApp.getState().boot() }, [])
  useEffect(() => { if (window.amadeus) ensureAmadeusReady() }, [])
  useEffect(() => installFileDropGuard(), [])
  useEffect(() => {
    const id = floatingId()
    const off = window.tangu?.onFloatingTarget?.(setTarget)
    void window.tangu?.floatingReady?.(id).then((next) => { if (next) setTarget(next) })
    return () => off?.()
  }, [])
  useEffect(() => {
    if (target?.builtin === 'feedback' && typeof target.params?.description === 'string') {
      useApp.setState({ feedbackDraft: target.params.description })
    }
  }, [target])

  // BrowserWindow stays hidden until ready-to-show; do not flash an app-level loading screen
  // while the local IPC handshake resolves.
  if (!target) return <div className="floating-native-root" />
  const onSettingsClose = (): void => { app.closeSettings(); close() }
  const onMarketClose = (): void => { app.closeMarket(); close() }
  const onAchievementsClose = (): void => { app.closeAchievements(); close() }
  const onFeedbackClose = (): void => { app.closeFeedback(); close() }
  return <div className="floating-native-root">
    {window.tangu?.platform === 'darwin' && <header className="floating-native-chrome">{target.title}</header>}
    <main className="floating-native-content">
      {target.builtin === 'settings' && <SettingsModal key={JSON.stringify(target.params ?? {})}
        open initialTab={typeof target.params?.tab === 'string' ? target.params.tab as never : undefined}
        cfg={app.cfg} activeSession={activeSession}
        themeLang={theme.lang} themeSkin={theme.skin} themeMode={theme.mode} themeModePref={theme.modePref}
        glassOn={theme.glass} flatOn={theme.flat} themeSeed={theme.seed}
        onClose={onSettingsClose} onConfigChange={app.patchConfig}
        onThemeChange={(lang, skin, mode) => theme.setTheme(lang, skin, theme.bg, mode)}
        onGlassChange={theme.setGlass} onFlatChange={theme.setFlat} onSeedChange={theme.setSeedValue}
        onReloadThemes={theme.reloadThemes}
        onReconnect={(patch) => void app.connect({ ...app.cfg, ...(patch || {}) })}
        onRelaunchOnboarding={() => {
          try { localStorage.removeItem(ONBOARDING_DISMISS_KEY) } catch { /* ignore */ }
          window.tangu?.requestMainAction?.('onboarding'); close()
        }}
      />}
      {target.builtin === 'market' && <MarketModal onClose={onMarketClose} />}
      {target.builtin === 'achievements' && <AchievementsModal onClose={onAchievementsClose} />}
      {target.builtin === 'feedback' && <FeedbackModal surface="panel" cfg={app.cfg} activeSession={activeSession} onClose={onFeedbackClose} />}
      {target.view && <FloatingViewSurface target={target.view} onUnavailable={close} />}
    </main>
  </div>
}
