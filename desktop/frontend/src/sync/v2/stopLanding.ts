/**
 * 智库同步第 4 步 U4 ⑩「停止落盘（只留云端）」确认卡背后的逻辑(契约 step34 §4.3、实现期修订 E4-4/10/11/12/15/18;方案图第 2 页 ⑩)。
 * 没有 JSX、不出文案:状态一律回码,界面按码说。
 *
 * - 「先同步再停」= 一次 unbind({ syncFirst:true }):Extend 自己跑一轮、在同一处核代次和结果,跑完还有剩回 pending(什么都没停)。
 *   渲染层不自己先 run 再 unbind(两次调用之间有竞态)。
 * - pending ≠ local_pending:前者什么都没停;后者绑定已停用、意图留着,下次启动接着做完(终态提示,不给重试)。
 * - 成功只回 root。交根(当前库先换走)、forget、挪钉子不在这里(第 3 批 / H 的加固 PR)。
 */
import type { VsResult } from './client'
import type { BindingView, UnbindOk, VaultSyncStatus } from './types'

type StatusBinding = VaultSyncStatus['bindings'][number]

export type StopPreflight =
  /** 能停。leftover:这台还有没传上去的(改动 + 待确认的删除 + 出错的文件)/ 等你定的;unknown = 有数读不出(held < 0 之类),当有 */
  | { eligible: true; unsynced: number; held: number; unknown: boolean; recommendSyncFirst: boolean }
  /** 现在不能停:接手中 / 正在换去处 */
  | { eligible: false; reason: 'takeover_in_progress' | 'move_in_progress' }

const count = (n: unknown): number | null => (typeof n === 'number' && Number.isFinite(n) && n >= 0 ? n : null)

/** 开确认卡之前判:要不要多那一行「这台还有 N 个改动没传上去 / M 篇等你定」、主按钮换不换成「先同步再停」。 */
export function stopPreflight(b: Pick<StatusBinding, 'state' | 'status'> & Partial<Pick<BindingView, 'firstRound'>>): StopPreflight {
  if (b.state === 'takeover' || b.firstRound === 'takeover') return { eligible: false, reason: 'takeover_in_progress' }
  if (b.status?.reason === 'move_in_progress') return { eligible: false, reason: 'move_in_progress' }
  const st = b.status
  const pending = count(st?.pendingChanges), deletes = count(st?.deletesPending), failures = count(st?.failures), held = count(st?.held)
  const unknown = pending === null || deletes === null || failures === null || held === null
  const unsynced = (pending ?? 0) + (deletes ?? 0) + (failures ?? 0)
  return { eligible: true, unsynced, held: held ?? 0, unknown, recommendSyncFirst: unknown || unsynced > 0 || (held ?? 0) > 0 }
}

export type StopPhase = 'syncing' | 'stopping'

export type StopRun =
  /** 停了:文件夹 root 原样留在这台 */
  | { kind: 'stopped'; root: string }
  /** 「先同步再停」跑完还有剩:什么都没停;界面给「先不停」/「看是哪几篇」/(再点一次)「直接停」 */
  | { kind: 'pending'; pending: number; held: number; failures: number }
  /** 回了 pending 但三个数都是 0(代次变了 / 读不出 / 那一轮没跑完):确认不了干净,什么都没停,不当「没剩」 */
  | { kind: 'unconfirmed' }
  /** 同步已经停了、只差收尾(本机删除的暂存没结清),下次启动接着做完。终态提示,不重试 */
  | { kind: 'local_pending' }
  /** 「先同步再停」时引擎没在跑:跑不了那一轮;出口 = 直接停 */
  | { kind: 'not_running' }
  /** 这个库已经不在同步了 */
  | { kind: 'gone' }
  /** 接手中 / 正在换去处:做完才能停 */
  | { kind: 'busy'; code: 'takeover_in_progress' | 'move_in_progress' | 'unbinding_in_progress' }
  /** 别的失败(外层的 state_unreadable / compat_mode / channel_missing / extend_unavailable / 其他):code 原样 */
  | { kind: 'failed'; code: string }

const codeOf = (err: string): string => /([a-z][a-z0-9_-]+)\s*$/.exec(err)?.[1] ?? err

export function classifyUnbind(r: VsResult<UnbindOk>): StopRun {
  if (r.ok) return r.value && typeof r.value.root === 'string' && r.value.root ? { kind: 'stopped', root: r.value.root } : { kind: 'failed', code: 'invalid_reply' }
  const code = codeOf(r.error)
  if (code === 'pending') {
    const p = r.detail?.pending ?? 0, h = r.detail?.held ?? 0, f = r.detail?.failures ?? 0
    return p || h || f ? { kind: 'pending', pending: p, held: h, failures: f } : { kind: 'unconfirmed' }
  }
  if (code === 'local_pending') return { kind: 'local_pending' }
  if (code === 'binding_not_running') return { kind: 'not_running' }
  if (code === 'binding_not_found') return { kind: 'gone' }
  if (code === 'takeover_in_progress' || code === 'move_in_progress' || code === 'unbinding_in_progress') return { kind: 'busy', code }
  return { kind: 'failed', code }
}

/** 点了「停止落盘」/「直接停」(syncFirst:false)或「先同步再停」(syncFirst:true)。onPhase 只报一次:跑那一轮期间是 syncing,否则 stopping。 */
export async function runStopLanding(deps: { unbind(bindingId: string, syncFirst?: boolean): Promise<VsResult<UnbindOk>> }, o: { bindingId: string; syncFirst: boolean; onPhase?: (p: StopPhase) => void }): Promise<StopRun> {
  o.onPhase?.(o.syncFirst ? 'syncing' : 'stopping')
  return classifyUnbind(await deps.unbind(o.bindingId, o.syncFirst))
}
