/** 启动副作用(React 生命周期相关):注入 i18n 翻译器 → 引导连接 → 全局轮询 + 快捷键。 */
import { useEffect } from 'react'
import { useI18n } from '../i18n'
import { useApp } from './appStore'
import { useInbox } from './inboxStore'
import { useChannels } from './channelsStore'
import { setActiveSpace } from '@lcl/engine'
import { maybeAutoOpenWhatsNew } from '../components/WhatsNewDialog'
import { setUnauthorizedHandler } from '../services/http'
import { useAttention } from './attentionStore'
import { openSessionFromApproval } from './attentionOpen'
import { installTraySessionsReport } from '../trayReport'

// 任意请求(含轮询/SSE)返回 401 → 集中触发登录过期处理(在 React 外注册一次)。
// P1-K6 S2:带上是哪台引擎回的 —— 经 hub 的「我的电脑」回 401 绝不重启本机引擎 / 误登出(appStore.handleAuthExpired)。
setUnauthorizedHandler((target) => useApp.getState().handleAuthExpired(target))

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

  // 启动静默检查更新:检测到新版(或已下载)→ 弹出 What's new(两栏:版本列表 + 官网更新文章)。
  // 主进程之后每 6 小时 / 睡眠唤醒再查;弹不弹由 maybeAutoOpenWhatsNew 定(只在主窗、跳过的版本不弹、一次运行每版本一次)。
  useEffect(() => {
    const off = window.tangu?.onUpdaterStatus?.(maybeAutoOpenWhatsNew)
    void window.tangu?.checkForUpdates?.()
    return () => off?.()
  }, [])

  // 全局单轮询器(每 4s 拉当前会话带外消息 + 订阅外部在飞 run)。
  // 列表里有本端没订阅、引擎报 busy 的会话(子会话、主会话自动接着做的一轮)时顺带刷新会话列表,行尾状态才跟得上;
  // 最后一个 busy 没了之后再多刷两轮(子会话收尾与主会话起轮之间那一下可能正好被拍到)。
  useEffect(() => {
    let tail = 0
    const timer = window.setInterval(() => {
      const st = useApp.getState()
      if (st.activeId && st.connState === 'ok') void st.pollSession(st.activeId)
      if (st.connState !== 'ok') return
      if (st.sessions.some((x) => x.busy && !st.runningBySession[x.id])) tail = 2
      else if (tail > 0) tail--
      else return
      void st.refreshSessions(st.cfg).catch(() => {})
    }, 4000)
    return () => window.clearInterval(timer)
  }, [])

  // 收件箱:全局常驻未读轮询(ribbon/dock 角标在任何 Space 下更新)。桌面壳 或 移动端(本地 inbox)gate;Tangu Web 不跑。
  useEffect(() => {
    if (!window.tangu?.backendStatus && !window.tangu?.mobile) return
    useInbox.getState().startPolling()
    return () => useInbox.getState().stopPolling()
  }, [])

  // 通道(微信/Telegram/QQ):全局常驻状态轮询(侧栏通道文件夹 + 连接状态点)。仅内置本地后端。
  useEffect(() => {
    if (!window.tangu?.backendStatus) return
    useChannels.getState().startPolling()
    return () => useChannels.getState().stopPolling()
  }, [])

  // 系统通知点击 → 聚焦窗口后回跳 Inbox Space(main 进程 webContents.send('inbox:open'))。
  useEffect(() => {
    const off = window.tangu?.onInboxOpen?.(() => setActiveSpace('inbox'))
    return () => off?.()
  }, [])

  // P1-K3:会话列表「等你处理」点的数据源(引擎待批索引 20s 轮询 + 回前台立即拉)。门控与收件箱同款:桌面壳 或 移动端;Tangu Web 不跑。
  useEffect(() => {
    if (!window.tangu?.backendStatus && !window.tangu?.mobile) return
    return useAttention.getState().install()
  }, [])

  // P1-K3:远程会话待批的系统通知被点击(主进程 approvalDelivery → approval:open)→ 打开那条会话。仅桌面壳有这个 IPC。
  useEffect(() => {
    const off = window.tangu?.onApprovalOpen?.(({ sessionId }) => { void openSessionFromApproval(sessionId) })
    return () => off?.()
  }, [])

  // 借鉴 Comma 2.6:在跑 / 等你的会话报给托盘 / 菜单栏(仅桌面壳有这个 IPC;各窗口各报一份,主进程并起来)。语言变了重装,标题跟着换。
  useEffect(() => installTraySessionsReport((k) => t(k)), [t])

  // 快捷键:全部由引擎 installHotkeys 统一分发(命令 new-chat=mod+n、命令面板=mod+k 等),
  // 且支持设置→快捷键里自定义。此处不再单独监听(原 ⌘N 处理与 new-chat 命令重复,已移除)。
}
