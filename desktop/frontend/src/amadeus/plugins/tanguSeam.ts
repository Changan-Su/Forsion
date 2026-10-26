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

import type { TanguSliceModule } from '../../stores/appStore'
import { createContext, createElement, type ComponentProps, type ComponentType, type ReactElement } from 'react'
import type { BtwSeed } from '@tangu/ui/views/chat2/btwStore'
import type { FilesPanel } from '@tangu/ui/views/chat2/FilesPanel'
import type { SpecialKind } from '@tangu/ui/tangu/store/tanguSlice'
import type { CtxItem } from '../../components/RightPanel'
import type { ViewProps } from '@lcl/engine'
import type { Attachment } from '../../../../../tangu-agent/src/contracts/clientTypes'

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
  /** 语音通话里模型此刻的输出电平 0..1(2026-10-04+;RMS×4 截顶,正常说话多在 0.2–0.8)。
   *  **只在这个会话正在语音通话时出现**(模型没在出声 = 0)—— 出现就按它做口型(真实声音),别再用 textChars 的
   *  出字速度:通话中代办 run 在聊天区出字时,模型并没有出声。拉取式(~20Hz 更新),不进变更过滤。
   *  通话相位同时叠在 `phase` 上:模型出声 → speaking(压过其余一切);用户说完、模型还没开口且没有 run 在跑 → thinking。 */
  speechLevel?: number
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
  /** Explicit Chat Box selection; applied after Agent defaults and before draft/send. */
  modelId?: string
  thinkingLevel?: import('../../../../shared/chatBox').ChatBoxSelection['thinkingLevel']
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

/** `mountChat` 入参(2026-10-04+)。放行规则(cwd 钳在库内)在 pluginStore;探针只执行。 */
export interface TanguChatMountOptions {
  /** 归属的插件 id:与 cwd 一起定「接哪一条会话」,也是引用通道的目标名。 */
  owner: string
  /** Agent slug;不给 = 用户默认 Agent。不存在的 slug → ready 给 ok:false。 */
  agent?: string
  /** 插件给的工作文件夹(库相对,已去尾斜杠)。只用来给引用通道起目标名;落到哪个绝对路径由 resolveCwd 说了算。 */
  folder?: string
  /** folder → **本机绝对路径**(pluginStore 的放行规则:钳在库内、须本机执行)。探针等后端就绪之后才调 ——
   *  应用刚启动时桌面配置与笔记库都还没回来,当场解析会把「还没就绪」错当成「不能在本机跑」。解析不出来给 null。 */
  resolveCwd?: () => string | null
  /** 新建会话时的标题(重连既有会话时不改它)。 */
  title?: string
}

/** 挂载出来的对话在引用通道里的目标名(也是它的 `data-chat-surface`)。跟着(插件, 工作文件夹)走、不跟着挂载实例走:
 *  视图卸了重挂的那一拍里投的引用,新挂上的对话照样接得住。 */
export const pluginChatType = (o: Pick<TanguChatMountOptions, 'owner' | 'folder'>): string => `plugin-chat:${o.owner}:${o.folder ?? ''}`

/** `mountComposer` 入参(2026-10-18+,主页插件化 S2)。新对话输入区整块挂进插件的 DOM;建会话、切到 Tangu、发送都由宿主做。 */
export interface TanguComposerOptions {
  /** 输入区(含模型 / 模式 / 附件这些控件和它们的菜单)获得 / 失去焦点。主页拿它做聚焦景深。 */
  onFocusChange?(focused: boolean): void
  /** 宿主发送之前先等它(插件放退场动效,最多 2 秒)。明确回 false = 这次不发;抛错、超时、或插件这时被停用 / 视图被卸,宿主照样发。 */
  beforeSend?(): Promise<boolean | void> | boolean | void
  /** 要不要通话按钮。给了 = 挂载时所在的 Space 是当前 Space 时才画(同一时刻只该有一个通话接收方)。 */
  call?: boolean
}

/** `mountComposer` 的句柄。 */
export interface TanguComposerMount {
  /** 把光标放进输入框。 */
  focus(): void
  /** 开始录音(按的就是输入区里那颗话筒)。要在用户的点击处理里同步调:麦克风权限只认用户那一下。 */
  startVoice(): void
  /** 输入框里此刻的草稿(只读;草稿归宿主)。 */
  draft(): string
  dispose(): void
}

