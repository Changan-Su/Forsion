import type { CorePluginUpdates } from '../../shared/corePlugins'
import type { WebsiteRelease } from '../../shared/websiteReleases'
import type { GitPanelStatus, GitRestoreSummary, GitVersion, ProductKind, ProductSummary, ShortcutResult } from '../../shared/products'
/** standalone /agent 契约的前端类型(与包内 routes/eventBus 一致)。 */
import type { ActiveWindowSample } from '../../shared/activeWindow'
import type { DesktopPermissionId, DesktopPermissionRequestOptions, DesktopPermissionsSnapshot } from '../../shared/desktopPermissions'
import type { ComputerHistoryApi } from '../../shared/computerHistory'
export type { DesktopPermissionId, DesktopPermissionRequestOptions, DesktopPermissionsSnapshot, DesktopPermissionState } from '../../shared/desktopPermissions'
// 核心插件化第 2b 步:与 Tangu 共用的数据形状搬进了契约(tangu-agent/src/contracts/clientTypes.ts),这里原样转出,宿主的 import 方不动。
export type { ThinkingLevel, DefaultModelSlot, VisionMode, TanguDesktopConfig, AgentRunEvent, SubChatSeg, SubChat, SessionRecord, PendingApprovalInfo, HistorianActivityItem, AutomationActionSpec, AutomationWhere, MuseTriggerInfo, AgentScheduleEntry, TeamDef, NormalAgentDef, AgentConfig, ChannelKind, WorkspaceDescriptor, MessageRecord, ModelInfo, ModelsResponse, ProjectSettings, ProjectDocInfo, ProjectSkillInfo, ProjectPlanInfo, GitRemoteInfo, GitCommitInfo, GitChangeInfo, GitSummary, GitIdentity, ProjectContext, ProjectMemoryView, SkillInfo, SkillCatalogEntry, ToolsResponse, WorkspaceFileMeta, Attachment, DisplayFile, CtxInfo, ToolEvent, MsgSeg, ApprovalRequest, AnswerBy, ApprovalRemote, ApprovalReason, ApprovalPreviewI18n, InquiryRequest, SketchItem, TodoItem, TeamWork, LiveWait, UiMessage, BackendStatusInfo, StoredDesktopConfig, UnitInfo } from '../../../tangu-agent/src/contracts/clientTypes'
export { THINKING_LEVELS, isHomeSession, SHOW_SYSTEM_PROMPT_KEY, isTeamImageAvatar, isIndependentOrbitConfig, CLOUD_WORKSPACE_KEY, ROOTLESS_WORKSPACE_KEY, DEFAULT_LOCAL_WORKSPACE_KEY, DEFAULT_CLOUD_PROJECT, cloudProjectKey, sessionWorkspaceKey, isProjectIconFile } from '../../../tangu-agent/src/contracts/clientTypes'
import type { AgentScheduleEntry, AutomationActionSpec, AutomationWhere, BackendStatusInfo, StoredDesktopConfig, UnitInfo } from '../../../tangu-agent/src/contracts/clientTypes'

/** 带时间戳的转写结果(仅在调用方显式要 timestamps 时返回;segments 缺席 = 上游给不了)。 */
export interface AsrTimedResult { text: string; segments?: Array<{ start: number; end: number; text: string }> }

/** Computer Use 正在操控的窗口的一帧。active:false = 现在没人在操控(或本平台/本 helper 不支持)。 */
export interface CuLiveFrame {
  active: boolean
  windowId?: number
  pid?: number
  app?: string
  bundleId?: string
  title?: string
  width?: number
  height?: number
  /** JPEG base64(不含 data: 前缀)。缺失 = 本次没取到画面,看 error。 */
  jpegBase64?: string
  /** 这一帧的序号。带回给下次请求,画面没变时 helper 只回 unchanged、不重编 JPEG。 */
  frameSeq?: string
  /** true = 与你上次见到的那一帧相同,本次不含图。 */
  unchanged?: boolean
  ageMs?: number
  error?: string
}

export interface StartRunResult {
  runId: string
  assistantMessageId: string
  userMessageId: string
}

// ── Special Agents（Historian / Muse;本地）──────────────────────────────────
export interface HistorianConfig {
  /** 总结时为尚未设置图标的会话选择 Emoji；旧引擎缺省视为开启。 */
  autoEmoji?: boolean
  enabled: boolean
  modelId: string
  /** 每 x 轮触发一次维护(标题 + 日志/记忆同一节奏)。 */
  everyRounds: number
  firstRoundTrigger: boolean
  /** independent=自己判断并写日志/记忆(默认);assist=分支出后台讨论,由主 Agent 自己定夺并写入(首轮始终 independent);
   *  fork=尾部分叉判官:用会话模型在全量上下文快照上一次补全出判断(缓存对齐),失败自动回落 independent。 */
  mode: 'independent' | 'assist' | 'fork'
  prompt: string
  /** 自进化自动档:判官额外提名「工作笔记候选」进各 Agent 收件箱,/refine 时供其审阅采纳(09-18 起默认开,引擎启动期一次性迁移翻开老配置)。 */
  harnessCandidates: boolean
}
export interface MuseConfig {
  enabled: boolean
  modelId: string
  restartWindowHours: number
  maxRestartsPerWindow: number
  maxIterationsPerCycle: number
  maxTodosPerWindow: number
  supervisorPollMinutes: number
  activeHours: { start: number; end: number } | null
  allowedFolders: string[]
  /** 以下四个是 2026-09-10 加的:旧引擎的 GET /agent/special/config 没有它们,读端按可选处理、UI 显示缺省。
   *  权限档(与普通 agent 审批档对齐):ask=越界排队待批 / agent=默认 agent 代批一次 / auto=全开。 */
  mode?: 'ask' | 'agent' | 'auto'
  /** 心跳间隔(分钟;0=只按日程/规则醒来)。2026-09-11 由小时改分钟;旧引擎仍回 heartbeatHours,读端 ×60 兜底。 */
  heartbeatMinutes?: number
  /** @deprecated 旧引擎字段(小时),只读不写。 */
  heartbeatHours?: number
  /** 通知策略:immediate=逐条进收件箱 / digest=只发日报。 */
  notify?: 'immediate' | 'digest'
  /** 难活升级给哪个 agent(slug;空=不指定)。 */
  escalateTo?: string
}

/** GET /agent/special/muse/library 的一项(Library 相对路径;dir=目录)。 */
export interface MuseLibraryEntry { path: string; size: number; mtime: number; dir: boolean }
export interface SpecialAgentsConfig { historian: HistorianConfig; muse: MuseConfig }
// P1-K10b
/** 引擎给**远程来源**(手机经隧道 / 设备页 / 局域网 / P2P)的 GET /agent/special/config 投影(`remote: true`):只有开关与两个节奏值,
 *  提示词、授权文件夹、模型、活跃时段、预算、通知 / 升级对象这条路由都不回(Muse 的权限档 / 心跳另经 muse/status 可读)。
 *  整份 SpecialAgentsConfig 结构上也满足它 —— 只读这几个字段的调用点用它。 */
export interface SpecialAgentsSummary {
  historian: Pick<HistorianConfig, 'enabled' | 'everyRounds'>
  muse: Pick<MuseConfig, 'enabled' | 'supervisorPollMinutes'>
}
/** GET /agent/special/config 的回包:本机整份(+ 默认提示词);云端整份形状 + cloud:true;远程来源只有摘要 + remote:true。 */
export type SpecialConfigResponse =
  | { config: SpecialAgentsConfig; defaults?: { historianPrompt: string }; cloud?: boolean; remote?: undefined }
  | { config: SpecialAgentsSummary; remote: true; defaults?: undefined; cloud?: undefined }

export interface MuseTodo {
  id: string
  title: string
  detail: string | null
  status: 'pending' | 'injected' | 'done' | 'dismissed'
  source_session_id: string | null
  created_at: string
}
export interface MuseStatusInfo {
  enabled: boolean
  /** 这四个远程来源拿不到(引擎 routes/special.ts remoteMuseStatusView:设备页 / 手机整端切过去时缺席),读端自己兜底。 */
  hasModel?: boolean
  running: boolean
  restartsThisWindow?: number
  maxRestartsPerWindow?: number
  lastCycleAt: number | null
  lastError?: string | null
  sessionId: string | null
  /** 旧引擎没有下面四个字段(可选,读端兜底)。 */
  mode?: 'ask' | 'agent' | 'auto'
  heartbeatMinutes?: number
  pendingApprovals?: number
  libraryDir?: string
  /** 自建 Space(2026-09-11):插件目录 + 内容戳(变了 → 只重载 agent-muse 插件)。旧引擎无 → undefined = 不同步。 */
  spaceDir?: string
  spaceStamp?: number
  /** Muse 自己定的休眠(set_next_wake,2026-09-24):心跳暂停到这个时刻;null = 醒着。旧引擎无此字段。 */
  sleepUntil?: number | null
  sleepReason?: string | null
}

/** POST /agent/special/muse/triggers 的 upsert 入参(snake_case 对齐引擎校验)。
 *  actions:数组=设置;null=显式清空(回到 Muse/agentSlug 旧语义);缺席=保留旧值。 */
