// 打开会话 / 新对话的统一门面(会话列表 / ⌘K 快切 / 新标签页的最近使用等都走这里)——
// 语义与 Amadeus 的 openNote 逐字对齐:已有钉住该会话的标签 → 激活它;⌘/Ctrl 点击(newTab)→ 新开一个钉住它的标签;
// 否则落进「当前聚焦的主 leaf」(含你刚点 ＋ 开出来的空白标签)。决策见 planSessionOpen。
//
// ⚠️ 会话开进**别的** leaf 时,必须先把主区那个「跟随档」聊天就地冻结成它此刻显示的会话 ——
//    否则 activeId 一变就把它一起拖走,用户明明在新标签里开东西,老标签的内容却被换掉
//    (2026-08-16 用户实报:「他们都会直接替换 A chatview」)。侧栏的聊天不冻:那份是 Space 配方里的
//    常驻陪伴视图(Coding/Amadeus 空间),冻了等于把用户的主力聊天锁死。
import { useApp } from './stores/appStore'
import { useWorkspace, activeMainPanel, useSpaceStore, setActiveSpace } from '@lcl/engine'
import { planNewChat, planSessionOpen, type ChatLeaf } from './sessionOpenPlan'
import { registerMessages, translate } from './i18n'

registerMessages({
  'orbits.rotate.queued': { zh: '已开新会话,正在后台总结上一段的记忆', en: 'New session started; summarizing the previous one in the background' },
  'orbits.rotate.skipped': { zh: '已开新会话(这次没有采集记忆:Historian 未启用或正忙)', en: 'New session started (memory was not collected this time: Historian is off or busy)' },
  'orbits.rotate.none': { zh: '已开新会话', en: 'New session started' },
})

interface PanelLike { id: string; params?: Record<string, unknown> }

const paramsOf = (p: PanelLike | null | undefined): Record<string, unknown> => (p?.params ?? {}) as Record<string, unknown>
const panelsOf = (): PanelLike[] => ((useWorkspace.getState() as unknown as { api?: { panels: PanelLike[] } }).api?.panels ?? [])

/** 主区那个「跟随 activeId」的聊天 leaf(没有则 null)。 */
function mainPrimaryChat(): PanelLike | null {
  return panelsOf().find((p) => {
    const q = paramsOf(p)
    return q.__type === 'chat' && q.__loc === 'main' && q.followActive !== false
  }) ?? null
}

/** 把主区跟随档聊天冻结成它此刻显示的那个会话(= 从此不再被 activeId 拖着走)。
 *  它本来就是空白新对话(没有会话可冻)→ 直接关掉:留着也是个永远空白、再也接不到新会话的死标签。 */
function freezeMainPrimary(prevSessionId: string | null, exceptLeafId?: string): void {
  const primary = mainPrimaryChat()
  if (!primary || primary.id === exceptLeafId) return
  const ws = useWorkspace.getState()
  if (prevSessionId) ws.leafById(primary.id)?.setParams({ sessionId: prevSessionId, followActive: false, reuseKey: undefined })
  else ws.leafById(primary.id)?.close()
}

export function openSession(id: string, opts?: { newTab?: boolean }): void {
  const ws = useWorkspace.getState()
  const leaves: ChatLeaf[] = panelsOf()
    .filter((p) => paramsOf(p).__type === 'chat')
    .map((p) => ({ id: p.id, sessionId: paramsOf(p).sessionId as string | undefined, followActive: paramsOf(p).followActive as boolean | undefined }))
  const focused = ws.api ? activeMainPanel(ws.api) : null
  const fp = paramsOf(focused as PanelLike | null)
  const plan = planSessionOpen(
    focused ? { type: fp.__type as string | undefined, followActive: fp.followActive as boolean | undefined } : null,
    { sessionId: id, leaves, newTab: opts?.newTab },
  )
  // 冻结要在 setActiveId 之前:此刻的 activeId 才是老标签正显示的那个会话。
  if (plan.act !== 'follow') freezeMainPrimary(useApp.getState().activeId, plan.act === 'activate' ? plan.leafId : undefined)
  useApp.getState().setActiveId(id) // 侧栏高亮 + 「跟随主聊天」据此切换会话
  switch (plan.act) {
    case 'activate':
      ws.activateLeaf(plan.leafId) // 已经开着 → 切过去,别在别的标签里再开一份
      return
    case 'newtab':
      // 钉住该会话(followActive:false),否则它会跟着侧栏高亮乱跑,等于两个标签永远显示同一个会话。
      ws.openView('chat', { sessionId: id, followActive: false }, 'main', { newTab: true })
      return
    case 'follow':
      return // 跟随主聊天已随 activeId 切到该会话,无需动 leaf
    case 'pin':
      // 就地把聚焦 leaf 固定成该会话的聊天;bootstrapEngine 的跟随订阅对固定 leaf 放行不回拽。
      ws.navigateLeaf(focused!.id, 'chat', { sessionId: id, followActive: false })
      return
    case 'fresh':
      ws.openView('chat', { followActive: true, reuseKey: 'primary' }, 'main')
      return
  }
}

