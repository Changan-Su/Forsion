/** Mini 悬浮卡片根:卫星窗口(?window=mini)下挂独立 MiniColumnHost。
 *  精简 bootstrap(i18n 注入 + 连接共享后端);不跑主窗独有的更新/inbox/通知,不挂 app 级浮层。
 *  独立导航:内容与切换全由 Mini Card 单层 chrome 驱动,与主窗互不影响。 */
import { useEffect } from 'react'
import { MiniColumnHost } from '@lcl/engine'
import { useApp } from './stores/appStore'
import { buildDefaultLayout } from './bootstrapEngine'
import { useI18n } from './i18n'
import { installFileDropGuard } from './fileDropGuard'

export function MiniRoot() {
  const { t } = useI18n()
  useEffect(() => {
    useApp.getState().setTr((k, vars) => t(k, vars as Record<string, string | number> | undefined))
  }, [t])
  useEffect(() => { void useApp.getState().boot() }, [])
  useEffect(() => installFileDropGuard(), []) // 全局 OS 文件拖放守卫(mini 窗也防被拖入文件冲掉)
  // 边缘吸附折叠/展开全在主进程(轮询光标位置,见 electron/main.ts onMiniSettled/pollMiniCursor)——
  // frameless 透明窗上 DOM mouseenter/leave 不可靠且无迟滞(会「一动就弹回」),故不在渲染层做。
  return <MiniColumnHost buildDefault={buildDefaultLayout} />
}
