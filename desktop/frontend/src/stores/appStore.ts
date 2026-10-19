import { useChildChat } from './childChatStore'
import { PRODUCT } from '../product'
/**
 * 应用状态 store —— App.tsx 的忠实搬迁(单 store)。
 * ponytail: single store now; split into config/sessions/runs/catalog if it grows.
 * App.tsx 的 React refs 在此化为:① 用 get() 读当前 state(无 stale-closure 问题);
 * ② 非响应式的 Map/Set(runAborts/subscribedRuns/stoppedRuns/loadedHistory)做模块级常量。
 * i18n 是 hook,store 在 React 外 → 持 tr 函数,由 bootstrap 从 useI18n 注入。
 */
import { create } from 'zustand'
import { contentStorageKey } from '@lcl/engine/contentStorageScope'
import { useSpaceStore } from '@lcl/engine/spaceRegistry'
import { getView } from '@lcl/engine/viewRegistry'
import type { AuthStatusInfo, ModelsResponse, SessionRecord, SkillInfo, TanguDesktopConfig, StoredDesktopConfig, DefaultModelSlot } from '../types'
import { isHomeSession } from '../types'
import * as api from '../services/backendService'
import { clearSessionBindings, connectionKey, focusName, focusRef, focusTarget, homeTarget, installEngineHost, knownTargets, nameOfRef, refForSession, refreshDesktopRelay, restoreFocus, restoreSessionBindings, sameRef, setFocusTarget, targetForSession, targetKeyOf, HOME_REF, type TargetKey, type TargetRef } from '../services/engine/targets'
import { healthOf, isRecoverable, isTerminal, noteHealth, probeTarget, resetHealth, useTargetHealth, waitReady } from '../services/engine/health'
import { catalogFor, ensureCatalog, forgetCatalog, rememberCatalog } from '../services/engine/catalog'
import { unitHostProfile } from '../services/engine/hostFs'
import '../services/engine/messages'
import { currentPlatform, testConnection } from '../services/agentRunService'
import { effectiveSessionMode } from '../views/sessionMode'
import { recordUiAction } from '../diag'
import { getClientSurface, notifyClientSurfaces } from '../services/clientSurfaces'
import { windowKind } from '../windowKind'
import type { SettingsTarget as SettingsTab } from '../components/SettingsModal'
import { ONBOARDING_DISMISS_KEY, ONBOARDING_VERSION_KEY } from '../components/OnboardingWizard'
import { act } from '../activity/log'
import { notifyApp } from './notificationStore'
import { agentWriteKnown, noteAgentWriteEnd, noteAgentWriteLive, noteAgentWriteStart } from './agentWriteLedger'
import { translate } from '../i18n'
import { abortAllTanguRuns, abortTanguRun, createTanguSlice, readFocusModel, resetTanguAuthScope, type TanguState } from '@tangu/ui/tangu/store/tanguSlice'
// 转出垫片(第 2a 步):这些搬进了 Tangu 的 store 半身,import 方暂时照旧从这里取,之后逐个改到 Tangu 自己的出口。
export { sketchFromToolEvent, recordToUi, splitDoneMark, pushTextSeg, pushToolSeg, segmentsFromHistory, settleSegments, DEFAULT_APPROVAL, DEFAULT_THINKING, stickyDefaults, applyPreset, rootlessWs, sessionReachable, composerReady, newSessionDirs, resolveNewSessionWorkspace, newChatProjectPath, newSessionPreset, withAmadeusWorkspace, amadeusLandingRoot, remoteSafeInit, newChatModelId, activeChatModelId, lockSessionMove, unlockSessionMove, AGENT_CONFIG_READ_RETRY_MS, AGENT_CONFIG_SYNC_WAIT_MS, steerAcceptPatch } from '@tangu/ui/tangu/store/tanguSlice'
export type { SpecialKind, TeamWorkMember, DeskState, QueueItem } from '@tangu/ui/tangu/store/tanguSlice'


export type { SettingsTab }
let authGeneration = 0
/** P1-K6 S4:焦点代。换焦点不再清会话(会话按绑定走,别的会话照常跑),只换「新会话建在哪」和它的目录 ——
 *  目录类加载(Agent / 模型 / 技能 / 团队 / 云项目 / 特殊 Agent / 家目录)按「账号代 + 焦点代」丢弃过期结果。 */
let focusGeneration = 0
const catalogToken = (): string => `${authGeneration}:${focusGeneration}`

// ── P1-K6 S2:焦点目标(整端切到一台电脑)在 store 里的落点 ──
/** 焦点的目标键(home / unit:<id>)。 */
const focusKey = (): TargetKey => targetKeyOf(focusRef())
const unitPollAt = new Map<TargetKey, number>()

/** 焦点代的中止器:换焦点 / 换账号时 abort,挂在它上面的后台等恢复随之撤掉(探针环没人等 → 当场收工,不再经 hub 探旧那台)。 */
let focusAbort = new AbortController()
/** 当前焦点代上挂着的那个后台等恢复(同一代只挂一个;探针环本就按目标共用)。 */
let focusRecovery: { signal: AbortSignal } | null = null

/** 结束当前焦点代:撤掉后台等恢复。句柄同步清空 —— waitReady 的拒绝在微任务里才到,紧接着的 ensureFocusRecovery 不能看见旧句柄。 */
function endFocusGeneration(): void {
  focusAbort.abort()
  focusAbort = new AbortController()
  focusRecovery = null
}

/**
 * 焦点那台掉进可恢复态(离线 / 引擎没起 / 限流,或 connect 撞上瞬态、健康还是 unknown)→ 挂一个后台 waitReady
 * (与 SSE 暂停共用一条探针环),转好时:connect 失败过 → 再 connect 一次;已连上 → 放开轮询(lastUnitPollAt 归零,下一拍就拉带外消息)。
 * 提示条说的「恢复连接后会自动继续」不能只靠「恰好有 SSE 在等 / connect 失败时挂的那个等待者」(K6-S2 评审 F1:
 * 空闲时一次 502 就让轮询永久停摆)。终局态不挂(R-32 不无限重试;手动出口 = retryFocusTarget / 再选一次同一台)。
 */
function ensureFocusRecovery(): void {
  if (focusRef().kind !== 'unit') return
  const signal = focusAbort.signal
  if (focusRecovery?.signal === signal) return
  const key = focusKey()
  const h = healthOf(key)
  if (h.state === 'ready' || isTerminal(h)) return
  const handle = { signal }
  focusRecovery = handle
  waitReady(key, signal).then(() => {
    if (signal.aborted || focusKey() !== key) return
    unitPollAt.delete(key)
    // 只接「连过、失败了」的:idle = 正在连(refocus / boot 的 connect 在飞),不插第二条
    const st = useApp.getState()
    if (st.connState === 'err') void st.connect(st.cfg)
  }, () => { /* 中止(换了焦点)或转成终局(提示条给「重试」)*/ }).finally(() => { if (focusRecovery === handle) focusRecovery = null })
}
/** P1-K6 S4:**非焦点**的那台(打开的会话绑在它上面)掉进可恢复态时的后台等恢复 —— 同焦点那条(评审 F1 的教训:空闲时一次 502
 *  就让轮询永久停摆),只是它不重连焦点,转好了放开这台的轮询。只给「在用」的那台挂:打开的会话在它上面;换会话 / 换焦点时撤掉不在用的。 */
