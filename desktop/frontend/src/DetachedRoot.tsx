/** 独立窗口根:渲染**无 ribbon** 的 dockview 壳。只做精简 bootstrap(i18n 注入 + 连接共享后端拿实时数据),
 *  不跑主窗独有的更新检查 / inbox 角标轮询 / 通知回跳,也不挂 app 级浮层(设置/引导/市场/成就)。
 *  首次拖出的初始视图由主进程 pull 握手注入(detachedReady,避免「主进程先推、渲染端还没挂监听」竞态);
 *  重启时该窗自恢复 tangu2_layout_detached_<id> 布局(见 layoutPersist),detachedReady 返回空即可。 */
import { useEffect } from 'react'
import { Shell, useWorkspace } from '@lcl/engine'
import { useApp } from './stores/appStore'
import { useTheme } from './stores/themeStore'
import { getLanguage } from './theme/registry'
import { useI18n } from './i18n'
import { AmadeusOverlays } from './amadeusOverlays'
import { FindBar } from './findInPage'
import { detachedId } from './windowKind'
import { installFileDropGuard } from './fileDropGuard'

/** 独立窗默认布局 = 主区空占位(home,不可关);真正的视图随后由 detachedReady 注入或从持久化恢复。 */
function buildDetachedDefault(): void {
  useWorkspace.getState().openView('home', {}, 'main')
}

export function DetachedRoot() {
  const { t } = useI18n()
  const theme = useTheme()

  useEffect(() => {
    useApp.getState().setTr((k, vars) => t(k, vars as Record<string, string | number> | undefined))
  }, [t])
  useEffect(() => { void useApp.getState().boot() }, [])
  useEffect(() => installFileDropGuard(), []) // 独立窗也装全局拖放守卫

  // pull 握手:向主进程取本窗待打开的初始视图(拖出时登记的 {type, params}[]),逐个开在主区。
  useEffect(() => {
    void window.tangu?.detachedReady?.(detachedId()).then((views) => {
      if (!views?.length) return
      const ws = useWorkspace.getState()
      for (const v of views) ws.openView(v.type, v.params ?? {}, 'main')
    })
  }, [])

  const isMac = (() => { try { return window.tangu?.platform === 'darwin' } catch { return false } })()

  return (
    <>
      <div className="shell-host">
        <Shell
          noRibbon
          dark={theme.mode === 'dark'}
          soft={!!getLanguage(theme.lang)?.manifest.panelGap}
          buildDefault={buildDetachedDefault}
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