/** 「新对话」的统一门面(侧栏入口 / 新标签页卡片都走这里)。
 *  站在**空白标签**(＋ 开出来的启动器 / Space 空白首页)里点新对话 → 就开在这个标签,老的主聊天
 *  原地冻结、内容留在它自己的标签里。站在别处(笔记/已有聊天)→ 照旧复用主聊天,与「新建笔记」复用
 *  已有编辑器同一口径。 */
export function openNewChat(): void {
  const app = useApp.getState()
  const ws = useWorkspace.getState()
  const focused = ws.api ? activeMainPanel(ws.api) : null
  const ftype = paramsOf(focused as PanelLike | null).__type
  const primary = mainPrimaryChat()
  const where = planNewChat(focused ? { type: ftype as string | undefined, id: focused.id } : null, primary?.id)
  const prevSession = app.activeId
  app.setActiveId(null); app.setNewChatWs(null); app.setNewChatCfg(() => ({})); app.setNewChatModel(null)
  if (where === 'here') {
    // 先让空白标签接任,再让老的退位 —— 反过来会有一瞬间主区没有聊天(布局保存可能拍到那一帧)。
    ws.navigateLeaf(focused!.id, 'chat', { followActive: true, reuseKey: 'primary' })
    freezeMainPrimary(prevSession, focused!.id)
    return
  }
  ws.openView('chat', { followActive: true, reuseKey: 'primary' }, 'main')
}

/** 私聊(Agent 轨道的单人形态)的统一入口 —— 侧栏私聊行 / 引擎行、Agent 选择器的「私聊」都只认这一扇门。
 *  `kind='agent'` 时 id = agent slug,`kind='engine'` 时 id = 外部引擎 id。
 *  P1 只钉签名:真正的「解析该 agent 最新未归档的 soloAgentSlug 会话,没有就经 rotate 端点新建」落在 P2,
 *  换实现时**不动调用点**(方案 §3.4 / §5)。 */
/** 主页 Space 没有聊天主区:从主页(选择条右键「私聊」等)进轨道会话要先切到 Tangu Space,否则会把主页 leaf 原地导航成聊天。 */
function leaveHomeSpace(): void {
  if (useSpaceStore.getState().activeSpaceId === 'home') setActiveSpace('tangu')
}

export function openSolo(kind: 'agent' | 'engine', id: string): void {
  void useApp.getState().ensureSoloSession(kind, id).then((s) => { if (s) { leaveHomeSpace(); openSession(s.id) } })
}

/** 私聊「新会话(先总结记忆)」:引擎侧归档旧会话 + 建新(Agent 私聊后台采记忆);旧会话还在跑 → store 已提示,这里不动。 */
export function rotateSolo(kind: 'agent' | 'engine', id: string): Promise<void> {
  return useApp.getState().rotateSoloSession(kind, id).then((r) => {
    if (!r) return
    leaveHomeSpace()
    openSession(r.session.id)
    useApp.getState().toast(translate(r.memory === 'queued' ? 'orbits.rotate.queued' : r.memory === 'skipped' ? 'orbits.rotate.skipped' : 'orbits.rotate.none'))
  })
}

/** 独立团队(Agent 轨道的持久团队)的统一入口:该团队最新未归档会话,没有就建;不内联展开(方案 §3.4)。 */
export function openTeam(slug: string, opts?: { newTab?: boolean }): void {
  void useApp.getState().ensureTeamSession(slug).then((s) => { if (s) { leaveHomeSpace(); openSession(s.id, opts) } })
}
