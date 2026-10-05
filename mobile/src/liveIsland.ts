/**
 * 安卓灵动岛(2026-09-18):agent 在跑时,把「在干什么 / 等你批准 / 跑完了」贴到各家的岛上。
 * 原生那半(Android 16 Live Updates + 保活前台服务)在 LiveIslandPlugin.java / LiveIslandService.java,
 * 此处只管:从 store 派生岛的内容(liveIslandDerive.ts)→ 变了才发原生;点岛 → 插件的 openSession 事件 → 打开会话。
 *
 * 收尾口径对齐桌面的 run 结束提醒(notificationWiring):正看着这个会话就悄悄撤掉,不在看才留一条「已完成」。
 * ponytail: 岛只有一个位置 —— 多个会话并发时,先跑完的那个不单独报完成,等全部跑完才报最后显示的那个;
 *   真要逐个报,给每个会话一条独立的完成通知(另开 id)即可。
 *
 * 系统通知(2026-10-05)也从这里出,两件事:
 *  - 岛上显示的是待批审批时,通知带「拒绝 / 允许」;点了 → 插件的 answer 事件 → 与审批卡同一个 decideApproval。
 *    放哪个按钮、点下去认不认,都由 liveIslandDerive.shadeAsk 一处判。
 *  - 应用内通知(收件箱 / 同步 / 提醒…)在 App 退到后台时跟发一条系统通知:`window.tangu.notify`,同桌面那座桥。
 * 都只在进程活着时有:刚退后台的那一阵,或有 agent 在跑(前台服务保活)。进程被系统收走之后的推送要服务器来发,不在这里。
 */
import { Capacitor, registerPlugin, type PluginListenerHandle } from '@capacitor/core'
import { useWorkspace } from '@lcl/engine'
import { useApp } from '@/stores/appStore'
import { registerMessages, translate } from '@/i18n'
import { openSession } from '@/sessionNav'
import { fmtElapsed } from '@/views/chat2/RunStatsLine'
import { deriveIsland, lastAssistant, shadeAnswer, type IslandState } from './liveIslandDerive'

/** 通知按钮送回来的一次作答(原生从按钮的意图里原样取出,全是不可信的串)。 */
type ShadeAnswer = Partial<Record<'sessionId' | 'messageId' | 'approvalId' | 'action', string>>
interface LiveIslandPlugin {
  show(o: IslandState & { channelName: string; sub?: string; done?: boolean; quiet?: boolean; allowLabel?: string; denyLabel?: string }): Promise<void>
  /** 一条普通系统通知;App 在前台时原生不贴。同一个 tag 只留最新一条。 */
  notice(o: { title: string; text: string; tag: string; channelName: string }): Promise<void>
  reset(): Promise<void>
  addListener(event: 'openSession', fn: (e: { id: string }) => void): Promise<PluginListenerHandle>
  addListener(event: 'answer', fn: (e: ShadeAnswer) => void): Promise<PluginListenerHandle>
}
const Native = registerPlugin<LiveIslandPlugin>('LiveIsland')

registerMessages({
  'island.channel': { zh: 'Agent 运行状态', en: 'Agent activity' },
  'island.untitled': { zh: '新会话', en: 'New chat' },
  'island.thinking': { zh: '思考中…', en: 'Thinking…' },
  'island.writing': { zh: '正在回复…', en: 'Writing a reply…' },
  'island.tool': { zh: '正在执行 {tool}', en: 'Running {tool}' },
  'island.approval': { zh: '等你批准：{tool}', en: 'Needs your approval: {tool}' },
  'island.inquiry': { zh: '有个问题等你回答', en: 'Waiting for your answer' },
  'island.chipApproval': { zh: '待审批', en: 'Approve' },
  'island.chipInquiry': { zh: '待回答', en: 'Reply' },
  'island.more': { zh: '另有 {n} 个在跑', en: '{n} more running' },
  'island.done': { zh: '已完成', en: 'Done' },
  'island.failed': { zh: '运行出错', en: 'Failed' },
  'island.stopped': { zh: '已停止', en: 'Stopped' },
  'island.allow': { zh: '允许', en: 'Allow' },
  'island.deny': { zh: '拒绝', en: 'Deny' },
  'island.eventsChannel': { zh: '消息与提醒', en: 'Messages and reminders' },
})

/** runId → 首次看到的时刻。runStats 有真起点就用它(重挂的在飞 run 只能从看到那一刻算)。 */
const firstSeen = new Map<string, number>()
function since(sessionId: string): number {
  const s = useApp.getState()
  const runId = s.runningBySession[sessionId]
  const rs = s.runStatsBySession[sessionId]
  if (rs?.runId === runId) return Math.round(rs.startedAt)
  if (!firstSeen.has(runId)) firstSeen.set(runId, Date.now())
  return firstSeen.get(runId)!
}

