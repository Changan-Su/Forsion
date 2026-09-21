/**
 * 插件 ctx 的 Tangu 只读探针(叶子模块,2026-08-29+)。
 *
 * 为什么是探针而不是直接 import appStore:`pluginStore → appStore → SettingsModal → pluginStore`
 * 是一个真实的 import 环(appStore 顶部就 import 了 amadeus 的 pageStore)。做法同
 * `editorExtensions.ts` —— 叶子模块只存实现,由 `bootstrapEngine` 在装配时注入。
 *
 * 没注入(纯 Amadeus 壳 / unit 设备页 / 云端)→ `readTangu()` 恒 null,`ctx.tangu` 整个不注入,
 * 插件据此判断「这不是 Tangu 宿主」。这是**能力探测**,不是权限闸(模型名不敏感,不走 manifest
 * `capabilities` 白名单那道双闸)。
 */

export interface TanguModelInfo {
  /** 模型 id(引擎侧标识,如 `claude-opus-5`)。 */
  id: string
  /** 展示名(模型目录里查到的;查不到时回落成 id —— 目录还没拉回来时也不至于给空串)。 */
  name: string
}

/** 主区聊天此刻的**用量与档位**快照(2026-08-29+)。全部是「读一次拿走」的口径。 */
export interface TanguSessionInfo {
  /** 模型的上下文窗口(tokens);引擎报的真实预算优先于目录值。**未知给 0**,别当 128k 兜底用。 */
  contextWindow: number
  /** 当前上下文占用(最近一次 run 的 prompt tokens);没跑过给 0。 */
  contextTokens: number
  /** 本会话累计 tokens(历史 + 本次流式)。空态会话 = 0。 */
  sessionTokens: number
  /** 生效的思考档(`off`/`minimal`/`low`/`medium`/`high`/`xhigh`/`max`);不知道给 null。
   *  引擎报过 `thinkingEffective`(被能力表 clamp 后的真实档)就用它,否则用会话配置里的请求档。 */
  effort: string | null
}

/** Agent 在某个会话里**此刻在干什么**(2026-09-19+)。粗粒度状态机,专给「跟着 agent 做反应」的插件
 *  (Desk 伴随形象、状态栏小宠物)用;推导规则见 `stores/agentStatus.ts`。
 *  - idle     :没在跑(含新对话草稿、done/error 的余韵过期后)
 *  - thinking :在跑,但还没出字 / 在推理 / 工具结果回来等下一轮模型
 *  - speaking :正在流式输出正文
 *  - tool     :有工具在执行(或模型正在写工具参数,见 toolStage)
 *  - waiting  :等用户 —— 审批或提问(优先级最高:等人永远压过「在跑」)
 *  - error    :刚失败(余韵 ERROR_HOLD 后自动回 idle)
 *  - done     :刚成功结束(余韵 DONE_HOLD 后自动回 idle) */
export type TanguAgentPhase = 'idle' | 'thinking' | 'speaking' | 'tool' | 'waiting' | 'error' | 'done'

export interface TanguAgentStatus {
  phase: TanguAgentPhase
  /** 这份状态说的是哪个会话;新对话草稿 = null。 */
  sessionId: string | null
  runId: string | null
  /** tool:正在跑的工具名;waiting:待审批的工具名,或 'ask_user' / 'exit_plan_mode'。 */
  tool?: string
  /** tool 阶段细分:args = 模型还在写参数(未开始执行),exec = 正在执行。 */
  toolStage?: 'args' | 'exec'
  waitingFor?: 'approval' | 'inquiry'
  /** 本阶段开始时刻(ms,尽力而为)。 */
  since: number
  /** 仅 done / error:到这一刻回落 idle(订阅方会在那一刻收到 idle 回调)。 */
  until?: number
  /** 当前流式助手消息 id(speaking 期间用它区分「换了一条气泡」)。 */
  messageId?: string
  /** 当前流式助手消息正文 / 推理的累计字符数 —— 拉取式,插件自己按帧算增量做口型包络。 */
  textChars: number
  reasoningChars: number
  /** 这个会话用的是哪个 Agent(slug)。会话没显式选 → 用户的默认 Agent;草稿会话 → 新对话配置里选的那个。
   *  外部引擎会话 / 推导不出来 → undefined。 */
  agentSlug?: string
  /** 该 Agent 的展示名;名册里查不到(还没拉回来 / 已删)时省略。 */
  agentName?: string
}

/** Agent 名册的一条(2026-09-20+)。 */
export interface TanguAgentInfo { slug: string; name: string }

/** 「什么都不知道」时的状态:草稿、没有探针的宿主、探针缺 agentStatus 的旧台架都回它。 */
export const idleAgentStatus = (sessionId: string | null): TanguAgentStatus =>
  ({ phase: 'idle', sessionId, runId: null, since: 0, textChars: 0, reasoningChars: 0 })