const sessionRecoveries = new Map<TargetKey, AbortController>()
/** 正在用的 unit 键:焦点 + 打开的会话所在的那台(轮询 / 恢复只为它们跑,别的电脑不经 hub 空探)。 */
function unitKeysInUse(): Set<TargetKey> {
  const keys = new Set<TargetKey>()
  if (focusRef().kind === 'unit') keys.add(focusKey())
  const active = useApp.getState().activeId
  const ref = active ? refForSession(active) : HOME_REF
  if (ref.kind === 'unit') keys.add(targetKeyOf(ref))
  return keys
}
function ensureUnitRecovery(key: TargetKey): void {
  if (key === 'home') return
  if (focusRef().kind === 'unit' && key === focusKey()) { ensureFocusRecovery(); return }
  if (sessionRecoveries.has(key) || !unitKeysInUse().has(key)) return
  const h = healthOf(key)
  if (h.state === 'ready' || isTerminal(h)) return
  const ac = new AbortController()
  sessionRecoveries.set(key, ac)
  waitReady(key, ac.signal).then(() => { if (!ac.signal.aborted) unitPollAt.delete(key) }, () => { /* 中止 / 转成终局 */ })
    .finally(() => { if (sessionRecoveries.get(key) === ac) sessionRecoveries.delete(key) })
}
/** 撤掉不再在用的那几台的后台等恢复(探针环没人等 → 当场收工)。 */
function pruneSessionRecoveries(): void {
  const keep = unitKeysInUse()
  for (const [key, ac] of sessionRecoveries) if (!keep.has(key)) { ac.abort(); sessionRecoveries.delete(key) }
}

/** 换焦点前 home 的家目录 / 默认工作区(web / 手机上本就为空;桌面不会有 unit 焦点)。回 home 时还原。 */
let homeProfile: { homeDir: string | undefined; defaultWsDir: string } | null = null
let lastAuthExpiredAt = 0 // handleAuthExpired 去抖:轮询/SSE/models 可能同时多次 401
/** boot 期 managed 重连:引擎已 ready 但 connState 没到 ok(testConnection 撞上引擎刚 listen / 偶发超时)→ 15s 一次
 *  **只 connect 不 restart**,上限 8 次;每次 ready 广播重新计数。 */
export const BOOT_RETRY_MS = 15_000
export const BOOT_RETRY_MAX = 8
let bootRetryTimer: ReturnType<typeof setTimeout> | null = null
/** 上次 connect 因鉴权被拒(探针 401)。重试环见它即停:15s 一次的重试 > handleAuthExpired 的 10s 去抖,
 *  否则每次重试都再触发一次「重启引擎 / 弹设置页」,8 次。引擎 ready 广播(带新 token 重启)才清掉。 */
let lastConnectAuthRejected = false
/** 同一 (url, token) 的 connect 正在飞时复用它:boot 快照 ready 与 preload 回放 ready 会各叫一次。 */
let connectInflight: { key: string; p: Promise<void> } | null = null
/** connect 代数:每次 connectOnce 递增,await 回来后只有**最新代**才许写 connState / 记录 authRejected / 选会话。
 *  否则老 token 那次 connectOnce 晚到的 401 会盖掉新 token 已成功的 ok,还把 lastConnectAuthRejected 置真停掉重试环(Codex 评审抓的)。 */
let connectGen = 0
let lastOkConnectKey = ''
// 焦点在 unit 时连的是那台电脑(基址不在 cfg 里):键按焦点算,否则换焦点后 inflight 复用 / lastOkConnectKey 会误判「已连同一个」。
const connectKey = (c: { backendUrl: string; token: string }): string =>
  focusRef().kind === 'home' ? connectionKey(c) : `${focusKey()}|${c.token}`
let lastEngineResyncAt = 0 // 凭据不同步时的引擎重启节流:401 持续不断也不许变成重启风暴
// 本窗口是否已经连上过一次:connect 的「没选会话就兜底选第一条」只在冷启动那一次做。
let connectedOnce = false

type ConnState = 'idle' | 'ok' | 'err'

export type { DeskItem } from './deskPlan'

/** 开浮窗时随 params 递「用户正在看的那条会话」—— 浮窗自带一套 store,它首次 connect 的兜底是**列表第一条**,
 *  让它自己猜要么「未关联会话」、要么挂错会话(比挂空更糟)。卫星窗(floating/mini/detached)的 activeId 同样不可信,
 *  所以只有主窗才递;从浮窗里再开浮窗(如登录失效跳设置)就老实不带会话。 */
function openerSession(s: Pick<AppState, 'sessions' | 'archivedSessions' | 'activeId'>): { session?: SessionRecord } {
  if (typeof window === 'undefined' || windowKind() !== 'main') return {}
  const found = s.sessions.find((x) => x.id === s.activeId) || s.archivedSessions.find((x) => x.id === s.activeId) || null
  return found ? { session: found } : {}
}

/** 宿主自己的那一半:连接(cfg / 连接态 / 启动 / 重连)、提示、设置 / 市场 / 反馈 / 成就 / 引导 / 更新。 */
export interface HostState {
  tr: (k: string, vars?: Record<string, unknown>) => string
  cfg: TanguDesktopConfig
  desktopConfig: StoredDesktopConfig | null
  cfgLoaded: boolean
  connState: ConnState
  connMessage: string
  desktopMode: 'managed' | 'external' | null
  homeDir: string | undefined
  defaultWsDir: string
  modelsResp: ModelsResponse | null
  skillsList: SkillInfo[] | null
  authInfo: AuthStatusInfo | null
  engines: Array<{ id: string; name: string; available?: boolean; status?: 'available' | 'needs-signin' | 'not-installed'; defaultModel?: string }>
  engineCaps: Record<string, { models: Array<{ id: string; name: string; description?: string }>; commands: Array<{ name: string; description: string; hint?: string }> }>
  specialEnabled: { historian: boolean; muse: boolean }
  // Phase 2: 设置 / 引导 / 更新
  settingsOpen: boolean
  settingsTab: SettingsTab | null
  settingsSkillKey: string | null
  /** 窗内设置页的重挂 key:每个带落点的 openSettings 请求换一个(见 openSettings)。 */
  settingsNonce: number
  feedbackOpen: boolean
  feedbackDraft: string
  marketOpen: boolean
  marketTarget: { itemId?: string; detailTab?: string; q?: string; nonce?: number } | null
  achievementsOpen: boolean
  onboarding: boolean
  /** 这次引导是版本更新后弹的短引导(只在开机的版本检查里置上;手动重开、首启都是完整引导)。 */
  onboardingUpdate: boolean
  updateAvailable: { version?: string } | null
  updateDismissed: boolean

