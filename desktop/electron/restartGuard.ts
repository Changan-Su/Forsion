import { defineMainMessages, mt } from './mainI18n'

defineMainMessages({
  'main.restart.title': { zh: '重启更新', en: 'Restart to update' },
  'main.restart.busy': { zh: '还有未完成的任务，要强制退出并重启吗？', en: 'Tasks are still active. Force quit and restart?' },
  'main.restart.detail': { zh: '有 {tasks} 个运行中或排队中的任务，以及 {processes} 个后台进程。强制重启会中断它们；选择稍后重启可继续当前工作。', en: '{tasks} tasks are running or queued, with {processes} background processes. A forced restart will interrupt them. Choose Restart later to keep working.' },
  'main.restart.unknown': { zh: '暂时无法确认任务状态，要强制退出并重启吗？', en: 'Task status could not be checked. Force quit and restart?' },
  'main.restart.unknownDetail': { zh: '引擎暂时没有响应，可能仍有任务在运行。可以稍后重试，或强制退出并重启。', en: 'The engine is not responding and tasks may still be running. Try again later, or force quit and restart.' },
  'main.restart.later': { zh: '稍后重启', en: 'Restart later' },
  'main.restart.force': { zh: '强制退出并更新', en: 'Force quit and update' },
  // 开着「重启后自动接着做」时(中断任务续跑方案 B 第 7 节):任务不会白做,弹窗改说更新完会接着做,主按钮是「立即更新 / 立即重启」
  'main.restart.resumeUpdate': { zh: '现在更新吗？', en: 'Update now?' },
  'main.restart.resumeUpdateDetail': {
    zh: '有 {tasks} 个任务在跑。更新完重新打开后，它们会从停下的地方自动接着做。{processes} 个后台进程会被停掉。',
    en: '{tasks} tasks are running. After the update they will pick up where they left off. {processes} background processes will be stopped.',
  },
  'main.restart.resumeUpdateNow': { zh: '立即更新', en: 'Update now' },
  'main.restart.resumeRelaunch': { zh: '现在重启吗？', en: 'Restart now?' },
  'main.restart.resumeRelaunchDetail': {
    zh: '有 {tasks} 个任务在跑。重新打开后，它们会从停下的地方自动接着做。{processes} 个后台进程会被停掉。',
    en: '{tasks} tasks are running. After the restart they will pick up where they left off. {processes} background processes will be stopped.',
  },
  'main.restart.resumeRelaunchNow': { zh: '立即重启', en: 'Restart now' },
  'main.restart.resumeLater': { zh: '稍后', en: 'Later' },
  // 只有一部分能自动接着做(团队任务、ACP 会话、旧引擎建的 run 不续,评审 #10):如实说,主按钮照旧
  'main.restart.resumeSomeUpdateDetail': {
    zh: '有 {tasks} 个任务在跑，其中 {resumable} 个更新后会自动接着做，其余会被中断。',
    en: '{tasks} tasks are running; {resumable} of them will pick up where they left off after the update, the rest will be interrupted.',
  },
  'main.restart.resumeSomeRelaunchDetail': {
    zh: '有 {tasks} 个任务在跑，其中 {resumable} 个重启后会自动接着做，其余会被中断。',
    en: '{tasks} tasks are running; {resumable} of them will pick up where they left off after the restart, the rest will be interrupted.',
  },
})

/** resumable:引擎报的「此刻停机的话,本进程会自动接着做的任务数」;旧引擎不报 = undefined(按原来的弹窗)。 */
export interface RestartActivity { tasks: number; processes: number; unknown?: boolean; resumable?: number }
export interface RestartDialog {
  type: 'warning'; title: string; message: string; detail: string
  buttons: string[]; defaultId: number; cancelId: number; noLink: boolean
}
/**
 * 重启 / 装更新前的确认框。opts.autoResume(设置「重启后自动接着做未完成的任务」开着)、确实有任务在跑(不是查不到)、
 * 且引擎报了其中有几个会自动接着做(resumable > 0)时,换成「现在更新吗?」,主按钮(defaultId 1)= 立即更新 / 立即重启:
 *  - 全都会续(resumable ≥ tasks):「…会从停下的地方自动接着做」;
 *  - 只续一部分:如实说「其中 N 个会自动接着做,其余会被中断」(评审 #10)。
 * 旧引擎不报 resumable、或一个都不续:与原来一字不差。两种都是 0 = 稍后、1 = 继续,调用方按 response === 1 放行。
 */
