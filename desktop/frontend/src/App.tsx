/**
 * Tangu Desktop 应用壳:侧栏(多会话)+ 聊天流 + 输入区 + 设置 + 右侧面板。
 * run 流式:startRun → SSE 归约进对应 assistant 消息(后台会话照常跑,完成标未读)。
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type {
  AgentConfig, AgentRunEvent, Attachment, ModelsResponse, NormalAgentDef, SessionRecord, SkillInfo, TanguDesktopConfig, UiMessage, WorkspaceDescriptor,
} from './types'
import { CLOUD_WORKSPACE_KEY } from './types'
import * as api from './services/backendService'
import { abortRun, listActiveRuns, resolveApproval, resolveInquiry, startRun, subscribeRunEvents, testConnection } from './services/agentRunService'
import { Sidebar } from './components/Sidebar'
import { ChatHeader } from './components/ChatHeader'
import { ChatArea } from './components/ChatArea'
import { MessageInput } from './components/MessageInput'
import { SettingsModal } from './components/SettingsModal'
import { RightPanel } from './components/RightPanel'
import { HistorianView } from './components/HistorianView'
import { MuseView } from './components/MuseView'
import { OnboardingWizard, ONBOARDING_DISMISS_KEY } from './components/OnboardingWizard'
import { resolveInitialMode, resolveInitialPreset } from './theme/registry'
import { applyTheme } from './theme/loader'
import { useI18n } from './i18n'

const UNREAD_KEY = 'forsion_tangu_unread_sessions'

function loadUnread(): Set<string> {
  try { return new Set(JSON.parse(localStorage.getItem(UNREAD_KEY) || '[]')) } catch { return new Set() }
}
function saveUnread(s: Set<string>): void {
  try { localStorage.setItem(UNREAD_KEY, JSON.stringify([...s])) } catch { /* ignore */ }
}

/** 历史行 → UI 消息(tool_calls/tool_results 配对成 toolEvents)。 */
function recordToUi(r: any): UiMessage {
  const role = r.role === 'model' || r.role === 'assistant' ? 'assistant' : 'user'
  const msg: UiMessage = {
    id: r.id,
    role,
    content: r.content || '',
    reasoning: r.reasoning || undefined,
    attachments: r.attachments || undefined,
    status: 'done',
    timestamp: Number(r.timestamp) || 0,
  }
  if (role === 'assistant' && Array.isArray(r.tool_calls) && r.tool_calls.length) {
    const results = new Map<string, any>(
      (Array.isArray(r.tool_results) ? r.tool_results : []).map((t: any) => [t.tool_call_id, t]),
    )
    msg.toolEvents = r.tool_calls.map((c: any) => {
      const res = results.get(c.id)
      return {
        id: c.id,
        name: c.function?.name || c.name || 'tool',
        arguments: c.function?.arguments,
        result: res ? String(res.content ?? '') : undefined,
        isError: res?.isError || false,
        done: true,
      }
    })
  }
  if (r.is_error) msg.status = 'error'
  return msg
}