  setTr(tr: AppState['tr']): void
  toast(text: string, error?: boolean): void
  connect(c: TanguDesktopConfig): Promise<void>
  /** connect 的本体(不去重);外部一律调 connect。 */
  connectOnce(c: TanguDesktopConfig): Promise<void>
  refreshSpecialEnabled(c: TanguDesktopConfig): Promise<void>
  boot(): Promise<void>
  patchConfig(patch: Partial<TanguDesktopConfig>): void
  /** Chat View「高级」的默认辅助 / 生图 / 识图模型；先乐观更新，再写入 config.json。 */
  setDefaultModel(slot: DefaultModelSlot, modelId: string): void
  ensureEngineCaps(engineId: string | undefined): void
  openSettings(tab?: SettingsTab, skillKey?: string): void
  closeSettings(): void
  /** 检测到 Forsion 登录过期(401/凭证失效):清登录态 + 提示 + 引导重登录。幂等;standalone/未登录不触发。
   *  target(P1-K6 S2):哪台引擎回的 401;unit = 先复检账号,账号有效只记那台「引擎鉴权」,绝不重启本机引擎。 */
  handleAuthExpired(target?: TargetKey): void
  /** query = 打开时预填的搜索词(插件详情页「在市场中查找」前置插件)。 */
  openMarket(query?: string, target?: { itemId?: string; detailTab?: string; nonce?: number }): void
  closeMarket(): void
  openAchievements(): void
  closeAchievements(): void
  /** 插件装好后:重扫(免重启出现)+ 启用 + 重启提示 + 跳转对应设置。 */
  /** notify:调用方自己的提示出口(市场在浮窗 / 覆盖层里,全局 toast 看不见);缺省走全局 toast。
   *  updated = 覆盖了已装的同名插件。返回 true = 要重启后端才完整生效(调用方据此给「重启后端」按钮)。 */
  onPluginInstalled(notify?: (text: string, error?: boolean) => void, updated?: boolean): Promise<boolean>
  openFeedback(description?: string): boolean
  closeFeedback(): void
  setOnboarding(on: boolean): void
  setUpdateAvailable(v: { version?: string } | null): void
  dismissUpdate(): void
}
/** useApp 的完整形状 = 宿主半边 + Tangu 半边(tangu/store/tanguSlice.ts)。 */
export interface AppState extends HostState, TanguState {}


