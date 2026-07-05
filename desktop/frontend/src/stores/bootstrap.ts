/** 启动副作用(React 生命周期相关):注入 i18n 翻译器 → 引导连接 → 全局轮询 + 快捷键。 */
import { useEffect } from 'react'
import { useI18n } from '../i18n'
import { useApp } from './appStore'
import { useInbox } from './inboxStore'
import { setActiveSpace } from '../engine'
import { setUnauthorizedHandler } from '../services/http'

// 任意请求(含轮询/SSE)返回 401 → 集中触发登录过期处理(在 React 外注册一次)。
setUnauthorizedHandler(() => useApp.getState().handleAuthExpired())

export function useBootstrap(): void {
  const { t } = useI18n()

  // 把 hook 版 t 注入 store(store 在 React 外)。locale 变即更新。
  useEffect(() => {
    useApp.getState().setTr((k, vars) => t(k, vars as Record<string, string | number> | undefined))
  }, [t])

  // 启动一次:加载配置 + 连接(managed 自动 / external 有 token 即连)。
  useEffect(() => {
    void useApp.getState().boot()
  }, [])

  // 启动静默检查更新 + 订阅状态(检测到新版/已下载 → 顶部横幅)。
  useEffect(() => {
    const off = window.tangu?.onUpdaterStatus?.((st) => {
      if (st.phase === 'available' || st.phase === 'downloaded') useApp.getState().setUpdateAvailable({ version: st.version })
      else if (st.phase === 'not-available' || st.phase === 'idle') useApp.getState().setUpdateAvailable(null)
    })
    void window.tangu?.checkForUpdates?.()
    return () => off?.()
  }, [])

  // 全局单轮询器(每 4s 拉当前会话带外消息 + 订阅外部在飞 run)。
  useEffect(() => {
    const timer = window.setInterval(() => {
      const st = useApp.getState()
      if (st.activeId && st.connState === 'ok') void st.pollSession(st.activeId)
    }, 4000)
    return () => window.clearInterval(timer)
  }, [])

  // 收件箱:全局常驻未读轮询(ribbon/dock 角标在任何 Space 下更新)。桌面壳 或 移动端(本地 inbox)gate;Tangu Web 不跑。
  useEffect(() => {
    if (!window.tangu?.backendStatus && !window.tangu?.mobile) return
    useInbox.getState().startPolling()
    return () => useInbox.getState().stopPolling()
  }, [])

  // 系统通知点击 → 聚焦窗口后回跳 Inbox Space(main 进程 webContents.send('inbox:open'))。
  useEffect(() => {
    const off = window.tangu?.onInboxOpen?.(() => setActiveSpace('inbox'))
    return () => off?.()
  }, [])

  // 快捷键:全部由引擎 installHotkeys 统一分发(命令 new-chat=mod+n、命令面板=mod+k 等),
  // 且支持设置→快捷键里自定义。此处不再单独监听(原 ⌘N 处理与 new-chat 命令重复,已移除)。
}
