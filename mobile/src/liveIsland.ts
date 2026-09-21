/**
 * 安卓灵动岛(2026-09-18):agent 在跑时,把「在干什么 / 等你批准 / 跑完了」贴到各家的岛上。
 * 原生那半(Android 16 Live Updates + 保活前台服务)在 LiveIslandPlugin.java / LiveIslandService.java,
 * 此处只管:从 store 派生岛的内容(liveIslandDerive.ts)→ 变了才发原生;点岛 → 插件的 openSession 事件 → 打开会话。
 *
 * 收尾口径对齐桌面的 run 结束提醒(notificationWiring):正看着这个会话就悄悄撤掉,不在看才留一条「已完成」。
 * ponytail: 岛只有一个位置 —— 多个会话并发时,先跑完的那个不单独报完成,等全部跑完才报最后显示的那个;
 *   真要逐个报,给每个会话一条独立的完成通知(另开 id)即可。
 */
import { Capacitor, registerPlugin, type PluginListenerHandle } from '@capacitor/core'
import { useWorkspace } from '@lcl/engine'
import { useApp } from '@/stores/appStore'
import { registerMessages, translate } from '@/i18n'
import { openSession } from '@/sessionNav'
import { deriveIsland, lastAssistant, type IslandState } from './liveIslandDerive'

interface LiveIslandPlugin {
  show(o: IslandState & { channelName: string; sub?: string; done?: boolean; quiet?: boolean }): Promise<void>
  reset(): Promise<void>
  addListener(event: 'openSession', fn: (e: { id: string }) => void): Promise<PluginListenerHandle>
}
const Native = registerPlugin<LiveIslandPlugin>('LiveIsland')

registerMessages({
  'island.channel': { zh: 'Agent 运行状态', en: 'Agent activity' },
  'island.untitled': { zh: '新会话', en: 'New chat' },
  'island.thinking': { zh: '思考中…', en: 'Thinking…' },
  'island.writing': { zh: '正在回复…', en: 'Writing a reply…' },
  'island.tool': { zh: '正在执行 {tool}', en: 'Running {tool}' },
  'island.approval': { zh: '等你批准:{tool}', en: 'Needs your approval: {tool}' },
  'island.inquiry': { zh: '有个问题等你回答', en: 'Waiting for your answer' },
  'island.chipApproval': { zh: '待审批', en: 'Approve' },
  'island.chipInquiry': { zh: '待回答', en: 'Reply' },
  'island.more': { zh: '另有 {n} 个在跑', en: '{n} more running' },
  'island.done': { zh: '已完成', en: 'Done' },
  'island.failed': { zh: '运行出错', en: 'Failed' },
  'island.stopped': { zh: '已停止', en: 'Stopped' },
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
    void Native.show({ ...next, channelName, sub }).catch(() => { /* 老系统 / 权限受限:静默 */ })
    return
  }
  const prev = shown
  shown = null
  firstSeen.clear()
  if (!prev) return
  const status = lastAssistant(s.messagesBySession[prev.sessionId])?.status
  const quiet = document.visibilityState === 'visible' && s.activeId === prev.sessionId
  const text = translate(status === 'error' ? 'island.failed' : status === 'stopped' ? 'island.stopped' : 'island.done')
  void Native.show({ ...prev, text, chip: '', more: 0, channelName, done: true, quiet }).catch(() => { /* ignore */ })
}

/** 节流:原生每秒至多一发(系统对通知更新限速,超了静默丢 —— 丢的若是最后一发,岛就停在旧状态)。 */
function schedule(): void {
  if (timer !== null) return
  timer = window.setTimeout(flush, Math.max(0, 1000 - (Date.now() - lastFlush)))
}

/** 等单列壳把上次的布局还原完再开会话:早开的话,壳见主区已有 leaf 就跳过还原,用户上次的标签全丢。 */
function whenShellReady(fn: () => void): void {
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
}