export const useApp = create<AppState>((set, get) => ({
  ...createTanguSlice(set, get, {
    authGen: () => authGeneration,
    catalogToken,
    unitPollAt,
    ensureUnitRecovery,
    focusProfilePending: () => focusProfilePending,
    act,
    recordUiAction: (entry) => recordUiAction(entry as Parameters<typeof recordUiAction>[0]),
    getClientSurface,
    notifyClientSurfaces: (event, runId) => notifyClientSurfaces(event, runId),
    catalogFor,
    rememberCatalog,
    ensureCatalog,
    effectiveSessionMode,
    contentStorageKey,
    activeSpaceId: () => useSpaceStore.getState().activeSpaceId,
    viewDisplayName: (type) => getView(type)?.displayName,
    loadAgentCommands: () => import('../agentCommands'),
    askGitClone: async () => (await import('../components/GitCloneDialog')).askGitClone(),
    noteAgentWriteStart,
    noteAgentWriteLive,
    noteAgentWriteEnd,
    agentWriteKnown,
  }),
  tr: (k) => k,
  // 云 web/mobile:boot() 异步回填前的早期请求(布局恢复后的轮询等)会拿默认 cfg 打
  // localhost:8787(控制台 ERR_CONNECTION_REFUSED 红噪音)。壳在挂载前已装好
  // window.tangu.initialConfig 提供已验证账号初值；旧 Web/mobile 保留既有回退。
  cfg: (typeof window !== 'undefined' && window.tangu?.initialConfig) || (typeof window !== 'undefined' && window.tangu?.cloudWeb
    ? { backendUrl: location.origin + '/api', token: (() => { try { return localStorage.getItem('forsion_token') || '' } catch { return '' } })(), modelId: '' }
    : { backendUrl: 'http://localhost:8787', token: '', modelId: '' }),
  desktopConfig: null,
  cfgLoaded: false,
  connState: 'idle',
  connMessage: '',
  desktopMode: null,
  homeDir: undefined,
  defaultWsDir: '',
  modelsResp: null,
  skillsList: null,
  authInfo: null,
  engines: [],
  engineCaps: {},
  specialEnabled: { historian: false, muse: false },
  settingsOpen: false,
  settingsTab: null,
  settingsSkillKey: null,
  settingsNonce: 0,
  feedbackOpen: false,
  feedbackDraft: '',
  marketOpen: false,
  marketTarget: null,
  achievementsOpen: false,
  onboarding: false,
  onboardingUpdate: false,
  updateAvailable: null,
  updateDismissed: false,

  setTr: (tr) => set({ tr }),

  // 垫片:旧 toast(text, error) → 通知系统(error 走 error 级=常驻手动关,其余 info 自动消失)。
  toast: (text, error = false) => {
    notifyApp({ text, level: error ? 'error' : 'info' })
  },

  // P1-K6 S3:请求走目标解析层(焦点 / homeTarget() 活目标现读 store.cfg);c 只作去重键。调用方先把 cfg 落进 store 再 connect
  // (patchConfig → onReconnect、boot / 引导回调、账号切换都是这个顺序)。
  connect: async (c) => {
    const key = connectKey(c)
    if (connectInflight?.key === key) return connectInflight.p
    const p = get().connectOnce(c).finally(() => { if (connectInflight?.p === p) connectInflight = null })
    connectInflight = { key, p }
    return p
  },

  connectOnce: async (c) => {
    const t = get().tr
    const gen = ++connectGen
    const latest = (): boolean => gen === connectGen
    // 换了连接目标(托管切外部、改外部地址 / 令牌):旧目标的 ok 不代表新目标连得上,结果回来前先退回「连接中」,
    // 别让状态条在这段时间把新地址报成已连通(Codex 第三轮 R2-g-1)。同一目标的重连不动 ok。
    if (get().connState === 'ok' && connectKey(c) !== lastOkConnectKey) set({ connState: 'idle', connMessage: '' })
    // S2:焦点在「我的电脑」→ 探的、拉的都是那台(目录 + 会话类);焦点在 home = 原样用 c(与改造前逐字一致)
    const target = focusTarget()
    const onUnit = focusRef().kind === 'unit'
    const r = await testConnection(target)
    if (!latest()) return // 已有更新的 connect 在飞/已完成:这条的结果(尤其老 token 的 401)一律作废
    set({ connState: r.ok ? 'ok' : 'err', connMessage: r.message })
    lastConnectAuthRejected = !!r.authRejected
    if (!r.ok) {
      // 那台电脑已从账号移除(404 UNIT_NOT_FOUND):id 不会再回来,留在这个焦点上只剩一屏报错 → 切回本端
      if (onUnit && r.verdict === 'gone') {
        get().toast(`${t('engine.target.gone')} · ${t('engine.target.fallbackHome')}`, true)
        void setFocusTarget(HOME_REF).catch(() => {})
      }
      // 可恢复的(不在线 / 引擎没起 / 限流 / 网关 5xx):提示说了「恢复连接后会自动继续」就得真的自己连回去 ——
      // 挂到焦点代的后台等恢复上(探针转好再 connect 一次;换了焦点即中止,不再探旧那台)。瞬态不写健康表(还是 unknown),
      // 健康表的订阅看不见它,所以这里显式挂;终局(设备移除 / 身份 / 拒绝)由提示条说明、给重试,不自动重连。
      if (onUnit && (r.verdict === 'offline' || r.verdict === 'engine-unavailable' || r.verdict === 'rate-limited' || r.verdict === 'transient')) {
        ensureFocusRecovery()
      }
      // P1-K6 S4:会话列表只拉本端(R-17)—— 焦点那台连不上不妨碍列出 / 打开本端的会话
      if (onUnit) void get().refreshSessions(c).catch(() => {})
      return
    }
    lastOkConnectKey = connectKey(c)
    try {
      const act = await get().refreshSessions(c)
      if (!latest()) return
      const cur = get().activeId
      // ⚠️ activeId 为 null 往往是**故意**的空白新对话(用户点了「新对话」/ 按 Space 分账给这个 Space 的
      //    起手,见 bootstrapEngine 的 planSpaceSwitch 订阅)。兜底选第一条只在本窗口首次连上时做 ——
      //    否则后端重启 / 登录变化 / 手动重连触发的 connect 会把这份空白顶成别的会话。
      if (cur || !connectedOnce) get().setActiveId(cur && act.some((s) => s.id === cur) ? cur : (act[0]?.id ?? null))
      connectedOnce = true
    } catch (e: any) {
      get().toast(t('app.sessionListLoadFail', { e: e?.message || e }), true)
    }
    if (!latest()) return
    void get().refreshCloudProjects(c)
    // 后续三条列表也只认最新代:老 token 的 401 会把 modelsResp/skillsList 置空,盖掉新 token 刚拉到的
    const key = focusKey()
    void api.listModels(target).then((m) => { if (latest()) { set({ modelsResp: m }); rememberCatalog(key, { models: m }) } }).catch(() => { if (latest()) set({ modelsResp: null }) })
    void api.listSkills(target).then((s) => { if (latest()) { set({ skillsList: s }); rememberCatalog(key, { skills: s }) } }).catch(() => { if (latest()) set({ skillsList: null }) })
    // 外部引擎(ACP)远端 deny-remote:unit 焦点不问(targetCaps.externalEngines = false)
    if (onUnit) set({ engines: [] })
    else void api.listEngines(homeTarget()).then((e) => { if (latest()) set({ engines: e }) }).catch(() => { if (latest()) set({ engines: [] }) })
    void get().refreshSpecialEnabled(c)
    get().refreshAgents()
    void get().refreshTeams()
    void window.tangu?.authStatus?.().then((a) => { if (latest()) set({ authInfo: a }) }).catch(() => { if (latest()) set({ authInfo: null }) })
  },

  refreshSpecialEnabled: async (c) => {
    void c
    const generation = catalogToken()
    try {
      const r = await api.getSpecialConfig(focusTarget())
      if (generation !== catalogToken()) return
      // 云端按轮 Historian 只在后台跑,没有本地的状态条 / 工作视图 / 子会话记录(那些端点在云端 404)→ 不点亮那些入口。
      set({ specialEnabled: { historian: !!r.config?.historian?.enabled && !r.cloud, muse: !!r.config?.muse?.enabled && !r.cloud } })
    } catch {
      if (generation === catalogToken()) set({ specialEnabled: { historian: false, muse: false } })
    }
  },

  boot: async () => {
    const t = get().tr
    // ⚠️ 先订阅再 await:ready 广播若落在下面 getConfig 的 await 期间,晚注册的监听器收不到 → 快照 starting
    //    永远停在「后端启动中」(preload 侧还会注册即回放当前状态,双保险;见 preload.onBackendStatus)。
    const connectFromStatus = (): void => {
      const generation = authGeneration
      void window.tangu!.getConfig().then((c) => {
        if (generation !== authGeneration) return
        const eff = { backendUrl: c.backendUrl, token: c.token, modelId: c.modelId, imageModelId: c.imageModelId }
        set({ desktopConfig: c, cfg: eff, cfgLoaded: true })
        // 快照 ready 那条已连上同一 (url,token) → 这条(preload 回放 / 重复广播)不再打一遍;
        // 引擎重启会先广播 starting 把 connState 压回 idle,所以真正的换 token 重启仍会连。
        if (get().connState === 'ok' && lastOkConnectKey === connectKey(eff)) return
        void get().connect(eff)
      })
    }
    const armRetry = (n: number): void => {
      if (bootRetryTimer) clearTimeout(bootRetryTimer)
      bootRetryTimer = null
      if (n >= BOOT_RETRY_MAX) return
      bootRetryTimer = setTimeout(() => {
        bootRetryTimer = null
        void (async () => {
          const s = get()
          if (s.desktopMode !== 'managed' || s.connState === 'ok' || lastConnectAuthRejected) return
          // 只在引擎自报 ready 时才打:starting 期打过去必 ECONNREFUSED,会把「启动中」顶成「错误」
          const st = await window.tangu?.backendStatus?.().catch(() => null)
          if (st?.state === 'ready') await s.connect(s.cfg)
          armRetry(n + 1)
        })()
      }, BOOT_RETRY_MS)
    }
    window.tangu?.onBackendStatus?.((st) => {
      if (st.state === 'ready') {
        lastConnectAuthRejected = false // 重启后是新 token,重新给机会
        connectFromStatus()
        armRetry(0)
      } else if (st.state === 'starting') {
        set({ connState: 'idle', connMessage: t('app.managedBackendStarting') })
      } else if (st.state === 'crashed') {
        set({ connState: 'err', connMessage: st.lastError || t('app.managedBackendExited') })
      }
    })
    lastConnectAuthRejected = false
    const stored = await window.tangu?.getConfig()
    set({
      desktopConfig: stored || null,
      desktopMode: stored?.mode ?? null,
      homeDir: stored?.homeDir,
      defaultWsDir: stored?.defaultWorkspaceDir || '',
    })
    const prev = get().cfg
    const merged = {
      backendUrl: stored?.backendUrl || prev.backendUrl,
      token: stored?.token ?? prev.token,
      modelId: stored?.modelId ?? prev.modelId,
      // 生图模型也得回灌:run 透传的是 cfg.imageModelId,不回灌就是「设置里选了、重启后设置页空着、
      // 发出去还是 ''」—— 设置页那一行看着存上了其实没有(移动端尤其:云端没有本机 config.json 兜底)。
      imageModelId: stored?.imageModelId ?? prev.imageModelId,
    }
    set({ cfg: merged, cfgLoaded: true })
    // P1-K6 S2:恢复上次的焦点(只有手机 / 网页版可能是「我的电脑」;桌面 / 设备页恒 home)。首次 connect 本来就按焦点连。
    // S4:连同会话 → 电脑的绑定一起读回(按账号落盘),重载后打开那台上的会话仍打那台。
    restoreSessionBindings()
    if (restoreFocus().kind === 'unit') applyFocusEffects(HOME_REF)
    // 桌面作为调用方:中转口经主进程 IPC 异步到位,到了才读得到按账号落盘的会话绑定。焦点不恢复 —— 桌面开机恒在「这台电脑」,
    // 上次选的那台由 runLocationStore 的对账在它 ready 时再切过去。
    void refreshDesktopRelay().then((changed) => { if (changed) restoreSessionBindings() })
    if (stored?.mode === 'managed') {
      if (stored.backendState?.state === 'ready') void get().connect(merged)
      else if (get().connState !== 'ok') set({ connState: 'idle', connMessage: t('app.managedBackendStarting') })
      armRetry(0)
    } else if (merged.token) {
      void get().connect(merged)
    }
    // 首启引导:从未配置凭证(未登录、无直连 provider,且未跳过过)→ 进向导。
    // 注意:不能再用 stored.token 当「有无凭证」信号——managed 后端现在恒有 token(无 Forsion 时回退本地令牌,
    // 见 backendManager.getToken),会把新用户误判为已配置。真实凭证只看 authStatus.loggedIn(读 auth.json,
    // 不含本地回退)+ 直连 provider。
    if (PRODUCT.onboarding !== false && stored && window.tangu?.envCheck) {
      try {
        if (!localStorage.getItem(ONBOARDING_DISMISS_KEY)) {
          // void 不 await:两条 IPC 只决定要不要弹引导,不该拖住 boot 的 resolve(bootstrap 等 boot 完才往下走)。
          void Promise.all([
            window.tangu.authStatus?.().catch(() => null) ?? null,
            window.tangu.listProviders?.().catch(() => []) ?? [],
          ]).then(([auth, provs]) => {
            if (!auth?.loggedIn && !(provs && provs.length)) set({ onboarding: true })
          }).catch(() => { /* 引导判定失败不阻断 */ })
        }
      } catch { /* 引导判定失败不阻断 */ }
    } else if (PRODUCT.onboarding !== false && stored) {
      // web / 移动端(无 envCheck):登录早在挂载前由 webShim / mobileShim 完成(无 token 直接跳
      // /auth),也没有 provider / 本机环境这些概念 —— 「首启」的唯一信号就是没跳过过。
      // 步骤序同步收缩到 welcome/theme/done,见 OnboardingWizard.stepOrder。
      try { if (!localStorage.getItem(ONBOARDING_DISMISS_KEY)) set({ onboarding: true }) } catch { /* 私密模式 */ }
    }
    // 版本更新后再进一次引导(展示 What's New);完成时记录版本(见 OnboardingWizard.finish)。
    // 只在 host 生效(web/移动端没有 appVersion,这条自然 no-op):web 每次发版都全屏拦一次
    // 所有在线用户,代价与收益不成比例 —— 更新日志那边从欢迎页的抽屉照样看得到。
    // seen 与当前版本不同(含老用户首次启用本功能,seen 为空)→ 弹一次,弹完即标记不再重复。
    if (PRODUCT.onboarding !== false) void window.tangu?.appVersion?.().then((ver) => {
      if (!ver) return
      let seen: string | null = null
      try { seen = localStorage.getItem(ONBOARDING_VERSION_KEY) } catch { seen = null }
      if (seen === ver) return
      // 走完 / 跳过过引导的人只看「更新了什么」+ 这一版新增的步骤(OnboardingWizard 的 updateMode);没走过的照常走完整引导。
      let dismissed = false
      try { dismissed = !!localStorage.getItem(ONBOARDING_DISMISS_KEY) } catch { dismissed = false }
      set({ onboarding: true, onboardingUpdate: dismissed })
    }).catch(() => {})
    // 登录态变化(含 CLI tangu login 等外部来源,主进程 auth.json watcher 广播)→ 刷新 authInfo。
    // managed 后端的重连由上面 onBackendStatus 的 ready 分支承接(登录变化会触发后端带新 token 重启)。
    window.tangu?.onAuthChanged?.(() => {
      const generation = ++authGeneration
      ++connectGen
      connectInflight = null
      lastOkConnectKey = ''
      resetTanguAuthScope()
      Object.values(get().agentAvatars).forEach((url) => { try { URL.revokeObjectURL(url) } catch { /* ignore */ } })
      const managed = get().desktopMode === 'managed'
      if (!managed) useChildChat.setState({ selected: {}, sessions: {} })
      set((s) => ({
        authInfo: null, modelsResp: null, skillsList: null, agentDefs: [], agentAvatars: {}, cloudProjects: [],
        connState: 'idle', connMessage: '', cfg: { ...s.cfg, token: '' }, historyLoading: {},
        ...(!managed ? {
          sessions: [], archivedSessions: [], activeId: null, messagesBySession: {}, configBySession: {},
          historyLoading: {}, deskBySession: {}, unread: new Set<string>(),
          // 下面 abort 的订阅静默退出、不走 endRun:不清就永远「运行中」(防休眠跟着卡住不放)
          runningBySession: {},
        } : {}),
      }))
      if (!managed) {
        abortAllTanguRuns()
        // 上面 abort 的 run 都不走 endRun → 能力面收不到 onRunEnd,由这里统一通知重置(移动端登出即走此路)。
        notifyClientSurfaces('reset')
      }
      void window.tangu?.authStatus?.().then((a) => { if (generation === authGeneration) set({ authInfo: a }) }).catch(() => {})
      // P1-K6 S2:焦点按账号落盘 —— 换了号就读新账号的那份(没有 = home);绑定表 / 健康 / 目录缓存都是上个账号的
      const resetEngineScope = (): void => {
        clearSessionBindings()
        endFocusGeneration()
        resetHealth()
        forgetCatalog()
        restoreSessionBindings()
        const prevFocus = focusRef()
        if (restoreFocus().kind === 'unit') applyFocusEffects(prevFocus)
        else restoreHomeProfile(prevFocus)
      }
      // 桌面作为调用方:主进程的中转口(连同它认的账号)跟着登录态变,先重取(手机 / 网页版上是空操作)。
      const relay = refreshDesktopRelay()
      // Some transitions await the engine restart before emitting auth:changed, so
      // ready may already have arrived. Other paths still reconnect from the later broadcast.
      if (managed) {
        // 本机会话不属于云端账号、留着;开在别的电脑上的那些(注入的会话 / 它们的订阅 / 绑定 / 焦点)是上个账号的,账号变了就收掉。
        void relay.then((changed) => {
          if (!changed || generation !== authGeneration) return
          const st = get()
          const remote = new Set([...st.sessions, ...st.archivedSessions].filter((x) => x.location?.kind === 'unit').map((x) => x.id))
          for (const sid of remote) {
            const runId = st.runningBySession[sid]
            if (!runId) continue
            abortTanguRun(runId)
          }
          const wasRemote = focusRef().kind === 'unit'
          resetEngineScope()
          const keep = <T,>(m: Record<string, T>): Record<string, T> => Object.fromEntries(Object.entries(m).filter(([sid]) => !remote.has(sid)))
          set((s) => ({
            sessions: s.sessions.filter((x) => !remote.has(x.id)),
            archivedSessions: s.archivedSessions.filter((x) => !remote.has(x.id)),
            activeId: s.activeId && remote.has(s.activeId) ? null : s.activeId,
            messagesBySession: keep(s.messagesBySession), configBySession: keep(s.configBySession), runningBySession: keep(s.runningBySession),
          }))
          // 焦点原来停在别的电脑上:目录是那台的,回到这台电脑重连一次(引擎若正在带新令牌重启,下面的 ready 广播会再连)。
          if (wasRemote) void window.tangu?.backendStatus?.().then((status) => {
            if (generation === authGeneration && status.state === 'ready') connectFromStatus()
          }).catch(() => {})
        })
        void window.tangu?.backendStatus?.().then((status) => {
          if (generation === authGeneration && status.state === 'ready') connectFromStatus()
        }).catch(() => {})
      } else void relay.then(() => window.tangu?.getConfig?.()).then((c) => {
        if (!c || generation !== authGeneration) return
        const effective = { backendUrl: c.backendUrl, token: c.token, modelId: c.modelId, imageModelId: c.imageModelId }
        set({ desktopConfig: c, cfg: effective })
        resetEngineScope()
        if (effective.token) void get().connect(effective)
      })
    })
  },

  patchConfig: (patch) => {
    set((s) => { void window.tangu?.setConfig?.(patch).catch(() => {}); return { cfg: { ...s.cfg, ...patch } } })
  },

  setDefaultModel: (slot, modelId) => {
    set((s) => ({
      // desktopConfig 是三个槽的完整 UI 真源；桌面尚未 boot 完时保持 null，避免伪造必填连接配置。
      desktopConfig: s.desktopConfig ? { ...s.desktopConfig, [slot]: modelId } : null,
      // 生图 / 识图还会随每次 run 透传，必须同步运行态 cfg；后台辅助模型只由引擎读 config.json。
      cfg: slot === 'backgroundModelId' ? s.cfg : { ...s.cfg, [slot]: modelId },
    }))
    // 不用 setConfig 返回的整份旧快照回灌：用户连续改三个槽时，请求可能乱序完成，整份回灌会把后选项冲掉。
    void window.tangu?.setConfig?.({ [slot]: modelId }).catch(() => {})
  },

  ensureEngineCaps: (engineId) => {
    if (!engineId || get().engineCaps[engineId]) return
    void api.getEngineCapabilities(homeTarget(), engineId).then((caps) => set((s) => ({ engineCaps: { ...s.engineCaps, [engineId]: caps } })))
  },

  openSettings: (tab, skillKey) => {
    // 带落点的请求每次换一个 nonce,设置页按它重挂(浮窗:FloatingRoot 拿 params 做 key;窗内:Root 拿 settingsNonce 做 key)。
    // 落点只在挂载时读一次 —— 没有它,设置开着、用户又翻到了别的页时再请求同一个落点,只会把窗口带到前台。
    // 不带落点的(齿轮、命令)不换:窗内设置页开着就留在用户原来那一页。(浮窗那边上一次请求若带落点,
    // params 仍然变了、照旧回到首页 —— 那是这次改动之前就有的行为,没有动。)
    // 加随机小数:同一毫秒里的两次请求、不同窗口各自的 store 都不会撞出同一个号。
    const nonce = tab ? Date.now() + Math.random() : null
    if (window.tangu?.openFloatingPanel) {
      void window.tangu.openFloatingPanel({ id: 'settings', title: get().tr('settings.title'), builtin: 'settings', params: { tab: tab ?? null, skillKey: skillKey ?? null, ...(nonce ? { nonce } : {}), ...openerSession(get()) } })
      return
    }
    set((s) => ({ settingsTab: tab ?? null, settingsSkillKey: skillKey ?? null, settingsOpen: true, settingsNonce: nonce ?? s.settingsNonce }))
  },

  openMarket: (query, target) => {
    if (window.tangu?.openFloatingPanel) {
      void window.tangu.openFloatingPanel({ id: 'market', title: get().tr('market.title'), builtin: 'market', params: { ...(query ? { q: query } : {}), ...target } })
      return
    }
    set({ marketOpen: true, marketTarget: { ...(query ? { q: query } : {}), ...target } })
  },

  openAchievements: () => {
    if (window.tangu?.openFloatingPanel) {
      void window.tangu.openFloatingPanel({ id: 'achievements', title: get().tr('achievements.title'), builtin: 'achievements' })
      return
    }
    set({ achievementsOpen: true })
  },
  closeAchievements: () => set({ achievementsOpen: false }),

  closeMarket: () => {
    set({ marketOpen: false, marketTarget: null })
    // 装了新技能/智能体/插件 → 刷新本地 Agent 目录 + 技能列表(让 /skill 选择器即时反映新技能,
    // 无需手动刷新桌面;system prompt 的技能段由托管后端每轮按需重扫,已即时生效)。
    get().refreshAgents()
    void api.listSkills(focusTarget()).then((s) => set({ skillsList: s })).catch(() => { /* ignore */ })
  },

  onPluginInstalled: async (notify, updated) => {
    const t = get().tr
    const say = notify ?? get().toast
    try {
      // 重扫让后端立刻发现新插件(免重启);装即启用;提示可能需重启。
      // 不再自动关市场 / 跳设置:装完只 toast「已安装」,用户在插件详情里自行「打开设置」。
      const r = await api.rescanPlugins(homeTarget())
      let list = r.plugins
      for (const id of r.addedIds) list = (await api.setPluginEnabled(homeTarget(), id, true).catch(() => null))?.plugins ?? list
      // 新引擎(给 reloadedIds,10-02 起)原地更新即热换,破不了模块缓存的(CommonJS / 自带 node_modules 等)才要重启 —— needsRestart 已经说了;
      // 旧引擎只激活全新 id:原地更新时老代码还在跑,不重启就报「已生效」是谎报。
      const needsRestart = r.needsRestart || (!!updated && !r.reloadedIds)
      // 装上了但前置没齐(引擎让它休眠):别报「已启用」,说清还缺什么
      const missing = [...new Set((list ?? []).filter((p) => [...r.addedIds, ...(r.reloadedIds ?? [])].includes(p.id)).flatMap((p) => (p.waitingFor ?? []).map((w) => w.id)))]
      const label = (id: string): string => { const q = list?.find((p) => p.id === id); return q ? q.name : id }
      say(needsRestart ? t('market.pluginInstalledRestartHint')
        : missing.length ? t('market.pluginInstalledWaiting', { list: missing.map(label).join(t('common.listSep')) })
        : t('market.pluginInstalledOk'))
      return needsRestart
    } catch (e: any) {
      say(t('market.installFail', { e: e?.message || String(e) }), true)
      return false
    }
  },

  closeSettings: () => {
    set({ settingsOpen: false })
    // 设置里可能改了默认工作区目录 / Special Agents 开关 → 重读折算值刷新。
    void window.tangu?.getConfig().then((c) => set({ desktopConfig: c, homeDir: c.homeDir, defaultWsDir: c.defaultWorkspaceDir || '' }))
    void get().refreshSpecialEnabled(get().cfg)
    // 关设置后刷新本地 Agent 目录(设置页可能新建/改头像)。
    get().refreshAgents()
  },

  handleAuthExpired: (target) => {
    // P1-K6 S2(§3.5):经 hub 打「我的电脑」回的 401。hub 401 体无 code,与那台引擎的 401 分不开 → 先复检账号:
    // 账号无效 → 走下面 home 的过期流程;账号有效 → 只记那台「引擎鉴权」、提示一次,**绝不**重启本机引擎 / 误登出。
    if (target && target !== 'home') { void unitAuthExpired(target); return }
    const s = get()
    if (!s.authInfo?.loggedIn) return // standalone/未登录:绝不踢去 Forsion 登录
    const now = Date.now()
    if (now - lastAuthExpiredAt < 10_000) return // 幂等去抖
    lastAuthExpiredAt = now
    void (async () => {
      // 401 ≠ 云端登录过期:本地引擎的端点鉴权是**逐字比对 spawn 时的 env token 快照**,凭据一漂
      // (auth.json 被改写而引擎没重启)本地接口就整片 401 —— 而那时云端登录完好无损。所以先复检真实
      // 登录态(与 run 出错路径同一套路),服务端也不认了才走过期 UX;仍有效 = 引擎凭据不同步,重启引擎
      // 自愈(ready 后渲染层带新配置重连,会话列表自己回来),绝不弹「请重新登录」误导用户。
      const a = await (window.tangu?.authStatus?.().catch(() => null) ?? Promise.resolve(null))
      if (a?.loggedIn) {
        set({ authInfo: a })
        if (now - lastEngineResyncAt > 60_000) {
          lastEngineResyncAt = now
          void window.tangu?.backendRestart?.()
        }
        return
      }
      const t = get().tr
      set({
        authInfo: a ?? { ...s.authInfo!, loggedIn: false, tokenValid: false },
        connState: 'err',
        connMessage: t('app.sessionExpired'),
      })
      get().toast(t('app.sessionExpired'), true)
      // 通知常驻的账号卡(自管 authStatus,不订阅本 store)刷新 → 显示过期态 + 点击改走重新登录。
      try { window.dispatchEvent(new Event('tangu:auth-expired')) } catch { /* ignore */ }
      get().openSettings('forsion') // 复用现成 forsion tab 的登录入口
    })()
  },

  openFeedback: (description) => {
    if (description) set({ feedbackDraft: description })
    if (get().authInfo?.loggedIn) {
      if (window.tangu?.openFloatingPanel) {
        void window.tangu.openFloatingPanel({ id: 'feedback', title: get().tr('feedback.title'), builtin: 'feedback', params: { description: description ?? get().feedbackDraft, ...openerSession(get()) } })
      } else set({ feedbackOpen: true })
      return true
    }
    else {
      get().toast(get().tr('feedback.errNotLoggedIn'), true)
      get().openSettings('forsion')
    }
    return false
  },
  closeFeedback: () => set({ feedbackOpen: false }),

  setOnboarding: (on) => set({ onboarding: on, onboardingUpdate: false }),
  setUpdateAvailable: (v) => set({ updateAvailable: v }),
  dismissUpdate: () => set({ updateDismissed: true }),
}))

