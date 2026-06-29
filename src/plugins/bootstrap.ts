/**
 * 插件宿主装配。构造 `ctx`（含按引用的 `ctx.sdk`）、编排发现/激活，给各入口（tui/standalone）用。
 *
 * `ctx.sdk` 的运行时构建块从**核心内部模块路径**直接 import（httpBrain/noopBilling/runContext/
 * agentLoop/profiles），`createTanguModule` 取自包入口——全是核心**同一模块图实例**（P0 关键:
 * 插件经 ctx.sdk 调到的就是这些同一份函数/单例，绝不会复制出第二份）。
 *
 * 两个消费面:
 *   - `dispatchPluginCommand`（tui `tangu`）:廉价 discover → 命中命令才激活**那一个**插件并运行。
 *   - `activateAllPlugins`（standalone `tangu-server`）:激活全部（tool provider 全局注册 + 收集路由挂载器）。
 */
import { registerToolProvider } from '../tools/toolRegistry.js';
import { registerPlugin, getPluginMeta, pluginsNeedingRestart } from './registry.js';
import * as pluginStore from './settingsStore.js';
import { wechatRemote } from '../services/wechatRemote.js';
import { createTanguModule } from '../index.js';
import { createHttpBrain } from '../adapters/standalone/httpBrain.js';
import { createNoopBilling } from '../adapters/standalone/noopBilling.js';
import { createAiStudioProfile, createTanguProfile } from '../profiles/index.js';
import { currentRunUserId } from '../seams/runContext.js';
import { activeRunCount } from '../services/agentLoop.js';
import { createThinWorker } from '../adapters/httpWorkerHost.js';
import { activatePlugin, discoverPlugins, type DiscoveredPlugin } from './loader.js';
import type {
  PluginCommand,
  PluginRouters,
  TanguPluginContext,
  TanguSdk,
} from './types.js';
import type { AppProfile } from '../seams/appProfile.js';
import type { HostServices } from '../seams/hostServices.js';
import type { CloudBrainServices } from '../seams/cloudBrain.js';
import type { BillingServices } from '../seams/billing.js';

/** 按引用的运行时构建块——核心同一模块图（见文件头 P0）。 */
const sdk: TanguSdk = {
  createTanguModule,
  createHttpBrain,
  createNoopBilling,
  createAiStudioProfile,
  createTanguProfile,
  currentRunUserId,
  activeRunCount,
  createThinWorker,
  pluginStore,
  sendWechatMedia: (userId, sessionId, buffer, opts, signal) => wechatRemote.sendMediaForSession(userId, sessionId, buffer, opts, signal),
};

interface HostState {
  commands: Map<string, PluginCommand>;
  routeMounters: ((r: PluginRouters) => void)[];
  // 以下为宽契约的预留登记面（worker 不用）:
  profiles: Map<string, AppProfile>;
  hostAdapters: Map<string, (o: any) => { host: HostServices }>;
  brainAdapters: Map<string, (o: any) => CloudBrainServices>;
  billingAdapters: Map<string, (o: any) => BillingServices>;
}

function newState(): HostState {
  return {
    commands: new Map(),
    routeMounters: [],
    profiles: new Map(),
    hostAdapters: new Map(),
    brainAdapters: new Map(),
    billingAdapters: new Map(),
  };
}

function makeContext(d: DiscoveredPlugin, state: HostState): TanguPluginContext {
  return {
    registerCommand: (cmd) => state.commands.set(cmd.name, cmd),
    registerToolProvider: (p) => registerToolProvider(p), // 全局注册表，append 在核心 builtin 之后
    registerPlugin: (meta) => registerPlugin({ ...meta, source: 'folder' }), // folder 插件进统一注册表

    registerProfile: (p) => state.profiles.set(p.appId, p),
    registerHostAdapter: (id, build) => state.hostAdapters.set(id, build),
    registerBrainAdapter: (id, build) => state.brainAdapters.set(id, build),
    registerBillingAdapter: (id, build) => state.billingAdapters.set(id, build),
    registerRoutes: (mount) => state.routeMounters.push(mount),
    sdk,
    log: (msg) => console.log(`[plugin:${d.manifest.id}] ${msg}`),
    paths: { pluginDir: d.dir },
  };
}

