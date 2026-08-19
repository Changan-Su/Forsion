// 打开会话 / 新对话的统一门面(会话列表 / ⌘K 快切 / 新标签页的最近使用等都走这里)——
// 语义与 Amadeus 的 openNote 逐字对齐:已有钉住该会话的标签 → 激活它;⌘/Ctrl 点击(newTab)→ 新开一个钉住它的标签;
// 否则落进「当前聚焦的主 leaf」(含你刚点 ＋ 开出来的空白标签)。决策见 planSessionOpen。
//
// ⚠️ 会话开进**别的** leaf 时,必须先把主区那个「跟随档」聊天就地冻结成它此刻显示的会话 ——
//    否则 activeId 一变就把它一起拖走,用户明明在新标签里开东西,老标签的内容却被换掉
//    (2026-08-16 用户实报:「他们都会直接替换 A chatview」)。侧栏的聊天不冻:那份是 Space 配方里的
//    常驻陪伴视图(Coding/Amadeus 空间),冻了等于把用户的主力聊天锁死。
import { useApp } from './stores/appStore'
import { useWorkspace, activeMainPanel } from '@lcl/engine'
import { planNewChat, planSessionOpen, type ChatLeaf } from './sessionOpenPlan'

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
