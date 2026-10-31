/**
 * Tangu 插件契约（宿主系统）。
 *
 * 插件以**独立模块图**运行（各自 dist/ 经动态 import 加载），故插件**绝不能在运行时 import
 * @forsion/tangu-agent**——否则核心的模块级单例（seams/runContext 的 `als`、seams/runtime 的 `_deps`、
 * services/agentLoop 的 run map、tools/toolRegistry 的 provider 注册表）会被复制成**第二份**:
 * `currentRunUserId()` 永远返回 undefined（worker 的 per-user JWT 全签成 `__no_run_ctx__`）、
 * 工具定义顺序漂移。运行时一律走**按引用传入的 `ctx.sdk`**（核心同一模块实例）;插件对核心仅允许
 * `import type`（NodeNext 下被擦除）。插件 tsconfig 开 `verbatimModuleSyntax` 把任何值导入变成编译错误。
 *
 * 发现/加载见 ./loader.ts;装配见 ./bootstrap.ts。
 */
import type { Router } from 'express';
import type { ToolProvider } from '../tools/toolRegistry.js';
import type { PluginMeta } from './registry.js';
import type * as PluginStore from './settingsStore.js';
import type { AppProfile } from '../seams/appProfile.js';
import type { HostServices } from '../seams/hostServices.js';
import type { CloudBrainServices } from '../seams/cloudBrain.js';
import type { BillingServices } from '../seams/billing.js';
import type { createTanguModule } from '../index.js';
import type { createHttpBrain } from '../adapters/standalone/httpBrain.js';
import type { createNoopBilling } from '../adapters/standalone/noopBilling.js';
import type { createAiStudioProfile, createTanguProfile } from '../profiles/index.js';
import type { currentRunUserId } from '../seams/runContext.js';
import type { activeRunCount } from '../services/agentLoop.js';
import type { createThinWorker } from '../adapters/httpWorkerHost.js';
import type { createProfileStore } from '../profiles/profileStore.js';
import type { ChannelSettings, PluginChannelSpec } from '../channels/types.js';

/** 插件契约版本。loader 只加载 `apiVersion === TANGU_PLUGIN_API` 的插件。 */
export const TANGU_PLUGIN_API = 1;

/** `plugins/<dir>/tangu-plugin.json` 的形态。 */
export interface TanguPluginManifest {
  id: string;
  name: string;
  version: string;
  apiVersion: number;
  /** 相对 manifest 的已构建 ESM 入口（default-export `TanguPlugin`），如 `"dist/index.js"`。 */
  entry: string;
  /** 本插件声明提供的 CLI 子命令名（供 `tangu` 廉价路由，无需先 activate）。 */
  commands?: string[];
  description?: string;
  /**
   * 前置插件(引擎插件 id;与桌面 UI 插件同一套语义)。`"id"` 或 `{ id, minVersion? }`;其余键(market / name 等,
   * 桌面用)引擎忽略。非 kebab id、依赖自己的丢弃,去重,最多 8 条;minVersion 须点分数字(可带前导 v)。
   * 前置**满足** = 已发现 + 版本 ≥ minVersion(点分数字比较,前导 v 忽略,缺段按 0)+ 已启用 + 正在运行;
   * 不满足时本插件休眠(仍列出,不运行),前置就位后自动激活。激活顺序按依赖拓扑(同层按 id);成环的全部休眠。
   */
  requiresPlugins?: Array<string | { id: string; minVersion?: string }>;
  /**
   * 自带的 MCP server(形态同 `~/.tangu/mcp.json` 的 `mcpServers`,**只收 stdio**:随包发的静态 server)。插件激活时起、停用时关;工作目录是插件目录,
   * command / args / env 里的 `${pluginDir}` 展开成它的绝对路径。和用户自己配的 server 撞名时插件这份不起。
   * 只在本机引擎上生效(云端 worker 没有 MCP)。见 mcp/pluginServers.ts。⚠️入口仍要 `ctx.registerPlugin(...)`:没登记 meta 的插件
   * 没有开关(视为常开),桌面停用捆绑包时级联关不到,声明的 MCP 进程就一直开着。
   */
  mcpServers?: Record<string, unknown>;
  /**
   * 自带的 lifecycle hooks(形态同 config.json hooks 段的 `events`)。**只开观察档**:SessionStart / PostToolUse / Stop /
   * SubagentStart / SubagentStop,hook 照常跑、收事件 JSON,但输出不进判定(拦不住、注入不了上下文)。
   * command 里的 `${pluginDir}` 展开成插件目录。随插件启停。见 hooks/pluginHooks.ts。
   */
  hooks?: Record<string, unknown>;
}

