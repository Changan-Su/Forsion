/** 独立窗口根:渲染**无 ribbon** 的 dockview 壳。只做精简 bootstrap(i18n 注入 + 连接共享后端拿实时数据),
 *  不跑主窗独有的更新检查 / inbox 角标轮询 / 通知回跳,也不挂 app 级浮层(设置/引导/市场/成就)。
 *  首次拖出的初始视图由主进程 pull 握手注入(detachedReady,避免「主进程先推、渲染端还没挂监听」竞态);
 *  重启时该窗自恢复 tangu2_layout_detached_<id> 布局(见 layoutPersist),detachedReady 返回空即可。 */
import { useEffect, useState } from 'react'
import { Shell, useWorkspace, useSpaceStore, subscribeViews, savedLayoutRestorable, label, WINDOW_SPACE_ID } from '@lcl/engine'
import type { SpaceDefinition } from '@lcl/engine'
import { buildDefaultLayout } from './bootstrapEngine'
import { useApp } from './stores/appStore'
import { useTheme } from './stores/themeStore'
import { getLanguage } from './theme/registry'
import { useI18n, registerMessages } from './i18n'
import { AmadeusOverlays } from './amadeusOverlays'
import { FindBar } from './findInPage'
import { detachedId } from './windowKind'
import { installFileDropGuard } from './fileDropGuard'
import { listSkills } from './services/backendService'
import { homeTarget } from './services/engine/targets'

/** 独立窗默认布局 = 主区空占位(home,不可关);真正的视图随后由 detachedReady 注入或从持久化恢复。 */
function buildDetachedDefault(): void {
  useWorkspace.getState().openView('home', {}, 'main')
}

registerMessages({
  'spaceWindow.stuck': {
    zh: '这个 Space 还没准备好。它所属的插件可能还在加载，或已被停用、卸载。准备好后这里会自动打开，也可以直接关掉这扇窗。',
    en: 'This Space is not ready yet. Its plugin may still be loading, or may have been disabled or removed. It will open here once it is ready, or you can close this window.',
  },
})

/** 等这么久还没等到 → 把话说明白(继续等)。也是「本窗存着的布局里引用的视图没注册全」时最多再等的时间。 */
const SPACE_WAIT_MS = 6000

/** Space 窗口(整个 Space 开在这扇窗里,?space=<id>)什么时候能挂 Shell:
 *   · 等这个 Space 注册上来(用户 / 插件 Space 是异步装载的)—— **一直等,不降级**:降级成普通独立窗会往同一把布局键里写一份
 *     空布局,把这扇窗原来的布局盖掉,Space 晚到了也回不来(Codex 评审)。等久了只是把话说明白。
 *   · 本窗存着的布局里引用的视图也要注册全(插件视图可能比 Space 晚到):挂早了还原落空,默认布局随即盖掉存档。
 *     这一条最多等 SPACE_WAIT_MS(视图可能再也不来 —— 插件卸了),到点照挂,落空走默认布局,口径同主窗的启动还原。
 *   · 挂上之后这个 Space 的定义换了 / 没了(插件更新、停用、卸载):整窗重载,从头再等一遍。
 *  返回 'plain' = 普通独立窗(没带 space);'wait' / 'stuck' = 还在等(stuck = 等久了);'ready' = 可以挂了。 */
