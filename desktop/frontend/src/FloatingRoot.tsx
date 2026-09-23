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
import type { SessionRecord } from './types'
import { FloatingViewSurface } from './components/FloatingViewSurface'
import { PluginOnboardingHost } from './components/PluginOnboardingModal'
import { listSkills } from './services/backendService'

export function FloatingRoot() {
  const { t } = useI18n()
  const theme = useTheme()
  const [target, setTarget] = useState<FloatingPanelOpenOptions | null>(null)
  const app = useApp(useShallow((s) => ({
    cfg: s.cfg, cfgLoaded: s.cfgLoaded, closeSettings: s.closeSettings, closeMarket: s.closeMarket,
    closeAchievements: s.closeAchievements, closeFeedback: s.closeFeedback,
    patchConfig: s.patchConfig, connect: s.connect,
  })))
  // 面板一律只认开窗方递来的那条会话:本窗口的 activeId 兜底是列表第一条,拿它当「当前会话」会挂错人
  // (反馈会挂错会话、设置的「导出日志」会导错会话)。递不到就老实显示「未关联会话」/ 禁用导出。
  const panelSession = (target?.params?.session as SessionRecord | undefined)?.id ? target!.params!.session as SessionRecord : null
  const close = (): void => window.tangu?.closeSelf?.()

  useEffect(() => { useApp.getState().setTr((k, vars) => t(k, vars as Record<string, string | number> | undefined)) }, [t])
  useEffect(() => { void useApp.getState().boot() }, [])
  useEffect(() => { if (window.amadeus) ensureAmadeusReady() }, [])
  useEffect(() => installFileDropGuard(), [])
  useEffect(() => window.tangu?.onMainAction?.((action) => {
    if (action === 'agents-changed') {
      void useApp.getState().refreshAgents()
      window.dispatchEvent(new Event('forsion:agents-changed'))
    }
    if (action === 'skills-changed') {
      void listSkills(useApp.getState().cfg).then((skillsList) => useApp.setState({ skillsList })).catch(() => {})
      window.dispatchEvent(new Event('forsion:skills-changed'))
    }
  }), [])
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
        initialSkillKey={typeof target.params?.skillKey === 'string' ? target.params.skillKey : undefined}
        cfg={app.cfg} activeSession={panelSession}
        themeLang={theme.lang} themeSkin={theme.skin} themeMode={theme.mode} themeModePref={theme.modePref}
        flatOn={theme.flat} glassOn={theme.glass} themeSeed={theme.seed}
        onClose={onSettingsClose} onConfigChange={app.patchConfig}
        onThemeChange={(lang, skin, mode) => theme.setTheme(lang, skin, theme.bg, mode)}
        onFlatChange={theme.setFlat} onGlassChange={theme.setGlass} onSeedChange={theme.setSeedValue}
        onReloadThemes={theme.reloadThemes}
        onReconnect={(patch) => void app.connect({ ...app.cfg, ...(patch || {}) })}
        onRelaunchOnboarding={() => {
          try { localStorage.removeItem(ONBOARDING_DISMISS_KEY) } catch { /* ignore */ }
          window.tangu?.requestMainAction?.('onboarding'); close()
        }}
      />}
      {target.builtin === 'market' && <MarketModal onClose={onMarketClose} />}
      {target.builtin === 'achievements' && <AchievementsModal onClose={onAchievementsClose} />}
      {target.builtin === 'feedback' && app.cfgLoaded && <FeedbackModal key={panelSession?.id || ''} surface="panel" cfg={app.cfg} activeSession={panelSession} onClose={onFeedbackClose} />}
      {target.view && <FloatingViewSurface target={target.view} onUnavailable={close} />}
    </main>
    {/* 插件检查卡:设置 / 市场自 2026-09-20 住在这个独立窗口里,「运行引导」、手动启用、市场装完都在这里
        触发 —— 检查卡的 store 每个渲染进程一份,只挂在主窗 Root 里的话,这边点了什么都不会出现。 */}
    {(target.builtin === 'settings' || target.builtin === 'market') && <PluginOnboardingHost />}
  </div>
}
