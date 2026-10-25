import { MessageCircle, MessageCircleQuestion, BookOpen, FolderOpen, Bot, Users, Terminal } from 'lucide-react'
import { addCommand, registerView, useWorkspace } from '@lcl/engine'
import { activeChatModelId, useApp } from '../stores/appStore'
import { TANGU_SLICE } from '../tangu/store/tanguSlice'
import { translate } from '../i18n'
import { ChatView } from '../views/ChatView'
import { ChatPreview } from '../views/chat2/ChatPreview'
import { ProcessLogView } from '../views/chat2/BackgroundProcs'
import { BtwHost, BtwPanel, BtwSideView } from '../views/chat2/BtwPanel'
import { btwSeedOf, btwWebVisible, openBtw, quoteInMainChat, useBtw } from '../views/chat2/btwStore'
import { FilesPanel, bumpDir } from '../views/chat2/FilesPanel'
import { ensureAppRefCommand } from '../views/chat2/appRefCommand'
import { MemoryPanelView, SubchatsView, SessionFilesView, TocView } from '../views/RightViews'
import { AgentsDetailSpecialView, WorkspaceDetailSpecialView, openSpecial } from '../views/SpecialViews'
import { AgentsSpaceView, AgentsRosterView, TanguDetailsView } from '../views/AgentProfileView'
import { hasNativeFeature, tanguProbeAvailable } from './runtime'
import { quoteInChatPanel } from '../views/chat2/chatPanelQuote'
import { SessionTabIcon } from '../components/SessionIcon'
import { setTanguChatOutline, setTanguChatViews, setTanguInboxTasks, setTanguNewChat, setTanguPrefs, setTanguShell, setTanguSidebarModes, type TanguHost } from '../amadeus/plugins/tanguSeam'
import { inboxTasks } from '../views/chat2/inboxTasks'
import { isChatAvatarsOn, setChatAvatarsOn } from '../views/chat2/chatAvatars'
import { isPromptSuggestOn, setPromptSuggest } from '../views/chat2/promptSuggest'
import { NewChatComposer, mountNewChatComposer, sendFromNewChat, startNewChatCall } from '../views/newChatComposer'
import { OrbitsView } from '../views/OrbitsView'
import { SessionsView } from '../views/SessionsView'
import '../tangu/messages' // Tangu 自己的文案片段(核心插件化 2c)
/** 对话的右栏组 = 今天 Tangu Space 的右栏那三个(spaces.tsx 的 TANGU_SIDE_VIEWS)。 */
const CHAT_RIGHT = [{ type: 'tangu-details', params: {} }, { type: 'workspace', params: { mode: 'files' } }, { type: 'outline', params: {} }]

const app = () => useApp.getState()
const ws = () => useWorkspace.getState()

const blankNewChat = (): void => {
  const s = app()
  s.setActiveId(null)
  s.setNewChatWs(null)
  s.setNewChatCfg(() => ({}))
  s.setNewChatModel(null)
  ws().openView('chat', { followActive: true, reuseKey: 'primary' }, 'main')
}

const splitChat = (): void => {
  const active = ws().getActiveLeaf()
  if (active?.type !== 'chat') { ws().splitActive('right'); return }
  const pinned = typeof active.params.sessionId === 'string' ? active.params.sessionId : app().activeId
  ws().splitActive('right', { followActive: false, sessionId: pinned, reuseKey: `session:${pinned || 'new'}` })
}

/** Tangu 唯一的入口(界面热更新 3b / 3c):store 半身、视图、给宿主的接缝、ctx.tangu 探针、命令都从这里进,宿主(installEngine)只调这一个。
 *  第 4 步打包版从界面包里取同一个函数;`host` 只装入口 import 不到的宿主私有件。
 *  **无条件调用、按段门控**:探针的门比 Tangu 宽 —— automation-only / 老档案没有 Tangu 界面,插件照样要 ctx.tangu
 *  (模型 / agent / startChat),只是没有对话那几块。排在布局恢复与插件宿主之前:视图要先进注册表,
 *  ctx.tangu 的有无在建 plugin context 那一刻定。 */