export interface MuseTriggerUpsert {
  id?: string
  /** 谁发起的这次 upsert(引擎按它决定「能不能把停用的规则开回来」):
   *  'plugin-ensure' = 插件每次 setup 的**幂等重放**(不是用户意图)—— 引擎自动停用(排空封顶断环 / 配置错误)
   *  与用户显式停用都不许被它开回来,否则安全闸每次启动自动松开、停用原因还被抹掉;
   *  'user' = 面板启停 / 构建器保存这种**显式**操作,可以开回来,且停用会记成 disabledBy='user';
   *  缺席 = 「没人认领」的停用(如宿主禁用插件时逐条关的),照旧能被后续 ensure 开回来 ——
   *  那正是「用户重新启用插件 → setup 再 ensure 一次 → 规则复活」这条既有生命周期,别给它加 actor。 */
  actor?: 'plugin-ensure' | 'user'
  desc: string
  cond_type: 'file_chars_gte' | 'event_seen' | 'daily_at' | 'at' | 'every' | 'manual' | 'db_changed'
  path?: string
  n?: number
  match?: string
  time?: string
  datetime?: string
  interval?: string
  event?: 'row_added' | 'cell_changed'
  vault?: string
  column_id?: string
  /** cell_changed 多列监听(与 column_id 取并集;引擎去重排序,单列归回 columnId)。⚠️与 column_id 同为整量 upsert 的一部分,漏发即抹列。 */
  column_ids?: string[]
  equals?: string
  /** db_changed 附加条件(与 equals AND;row_added / cell_changed 都可用)。⚠️空数组一律发 undefined,
   *  否则引擎按 JSON 比对认为 cond 变了 → 每次保存都重置游标/冷却。 */
  where?: AutomationWhere[]
  prompt?: string
  cooldown_hours?: number
  agent_slug?: string
  enabled?: boolean
  actions?: AutomationActionSpec[] | null
}
/** GET /agent/special/automation/actions 的目录项(tool_call 步骤选择器+参数表单生成)。 */
export interface AutomationActionCatalogItem {
  name: string
  description: string
  parameters: { type?: string; properties?: Record<string, { type?: string; description?: string; enum?: string[] }>; required?: string[] }
  dangerous?: boolean
}
/** 动作链执行账本行(GET /agent/special/automation/executions)。 */
export interface AutomationExecutionInfo {
  id: string
  trigger_id: string
  origin: 'auto' | 'manual' | string
  status: string
  steps: { type: string; tool?: string; ok: boolean; summary: string }[]
  error: string | null
  created_at: string
}
/** agent 自动化的常驻会话(每规则一条;运行历史=该会话的 runs)。 */
export interface AutomationSessionInfo {
  id: string
  title: string
  triggerId: string | null
  agentSlug: string | null
  created_at: string
  updated_at: string
}
export interface AutomationRunInfo {
  id: string
  status: string
  tokens_total: number | null
  error: string | null
  created_at: string
  updated_at: string
}

/** GET /agent/special/schedule 的单个 agent 日程(db=DbFile 原样,Calendar 合成只读源用)。 */
export interface AgentScheduleInfo {
  slug: string
  name: string
  db: {
    version: number
    name: string
    columns: { id: string; name: string; type: string }[]
    rows: { id: string; cells: Record<string, unknown> }[]
  }
  entries: AgentScheduleEntry[]
}
/** POST /agent/special/schedule/:slug/entries 的 upsert 入参。 */
export interface AgentScheduleEntryUpsert {
  id?: string
  name: string
  date?: string
  repeat?: string
  auto?: boolean
  prompt?: string
  description?: string
  todo?: boolean
}

/** 默认 Agent slug(无 agentSlug 时后端落此;新会话选择器默认高亮)。 */
export const DEFAULT_AGENT_SLUG = 'xyra'

/** 丝滑光标开关(localStorage,**缺席=关**;smoothCaret.ts 全局模块 + 设置→外观)。 */
export const SMOOTH_CARET_KEY = 'forsion_tangu_smooth_caret'
/** 划线条的排法(localStorage,**缺席 = 'tools'**:本视图的工具在前;'actions' = 动作在前。selectionActions.ts + 设置→外观)。 */
export const SELECTION_BAR_ORDER_KEY = 'forsion_selection_bar_order'
/** UI 缩放(uiZoom.ts 真源;放这儿是为了让跨窗同步的白名单不必反向依赖 uiZoom)。 */
export const UI_ZOOM_KEY = 'forsion_ui_zoom'
/** 界面语言(i18n.tsx 真源;同上)。 */
export const LOCALE_KEY = 'tangu_locale'

/** 界面字体三档(localStorage,**缺席=跟随主题**;uiFont.ts + 设置→外观)。 */
export const FONT_UI_KEY = 'forsion_tangu_font_ui'
export const FONT_BODY_KEY = 'forsion_tangu_font_body'
export const FONT_MONO_KEY = 'forsion_tangu_font_mono'

/** Agent 列表的全局 meta:展示顺序 + 用户选定的默认 agent。 */
export interface AgentsMeta { order: string[]; defaultSlug: string }

/** ~/.tangu/providers.json 一项(desktop Providers 页编辑;apiKey 只在本机文件,不进 renderer 之外)。 */
export interface DirectProviderConfig {
  providerId: string
  baseUrl: string
  apiKey?: string
  modelIds?: string[]
  /** 该 provider 的生图模型 id(OpenAI 兼容 /images/generations;generate_image 用)。 */
  imageModelIds?: string[]
  /** 该 provider 的语音合成模型 id(OpenAI 兼容 /audio/speech;朗读用)。 */
  ttsModelIds?: string[]
  /** 该 provider 的语音识别模型 id(OpenAI 兼容 /audio/transcriptions;语音输入用)。 */
  asrModelIds?: string[]
  /** 该 provider 里**没有**多模态的模型(黑名单;默认都算能看图)。命中的模型遇图转交辅助视觉模型。 */
  noVisionModelIds?: string[]
}

/** 「设置 → Git」(引擎 config.json 的 git 段):PROJECT 详情的 git 动作与 agent 自己建分支 / 写提交时都照它。 */
export interface GitSettings {
  branchPrefix: string
  commitInstructions: string
  forceWithLease: boolean
  /** 提交身份:只在这台电脑的 git 没配名字 / 邮箱时用;空 = 由 Forsion 账号推出来。 */
  identityName: string
  identityEmail: string
}

// ── 跨生态 agent 资产发现(desktop discovery:scan;~/.claude、~/.codex、~/.hermes)──

export type DiscoveryEcosystem = 'claude-code' | 'codex' | 'hermes'

export interface DiscoveredSkill {
  ecosystem: DiscoveryEcosystem
  id: string
  name: string
  description: string
  sourceDir: string
}

export interface DiscoveredMcp {
  ecosystem: DiscoveryEcosystem
  name: string
  config: McpServerConfigEntry
}

export interface DiscoveryResult {
  skills: DiscoveredSkill[]
  mcpServers: DiscoveredMcp[]
}

/** 环境检测一项(首启向导;installId 为 env:run 的 opaque 凭据)。 */
export interface EnvProbeResult {
  tool: string
  found: boolean
  version: string | null
  installId: string | null
  installCommand: string | null
  /** 缺失时的手动下载页(老宿主没有这个字段)。 */
  downloadUrl?: string | null
}

/** 镜像连通性测试结果(每个 registry 目标一行)。 */
export interface MirrorTestResult {
  mirror: 'default' | 'china'
  targets: Array<{ name: string; url: string; ok: boolean; status: number; latencyMs: number; error?: string }>
}

/** ~/.tangu/mcp.json 一项。 */
export interface McpServerConfigEntry {
  command?: string
  args?: string[]
  env?: Record<string, string>
  url?: string
  transport?: 'stdio' | 'http' | 'sse'
  headers?: Record<string, string>
  timeoutMs?: number
  enabled?: boolean
}

/** 官网更新动态的一篇(forsion.net/releases;主进程校验过形状)。 */
export type { WebsiteRelease }

/** 应用内自动更新状态(electron-updater 经 'updater:status' 广播;mac 仅检测)。 */
export interface UpdaterStatusInfo {
  phase: 'idle' | 'checking' | 'available' | 'not-available' | 'downloading' | 'downloaded' | 'error' | 'unsupported'
  version?: string
  releaseNotes?: string
  /** 同一节的英文版(CHANGELOG.en.md);没有就只有 releaseNotes */
  releaseNotesEn?: string
  percent?: number
  /** 'unreachable' = 官网和 GitHub 都没答上 */
  error?: string
  /** 这次从哪儿下(官网 / GitHub) */
  source?: 'website' | 'github'
  /** 安装包字节数(知道才有) */
  size?: number
  transferred?: number
  total?: number
  /** 自动换过源:原来那边 */
  fallbackFrom?: 'website' | 'github'
  /** 下载中能手动换到另一边 */
  canSwitch?: boolean
  /** mac:已在浏览器里开了 .dmg 的下载链接 */
  opened?: boolean
}

/** 已配对的来访设备(本机 unitWeb 的 T1 局域网配对;令牌只存 hash)。 */
export interface UnitPairedDevice {
  id: string
  name: string
  createdAt: number
}

export interface AuthAccountInfo {
  id: string
  cloudUrl: string
  username?: string
  nickname?: string
  active: boolean
}

export interface AuthStatusInfo {
  accountId?: string | null
  loggedIn: boolean
  /** token 是否仍有效:true=有效,false=已失效(401/403),null=未校验/离线(不确定)。用于检测登录过期。 */
  tokenValid?: boolean | null
  cloudUrl: string
  username: string | null
  nickname?: string | null
  avatar?: string | null
  membershipTier?: string | null
  tokenSource: 'tangu-login' | null
  /** managed 模式下的引擎进程态;null=external/无 agent 后端形态(前端不渲染引擎态)。 */
  backendState?: 'stopped' | 'starting' | 'ready' | 'crashed' | null
}

