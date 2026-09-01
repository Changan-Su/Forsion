/** 内置通知事件接线(仅主窗 Root 装一次):把现有系统事件流翻成右上角通知。
 *  - 云同步(镜像/按条目引擎):进 error/auth-required 弹 error(按引擎 dedupe);syncing→idle 弹完成(事件默认关)
 *  - remotesync:一轮结束按报告弹完成/失败/冲突
 *  - agent 会话:runningBySession 键消失 = run 结束;当前正看的会话不打扰,后台会话才提醒
 *  - 笔记正文 `@remind:2026-09-01T09:00`:到点弹一条,点「查看」跳回那篇笔记
 *  收件箱新消息在 inboxStore 轮询处就地接线(检测逻辑在那边)。文案走 appStore.tr(bootstrap 注入)。 */
import { useApp } from './appStore'
import { notifyApp } from './notificationStore'
import { useMdMarkStore } from '../amadeus/store/mdMarkStore'
import { usePageStore } from '../amadeus/store/pageStore'
import { openNoteAtHeading } from '../amadeusNav'
import { toLocalDate } from '../views/calendar/dateUtils'
import type { MdMark } from '@amadeus-shared/mdMarks'
import type { AmadeusSyncStatus } from '../types'

/** 已弹过的提醒(localStorage:key → 弹出时刻)。key **不含行号** —— 行号会随编辑上下漂,
 *  用「路径 + 提醒时刻 + 文本」才认得出是同一条。7 天前的条目每次启动顺手清掉。 */
const FIRED_KEY = 'forsion.noteRemind.fired'
const WEEK = 7 * 24 * 3600_000
/** 迟到多久就不补弹了:关着应用错过的提醒开机补一条有用,补一周前的只是噪音。 */
const CATCHUP = 24 * 3600_000

function readFired(): Record<string, number> {
  try {
    const raw = JSON.parse(localStorage.getItem(FIRED_KEY) || '{}') as Record<string, number>
    const now = Date.now()
    return Object.fromEntries(Object.entries(raw).filter(([, t]) => now - t < WEEK))
  } catch { return {} }
}

/** 一条提醒的去重键。
 *  **不含行号** —— 行号随编辑上下漂,同一条提醒会被当成新的重复弹。
 *  **含 vault** —— `m.path` 是库内相对路径,两个库里常见的同名模板(`Daily.md`)如果时刻与文本也一样,
 *  第一个库弹过就会把第二个库的静默压掉(Codex 评审)。 */
export const remindKey = (vault: string, m: Pick<MdMark, 'path' | 'remind' | 'text'>): string =>
  `${vault}|${m.path}|${m.remind}|${m.text}`

/** 此刻该弹哪些提醒:到点了、还没迟到太久、且没弹过。纯函数,单测在 notificationWiring.test.ts。 */
export function pendingReminders(marks: MdMark[], now: number, fired: Record<string, number>, vault: string): MdMark[] {
  return marks.filter((m) => {
    if (!m.remind) return false
    const at = toLocalDate(m.remind.split('/')[0]).getTime()
    return at <= now && now - at < CATCHUP && !fired[remindKey(vault, m)]
  })
}

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
      notifyApp({ event: 'sync.doneOnline', level: 'success', text: tr('ntf.syncDone'), dedupeKey: 'sync.done' })
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

  // E. 笔记正文的 `@remind:` 到点提醒。
  // ponytail: 60s 轮询 + 每轮重拉全库标记(主进程索引已在内存里,只是遍历字符串)。天花板 =
  // **只在应用开着时会响**,没有主进程调度器;真要后台/关机也响,那是另一轮(系统级日程注册)。
  let fired = readFired()
  /** 判一次当前这批标记。⚠️ 必须同时挂在 store 订阅上:装配发生在 Root 挂载,那一刻 vault 往往还没开,
   *  首跑 load() 拿回空数组 —— 只靠 60s 轮询的话,启动时就该响的那条要等一整轮。 */
  const sweep = (): void => {
    const now = Date.now()
    const vault = usePageStore.getState().vaultRoot ?? ''
    for (const m of pendingReminders(useMdMarkStore.getState().marks, now, fired, vault)) {
      fired = { ...fired, [remindKey(vault, m)]: now }
      try { localStorage.setItem(FIRED_KEY, JSON.stringify(fired)) } catch { /* 满了就当没记,顶多重复弹一次 */ }
      notifyApp({
        event: 'note.reminder', level: 'info', sticky: true,
        title: tr('ntf.noteReminder', { src: m.title }),
        text: m.text,
        action: { label: tr('ntf.view'), run: () => { void openNoteAtHeading(m.path, m.heading) } },
      })
    }
  }
  const tick = async (): Promise<void> => {
    await useMdMarkStore.getState().load()
    sweep()
  }
  useMdMarkStore.subscribe(sweep) // 别处(待办视图/换页/structureChange)拉回新标记时立刻判一次
  void tick()
  setInterval(() => { void tick() }, 60_000)
}