/** `mountChat` 的句柄。同步返回;会话是异步接上的,`quote` / `prefill` 在接上之前调用也不丢。 */
export interface TanguChatMount {
  /** 会话接上(重连或新建)→ ok + sessionId;后端没连上 / Agent 不存在 / 建会话失败 → ok:false(不抛)。 */
  ready: Promise<TanguStartChatResult>
  /** 把一段文字挂成输入框上方的引用条:不发送、不动草稿,由用户接着打字。 */
  quote(text: string): void
  /** 把一段文字放进输入框(接在已有草稿后面)并聚焦:不发送,由用户按回车。对话要看得见才落进去。 */
  prefill(text: string): void
  dispose(): void
}

export interface TanguProbe {
  openSession?(sessionId: string, alive?: () => boolean): Promise<void> | void
  /** True only when the active engine executes against this host filesystem. */
  hostExecution?(): boolean
  /** 主区聊天此刻**实际会用**的模型;一个都没有 → null。 */
  activeModel(): TanguModelInfo | null
  /** 当前模型目录里的全部对话模型(只含 llm,不混入生图 / 语音模型)。 */
  models(): TanguModelInfo[]
  modelCatalog?(kind: import("../../../../shared/pluginModelPicker").PluginModelKind): Promise<import("../../../../shared/pluginModelPicker").PluginModelCatalog>
  /** 用户的 Agent 名册(给「把某个东西绑给某个 Agent」的选择器用)。可选:旧宿主 / 台架假探针不给 →
   *  插件退回「只认当前会话的 Agent」。 */
  agents?(): TanguAgentInfo[]
  /** Native roster consumers; separate from the model/Space-only subscription. */
  subscribeAgents?(cb: () => void): () => void
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
  /** 把原生对话挂进插件自己的 DOM(2026-10-04+):一个(插件, 工作目录)接一条会话,本机记住、下次重连。
   *  只在有 Tangu 对话能力的宿主上给;台架假探针 / 旧宿主不给 = 插件退回 startChat。 */
  mountChat?(el: HTMLElement, o: TanguChatMountOptions): TanguChatMount
  /** 新对话输入区(ctx.tangu.mountComposer)。只在有 Tangu 对话能力的宿主上给。 */
  mountComposer?(el: HTMLElement, o: TanguComposerOptions): TanguComposerMount
  /** Native document actions only; never exported into the plugin context. */
  submitDocumentTask?(o: {
    key: string; agent?: string; prompt: string; vaultRoot: string
    alive: () => boolean
    /** Bind and strictly save the session before any model run is submitted. */
    onCreated: (sessionId: string) => Promise<void>
  }): Promise<TanguStartChatResult>
  openDocumentTask?(sessionId: string): void
  /** agent 自建 Space 读写自家数据(2026-09-27+);slug 没有数据源 → null(今天只有 muse)。
   *  可选:台架假探针 / 纯 Amadeus 壳不给 = 插件那边整个没有 `ctx.agent`。 */
  agentSelf?(slug: string): TanguAgentSelf | null
  /** 编辑器「问 Tangu」(评审 G3-04,2026-09-28):把一段引用交给侧栏对话(挂成输入框上方的引用,不发送),
   *  侧栏没在前台就把它揭出来。**宿主内部接缝,不进 `ctx.tangu`**(pluginStore 按字段挑着暴露)。
   *  存在性 = 宿主注册了 `chat-panel` 视图(与 features/tangu.tsx 同一个谓词);没有侧栏对话的宿主不给 →
   *  编辑器里整个入口不出现,不画一个点了没反应的按钮。 */
  askInChat?(text: string): void
  /** 正文生成式 AI 的一次性补全(评审 G3-07,2026-09-28):引擎 `POST /agent/inline`(不落库、无工具)。
   *  编辑器的「AI ▾」/ `/ai` / 空行空格与插件的 `ctx.tangu.complete` / `translate` 都走这一条。模型缺省 = 主区聊天此刻用的那个;
   *  `action: 'translate'` 没点名模型时先取「翻译」模型槽(设置 → 模型 → 翻译)。
   *  可选:纯 Amadeus 壳 / 台架假探针不给 = 编辑器里没有 AI 入口、插件那边没有 `ctx.tangu.complete`。 */
  complete?(req: TanguCompleteRequest, opts?: TanguCompleteOptions): Promise<TanguCompleteResult>
  /** 行内补全(FIM,2026-10-26+):引擎 `/agent/inline` 的 `fim` 动作,光标前后文原样交给补全模型,无提示词。
   *  模型:`req.modelId` → 「补全」模型槽(还在目录里)→ 目录 fimModels 第一个 → 都没有 reject `Error('fim_unavailable')`;
   *  引擎 / 云端回 fim_unsupported 也 reject 成 `fim_unavailable`(插件据此落回 `complete`)。只在给得出 `complete` 的宿主上有。 */
  fim?(req: TanguFimRequest, opts?: TanguCompleteOptions): Promise<TanguFimResult>
}

