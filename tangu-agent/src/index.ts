/**
 * @forsion/tangu-agent —— 包入口。
 *
 * 与宿主无关的 Tangu Agent 运行时。两种消费方式:
 *   - microserver:server/microserver/agent-core/index.ts(薄适配器)用 Forsion host +
 *     forsionSeams 构造 deps,调 createTanguModule。
 *   - standalone:standalone/server.ts 用 httpBrain/localHost/noopBilling 构造 deps。
 *
 * 设计见 server/Documents/Tangu/Tangu_Agent_Architecture_v2.0.md(三层 + 两接缝)。
 */
import { Router } from 'express';
import { configureTangu, deps, type TanguDeps } from './seams/runtime.js';
import type { AppProfileOverride } from './seams/appProfile.js';
import runsRouter from './routes/runs.js';
import workspaceRouter from './routes/workspace.js';
import approvalsRouter from './routes/approvals.js';
import sessionsRouter from './routes/sessions.js';
import modelsRouter from './routes/models.js';
import enginesRouter from './routes/engines.js';
import providersRouter from './routes/providers.js';
import memoryRouter from './routes/memory.js';
import assetsRouter from './routes/assets.js';
import agentsRouter from './routes/agents.js';
import pluginsRouter from './routes/plugins.js';
import specialRouter from './routes/special.js';
import hooksRouter from './routes/hooks.js';
import wechatRouter from './routes/wechat.js';
import inboxRouter from './routes/inbox.js';
import ttsRouter from './routes/tts.js';
import adminRouter from './routes/admin.js';
import { runMigration } from './db/migrate.js';
import { failStaleRuns } from './services/runStore.js';
import { recoverQueuedRuns, abortAllRuns } from './services/agentLoop.js';
import { loadSandboxConfig } from './sandbox/sandboxConfig.js';
import { startCacheJanitor, stopCacheJanitor, reapOrphanRunContainers } from './sandbox/dockerProvider.js';
import { startSessionReaper, stopSessionReaper, reapOrphanSessions } from './sandbox/sessionSandbox.js';
import { loadHistorianConfig } from './services/historianConfig.js';
import { startHistorian, stopHistorian } from './services/historian.js';
import { startMuseSupervisor, stopMuseSupervisor } from './services/muse.js';
import { startInboxPull, stopInboxPull } from './services/inboxPull.js';
import { startWechatRemote, stopWechatRemote } from './services/wechatRemote.js';
import { disposeAllProcesses } from './tools/processRegistry.js';

export interface TanguModule {
  /** session 亲和路由(runs/SSE/workspace/approvals):fleet 模式按 session 哈希转发到 worker。 */
  userRouter: Router;
  /** 无亲和数据路由(sessions/models/memory/skills/tools):读写共享库/brain,fleet 模式由调度进程直服。 */
  dataRouter: Router;
  adminRouter: Router;
  runMigration: () => Promise<void>;
  /**
   * 进程重启自愈 + 沙箱/历史员等后台任务。装配后由宿主决定调用时机(migrate 路径不应调)。
   *
   * opts(分离式云 worker / 纯调度网关用):多 worker 共享同一云库时,run 自愈(failStaleRuns/
   * recoverQueuedRuns)与 historian 是**全局**的——每个 worker 都跑会互相把对方在飞的 run 标
   * failed / 重复入队 / 重复复盘。故 worker 传 `{ recoverRuns:false, historian:false }`,只留
   * **本机本地**的沙箱 janitor(docker/session);Forsion 纯调度网关(loop 在远端 worker,
   * 本机无沙箱)传 `{ recoverRuns:false, sandbox:false, historian:true }`。
   * 默认全开,standalone 行为不变。
   */
  startBackgroundTasks: (opts?: { recoverRuns?: boolean; historian?: boolean; sandbox?: boolean; profilePolling?: boolean }) => void;
  /** 卸载/热加载:停掉所有 interval 定时器 + 中止在飞 run(防 interval 泄漏)。 */
  dispose: () => void;
}

