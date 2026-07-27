/** 内置通知事件接线(仅主窗 Root 装一次):把现有系统事件流翻成右上角通知。
 *  - 云同步(镜像/按条目引擎):进 error/auth-required 弹 error(按引擎 dedupe);syncing→idle 弹完成(事件默认关)
 *  - remotesync:一轮结束按报告弹完成/失败/冲突
 *  - agent 会话:runningBySession 键消失 = run 结束;当前正看的会话不打扰,后台会话才提醒
 *  收件箱新消息在 inboxStore 轮询处就地接线(检测逻辑在那边)。文案走 appStore.tr(bootstrap 注入)。 */
import { useApp } from './appStore'
import { notifyApp } from './notificationStore'
import type { AmadeusSyncStatus } from '../types'

const tr = (k: string, vars?: Record<string, string | number>): string => useApp.getState().tr(k, vars)

let installed = false
export function installNotificationWiring(): void {
  if (installed) return
  installed = true

  // A. Amadeus 云同步(镜像引擎无 binding;按条目引擎带 binding=vault 根)。状态机转移才弹,持平不弹。
  const prevSyncState: Record<string, string> = {}
  window.amadeusSync?.onStatus?.((raw) => {
    const s = raw as AmadeusSyncStatus
    const key = s.binding ? `entry:${s.binding}` : `mirror:${s.side ?? 'own'}`
    const prev = prevSyncState[key]
    prevSyncState[key] = s.state
    if (!s.enabled || prev === s.state) return
    if (s.state === 'error' || s.state === 'auth-required') {
      notifyApp({
        event: 'sync.error', level: 'error',
        text: tr('ntf.syncError', { e: s.error || s.state }),
        dedupeKey: `sync.error:${key}`,
      })
    } else if (prev === 'syncing' && s.state === 'idle') {
      notifyApp({ event: 'sync.done', level: 'success', text: tr('ntf.syncDone'), dedupeKey: 'sync.done' })
    }
  })

  // B. remotesync:running true→false 收一份报告。
  let remoteWas = false
  window.remoteSync?.onStatus?.((s) => {
    if (remoteWas && !s.running && s.lastReport) {
      const r = s.lastReport
      if (!r.ok || r.errors?.length) {
        notifyApp({
          event: 'sync.error', level: 'error',
          text: tr('ntf.remoteSyncFail', { e: r.errors?.[0] || '' }),
          dedupeKey: 'remotesync.error',
        })
      } else {
        if (r.conflicts > 0) {
          notifyApp({
            event: 'sync.error', level: 'warning',
            text: tr('ntf.remoteSyncConflicts', { n: r.conflicts }),
            dedupeKey: 'remotesync.conflict',
          })
        }
        // 删除闸挂起:定时轮触发时用户不在设置页,不提醒的话删除永远悬着
        if (r.pendingDeletions > 0) {
          notifyApp({
            event: 'sync.error', level: 'warning',
            text: tr('ntf.remoteSyncPendingDel', { n: r.pendingDeletions }),
            dedupeKey: 'remotesync.pendingDel',
            action: { label: tr('ntf.actionReview'), run: () => useApp.getState().openSettings('sync') },
          })
        }
        const n = r.pushed + r.pulled + r.deletedLocal + r.deletedRemote
        if (n > 0) notifyApp({ event: 'sync.done', level: 'success', text: tr('ntf.remoteSyncDone', { n }), dedupeKey: 'remotesync.done' })
      }
    }
    remoteWas = s.running
  })

  // C. agent 会话结束(runningBySession 只增删单键,无整表重置——boot 后仅初始化一次)。
  // 结局从该会话末条助手消息读(endRun 前 patchMessage 已落):error → 失败红卡;
  // stopped = 用户亲手停的,不打扰;其余按完成。
  let prevRunning = useApp.getState().runningBySession
  useApp.subscribe((s) => {
    if (s.runningBySession === prevRunning) return
    const prev = prevRunning
    prevRunning = s.runningBySession
    for (const sid of Object.keys(prev)) {
      if (s.runningBySession[sid]) continue
      if (sid === s.activeId) continue // 正看着的会话,结果就在眼前
      const msgs = s.messagesBySession[sid] || []
      const last = [...msgs].reverse().find((m) => m.role === 'assistant')
      if (last?.status === 'stopped') continue
      const failed = last?.status === 'error'
      const sess = s.sessions.find((x) => x.id === sid) || s.archivedSessions.find((x) => x.id === sid)
      notifyApp({
        event: 'agent.done', level: failed ? 'error' : 'success',
        text: tr(failed ? 'ntf.agentFail' : 'ntf.agentDone', { name: sess?.title || 'Agent' }),
      })
    }
  })
}