/** 插件沙箱(electron/pluginSandbox.ts;契约 tangu-agent/docs/plugin-sandbox.md)。 */
export interface PluginSandboxResult { ok: boolean; code?: string; error?: string; text?: string; image?: string }
/** 带给沙箱首屏的界面状态:语言(zh / en)+ 主题那几把 localStorage 键。 */
export interface PluginSandboxUi { locale: string; storage: Record<string, string> }
export interface PluginSandboxState {
  running: boolean
  pluginId?: string
  name?: string
  version?: string
  dir?: string
  sessionId?: string
  status?: import('../../../tangu-agent/src/contracts/pluginSandbox').SandboxStatus | null
}
export interface PluginSandboxReport { note: string; sessionId?: string; pluginId: string; name: string }
export interface PluginSandboxApi {
  /** ui.storage = 本窗的主题键(沙箱首屏照着画);语言由主进程按自己的界面语言给。deadline = 引擎给这次动作的期限(Date.now() 毫秒),排队排过了主进程就不做了。 */
  exec(op: string, args: Record<string, unknown>, origin: { sessionId?: string; deadline?: number; ui?: { storage: Record<string, string> } }): Promise<PluginSandboxResult>
  state(): Promise<PluginSandboxState>
  show(): Promise<boolean>
  stop(): Promise<void>
  reset(): Promise<PluginSandboxResult>
  /** 「安装到我的 Forsion」:主进程先弹确认框;用户取消 = cancelled。 */
  install(): Promise<{ ok: boolean; pluginId?: string; error?: string; cancelled?: boolean }>
  onChanged(cb: (s: PluginSandboxState) => void): () => void
  onReport(cb: (r: PluginSandboxReport) => void): () => void
}
export interface PluginSandboxSelf {
  pluginId: string
  name: string
  version: string
  dir: string
  appVersion: string
  ui?: PluginSandboxUi
}