const revoke = (url: string): void => { try { URL.revokeObjectURL(url) } catch { /* ignore */ } }

/** unit 焦点的家目录 / 默认工作区正在拉(/unit/config):send() 建第一个会话前等它一下。 */
let focusProfilePending: Promise<void> | null = null

/**
 * 焦点落到某台电脑之后的附带动作(换焦点与启动恢复共用):拉那台电脑的家目录 / 默认工作区(新会话落点要它 ——
 * 手机自己没有),读按设备记的模型,预热 home 的目录缓存(管理面板 / 收件箱 / 自动化读 home 那份,K6 待定 4)。
 * prev = 换焦点之前的位置:从 home 离开时先记下 home 的家目录,回来时还原。
 */
function applyFocusEffects(prev: TargetRef): void {
  const next = focusRef()
  if (next.kind !== 'unit') return
  const st = useApp.getState()
  // 桌面:这台电脑自己的 homeDir / defaultWsDir 不动(侧栏 / 文件面板 / 设置在读),那台的另放 focusDirs
  const desktop = currentPlatform() === 'desktop'
  const putDirs = (d: { homeDir: string | undefined; defaultWsDir: string }): void => useApp.setState(desktop ? { focusDirs: d } : d)
  if (!desktop && prev.kind === 'home') homeProfile = { homeDir: st.homeDir, defaultWsDir: st.defaultWsDir }
  const generation = catalogToken()
  putDirs({ homeDir: undefined, defaultWsDir: '' })
  useApp.setState({ focusModelId: readFocusModel(next) })
  const pending: Promise<void> = unitHostProfile(focusTarget()).then((profile) => {
    if (generation !== catalogToken() || !profile) return
    putDirs({ homeDir: profile.homeDir ?? undefined, defaultWsDir: profile.defaultWorkspaceDir || '' })
  }).finally(() => { if (focusProfilePending === pending) focusProfilePending = null })
  focusProfilePending = pending
  void ensureCatalog('home', { force: true })
}

