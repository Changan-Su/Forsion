/**
 * 停引擎前的「为什么停」(2026-11-20 中断任务续跑方案 B)。
 *
 * 桌面主进程在 SIGTERM / 强杀引擎**之前**,把意图原子写进 `<TANGU_HOME>/shutdown-intent.json`(先写临时文件再 rename)。
 * 引擎收到 SIGTERM 时同步读一次(pid 对得上、写入不超过 INTENT_MAX_AGE_MS 才认),据此把在途任务记成 interrupted(<reason>);
 * 引擎来不及处理(Windows 上信号等于强杀)时,下次启动的恢复流程按持有者 pid 对上这份意图,照样认作计划内的停,不落进 crash。
 * 引擎启动恢复处理完后删掉它。读不出 / 解析失败 = 没有意图(按 engine_stop / crash 算),不当成计划内。
 */
export const SHUTDOWN_INTENT_FILE = 'shutdown-intent.json'
export const INTENT_MAX_AGE_MS = 10 * 60_000

/** engine_stop:桌面明说「这次停了别续」(例如只清桌面设置、保留引擎数据那条路:续跑开关随设置一起没了,不能按缺省开去续)。 */
export type ShutdownIntentReason = 'app_quit' | 'app_update' | 'engine_restart' | 'account_change' | 'engine_stop'
export interface ShutdownIntent { reason: ShutdownIntentReason; pid: number; at: number }

const REASONS: readonly string[] = ['app_quit', 'app_update', 'engine_restart', 'account_change', 'engine_stop']

export function parseShutdownIntent(raw: string): ShutdownIntent | null {
  try {
    const j = JSON.parse(raw)
    if (!j || !REASONS.includes(j.reason) || !Number.isSafeInteger(j.pid) || j.pid <= 0 || !Number.isFinite(j.at)) return null
    return { reason: j.reason, pid: j.pid, at: j.at }
  } catch {
    return null
  }
}