/** 插件注册的 CLI 子命令（`tangu <name> ...`）。 */
export interface PluginCommand {
  name: string;
  summary: string;
  /** 命令名之后的 argv;返回退出码（或 void=保持进程，由其打开的句柄决定存活）。 */
  run(argv: string[]): Promise<number | void>;
}

/**
 * 运行时构建块句柄。**由核心构造、按引用传入** `activate(ctx)`——这是插件不复制核心单例的关键:
 * 插件用 `ctx.sdk.*` 调到的全是核心**同一份**模块实例（同一 `als`/`_deps`/registry）。
 */
export interface TanguSdk {
  automation: ReturnType<typeof import('./automation.js').createPluginAutomation>;
  workspaces: ReturnType<typeof import('./workspaces.js').createPluginWorkspaces>;
  runs: ReturnType<typeof import('./runs.js').createPluginRuns>;
  engines: typeof import('./runs.js').pluginEngines;
  createTanguModule: typeof createTanguModule;
  createHttpBrain: typeof createHttpBrain;
  createNoopBilling: typeof createNoopBilling;
  createAiStudioProfile: typeof createAiStudioProfile;
  createTanguProfile: typeof createTanguProfile;
  /** 当前 run 的 userId（分离式多用户 worker 用它铸 per-user token）。 */
  currentRunUserId: typeof currentRunUserId;
  /** 在飞 run 数（worker /health 自描述用）。 */
  activeRunCount: typeof activeRunCount;
  /** thin worker 装配:httpWorkerHost(无 pg/JWT_SECRET) + HttpStateStore(状态走 server) + brainToken。 */
  createThinWorker: typeof createThinWorker;
  /** 配置驱动 profile store(可注入取数源;thin worker 传 HTTP 版接收 admin 覆盖下达)。 */
  createProfileStore: typeof createProfileStore;
  /** 插件设置/数据存储(读写自身设置 + image-list blob;按 id + scope)。folder 插件经此读写,不直接 import 核心。 */
  pluginStore: typeof PluginStore;
  /** 把媒体(图片/文件)发到当前微信会话连接的用户(send_sticker 等用;非微信会话返回 ok:false)。 */
  sendWechatMedia(userId: string, sessionId: string, buffer: Buffer, opts: { kind: 'image' | 'file'; fileName: string }, signal?: AbortSignal): Promise<{ ok: boolean; error?: string }>;
  /** 读某通道的设置(插件通道的驱动经此读自己的凭据 appId / appSecret / botToken;每次现读,改设置即时可见)。 */
  channelSettings(kind: string): ChannelSettings;
}

/** ctx.cloud 的一次请求(官方插件专用)。path 原样匹配白名单,不解码。 */
export interface PluginCloudRequest {
  path: string;
  method?: 'GET' | 'POST';
  body?: unknown;
  /** 缺省 15s,上限 120s。 */
  timeoutMs?: number;
  signal?: AbortSignal;
}
/** status 0 = 没发出去或没收到(error 写原因);403 + path_not_allowed = 白名单外,没发。 */
export interface PluginCloudResponse { status: number; json?: any; error?: string }

/** 插件可挂载额外路由的三组 router（标准/数据/admin）。 */
export interface PluginRouters {
  userRouter: Router;
  dataRouter: Router;
  adminRouter: Router;
}

/**
 * `activate(ctx)` 收到的注册面 + 运行时句柄。
 * 每次激活拿到一份**新** ctx,宿主按它记一本效果台账(工具 provider / 命令 / 路由 / meta):停用时逐条撤销。
 * 停用之后旧 ctx 即失效 —— 迟到的 register*(异步回调、定时器里)一律忽略并告警。
 */