/** 焦点回到 home:还原 home 的家目录 / 默认工作区,丢掉 home 的独立目录缓存(顶层目录又是 home 的了)。 */
function restoreHomeProfile(prev: TargetRef): void {
  if (prev.kind !== 'unit') return
  if (homeProfile) useApp.setState({ homeDir: homeProfile.homeDir, defaultWsDir: homeProfile.defaultWsDir })
  homeProfile = null
  focusProfilePending = null
  useApp.setState({ focusModelId: '', focusDirs: null })
  forgetCatalog('home')
}

/** 某台电脑此刻是否还有会话在用(打开着 / 有 run 在跑):S4 起换焦点不再掐会话,离开的那台若还有会话在用,它的健康格与恢复都留着。 */
function unitKeyBusy(key: TargetKey): boolean {
  if (key === 'home') return false
  if (unitKeysInUse().has(key)) return true
  const running = useApp.getState().runningBySession
  return Object.keys(running).some((sid) => !!running[sid] && refForSession(sid).kind === 'unit' && targetKeyOf(refForSession(sid)) === key)
}

/**
 * setFocusTarget 的宿主半身。
 * S2(整端切换)时这里清空全部会话 / 消息 / SSE 再按新焦点重连;**S4 起会话按绑定走**(targetForSession = 绑定 ?? home,R-19),
 * 焦点只剩「新会话建在哪」与它那一侧的目录 / 连接态:
 *  ① 递增焦点代(连带 connectGen / inflight / lastOkConnectKey):旧焦点慢到的目录(Agent / 模型 / 技能 / 团队 / 云项目 / 家目录)
 *     与 connect 结果一律作废 —— 会话类加载(列表只拉 home、历史按会话目标)不受影响,**不动 authGeneration**;
 *  ② **不中止任何 SSE、不清会话 / 消息 / 绑定**:绑在别的电脑上的会话照常跑、照常批审批(两台并存,一台断线不影响另一台);
 *     只清焦点作用域的目录态,回到空白新对话(activeId = null:选了「在哪运行」,接下来打的字就建在那);
 *  ③ 按新焦点重连(connect:探焦点、拉焦点的目录、刷新本端列表)。
 */