/** preload 注入的 window.tangu(浏览器内调试时缺省,backend/auth 能力按需探测)。 */
declare global {
  interface Window {
    tangu?: {
      /** 宿主平台('darwin' | 'win32' | 'linux');静态值,渲染层据此调标题栏留白。 */
      platform?: string
      /** 只读状态检查:不安装 helper、不触发系统授权。 */
      desktopPermissionsStatus?(): Promise<DesktopPermissionsSnapshot>
      /** 仅由用户点击触发:打开系统授权引导;Computer Use 缺失时安装/启动。 */
      desktopPermissionRequest?(id: DesktopPermissionId, options?: DesktopPermissionRequestOptions): Promise<DesktopPermissionsSnapshot>
      /** 用户主动验证 Computer Use,可能探测实际屏幕访问。 */
      desktopPermissionsVerify?(): Promise<DesktopPermissionsSnapshot>
      /** 仅由用户点击触发:清掉这一项 Computer Use 权限的旧授权记录(tccutil reset)、重启助手并重新登记,等同系统设置里的「−」再「+」。 */
      desktopPermissionRepair?(id: DesktopPermissionId, options?: DesktopPermissionRequestOptions): Promise<DesktopPermissionsSnapshot>
      /** 离开权限页关闭指导窗;main 同时处理尚未完成的 request 取消竞态。 */
      desktopPermissionsCloseGuide?(): Promise<void>
      /** 插件沙箱的控制面:只有用户那份桌面 Forsion 有(沙箱自己、web、mobile 都没有)。 */
      pluginSandbox?: PluginSandboxApi
      /** 本进程就是插件沙箱:自身信息 + 沙箱条上的按钮(报告问题 / 安装 / 重置)转给父进程。普通实例没有这个键。 */
      sandbox?: { self: PluginSandboxSelf; action(a: 'report' | 'install' | 'reset', note?: string): Promise<boolean>; changed(): void }
      /** 电脑历史(主进程 electron/computerHistory.ts);无 agent 后端的产品形态没有这个键。 */
      computerHistory?: ComputerHistoryApi
      /** Tangu Web(浏览器云端客户端)标志:由 web 垫片注入;共享组件据此解闸云端可用特性(如技能)。 */
      cloudWeb?: boolean
      /** 移动端(Capacitor/Android)标志:由 mobile 垫片注入;Inbox 等据此走设备本地存储实现。 */
      mobile?: boolean
      /** 安卓 App:桌面图标能跟随**内置**应用图标(Android 只能在安装包自带的图标之间切换);mobile 垫片注入。 */
      launcherIcon?: boolean
      /** unit 设备页标志(B 端渲染,unitShim 注入):本页是另一台设备曝出来的 Forsion 面 ——
       *  插件清单走对方的 unit/plugins,无 vault 桥(本地 vault 面 = v2.1)。 */
      unitPage?: boolean
      /** 服务器 Unit 自己的网页主入口(/web/ 这类 projection=public 的投射,unitShim 注入;与 unitPage 同在)。
       *  页面账号就是来访者本人,所以 Forsion Extend 的账号 / 商店页在这里放行;看别的设备的设备页没有这个标志,照旧挡住。 */
      unitPublicEntry?: boolean
      /** 设备页以**远端身份**驱动对方的引擎(unitShim 注入;便携 Unit 的工作区主人 projection=local 不算):
       *  引擎按远程钳制 —— 审批改参数被拒(REMOTE_ARGS_OVERRIDE_FORBIDDEN)、「总允许」降成单次,界面据此收起这两样。 */
      remoteCaller?: boolean
      /** A local engine sharing the active vault filesystem. Cloud/virtual vaults never qualify. */
      executionCapabilities?: { host: boolean }
      /** Explicit host filesystem availability; published cloud Units set false. */
      hostFiles?: boolean
      /** Verified account config installed synchronously before stores initialize. */
      initialConfig?: StoredDesktopConfig
      account?: import('./amadeus/plugins/types').PluginAccount
      /** Verified Extend renderer is bundled with the mobile host. */
      extendMobile?: boolean
      getConfig(): Promise<StoredDesktopConfig>
      documentTasks?: import('../../shared/documentTasks').DocumentTaskClaimsApi
      setConfig(patch: Partial<StoredDesktopConfig>): Promise<StoredDesktopConfig>
      backendStatus?(): Promise<BackendStatusInfo>
      backendLogs?(): Promise<string[]>
      backendRestart?(): Promise<BackendStatusInfo>
      onBackendStatus?(cb: (st: BackendStatusInfo) => void): () => void
      onConfigChanged?(cb: () => void): () => void
      // ── 设备互联(Forsion Unit):名册 + 本机 host 状态(token 留主进程,渲染层只拿结果)──
      unitsList?(): Promise<{ status: number; json: { units?: UnitInfo[] } | null }>
      /** 系统浏览器开中转引导页:main 代拼 `#token=` 登录态递交(forsion_token 不下发渲染层)。 */
      unitsOpenInBrowser?(unitId: string): Promise<void>
      unitsUpdate?(id: string, patch: { name?: string; icon?: string }): Promise<{ status: number; json: any }>
      unitsRemove?(id: string): Promise<{ status: number; json: any }>
      unitHostStatus?(): Promise<{ running: boolean; connected: boolean; unitId: string | null; lastError: string | null; webPort: number | null; lanUrl: string | null }>
      /** 本机已配对的来访设备(T1)与回收。 */
      unitsPairedList?(): Promise<UnitPairedDevice[]>
      unitsPairedRemove?(id: string): Promise<{ ok: boolean }>
      /** LAN 直连探针(主进程发,免 CORS):是台 unitWeb 就回 meta,否则 null。 */
      unitsProbeLan?(lanUrl: string): Promise<{ instanceId: string; name: string } | null>
      /** P2P 直连打开设备:成了回本机代理地址;失败 reject(UI 回落中转)。 */
      unitsP2pOpen?(id: string): Promise<{ url: string }>
      /** 桌面作为调用方(新会话建到账号下另一台电脑上):主进程本机中转口的地址 + 本次启动的口令(electron/unitRelay.ts)。
       *  forsion_token 不下发渲染层 —— 渲染层拿这枚口令打中转口,主进程换上云端凭据与调用方票再发往 hub 隧道。没登录 → null。
       *  只有桌面壳有;手机走原生中继、网页版手里本来就有 forsion_token。 */
      unitRelay?(): Promise<{ base: string; token: string; accountId: string | null } | null>
      // P1-K8 ── 手机本机作为 Unit(调用方)的身份:只在移动端 mobileShim 注入(web 路径回「仅安卓 App」)。
      // 远端引擎请求的调用方票由原生中继透明附加(window.fetch 前置),票与凭据永不进 JS;中继模式下
      // 刻意没有 unitCallerHeaders(INTEGRATION R-05,那是桥模式的接缝)。relay:'unsupported' = 原生缺席或
      // 启动断言 cloudApiBase ≠ 原生 apiBase,中继面上的请求一律合成 503 CALLER_UNSUPPORTED;'native_only' = 不是安卓 App。
      unitSelf?(): Promise<{ registered: boolean; unitId: string | null; name: string | null; relay?: 'ready' | 'unsupported' | 'native_only' }>
      /** 懒登记:没登记过才登记(kind='phone');失败 code:native_only / caller_unsupported / not_signed_in / no_api_base / network / server_<status> / storage。 */
      unitEnsureSelf?(): Promise<{ ok: true; unitId: string; name: string } | { ok: false; code: string }>
      /** 删本机条目并尽力从名册移除;之后各电脑对这台手机的授权都失效(按 unit id 认)。 */
      unitForgetSelf?(): Promise<{ ok: boolean }>
      // P1-DL ── 安卓 App 把字节存进系统公共「下载」(MediaStore.Downloads,Android 10+,原生 DownloadsPlugin 分块写)。
      // 只有 mobileShim 的 native 路径注入;desktop / web / 移动端 dev 缺席 → 调用方回落 `<a download>`(见 services/nativeDownload.ts)。
      // 回的 name 是 MediaStore 实际落下的显示名(同名去重成 `x (1).txt`)。上限 50 MB;reject 的 code:
      // too_large / unsupported_os(Android 8–9)/ busy / not_found / bad_request / io。
      saveDownload?(name: string, mime: string, data: Blob): Promise<{ name: string }>
      // P1-K5 ── 设备凭据存储状态(SecretStorageNotice;远程会话开关按它置灰)──
      secretStorageStatus?(): Promise<import('../../shared/secretStorage').SecretStorageStatus>
      secretStorageRetry?(): Promise<import('../../shared/secretStorage').SecretStorageStatus>
      /** 主进程先核「配对锁定」、再弹原生确认框;没锁定 / 这次运行加密不可用时 reject。 */
      secretStorageResetUnitPairing?(): Promise<import('../../shared/secretStorage').SecretStorageStatus>
      /** 只在 restartRequired 时放行:重启 Forsion(进程内的重试救不回钥匙串被拒绝)。 */
      secretStorageRelaunch?(): Promise<import('../../shared/secretStorage').SecretStorageStatus>
      // P1-K4 ── 「允许远程会话」开关 / 信任列表 / 远程会话最高审批档(主进程 electron/remoteSessions.ts;设备页 / web / 手机没有)──
      remoteSessions?: import('../../shared/remoteSessions').RemoteSessionsApi
      /** 设置 → 快捷键录制 / 按键查找期间挂起主进程全局快捷键(electron/globalHotkeyPause.ts);只有桌面端有。 */
      shortcuts?: { pauseGlobal(on: boolean): Promise<void> }
      // P1-K2 ── 急停 / 远程锁定(主进程 electron/remoteSafety.ts;设备页 / web / 手机没有)──
      remoteSafety?: import('../../shared/remoteSafety').RemoteSafetyApi
      // P1-K6 ── unit 目标的调用方头接缝(INTEGRATION R-05;§2.2 把声明记在 K8 的块里,消费方 services/engine/targets.ts 先落地,
      //   所以 K6-S2 先在这里声明)。⚠️ 保持**方法签名**:K8 合入时在自己的块里再声明一次(方法或属性签名皆可)= 重载合并,
      //   不报 TS2300(tsc 实测:只有「属性 + 属性」才重复标识符);K8 合入后二者留一即可,这一条可删。──
      /** 手机原生层给经 hub 隧道打「我的电脑」的请求现取调用方头(只认 `X-Forsion-Caller`)。K8 **桥模式**才实现;
       *  中继模式缺省(原生层自己附头)→ 渲染层不带头。实现了却抛错 / 拒绝 / 给不出有效的 X-Forsion-Caller = 失败关闭,请求不发。 */
      unitCallerHeaders?(unitId: string): Promise<Record<string, string>>
      authStatus?(): Promise<AuthStatusInfo>
      forsionLogin?(cloudUrl?: string): Promise<{ ok: boolean; cloudUrl: string }>
      forsionLogout?(): Promise<{ ok: boolean }>
      authAccounts?(): Promise<AuthAccountInfo[]>
      forsionSwitchAccount?(accountId: string): Promise<{ ok: boolean; cloudUrl: string }>
      authProviders?(): Promise<Array<{ id: string; loggedIn: boolean }>>
      providerLogin?(id: string): Promise<{ ok: boolean; id: string }>
      openAccountCenter?(section?: string): Promise<{ ok: boolean }>
      /** 打开会员购买页({cloudUrl}/pay?tab=membership,token 主进程拼接)。 */
      openPayCenter?(): Promise<{ ok: boolean }>
      /** 头像菜单额度视图(GET /api/token-quota/my 透传,含 resetCards)。 */
      accountQuota?(): Promise<{ status: number; json: any }>
      /** 用掉一张限额重置卡(今日+本周已用清零)。 */
      /** 周卡 2026-08-05 下线,只收缺省或 'both'。 */
      accountUseResetCard?(type?: 'both'): Promise<{ status: number; json: any }>
      /** 后台额度:从主额度等额转入 limit×percent%(本周期有效;POST /api/token-quota/background/convert)。 */
      accountBgConvert?(percent: number): Promise<{ status: number; json: any }>
      /** 后台额度用尽后改用主额度继续(开关;POST /api/token-quota/background/auto-main)。 */
      accountBgAutoMain?(enabled: boolean): Promise<{ status: number; json: any }>
      /** 以当前用户身份调 Forsion 云端 API(只收相对路径,主进程拼 cloudUrl 并盖 token;token 不下发渲染层)。
       *  返回 { status, json } 或 { status: 0, error }(0 = 没发出去:未登录 / 地址非法 / 网络断)。timeoutMs 缺省 15s,上限 120s。 */
      cloudFetch?(req: { path: string; method?: string; body?: unknown; timeoutMs?: number }): Promise<{ status: number; json?: any; error?: string }>
      /** 网页版专用(webShim):协议更新状态 GET /api/auth/terms 与确认 POST /api/auth/terms/agree。
       *  桌面 / Android 走 cloudFetch;网页版不给 cloudFetch(有它会顺带打开只给桌面的成就 / 插件数据同步)。见 components/TermsUpdateDialog。 */
      termsStatus?(): Promise<{ status: number; json?: any }>
      termsAgree?(version: string): Promise<{ status: number; json?: any }>
      /** Forsion Extend 渲染半身调它自己主进程半身注册的通道;宿主通道一律拒。没装载 Extend 就没有这个键。 */
      cloudInvoke?(channel: string, ...args: unknown[]): Promise<unknown>
      /** 提交反馈到 Forsion 反馈中心(会话日志 JSON 随附为附件;token 留主进程)。 */
      submitFeedback?(input: { description: string; sessionLogJson?: string; sessionLogName?: string }): Promise<{ ok: boolean; id?: string | null; error?: string; attachmentSkipped?: boolean }>
      appVersion?(): Promise<string>
      /** 应用内自动更新:检查 / 下载 / 重启安装(mac 的 download/install 为 no-op,改用 openUpdateInstaller)。 */
      getCorePluginUpdates?(): Promise<CorePluginUpdates>
      onCorePluginUpdates?(cb: (status: CorePluginUpdates) => void): () => void
      checkForUpdates?(): Promise<UpdaterStatusInfo>
      getUpdaterStatus?(): Promise<UpdaterStatusInfo>
      restartForUpdate?(): Promise<{ ok: boolean }>
      downloadUpdate?(): Promise<void>
      installUpdate?(): Promise<{ ok: boolean }>
      /** 测试版通道开关(缺省关)。开了才收 x.y.z-beta.N;关着两层都隔离:
       *  Win/Linux 读的是 latest.yml 而非 beta.yml,mac 打的是 /releases/latest(按定义排除 prerelease)。 */
      getUpdateBeta?(): Promise<boolean>
      setUpdateBeta?(on: boolean): Promise<{ ok: boolean }>
      /** 下载来源:auto = 按地区(大陆官网、其他地区 GitHub);有没有新版始终看官网。 */
      getUpdateSource?(): Promise<'auto' | 'website' | 'github'>
      setUpdateSource?(v: 'auto' | 'website' | 'github'): Promise<{ ok: boolean }>
      /** 这台电脑在不在中国大陆(null = 没探出来)。 */
      getUpdateRegion?(): Promise<boolean | null>
      /** 下载中换到另一边。 */
      switchUpdateSource?(): Promise<boolean>
      /** mac:在浏览器里开这一版 .dmg 的下载链接。 */
      openUpdateInstaller?(): Promise<boolean>
      /** What's new 弹窗正文:官网更新动态的已发布快照;拿不到 = null(退回打包的 CHANGELOG)。 */
      getWebsiteReleases?(): Promise<WebsiteRelease[] | null>
      /** 请主窗弹出 What's new(设置是独立浮窗,在那里点也要弹在主窗)。 */
      openWhatsNew?(): void
      onOpenWhatsNew?(cb: () => void): () => void
      onUpdaterStatus?(cb: (st: UpdaterStatusInfo) => void): () => void
      /** 应用内清空数据(卸载/重置);清完主进程 relaunch。 */
      clearAppData?(opts: { desktop?: boolean; tangu?: boolean }): Promise<{ ok: boolean }>
      /** 走正常退出链后重新拉起(插件页「重启以生效」)。 */
      relaunchApp?(): Promise<void>
      /** 带主进程半身的内置包(Forsion Extend)启停:只改下次开机装不装,回是否待重启。设备页没有这座桥。 */
      setBundleEnabled?(id: string, on: boolean): Promise<{ restartPending: boolean }>
      /** 主题请求窗口级材质;system-glass 在 macOS 映射为可取样窗口后方的高透原生 vibrancy。 */
      startupAppearance?: {
        readonly prefersReducedMotion?: boolean
        readonly softwareRendering?: boolean
        /** Resolves with the time the window came on screen (0 when it already was). */
        whenShown?(): Promise<number>
        initial: import('../../shared/startupAppearance').StartupAppearance
        update(patch: import('../../shared/startupAppearance').AppearancePatch, clearPlugin?: string): Promise<import('../../shared/startupAppearance').StartupAppearance>
        subscribe(cb: (value: import('../../shared/startupAppearance').StartupAppearance) => void): () => void
      }
      setWindowMaterial?(input: { material: 'opaque' | 'system-glass'; mode: 'light' | 'dark'; backgroundColor?: string }): Promise<{ ok: boolean }>
      setTabTitleBar?(input: { height: number; symbolColor: string }): Promise<{ ok: boolean; fullscreen?: boolean }>
      onTabTitleBarFullscreen?(cb: (fullscreen: boolean) => void): () => void
      onAuthDevice?(cb: (info: { url: string; userCode: string }) => void): () => void
      /** 登录态变化(桌面登录/登出、CLI `tangu login` 等外部来源)→ 刷新账号卡/authInfo。 */
      onAuthChanged?(cb: (info: { loggedIn: boolean }) => void): () => void
      onAuthWillChange?(cb: () => Promise<void>): () => void
      /** 截当前窗口的一块视口矩形(Agent Desk 截屏 → 引擎 desk_screenshot);失败返回 null。 */
      sampleAmbientPalette?(rect: import('../../shared/ambientPalette').AmbientRect): Promise<import('../../shared/ambientPalette').AmbientPalette | null>
      captureRect?(rect: { x: number; y: number; width: number; height: number }): Promise<string | null>
      /** purpose:'project' = 添加 / 导入项目:主进程把选中的目录登记为本机确认过的项目根(设备页 /unit/host* 只认这些会话目录);
       *  其余用途(技能导入、同步目录、额外可写根…)不传,不登记。 */
      pickDirectory?(opts?: { purpose?: 'project' }): Promise<string | null>
      /** Chat Box 添加文件或文件夹；取消返回空数组。 */
      pickPaths?(): Promise<Array<{ path: string; isDirectory: boolean }>>
      /** Android:系统文件选择器选文件(内容随回,不是路径);取消返回空数组。原生半屏里没有用户激活,
       *  `<input type=file>.click()` 会被 Chromium 静默丢掉 —— 有这个能力时 Chat Box「添加文件」走它。 */
      pickFiles?(): Promise<File[]>
      /** Android:系统照片选择器(只列图片) / 系统相机拍一张。同上:内容随回,取消或没拍成返回空数组;
       *  两个都在时,Chat Box 的原生「＋」半屏把「添加文件」拆成 拍照 / 相册 / 文件 三行。 */
      pickPhotos?(): Promise<File[]>
      takePhoto?(): Promise<File[]>
      /** 另存为文本文件(导出日志等);取消返回 { ok:false }。 */
      saveTextFile?(defaultName: string, content: string): Promise<{ ok: boolean; path: string | null }>
      /** 用户活动日志埋点(fire-and-forget;拼行/消毒在 main 侧 activityLog.ts)。 */
      act?(event: string, detail?: Record<string, unknown>): void
      /** 导出近 days 天活动日志拼接文本。 */
      exportActivity?(days?: number): Promise<string>
      /** 前台窗口采样(host-only 接缝)。主进程 activeWindowEnabled 关着时恒 null —— 默认拒。 */
      activeWindow?(): Promise<ActiveWindowSample | null>
      /** 本窗口订阅着的在飞 run 数 → 主进程「有会话运行时不休眠」(keepAwakeReport.ts 上报)。 */
      reportRunningSessions?(count: number): void
      /** 拖入文件 → 绝对路径(本机模式粘贴路径用)。 */
      getPathForFile?(file: File): string
      /** 本机工作区文件浏览(host cwd)。 */
      listDir?(dirPath: string): Promise<Array<{ name: string; isDir: boolean; size: number; path: string }>>
      /** 单条目 stat(侧栏悬停提示):文件→修改/创建时间;目录→另带直接子项计数。
       *  birthtimeMs=null → 该文件系统给不出创建时间(Linux 常见)。 */
      statPath?(p: string): Promise<{ isDir: boolean; mtimeMs: number; birthtimeMs: number | null; files?: number; folders?: number } | null>
      readHostFile?(filePath: string): Promise<{ mimeType: string; content: string; size: number; mtimeMs?: number; tooLarge?: boolean }>
      /** 用系统默认应用打开(预览不支持的类型)。 */
      openHostPath?(p: string): Promise<{ ok: boolean; error?: string }>
      /** Forsion Clip 手动安装(设置 › 浏览器):复制出包的扩展文件夹 / 打开 Chrome 扩展页;拖拽用 startHostDrag。 */
      clipExtension?: {
        /** update=false 只补缺不动已有副本;用户要(重新)装时传 true 换成随包版本(bundled)。 */
        prepare(update?: boolean): Promise<{ dir: string; version: string; bundled: string } | { error: string }>
        openChromeExtensions(): Promise<{ ok: true } | { ok: false; copied: true; reason: 'no-chrome' | 'unsupported' }>
      }
      /** Coding Space:把工作区目录挂本地静态服务器,返回 origin(iframe 多文件预览)。 */
      codePreviewServe?(rootDir: string): Promise<{ origin: string }>
      /** 单文件 HTML 预览:挂其所在目录到不可猜的令牌根,返回可直接加载的 http URL。 */
      codePreviewServePath?(filePath: string): Promise<{ url: string }>
      /** 无本机路径的 HTML(云沙箱/对话内联):把文本挂到令牌根,同样拿到真实源。 */
      codePreviewServeHtml?(html: string): Promise<{ url: string }>
      codePreviewStop?(): Promise<{ ok: boolean }>
      /** Coding Space 项目根 ~/Forsion/Project(确保存在)。 */
      codeProjectsRoot?(): Promise<string>
      codeStudioWatch?(root: string | null): Promise<{ root: string | null }>
      onCodeStudioChanged?(cb: (change: { root: string; path: string | null; error?: string }) => void): () => void
      codeStudioVersions?(root: string): Promise<Array<{ id: string; name: string; createdAt: number; files: number }>>
      codeStudioSnapshot?(root: string, name: string): Promise<{ id: string; name: string; createdAt: number; files: number }>
      codeStudioRestore?(root: string, id: string): Promise<{ restored: string[]; deleted: string[]; conflicts: string[]; backupId: string }>
      /** git 版本(只给有 git 的用户)。宿主驱动:每轮 agent 结束自动提交 + 手动命名版本;agent 自己不跑 git。 */
      codeStudioGitStatus?(root: string): Promise<GitPanelStatus>
      codeStudioGitVersions?(root: string): Promise<GitVersion[]>
      codeStudioGitCommit?(root: string, input: { name: string; auto: boolean; untitled?: string }): Promise<GitVersion | null>
      codeStudioGitRestore?(root: string, id: string, labels?: { backup?: string; restorePrefix?: string }): Promise<GitRestoreSummary>
      /** 造物(Creations)Space:渲染层只传产物 id,目录由主进程回注册表重解。 */
      productsList?(): Promise<ProductSummary[]>
      productsGet?(id: string): Promise<ProductSummary | null>
      productsEnsure?(dir: string): Promise<ProductSummary | null>
      productsUpdate?(id: string, patch: { name?: string; entry?: string | null; kind?: ProductKind; devLoad?: boolean }): Promise<ProductSummary>
      productsServe?(id: string): Promise<{ origin: string; url: string; product: ProductSummary }>
      /** fallbackName:产物名清洗后为空时用的桌面文件名(落盘产物命名,跟随当前语言)。 */
      productsShortcut?(id: string, fallbackName?: string): Promise<ShortcutResult>
      /** 托管根里的 = 移进废纸篓;原地加入的外部造物 = 只取消登记(unregistered),文件夹不动。
       *  expect = 用户在确认框里同意的那件事(动作 + 卡片列出时那个目录的身份);宿主重解后对不上(期间被挪过 / 换过)就拒绝,得刷新后重新确认。 */
      productsTrash?(id: string, expect: { action: 'trash' | 'unregister'; dirId?: string }): Promise<{ ok: boolean; unregistered?: boolean }>
      /** 在造物的托管根里建一个新作品文件夹(名字宿主清洗 + 撞名接序号)。 */
      productsCreate?(name: string): Promise<{ dir: string; name: string; product: ProductSummary }>
      /** 原地加入造物(不复制、不移动)。within:源的真实路径必须在它里面(strict = 不能就是它本身)。 */
      productsRegister?(source: string, within: string, strict: boolean): Promise<{ ok: true; dir: string; name: string; product: ProductSummary } | { ok: false; code: 'invalid_source' | 'forbidden_source' | 'outside' | 'nested'; detail?: string }>
      /** 这个目录是不是造物(托管根的直接子目录 / 原地加入的外部文件夹);只读,不铸身份。 */
      productsIsCreation?(dir: string): Promise<boolean>
      /** 这件产物能否**从应用外**(桌面快捷方式 / forsion:// 深链)拉起:存在、是网页、且用户为它建过快捷方式。 */
      productsExternalLaunchAllowed?(id: string): Promise<boolean>
      productsExternalLaunchNeedsReauth?(id: string): Promise<boolean>
      onDevPluginsChanged?(cb: (change: { pluginIds: string[] }) => void): () => void
      /** Forsion Connect:Coding Space 项目发布到云端托管(主进程持 token 转发)。 */
      connectMeta?(dir: string): Promise<{ slug?: string }>
      connectList?(): Promise<{ ok: boolean; code?: string; detail?: string; base?: string; handle?: string | null; apps?: Array<{ slug: string; name: string; entry: string; status: string; total_bytes: number; updated_at?: string; listing_status?: string | null; listing_summary?: string | null; listing_note?: string | null }>; used?: number; limit?: number; tier?: string }>
      connectPublish?(p: { dir: string; name: string; slug: string; entry: string }): Promise<{ ok: boolean; code?: string; detail?: string; slug?: string; handle?: string; url?: string; used?: number; limit?: number }>
      connectUnpublish?(slug: string): Promise<{ ok: boolean; code?: string; detail?: string }>
      connectListingApply?(p: { slug: string; summary: string }): Promise<{ ok: boolean; code?: string; detail?: string; status?: string }>
      connectListingWithdraw?(slug: string): Promise<{ ok: boolean; code?: string; detail?: string }>
      connectStore?(): Promise<{ ok: boolean; detail?: string; base?: string; items?: Array<{ name: string; summary: string; handle: string; slug: string; url: string; updatedAt?: string }> }>
      /** 写回文本文件(工作区 .md 编辑):原子写;expectedMtimeMs 不符返回 conflict。 */
      writeHostFile?(filePath: string, content: string, expectedMtimeMs?: number, createNew?: boolean): Promise<{ ok?: boolean; conflict?: boolean; mtimeMs: number }>
      /** 本机工作区文件操作(host 模式)。 */
      renameHostPath?(oldPath: string, newName: string): Promise<{ path: string }>
      mkdirHost?(parentDir: string, name: string): Promise<{ path: string }>
      trashHostPath?(p: string): Promise<{ ok: boolean }>
      revealHostPath?(p: string): Promise<{ ok: boolean }>
      /** 设备页(unitShim):经 /unit/hostfile/download 下载对方电脑上的原文件并存下(P1-DL)。桌面没有(桌面用 revealHostPath)。 */
      downloadHostFile?(path: string, name: string): Promise<void>
      startHostDrag?(filePath: string): void
      /** 拖 OS 文件/文件夹进 host 工作区目录 → 复制。 */
      copyHostFiles?(srcPaths: string[], destDir: string): Promise<{ copied: number }>
      /** 复合笔记(X.md + X.fd)成对复制:整套共用一个可用 stem(逐件复制会把两半拆散)。 */
      copyNoteBundles?(items: Array<{ md: string; fd?: string }>, destDir: string): Promise<{ copied: number }>
      /** 拖一行到文件夹 → 移动。 */
      moveHostPath?(srcPath: string, destDir: string): Promise<{ path: string }>
      // ── 内置浏览器 / 内置终端(builtins/)──
      /** 用系统浏览器打开(主进程只放 http(s))。 */
      openExternal?(url: string): Promise<void>
      /** 设备页开在 app 内的 WebView(移动端垫片独有;桌面走 UnitRemoteSurface,web 无此桥)。
       *  缺席即回落 openExternal —— 消费点必须保留那条链,否则旧壳上点了没反应。 */
      openUnitPage?(url: string): Promise<{ ok: boolean }>
      /** 拉外部日历订阅(.ics);走主进程绕开 CORS(订阅地址一律不发 CORS 头)。 */
      fetchIcs?(url: string): Promise<{ ok: boolean; text?: string; error?: string }>
      /** 主页 Bing 壁纸目录(主进程固定目标代理,规避浏览器 CORS;不接受任意 URL)。 */
      wallpaperListBing?(market?: string, count?: number): Promise<{
        ok: boolean
        items: Array<{ id: string; url: string; thumbnailUrl: string; title: string; copyright: string; startDate: string }>
        error?: string
      }>
      /** 主进程回投的外链;渲染层决定进内置浏览器还是系统浏览器。fromGuest = 内置浏览器里的页面自己开的新窗口。返回取消订阅。 */
      onOpenUrl?(cb: (url: string, fromGuest?: boolean) => void): () => void
      /** 内置终端 PTY;spawn 失败(原生模块未就绪)返回 { error } 而非抛。 */
      pty?: {
        /** cmd:带命令启动(`shell -l -c cmd`,退出即 onExit 带退出码);缺省=交互登录 shell。 */
        spawn(opts: { cols?: number; rows?: number; cwd?: string; cmd?: string }): Promise<{ id?: string; shell?: string; error?: string }>
        write(id: string, data: string): void
        resize(id: string, cols: number, rows: number): void
        kill(id: string): void
        onData(id: string, cb: (data: string) => void): () => void
        onExit(id: string, cb: (code: number) => void): () => void
      }
      listProviders?(): Promise<DirectProviderConfig[]>
      saveProvider?(provider: DirectProviderConfig): Promise<DirectProviderConfig[]>
      deleteProvider?(providerId: string): Promise<DirectProviderConfig[]>
      /** 桌面级共享语音转写:音频(base64)→ 文本。任意功能复用;主进程本地/自带-key,不经引擎。 */
      /** timestamps 不传 = 回纯文本(语音输入);传 true = 回 { text, segments }(视频转录要分段时间戳)。 */
      transcribeAudio?(req: { audioBase64: string; mime?: string; modelId?: string; backend?: 'local' | 'cloud'; language?: string }): Promise<string>
      transcribeAudio?(req: { audioBase64: string; mime?: string; modelId?: string; backend?: 'local' | 'cloud'; language?: string; timestamps: true }): Promise<AsrTimedResult>
      /** 按路径转写(几十 MB 音轨不走 base64;主进程直接读盘)。 */
      transcribeAudioFile?(filePath: string, req?: { mime?: string; modelId?: string; backend?: 'local' | 'cloud'; language?: string }): Promise<string>
      transcribeAudioFile?(filePath: string, req: { mime?: string; modelId?: string; backend?: 'local' | 'cloud'; language?: string; timestamps: true }): Promise<AsrTimedResult>
      /** Computer Use:最近被操控窗口的一帧画面。只读——helper 没跑就 active:false,绝不因此拉起它。
       *  仅 macOS(Windows helper 是 stdio 子进程,桌面够不着);拿不到图会带 error 而不是伪造画面。 */
      computerUseLiveView?(opts?: { maxDimension?: number; quality?: number; activeWithinMs?: number; image?: boolean; sinceFrame?: string }): Promise<CuLiveFrame>
      /** 侧边拼接(App Dock,仅 macOS):对话面板贴在别的 App 窗口旁边。open 任何窗口可调(打开面板,先挑窗口);
       *  其余只在面板窗口自己里调得通,别处调回空结果。 */
      appDockOpen?(): Promise<{ ok: boolean; error?: string }>
      appDockReady?(): Promise<import('../../shared/appDock').DockState>
      appDockCandidates?(): Promise<{ windows: import('../../shared/appDock').DockCandidate[]; error?: string }>
      appDockAttach?(target: import('../../shared/appDock').DockWindow): Promise<{ ok: boolean; error?: string }>
      appDockDetach?(): Promise<void>
      /** 应用 / 窗口引用(桌面 macOS 与 Windows;没有这组方法的宿主上引用只显示名字、不可点)。 */
      appRefs?: {
        list(): Promise<import('../../shared/appRefs').AppRefList>
        status(refs: import('../../shared/appRefs').AppRef[]): Promise<import('../../shared/appRefs').AppRefStatus[]>
        open(ref: import('../../shared/appRefs').AppRef): Promise<{ ok: boolean; landed?: 'window' | 'app'; error?: string }>
        frontmost(): Promise<import('../../shared/appRefs').AppRef | null>
        icons(ids: string[]): Promise<Record<string, string | null>>
        setGlobalHotkey?(hotkey: string): void
        snapshot?(ref: import('../../shared/appRefs').AppRef): Promise<{ mimeType: string; data: string } | null>
        takePendingHotkey?(): Promise<import('../../shared/appRefs').AppRef | null>
        onHotkey?(cb: (ref: import('../../shared/appRefs').AppRef) => void): () => void
      }
      appDockSelection?(): Promise<import('../../shared/appDock').DockSelection & { error?: string }>
      onAppDockState?(cb: (state: import('../../shared/appDock').DockState) => void): () => void
      /** 本地语音模型(SenseVoice)状态 / 下载 / 删除 + 下载进度订阅(返回取消函数)。 */
      asrLocalStatus?(): Promise<{ ready: boolean; sizeBytes: number }>
      asrLocalDownload?(): Promise<{ ok: boolean; ready: boolean }>
      asrLocalRemove?(): Promise<{ ok: boolean }>
      onAsrLocalProgress?(cb: (ev: { received: number; total: number }) => void): () => void
      readMcpConfig?(): Promise<{ mcpServers: Record<string, McpServerConfigEntry> }>
      writeMcpConfig?(cfg: { mcpServers: Record<string, McpServerConfigEntry> }): Promise<{ mcpServers: Record<string, McpServerConfigEntry> }>
      discoveryScan?(): Promise<DiscoveryResult>
      discoveryImportSkills?(ids: string[]): Promise<{ imported: string[] }>
      discoveryImportMcp?(names: string[]): Promise<{ imported: string[]; reserved?: string[] }>
      envCheck?(): Promise<EnvProbeResult[]>
      envRun?(installId: string): Promise<{ exitCode: number }>
      envTestMirror?(mirror?: 'default' | 'china'): Promise<MirrorTestResult>
      onEnvOutput?(cb: (ev: { installId: string; line: string }) => void): () => void
      /** Forsion 插件依赖应用一键安装:宿主白名单查表登记,拿 installId 走 envRun;null=无一键命令。 */
      requestKnownAppInstall?(appId: string): Promise<{ installId: string; command: string } | null>
      /** 拖入式主题:列 ~/.tangu/themes/(每项 {id,manifest,css})/ 打开该文件夹。 */
      listThemes?(): Promise<Array<{ id: string; manifest: Record<string, unknown>; css: string }>>
      openThemesDir?(): Promise<{ ok: boolean }>
      /** 设置界面「打开文件夹」:在系统文件管理器打开 agent(slug 缺省=agents 根)/ skills / plugins 目录(仅桌面)。 */
      openAgentDir?(slug?: string): Promise<{ ok: boolean }>
      openSkillsDir?(): Promise<{ ok: boolean }>
      openPluginsDir?(): Promise<{ ok: boolean }>
      /** Forsion Market:浏览(公开)/ 详情含 README / 安装(下载+按类型解压到 ~/.tangu)/ 已装列表。 */
      marketList?(type?: string): Promise<{ items: MarketCard[] }>
      marketRead?(id: string, resource: string, offset?: number): Promise<any>
      marketDetail?(id: string): Promise<MarketDetail>
      marketUpdateStatus?(): Promise<import('../../shared/marketPluginUpdates').MarketPluginUpdates>
      marketSetAutoUpdate?(id: string, on: boolean): Promise<import('../../shared/marketPluginUpdates').MarketPluginUpdates>
      marketCheckUpdates?(): Promise<void>
      onMarketUpdateStatus?(cb: (state: import('../../shared/marketPluginUpdates').MarketPluginUpdates) => void): () => void
      marketInstall?(id: string, version?: string): Promise<{ ok: boolean; path: string; files: number; type: string; slug: string; id?: string }>
      /** 安装进度订阅(主进程只推给发起窗口);返回退订函数。 */
      onMarketInstallProgress?(cb: (ev: MarketInstallProgress) => void): () => void
      marketInstalled?(): Promise<Record<string, Array<{ slug: string; version: string | null; id?: string }>>>
      marketUninstall?(type: string, slug: string): Promise<{ ok: boolean; path: string; type: string; id?: string }>
      /** 本宿主能装的市场类型(缺省 = 全部)。Android App 没有本机引擎 / 主题目录 / Space 目录,只声明 ['amadeus-plugin'];
       *  MarketModal 只列这些类型,其余在发现页一句话说明去桌面端装。 */
      marketTypes?: readonly string[]
      /** 后端插件卸载:列用户目录已装(manifest id→目录名)/ 按 id 删目录(仅 ~/.tangu/plugins,首方插件删不到)。 */
      pluginsUserInstalled?(): Promise<Array<{ id: string; slug: string }>>
      pluginsUninstall?(id: string): Promise<{ ok: boolean }>
      /** 用户自定义 Space:~/.tangu/spaces/<slug>/space.json(数据化布局配方;market type='space' 同目录)。 */
      spacesList?(): Promise<Array<{ slug: string; json: string; plugin?: string; iconUrl?: string }>>
      spacesSave?(slug: string, json: string): Promise<{ ok: boolean }>
      spacesDelete?(slug: string): Promise<{ ok: boolean }>
      /** 收件箱:系统通知(点击回跳 Inbox Space)/ dock 角标(仅 mac 生效)/ 通知点击订阅。 */
      notifyInbox?(title: string, body: string): Promise<void>
      /** 通用系统通知(所有应用内通知同步发);web 下 undefined。meta.event = 哪类通知(NOTIFY_EVENTS 的 id):
       *  桌面不看;安卓(mobile/src/liveIsland.ts)据此给每类只留一条,并略过由灵动岛报的「跑完了」。 */
      notify?(title: string, body: string, meta?: { event?: string }): Promise<void>
      setInboxBadge?(count: number): Promise<void>
      onInboxOpen?(cb: () => void): () => void
      // P1-K3
      /** 远程会话待批的系统通知被点击(主进程 approvalDelivery)→ 打开那条会话。仅桌面壳。 */
      onApprovalOpen?(cb: (p: { sessionId: string }) => void): () => void
      // ── 多窗口:独立窗(拖出的 dockview,无 ribbon)+ mini 悬浮卡片 + floating 面板 ──
      /** 独立窗启动握手:pull 本窗待打开的初始视图(拖出时登记的 {type,params}[];重启已恢复布局则返回空)。 */
      detachedReady?(id: string): Promise<Array<{ type: string; params?: Record<string, unknown> }>>
      /** 开一个独立窗承载给定视图(右键「移到新窗口」/拖到空桌面);screen 坐标可选(拖出落点)。 */
      openDetached?(views: Array<{ type: string; params?: Record<string, unknown> }>, at?: { screenX: number; screenY: number }, opts?: { space?: string }): Promise<{ id: string }>
      cursorScreenPoint?(): { screenX: number; screenY: number }
      /** 开/切换 mini 悬浮卡片。带 sessionId 时定向显示该正式会话,不另建临时会话。 */
      openMini?(opts?: import('../../shared/miniPanel').MiniOpenOptions): void
      /** Open/focus a native Floating Panel window. Undefined on Web/mobile. */
      openFloatingPanel?(opts: import('../../shared/floatingPanel').FloatingPanelOpenOptions): Promise<{ id: string } | undefined>
      floatingReady?(id: string): Promise<import('../../shared/floatingPanel').FloatingPanelOpenOptions | undefined>
      onFloatingTarget?(cb: (opts: import('../../shared/floatingPanel').FloatingPanelOpenOptions) => void): () => void
      /** 已存在的 Mini 窗收到新的会话定向。返回取消订阅。 */
      onMiniTarget?(cb: (opts: import('../../shared/miniPanel').MiniOpenOptions) => void): () => void
      onMiniDockMotion?(cb: (request: import('../../shared/miniDock').MiniDockMotion) => void): () => void
      miniDockMotionDone?(id: number): void
      /** 关闭当前(卫星)窗口。 */
      miniReady?(): void
      reportMiniSession?(context: import('../../shared/miniPanel').MiniSessionContext): void
      miniSessionReady?(sessionId: string): void
      showMainPanel?(target: import('../../shared/miniPanel').MainPanelTarget): void
      onMainPanelTarget?(cb: (target: import('../../shared/miniPanel').MainPanelTarget) => void): () => void
      mainPanelReady?(): void
      requestMainAction?(action: import('../../shared/floatingPanel').MainAction, payload?: string): void
      onMainAction?(cb: (action: import('../../shared/floatingPanel').MainAction, payload?: string) => void): () => void
      /** 界面变更广播给其余窗口(主题/字体/缩放/光标/语言;主进程转发,不回发自己)。 */
      broadcastUi?(state: import('../../shared/uiSync').UiSyncPayload): void
      /** 本窗收到别处的界面变更 → 原样重放。返回取消订阅。 */
      onUiChanged?(cb: (state: import('../../shared/uiSync').UiSyncPayload) => void): () => void
      /** P1-KF:把本窗**生效**界面语言报给主进程(托盘 / 系统通知 / 对话框跟它走)。只有桌面 preload 有;web / 手机 / 设备页缺席 = 不报。 */
      reportUiLocale?(locale: 'zh' | 'en'): void
      closeSelf?(): void
      miniResize?(edge: string | null, start?: boolean, cursor?: { x: number; y: number }): void
      /** 跨窗撕拽:拖拽中实时上报屏幕坐标(主进程命中测试 → 给光标下窗口发落点预览)。节流后调。 */
      dragUpdate?(screenX: number, screenY: number, view: { type: string; params?: Record<string, unknown> }): void
      /** 跨窗撕拽:最终落点路由(命中另一 dockview 窗→并入并返回 routed:true;空桌面→建新独立窗;命中源窗→false 不动)。 */
      dropView?(screenX: number, screenY: number, view: { type: string; params?: Record<string, unknown> }): Promise<{ routed: boolean }>
      /** 本窗收到跨窗拖入的视图(主进程 accept-view)→ 打开在主区。返回取消订阅。 */
      onAcceptView?(cb: (view: { type: string; params?: Record<string, unknown> }) => void): () => void
      /** 本窗收到跨窗拖拽实时预览(主进程 drag-preview;null=离开本窗清除)。返回取消订阅。 */
      onDragPreview?(cb: (at: { localX: number; localY: number } | null) => void): () => void
    }
    /** Amadeus 页面级共享+发布(web=cloudCollab / 桌面=collab IPC;移动 undefined,共享 UI 据此解闸)。 */
    amadeusCollab?: {
      listVaults(): Promise<Array<{ id: string; name: string; role?: string; ownerName?: string | null }>>
      activeVaultId(): Promise<string>
      /** 切活动云库(web=localStorage+reload;桌面=切共享镜像)。 */
      switchVault(id: string): void
      // 同步共享(owner):共享单位 = 页 + 子页面树
      pageShare(path: string): Promise<{ share: AmadeusPageShare | null; quota: AmadeusCollabQuota }>
      createPageShare(path: string, opts: { role?: 'editor' | 'viewer'; expiresDays?: number | null; password?: string | null }): Promise<AmadeusPageShare>
      updatePageShare(id: string, patch: { role?: 'editor' | 'viewer'; password?: string | null; expiresDays?: number | null; rotate?: boolean }): Promise<AmadeusPageShare>
      revokePageShare(id: string): Promise<void>
      setParticipantRole(id: string, userId: string, role: 'editor' | 'viewer'): Promise<void>
      removeParticipant(id: string, userId: string): Promise<void>
      // 参与者
      sharedWithMe(): Promise<Array<{ vaultId: string; path: string; title: string; role: string; ownerName: string | null; localPath?: string }>>
      leaveShare(id: string): Promise<void>
      inviteUrl(token: string): string
      // 发布(公开只读链接)
      publishes(): Promise<{ shares: Array<{ token: string; mode: string; path: string; createdAt: string }>; quota: AmadeusCollabQuota }>
      createPublish(mode: 'page' | 'subtree', path: string): Promise<{ token: string; mode: string; path: string; url: string }>
      revokePublish(token: string): Promise<void>
      /** Public View 跨库撤销：显式带 vaultId（默认变体只作用于 own vault）。 */
      revokePublishIn(vaultId: string, token: string): Promise<void>
      revokePageShareIn(vaultId: string, id: string): Promise<void>
      publishUrl(token: string): string
      /** Public View：跨全部 vault 汇总「我发布的公开链接 + 我创建的页面协作共享」。 */
      listAllShares(): Promise<{
        publishes: Array<{ token: string; mode: string; path: string; createdAt?: string; vaultId: string; vaultName: string }>
        pageShares: Array<Record<string, unknown>>
        linkBase: string
      }>
      // presence
      heartbeat(page: string | null): void
      stopHeartbeat(): void
      onPresence(cb: (list: Array<{ userId: string; username: string; page: string | null; at: number }>) => void): () => void
      myUserId(): string | null
    }
    /** Amadeus 云同步(桌面专属;web/mobile 下为 undefined,设置页/滑块据此隐藏)。 */
    amadeusSync?: {
      get(): Promise<AmadeusSyncStatus>
      setEnabled(on: boolean): Promise<AmadeusSyncStatus>
      syncNow(): Promise<AmadeusSyncStatus>
      /** 放行被删除保护拦下的批量删除(可选:旧 preload 构建下缺位)。 */
      confirmDeletions?(): Promise<AmadeusSyncStatus>
      /** 胶囊滑块:Local↔Cloud 全局切活动 vault;返回与 restoreVault 同形载荷。 */
      switchSide(side: 'local' | 'cloud'): Promise<{ root: string; pages: string[]; folders: string[]; lastPage?: string; side: 'local' | 'cloud' } | null>
      onStatus(cb: (s: AmadeusSyncStatus) => void): () => void
      // ── 按条目云同步(全部可选:旧 preload 构建下优雅缺位) ──
      entrySyncGet?(): Promise<AmadeusEntrySyncState>
      entrySyncEnable?(payload: {
        entries: Array<{ path: string; kind: 'page' | 'folder' | 'asset' }>
        /** 取消勾选的子页面(被条目覆盖但不同步)。 */
        exclude?: string[]
        /** 勾上的子页面:显式解除历史排除。 */
        include?: string[]
        cloudName?: string
        merge?: boolean
      }): Promise<{ ok?: boolean; cloudName?: string; conflict?: string; error?: string }>
      entrySyncDisable?(path: string): Promise<{ ok: boolean }>
      /** 手动设 / 取消 Cloud 侧根文件夹的「同步库分区」标记(Forsion Extend 0.9+)。 */
      entrySyncMark?(name: string, on: boolean): Promise<{ ok?: boolean; error?: string }>
      /** 递归关联闭包(开启弹窗数据源):种子范围外的关联笔记+附件,外加种子页的子页面。 */
      entrySyncClosure?(rootRel: string, kind: 'page' | 'folder'): Promise<{ pages: string[]; files: string[]; subPages: string[] }>
      onEntrySyncChange?(cb: () => void): () => void
      /** 非活动侧(Local↔Cloud 另一侧)的 .db 只读快照,供 Calendar 汇总两侧日历。null = 无另一侧。 */
      otherSideCalDbs?(): Promise<AmadeusOtherSideDbs | null>
    }
    /** 本地库远程同步(remotely-save 式,S3/WebDAV/文件夹;桌面专属,web/mobile 下 undefined)。 */
    remoteSync?: {
      get(): Promise<RemoteSyncState>
      set(patch: Partial<RemoteSyncConfig>): Promise<RemoteSyncConfig>
      run(opts?: { dryRun?: boolean; allowMassDelete?: boolean }): Promise<RemoteSyncReport>
      check(): Promise<{ ok: boolean; error?: string }>
      /** 本机笔记库多大(只估量级)。旧主进程没有。 */
      rootStats?(): Promise<{ files: number; bytes: number; name: string } | { error: string }>
      /** 第二台电脑「用云端那份」:把和云端不一样的文件挪到库外备份(label = 按界面语言的「同步前备份」)。旧主进程没有。 */
      adoptRemote?(label: string): Promise<{ ok: boolean; moved: number; backupDir?: string; error?: string }>
      /** mode:auto = 回环回调自动回填(结果走 onDropboxAuth);manual = 端口起不来,要用户手贴授权码。 */
      dropboxAuthStart(appKey: string): Promise<{ ok: boolean; error?: string; mode?: 'auto' | 'manual'; redirectUri?: string }>
      dropboxAuthFinish(appKey: string, code: string): Promise<{ ok: boolean; error?: string; email?: string; config?: RemoteSyncConfig }>
      onDropboxAuth(cb: (r: { ok: boolean; error?: string; email?: string; config?: RemoteSyncConfig }) => void): () => void
      onStatus(cb: (s: { running: boolean; lastReport: RemoteSyncReport | null; progress: RemoteSyncProgress | null }) => void): () => void
    }
  }
}