export interface TanguFimRequest {
  /** 光标前的正文(引擎留尾 16k 字符)。 */
  before: string
  /** 光标后的正文(引擎留头 8k 字符)。 */
  after?: string
  /** 输出上限,引擎夹到 1..512,缺省 64。 */
  maxTokens?: number
  /** 停止串,引擎留前 4 个、每个前 32 字符。 */
  stop?: string[]
  /** 不给 = 「补全」模型槽 / 目录里第一个补全模型。 */
  modelId?: string
}
export interface TanguFimResult {
  /** 模型原文(不 trim、不剥围栏)。 */
  text: string
  model?: { id: string; name: string }
}

/** 正文 AI 的动作(与引擎 services/inlineAi.ts 的 INLINE_ACTIONS 同表)。改写类(前六个)必须带 selection。 */
export type TanguInlineAction = 'improve' | 'fix' | 'shorter' | 'longer' | 'summarize' | 'translate' | 'continue' | 'custom'
export interface TanguCompleteRequest {
  action: TanguInlineAction
  /** 自定义指令(custom 必填)。 */
  instruction?: string
  selection?: string
  /** 光标 / 选区前后的一段正文(上下文,不改写)。 */
  before?: string
  after?: string
  /** 笔记标题。 */
  title?: string
  pageInstructions?: string
  pagePath?: string
  /** translate 的目标语言(如 "English")。 */
  language?: string
  /** 不给 = 主区聊天当前模型(translate:先取「翻译」模型槽)。 */
  modelId?: string
}
export interface TanguCompleteOptions {
  signal?: AbortSignal
  /** 流式增量(整段累计请自己拼);done 前可能回调多次,也可能一次都不回(网关缓冲)。 */
  onDelta?: (delta: string) => void
}
export interface TanguCompleteResult {
  /** 待插入的 markdown(引擎已剥掉整段包裹的 ```markdown 围栏)。 */
  text: string
  /** 模型把工具调用写成了文本(它没有工具,什么都没执行)。 */
  toolCallText: boolean
  /** translate:这次实际是谁译的(结果卡上写出来;mt = 机器翻译模型)。别的动作不给;不随 ctx.tangu 交给插件。 */
  model?: { id: string; name: string; mt: boolean }
}

/** agent 自建 Space 读写自家数据(2026-09-27+):`ctx.agent` 的宿主实现。字段都是插件可见的契约,别塞绝对路径。 */
export interface TanguAgentSelfStatus {
  running: boolean
  lastCycleAt: number | null
  /** 自己定的休眠(心跳暂停到这个时刻);null = 醒着 */
  sleepUntil: number | null
  sleepReason: string | null
  mode: 'ask' | 'agent' | 'auto'
  heartbeatMinutes: number
  pendingApprovals: number
}
export type TanguAgentTodoStatus = 'pending' | 'injected' | 'done' | 'dismissed'
export interface TanguAgentTodo { id: string; title: string; detail: string | null; status: TanguAgentTodoStatus; createdAt: string }
export interface TanguAgentScheduleEntry { id: string; name: string; date: string; repeat: string; auto: boolean; description: string; lastRun: string }
export interface TanguAgentLibraryEntry { path: string; size: number; mtime: number; dir: boolean }
export interface TanguAgentSelf {
  status(): Promise<TanguAgentSelfStatus | null>
  todos(status?: TanguAgentTodoStatus): Promise<TanguAgentTodo[]>
  /** 只改 pending 的(CAS):别处已处理过的不许被一个旧界面改回去。alive() 为 false(插件等后端期间被停用)→ 不发请求、reject */
  updateTodo(id: string, status: 'done' | 'dismissed', alive?: () => boolean): Promise<void>
  schedule(): Promise<TanguAgentScheduleEntry[]>
  libraryList(): Promise<TanguAgentLibraryEntry[]>
  libraryRead(path: string): Promise<string>
}

