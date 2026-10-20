/**
 * 新对话输入区 —— 主页那一整块,从 HomepageView 原样搬出(2026-10-18,主页插件化 S2):内置主页和插件
 * (`ctx.tangu.mountComposer`)挂的是同一份。2e-3 起归 Tangu,经 tanguSeam 的 setTanguNewChat 交给宿主(features/tangu.tsx)。DOM 一个类名都没改(`.hp-composer` / `data-kb-rise` /
 * `.newchat-pickers` / `.hp-projectbar`),主页的样式、手机键盘上抬、台架都还认它。
 * 建会话、切到 Tangu、发送、开通话一律由宿主做(sendFromNewChat / startNewChatCall),插件只决定放在哪。
 */
import { useEffect, useMemo } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { setActiveSpace, useSpaceStore, useWorkspace } from '@lcl/engine'
import { mountHostReact } from '@lcl/components'
import { useApp, newChatModelId, stickyDefaults, withAmadeusWorkspace, applyPreset, newSessionPreset, resolveNewSessionWorkspace } from '../stores/appStore'
import { settleModes } from '../stores/projectSettings'
import { currentPlatform } from '../services/agentRunService'
import { usePageStore } from '../amadeus/store/pageStore'
import { ProjectSelector } from '../components/ProjectSelector'
import { ExtraFolders } from '../components/ExtraFolders'
import { useTargetComposerPlaceholder } from '../components/TargetHealthNotice'
import { RunLocationPicker } from '../components/RunLocationPicker'
import { useRemoteNewChatWorkspaces } from '../stores/newChatWorkspaces'
import { AgentSelectStrip } from '../components/AgentSelectStrip'
import { HostLocaleProvider } from '../i18n'
import { Composer2 } from './chat2/Composer2'
import type { TanguComposerMount, TanguComposerOptions, TanguNewChatDispatch as NewChatDispatch } from '../amadeus/plugins/tanguSeam'

/**
 * 「新对话」输入区(主页那一整块:Agent 条、项目栏、运行位置、额外文件夹、Composer2)。主页只做「新对话」的宿主接线,输入 UI 和交互不复制:字面挂的就是 ChatView 里的 Composer2。
 * `sessionId={null}` 强制 slash / 引用菜单也按新对话语义跑,不误操作用户上次停留的会话。
 */