/** 执行阶段进度(主进程 150ms 节流广播;key = 当前处理的文件)。 */
export interface RemoteSyncProgress {
  done: number
  total: number
  key: string
}

/** 本地库远程同步配置(镜像 electron/remotesyncIpc.ts 的 RemoteSyncConfig)。 */
export interface RemoteSyncConfig {
  backend: 'off' | 'folder' | 's3' | 'webdav' | 'penzor' | 'dropbox'
  /** 定时同步间隔(分钟);0 = 仅手动。 */
  intervalMin: number
  folder?: { path: string }
  s3?: { endpoint: string; region: string; accessKeyID: string; secretAccessKey: string; bucket: string; prefix?: string; forcePathStyle?: boolean }
  webdav?: { address: string; username: string; password: string; authType?: 'basic' | 'digest'; baseDir?: string }
  penzor?: { vault?: string }
  dropbox?: { appKey: string; refreshToken?: string; accountId?: string; email?: string; baseDir?: string }
  /** 同步方式:both=双向(默认);push=仅上传(增量备份);pull=仅下载(增量还原)。 */
  direction?: 'both' | 'push' | 'pull'
  /** 启动后自动同步一次(15s 后)。 */
  syncOnStart?: boolean
  /** 传输并发(1-16,缺省 4)。 */
  concurrency?: number
  ignore?: string[]
  maxFileMB?: number
}