/** `startChat` 入参(2026-09-19+)。 */
export interface TanguStartChatOptions {
  /** Agent slug;不给 = 用户默认 Agent。不存在的 slug → ok:false。 */
  agent?: string
  /** 用户消息正文(送出或预填进输入框)。 */
  prompt: string
  /** true = 直接送出(只对**插件自己捆绑包里**的 Agent 生效,宿主在 pluginStore 那层把关);
   *  false / 不给 = 只预填进输入框,由用户按回车。 */
  send?: boolean
  /** 新会话的工作目录:**本机绝对路径**(pluginStore 已把插件给的库相对路径解析、钳在库内)。 */
  cwd?: string
  /** 宿主内部:调用方(pluginStore)的活性闸。探针在每个 await 之后、任何副作用之前复查,
   *  false → 不再动界面、返回 ok:false —— 等 Agent 名册的那几秒里插件被禁用,不许再替它开对话。 */
  alive?: () => boolean
}

export interface TanguStartChatResult {
  ok: boolean
  /** send:true 且成功时是新会话 id;预填时 undefined。 */
  sessionId?: string
  error?: string
}

export interface TanguProbe {
  /** True only when the active engine executes against this host filesystem. */
  hostExecution?(): boolean
  /** 主区聊天此刻**实际会用**的模型;一个都没有 → null。 */
  activeModel(): TanguModelInfo | null
  /** 当前模型目录里的全部对话模型(只含 llm,不混入生图 / 语音模型)。 */
  models(): TanguModelInfo[]
  /** 用户的 Agent 名册(给「把某个东西绑给某个 Agent」的选择器用)。可选:旧宿主 / 台架假探针不给 →
   *  插件退回「只认当前会话的 Agent」。 */
  agents?(): TanguAgentInfo[]
  /** 当前 Space id(`tangu` / `home` / 用户 Space …);无 Space 时 null。 */
  activeSpace(): string | null
  /** 用量/档位快照。**纯拉取,永远不进 `subscribe` 的变更键** —— 这些值在流式回答里每个
   *  SSE 增量都在动,放进订阅等于把浮层插件按帧敲一遍(那正是变更过滤器存在的理由)。
   *  插件要"实时"就自己定时拉。
   *  可选:台架的假探针可以整条不给,插件那边表现得与旧宿主一致(`session` 返回 null)。 */
  session?(): TanguSessionInfo
  /** 仅在 (模型 id, Space id) 这对值**真的变了**时回调。返回退订。 */
  subscribe(cb: () => void): () => void
  /** 等引擎后端可用(cfg 已从主进程回填且连通检查通过),给出那一刻的连接配置;超时给 null(2026-09-02+)。
   *  `ctx.automation` 的有无就看这条在不在 —— 台架假探针 / 旧宿主不给 = 非 Tangu 宿主口径。
   *  为什么是等待而不是同步读:插件 setup 在 `installEngine()` 模块期就跑完了,那一刻 appStore 的 cfg
   *  还是 localhost:8787 + 空 token 的初值(boot() 在 React effect 里才回填)。**调用时才读 store**,别在装配时捕获。 */
  waitBackend?(timeoutMs: number): Promise<import('../../types').TanguDesktopConfig | null>
  /** 后端就绪**边沿**(与 waitBackend 同一判据:cfgLoaded && connState 'ok',从「非就绪」翻到「就绪」那一刻)回调;
   *  订阅时已就绪不补发,只认边沿。返回退订。宿主用它重放上次失败的 `ctx.automation.ensure`(2026-09-02+);
   *  可选:台架假探针 / 旧宿主不给 = 没有自动重放,ensure 的语义不变。 */
  subscribeReady?(cb: () => void): () => void
  /** 某会话的 agent 状态快照(2026-09-19+)。sessionId 省略 = 全局活动会话(`activeId`);null = 草稿(恒 idle)。
   *  可选:台架假探针 / 旧宿主不给 = 插件那边拿不到状态(按 idle 处理)。 */
  agentStatus?(sessionId?: string | null): TanguAgentStatus
  /** 同一会话口径的**变更过滤**订阅:只在 phase / tool / toolStage / waitingFor / sessionId / agentSlug
   *  变了时回调,done/error 余韵到期那一刻再回调一次(回 idle)。token / 推理增量、改 Agent 展示名**不**回调。
   *  返回退订。 */
  subscribeAgentStatus?(cb: (s: TanguAgentStatus) => void, sessionId?: string | null): () => void
  /** 用指定 Agent 开一个新对话(离开主页 Space → 新对话草稿 → 选 Agent → 预填或送出)。
   *  放行规则(send 只给自家捆绑 Agent、cwd 钳在库内)在 pluginStore 那层,这里只执行。 */
  startChat?(o: TanguStartChatOptions): Promise<TanguStartChatResult>
}

let probe: TanguProbe | null = null

/** 由 `installEngine()` 注入(desktop / web / mobile 三端共用那一处装配 → 天然对齐)。
 *  必须早于 `installAmadeusPlugins()`:`ctx.tangu` 的有无是在建 context 那一刻定的。 */
export function setTanguProbe(p: TanguProbe | null): void {
  probe = p
}

export function readTangu(): TanguProbe | null {
  return probe
}