let sent = ''
let shown: IslandState | null = null
let timer: number | null = null
let lastFlush = 0

function flush(): void {
  timer = null
  lastFlush = Date.now()
  const s = useApp.getState()
  const next = deriveIsland(s.runningBySession, s.messagesBySession, s.sessions, since, translate)
  const key = JSON.stringify(next)
  if (key === sent) return
  sent = key
  const channelName = translate('island.channel')
  if (next) {
    shown = next
    const sub = next.more ? translate('island.more', { n: next.more }) : undefined
    void Native.show({ ...next, channelName, sub, allowLabel: translate('island.allow'), denyLabel: translate('island.deny') }).catch(() => { /* 老系统 / 权限受限:静默 */ })
    return
  }
  const prev = shown
  shown = null
  firstSeen.clear()
  if (!prev) return
  const status = lastAssistant(s.messagesBySession[prev.sessionId])?.status
  const quiet = document.visibilityState === 'visible' && s.activeId === prev.sessionId
  // 用时与会话里末条回复下面那行同源(run 结束时冻结的 runStats);对不上岛上那轮 run 就不写,不拿「从看到那一刻起」冒充。
  const rs = s.runStatsBySession[prev.sessionId]
  const took = rs?.finishedAt && Math.round(rs.startedAt) === prev.since ? ` · ${fmtElapsed(rs.finishedAt - rs.startedAt)}` : ''
  const text = translate(status === 'error' ? 'island.failed' : status === 'stopped' ? 'island.stopped' : 'island.done') + took
  const { ask: _ask, ...last } = prev
  void Native.show({ ...last, text, chip: '', more: 0, channelName, done: true, quiet }).catch(() => { /* ignore */ })
}

/** 已经从通知上答过的审批:连点两下只发一次(第二发必然 410,还会把刚批的那张标成「已过期」)。 */
const answered = new Set<string>()

/** 通知上点了「允许 / 拒绝」:认不认由 shadeAnswer 照此刻的 store 判,认了就走审批卡那同一个 decideApproval。 */
function answer(e: ShadeAnswer): void {
  const s = useApp.getState()
  const sessionId = String(e.sessionId ?? '')
  const hit = shadeAnswer(e, s.messagesBySession[sessionId])
  if (!hit || answered.has(hit.approvalId)) return
  answered.add(hit.approvalId)
  const retry = (): void => { answered.delete(hit.approvalId) } // 没发出去(断网 / 引擎拒了):岛还停在「等你批准」,让下一次点击重发
  void s.decideApproval(hit.messageId, hit.approvalId, hit.action, undefined, sessionId).then((ok) => { if (!ok) retry() }, retry)
}

/** 节流:原生每秒至多一发(系统对通知更新限速,超了静默丢 —— 丢的若是最后一发,岛就停在旧状态)。 */
function schedule(): void {
  if (timer !== null) return
  timer = window.setTimeout(flush, Math.max(0, 1000 - (Date.now() - lastFlush)))
}

/** 等单列壳把上次的布局还原完再开会话:早开的话,壳见主区已有 leaf 就跳过还原,用户上次的标签全丢。 */
export function whenShellReady(fn: () => void): void {
  if (useWorkspace.getState().mainTabs.length) { fn(); return }
  const off = useWorkspace.subscribe((s) => { if (s.mainTabs.length) { off(); fn() } })
}

let installed = false
export function installLiveIsland(): void {
  if (installed || !Capacitor.isNativePlatform()) return
  installed = true
  // 本 JS 上下文还没贴过任何岛:清掉上一程留下的常驻岛(进程死后残留 / 重载前的前台服务),仍在跑的 run 会重新贴回。
  void Native.reset().catch(() => { /* ignore */ })
  useApp.subscribe((s, p) => {
    if (s.runningBySession === p.runningBySession && s.messagesBySession === p.messagesBySession && s.sessions === p.sessions) return
    if (shown || Object.keys(s.runningBySession).length) schedule()
  })
  void Native.addListener('openSession', ({ id }) => whenShellReady(() => openSession(id)))
  void Native.addListener('answer', answer)
  // 应用内通知的系统通知出口(notificationStore 在页面失焦时调,同桌面的 window.tangu.notify)。
  // 「跑完了」不走这里:手机上由岛报(常驻那条撤掉、换成一条「已完成 · 用时」,正看着的会话在后台跑完也报),再发一条就是重复。
  const host = window.tangu
  if (host) {
    host.notify = async (title, body, meta) => {
      if (meta?.event === 'agent.done') return
      await Native.notice({ title, text: body, tag: meta?.event || 'app', channelName: translate('island.eventsChannel') }).catch(() => { /* 老系统 / 权限受限:静默 */ })
    }
  }
}