/**
 * 用注入的依赖装配 Tangu 运行时,返回路由 + 迁移 + 后台任务启动器。
 * configureTangu 必须先于任何 deps() 调用(本函数内已保证)。
 */
export function createTanguModule(d: TanguDeps): TanguModule {
  configureTangu(d);

  const userRouter = Router();
  userRouter.use(runsRouter);
  userRouter.use(workspaceRouter);
  userRouter.use(approvalsRouter);

  const dataRouter = Router();
  dataRouter.use(sessionsRouter);
  dataRouter.use(modelsRouter);
  dataRouter.use(enginesRouter);
  dataRouter.use(providersRouter);
  dataRouter.use(memoryRouter);
  dataRouter.use(assetsRouter);
  dataRouter.use(agentsRouter);
  dataRouter.use(pluginsRouter);
  dataRouter.use(specialRouter);
  dataRouter.use(hooksRouter);
  dataRouter.use(wechatRouter);
  dataRouter.use(inboxRouter);
  dataRouter.use(ttsRouter);

  const startBackgroundTasks = (opts?: { recoverRuns?: boolean; historian?: boolean; sandbox?: boolean; profilePolling?: boolean }): void => {
    // 进程重启自愈:遗留 running 标 failed → 重新入队仍在飞的 run(顺序不可颠倒)。
    // 共享云库的 worker 集群必须关掉(opts.recoverRuns=false),否则跨 worker 互相干扰。
    // 纯调度网关(Forsion server)三个全关:loop 不在该进程跑,沙箱也不在该机。
    if (opts?.recoverRuns !== false) {
      failStaleRuns()
        .then((n) => {
          if (n) console.log(`[tangu] marked ${n} stale runs as failed`);
          return recoverQueuedRuns();
        })
        .then((m) => { if (m) console.log(`[tangu] re-enqueued ${m} pending run(s)`); })
        .catch(() => {});
    }

    // 本机本地的沙箱 janitor(docker 容器 / 会话工作区):每个 worker 各管自己的,安全。
    if (opts?.sandbox !== false) {
      loadSandboxConfig().catch(() => {});
      startCacheJanitor();
      reapOrphanRunContainers();
      reapOrphanSessions();
      startSessionReaper();
    }

    // historian(云端闲置会话复盘,服务 AI Studio)是全局后台扫描:worker 集群关掉避免重复复盘;
    // 本地形态(hostExec=standalone/desktop)由按轮的 localHistorian 全权负责,这里不启动——
    // 它 agent-unaware(无 run 上下文,全写默认 agent 文件夹),与 per-agent 记忆架构不兼容。
    if (opts?.historian !== false && !deps().profile.capabilities.hostExec) {
      loadHistorianConfig().catch(() => {});
      startHistorian();
    }

    // Muse(本地后台常驻 Special Agent):supervisor 自带 isLocal 闸门——仅 host-exec profile
    //（standalone/desktop/TUI）生效,云端/worker(hostExec=false)为 no-op。不受 opts 控制。
    startMuseSupervisor();
    // 收件箱广播拉取:自带 isLocal + brain.inbox seam 双闸——仅配置了云端连接的本地形态生效,其余 no-op。
    startInboxPull();
    void startWechatRemote().catch((e: any) => console.warn('[tangu] WeChat Remote 启动失败:', e?.message || e));

    // 配置驱动 profile:启动 app_profile_overrides 轮询(admin panel 改 → 本进程 ≤刷新窗口收敛)。
    // thin worker 无本地 DB(host.query 抛)→ 传 profilePolling:false,用基线 profile(admin 覆盖暂不下达,后续可经 state-API 取)。
    if (opts?.profilePolling !== false) deps().profileStore.start();
  };

  const dispose = (): void => {
    stopCacheJanitor();
    stopSessionReaper();
    stopHistorian();
    stopMuseSupervisor();
    stopInboxPull();
    stopWechatRemote();
    deps().profileStore.dispose();
    abortAllRuns();
    disposeAllProcesses(); // run_background 的子进程(防热加载/退出泄漏)
  };

  return { userRouter, dataRouter, adminRouter, runMigration, startBackgroundTasks, dispose };
}

