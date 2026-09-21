/**
 * `ctx.tangu` 探针的实现(2026-08-29+)。契约与「为什么要探针」见
 * `amadeus/plugins/tanguSeam.ts` —— 那边是叶子,这边才碰 store。
 *
 * 由 `installEngine()` 调用,**必须早于 `installAmadeusPlugins()`**:`ctx.tangu` 的有无是在
 * 建 plugin context 那一刻定的。三端共用 installEngine,移动端自动跟上(check:parity)。
 */
import { setActiveSpace, useSpaceStore, useWorkspace } from '@lcl/engine'
import {
  setTanguProbe,
  type TanguAgentInfo,
  type TanguAgentStatus,
  type TanguModelInfo,
  type TanguSessionInfo,
  type TanguStartChatOptions,
  type TanguStartChatResult,
} from '@amadeus/plugins/tanguSeam'
import { activeChatModelId, stickyDefaults, useApp, type AppState } from './stores/appStore'
import { agentStatusOf, statusKey } from './stores/agentStatus'
import type { TanguDesktopConfig } from './types'

function readActiveModel(): TanguModelInfo | null {
  const s = useApp.getState()
  // activeSession 的取法与 ChatView 的选择器一致(归档会话也算活动会话)。
  const activeSession =
    s.sessions.find((x) => x.id === s.activeId) ?? s.archivedSessions.find((x) => x.id === s.activeId) ?? null
  const id = activeChatModelId({ ...s, activeSession })
  if (!id) return null
  // 目录还没拉回来(冷启动/离线)时回落成 id,别给空串 —— 插件多半直接拿去当标题画。
  return { id, name: s.modelsResp?.models.find((m) => m.id === id)?.name || id }
}

/** 给插件设置页用的模型目录。和聊天模型选择器同口径:缺 modelType 的旧目录项也算 llm。 */
function readModels(): TanguModelInfo[] {
  return (useApp.getState().modelsResp?.models ?? [])
    .filter((m) => !m.modelType || m.modelType === 'llm')
    .map((m) => ({ id: m.id, name: m.name || m.id }))
}

/** Agent 名册(给「把某个东西绑给某个 Agent」的插件选择器用)。
 *  **不过滤 `createdBy === 'system'`** —— 与用户面前那个「选择 Agent」条(`AgentSelectStrip`,新对话与
 *  ChatView 顶部,决定会话归谁)同口径:它把 Muse 这类系统 Agent 照样列出来、只加一枚「后台」徽章
 *  (`NormalAgentDef.createdBy` 的注释也是这么写的)。另外两处**会**过滤的是聊天中途的「换 Agent」菜单
 *  (Composer2)与团队成员候选(TeamEditor),那是「谁能被指派干活」的口径,不是「会话归谁」。
 *  归属侧(agentStatus.agentSlug)一样不过滤,两边必须对得上:Muse 的会话也报 muse,插件才挑得出形象。 */
const readAgents = (): TanguAgentInfo[] => useApp.getState().agentDefs.map((a) => ({ slug: a.slug, name: a.name || a.slug }))

const readActiveSpace = (): string | null => useSpaceStore.getState().activeSpaceId || null

/** 用量/档位快照。三条口径与 ChatView 传给输入框的那套**同源**,别就地另写:
 *  ① ctxInfo 必须过「模型没变」这道闸 —— 切模型后 SSE 重放会复活旧 run 的事件,不过闸会同时
 *     报错窗口**和**报错思考档(两个值都出自这一条事件);
 *  ② 窗口未知给 0(引擎的 128k 兜底是它自己的事,这里不替它猜);
 *  ③ 空态(还没建会话)也要给得出来:用量 0 + 新对话的起步档。 */