export function activateTangu(host: TanguHost): void {
  // store 半身先装(不看档案:宿主的连接 / 换号流程也读写会话字段,automation-only 档案同样要)
  host.installSlice(TANGU_SLICE)
  // 宿主外壳用的界面件(旁聊、文件树、特殊视图;3d):以前是宿主静态 import 的,任何档案都有 —— 同样不看档案
  setTanguShell({
    BtwHost, BtwPanel, btwSeedOf, quoteInMainChat,
    btwPageVisible: (activeId) => btwWebVisible(useBtw.getState().webOpen, activeId),
    closeBtwPage: () => useBtw.getState().closeWeb(),
    subscribeBtw: (cb) => useBtw.subscribe(cb),
    FilesPanel, bumpDir, openSpecial,
  })
  registerTanguViews()
  if (tanguProbeAvailable()) {
    // 编辑器「问 Tangu」只在注册了 chat-panel 的宿主上给(与 registerTanguViews 同一个谓词)
    host.installProbe(hasNativeFeature('tangu') ? { askInChat: quoteInChatPanel } : {})
  }
  registerTanguCommands()
}

/** Tangu 的命令(核心插件化 2e-4,原在 bootstrapEngine)。命令面板 / 快捷键表里这几条挨在一起。 */
export function registerTanguCommands(): void {
  // 应用 / 窗口引用的快捷键(双 ⌘):开机就注册,别等第一张输入卡 —— 停在没有输入卡的 Space 上启动时全局那条订阅会一直没人要。
  // 写进笔记那条路不要对话,所以照旧不随 tangu 门控(没装 Tangu 时它还该不该在,第 3 步定)。
  ensureAppRefCommand()
  if (!hasNativeFeature('tangu')) return
  addCommand({ id: 'new-chat', title: () => app().tr('sidebar.newChat'), keywords: 'new chat 新对话', hotkey: 'mod+n', run: blankNewChat , invoke: {
    description: 'Start a new, empty chat in the window the user is talking to you from. Use it when the user asks to start over or open a fresh conversation.',
  } })
  // 旁聊(/btw;⌘; 同 Claude Desktop):带当前会话上下文问一句题外话,开在会话级 Floating Panel 里。
  // 新对话草稿(activeId=null)没有上下文可带 → 不开。不给 invoke:这是用户自己的旁路,不是 agent 能替用户点的动作。
  addCommand({ id: 'chat-btw', title: () => translate('btw.cmd'), keywords: 'btw by the way side question aside 顺便问 旁聊', hotkey: 'mod+;', run: () => {
    const s = app()
    if (!s.activeId) return
    const activeSession = s.sessions.find((x) => x.id === s.activeId) || s.archivedSessions.find((x) => x.id === s.activeId) || null
    openBtw({ sessionId: s.activeId, title: activeSession?.title, modelId: activeChatModelId({ ...s, activeSession }) || undefined })
  } })
  addCommand({ id: 'split-right', title: () => app().tr('command.splitRight'), keywords: 'split 分屏', hotkey: 'mod+\\', run: splitChat })
  addCommand({
    id: 'show-chat-panel',
    icon: MessageCircle,
    title: () => translate('tangu.cmd.showChatPanel'),
    keywords: 'chat panel side conversation 侧栏 对话 面板',
    run: () => ws().showSideView('right', 'chat-panel'),
  })
  addCommand({ id: 'stop-run', title: () => app().tr('command.stop'), keywords: 'stop 停止', run: async () => { await app().stop() } })
  addCommand({ id: 'compact', title: () => app().tr('command.compact'), keywords: 'compact 压缩', run: () => void app().compact() })
  addCommand({ id: 'branch', title: () => app().tr('command.branch'), keywords: 'branch 分支', run: () => void app().branchFromMessage() })
}

