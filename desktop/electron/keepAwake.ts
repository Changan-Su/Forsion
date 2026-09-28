/**
 * 「有会话运行时阻止电脑休眠」(config.keepAwakeWhileRunning,默认关)。
 *
 * 各窗口渲染层把「自己订阅着的在飞 run 数」经 power:running 报上来,按 webContents 分桶;
 * 开关开 + 任一窗口有 run → 持一枚 powerSaveBlocker('prevent-app-suspension'),否则释放。
 * 卫星窗口可能订阅同一个会话,所以判「任一」而不是求和。
 * 该类型只拦**闲置自动休眠**(macOS = NoIdleSleep 断言;Windows = ExecutionRequired 电源请求,传统 S3 机器上
 * 等价 SystemRequired):屏幕照常熄灭,合盖 / 手动睡眠不拦;Modern Standby 笔记本用电池时,系统会在睡眠超时
 * 约 5 分钟后终止请求(微软电源策略上限,应用层绕不过)。
 *
 * ponytail: 只认渲染层订阅的 run(本机发的消息 / 打开过的会话,= 侧栏「运行中」圆点那份);
 * 通道(微信等)、Muse、自动化、其他设备经 Unit 起的后台 run 不算。要全口径 → 引擎暴露在飞 run 数
 * (agentLoop 的 runTasks.size),主进程轮询它。
 *
 * P1-K2 强制通道 force(key, on):不看开关、不看渲染层上报 —— 远程 run 在跑时阻止闲置休眠(远端没法把电脑唤醒;
 * 仍只拦闲置休眠,合盖照睡)。任一 key 开着即持有;与开关 + 上报的判定取「或」。
 */
export interface KeepAwakeDeps {
  isEnabled: () => boolean
  start: () => number
  stop: (id: number) => void
}

export function createKeepAwake(d: KeepAwakeDeps) {
  const busy = new Set<number>() // 有在飞 run 的 webContents id
  const forced = new Set<string>() // P1-K2:强制通道(remote = 远程 run 在跑)
  let blocker: number | null = null
  /** 按当前开关 + 上报 + 强制通道重算;开关变化后必须调一次(关掉要立刻放、运行中打开要立刻拦)。返回是否持有。 */
  const refresh = (): boolean => {
    const want = (d.isEnabled() && busy.size > 0) || forced.size > 0
    if (want && blocker === null) blocker = d.start()
    else if (!want && blocker !== null) {
      d.stop(blocker)
      blocker = null
    }
    return blocker !== null
  }
  return {
    report(sender: number, running: boolean): boolean {
      if (running) busy.add(sender)
      else busy.delete(sender)
      return refresh()
    },
    /** 窗口销毁 / 渲染进程崩溃 / 重载:它来不及报 0,这里替它清掉。 */
    forget(sender: number): boolean {
      busy.delete(sender)
      return refresh()
    },
    /** 睡眠唤醒后重新申请:Windows 在用户主动睡眠时会终止电源请求,手里的 id 还在但已失效。 */
    /** P1-K2:强制通道开 / 关(不看「有会话运行时不休眠」开关)。返回是否持有。 */
    force(key: string, on: boolean): boolean {
      if (on) forced.add(key)
      else forced.delete(key)
      return refresh()
    },
    rearm(): boolean {
      if (blocker !== null) {
        d.stop(blocker)
        blocker = null
      }
      return refresh()
    },
    refresh,
  }
}