/** 一次同步的结果(镜像 electron/remotesync/types.ts 的 SyncReport)。 */
export interface RemoteSyncReport {
  ok: boolean
  startedAt: number
  finishedAt: number
  pushed: number
  pulled: number
  deletedLocal: number
  deletedRemote: number
  conflicts: number
  skippedLarge: string[]
  pendingDeletions: number
  errors: string[]
  /** dryRun 时返回完整计划(不执行任何写)。 */
  plan?: Array<{ key: string; kind: 'push' | 'pull' | 'pushDelete' | 'deleteLocal' | 'join' | 'conflict'; same?: true }>
}

export interface RemoteSyncState {
  config: RemoteSyncConfig
  running: boolean
  lastReport: RemoteSyncReport | null
  progress: RemoteSyncProgress | null
  root: string | null
  rootError: string | null
  /** 装机自带 Forsion 官方 Dropbox 应用 → 无需用户填 App Key,点一下即登。 */
  dropboxBuiltin?: boolean
  /** 外置后端(Forsion Extend 注册的 kind,如 'penzor'):选项只列这里有的;老宿主没有这个字段 = 没有外置后端。 */
  backends?: string[]
}

/** 非活动侧日历只读快照(Calendar 汇总另一侧用)。root=另一侧磁盘根;vaultName=显示名(云端/文件夹名)。 */
export interface AmadeusOtherSideDbs {
  root: string
  vaultName: string
  dbs: Array<{ rel: string; source: string }>
}