export interface TanguPluginContext {
  /** 注册 `tangu <name>` 子命令。 */
  registerCommand(cmd: PluginCommand): void;
  /** 注册工具 provider（一律 append 在核心 builtin 之后，按插件加载序——保 tool-def 稳定）。
   *  停用时撤下但**保留槽位**,再启用回到原位(不跑到队尾)。 */
  registerToolProvider(p: ToolProvider): void;
  /** 登记进统一插件注册表（在「设置 → 插件」露出 + schema 面板;带 toolProvider 则顺带注册工具）。
   *  停用后 meta 仍列出(休眠:名称/图标/设置保留,toolProvider 与 promptSection 摘掉)。 */
  registerPlugin(meta: PluginMeta): void;
  /** 注册一个可被 profileStore 选用的 AppProfile（预留扩展，worker 不用）。 */
  registerProfile(p: AppProfile): void;
  /** 注册一个可命名选用的 host/brain/billing 适配器工厂（预留扩展，worker 不用）。 */
  registerHostAdapter(id: string, build: (opts: any) => { host: HostServices }): void;
  registerBrainAdapter(id: string, build: (opts: any) => CloudBrainServices): void;
  registerBillingAdapter(id: string, build: (opts: any) => BillingServices): void;
  /** 贡献额外路由（预留扩展，worker 不用）。`mount` 拿到的是**本次激活专属**的三组子 router,宿主经一个分发器
   *  挂在核心路由之后(按插件 id 序);运行期激活(重扫/启用/升级)即时生效、停用即摘除,都不用重启。
   *  `mount` 在 `createTanguModule` 之后才调(彼时 deps() 已就绪)。 */
  registerRoutes(mount: (r: PluginRouters) => void): void;
  /** Authenticated JSON routes under /extensions/<bundle>/<engine>. Host assigns ownership and removes on disable. */
  registerScopedRoutes(mount: (router: Router) => void): void;
  /**
   * 贡献一个 IM 通道(企业微信等):驱动只管传输层,会话绑定 / 审批 / slash / 收件箱转发 / 设置卡全由宿主管线负责。
   * 本机引擎才生效(云端 profile 不起通道)。停用插件时宿主完全停止该通道,绑定保留。kind 非法或撞名直接抛错(激活作废)。
   */
  registerChannel(spec: PluginChannelSpec): void;
  /** 运行时构建块（按引用，见 `TanguSdk`）。 */
  sdk: TanguSdk;
  /** 带插件 id 前缀的日志。 */
  log(msg: string): void;
  /** 路径信息。 */
  paths: { pluginDir: string; dataDir: string };
  /**
   * 以用户的 Forsion 账号请求云端。**只有官方插件有**(捆绑包 SIGNATURE 用引擎钉的公钥验过,见 ./official.ts),
   * 其余插件恒为 undefined。路径白名单:`GET /api/market/mine`、`POST /api/market/mine/<id>/update`(可带 `?dryRun=1`),
   * 别的一律 `{ status: 403, error: 'path_not_allowed' }`、不发;没有云端接缝(内嵌引擎 / 没配云端)= `{ status: 0, error: 'no_cloud' }`。
   * 令牌由宿主带,插件拿不到;永不抛。
   */
  cloud?: { request(req: PluginCloudRequest): Promise<PluginCloudResponse> };
  /**
   * 发用户活动事件(强制 `plugin:<id>:` 前缀,对齐桌面 ctx.activity.log)——自动化 event_seen 可盯,
   * Muse/read_activity 可读。仅本地形态生效(云端 worker 静默 no-op)。detail 值折叠空白截断,勿放敏感原文。
   */
  activity: { append(event: string, detail?: Record<string, unknown>): void };
}

/**
 * 插件入口默认导出。生命周期(宿主 = ./bootstrap.ts):
 *   - 启动时每个发现的插件都 activate 一次(meta / defaultEnabled 只有激活后才知道),随后未启用或前置没齐的立即 deactivate 休眠;
 *   - 停用 / 卸载 / 原地升级 / 前置消失 → 调 `deactivate()`(限时 5s,超时或抛错只告警),再撤掉它注册的一切;
 *   - 再启用 → 在**同一个模块对象**上再调一次 `activate(ctx)`(不重 import)。所以 activate 可能跑多次:
 *     别依赖模块级「只做一次」的状态,activate 里起的定时器 / 子进程 / 监听都要在 deactivate 里收掉;
 *   - activate 抛错 = 本次激活作废:已注册的半截效果回滚,并调一次 deactivate 收尾,插件休眠(列表带 lastError),
 *     不自动重试 —— 用户再拨一次开关、或重扫发现代码变了才重试。
 */
export interface TanguPlugin {
  /** 可选:loader 已从 `tangu-plugin.json` 拿到权威 manifest，本字段仅信息性。 */
  manifest?: TanguPluginManifest;
  activate(ctx: TanguPluginContext): void | Promise<void>;
  /** 停用 / 卸载 / 原地升级时调用(限时 5s)。停掉 activate 里起的后台工作。
   *  ⚠️ 启动期那次(未启用 / 前置没齐的插件)早于 createTanguModule:deactivate 里别依赖 deps() 等运行时装配。 */
  deactivate?(): void | Promise<void>;
}
