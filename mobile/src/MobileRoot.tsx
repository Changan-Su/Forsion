/**
 * 移动端 App 根:启动副作用(连接/轮询,复用 desktop useBootstrap)+ 主题桥接给 MobileShell +
 * 设置浮层(账号/登录)+ 通知。刻意精简 desktop Root 的桌面专属浮层(更新横幅/引导/商店/Amadeus 浮层);
 * 需要时按 state 门控逐个加回。
 *
 * ⚠️ 本文件消费的是 **desktop 的 appStore/组件**,而 vite build 不做类型检查 —— 桌面侧删个字段
 * 或给组件加个必填 prop,这里不会报错,直接在真机上崩(2026-07-27 的 `a.toasts.map` 就是这么
 * 把 v2.7.1 的安卓包整个打不开的)。**改 desktop 渲染层后请跑 `npm run typecheck`**(mobile 目录下)。
 */
import { useEffect } from 'react'
import { App as CapApp } from '@capacitor/app'
import { useApp } from '@/stores/appStore'
import { useTheme } from '@/stores/themeStore'
import { useBootstrap } from '@/stores/bootstrap'
import { useInbox } from '@/stores/inboxStore'
import { pullInbox } from '@/services/backendService'
import { SettingsModal } from '@/components/SettingsModal'
import { NotificationHost } from '@/components/NotificationHost'
import { AnimatePresence, motion } from 'framer-motion'
import { useShallow } from 'zustand/react/shallow'
import { SingleColumnHost, useWorkspace, useNav } from '@lcl/engine'
import { buildDefaultLayout } from '@/bootstrapEngine'

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

/** Android 系统返回(实体键/全面屏侧滑手势)接管:浮层→抽屉→tab 内后退→关视图→挂起。
 *  此前无人监听 backButton,返回手势直接把 app 退到后台——「侧滑返回没反应」的根因。 */
function useAndroidBack(): void {
  useEffect(() => {
    if (!window.tangu?.mobile) return // 仅原生壳;浏览器无此事件
    const sub = CapApp.addListener('backButton', () => {
      const app = useApp.getState()
      if (app.settingsOpen) { app.closeSettings(); return }
      const ws = useWorkspace.getState()
      if (ws.leftVisible) { ws.toggleSidebar('left'); return }
      if (ws.rightVisible) { ws.toggleSidebar('right'); return }
      const active = ws.mainTabs.find((t) => t.active)
      if (active) {
        const st = useNav.getState().stacks[active.id]
        if (st && st.idx > 0) { useNav.getState().back(active.id); return }
        if (active.type !== 'home') { ws.closeLeaf(active.id); return } // 白板/PDF/会话等 → 关回列表/home
      }
      void CapApp.minimizeApp() // 已在底:挂起(Android 默认原行为)
    })
    return () => { void sub.then((h) => h.remove()) }
  }, [])
}

export function MobileRoot() {
  useBootstrap()
  useInboxAutoPull()
  useAndroidBack()
  const theme = useTheme()
  const a = useApp(useShallow((s) => ({
    sessions: s.sessions,
    archivedSessions: s.archivedSessions,
    activeId: s.activeId,
    settingsOpen: s.settingsOpen,
    settingsTab: s.settingsTab,
    cfg: s.cfg,
    closeSettings: s.closeSettings,
    patchConfig: s.patchConfig,
    connect: s.connect,
  })))
  const activeSession = a.sessions.find((s) => s.id === a.activeId) || a.archivedSessions.find((s) => s.id === a.activeId) || null

  return (
    <>
      <div className="shell-host">
        <SingleColumnHost dark={theme.mode === 'dark'} buildDefault={buildDefaultLayout} />
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
            />
          </motion.div>
        )}
      </AnimatePresence>

      {/* 旧 .toast-wrap 已随 appStore.toasts 一起下线;通知统一走 notificationStore + NotificationHost。 */}
      <NotificationHost />
    </>
  )
}