/** 按条目云同步注册表(镜像 electron/amadeus/sync/entryRegistry.ts)。 */
export interface AmadeusEntrySyncVault {
  vaultRoot: string
  cloudName: string
  entries: Array<{ path: string; kind: 'page' | 'folder' | 'asset' }>
  /** 被条目覆盖但用户剔除的路径(子树语义)。 */
  exclude?: string[]
}

export interface AmadeusEntrySyncState {
  vaults: AmadeusEntrySyncVault[]
  activeRoot: string | null
  cloudRoot: string
  /** 云镜像里带 `.forsion-vault.md` 标记的根级文件夹名(换设备时注册表为空,分区名只能靠它)。 */
  mirrorVaults?: string[]
  /** 标记里记的在同步各库的设备(库名 → 设备;旧的空标记、手动设的分区不在里面)。 */
  mirrorVaultDevices?: Record<string, Array<{ id: string; name: string; since?: string }>>
  /** 本机的 cloudSync.deviceId(据此把设备标签写成「本机」)。 */
  deviceId?: string | null
}

/** 页面级同步共享(分享卡片数据源)。 */
export interface AmadeusPageShare {
  id: string
  path: string
  title: string
  inviteToken: string
  inviteRole: 'editor' | 'viewer'
  hasPassword: boolean
  expiresAt: string | null
  participants: Array<{ userId: string; username: string | null; role: 'editor' | 'viewer'; since: string }>
}