/** 宿主交给 Tangu 入口 `activateTangu(host)` 的东西(界面热更新 3b):只放入口 import 不到的宿主私有件,
 *  其余宿主模块照共享模块表直接 import。**宿主内部接缝,不进 `ctx.tangu`**。 */
export interface TanguHost {
  /** 把 Tangu 的 store 半身装进 useApp(宿主 stores/appStore.ts 的 installTanguSlice;界面热更新 3c)。入口第一件事就做。 */
  installSlice(mod: TanguSliceModule): void
  /** 装 ctx.tangu 探针(宿主 tanguProbe.ts)。`tangu` = Tangu 自己交进去的那几块,Tangu 没激活时为空。 */
  installProbe(tangu: Pick<TanguProbe, 'askInChat'>): void
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

/** 收件箱里 agent 信末尾的任务卡(核心插件化 2e,方案第 5 节 9 号接缝的仓内版):Tangu 在激活时交出来
 *  (features/tangu.tsx),宿主的收件箱只管放。**宿主内部接缝,不进 `ctx.tangu`**。
 *  没交(Tangu 没激活)→ 收件箱不切卡,正文原样显示。 */
export interface TanguInboxTasks {
  /** 切出正文与卡:只认 forsion-task / forsion-approval 两种围栏;todo = 这封是 Muse 自己的信(`todo:` 头才生效)。 */
  split(body: string, opts: { todo: boolean }): { text: string; tasks: readonly unknown[]; approvals: string[] }
  /** 画任务卡:落点新会话 / 交给 Muse / 忽略(收件箱没有当前会话),Muse 待办的真状态现拉回写。 */
  Cards: ComponentType<{ tasks: readonly unknown[]; ownerId: string }>
}

let inboxTasks: TanguInboxTasks | null = null

export function setTanguInboxTasks(p: TanguInboxTasks | null): void {
  inboxTasks = p
}

export function readTanguInboxTasks(): TanguInboxTasks | null {
  return inboxTasks
}

/** Tangu 自己的界面偏好(核心插件化 2e-2,方案第 4.5 节「聊天偏好」的仓内版):Tangu 在激活时交出读写口,
 *  宿主的设置页照原位置摆开关。**宿主内部接缝,不进 `ctx.tangu`**。没交(Tangu 没激活)→ 两个开关连同搜索结果都不摆。 */
export interface TanguPref { get(): boolean; set(on: boolean): void }
export interface TanguPrefs {
  /** 聊天消息头像(主题页)。 */
  chatAvatars: TanguPref
  /** 输入建议(高级 › 界面与会话);桌面宿主之外 get() 恒 false。 */
  promptSuggest: TanguPref
}

let prefs: TanguPrefs | null = null

export function setTanguPrefs(p: TanguPrefs | null): void {
  prefs = p
}

export function readTanguPrefs(): TanguPrefs | null {
  return prefs
}

/** 新对话输入区发出第一句(核心插件化 2e-3)。 */
export type TanguNewChatDispatch = (
  text: string,
  attachments: Attachment[],
  workspaceFiles?: Attachment[],
  skillIds?: string[],
  mentions?: { priorityAgent?: string; mentionAgents?: string[] },
) => Promise<boolean>

/** 新对话输入区(核心插件化 2e-3,方案第 5 节 9 号接缝 `mountComposer` 的仓内版):Tangu 在激活时交出来,
 *  内置主页直接放 `Composer`,`ctx.tangu.mountComposer` 挂的是 `mount` —— 同一份。**宿主内部接缝**。
 *  没交(Tangu 没激活)→ 主页不摆输入区、探针不给 mountComposer。 */
export interface TanguNewChat {
  Composer: ComponentType<{
    onDispatch: TanguNewChatDispatch
    onStartCall?: () => Promise<string | null>
    onInputModeChange: (focused: boolean) => void
    /** 通话按钮只在这个 Space 是当前 Space 时画;不给 = 不画。 */
    liveSpaceId?: string
  }>
  /** 切到 Tangu 再按新对话发出去;没有 Tangu Space → false。 */
  send: TanguNewChatDispatch
  /** 切到 Tangu、建新会话,resolve 新会话 id;没建成 → null。 */
  startCall(): Promise<string | null>
  /** 清成空白新对话(⌘N 那条;手机「分享到 Forsion → 新对话」也用)。 */
  blank(): void
  mount(el: HTMLElement, o: TanguComposerOptions): TanguComposerMount
}

let newChat: TanguNewChat | null = null

export function setTanguNewChat(p: TanguNewChat | null): void {
  newChat = p
}

export function readTanguNewChat(): TanguNewChat | null {
  return newChat
}

/** 工作区侧栏的两种会话模式(核心插件化 2e-5,方案第 5 节 8 号接缝 `registerWorkspaceMode` 的仓内版):轨道(orbits)与
 *  会话列表(sessions)由 Tangu 在激活时交出,宿主的 WorkspaceView 只管放。**宿主内部接缝**。没交 → 这两种模式是空的。 */
export interface TanguSidebarModes {
  Orbits: ComponentType<{ sideFilter?: 'local' | 'cloud' }>
  Sessions: ComponentType<{ sideFilter?: 'local' | 'cloud' }>
}

let sidebarModes: TanguSidebarModes | null = null

export function setTanguSidebarModes(p: TanguSidebarModes | null): void {
  sidebarModes = p
}

export function readTanguSidebarModes(): TanguSidebarModes | null {
  return sidebarModes
}

/** 「大纲」视图在主区是对话时画的会话目录(核心插件化 2e-6,方案第 5 节 8 号接缝 `registerOutlineProvider` 的仓内版):
 *  Tangu 在激活时交出,宿主的 OutlineView 只管放。**宿主内部接缝**。没交 → 落空态。 */
let chatOutline: ComponentType | null = null

export function setTanguChatOutline(p: ComponentType | null): void {
  chatOutline = p
}

export function readTanguChatOutline(): ComponentType | null {
  return chatOutline
}

/** 被 Agent Desk 托管的视图拿到的悬浮胶囊(10-17 用户选方案 B,方案页 docs/ToBeImproved/AgentDesk方案_2026-10-17/)。
 *  格子里的视图不再画自己的顶栏:读到本 context 就把视图专属控件(编辑/源码、换行、缩放…)portal 进胶囊槽,
 *  次要动作写进 more(⋯ 菜单打开那一刻才读,写 ref 不触发重渲染)。Desk(Tangu)提供,宿主的 WsFileView 读
 *  (核心插件化 2e-6 从 chat2/deskChrome 挪来;放这里是因为两边本来都依赖本文件,也不必为一个 context 拉起文件视图)。 */
export interface DeskChrome {
  /** 胶囊里给视图留的槽;首帧为 null(ref 还没挂上),视图此时什么都不画,也不画自带顶栏。 */
  slot: HTMLElement | null
  more: { current: CtxItem[] }
}
export const DeskChromeContext = createContext<DeskChrome | null>(null)

/** Tangu 的对话视图(核心插件化 2e-7):宿主嵌固定会话的地方(图像工作室、插件聊天 pluginChat、mini 卡片)和
 *  外观预览窗口(#preview)用。Tangu 在激活时交出,**宿主内部接缝**。没交 → 这几处不画对话。 */
export interface TanguChatViews {
  /** 就是注册成 `chat` 的那个视图;props 同注册视图(leaf + params,嵌固定会话传 followActive: false + sessionId)。 */
  Chat: ComponentType<ViewProps>
  /** 外观预览窗口里的样例对话。 */
  Preview: ComponentType
}

let chatViews: TanguChatViews | null = null

export function setTanguChatViews(p: TanguChatViews | null): void {
  chatViews = p
}

export function readTanguChatViews(): TanguChatViews | null {
  return chatViews
}

/** Tangu 交给宿主外壳的界面件(界面热更新 3d):宿主不再直引 Tangu 模块,Tangu 激活时交进来。不看档案一律交 ——
 *  这些以前是宿主静态 import 的,任何档案都有。**宿主内部接缝,不进 `ctx.tangu`**。没交(不走激活的台架页)→ 外壳不画旁聊 / 文件树。 */
export interface TanguShell {
  /** 旁聊:主窗 / 手机挂的宿主(page = 手机全屏页)、设置浮窗式的独立旁聊窗口、浮窗参数 → 种子、把回答投成主区对话的引用 */
  BtwHost: ComponentType<{ page?: boolean }>
  BtwPanel: ComponentType<{ seed: BtwSeed; onClose?: () => void }>
  btwSeedOf(params: Record<string, unknown> | undefined): BtwSeed | null
  quoteInMainChat(text: string): void
  /** 手机:旁聊全屏页此刻是否盖在最上面(切了会话而隐着时不算)、关掉它、变化时回调 */
  btwPageVisible(activeId: string | null): boolean
  closeBtwPage(): void
  subscribeBtw(cb: () => void): () => void
  /** 工作区侧栏的「文件」模式;bumpDir = 让某个目录重新列一次 */
  FilesPanel: ComponentType<ComponentProps<typeof FilesPanel>>
  bumpDir(dir: string): void
  /** 打开 Agents / 项目详情这类特殊视图(新建标签页里的入口) */
  openSpecial(kind: SpecialKind, wsKey?: string): void
}

let shell: TanguShell | null = null

export function setTanguShell(p: TanguShell | null): void {
  shell = p
}

export function readTanguShell(): TanguShell | null {
  return shell
}

/** 宿主外壳里挂旁聊的那一处(Root / MobileRoot 同名,check:parity 按名字对齐):Tangu 没交就不画。 */
export function TanguBtwHost(props: { page?: boolean }): ReactElement | null {
  return shell ? createElement(shell.BtwHost, props) : null
}

/** 往输入框预填的来源(核心插件化 2e-8,方案第 5 节 10 号接缝「Composer2 扩展槽」的仓内版):造物、图像工作室、插件聊天
 *  这些宿主功能往这里登记,Composer2 只在自己的输入卡上问一遍「有没有给我的」,不再反读它们的 store。
 *  来源的待填变了就 notifyComposerPrefill();输入卡等这一轮渲染提交之后再认领(和原来按 store 订阅的 effect 同一时机)。 */
export interface ComposerPrefillTarget {
  /** 认领的那张输入卡;来源按它所在的 DOM(data-image-studio-chat / data-plugin-chat)和是否可见决定给不给。 */
  card: HTMLElement
  /** 卡上的会话;新对话草稿 = null。 */
  sessionId: string | null
}
export interface ComposerPrefill { texts: string[]; attachments?: Attachment[] }
export interface ComposerPrefillSource {
  /** 有给这张卡的就当场取走(只取一次)并返回;没有 = null。 */
  claim(t: ComposerPrefillTarget): ComposerPrefill | null
}

const prefillSources = new Set<ComposerPrefillSource>()
const prefillListeners = new Set<() => void>()

/** 来源登记(通常在它的 store 模块里);返回注销。登记本身也算一次「待填变了」。 */
export function registerComposerPrefill(src: ComposerPrefillSource): () => void {
  prefillSources.add(src)
  notifyComposerPrefill()
  return () => { prefillSources.delete(src) }
}

export function notifyComposerPrefill(): void {
  for (const l of [...prefillListeners]) l()
}

export function subscribeComposerPrefill(l: () => void): () => void {
  prefillListeners.add(l)
  return () => { prefillListeners.delete(l) }
}

/** 按登记顺序问一遍,把给这张卡的都取走。 */
export function claimComposerPrefill(t: ComposerPrefillTarget): ComposerPrefill[] {
  return [...prefillSources].flatMap((src) => src.claim(t) ?? [])
}