async function refocusEngine(next: TargetRef, prev: TargetRef): Promise<void> {
  ++focusGeneration
  ++connectGen
  connectInflight = null
  lastOkConnectKey = ''
  lastConnectAuthRejected = false
  if (next.kind === 'unit' && !unitKeyBusy(targetKeyOf(next))) resetHealth(targetKeyOf(next))
  // 旧焦点的后台等恢复 / connect 挂的等待者一并撤掉 → 探针环没人等,当场收工(在飞的探针也撤)。离开的那台若已没有会话在用,
  // 健康格也清掉(没人再探它,留着就是过期的「离线」给 K3 / K7 读);还有会话在用(run 在跑)就留着。gone 是永久事实,留着。
  endFocusGeneration()
  const st = useApp.getState()
  Object.values(st.agentAvatars).forEach(revoke)
  Object.values(st.teamAvatars).forEach(revoke)
  useApp.setState({
    activeId: null,
    modelsResp: null, skillsList: null, agentDefs: [], agentAvatars: {}, defaultAgentSlug: 'xyra', engines: [], engineCaps: {},
    teams: [], teamAvatars: {}, cloudProjects: [],
    specialEnabled: { historian: false, muse: false },
    newChatModel: null, newChatWs: null,
    connState: 'idle',
    connMessage: next.kind === 'unit' ? translate('engine.target.connecting', { name: focusName() || '' }) : '',
  })
  pruneSessionRecoveries()
  if (prev.kind === 'unit' && !sameRef(prev, next)) {
    const pk = targetKeyOf(prev)
    if (!unitKeyBusy(pk) && healthOf(pk).state !== 'gone') resetHealth(pk)
  }
  if (next.kind === 'unit') applyFocusEffects(prev)
  else restoreHomeProfile(prev)
  await useApp.getState().connect(useApp.getState().cfg)
}

