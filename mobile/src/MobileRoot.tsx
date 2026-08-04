/**
 * 移动端 App 根:启动副作用(连接/轮询,复用 desktop useBootstrap)+ 主题桥接给 MobileShell +
 * 设置浮层(账号/登录)+ Amadeus 对话框宿主 + 通知。刻意精简 desktop Root 的桌面专属浮层
 * (引导/商店/反馈/插件引导/QuickFind);哪些故意不要、为什么,以 `desktop/scripts/platform-parity.check.cjs`
 * 的 SKIP 表为准 —— 那张表是唯一台账,别只在这里凭记忆增删。
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
import { AmadeusOverlays } from '@/amadeusOverlays'
import { AchievementToast } from '@/achievements/AchievementToast'
import { AchievementsModal } from '@/achievements/AchievementsModal'
import { QuickFind } from '@/quickFind'
import { installNotificationWiring } from '@/stores/notificationWiring'
import { AnimatePresence, motion } from 'framer-motion'
import { useShallow } from 'zustand/react/shallow'
import { SingleColumnHost, useWorkspace, useNav } from '@lcl/engine'
// 命令面板:desktop 由 `Shell.tsx` 渲染,而移动端把 Shell 换成了空壳(vite.config engineSwap)——
// 于是 ribbon 的 rb-cmd 项(无条件注册,经「⋯」菜单在移动端可点)点了只是把 paletteOpen 置 true,
// 没有任何东西渲染它。宿主责任随外壳一起被换掉了,得在这儿接回来。
import { CommandPalette } from '@lcl/engine/CommandPalette'
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

/** Android 系统返回(实体键/全面屏侧滑手势)接管:壳内 sheet→浮层→抽屉→tab 内后退→关视图→挂起。
 *  此前无人监听 backButton,返回手势直接把 app 退到后台——「侧滑返回没反应」的根因。
 *  Manifest 已开 enableOnBackInvokedCallback(Capacitor App 插件走 androidx OnBackPressedDispatcher,
 *  自动桥到新 API):系统预测性返回动画只在链底「挂起 app」那档出现,链上各档照旧被我们拦截。 */
function useAndroidBack(): void {
  useEffect(() => {
    if (!window.tangu?.mobile) return // 仅原生壳;浏览器无此事件
    const sub = CapApp.addListener('backButton', () => {
      // 最上层先问壳:标签页 sheet /「⋯」菜单开着 → 由 SingleColumnHost 接管关闭(可取消事件)。
      const shellEv = new Event('forsion:mobile-back', { cancelable: true })
      window.dispatchEvent(shellEv)
      if (shellEv.defaultPrevented) return
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
  // 通知事件接线(幂等)。三段里 A(amadeusSync)/B(remoteSync)在移动端是可选链 no-op,真正生效的是
  // C:后台会话跑完 → 右上角通知。此前只挂了 NotificationHost 外壳没接线,设置里的「通知」页
  // 一直在管一个永不触发的东西。desktop 在 Root 里装,移动端走本文件 → 必须自己装一份。
  useEffect(() => { installNotificationWiring() }, [])
  const theme = useTheme()
  const a = useApp(useShallow((s) => ({
    sessions: s.sessions,
    archivedSessions: s.archivedSessions,
    activeId: s.activeId,
    settingsOpen: s.settingsOpen,
    settingsTab: s.settingsTab,
    achievementsOpen: s.achievementsOpen,
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

      {/* Amadeus 全局浮层。⚠️ 名字像「快速切换器」,实为**对话框宿主**:AskStringHost / DeleteAssetsHost /
          NewDrawingHost / ConfirmDialog / AutomationBuilderHost / TemplatePicker 都住在里面。
          不挂它,移动端所有 askString()(新建文件夹、添加属性、存为集合…共 20 处)的 promise 永不 resolve
          —— 点了没反应且不报错。门控与 desktop Root 同款。 */}
      {window.amadeus && <AmadeusOverlays />}

      {/* 下面三个的共同点:它们的入口 ribbon 项(rb-search / rb-achievements / rb-cmd)在
          bootstrapEngine 里是**无条件注册**的,而 SingleColumnHost 的「⋯」菜单会把所有
          side:'bottom' 的 ribbon 项原样搬上来并调它们的 onClick —— 也就是说移动端一直点得到,
          只是点完没有任何东西渲染(状态置了 true,宿主不在)。属于静默死按钮,不是「移动端没这功能」。 */}
      <QuickFind />
      <CommandPalette />

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

      {/* 成就解锁提示:埋点(track)与存档(localStorage)在移动端本就照跑,缺的只是这块弹层。
          成就总览 AchievementsModal 仍不挂 —— 单列壳没有 ribbon 入口,挂了也进不去(见 SKIP 表)。 */}
      <AchievementToast />

      {/* 旧 .toast-wrap 已随 appStore.toasts 一起下线;通知统一走 notificationStore + NotificationHost。 */}
      <NotificationHost />
    </>
  )
}