export interface AmadeusCollabQuota {
  collab: number
  publish: number
}

/** 云同步状态(镜像 electron/amadeus/sync/engine.ts 的 SyncStatus;side 由 IPC get 附带)。 */
export interface AmadeusSyncStatus {
  enabled: boolean
  state: 'disabled' | 'starting' | 'idle' | 'syncing' | 'offline' | 'auth-required' | 'error'
  lastSyncAt: number | null
  pending: number
  conflicts: number
  skipped: Array<{ path: string; reason: string }>
  error: string | null
  /** 被删除保护拦下、等确认的删除条数(旧 preload 无此字段 → undefined 按 0 处理)。 */
  pendingDeletions?: number
  /** 服务端下发的二进制单文件上限(字节,随会员档位);null / 缺 = 还没拉到(或旧引擎)。 */
  maxFileBytes?: number | null
  /** 仅 get() 响应携带:当前活动 vault 在哪一侧。 */
  side?: 'local' | 'cloud'
  /** 按条目同步绑定的状态事件携带:该绑定的本地 vault 根(区分多引擎,防互相覆盖)。 */
  binding?: string
}

/** 市场卡片(浏览列表)。 */
export interface MarketCard {
  description?: string
  minAppVersion?: string | null
  maxAppVersion?: string | null
  platforms?: string[]
  id: string
  type: 'skill' | 'agent' | 'plugin' | 'space' | 'theme' | 'amadeus-plugin'
  source: 'github' | 'zip' | 'npm'
  name: string
  summary: string
  author: string
  installSlug: string
  downloads: number
  /** 卡片图标的绝对 URL（主进程已拼上 cloudUrl）。缺省/加载失败 → 回落类型字形。 */
  iconUrl?: string | null
  latestTag?: string | null
  /** 可比较的最新版本(github=release tag,zip=manifest/手填 version);null=不参与「可更新」判断。 */
  latestVersion?: string | null
  /** 投稿标签。旧服务端未返回时按空数组处理。保留标签 `desktop-only` = 这个包只能在电脑上用
   *  (services/marketService 的 `isDesktopOnlyItem`):卡片上画成「仅桌面」标记而不是普通标签,Android App 上不给装。 */
  tags?: string[]
  /** 用于商店「最近上架」和详情元信息；兼容旧服务端，均可缺省。 */
  createdAt?: string | null
  updatedAt?: string | null
}

/** market:installProgress:resolve=向服务端要下载地址;download=在试第 attempt/attempts 个地址、已收 received 字节
 *  (total 常为 null:codeload / 代理站多不给长度);install=解压落盘。 */
export interface MarketInstallProgress {
  id: string
  phase: 'resolve' | 'download' | 'install'
  attempt?: number
  attempts?: number
  host?: string
  received?: number
  total?: number | null
}

/** 市场详情(含 README 正文)。 */
export interface MarketDetail extends MarketCard {
  readme: string
  githubRepoUrl?: string | null
  npmPackage?: string | null
}