export function restartDialog(activity: RestartActivity, opts: { install?: boolean; autoResume?: boolean } = {}): RestartDialog {
  const resumable = activity.resumable
  if (opts.autoResume && !activity.unknown && activity.tasks > 0 && resumable !== undefined && resumable > 0) {
    const all = resumable >= activity.tasks
    const vars = { tasks: activity.tasks, processes: activity.processes, resumable }
    const detail = all
      ? (opts.install ? 'main.restart.resumeUpdateDetail' : 'main.restart.resumeRelaunchDetail')
      : (opts.install ? 'main.restart.resumeSomeUpdateDetail' : 'main.restart.resumeSomeRelaunchDetail')
    return {
      type: 'warning', title: mt('main.restart.title'),
      message: mt(opts.install ? 'main.restart.resumeUpdate' : 'main.restart.resumeRelaunch'),
      detail: mt(detail, vars),
      buttons: [mt('main.restart.resumeLater'), mt(opts.install ? 'main.restart.resumeUpdateNow' : 'main.restart.resumeRelaunchNow')],
      defaultId: 1, cancelId: 0, noLink: true,
    }
  }
  return {
    type: 'warning', title: mt('main.restart.title'),
    message: mt(activity.unknown ? 'main.restart.unknown' : 'main.restart.busy'),
    detail: activity.unknown ? mt('main.restart.unknownDetail') : mt('main.restart.detail', { tasks: activity.tasks, processes: activity.processes }),
    buttons: [mt('main.restart.later'), mt('main.restart.force')], defaultId: 0, cancelId: 0, noLink: true,
  }
}

/** Read the engine-wide inventory, including queued runs and delegated work outside the current window. */
export async function readRestartActivity(url: string, token: string, fetchFn: typeof fetch = fetch): Promise<RestartActivity> {
  const res = await fetchFn(`${url.replace(/\/$/, '')}/agent/remote/restart-status`, {
    headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(5000),
  })
  if (!res.ok) throw new Error(`restart status: HTTP ${res.status}`)
  const data = await res.json() as RestartActivity
  if (![data.tasks, data.processes].every((n) => Number.isSafeInteger(n) && n >= 0)) throw new Error('Invalid restart status')
  // resumable 是新字段:旧引擎没有;不是 0..tasks 的整数也当没有(弹窗按原来的),不因它判整个状态无效
  const r = data.resumable
  const resumable = typeof r === 'number' && Number.isSafeInteger(r) && r >= 0 && r <= data.tasks ? r : undefined
  return { tasks: data.tasks, processes: data.processes, ...(resumable !== undefined ? { resumable } : {}) }
}

/** All restart entry points share one inspection / confirmation / shutdown operation. */
export function createRestartGuard(deps: {
  inspect(): Promise<RestartActivity>
  confirm(options: RestartDialog): Promise<boolean>
  restart(install: boolean): Promise<void>
  /** 设置「重启后自动接着做未完成的任务」开着没有;不给 / 读不到 = 按关(原来的弹窗)。 */
  autoResume?(): Promise<boolean>
}) {
  let pending: Promise<{ ok: boolean }> | undefined
  return (install = false): Promise<{ ok: boolean }> => {
    if (pending) return pending
    pending = (async () => {
      const activity = await deps.inspect().catch(() => ({ tasks: 0, processes: 0, unknown: true }))
      if (activity.unknown || activity.tasks || activity.processes) {
        const autoResume = await (deps.autoResume?.() ?? Promise.resolve(false)).catch(() => false)
        if (!await deps.confirm(restartDialog(activity, { install, autoResume }))) return { ok: false }
      }
      await deps.restart(install)
      return { ok: true }
    })().finally(() => { pending = undefined })
    return pending
  }
}
