/** 独立窗口根:渲染**无 ribbon** 的 dockview 壳。只做精简 bootstrap(i18n 注入 + 连接共享后端拿实时数据),
 *  不跑主窗独有的更新检查 / inbox 角标轮询 / 通知回跳,也不挂 app 级浮层(设置/引导/市场/成就)。
 *  首次拖出的初始视图由主进程 pull 握手注入(detachedReady,避免「主进程先推、渲染端还没挂监听」竞态);
 *  重启时该窗自恢复 tangu2_layout_detached_<id> 布局(见 layoutPersist),detachedReady 返回空即可。 */
import { useEffect, useState } from 'react'
import { Shell, useWorkspace, useSpaceStore, setActiveSpaceCold, label, WINDOW_SPACE_ID } from '@lcl/engine'
import { buildDefaultLayout } from './bootstrapEngine'
import { useApp } from './stores/appStore'
import { useTheme } from './stores/themeStore'
import { getLanguage } from './theme/registry'
import { useI18n } from './i18n'
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

/** Space 窗口(整个 Space 开在这扇窗里,?space=<id>):等这个 Space 注册上来(用户 / 插件 Space 是异步装载的)、
 *  把它的画像配好,再挂 Shell —— 挂早了,还原的布局里引用的插件视图还没注册,整份会回退成默认。
 *  返回 true = 可以挂了且就是这个 Space;null = 还在等;false = 没等到(插件删了…),当普通独立窗开着。
 *  普通独立窗(没带 space)恒为 false。 */
function useWindowSpace(): boolean | null {
  const [ready, setReady] = useState<boolean | null>(WINDOW_SPACE_ID ? null : false)
  useEffect(() => {
    const id = WINDOW_SPACE_ID
    if (!id) return
    let done = false
    const settle = (): boolean => {
      if (done) return true // 下面钉活动 id 那一笔会再触发一次订阅:不挡就是自己调自己,栈溢出
      const sp = useSpaceStore.getState().spaces.find((s) => s.id === id)
      if (!sp) return false
      done = true
      // 内置之外的 Space 此刻还没注册时,registerSpaces 把内存里的活动 id 归一成了产品默认 → 钉回来(不落盘:活动键是主窗的)。
      setActiveSpaceCold(id, false)
      const ws = useWorkspace.getState()
      ws.setSidebarDefaults(sp.sidebarDefaults)
      ws.setSideProfile(sp.id, sp.resizableSides ?? {}, sp.sideDefaultScale, sp.bottomSpan)
      ws.setPinned(sp.pinned)
      document.title = label(sp.name)
      setReady(true)
      return true
    }
    if (settle()) return
    const off = useSpaceStore.subscribe(() => { if (settle()) { off(); window.clearTimeout(timer) } })
    // ponytail: 8 秒没等到就不等了。插件装载比这还慢的机器上会落成一扇空窗,关掉重开即可;要更稳得让插件装载报「全部就位」。
    const timer = window.setTimeout(() => { off(); setReady(false) }, 8000)
    return () => { off(); window.clearTimeout(timer) }
  }, [])
  return ready
}

export function DetachedRoot() {
  const { t } = useI18n()
  const theme = useTheme()
  const inSpace = useWindowSpace()

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

  // Space 窗口还在等它的 Space:先只留拖窗带(窗口得能挪 / 关),不挂 Shell。
  if (inSpace === null) return <div className="shell-host">{isMac && <div style={{ height: 38, WebkitAppRegion: 'drag' } as React.CSSProperties} />}</div>

  return (
    <>
      <div className="shell-host">
        <Shell
          noRibbon
          dark={theme.mode === 'dark'}
          soft={!!getLanguage(theme.lang)?.manifest.panelGap}
          // Space 窗口没有存过布局(且没播种到)时,摆这个 Space 自己的默认布局。
          buildDefault={inSpace ? buildDefaultLayout : buildDetachedDefault}
          // mac hiddenInset:留一条可拖拽标题带给交通灯(win/linux 有原生标题栏,不需要)。
          header={isMac ? <div style={{ height: 38, flex: '0 0 auto', WebkitAppRegion: 'drag' } as React.CSSProperties} /> : undefined}
        />
      </div>
      {window.amadeus && <AmadeusOverlays />}
      {/* 分离窗口也是完整的 Shell(installHotkeys 照跑),不挂就只有 mod+f 没反应。 */}
      <FindBar />
    </>
  )
}