let lastUnitAuthToastAt = 0
/** unit 目标回 401(§3.5):账号复检 → 无效走 home 的过期流程;有效只记那台「引擎鉴权」,提示一次(10s 去抖)。 */
async function unitAuthExpired(key: TargetKey): Promise<void> {
  const a = await (window.tangu?.authStatus?.().catch(() => null) ?? Promise.resolve(null))
  if (a && (a.loggedIn === false || a.tokenValid === false)) {
    useApp.getState().handleAuthExpired('home')
    return
  }
  noteHealth(key, { state: 'engine-auth', since: Date.now() })
  const now = Date.now()
  if (now - lastUnitAuthToastAt < 10_000) return
  lastUnitAuthToastAt = now
  const name = (key.startsWith('unit:') ? nameOfRef({ kind: 'unit', unitId: key.slice('unit:'.length) }) : null) || translate('engine.target.defaultName')
  useApp.getState().toast(translate('engine.target.engineAuth', { name }), true)
}

/**
 * 焦点没换、手动重试那台(setFocusTarget(同一台) / retryFocusTarget;K8 UnitsSheet 再点一次同一台、提示条的「重试」):
 * 没连上 → connect(testConnection 本身就是一次探针,结果写回健康表);已连上但健康不是 ready(终局 / 离线)→ 探一次,
 * 转好了轮询自己续上。已连上且健康 → 什么都不做。终局态只在这里由用户触发重试(R-32)。
 */
async function reconnectFocus(ref: TargetRef): Promise<void> {
  if (ref.kind !== 'unit' || !sameRef(focusRef(), ref)) return
  const key = focusKey()
  const st = useApp.getState()
  if (st.connState !== 'ok') { await st.connect(st.cfg); return }
  if (healthOf(key).state === 'ready') return
  const h = await probeTarget(focusTarget()).catch(() => null)
  if (h?.state === 'ready' && sameRef(focusRef(), ref)) unitPollAt.delete(key)
}

// P1-K6:引擎目标解析层读本端连接配置的唯一接缝(homeTarget / knownTargets / cloudApiBase 每次现读);
// S2 起还接 setFocusTarget 的宿主半身(refocus)与焦点不变时的手动重试(reconnect)。
installEngineHost({
  cfg: () => useApp.getState().cfg,
  desktopConfig: () => useApp.getState().desktopConfig,
  refocus: refocusEngine,
  reconnect: reconnectFocus,
  // R-16:本端列表 / 归档区里没打 unit 标的会话 = 本端会话(它们从不 bindSession,绑定表里没有)。设备自报撞上它们的 id 一律 conflict。
  isHomeSession: (sid) => {
    const st = useApp.getState()
    return st.sessions.some((x) => x.id === sid && isHomeSession(x)) || st.archivedSessions.some((x) => x.id === sid && isHomeSession(x))
  },
})

// 焦点那台的健康格被任何人(轮询 / 服务层 / SSE / 探针)写进可恢复态 → 确保有个后台等恢复(评审 F1:
// 空闲时一次 502、或 run 进行中并行请求吃到 504,原先只要没有 SSE 恰好在等,就再也没人把它写回 ready)。
useTargetHealth.subscribe((s, prev) => {
  // S4:焦点那台 + 打开的会话所在的那台(可能不是焦点)都要有人等恢复
  for (const key of unitKeysInUse()) {
    const h = s.byKey[key]
    if (!h || h === prev.byKey[key] || !isRecoverable(h)) continue
    ensureUnitRecovery(key)
  }
})
// 换了打开的会话 → 撤掉不再在用的那几台的后台等恢复(不经 hub 空探别的电脑)
useApp.subscribe((s, p) => { if (s.activeId !== p.activeId) pruneSessionRecoveries() })

// dev-only 驱动入口:真机 live 台架(scripts/plan-live.e2e.cjs)靠它连上**你手里已经跑着的**
// dev 实例发指令 —— 自起 Electron 会被引导覆盖层挡住,而真模型/真引擎的行为(比如模型到底
// 调不调 exit_plan_mode)只有真实例答得了。生产构建里这行不存在。
// typeof window 守卫不能省:一部分单测跑在 node 环境(非 happy-dom),少了它 14 个测试文件当场 ReferenceError。
if (import.meta.env.DEV && typeof window !== 'undefined') {
  (window as unknown as Record<string, unknown>).__forsionStore = useApp
  // P1-K6 S2:整端切换台架(desktop/scripts/engine-target.check.cjs)的驱动口 —— 选「在哪运行」的 UI 归 K8,
  // 台架在它之前经这里切焦点、看健康表;生产构建同样没有这行。
  ;(window as unknown as Record<string, unknown>).__forsionEngineTargets = {
    setFocusTarget, focusRef,
    // P1-K7a:用户亲手选「在哪运行」(= 弹层 / 胶囊走的那一条:记住,且这份草稿不再被对账改掉)。只改焦点的 setFocusTarget 不算亲手选,
    // 新草稿会被对账拉回记住的位置 —— 要测「记住上次的选择」就走这里。动态 import:runLocationStore 反过来依赖本文件。
    setRunLocation: async (loc: TargetRef, name?: string) => (await import('./runLocationStore')).setDraftLocation(loc, { explicit: true, name: name ?? null }),
    // S4:两台并存台架看「这条会话绑在哪」与已知目标集合(R-20)
    locationOf: (sid: string) => refForSession(sid),
    known: () => knownTargets().map((t) => t.key),
    health: () => useTargetHealth.getState().byKey,
    probe: () => probeTarget(focusTarget()),
    // P1-K9:check:remotechain 的「下载产物」一步 —— 手机上没有列出远端会话沙箱的 UI 入口,台架经这里调**同一个**服务层函数
    // (按会话路由目标 → 头 → 中继 → blob 保存),与上传(uploadWorkspaceFiles(get().cfg, …))同一份 cfg。
    downloadWorkspaceFile: (sessionId: string, path: string) => api.downloadWorkspaceFile(targetForSession(sessionId), sessionId, path),
  }
}