/** 列已发现插件（供 `tangu plugins`），不激活。 */
export function listPlugins(): { id: string; name: string; version: string; commands: string[] }[] {
  return discoverPlugins().map((d) => ({
    id: d.manifest.id,
    name: d.manifest.name,
    version: d.manifest.version,
    commands: d.manifest.commands ?? [],
  }));
}

/**
 * tui:若 `name` 命中某插件 manifest 声明的命令 → 激活该插件并运行;返回退出码;未命中返回 `null`。
 * 仅动态 import 命中的那一个插件（不 activate 其余，省去无关插件的依赖加载）。
 */
export async function dispatchPluginCommand(name: string, argv: string[]): Promise<number | null> {
  const target = discoverPlugins().find((d) => (d.manifest.commands ?? []).includes(name));
  if (!target) return null;
  const state = newState();
  try {
    await activatePlugin(target, makeContext(target, state));
  } catch (e: any) {
    console.error(`[tangu] 插件 ${target.manifest.id} 激活失败:${e?.message || e}`);
    return 1;
  }
  const cmd = state.commands.get(name);
  if (!cmd) {
    console.error(`[tangu] 插件 ${target.manifest.id} 未注册命令 "${name}"`);
    return 1;
  }
  const code = await cmd.run(argv);
  return typeof code === 'number' ? code : 0;
}

/**
 * standalone:激活全部插件（tool provider 全局注册 + 路由挂载器收集）。返回一个把已注册路由挂到
 * 三组 router 的函数——**须在 `createTanguModule` 之后调用**（彼时 `configureTangu`/`deps()` 才就绪;
 * 路由挂载器内部可能读 `deps()`）。tool provider 注册是无状态的静态写入，先于 createTanguModule 也安全。
 */
export async function activateAllPlugins(): Promise<(r: PluginRouters) => void> {
  const state = newState();
  for (const d of discoverPlugins()) {
    try {
      await activatePlugin(d, makeContext(d, state));
    } catch (e: any) {
      console.warn(`[tangu] 插件 ${d.manifest.id} 激活失败，跳过:${e?.message || e}`);
    }
  }
  return (routers: PluginRouters) => {
    for (const mount of state.routeMounters) {
      try {
        mount(routers);
      } catch (e: any) {
        console.warn(`[tangu] 插件路由挂载失败:${e?.message || e}`);
      }
    }
  };
}

/**
 * 运行期重扫:激活磁盘上「尚未注册」的新插件(市场装后无需重启即可见/可用)。
 * tool provider / promptSection / 元数据 / 启用态都即时生效(resolveTools 等运行期实时读);
 * 唯一例外:插件经 registerRoutes 贡献的 Express 路由无法挂到已建好的 app → needsRestart=true。
 * 仅处理「全新 id」;原地升级(覆盖同 slug 代码)受 import 缓存所限仍需重启。
 */
export async function activateNewPlugins(): Promise<{ addedIds: string[]; needsRestart: boolean }> {
  const addedIds: string[] = [];
  let needsRestart = false;
  for (const d of discoverPlugins()) {
    if (getPluginMeta(d.manifest.id)) continue; // 已注册 → 跳过(避免重复 activate 副作用)
    const state = newState();
    try {
      await activatePlugin(d, makeContext(d, state));
      addedIds.push(d.manifest.id);
      if (state.routeMounters.length) { needsRestart = true; pluginsNeedingRestart.add(d.manifest.id); } // 贡献了路由 → 必须重启
    } catch (e: any) {
      console.warn(`[tangu] 插件 ${d.manifest.id} 重扫激活失败,跳过:${e?.message || e}`);
    }
  }
  return { addedIds, needsRestart };
}