function readSession(): TanguSessionInfo {
  const s = useApp.getState()
  const modelId = readActiveModel()?.id ?? ''
  const raw = s.activeId ? s.ctxInfoBySession[s.activeId] : null
  const ci = raw && (!raw.modelId || !modelId || raw.modelId === modelId) ? raw : null
  const usage = (s.activeId && s.usageBySession[s.activeId]) || null
  const cfgLevel = s.activeId
    ? s.configBySession[s.activeId]?.thinkingLevel
    : s.newChatCfg.thinkingLevel || stickyDefaults(s.desktopConfig, true).thinkingLevel
  // 思考档还要过**第二道闸**(与 Composer2 药丸同口径):`setSessionThinking` 不作废 ctxInfo,
  // 所以「改完档、还没发下一条消息」的窗口里,ci.thinkingEffective 仍是**上一次 run** 的档 ——
  // 拿它显示等于当着用户的面否认他刚改的设置(药丸显示 max、面板显示 medium)。
  // ⚠️只作废 effort,别把整条 ci 作废:换思考档不影响上下文窗口。
  const runEffort = ci && ci.thinkingRequested === (cfgLevel || 'medium') ? ci.thinkingEffective : undefined
  return {
    contextWindow: ci?.ctxWindow || s.modelsResp?.models.find((m) => m.id === modelId)?.contextWindow || 0,
    contextTokens: usage?.ctx || 0,
    sessionTokens: (usage?.base || 0) + (usage?.live || 0),
    // thinkingLevel 的类型里含空串(「不指定」),别原样吐给插件 —— 它会当成一个档位名去查表。
    effort: runEffort || cfgLevel || null,
  }
}

/** 后端就绪判据 = `cfgLoaded && connState === 'ok'`(不是「cfg 对象存在」——初值就是个假地址)。 */
function readyCfg(): TanguDesktopConfig | null {
  const s = useApp.getState()
  return s.cfgLoaded && s.connState === 'ok' ? s.cfg : null
}

/** 等后端就绪;就绪即刻 resolve,否则订阅 store 直到就绪或超时(超时 null,不抛)。 */
export function waitBackend(timeoutMs: number): Promise<TanguDesktopConfig | null> {
  const now = readyCfg()
  if (now) return Promise.resolve(now)
  return new Promise((resolve) => {
    let done = false
    const finish = (v: TanguDesktopConfig | null): void => {
      if (done) return
      done = true
      off()
      clearTimeout(timer)
      resolve(v)
    }
    const off = useApp.subscribe(() => {
      const c = readyCfg()
      if (c) finish(c)
    })
    const timer = setTimeout(() => finish(null), Math.max(0, timeoutMs))
  })
}

/** 后端就绪边沿:`!!readyCfg()` 从 false 翻到 true 才回调(判据与 waitBackend 共用 readyCfg,两边永远一致)。
 *  订阅那一刻已就绪不补发;ok→err→ok 再响一次(那正是「引擎重启 / 换 token 重连」要重放 ensure 的时刻)。 */
export function subscribeReady(cb: () => void): () => void {
  let last = !!readyCfg()
  return useApp.subscribe(() => {
    const now = !!readyCfg()
    if (now && !last) cb()
    last = now
  })
}

/** 某会话 agent 状态的快照(推导见 stores/agentStatus.ts)。 */
export const readAgentStatus = (sessionId?: string | null): TanguAgentStatus =>
  agentStatusOf(useApp.getState(), sessionId, Date.now())

/** 推导依赖的那几个引用。全等 = 状态不可能变 → 连推导都省掉(toast / 别的会话的 token 走这条)。
 *  activeId 恒在:sessionId 省略时它决定看哪个会话。
 *  ⚠️归属(2026-09-20)那几样也必须在这里:`selectSessionAgent` 只动 `configBySession`,漏了它
 *  fire() 在「引用全等」这一步就早退,键里加了 agentSlug 也永远算不到 —— 用户换了 Agent,插件毫无察觉。
 *  `agentDefs` **故意不进**:改展示名不是状态变化(与 statusKey 不收 agentName 同一条纪律)。 */
