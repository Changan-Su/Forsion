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
  /** 插件设置/数据存储(读写自身设置 + image-list blob;按 id + scope)。folder 插件经此读写,不直接 import 核心。 */
  pluginStore: typeof PluginStore;
  /** 把媒体(图片/文件)发到当前微信会话连接的用户(send_sticker 等用;非微信会话返回 ok:false)。 */
  sendWechatMedia(userId: string, sessionId: string, buffer: Buffer, opts: { kind: 'image' | 'file'; fileName: string }, signal?: AbortSignal): Promise<{ ok: boolean; error?: string }>;
}

/** 插件可挂载额外路由的三组 router（标准/数据/admin）。 */
export interface PluginRouters {
  userRouter: Router;
  dataRouter: Router;
  adminRouter: Router;
}

/** `activate(ctx)` 收到的注册面 + 运行时句柄。 */
export interface TanguPluginContext {
  /** 注册 `tangu <name>` 子命令。 */
  registerCommand(cmd: PluginCommand): void;
  /** 注册工具 provider（一律 append 在核心 builtin 之后，按插件加载序——保 tool-def 稳定）。 */
  registerToolProvider(p: ToolProvider): void;
  /** 登记进统一插件注册表（在「设置 → 插件」露出 + schema 面板;带 toolProvider 则顺带注册工具）。 */
  registerPlugin(meta: PluginMeta): void;
  /** 注册一个可被 profileStore 选用的 AppProfile（预留扩展，worker 不用）。 */
  registerProfile(p: AppProfile): void;
  /** 注册一个可命名选用的 host/brain/billing 适配器工厂（预留扩展，worker 不用）。 */
  registerHostAdapter(id: string, build: (opts: any) => { host: HostServices }): void;
  registerBrainAdapter(id: string, build: (opts: any) => CloudBrainServices): void;
  registerBillingAdapter(id: string, build: (opts: any) => BillingServices): void;
  /** 在 `createTanguModule` 之后把额外路由挂到三组 router（预留扩展，worker 不用）。 */
  registerRoutes(mount: (r: PluginRouters) => void): void;
  /** 运行时构建块（按引用，见 `TanguSdk`）。 */
  sdk: TanguSdk;
  /** 带插件 id 前缀的日志。 */
  log(msg: string): void;
  /** 路径信息。 */
  paths: { pluginDir: string };
}

/** 插件入口默认导出。 */
export interface TanguPlugin {
  /** 可选:loader 已从 `tangu-plugin.json` 拿到权威 manifest，本字段仅信息性。 */
  manifest?: TanguPluginManifest;
  activate(ctx: TanguPluginContext): void | Promise<void>;
  deactivate?(): void | Promise<void>;
}