export function NewChatComposer({ onDispatch, onStartCall, onInputModeChange, liveSpaceId }: {
  onDispatch: NewChatDispatch
  onStartCall?: () => Promise<string | null>
  onInputModeChange: (focused: boolean) => void
  /** 通话按钮只在这个 Space 是当前 Space 时画(主页 = 'home';被当成标签开进别的 Space 时不当接收方)。不给 = 不画。 */
  liveSpaceId?: string
}) {
  const vaultRoot = usePageStore((state) => state.vaultRoot)
  const activeSpaceId = useSpaceStore((state) => state.activeSpaceId)
  // 运行位置在一台还没连上的电脑上:占位说「等那台连上」(同 ChatView),不退回本端的「先在设置里连接后端」
  const targetPlaceholder = useTargetComposerPlaceholder(null)
  const s = useApp(useShallow((state) => ({
    cfg: state.cfg,
    desktopConfig: state.desktopConfig,
    desktopMode: state.desktopMode,
    homeDir: state.homeDir,
    defaultWsDir: state.defaultWsDir,
    focusDirs: state.focusDirs, // 桌面:运行位置在别的电脑上时新会话的落点用那台的目录
    modelsResp: state.modelsResp,
    newChatWs: state.newChatWs,
    newChatCfg: state.newChatCfg,
    newChatModel: state.newChatModel,
    sessionMode: state.sessionMode,
    setSessionMode: state.setSessionMode,
    engines: state.engines,
    engineCaps: state.engineCaps,
    agentDefs: state.agentDefs,
    defaultAgentSlug: state.defaultAgentSlug,
    skillsList: state.skillsList,
    connState: state.connState,
    voiceOnByAgent: state.voiceOnByAgent,
    ensureEngineCaps: state.ensureEngineCaps,
    refreshVoiceMode: state.refreshVoiceMode,
    setSessionModel: state.setSessionModel,
    setNewChatCfg: state.setNewChatCfg,
    setSessionThinking: state.setSessionThinking,
    setDefaultModel: state.setDefaultModel,
    setModelContextWindow: state.setModelContextWindow,
    setVoiceMode: state.setVoiceMode,
    setExecConfig: state.setExecConfig,
    openSettings: state.openSettings,
    setNewChatWs: state.setNewChatWs,
    addLocalWorkspace: state.addLocalWorkspace,
    cloneGitProject: state.cloneGitProject,
    addCloudProject: state.addCloudProject,
    workspaces: state.workspaces,
    sessions: state.sessions,
    archivedSessions: state.archivedSessions,
    cloudProjects: state.cloudProjects,
    channelWorkspaces: state.channelWorkspaces,
    tr: state.tr,
  })))

  // Project pill 与 send() 共用真实落点解析：主页不能再继承一枚用户看不见的 newChatWs，
  // 也不能在 Chat 时无提示地把会话放进「不在项目中工作」。
  const platform = currentPlatform()
  const targetWorkspace = resolveNewSessionWorkspace(s, platform)
  const remoteWs = useRemoteNewChatWorkspaces() // 桌面:运行位置在别的电脑上 → 项目药丸列那台的项目
  const workspaceList = useMemo(() => s.workspaces(), [
    s.workspaces, s.sessions, s.archivedSessions, s.cloudProjects, s.channelWorkspaces,
    s.defaultWsDir, s.homeDir, s.tr, vaultRoot,
  ])
  const preset = newSessionPreset(s.sessionMode, targetWorkspace, platform)
  const cloud = preset === 'chat' || targetWorkspace.kind === 'cloud' || targetWorkspace.kind === 'rootless'
  // settleModes:与建会话同一口径结算 Ultra 与「团队模式下没有计划模式」,药丸显示什么首条消息就按什么跑
  const config = useMemo(() => settleModes(withAmadeusWorkspace(applyPreset({
    execMode: cloud ? 'sandbox' : 'host',
    ...stickyDefaults(s.desktopConfig, !cloud, preset),
    cwd: cloud ? undefined : (targetWorkspace.path || undefined),
    ...s.newChatCfg,
  }, preset), vaultRoot)), [cloud, preset, s.desktopConfig, s.newChatCfg, targetWorkspace.path, vaultRoot])
  const modelId = newChatModelId(s) || ''
  const visibleModels = !s.modelsResp?.models
    ? null
    : s.modelsResp.models.filter((m) => (m.modelType || 'llm') === 'llm' && (!cloud || m.source === 'forsion'))
  const agentSlug = config.agentSlug || s.defaultAgentSlug
  const voiceOn = agentSlug ? !!s.voiceOnByAgent[agentSlug] : false

  useEffect(() => { void s.ensureEngineCaps(config.engineId || undefined) }, [config.engineId, s.ensureEngineCaps])
  useEffect(() => { if (agentSlug) void s.refreshVoiceMode(agentSlug) }, [agentSlug, s.refreshVoiceMode])

  return (
    <div
      className="hp-composer"
      data-kb-rise // 手机上跟着键盘一起上去(mobile/src/keyboardRise.ts);别处没人读
      onClick={(e) => e.stopPropagation()}
      // 模型/模式/附件和它们的菜单都属于输入准备,共用一个聚焦范围。
      onPointerDownCapture={() => onInputModeChange(true)}
      onPointerDown={(event) => event.stopPropagation()}
      onFocusCapture={() => onInputModeChange(true)}
      onBlurCapture={(event) => {
        // 内部焦点转移不退场;选项卸载/点菜单空白导致的 relatedTarget=null 也保留。
        // 真正点击外部由主页的 onPointerDown 收尾,Tab 到外部控件则在这里退出。
        if (event.relatedTarget instanceof Node && !event.currentTarget.contains(event.relatedTarget)) onInputModeChange(false)
      }}
      onKeyDownCapture={(event) => {
        if (event.key === 'Escape' && (event.target as HTMLElement).matches?.('.t2c-ta')) {
          ;(event.target as HTMLTextAreaElement).blur()
          onInputModeChange(false)
        }
      }}
    >
      {/* 主页恒是新对话(sessionId=null):Agent 选择条落在项目栏之上(§11 拍板 ⑦ 的推荐档,接线为零)。 */}
      <div className="newchat-pickers">
        <AgentSelectStrip sessionId={null} cfg={config} />
      </div>
      <div className="hp-projectbar">
        <RunLocationPicker />
        <ProjectSelector
          workspaces={remoteWs ?? workspaceList}
          value={targetWorkspace.key}
          onChange={s.setNewChatWs}
          // 「添加本地项目 / 云端项目」加的都是这一端的:运行位置在别的电脑上时不给
          onAddProject={!remoteWs && window.tangu?.pickDirectory ? () => void s.addLocalWorkspace() : undefined}
          onCloneProject={!remoteWs && window.tangu?.pickDirectory ? () => void s.cloneGitProject() : undefined}
          onAddCloudProject={remoteWs ? undefined : (name) => void s.addCloudProject(name)}
        />
        <ExtraFolders />
      </div>
      <Composer2
        sessionId={null}
        // 通话按钮只画在指定的那个 Space 里(主页 = Home;主页被当成标签开进别的 Space 时不当接收方)
        liveOwner={!!liveSpaceId && activeSpaceId === liveSpaceId}
        prepareLiveSession={onStartCall}
        autoFocus={false}
        disabled={s.connState !== 'ok'}
        disabledPlaceholder={targetPlaceholder}
        running={false}
        execConfig={config}
        models={visibleModels}
        modelsResponse={s.modelsResp}
        modelId={modelId}
        onModelChange={(id) => s.setSessionModel(id, null)}
        engines={s.engines}
        engineId={config.engineId}
        engineModels={config.engineId ? (s.engineCaps[config.engineId]?.models ?? []) : undefined}
        engineModelId={config.engineModelId}
        onEngineModelChange={(id) => s.setNewChatCfg((c) => ({ ...c, engineModelId: id || undefined }))}
        engineCommands={config.engineId ? (s.engineCaps[config.engineId]?.commands ?? []) : undefined}
        thinkingLevel={config.thinkingLevel}
        ultra={config.ultra}
        onThinkingChange={(level, ultra) => s.setSessionThinking(level, null, undefined, ultra)}
        defaultModelIds={{
          backgroundModelId: s.desktopConfig?.backgroundModelId || '',
          imageModelId: s.cfg.imageModelId || '',
          visionModelId: s.cfg.visionModelId || '',
        }}
        onDefaultModelChange={s.setDefaultModel}
        onContextWindowChange={(id, n) => void s.setModelContextWindow(id, n)}
        maxIterations={config.maxIterations}
        onMaxIterationsChange={(n) => s.setNewChatCfg((c) => ({ ...c, maxIterations: n }))}
        verifyCommand={config.verifyCommand}
        onVerifyCommandChange={(cmd) => s.setNewChatCfg((c) => ({ ...c, verifyCommand: cmd || undefined }))}
        planMode={config.planMode}
        onPlanModeChange={(on) => s.setNewChatCfg((c) => ({ ...c, planMode: on }))}
        preset={config.preset}
        onPresetChange={(p) => s.setSessionMode(p)}
        voiceMode={voiceOn}
        onVoiceModeChange={agentSlug ? (on) => void s.setVoiceMode(agentSlug, on) : undefined}
        groupChat={config.groupChat}
        groupAgents={config.groupAgents}
        groupTempAgents={config.groupTempAgents}
        onGroupChange={(patch) => s.setNewChatCfg((c) => ({ ...c, ...patch }))}
        skills={s.skillsList}
        agents={s.agentDefs}
        currentAgentSlug={agentSlug} // 草稿没设思考档时药丸显示该 Agent 的缺省(与引擎同源)
        onOpenSettings={() => s.openSettings('skills')}
        onExecConfigChange={(patch) => s.setExecConfig(patch, null)}
        onSend={(text, attachments, workspaceFiles, skillIds, mentions) => onDispatch(text, attachments, workspaceFiles, skillIds, mentions)}
        onStop={() => {}}
        autoRefFromMain={false}
      />
    </div>
  )
}