const statusRefs = (s: AppState, sid: string | null): unknown[] => (sid
  ? [s.activeId, s.messagesBySession[sid], s.runningBySession[sid], s.stoppingBySession[sid],
      s.runStatsBySession[sid], s.llmRetryBySession[sid], s.groupVoting[sid],
      s.configBySession[sid], s.defaultAgentSlug]
  : [s.activeId, s.newChatCfg, s.defaultAgentSlug])

/** 变更过滤订阅:只在 statusKey(phase / tool / toolStage / waitingFor / sessionId / agentSlug)变了时回调;
 *  done / error 带 until → 到期那一刻定时器再推一次(回 idle,store 那一刻不会 set)。
 *  流式回答期间每个 token 都换 messagesBySession[sid] 的引用 → 会重算,但键不变 → 不回调。 */
export function subscribeAgentStatus(cb: (s: TanguAgentStatus) => void, sessionId?: string | null): () => void {
  const sidOf = (s: AppState): string | null => (sessionId === undefined ? s.activeId : sessionId) ?? null
  const s0 = useApp.getState()
  let last = agentStatusOf(s0, sessionId, Date.now())
  let lastKey = statusKey(last)
  let refs = statusRefs(s0, sidOf(s0))
  let timer: ReturnType<typeof setTimeout> | undefined
  let off = false
  const arm = (): void => {
    clearTimeout(timer)
    // +16ms:别卡在到期前一刻醒来又判「还没到」。
    timer = last.until != null ? setTimeout(fire, Math.max(0, last.until - Date.now()) + 16) : undefined
  }
  function fire(): void {
    if (off) return
    const s = useApp.getState()
    const r = statusRefs(s, sidOf(s))
    const expired = last.until != null && Date.now() >= last.until
    if (!expired && r.length === refs.length && r.every((v, i) => v === refs[i])) return
    refs = r
    const next = agentStatusOf(s, sessionId, Date.now())
    const k = statusKey(next)
    if (k === lastKey) return
    last = next
    lastKey = k
    arm()
    // 插件回调抛错不许冒进 store 的 set(那是 reduceEvent 的调用栈)。
    try { cb(next) } catch (e) { console.error('[tangu] agentStatus subscriber threw', e) }
  }
  arm() // 订阅时正处在 done/error 余韵里,也要按时回落
  const unsub = useApp.subscribe(fire)
  return () => {
    off = true
    unsub()
    clearTimeout(timer)
  }
}

/** startChat 的提示词上限(字符)。插件生成的导入说明到这个量级已经是写错了,拒掉比悄悄截断诚实。 */
export const START_CHAT_MAX_PROMPT = 20_000
/** 名册里没有这个 slug 时,刷一次名册再等它回来的上限。 */
const AGENT_WAIT_MS = 3000

/** slug 在 Agent 名册里?不在 → 刷一次再等(名册可能还没拉回来;或插件刚装、捆绑 Agent 刚播种进引擎,
 *  名册是装之前拉的)。refreshAgents 成功/失败都会换 agentDefs 的引用,以此为「回来了」的信号。 */
async function agentKnown(slug: string): Promise<boolean> {
  const has = (): boolean => useApp.getState().agentDefs.some((a) => a.slug === slug)
  if (has()) return true
  const before = useApp.getState().agentDefs
  await new Promise<void>((resolve) => {
    let done = false
    const finish = (): void => {
      if (done) return
      done = true
      unsub()
      clearTimeout(timer)
      resolve()
    }
    // 先订阅再刷新:名册同步回来(缓存命中 / 台架)也接得住。
    const unsub = useApp.subscribe((s) => { if (s.agentDefs !== before) finish() })
    const timer = setTimeout(finish, AGENT_WAIT_MS)
    useApp.getState().refreshAgents()
  })
  return has()
}

const basename = (p: string): string => p.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || p

/** 用指定 Agent 开一个**可见的**新对话。放行规则(send 只给插件自家捆绑 Agent、cwd 钳在库内)在 pluginStore;
 *  这里只执行,步骤与「新对话」入口同源:离开主页 Space → 清成空白草稿(同 bootstrapEngine.blankNewChat)→
 *  选 Agent → 主区打开聊天 → 送出(send())或预填(pendingDraft,Composer 挂载时消费一次)。 */