function useWindowSpace(): 'plain' | 'wait' | 'stuck' | 'ready' {
  const [state, setState] = useState<'plain' | 'wait' | 'stuck' | 'ready'>(WINDOW_SPACE_ID ? 'wait' : 'plain')
  useEffect(() => {
    const id = WINDOW_SPACE_ID
    if (!id) return
    const t0 = Date.now()
    let mounted: SpaceDefinition | null = null
    let reloading = false
    const settle = (): void => {
      const sp = useSpaceStore.getState().spaces.find((s) => s.id === id)
      if (mounted) {
        if (sp !== mounted && !reloading) { reloading = true; location.reload() }
        return
      }
      if (!sp) return
      if (!savedLayoutRestorable() && Date.now() - t0 < SPACE_WAIT_MS) return
      mounted = sp
      const ws = useWorkspace.getState()
      ws.setSidebarDefaults(sp.sidebarDefaults)
      ws.setSideProfile(sp.id, sp.resizableSides ?? {}, sp.sideDefaultScale, sp.bottomSpan)
      ws.setPinned(sp.pinned)
      document.title = label(sp.name)
      setState('ready')
    }
    settle()
    const offSpaces = useSpaceStore.subscribe(settle)
    const offViews = subscribeViews(settle)
    const timer = window.setTimeout(() => { settle(); if (!mounted) setState('stuck') }, SPACE_WAIT_MS + 50)
    return () => { offSpaces(); offViews(); window.clearTimeout(timer) }
  }, [])
  return state
}

export function DetachedRoot() {
  const { t } = useI18n()
  const theme = useTheme()
  const spaceState = useWindowSpace()

  useEffect(() => {
    useApp.getState().setTr((k, vars) => t(k, vars as Record<string, string | number> | undefined))
  }, [t])
  useEffect(() => { void useApp.getState().boot() }, [])
  useEffect(() => installFileDropGuard(), []) // 独立窗也装全局拖放守卫
  useEffect(() => window.tangu?.onMainAction?.((action) => {
    if (action === 'agents-changed') {
      void useApp.getState().refreshAgents()
      window.dispatchEvent(new Event('forsion:agents-changed'))
    }
    if (action === 'skills-changed') {
      void listSkills(homeTarget()).then((skillsList) => useApp.setState({ skillsList })).catch(() => {})
      window.dispatchEvent(new Event('forsion:skills-changed'))
    }
  }), [])

  // pull 握手:向主进程取本窗待打开的初始视图(拖出时登记的 {type, params}[]),逐个开在主区。
  useEffect(() => {
    void window.tangu?.detachedReady?.(detachedId()).then((views) => {
      if (!views?.length) return
      const ws = useWorkspace.getState()
      for (const v of views) ws.openView(v.type, v.params ?? {}, 'main')
    })
  }, [])

  const isMac = (() => { try { return window.tangu?.platform === 'darwin' } catch { return false } })()

  // Space 窗口还在等它的 Space:只留拖窗带(窗口得能挪 / 关),不挂 Shell —— 不挂就不会往布局键里写东西。
  if (spaceState === 'wait' || spaceState === 'stuck') {
    return (
      <div className="shell-host" style={{ display: 'flex', flexDirection: 'column' }}>
        {isMac && <div style={{ height: 38, flex: '0 0 auto', WebkitAppRegion: 'drag' } as React.CSSProperties} />}
        {spaceState === 'stuck' && (
          <div className="space-window-wait" role="status" style={{ flex: 1, display: 'grid', placeItems: 'center', padding: 32, textAlign: 'center', color: 'var(--text-muted)', fontSize: 'var(--ui-font-body, 13px)', lineHeight: 1.6 }}>
            <span style={{ maxWidth: 420 }}>{t('spaceWindow.stuck')}</span>
          </div>
        )}
      </div>
    )
  }

  return (
    <>
      <div className="shell-host">
        <Shell
          noRibbon
          dark={theme.mode === 'dark'}
          soft={!!getLanguage(theme.lang)?.manifest.panelGap}
          // Space 窗口没有存过布局(且没播种到)时,摆这个 Space 自己的默认布局。
          buildDefault={spaceState === 'ready' ? buildDefaultLayout : buildDetachedDefault}
          // mac hiddenInset:不另留标题带 —— 标签栏顶到窗口最上(同主窗),交通灯由 engine.css 的 .shell--noribbon 让位;拖窗靠标签栏空白处。
        />
      </div>
      {window.amadeus && <AmadeusOverlays />}
      {/* 分离窗口也是完整的 Shell(installHotkeys 照跑),不挂就只有 mod+f 没反应。 */}
      <FindBar />
    </>
  )
}