const hasTangu = (): boolean => useSpaceStore.getState().spaces.some((s) => s.id === 'tangu')

/** 从「新对话」输入区发出第一句:先切 Space 再发,并显式传 `sessionId=null`:
 *  ① 不会把发起处的 leaf 就地换成 chat;② 不会把上次 activeId 当成续聊;
 *  ③ 不调 openNewChat,因此 Composer2 里刚选的模型/模式/工作区不会被它的「清新会话草稿」逻辑擦掉。
 *  没有 Tangu Space(单品档案)→ false,不发。 */
export function sendFromNewChat(...args: Parameters<NewChatDispatch>): Promise<boolean> {
  if (!hasTangu()) return Promise.resolve(false)
  setActiveSpace('tangu')
  // 老用户的 Tangu 命名布局可能把主 chat 关过;发话就是显式要去聊天,这里保证有一张聊天视图接住新会话。
  useWorkspace.getState().openView('chat', { followActive: true, reuseKey: 'primary' }, 'main')
  const [text, attachments, workspaceFiles, skillIds, mentions] = args
  return useApp.getState().send(text, attachments, workspaceFiles, skillIds, mentions, null)
}

/** 开通话 = 与发第一句同一条路:切到 Tangu、保证有主聊天视图,再建新会话;通话条随之出现在那边的输入框。
 *  resolve 新会话 id;没建成(newSession 自己吞掉失败,activeId 没换)→ null,别在旧会话里开通话。 */
