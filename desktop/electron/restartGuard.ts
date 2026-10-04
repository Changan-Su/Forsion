import { defineMainMessages, mt } from './mainI18n'

defineMainMessages({
  'main.restart.title': { zh: '重启更新', en: 'Restart to update' },
  'main.restart.busy': { zh: '还有未完成的任务，要强制退出并重启吗？', en: 'Tasks are still active. Force quit and restart?' },
  'main.restart.detail': { zh: '有 {tasks} 个运行中或排队中的任务，以及 {processes} 个后台进程。强制重启会中断它们；选择稍后重启可继续当前工作。', en: '{tasks} tasks are running or queued, with {processes} background processes. A forced restart will interrupt them. Choose Restart later to keep working.' },
  'main.restart.unknown': { zh: '暂时无法确认任务状态，要强制退出并重启吗？', en: 'Task status could not be checked. Force quit and restart?' },
  'main.restart.unknownDetail': { zh: '引擎暂时没有响应，可能仍有任务在运行。可以稍后重试，或强制退出并重启。', en: 'The engine is not responding and tasks may still be running. Try again later, or force quit and restart.' },
  'main.restart.later': { zh: '稍后重启', en: 'Restart later' },
  'main.restart.force': { zh: '强制退出并更新', en: 'Force quit and update' },
})

export interface RestartActivity { tasks: number; processes: number; unknown?: boolean }
export interface RestartDialog {
  type: 'warning'; title: string; message: string; detail: string
  buttons: string[]; defaultId: number; cancelId: number; noLink: boolean
}
export function restartDialog(activity: RestartActivity): RestartDialog {
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
  return { tasks: data.tasks, processes: data.processes }
}

/** All restart entry points share one inspection / confirmation / shutdown operation. */
export function createRestartGuard(deps: {
  inspect(): Promise<RestartActivity>
  confirm(options: RestartDialog): Promise<boolean>
  restart(install: boolean): Promise<void>
}) {
  let pending: Promise<{ ok: boolean }> | undefined
  return (install = false): Promise<{ ok: boolean }> => {
    if (pending) return pending
    pending = (async () => {
      const activity = await deps.inspect().catch(() => ({ tasks: 0, processes: 0, unknown: true }))
      if ((activity.unknown || activity.tasks || activity.processes) && !await deps.confirm(restartDialog(activity))) return { ok: false }
      await deps.restart(install)
      return { ok: true }
    })().finally(() => { pending = undefined })
    return pending
  }
}