// ── 接缝类型导出(宿主/适配器 import 自包名 @forsion/tangu-agent)──
export { configureTangu, deps, isConfigured } from './seams/runtime.js';
export type { TanguDeps } from './seams/runtime.js';
export type { HostServices } from './seams/hostServices.js';
export type {
  CloudBrainServices,
  LlmBrain,
  UsersBrain,
  MemoryBrain,
  AssetsBrain,
  SearchBrain,
  ModelsBrain,
  StorageBrain,
  AgentFilesBrain,
  AgentsBrain,
  AgentFileMeta,
  AgentFileContent,
  AgentFilePutBody,
  BuildPayloadOpts,
  StreamOpts,
  StreamResult,
} from './seams/cloudBrain.js';
// Phase 2 云端运行水合:forsionSeams 用 parseAgentConfig 把 config.toml+SOUL.md 组装 def;currentAgentSlug/
// resolveMemorySlug/DEFAULT_AGENT_SLUG 供 memory/log 按 slug 作用域路由。
export { parseAgentConfig, serializeAgentConfig, resolveMemorySlug } from './agents/agentRegistry.js';
export type { NormalAgentDef } from './agents/agentRegistry.js';
export { currentAgentSlug } from './seams/runContext.js';
export { DEFAULT_AGENT_SLUG } from './core/tanguHome.js';
export type { BillingServices } from './seams/billing.js';
export type { AppProfile, AppProfileOverride, PromptSectionCtx, PromptSections } from './seams/appProfile.js';
export { resolveProfile } from './seams/appProfile.js';
export { createAiStudioProfile, createTanguProfile } from './profiles/index.js';
export { createProfileStore } from './profiles/profileStore.js';
export type { ProfileStore, ProfileEntry, ProfileView } from './profiles/profileStore.js';
export { getKnownToolNames } from './profiles/mergeProfile.js';

// ── 配置驱动 profile 的 admin 辅助(server agent-core 的 adminProfiles 路由调用,薄封装 profileStore)──
/** 列全部已知 app + 生效视图 + 原始覆盖(面板渲染用)。 */
export function listAppProfiles() {
  return deps().profileStore.describe();
}
/** 已注册内置工具名(面板白名单清单)。 */
export function knownToolNames(): string[] {
  return deps().profileStore.knownTools();
}
/** upsert 一个 app 的 DB 覆盖(写表 + 本进程立即刷新)。 */
export function upsertAppProfile(appId: string, override: AppProfileOverride): Promise<void> {
  return deps().profileStore.upsert(appId, override);
}
/** 删一个 app 的 DB 覆盖行(回落文件/基线 + 立即刷新)。 */
export function deleteAppProfile(appId: string): Promise<void> {
  return deps().profileStore.remove(appId);
}
/** 立即重建快照(admin 写后即时生效)。 */
export function refreshAppProfiles(): Promise<void> {
  return deps().profileStore.refreshNow();
}
export type { ToolDef, ToolProvider } from './tools/toolRegistry.js';
export type { ToolContext, ToolResult, ToolImpl } from './tools/toolTypes.js';
export * from './core/types.js';

// ── 插件契约（外部插件经 dist/index.d.ts 只读 import type;运行时全走 ctx.sdk，见 src/plugins/types.ts）──
export { TANGU_PLUGIN_API } from './plugins/types.js';
export type {
  TanguPlugin,
  TanguPluginContext,
  TanguPluginManifest,
  PluginCommand,
  PluginRouters,
  TanguSdk,
} from './plugins/types.js';
export type { PluginMeta, SettingsField, PluginSettingsSchema, SettingsScope, PluginPromptCtx } from './plugins/registry.js';
export type { Scope, PluginFileMeta } from './plugins/settingsStore.js';