export function App(): React.JSX.Element {
  const { t } = useI18n()
  const [cfg, setCfg] = useState<TanguDesktopConfig>({ backendUrl: 'http://localhost:8787', token: '', modelId: '' })
  const [cfgLoaded, setCfgLoaded] = useState(false)
  const [connState, setConnState] = useState<'idle' | 'ok' | 'err'>('idle')
  const [connMessage, setConnMessage] = useState('')
  // managed(本机托管)后端 → 新会话默认本机执行(与 TUI 对齐);homeDir 作 cwd 兜底。
  const desktopMode = useRef<'managed' | 'external' | null>(null)
  const homeDirRef = useRef<string | undefined>(undefined)
  // 「Tangu 默认工作区」本地目录(effectiveConfig 折算的 ~/Tangu;设置里可改)。
  const defaultWsDirRef = useRef<string>('')
  const [defaultWsDir, setDefaultWsDir] = useState('')

  const [sessions, setSessions] = useState<SessionRecord[]>([])
  const [archivedSessions, setArchivedSessions] = useState<SessionRecord[]>([])
  const [activeId, setActiveId] = useState<string | null>(null)
  const [modelsResp, setModelsResp] = useState<ModelsResponse | null>(null)
  const [skillsList, setSkillsList] = useState<SkillInfo[] | null>(null)
  const [agentDefs, setAgentDefs] = useState<NormalAgentDef[]>([])
  const [specialView, setSpecialView] = useState<'historian' | 'muse' | null>(null)
  const [messagesBySession, setMessagesBySession] = useState<Record<string, UiMessage[]>>({})
  const [configBySession, setConfigBySession] = useState<Record<string, AgentConfig>>({})
  const [runningBySession, setRunningBySession] = useState<Record<string, string>>({})
  // 会话上下文/消耗:ctx=最近一轮真实 prompt tokens(占比用);base=已完成 run 累计;live=当前 run 累计。
  const [usageBySession, setUsageBySession] = useState<Record<string, { ctx: number; base: number; live: number }>>({})
  const [unread, setUnread] = useState<Set<string>>(loadUnread)

  const [sidebarCollapsed, setSidebarCollapsed] = useState(false)
  const [rightOpen, setRightOpen] = useState(false)
  // 聊天滚动容器引用:ChatArea 用它吸底,右侧「目录」用它扫描/跳转(共享同一容器)。
  const chatScrollRef = useRef<HTMLDivElement>(null)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [onboarding, setOnboarding] = useState(false)
  const [themePreset, setThemePreset] = useState(resolveInitialPreset)
  const [themeMode, setThemeMode] = useState<'light' | 'dark'>(resolveInitialMode)
  const [glassOn, setGlassOn] = useState(() => {
    try { return localStorage.getItem('forsion_glass') !== 'off' } catch { return true }
  })
  const [toasts, setToasts] = useState<Array<{ id: number; text: string; error?: boolean }>>([])

  const cfgRef = useRef(cfg)
  cfgRef.current = cfg
  const activeIdRef = useRef(activeId)
  activeIdRef.current = activeId
  const runAborts = useRef(new Map<string, AbortController>())
  const subscribedRuns = useRef(new Set<string>())
  const loadedHistory = useRef(new Set<string>())

  const toast = useCallback((text: string, error = false) => {
    const id = Date.now() + Math.random()
    setToasts((t) => [...t, { id, text, error }])
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 4200)
  }, [])

  // ── 消息更新助手 ──
  const patchMessage = useCallback((sessionId: string, messageId: string, fn: (m: UiMessage) => UiMessage) => {
    setMessagesBySession((prev) => {
      const list = prev[sessionId]
      if (!list) return prev
      const i = list.findIndex((m) => m.id === messageId)
      if (i < 0) return prev
      const next = list.slice()
      next[i] = fn(next[i])
      return { ...prev, [sessionId]: next }
    })
  }, [])

  const endRun = useCallback((sessionId: string, runId: string) => {
    runAborts.current.delete(runId)
    subscribedRuns.current.delete(runId)
    setRunningBySession((prev) => {
      if (prev[sessionId] !== runId) return prev
      const next = { ...prev }
      delete next[sessionId]
      return next
    })
    if (activeIdRef.current !== sessionId) {
      setUnread((prev) => {
        const next = new Set(prev)
        next.add(sessionId)
        saveUnread(next)
        return next
      })
    }
  }, [])

  // ── SSE 事件归约 ──
  const reduceEvent = useCallback((sessionId: string, runId: string, assistantId: string, ev: AgentRunEvent) => {
    const pl = ev.payload || {}
    switch (ev.type) {
      case 'token':
        patchMessage(sessionId, assistantId, (m) => ({ ...m, content: m.content + (pl.delta || '') }))
        break
      case 'reasoning':
        patchMessage(sessionId, assistantId, (m) => ({ ...m, reasoning: (m.reasoning || '') + (pl.delta || '') }))
        break
      case 'tool_stream':
        patchMessage(sessionId, assistantId, (m) => {
          const evs = (m.toolEvents || []).slice()
          const i = evs.findIndex((t) => t.id === pl.id)
          if (i >= 0) evs[i] = { ...evs[i], arguments: (evs[i].arguments || '') + (pl.delta || '') }
          else evs.push({ id: pl.id, name: pl.name || 'tool', arguments: pl.delta || '', done: false })
          return { ...m, toolEvents: evs }
        })
        break
      case 'tool_call':
        patchMessage(sessionId, assistantId, (m) => {
          const evs = (m.toolEvents || []).slice()
          const i = evs.findIndex((t) => t.id === pl.id)
          const item = { id: pl.id, name: pl.name, arguments: pl.arguments, done: false }
          if (i >= 0) evs[i] = { ...evs[i], ...item }
          else evs.push(item)
          return { ...m, toolEvents: evs }
        })
        break
      case 'tool_result':
        patchMessage(sessionId, assistantId, (m) => {
          const evs = (m.toolEvents || []).slice()
          const i = evs.findIndex((t) => t.id === pl.id)
          if (i >= 0) evs[i] = { ...evs[i], result: String(pl.result ?? ''), isError: !!pl.isError, done: true }
          return { ...m, toolEvents: evs }
        })
        break
      case 'approval_request':
        patchMessage(sessionId, assistantId, (m) => ({
          ...m,
          approvals: [
            ...(m.approvals || []),
            {
              approvalId: pl.approvalId, runId, name: pl.name,
              arguments: pl.arguments, preview: pl.preview || '', status: 'pending' as const,
            },
          ],
        }))
        break
      case 'approval_result':
        patchMessage(sessionId, assistantId, (m) => ({
          ...m,
          approvals: (m.approvals || []).map((a) =>
            a.approvalId === pl.approvalId
              ? { ...a, status: pl.action === 'reject' ? ('rejected' as const) : ('approved' as const) }
              : a,
          ),
        }))
        break
      case 'inquiry_request':
        patchMessage(sessionId, assistantId, (m) => ({
          ...m,
          inquiries: [
            ...(m.inquiries || []),
            {
              inquiryId: pl.inquiryId, runId, question: pl.question || '',
              options: Array.isArray(pl.options) ? pl.options : [], status: 'pending' as const,
            },
          ],
        }))
        break
      case 'inquiry_result':
        patchMessage(sessionId, assistantId, (m) => ({
          ...m,
          inquiries: (m.inquiries || []).map((q) =>
            q.inquiryId === pl.inquiryId ? { ...q, status: 'answered' as const, answer: String(pl.answer ?? '') } : q,
          ),
        }))
        break
      case 'plan':
        patchMessage(sessionId, assistantId, (m) => ({ ...m, planProposal: String(pl.plan || '') }))
        break
      case 'todo':
        // 任务清单整单替换(todo_write 工具 → todo 事件);渲染为 todolist。
        patchMessage(sessionId, assistantId, (m) => ({ ...m, todos: Array.isArray(pl.todos) ? pl.todos : [] }))
        break
      case 'plan_approved':
        // 服务端已把会话 agent_config.planMode 落库为 false;同步本地状态(输入栏开关复位)
        setConfigBySession((prev) => ({
          ...prev,
          [sessionId]: { ...(prev[sessionId] || {}), planMode: false },
        }))
        if (pl.file) toast(t('app.planArchived', { file: pl.file }))
        break
      case 'usage':
        // ctx=本轮真实 prompt(占比);live=本 run 累计 tokens。会话消耗 = base + live。
        setUsageBySession((prev) => {
          const u = prev[sessionId] || { ctx: 0, base: 0, live: 0 }
          return { ...prev, [sessionId]: { ctx: pl.prompt || u.ctx, base: u.base, live: pl.total || u.live } }
        })
        break
      case 'done':
        patchMessage(sessionId, assistantId, (m) => ({
          ...m,
          content: pl.content || m.content,
          status: 'done' as const,
          approvals: (m.approvals || []).map((a) => (a.status === 'pending' ? { ...a, status: 'expired' as const } : a)),
          inquiries: (m.inquiries || []).map((q) => (q.status === 'pending' ? { ...q, status: 'expired' as const } : q)),
        }))
        // run 结束:把本 run 的 live 累计并入 base(与持久化的 agent_runs.tokens_total 一致),live 归零。
        setUsageBySession((prev) => {
          const u = prev[sessionId]
          if (!u) return prev
          return { ...prev, [sessionId]: { ctx: u.ctx, base: u.base + u.live, live: 0 } }
        })
        endRun(sessionId, runId)
        break
      case 'error':
        patchMessage(sessionId, assistantId, (m) => ({
          ...m,
          status: 'error' as const,
          error: pl.error || 'error',
          approvals: (m.approvals || []).map((a) => (a.status === 'pending' ? { ...a, status: 'expired' as const } : a)),
          inquiries: (m.inquiries || []).map((q) => (q.status === 'pending' ? { ...q, status: 'expired' as const } : q)),
        }))
        endRun(sessionId, runId)
        break
      default:
        break
    }
  }, [patchMessage, endRun, toast, t])

  const subscribeRun = useCallback(
    (sessionId: string, runId: string, assistantId: string) => {
      if (subscribedRuns.current.has(runId)) return
      subscribedRuns.current.add(runId)
      const ac = new AbortController()
      runAborts.current.set(runId, ac)
      setRunningBySession((prev) => ({ ...prev, [sessionId]: runId }))
      void subscribeRunEvents(cfgRef.current, runId, (ev) => reduceEvent(sessionId, runId, assistantId, ev), ac.signal)
        .catch((e) => {
          patchMessage(sessionId, assistantId, (m) => ({ ...m, status: 'error', error: e?.message || t('app.eventStreamInterrupted') }))
          endRun(sessionId, runId)
        })
    },
    [reduceEvent, endRun, patchMessage, t],
  )

  // ── 启动:配置 → 连接 → 会话列表 ──
  const refreshSessions = useCallback(async (c: TanguDesktopConfig) => {
    const [act, arch] = await Promise.all([api.listSessions(c, false), api.listSessions(c, true)])
    setSessions(act)
    setArchivedSessions(arch)
    return act
  }, [])

  const connect = useCallback(async (c: TanguDesktopConfig) => {
    const r = await testConnection(c)
    setConnState(r.ok ? 'ok' : 'err')
    setConnMessage(r.message)
    if (!r.ok) return
    try {
      const act = await refreshSessions(c)
      setActiveId((cur) => (cur && act.some((s) => s.id === cur) ? cur : (act[0]?.id ?? null)))
    } catch (e: any) {
      toast(t('app.sessionListLoadFail', { e: e?.message || e }), true)
    }
    // 模型目录(输入栏会话内切换器用);失败静默,选择器自动隐藏。
    void api.listModels(c).then(setModelsResp).catch(() => setModelsResp(null))
    // 技能目录(斜杠命令 /skill:* 用);失败静默。
    void api.listSkills(c).then(setSkillsList).catch(() => setSkillsList(null))
    // 本地 Normal Agent 目录(斜杠 /agent:* 用;云端 404 → 空)。
    void api.listAgents(c).then(setAgentDefs).catch(() => setAgentDefs([]))
  }, [refreshSessions, toast, t])

  useEffect(() => {
    void (async () => {
      const stored = await window.tangu?.getConfig()
      desktopMode.current = stored?.mode ?? null
      homeDirRef.current = stored?.homeDir
      defaultWsDirRef.current = stored?.defaultWorkspaceDir || ''
      setDefaultWsDir(stored?.defaultWorkspaceDir || '')
      const merged = {
        backendUrl: stored?.backendUrl || cfgRef.current.backendUrl,
        token: stored?.token ?? cfgRef.current.token,
        modelId: stored?.modelId ?? cfgRef.current.modelId,
      }
      setCfg(merged)
      setCfgLoaded(true)
      if (stored?.mode === 'managed') {
        // 托管后端:**就绪才连**(此时 merged 已是 effectiveConfig 折算后的子进程 url/token)。
        // 未就绪别用 stale 默认配置硬连(会误报「未连接」,且后端随后就绪的 ready 事件若错过就一直卡着——
        // 正是「启动后显示未连接、去设置重启才好」的根因);改为显示「启动中」,等下方 onBackendStatus 的 ready。
        if (stored.backendState?.state === 'ready') void connect(merged)
        else { setConnState('idle'); setConnMessage(t('app.managedBackendStarting')) }
      } else if (merged.token) {
        void connect(merged)
      }
      // 首启引导:桌面端「从未配置凭证」(未登录、无 token、无直连 provider,且未跳过过)→ 进向导。
      // cloudUrl 不参与判定:它可由 ~/.tangu/.env(TANGU_CLOUD_URL)预配,有地址没登录仍要引导。
      if (stored && window.tangu?.envCheck) {
        try {
          if (!localStorage.getItem(ONBOARDING_DISMISS_KEY)
            && !stored.cloudToken && !stored.token) {
            const [auth, provs] = await Promise.all([
              window.tangu.authStatus?.().catch(() => null) ?? null,
              window.tangu.listProviders?.().catch(() => []) ?? [],
            ])
            if (!auth?.loggedIn && !(provs && provs.length)) setOnboarding(true)
          }
        } catch { /* 引导判定失败不阻断 */ }
      }
    })()
    // managed 后端状态推送:就绪 → 取折算配置重连;崩溃 → 标离线。
    const off = window.tangu?.onBackendStatus?.((st) => {
      if (st.state === 'ready') {
        void window.tangu!.getConfig().then((c) => {
          const eff = { backendUrl: c.backendUrl, token: c.token, modelId: c.modelId }
          setCfg(eff)
          void connect(eff)
        })
      } else if (st.state === 'starting') {
        setConnState('idle')
        setConnMessage(t('app.managedBackendStarting'))
      } else if (st.state === 'crashed') {
        setConnState('err')
        setConnMessage(st.lastError || t('app.managedBackendExited'))
      }
    })
    return () => off?.()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // ── 选中会话:懒加载历史 + 恢复在飞 run + 清未读 ──
  useEffect(() => {
    if (!activeId || connState !== 'ok') return
    setUnread((prev) => {
      if (!prev.has(activeId)) return prev
      const next = new Set(prev)
      next.delete(activeId)
      saveUnread(next)
      return next
    })
    if (loadedHistory.current.has(activeId)) return
    loadedHistory.current.add(activeId)
    void (async () => {
      try {
        const [records, config, active] = await Promise.all([
          api.listMessages(cfgRef.current, activeId),
          api.getSessionConfig(cfgRef.current, activeId).catch(() => ({} as AgentConfig)),
          listActiveRuns(cfgRef.current, activeId),
        ])
        setConfigBySession((prev) => ({ ...prev, [activeId]: config }))
        // 会话累计 token 作 base 种子(跨 run 求和);失败不阻断。
        void api.getSessionUsage(cfgRef.current, activeId)
          .then((base) => setUsageBySession((prev) => ({ ...prev, [activeId]: { ctx: prev[activeId]?.ctx || 0, base, live: 0 } })))
          .catch(() => {})
        setMessagesBySession((prev) => {
          // SSE 已在写的消息(本地比远端新)保留
          const existing = prev[activeId] || []
          const ui = records.map(recordToUi)
          const byId = new Map(ui.map((m) => [m.id, m] as const))
          for (const m of existing) byId.set(m.id, m)
          return { ...prev, [activeId]: [...byId.values()].sort((a, b) => a.timestamp - b.timestamp) }
        })
        // 恢复订阅在飞 run(刷新/重启后)
        for (const run of active) {
          if ((run.status === 'running' || run.status === 'queued') && run.assistant_message_id) {
            const amid = run.assistant_message_id
            setMessagesBySession((prev) => {
              const list = prev[activeId] || []
              if (list.some((m) => m.id === amid)) return prev
              return {
                ...prev,
                [activeId]: [...list, { id: amid, role: 'assistant', content: '', status: 'streaming', timestamp: Date.now() }],
              }
            })
            subscribeRun(activeId, run.id, amid)
          }
        }
      } catch (e: any) {
        loadedHistory.current.delete(activeId)
        toast(t('app.historyLoadFail', { e: e?.message || e }), true)
      }
    })()
  }, [activeId, connState, subscribeRun, toast, t])

  // ── 工作区 / 会话操作 ──
  /** 默认本地工作区(Tangu 默认工作区;cwd=defaultWsDir,空时回退主目录)。 */
  const defaultWorkspace = useCallback((): WorkspaceDescriptor => ({
    key: defaultWsDirRef.current || '__default_ws__',
    name: t('app.defaultWorkspace'),
    kind: 'local',
    path: defaultWsDirRef.current || homeDirRef.current || null,
  }), [t])

  /** 工作区列表:Cloud + Tangu 默认 常驻(空也在),再并入会话出现过的其它本地目录。 */
  const workspaces = useMemo<WorkspaceDescriptor[]>(() => {
    const defPath = defaultWsDir || homeDirRef.current || null
    const list: WorkspaceDescriptor[] = [
      { key: CLOUD_WORKSPACE_KEY, name: t('app.cloudWorkspace'), kind: 'cloud', path: null },
      { key: defaultWsDir || '__default_ws__', name: t('app.defaultWorkspace'), kind: 'local', path: defPath },
    ]
    const seen = new Set<string>([CLOUD_WORKSPACE_KEY, defaultWsDir || '__default_ws__'])
    for (const s of [...sessions, ...archivedSessions]) {
      if (s.project_path && s.project_path !== defPath && !seen.has(s.project_path)) {
        seen.add(s.project_path)
        list.push({
          key: s.project_path,
          name: s.project_name || s.project_path.split('/').filter(Boolean).pop() || t('app.workspace'),
          kind: 'local',
          path: s.project_path,
        })
      }
    }
    return list
  }, [sessions, archivedSessions, defaultWsDir, t])

  /** 在工作区下新建会话:cloud→云沙箱;本地→host + cwd=工作区目录 + 自动编辑审批档。 */
  const createInWorkspace = useCallback(async (ws: WorkspaceDescriptor) => {
    try {
      const path = ws.kind === 'local' ? (ws.path || defaultWsDirRef.current || homeDirRef.current || null) : null
      const s = await api.createSession(cfgRef.current, path
        ? { project_path: path, project_name: ws.name }
        : undefined)
      setSessions((prev) => [s, ...prev])
      setActiveId(s.id)
      loadedHistory.current.add(s.id)
      setMessagesBySession((prev) => ({ ...prev, [s.id]: [] }))
      const init: AgentConfig = path
        ? { execMode: 'host', approvalMode: 'auto-edit', cwd: path }
        : { execMode: 'sandbox' }
      setConfigBySession((prev) => ({ ...prev, [s.id]: init }))
      void api.putSessionConfig(cfgRef.current, s.id, init).catch(() => {})
    } catch (e: any) {
      toast(t('app.createSessionFail', { e: e?.message || e }), true)
    }
  }, [toast, t])

  /** 新建会话(默认进 Tangu 默认工作区;Ctrl/Cmd+N 与输入栏 /new 用)。 */
  const newSession = useCallback(() => {
    void createInWorkspace(defaultWorkspace())
  }, [createInWorkspace, defaultWorkspace])

  /** 浏览文件夹新增本地工作区(选目录 → 直接在其中建会话)。 */
  const addLocalWorkspace = useCallback(async () => {
    const dir = await window.tangu?.pickDirectory?.()
    if (!dir) return
    await createInWorkspace({
      key: dir,
      name: dir.split('/').filter(Boolean).pop() || dir,
      kind: 'local',
      path: dir,
    })
  }, [createInWorkspace])

  const renameSession = useCallback(async (id: string, title: string) => {
    setSessions((prev) => prev.map((s) => (s.id === id ? { ...s, title } : s)))
    setArchivedSessions((prev) => prev.map((s) => (s.id === id ? { ...s, title } : s)))
    try {
      await api.updateSession(cfgRef.current, id, { title })
    } catch (e: any) {
      toast(t('app.renameFail', { e: e?.message || e }), true)
    }
  }, [toast, t])

  const archiveSession = useCallback(async (id: string, archived: boolean) => {
    try {
      await api.updateSession(cfgRef.current, id, { archived })
      await refreshSessions(cfgRef.current)
      if (archived && activeIdRef.current === id) setActiveId(null)
    } catch (e: any) {
      toast(t('app.operationFail', { e: e?.message || e }), true)
    }
  }, [refreshSessions, toast, t])

  const deleteSession = useCallback(async (id: string) => {
    try {
      await api.deleteSession(cfgRef.current, id)
      setSessions((prev) => prev.filter((s) => s.id !== id))
      setArchivedSessions((prev) => prev.filter((s) => s.id !== id))
      loadedHistory.current.delete(id)
      if (activeIdRef.current === id) setActiveId(null)
    } catch (e: any) {
      toast(t('app.deleteFail', { e: e?.message || e }), true)
    }
  }, [toast, t])

  // ── 发送 / 停止 / 审批 ──
  const send = useCallback(async (text: string, attachments: Attachment[], workspaceFiles?: Attachment[]): Promise<boolean> => {
    let sid = activeIdRef.current
    let implicitInit: AgentConfig | null = null
    if (!sid) {
      // 无会话直接发送:落进 Tangu 默认工作区(managed)或云沙箱(其余)。
      const path = desktopMode.current === 'managed' ? (defaultWsDirRef.current || homeDirRef.current || null) : null
      const s = await api.createSession(cfgRef.current, path
        ? { project_path: path, project_name: t('app.defaultWorkspace') }
        : undefined).catch(() => null)
      if (!s) {
        toast(t('app.cannotCreateSession'), true)
        return false
      }
      setSessions((prev) => [s, ...prev])
      setActiveId(s.id)
      loadedHistory.current.add(s.id)
      sid = s.id
      implicitInit = path ? { execMode: 'host', approvalMode: 'auto-edit', cwd: path } : { execMode: 'sandbox' }
      setConfigBySession((prev) => ({ ...prev, [s.id]: implicitInit! }))
      void api.putSessionConfig(cfgRef.current, s.id, implicitInit).catch(() => {})
    }
    const sessionId = sid
    const agentConfig = { ...(implicitInit || configBySession[sessionId] || {}) }
    // 云沙箱拖入的文件:发送前先上传到会话工作区(agent run 时即可 list/read)。
    if (workspaceFiles?.length) {
      try {
        await api.uploadWorkspaceFiles(cfgRef.current, sessionId, workspaceFiles.map((f) => ({
          path: f.name, content: f.data, encoding: 'base64' as const, mimeType: f.mimeType,
        })))
        toast(t('app.filesUploaded', { count: workspaceFiles.length }))
      } catch (e: any) {
        toast(t('app.workspaceUploadFail', { e: e?.message || e }), true)
      }
    }
    // 会话级模型(输入栏切换器持久化在 session.model_id)优先于全局默认。
    const sessionModelId = sessions.find((s) => s.id === sessionId)?.model_id || undefined
    try {
      const r = await startRun(cfgRef.current, { sessionId, message: text, modelId: sessionModelId, attachments, agentConfig })
      setMessagesBySession((prev) => ({
        ...prev,
        [sessionId]: [
          ...(prev[sessionId] || []),
          { id: r.userMessageId, role: 'user', content: text, attachments, status: 'done', timestamp: Date.now() },
          { id: r.assistantMessageId, role: 'assistant', content: '', status: 'streaming', timestamp: Date.now() + 1 },
        ],
      }))
      subscribeRun(sessionId, r.runId, r.assistantMessageId)
      // 新 run 起步:live 归零(base 保留),usage 事件会重新累计本 run。
      setUsageBySession((prev) => ({ ...prev, [sessionId]: { ctx: prev[sessionId]?.ctx || 0, base: prev[sessionId]?.base || 0, live: 0 } }))
      // 自动命名:首条消息给 New Chat 改名
      const sess = sessions.find((s) => s.id === sessionId)
      if (sess && (!sess.title || sess.title === 'New Chat')) {
        void renameSession(sessionId, text.slice(0, 30))
      }
      return true
    } catch (e: any) {
      toast(t('app.sendFail', { e: e?.message || e }), true)
      return false
    }
  }, [configBySession, sessions, subscribeRun, renameSession, toast, t])

  const stop = useCallback(() => {
    const sid = activeIdRef.current
    if (!sid) return
    const runId = runningBySession[sid]
    if (runId) void abortRun(cfgRef.current, runId)
  }, [runningBySession])

  // 手动压缩上下文(/compact 或输入栏按钮):生成持久化总结检查点,后续 run 起步即精简。
  const compact = useCallback(async () => {
    const sid = activeIdRef.current
    if (!sid) return
    const modelId = sessions.find((s) => s.id === sid)?.model_id || cfgRef.current.modelId || modelsResp?.defaultModelId || ''
    toast(t('input.compacting'))
    try {
      const r = await api.compactSession(cfgRef.current, sid, modelId)
      toast(r.ok ? t('input.compactDone', { n: r.summarizedCount || 0 }) : t('input.compactSkip', { reason: r.reason || '' }))
    } catch (e: any) {
      toast(t('input.compactFail', { e: e?.message || e }), true)
    }
  }, [sessions, modelsResp, toast, t])

  const decideApproval = useCallback(
    async (messageId: string, approvalId: string, action: 'approve' | 'approve_always' | 'reject', argsOverride?: Record<string, any>) => {
      const sid = activeIdRef.current
      if (!sid) return
      // runId 取自审批对象本身(approval_request 事件已带),不依赖易失的 runningBySession
      // (run 结束/切会话后仍可兑现,服务端对过期审批回 410)。
      const approval = (messagesBySession[sid] || [])
        .find((m) => m.id === messageId)
        ?.approvals?.find((a) => a.approvalId === approvalId)
      if (!approval?.runId) return
      const r = await resolveApproval(cfgRef.current, approval.runId, approvalId, action, argsOverride)
      if (r.gone) {
        patchMessage(sid, messageId, (m) => ({
          ...m,
          approvals: (m.approvals || []).map((a) => (a.approvalId === approvalId ? { ...a, status: 'expired' as const } : a)),
        }))
      }
    },
    [messagesBySession, patchMessage],
  )

  const setExecConfig = useCallback((patch: Pick<AgentConfig, 'execMode' | 'approvalMode' | 'cwd'>) => {
    const sid = activeIdRef.current
    if (!sid) return
    setConfigBySession((prev) => {
      const next = { ...(prev[sid] || {}), ...patch }
      void api.putSessionConfig(cfgRef.current, sid, next).catch(() => {})
      return { ...prev, [sid]: next }
    })
  }, [])

  /** 会话内模型切换:持久化到 session.model_id;无会话时改全局默认。 */
  const setSessionModel = useCallback((modelId: string) => {
    const sid = activeIdRef.current
    if (!sid) {
      setCfg((prev) => {
        void window.tangu?.setConfig({ modelId })
        return { ...prev, modelId }
      })
      return
    }
    setSessions((prev) => prev.map((s) => (s.id === sid ? { ...s, model_id: modelId } : s)))
    setArchivedSessions((prev) => prev.map((s) => (s.id === sid ? { ...s, model_id: modelId } : s)))
    void api.updateSession(cfgRef.current, sid, { model_id: modelId }).catch((e) => {
      toast(t('app.modelSwitchSaveFail', { e: e?.message || e }), true)
    })
  }, [toast, t])

  /** 会话内思考深度切换:合并进 agent_config.thinkingLevel(agentLoop 每轮 run 读取)。 */
  const setSessionThinking = useCallback((level: NonNullable<AgentConfig['thinkingLevel']>) => {
    const sid = activeIdRef.current
    if (!sid) return
    setConfigBySession((prev) => {
      const next = { ...(prev[sid] || {}), thinkingLevel: level }
      void api.putSessionConfig(cfgRef.current, sid, next).catch(() => {})
      return { ...prev, [sid]: next }
    })
  }, [])

  /** 会话内最大循环轮数(/loop <n> 命令):合并进 agent_config.maxIterations(agentLoop 每轮 run 读取,后端 clamp 1-200)。 */
  const setSessionMaxIterations = useCallback((n: number) => {
    const sid = activeIdRef.current
    if (!sid) return
    setConfigBySession((prev) => {
      const next = { ...(prev[sid] || {}), maxIterations: n }
      void api.putSessionConfig(cfgRef.current, sid, next).catch(() => {})
      return { ...prev, [sid]: next }
    })
  }, [])

  /** 计划模式开关(输入栏「计划」按钮 / /plan 命令):持久化进 agent_config.planMode。 */
  const setSessionPlanMode = useCallback((on: boolean) => {
    const sid = activeIdRef.current
    if (!sid) return
    setConfigBySession((prev) => {
      const next = { ...(prev[sid] || {}), planMode: on }
      void api.putSessionConfig(cfgRef.current, sid, next).catch(() => {})
      return { ...prev, [sid]: next }
    })
  }, [])

  /** 会话内技能启停(/skill:<id> 斜杠命令):合并进 agent_config.enabledSkillIds。 */
  const toggleSessionSkill = useCallback((skillId: string) => {
    const sid = activeIdRef.current
    if (!sid) return
    setConfigBySession((prev) => {
      const cur = new Set(prev[sid]?.enabledSkillIds || [])
      cur.has(skillId) ? cur.delete(skillId) : cur.add(skillId)
      const next = { ...(prev[sid] || {}), enabledSkillIds: [...cur] }
      void api.putSessionConfig(cfgRef.current, sid, next).catch(() => {})
      toast(cur.has(skillId) ? t('app.skillEnabled', { id: skillId }) : t('app.skillDisabled', { id: skillId }))
      return { ...prev, [sid]: next }
    })
  }, [toast, t])

  /** 会话内选用 Normal Agent(/agent:<slug> 斜杠命令;''=取消):写 agent_config.agentSlug,有模型则应用会话模型。 */
  const selectSessionAgent = useCallback((slug: string) => {
    const sid = activeIdRef.current
    if (!sid) return
    const def = slug ? agentDefs.find((a) => a.slug === slug) : null
    setConfigBySession((prev) => {
      const next = { ...(prev[sid] || {}), agentSlug: slug || undefined }
      void api.putSessionConfig(cfgRef.current, sid, next).catch(() => {})
      return { ...prev, [sid]: next }
    })
    if (def?.model) setSessionModel(def.model)
    toast(def ? t('input.agentActive', { name: def.name }) : t('input.agentCleared'))
  }, [agentDefs, setSessionModel, toast, t])

  /** 兑现询问(ask_user/exit_plan_mode 的询问卡)。 */
  const answerInquiry = useCallback(
    async (messageId: string, inquiryId: string, answer: string) => {
      const sid = activeIdRef.current
      if (!sid) return
      const inquiry = (messagesBySession[sid] || [])
        .find((m) => m.id === messageId)
        ?.inquiries?.find((q) => q.inquiryId === inquiryId)
      if (!inquiry?.runId) return
      const r = await resolveInquiry(cfgRef.current, inquiry.runId, inquiryId, answer)
      if (r.gone) {
        patchMessage(sid, messageId, (m) => ({
          ...m,
          inquiries: (m.inquiries || []).map((q) => (q.inquiryId === inquiryId ? { ...q, status: 'expired' as const } : q)),
        }))
      }
    },
    [messagesBySession, patchMessage],
  )

  // ── 设置 ──
  const patchConfig = useCallback((patch: Partial<TanguDesktopConfig>) => {
    setCfg((prev) => {
      const merged = { ...prev, ...patch }
      void window.tangu?.setConfig(patch)
      return merged
    })
  }, [])

  const onGlassChange = useCallback((on: boolean) => {
    setGlassOn(on)
    document.documentElement.dataset.glass = on ? 'on' : 'off'
    try { localStorage.setItem('forsion_glass', on ? 'on' : 'off') } catch { /* ignore */ }
  }, [])

  // 快捷键:Cmd/Ctrl+N 新会话,Cmd/Ctrl+, 设置
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey
      if (!mod) return
      if (e.key === 'n') {
        e.preventDefault()
        void newSession()
      }
      if (e.key === ',') {
        e.preventDefault()
        setSettingsOpen(true)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [newSession])

  const activeSession = useMemo(
    () => sessions.find((s) => s.id === activeId) || archivedSessions.find((s) => s.id === activeId) || null,
    [sessions, archivedSessions, activeId],
  )
  const activeModel = useMemo(
    () => (modelsResp?.models || []).find((m) => m.id === (activeSession?.model_id || cfg.modelId || modelsResp?.defaultModelId || '')) || null,
    [modelsResp, activeSession, cfg.modelId],
  )
  const activeUsage = (activeId && usageBySession[activeId]) || { ctx: 0, base: 0, live: 0 }
  const activeMessages = (activeId && messagesBySession[activeId]) || []
  const running = !!(activeId && runningBySession[activeId])
  const runningIds = useMemo(() => new Set(Object.keys(runningBySession)), [runningBySession])
  const execConfig = (activeId && configBySession[activeId]) || {}

  if (!cfgLoaded) return <div className="app" />

  return (
    <div className={`app${sidebarCollapsed ? ' sidebar-collapsed' : ''}`}>
      <Sidebar
        collapsed={sidebarCollapsed}
        sessions={sessions}
        archivedSessions={archivedSessions}
        activeId={activeId}
        runningIds={runningIds}
        unreadIds={unread}
        onSelect={(id) => { setSpecialView(null); setActiveId(id) }}
        showSpecial={!!window.tangu?.backendStatus}
        specialView={specialView}
        onOpenSpecial={(v) => setSpecialView(v)}
        workspaces={workspaces}
        onNewInWorkspace={(ws) => { setSpecialView(null); void createInWorkspace(ws) }}
        onAddWorkspace={() => void addLocalWorkspace()}
        onRename={(id, t) => void renameSession(id, t)}
        onArchive={(id, a) => void archiveSession(id, a)}
        onDelete={(id) => void deleteSession(id)}
        onOpenSettings={() => setSettingsOpen(true)}
        onToast={toast}
        onAuthChange={() => {
          // 登录/登出后托管后端会重启(主进程触发);稍候重连 + 刷新会话/模型。
          setTimeout(() => void connect(cfgRef.current), 1500)
        }}
      />
      <main className="main">
        <ChatHeader
          title={activeSession?.title || 'Tangu Agent'}
          modelId={activeSession?.model_id || cfg.modelId}
          connState={connState}
          connMessage={connMessage}
          sidebarCollapsed={sidebarCollapsed}
          rightOpen={rightOpen}
          themeMode={themeMode}
          onToggleSidebar={() => setSidebarCollapsed(!sidebarCollapsed)}
          onToggleRight={() => setRightOpen(!rightOpen)}
          onToggleMode={() => {
            const m = themeMode === 'dark' ? 'light' : 'dark'
            applyTheme(themePreset, m) // 切换 + 持久化(forsion_theme)
            setThemeMode(m)
          }}
        />
        <div style={{ flex: 1, display: 'flex', minHeight: 0 }}>
          {onboarding ? (
            <OnboardingWizard
              themePreset={themePreset}
              themeMode={themeMode}
              onThemeChange={(preset, mode) => { setThemePreset(preset); setThemeMode(mode) }}
              onReconnect={() => {
                desktopMode.current = 'managed'
                void window.tangu?.getConfig().then((c) => {
                  const eff = { backendUrl: c.backendUrl, token: c.token, modelId: c.modelId }
                  setCfg(eff)
                  void connect(eff)
                })
              }}
              onFinish={() => {
                setOnboarding(false)
                // 引导里可能改了默认工作区目录 → 重读折算值刷新侧栏工作区,再重连。
                void window.tangu?.getConfig().then((c) => {
                  homeDirRef.current = c.homeDir
                  defaultWsDirRef.current = c.defaultWorkspaceDir || ''
                  setDefaultWsDir(c.defaultWorkspaceDir || '')
                  const eff = { backendUrl: c.backendUrl, token: c.token, modelId: c.modelId }
                  setCfg(eff)
                  void connect(eff)
                })
              }}
            />
          ) : (
            <>
              {specialView === 'historian' ? (
                <HistorianView cfg={cfg} />
              ) : specialView === 'muse' ? (
                <MuseView cfg={cfg} sessions={sessions} onInjected={(sid) => { setSpecialView(null); setActiveId(sid) }} />
              ) : (
              <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minWidth: 0 }}>
                <ChatArea
                  messages={activeMessages}
                  containerRef={chatScrollRef}
                  onApproval={(mid, aid, action, args) => void decideApproval(mid, aid, action, args)}
                  onInquiry={(mid, iid, answer) => void answerInquiry(mid, iid, answer)}
                />
                <MessageInput
                  disabled={connState !== 'ok'}
                  running={running}
                  execConfig={execConfig}
                  models={modelsResp?.models ?? null}
                  modelId={activeSession?.model_id || cfg.modelId || modelsResp?.defaultModelId || ''}
                  onModelChange={setSessionModel}
                  thinkingLevel={execConfig.thinkingLevel}
                  onThinkingChange={setSessionThinking}
                  maxIterations={execConfig.maxIterations}
                  onMaxIterationsChange={setSessionMaxIterations}
                  planMode={execConfig.planMode}
                  onPlanModeChange={setSessionPlanMode}
                  skills={skillsList}
                  enabledSkillIds={execConfig.enabledSkillIds || []}
                  onToggleSkill={toggleSessionSkill}
                  agents={agentDefs}
                  activeAgentSlug={execConfig.agentSlug}
                  onSelectAgent={selectSessionAgent}
                  onNewSession={() => void newSession()}
                  onOpenSettings={() => setSettingsOpen(true)}
                  onExecConfigChange={setExecConfig}
                  onSend={send}
                  onStop={stop}
                  contextWindow={activeModel?.contextWindow || 0}
                  ctxTokens={activeUsage.ctx}
                  sessionTokens={activeUsage.base + activeUsage.live}
                  onCompact={compact}
                />
              </div>
              )}
              {rightOpen && activeId && !specialView && (
                <RightPanel
                  cfg={cfg}
                  sessionId={activeId}
                  sessionConfig={execConfig}
                  running={running}
                  messages={activeMessages}
                  chatScrollRef={chatScrollRef}
                  onToast={toast}
                />
              )}
            </>
          )}
        </div>
      </main>

      <SettingsModal
        open={settingsOpen}
        cfg={cfg}
        activeSession={(activeId && sessions.find((s) => s.id === activeId)) || null}
        themePreset={themePreset}
        themeMode={themeMode}
        glassOn={glassOn}
        onClose={() => {
          setSettingsOpen(false)
          // 设置里可能改了默认工作区目录 → 重读折算值,刷新侧栏工作区。
          void window.tangu?.getConfig().then((c) => {
            homeDirRef.current = c.homeDir
            defaultWsDirRef.current = c.defaultWorkspaceDir || ''
            setDefaultWsDir(c.defaultWorkspaceDir || '')
          })
        }}
        onConfigChange={patchConfig}
        onThemeChange={(preset, mode) => {
          setThemePreset(preset)
          setThemeMode(mode)
        }}
        onGlassChange={onGlassChange}
        onReconnect={(patch) => void connect({ ...cfgRef.current, ...(patch || {}) })}
        onRelaunchOnboarding={() => {
          setSettingsOpen(false)
          try { localStorage.removeItem(ONBOARDING_DISMISS_KEY) } catch { /* ignore */ }
          setOnboarding(true)
        }}
      />

      <div className="toast-wrap">
        {toasts.map((t) => (
          <div key={t.id} className={`toast${t.error ? ' error' : ''}`}>
            {t.text}
          </div>
        ))}
      </div>
    </div>
  )
}
