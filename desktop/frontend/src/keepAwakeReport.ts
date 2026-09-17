import { useApp } from './stores/appStore'

/**
 * 「有会话运行时不休眠」的渲染层一半:runningBySession(= 侧栏「运行中」圆点那份)一变,就把本窗口
 * 订阅着的在飞 run 数报给主进程;开关、多窗口汇总、重载/崩溃清零、powerSaveBlocker 都在 electron/keepAwake.ts
 * 与 main.ts 的 power:running。web / 移动端没有这个接缝 → no-op。
 * 装上先报一次当前值:旧页面导航前发出、晚于主进程清零才到的正数,由新页面这一下盖掉。
 */
export function installKeepAwakeReport(): void {
  const tangu = window.tangu
  if (!tangu?.reportRunningSessions) return
  const report = (running: Record<string, string>): void => tangu.reportRunningSessions!(Object.keys(running).length)
  report(useApp.getState().runningBySession)
  useApp.subscribe((s, prev) => { if (s.runningBySession !== prev.runningBySession) report(s.runningBySession) })
}