/** Activate only the Tangu package's native view contributions. */
export function registerTanguViews(): void {
  if (!hasNativeFeature('tangu')) return
  // 给宿主的接缝(核心插件化 2e):收件箱里的任务卡由 Tangu 画,宿主只管放;设置页的两个聊天开关读写走 Tangu;
  // 主页的新对话输入区(和 ctx.tangu.mountComposer)是 Tangu 交出的同一份;工作区侧栏的轨道 / 会话列表两种模式也由 Tangu 交出。
  setTanguInboxTasks(inboxTasks)
  setTanguPrefs({ chatAvatars: { get: isChatAvatarsOn, set: setChatAvatarsOn }, promptSuggest: { get: isPromptSuggestOn, set: setPromptSuggest } })
  setTanguNewChat({ Composer: NewChatComposer, send: sendFromNewChat, startCall: startNewChatCall, mount: mountNewChatComposer, blank: blankNewChat })
  setTanguSidebarModes({ Orbits: OrbitsView, Sessions: SessionsView })
  setTanguChatOutline(TocView) // 「大纲」视图在主区是对话时画会话目录
  setTanguChatViews({ Chat: ChatView, Preview: ChatPreview }) // 宿主嵌固定会话处(图像工作室 / 插件聊天 / mini)与外观预览窗口
  // chat 可关闭(浏览器式):关掉主区最后一个 view → 显示「新建标签页」启动器(见 workspaceStore.closeLeaf)。
  // workspaceSource: 'orbits' = 自动档翻转的**声明位**(方案 §3.7-7):主区是 chat 时左栏自动落新版会话侧栏,
  // 不动 workspaceMode.ts 的硬规则;右栏恒 files 不受它管。
  // 右栏主视图规则(lcl rightRules.ts):对话做主区前台时右栏 = Tangu 详情 / 文件 / 大纲(大纲对对话是会话目录),不分 Space。
  registerView({ type: 'chat', kind: 'entity', rightCompanions: CHAT_RIGHT, idParam: 'sessionId', displayName: () => app().tr('workbench.chat'), icon: MessageCircle, TabIcon: SessionTabIcon, factory: (props) => <ChatView {...props} />, singleton: true, workspaceSource: 'orbits' })
  // 侧栏对话只是 ChatView 的另一个停靠身份:绕开 `chat` singleton 与主区实例冲突,但仍跟随同一
  // activeId / messagesBySession / runningBySession,不创建所谓「Side Chat」会话或第二套 runtime。
  registerView({ type: 'chat-panel', kind: 'aux', displayName: () => translate('tangu.view.chatPanel'), icon: MessageCircle, TabIcon: SessionTabIcon, factory: (props) => <ChatView {...props} />, singleton: true })
  // 旁聊的侧栏形态(划线「在侧栏提问」):带着主区当前会话的上下文问,不进主对话;浮窗版 /btw 照旧。
  registerView({ type: 'btw-panel', kind: 'aux', displayName: () => translate('btw.title'), icon: MessageCircleQuestion, factory: () => <BtwSideView />, singleton: true })
  registerView({ type: 'tangu-details', kind: 'aux', displayName: () => translate('agentProfile.title'), icon: Bot, factory: (props) => <TanguDetailsView {...props} />, singleton: true })
  // Bot 专属 Tangu 本体(tangu-details / agents-detail);Agent 名册与 Agents 页用 Users,与 Agents Space 的图标一致(评审 U-22)。
  registerView({ type: 'agents-roster', kind: 'aux', displayName: () => translate('agentProfile.roster'), icon: Users, factory: () => <AgentsRosterView />, singleton: true })
  registerView({ type: 'agent-profile', kind: 'page', displayName: () => translate('agentProfile.space'), icon: Users, factory: (props) => <AgentsSpaceView {...props} />, singleton: true })
  // 右栏视图(可关,可重开)
  registerView({ type: 'memory', kind: 'aux', displayName: () => app().tr('panel.tab.memory'), icon: BookOpen, factory: () => <MemoryPanelView />, singleton: true })
  registerView({ type: 'subchats', kind: 'aux', displayName: () => app().tr('panel.tab.subchats'), icon: MessageCircle, factory: () => <SubchatsView />, singleton: true })
  // 后台进程的输出(摘要栏「后台」卡点行 → Desk 里开;Desk 不收文件时开标签页)
  registerView({ type: 'process-log', kind: 'page', displayName: () => translate('bg.view'), icon: Terminal, factory: (props) => <ProcessLogView {...props} />, closable: true, singleton: false })
  registerView({ type: 'session-files', kind: 'aux', displayName: () => app().tr('panel.tab.workspace'), icon: FolderOpen, factory: () => <SessionFilesView />, singleton: true })
  // 主区特殊视图(按需从侧栏打开,不进默认布局)。旧 'wechat' 视图已退役:恢复布局时未注册类型被引擎自动剔除。
  registerView({ type: 'agents-detail', kind: 'page', displayName: () => app().tr('special.agents.title'), icon: Bot, factory: () => <AgentsDetailSpecialView />, singleton: true })
  registerView({ type: 'workspace-detail', kind: 'page', displayName: () => app().tr('app.workspace'), icon: FolderOpen, factory: () => <WorkspaceDetailSpecialView />, singleton: true })
}