export async function startChat(o: TanguStartChatOptions): Promise<TanguStartChatResult> {
  const alive = typeof o?.alive === 'function' ? o.alive : () => true
  const prompt = typeof o?.prompt === 'string' ? o.prompt.trim() : ''
  if (!prompt) return { ok: false, error: 'prompt is required' }
  if (prompt.length > START_CHAT_MAX_PROMPT) return { ok: false, error: `prompt is too long (max ${START_CHAT_MAX_PROMPT} characters)` }
  const agent = typeof o.agent === 'string' && o.agent.trim() ? o.agent.trim() : undefined
  if (agent && !(await agentKnown(agent))) return { ok: false, error: `unknown agent: ${agent}` }
  if (!alive()) return { ok: false, error: 'plugin disabled' }
  // 主页 Space 没有聊天主区(同 sessionNav 的 leaveHomeSpace;那份没导出,两行照抄)。
  if (useSpaceStore.getState().activeSpaceId === 'home') setActiveSpace('tangu')
  const app = useApp.getState()
  // 顺序:先清空草稿态,再选 Agent —— selectNewChatAgent 往 newChatCfg / newChatModel 里写,反过来会被清掉。
  app.setActiveId(null)
  // 本机工作目录照 codeStudio 的先例给 local 描述符:resolveNewSessionWorkspace 原样采用 → send() 建会话时
  // project_path = cwd、execMode host。
  app.setNewChatWs(o.cwd ? { key: o.cwd, name: basename(o.cwd), kind: 'local', path: o.cwd } : null)
  app.setNewChatCfg(() => ({}))
  app.setNewChatModel(null)
  if (agent) app.selectNewChatAgent(agent)
  useWorkspace.getState().openView('chat', { followActive: true, reuseKey: 'primary' }, 'main')
  if (!o.send) {
    app.setPendingDraft(prompt)
    return { ok: true }
  }
  // send() 只回 boolean(失败已 toast);新会话 id 从「送出前没有的那条会话」取,别读 activeId ——
  // 等 startRun 的那一拍里用户可能已经点去了别的会话。
  const known = new Set(useApp.getState().sessions.map((x) => x.id))
  let sent = false
  try {
    sent = await app.send(prompt, [], undefined, undefined, undefined, null)
  } catch (e) {
    return { ok: false, error: `send failed: ${String((e as { message?: unknown } | null)?.message ?? e)}` }
  }
  if (!sent) return { ok: false, error: 'send failed' }
  const st = useApp.getState()
  return { ok: true, sessionId: st.sessions.find((x) => !known.has(x.id))?.id ?? st.activeId ?? undefined }
}

export function installTanguProbe(): void {
  setTanguProbe({
    hostExecution: () => window.tangu?.executionCapabilities?.host ?? (useApp.getState().desktopConfig?.mode === 'managed'),
    activeModel: readActiveModel,
    models: readModels,
    agents: readAgents,
    activeSpace: readActiveSpace,
    session: readSession,
    waitBackend,
    subscribeReady,
    agentStatus: readAgentStatus,
    subscribeAgentStatus,
    startChat,
    // ⚠️只在 (模型 id, Space id) 这对值**真变了**时才回调。useApp 在流式回答期间每收一个
    // SSE 增量就 set 一次 state,裸转发 = 把每个订阅插件按帧敲一遍(浮层类插件会当场掉帧)。
    subscribe: (cb) => {
      const key = (): string => `${readActiveModel()?.id ?? ''}|${readActiveSpace() ?? ''}`
      let last = key()
      const fire = (): void => {
        const k = key()
        if (k === last) return
        last = k
        cb()
      }
      const offApp = useApp.subscribe(fire)
      const offSpace = useSpaceStore.subscribe(fire)
      return () => {
        offApp()
        offSpace()
      }
    },
  })
}
