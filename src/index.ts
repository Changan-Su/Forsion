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
import { configureTangu, type TanguDeps } from './seams/runtime.js';
import runsRouter from './routes/runs.js';
import workspaceRouter from './routes/workspace.js';
import adminRouter from './routes/admin.js';
import { runMigration } from './db/migrate.js';
import { failStaleRuns } from './services/runStore.js';
import { recoverQueuedRuns, abortAllRuns } from './services/agentLoop.js';
import { loadSandboxConfig } from './sandbox/sandboxConfig.js';
import { startCacheJanitor, stopCacheJanitor, reapOrphanRunContainers } from './sandbox/dockerProvider.js';
import { startSessionReaper, stopSessionReaper, reapOrphanSessions } from './sandbox/sessionSandbox.js';
import { loadHistorianConfig } from './services/historianConfig.js';
import { startHistorian, stopHistorian } from './services/historian.js';

export interface TanguModule {
  userRouter: Router;
  adminRouter: Router;
  runMigration: () => Promise<void>;
  /**
   * 进程重启自愈 + 沙箱/历史员等后台任务。装配后由宿主决定调用时机(migrate 路径不应调)。
   *
   * opts(分离式云 worker 用):多 worker 共享同一云库时,run 自愈(failStaleRuns/recoverQueuedRuns)
   * 与 historian 是**全局**的——每个 worker 都跑会互相把对方在飞的 run 标 failed / 重复入队 / 重复复盘。
   * 故 worker 传 `{ recoverRuns:false, historian:false }`,只留**本机本地**的沙箱 janitor(docker/session)。
   * 默认全开,microserver/standalone 行为不变。
   */
  startBackgroundTasks: (opts?: { recoverRuns?: boolean; historian?: boolean }) => void;
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

  const startBackgroundTasks = (opts?: { recoverRuns?: boolean; historian?: boolean }): void => {
    // 进程重启自愈:遗留 running 标 failed → 重新入队仍在飞的 run(顺序不可颠倒)。
    // 共享云库的 worker 集群必须关掉(opts.recoverRuns=false),否则跨 worker 互相干扰。
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
    loadSandboxConfig().catch(() => {});
    startCacheJanitor();
    reapOrphanRunContainers();
    reapOrphanSessions();
    startSessionReaper();

    // historian 也是全局后台扫描,worker 集群关掉避免重复复盘。
    if (opts?.historian !== false) {
      loadHistorianConfig().catch(() => {});
      startHistorian();
    }
  };

  const dispose = (): void => {
    stopCacheJanitor();
    stopSessionReaper();
    stopHistorian();
    abortAllRuns();
  };

  return { userRouter, adminRouter, runMigration, startBackgroundTasks, dispose };
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
  BuildPayloadOpts,
  StreamOpts,
  StreamResult,
} from './seams/cloudBrain.js';
export type { BillingServices } from './seams/billing.js';
export type { AppProfile } from './seams/appProfile.js';
export * from './core/types.js';