export function startNewChatCall(): Promise<string | null> {
  if (!hasTangu()) return Promise.resolve(null)
  setActiveSpace('tangu')
  useWorkspace.getState().openView('chat', { followActive: true, reuseKey: 'primary' }, 'main')
  const before = useApp.getState().activeId
  return useApp.getState().newSession().then(() => { const id = useApp.getState().activeId; return id && id !== before ? id : null }, () => null)
}

/** beforeSend 最多等这么久(它是放退场动效用的,不是确认框):动画卡住 / 插件写错,用户按下的那一下照样发出去。 */
export const BEFORE_SEND_MAX_MS = 2000

/** 插件挂载的发送闸:发送和开通话**共用**一把锁,同一时刻只放一次(连点第二下、发送没走完又点通话 = 没动)。
 *  先等插件的 beforeSend(放退场动效),它明确回 false 才不发;它抛错、超过 BEFORE_SEND_MAX_MS、或这次挂载被卸掉(插件停用 / 视图关掉,
 *  动画的 transitionend 永远等不到)—— 照样发:用户按下的那一下不能因为装饰动画丢掉(Codex 评审)。 */
export function sendGate(beforeSend: TanguComposerOptions['beforeSend'], released: Promise<unknown>) {
  let busy = false
  return function gate<A extends unknown[], T>(run: (...a: A) => Promise<T>, refused: T): (...a: A) => Promise<T> {
    return async (...a) => {
      if (busy) return refused
      busy = true
      let timer: ReturnType<typeof setTimeout> | undefined
      try {
        const go = await Promise.race([
          Promise.resolve().then(() => beforeSend?.()).catch(() => true),
          released.then(() => true),
          new Promise((r) => { timer = setTimeout(() => r(true), BEFORE_SEND_MAX_MS) }),
        ])
        return go === false ? refused : await run(...a)
      } finally { busy = false; clearTimeout(timer) }
    }
  }
}

/** `ctx.tangu.mountComposer` 的界面那半(探针动态 import 本模块)。同步返回句柄。 */
export function mountNewChatComposer(el: HTMLElement, o: TanguComposerOptions): TanguComposerMount {
  // 通话接收方 = 挂载那一刻所在的 Space(视图都挂在当前 Space 里);没要通话就不画通话按钮
  const liveSpaceId = o.call ? useSpaceStore.getState().activeSpaceId ?? undefined : undefined
  // 这次挂载卸了(自己 dispose,或同一个 el 上又挂了一份把它顶掉):句柄作废、还在等的 beforeSend 不再等
  let alive = true, release!: () => void
  const released = new Promise<void>((r) => { release = r })
  const gate = sendGate(o.beforeSend, released)
  const send = gate(sendFromNewChat, false)
  const call = gate(startNewChatCall, null)
  const mounted = mountHostReact(el, (
    <HostLocaleProvider>
      <NewChatComposer
        onDispatch={send}
        onStartCall={o.call ? call : undefined}
        onInputModeChange={(focused) => { try { o.onFocusChange?.(focused) } catch (e) { console.error('[composer] onFocusChange threw', e) } }}
        liveSpaceId={liveSpaceId}
      />
    </HostLocaleProvider>
  ), () => { alive = false; release() })
  // 只在还活着时碰 el:被顶掉的旧句柄不许读到 / 按到新那份的输入框和话筒(Codex 评审)
  const ta = (): HTMLTextAreaElement | null => (alive ? el.querySelector<HTMLTextAreaElement>('.hp-composer .t2c-ta') : null)
  return {
    focus: () => ta()?.focus(),
    // 按的就是输入区里那颗话筒:麦克风权限只认用户的这一下,调用方要在点击处理里同步调
    startVoice: () => { if (alive) el.querySelector<HTMLButtonElement>('.hp-composer .t2c-mic-control')?.click() },
    draft: () => ta()?.value ?? '',
    dispose: mounted.dispose,
  }
}
