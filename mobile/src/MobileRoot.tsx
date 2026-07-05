/**
 * 移动端 App 根:启动副作用(连接/轮询,复用 desktop useBootstrap)+ 主题桥接给 MobileShell +
 * 设置浮层(账号/登录)+ toast。刻意精简 desktop Root 的桌面专属浮层(更新横幅/引导/商店/Amadeus 浮层);
 * 需要时按 state 门控逐个加回。
 */
import { useEffect } from 'react'
import { useApp } from '@/stores/appStore'
import { useTheme } from '@/stores/themeStore'
import { useBootstrap } from '@/stores/bootstrap'
import { useInbox } from '@/stores/inboxStore'
import { pullInbox } from '@/services/backendService'
import { SettingsModal } from '@/components/SettingsModal'
import { AnimatePresence, motion } from 'framer-motion'
import { useShallow } from 'zustand/react/shallow'
import { MobileShell } from './engine/MobileShell'

/** 移动端本地 inbox 内容来自云端广播,但无服务端 inboxPull 调度器 → 客户端定时静默拉(绕开 inboxStore.pull 的 toast)。 */
function useInboxAutoPull(): void {
  useEffect(() => {
    const doPull = async () => {
      if (!window.tangu?.mobile || useApp.getState().connState !== 'ok') return
      try {
        const r = await pullInbox(useApp.getState().cfg)
        if (r.added) { void useInbox.getState().refreshList(); void useInbox.getState().refreshUnread() }
      } catch { /* 静默 */ }
    }
    void doPull()
    const timer = window.setInterval(doPull, 5 * 60_000)
    let prev = useApp.getState().connState
    const unsub = useApp.subscribe((s) => { if (s.connState === 'ok' && prev !== 'ok') void doPull(); prev = s.connState })
    return () => { window.clearInterval(timer); unsub() }
  }, [])
}

export function MobileRoot() {
  useBootstrap()
  useInboxAutoPull()
  const theme = useTheme()
  const a = useApp(useShallow((s) => ({
    sessions: s.sessions,
    archivedSessions: s.archivedSessions,
    activeId: s.activeId,
    settingsOpen: s.settingsOpen,
    settingsTab: s.settingsTab,
    toasts: s.toasts,
    cfg: s.cfg,
    closeSettings: s.closeSettings,
    patchConfig: s.patchConfig,
    connect: s.connect,
  })))
  const activeSession = a.sessions.find((s) => s.id === a.activeId) || a.archivedSessions.find((s) => s.id === a.activeId) || null

  return (
    <>
      <div className="shell-host">
        <MobileShell dark={theme.mode === 'dark'} />
      </div>

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
            />
          </motion.div>
        )}
      </AnimatePresence>

      <div className="toast-wrap" aria-live="polite" aria-atomic="true">
        {a.toasts.map((toast) => (
          <div key={toast.id} className={`toast${toast.error ? ' error' : ''}`}>{toast.text}</div>
        ))}
      </div>
    </>
  )
}
