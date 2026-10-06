import { deps } from '../seams/runtime.js';
import { tanguHome } from '../core/tanguHome.js';
import { createPluginRuns, pluginEngines } from './runs.js';
import { createPluginWorkspaces } from './workspaces.js';
import { createPluginAutomation } from './automation.js';
import { authMiddleware } from '../core/http.js';
import path from 'node:path';
/**
 * 插件宿主装配 + 生命周期。构造 `ctx`（含按引用的 `ctx.sdk`）、编排发现/激活/停用/依赖/热升级，给各入口（tui/standalone）
 * 与插件路由（routes/plugins.ts,经动态 import）用。
 *
 * `ctx.sdk` 的运行时构建块从**核心内部模块路径**直接 import（httpBrain/noopBilling/runContext/
 * agentLoop/profiles），`createTanguModule` 取自包入口——全是核心**同一模块图实例**（P0 关键:
 * 插件经 ctx.sdk 调到的就是这些同一份函数/单例，绝不会复制出第二份）。
 *
 * 消费面:
 *   - `dispatchPluginCommand`（tui `tangu`）:廉价 discover → 命中命令才激活**那一个**插件并运行(一次性,不进生命周期)。
 *   - `activateAllPlugins`（standalone `tangu-server` / TUI 会话）:启动期激活全部 → 按启用态与前置收敛;返回热路由挂载函数。
 *   - `rescanPlugins`(= activateNewPlugins)/ `setPluginEnabledLive` / `removePluginLive`:运行期与磁盘、开关同步。
 *
 * 生命周期(Cordis 式:每笔注册都可撤销,依赖驱动激活):
 *   - 每次激活 = 一个实例(Instance)。makeContext 把它注册的工具 provider / 命令 / 路由挂载器 / meta 记进实例台账;
 *     停用 = 调 deactivate(限时)→ 按台账撤销(provider 保槽位换空、子 router 丢弃、命令丢弃、meta 休眠仍列出)。
 *   - 插件 ACTIVE ⇔ 已启用 && 前置全满足 && 上次激活没抛错;否则休眠(仍列出,不运行)。
 *   - 任何变化后 reconcile 收敛到不动点:先按拓扑序算出「应当在跑」的集合,逆拓扑停掉集合外的(依赖者先于被依赖者),
 *     再按拓扑序启动集合内的。
 *   - 所有生命周期操作走同一条 promise 链串行(重扫、开关、卸载可经 HTTP 并发),绝不交错;import+activate / deactivate
 *     各自限时,超时的记 busy 隔离到它真正落定(withDeadline)。
 *   - 工具 provider 记归属(providerOwner):停用只撤自己名下的。
 */
import { Router, type NextFunction, type Request, type Response } from 'express';
import { registerToolProvider, unregisterToolProvider, listToolProviders } from '../tools/toolRegistry.js';
import { registerPlugin, getPluginMeta, pluginsNeedingRestart, setPluginDormant, unregisterPlugin } from './registry.js';
import * as pluginStore from './settingsStore.js';
import { wechatRemote } from '../services/wechatRemote.js';
import { createTanguModule } from '../index.js';
import { createHttpBrain } from '../adapters/standalone/httpBrain.js';
import { createNoopBilling } from '../adapters/standalone/noopBilling.js';
import { createAiStudioProfile, createTanguProfile } from '../profiles/index.js';
import { currentRunUserId } from '../seams/runContext.js';
import { activeRunCount } from '../services/agentLoop.js';
import { createThinWorker } from '../adapters/httpWorkerHost.js';
import { createProfileStore } from '../profiles/profileStore.js';
import {
  activatePlugin, assertNativePluginsAllowed, cannotHotSwap, compareVersions, discoverPlugins, loadPlugin, orderByRequires,
  type DiscoveredPlugin, type PluginRequirement,
} from './loader.js';
import { appendActivityLine } from '../services/userActivity.js';
import { seedBundleAgents } from './bundles.js';
import type {
  PluginCommand,
  PluginRouters,
  TanguPlugin,
  TanguPluginContext,
  TanguSdk,
} from './types.js';
import type { AppProfile } from '../seams/appProfile.js';
import type { HostServices } from '../seams/hostServices.js';
import type { CloudBrainServices } from '../seams/cloudBrain.js';
import type { BillingServices } from '../seams/billing.js';

/** 按引用的运行时构建块——核心同一模块图（见文件头 P0）。 */
const sdk: Omit<TanguSdk, 'runs' | 'engines' | 'workspaces' | 'automation'> = {
  createTanguModule,
  createHttpBrain,
  createNoopBilling,
  createAiStudioProfile,
  createTanguProfile,
  currentRunUserId,
  activeRunCount,
  createThinWorker,
  createProfileStore,
  pluginStore,
  sendWechatMedia: (userId, sessionId, buffer, opts, signal) => wechatRemote.sendMediaForSession(userId, sessionId, buffer, opts, signal),
};

/** 一次激活的效果台账。停用时据此逐条撤销;撤销后 disposed=true,旧 ctx 的迟到注册一律忽略。 */
interface Instance {
  plugin?: TanguPlugin;
  disposed: boolean;
  runtimeDisposers: (() => void)[];
  /** activate 已成功返回:此后 registerRoutes 立即挂;之前先攒着(激活失败就不必挂)。 */
  activated: boolean;
  providerIds: Set<string>;
  /** 与所属条目共享同一个 Set:历次实例登记过的 meta 都记在条目上(卸载/消失时据此注销)。 */
  metaIds: Set<string>;
  commands: Map<string, PluginCommand>;
  routeMounters: ((r: PluginRouters) => void)[];
  /** 已跑进子 router 的挂载器个数。 */
  mounted: number;
  /** 本实例专属的三组子 router(有路由贡献且宿主 router 已知时才建);分发器只认活跃实例的这一份。 */
  routers?: PluginRouters;
  // 以下为宽契约的预留登记面（worker 不用）:
  profiles: Map<string, AppProfile>;
  hostAdapters: Map<string, (o: any) => { host: HostServices }>;
  brainAdapters: Map<string, (o: any) => CloudBrainServices>;
  billingAdapters: Map<string, (o: any) => BillingServices>;
}

function newInstance(metaIds: Set<string> = new Set()): Instance {
  return {
    disposed: false,
    runtimeDisposers: [],
    activated: false,
    providerIds: new Set(),
    metaIds,
    commands: new Map(),
    routeMounters: [],
    mounted: 0,
    profiles: new Map(),
    hostAdapters: new Map(),
    brainAdapters: new Map(),
    billingAdapters: new Map(),
  };
}

function makeContext(d: DiscoveredPlugin, inst: Instance): TanguPluginContext {
  const id = d.manifest.id;
  const live = (what: string): boolean => {
    if (!inst.disposed) return true;
    console.warn(`[tangu] 插件 ${id} 已停用,忽略迟到的${what}注册`);
    return false;
  };
  return {
    registerCommand: (cmd) => {
      if (live('命令')) inst.commands.set(cmd.name, cmd);
    },
    registerToolProvider: (p) => {
      if (!live('工具')) return;
      inst.providerIds.add(p.id);
      providerOwner.set(p.id, id);
      registerToolProvider({ ...p, origin: 'plugin' }); // 全局注册表,append 在核心 builtin 之后;打 plugin 标(chat 正向面只认核心 provider)
    },
    // folder 插件进统一注册表；图标只信宿主读到的包根 icon.png。
    // 捆绑包内嵌的引擎插件默认跟随捆绑包(桌面上捆绑包缺省即启用,且只给捆绑包一个开关、拨动时级联):
    // 它自报的 defaultEnabled:false 在产品里没有任何打开入口,只会造成「卡片开着、工具一个没有」——
    // 随 App 播种的电脑操作在新装机器上就是这样(09-25 Windows 实测)。显式开关(__enabled)照旧优先。
    registerPlugin: (meta) => {
      if (!live(' meta ')) return;
      inst.metaIds.add(meta.id);
      if (meta.toolProvider) { // registry 顺带注册的 provider 也进台账
        inst.providerIds.add(meta.toolProvider.id);
        providerOwner.set(meta.toolProvider.id, id);
      }
      registerPlugin({ ...meta, defaultEnabled: d.bundled || meta.defaultEnabled, source: 'folder', iconUrl: d.iconUrl });
    },

    registerProfile: (p) => {
      if (live(' profile ')) inst.profiles.set(p.appId, p);
    },
    registerHostAdapter: (aid, build) => {
      if (live('适配器')) inst.hostAdapters.set(aid, build);
    },
    registerBrainAdapter: (aid, build) => {
      if (live('适配器')) inst.brainAdapters.set(aid, build);
    },
    registerBillingAdapter: (aid, build) => {
      if (live('适配器')) inst.billingAdapters.set(aid, build);
    },
    registerRoutes: (mount) => {
      if (!live('路由')) return;
      inst.routeMounters.push(mount);
      if (inst.activated) mountRoutes(id, inst); // 激活完成之后才注册的路由:立即挂
    },
    registerScopedRoutes: (mount) => {
      if (!live('scoped routes')) return;
      // The directory discovered by the host is authoritative, never plugin-supplied IDs.
      const owner = d.bundled ? path.basename(path.dirname(path.dirname(d.dir))) : id;
      inst.routeMounters.push((r) => {
        const router = Router();
        router.use(authMiddleware);
        router.use((req, res, next) => {
          if (!deps().profile.capabilities.hostExec || req.headers['x-forsion-remote']) { res.status(403).json({ detail: 'Local plugin routes only' }); return; }
          next();
        });
        mount(router);
        r.userRouter.use(`/extensions/${owner}/${id}`, router);
      });
      if (inst.activated) mountRoutes(id, inst);
    },
    sdk: { ...sdk, runs: createPluginRuns(id, () => !inst.disposed, off => inst.runtimeDisposers.push(off), () => listToolProviders().filter(p => providerOwner.get(p.id) === id).flatMap(p => p.tools().map(t => t.name))), engines: pluginEngines,
      automation: createPluginAutomation(id, () => !inst.disposed, () => listToolProviders().filter(p => providerOwner.get(p.id) === id).flatMap(p => p.tools().filter(t=>t.capabilities?.automationSafe).map(t => t.name))),
      workspaces: createPluginWorkspaces(id, path.join(tanguHome(), 'plugin-data', id), () => !inst.disposed) },
    log: (msg) => console.log(`[plugin:${id}] ${msg}`),
    paths: { pluginDir: d.dir, dataDir: path.join(tanguHome(), 'plugin-data', id) },
    activity: {
      append: (event, detail) => {
        // 强制插件命名空间前缀(与桌面 ctx.activity.log 同纪律);appendActivityLine 自身吞错,事件流是尽力而为的旁路。
        appendActivityLine(`plugin:${id}:${String(event || '')}`, detail as Record<string, any>);
      },
    },
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
 * 仅动态 import 命中的那一个插件（不 activate 其余，省去无关插件的依赖加载）。一次性台账,不进生命周期。
 */
export async function dispatchPluginCommand(name: string, argv: string[]): Promise<number | null> {
  const target = discoverPlugins().find((d) => (d.manifest.commands ?? []).includes(name));
  if (!target) return null;
  const inst = newInstance();
  try {
    await activatePlugin(target, makeContext(target, inst));
  } catch (e: any) {
    console.error(`[tangu] 插件 ${target.manifest.id} 激活失败:${e?.message || e}`);
    return 1;
  }
  const cmd = inst.commands.get(name);
  if (!cmd) {
    console.error(`[tangu] 插件 ${target.manifest.id} 未注册命令 "${name}"`);
    return 1;
  }
  const code = await cmd.run(argv);
  return typeof code === 'number' ? code : 0;
}

// ───────────────────────────── 生命周期 ─────────────────────────────

/** 每个已发现插件一条(跨多次激活存续)。键 = manifest id。 */
interface Entry {
  d: DiscoveredPlugin;
  /** 已 import 的模块对象:停用→启用复用,不重 import(ESM 模块永不卸载)。原地升级时清空并换新 gen。 */
  plugin?: TanguPlugin;
  /** 入口破缓存代号(0 = 原始 URL)。 */
  gen: number;
  /** 当前实例;undefined = 休眠。 */
  inst?: Instance;
  /** 上次激活抛错:reconcile 不自动重试,直到显式拨开关或重扫发现代码变了。 */
  failed: boolean;
  lastError?: string;
  /** 正在离场(目录消失 / 卸载 / 升级换代):按「未启用」参与收敛,依赖者先停。 */
  leaving: boolean;
  /** 上一次 activate / deactivate 超时后还在后台跑:落定前不进收敛目标(见 withDeadline)。 */
  busy?: Promise<void>;
  metaIds: Set<string>;
}

/** 前置没满足的原因。 */
export type PluginWaitReason = 'missing' | 'version' | 'off' | 'waiting' | 'cycle';
export interface PluginWaitingFor { id: string; reason: PluginWaitReason; minVersion?: string; have?: string }

/** 「设置→插件」列表用的运行态。 */
export interface PluginStatus {
  /** 此刻正在运行。 */
  active: boolean;
  /** folder 插件取 manifest.version;编进 app 的 builtin 省略。 */
  version?: string;
  /** manifest 声明的前置(消毒后);没声明省略。 */
  requiresPlugins?: PluginRequirement[];
  /** 仅「已启用但因前置没齐而休眠」时给出。 */
  waitingFor?: PluginWaitingFor[];
  /** 上次激活抛错的消息。 */
  lastError?: string;
  /** 上一次 activate / deactivate 超时后还在后台跑(busy):落定后按开关自动收敛,这期间不会再激活它。 */
  settling?: boolean;
}

/** 生命周期限时(测试改小)。超时只是不再等,对方仍在后台跑 —— 见 withDeadline。 */
export const lifecycleTimeouts = { activateMs: 30_000, deactivateMs: 5_000 };
// ponytail: ESM 模块永不卸载,每次热换代多留一份旧模块(闭包、缓冲区都在)。本进程换代满这么多次后一律按「需重启」
// 处理;要无限热升级得把插件放进可销毁的 worker / 子进程(Codex 10-02)。
const MAX_HOT_GENERATIONS = 20;

const entries = new Map<string, Entry>();
/** 工具 provider id → 最后注册它的插件。停用只撤自己名下的:两个插件撞了同一个 provider id 时后注册的覆盖前者,
 *  前者停用不许把后者的工具一起清掉(Codex 10-02)。 */
const providerOwner = new Map<string, string>();
/** 拓扑序(同层 id 序)= 激活序;停用走逆序。随 entries 变化重算。 */
let order: string[] = [];
/** 已卸载但目录可能还没删的:id → 卸载时的指纹。重扫见到同指纹就不复活(DELETE → 删目录 → rescan 之间的竞态)。 */
const uninstalled = new Map<string, string>();
/** 宿主的三组核心 router(createTanguModule 之后由 activateAllPlugins 返回的函数登记;TUI 没有)。 */
let hostRouters: PluginRouters | undefined;
let genSeq = 0;
/** 本进程 import 过的入口 URL(含失败的)。同一路径删了又装回来时据此破缓存,否则拿到的是旧模块。 */
const importedUrls = new Set<string>();
let queue: Promise<unknown> = Promise.resolve();

/** 生命周期操作串行化。⚠️ 串行体内绝不能再 await 另一个串行操作(会自锁)。 */
function serial<T>(op: () => Promise<T>): Promise<T> {
  const run = queue.then(op);
  queue = run.catch(() => {});
  return run;
}

// 绕过 setPluginEnabledLive 直接落盘的开关(channels 里开语音消息等):落盘后排一轮收敛。只排队不 await —— 由生命周期
// 自己的串行体触发时(setPluginEnabledLive 内部落盘)等不到它,排在后面空转一轮即可。
pluginStore.onPluginEnabledChange(() => {
  if (entries.size) void serial(reconcile).catch(() => {});
});

function newEntry(d: DiscoveredPlugin): Entry {
  return { d, gen: 0, failed: false, leaving: false, metaIds: new Set() };
}

function reorder(): void {
  order = orderByRequires([...entries.values()].map((e) => e.d)).map((d) => d.manifest.id);
}

/**
 * 启用态:有同 id meta → 设置里的开关(含 defaultEnabled 回落);没登记 meta 的插件(如只注册命令的 forsion-worker、
 * 只挂裸 provider 的)在设置页没有开关 → 视为常开,与今日一致。离场中的按未启用算。
 */
function enabledOf(e: Entry): boolean {
  if (e.leaving) return false;
  const id = e.d.manifest.id;
  return getPluginMeta(id) ? pluginStore.isPluginEnabledSync(id) : true;
}

/** a 是否(传递地)依赖 b。 */
function dependsOn(a: string, b: string, seen = new Set<string>()): boolean {
  if (seen.has(a)) return false;
  seen.add(a);
  for (const r of entries.get(a)?.d.requiresPlugins ?? []) {
    if (r.id === b || dependsOn(r.id, b, seen)) return true;
  }
  return false;
}

/**
 * 逐条判前置。原因优先级固定(桌面同口径):missing → version → cycle → off → waiting —— 先静态(装没装、版本、环),
 * 后动态(开没开、在不在跑)。`isUp` = 该前置此刻(或收敛目标里)是否在跑。
 */
function unmetOf(e: Entry, isUp: (id: string) => boolean): PluginWaitingFor[] {
  const self = e.d.manifest.id;
  const out: PluginWaitingFor[] = [];
  for (const r of e.d.requiresPlugins) {
    const dep = entries.get(r.id);
    const mv = r.minVersion ? { minVersion: r.minVersion } : {};
    if (!dep) out.push({ id: r.id, reason: 'missing', ...mv });
    else if (r.minVersion && compareVersions(dep.d.manifest.version, r.minVersion) < 0) out.push({ id: r.id, reason: 'version', ...mv, have: String(dep.d.manifest.version ?? '') });
    else if (r.id === self || dependsOn(r.id, self)) out.push({ id: r.id, reason: 'cycle' });
    else if (!enabledOf(dep)) out.push({ id: r.id, reason: 'off' });
    else if (!isUp(r.id)) out.push({ id: r.id, reason: 'waiting' });
  }
  return out;
}

const TIMED_OUT = Symbol('timed out');

/**
 * 限时跑 op。op 自己抛 → 原样抛;超时 → 抛,并把还在跑的 op 记成条目的 busy:落定前 reconcile 不会再起这个条目 ——
 * 同一模块对象上叠两份 activate,或迟到的 deactivate 清掉新实例的模块级资源(Codex 10-02);落定后排一轮收敛。
 * 只排队,绝不在串行体里 await busy(会把整条生命周期链一起挂住)。
 */
async function withDeadline(e: Entry, what: string, ms: number, op: () => unknown): Promise<void> {
  const run = Promise.resolve().then(op);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<typeof TIMED_OUT>((resolve) => {
    timer = setTimeout(() => resolve(TIMED_OUT), ms);
    timer.unref?.();
  });
  try {
    if ((await Promise.race([run, deadline])) !== TIMED_OUT) return;
  } finally {
    clearTimeout(timer);
  }
  const busy: Promise<void> = Promise.all([e.busy, run.catch(() => {})]).then(() => {
    if (e.busy !== busy) return;
    e.busy = undefined;
    void serial(reconcile).catch(() => {});
  });
  e.busy = busy;
  throw new Error(`${what} timed out after ${ms}ms`);
}

/** 激活一个条目的新实例(复用已 import 的模块;没有才 import)。失败 → 回滚台账、休眠、记 lastError,返回 false。 */
async function startEntry(e: Entry): Promise<boolean> {
  const id = e.d.manifest.id;
  const inst = newInstance(e.metaIds);
  e.inst = inst;
  try {
    // import 与 activate 一起限时:吊死的连接 / 顶层 await 不许堵住整条生命周期链(重扫、开关、卸载全排在它后面)
    await withDeadline(e, 'activate', lifecycleTimeouts.activateMs, async () => {
      if (e.plugin) {
        assertNativePluginsAllowed(); // 复用已 import 的模块对象也要过沙箱闸
      } else {
        if (!e.gen && importedUrls.has(e.d.entryUrl)) e.gen = ++genSeq; // 卸载后同路径重装:破入口缓存
        importedUrls.add(e.d.entryUrl);
        e.plugin = await loadPlugin(e.d, e.gen);
      }
      inst.plugin = e.plugin;
      await e.plugin.activate(makeContext(e.d, inst));
    });
    inst.activated = true;
    e.failed = false;
    e.lastError = undefined;
    mountRoutes(id, inst);
    return true;
  } catch (err: any) {
    e.failed = true;
    e.lastError = String(err?.message || err).slice(0, 500);
    console.warn(`[tangu] 插件 ${id} 激活失败,休眠:${e.lastError}`);
    await stopEntry(e); // 回滚已登记的半截效果,并给插件一次 deactivate 收尾
    return false;
  }
}

/** 停用当前实例:① deactivate(限时)② 撤 provider(保槽位)③ 摘路由 ④ 丢命令 ⑤ meta 休眠(仍列出)。 */
async function stopEntry(e: Entry): Promise<void> {
  const inst = e.inst;
  if (!inst) return;
  const id = e.d.manifest.id;
  inst.disposed = true; // 旧 ctx 从此失效
  for (const off of inst.runtimeDisposers.splice(0)) { try { off(); } catch { /* dispose independently */ } }
  const p = inst.plugin;
  if (p?.deactivate) {
    try {
      await withDeadline(e, 'deactivate', lifecycleTimeouts.deactivateMs, () => p.deactivate!());
    } catch (err: any) {
      console.warn(`[tangu] 插件 ${id} deactivate 失败(继续拆除):${err?.message || err}`);
    }
  }
  for (const pid of inst.providerIds) {
    if (providerOwner.get(pid) !== id) continue; // 已被别的插件同 id 覆盖:那是人家的
    unregisterToolProvider(pid);
    providerOwner.delete(pid);
  }
  inst.routers = undefined; // 分发器从下一个请求起就看不到它
  inst.routeMounters.length = 0;
  inst.commands.clear();
  inst.profiles.clear();
  inst.hostAdapters.clear();
  inst.brainAdapters.clear();
  inst.billingAdapters.clear();
  for (const mid of inst.metaIds) setPluginDormant(mid);
  e.inst = undefined;
}

/** 收敛到不动点(有界):算目标集 → 逆拓扑停集合外的 → 拓扑启集合内的。激活抛错的(failed)不在目标里,不自动重试;
 *  上一次 activate / deactivate 还没落定的(busy)也不在,落定后自会排一轮。 */
async function reconcile(): Promise<void> {
  for (let round = 0; round < entries.size + 2; round++) {
    const target = new Set<string>();
    for (const id of order) {
      const e = entries.get(id);
      if (e && !e.failed && !e.busy && enabledOf(e) && !unmetOf(e, (x) => target.has(x)).length) target.add(id);
    }
    let changed = false;
    for (const id of [...order].reverse()) {
      const e = entries.get(id);
      if (e?.inst && !target.has(id)) {
        await stopEntry(e);
        changed = true;
      }
    }
    for (const id of order) {
      const e = entries.get(id);
      // 前置须**此刻**真在跑:同一轮里前置激活失败,依赖者这轮先不起,下一轮目标集会把它剔掉。
      if (e && !e.inst && target.has(id) && e.d.requiresPlugins.every((r) => entries.get(r.id)?.inst)) {
        await startEntry(e);
        changed = true;
      }
    }
    if (!changed) return;
  }
  console.warn('[tangu] 插件收敛未在上限轮数内到达不动点(忽略)');
}

/** 彻底注销一个已停的条目(meta 也不再列出)。 */
function dropEntry(id: string): void {
  const e = entries.get(id);
  if (!e) return;
  for (const mid of e.metaIds) unregisterPlugin(mid);
  unregisterPlugin(id);
  entries.delete(id);
}

/** 活跃实例 + 宿主 router 已知 → 把尚未挂的路由挂载器跑进本实例专属的子 router。 */
function mountRoutes(id: string, inst: Instance): void {
  if (!hostRouters || inst.disposed || inst.mounted >= inst.routeMounters.length) return;
  inst.routers ??= { userRouter: Router(), dataRouter: Router(), adminRouter: Router() };
  for (; inst.mounted < inst.routeMounters.length; inst.mounted++) {
    try {
      inst.routeMounters[inst.mounted](inst.routers);
    } catch (err: any) {
      console.warn(`[tangu] 插件 ${id} 路由挂载失败:${err?.message || err}`);
    }
  }
}

/**
 * 宿主 router 上的唯一分发器:按插件 id 序把请求依次交给活跃实例的子 router,都不接就 next()。
 * 本身不处理任何请求(无路径中间件但完全透明),只在 standalone / TUI 装配,云端 microserver 不经这里。
 */
function dispatcher(key: keyof PluginRouters) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const subs = [...entries.keys()].sort().map((id) => entries.get(id)?.inst?.routers?.[key]).filter((r): r is Router => !!r);
    let i = 0;
    const step = (err?: unknown): void => {
      if (err) return next(err);
      const sub = subs[i++];
      if (!sub) return next();
      sub(req, res, step);
    };
    step();
  };
}

/** activateAllPlugins 返回的挂载函数:每组核心 router 末尾(核心路由之后,与旧版同位)装一个分发器,补挂已激活实例的路由。 */
function attachHostRouters(r: PluginRouters): void {
  if (hostRouters) return; // 只装一次
  hostRouters = r;
  r.userRouter.use(dispatcher('userRouter'));
  r.dataRouter.use(dispatcher('dataRouter'));
  r.adminRouter.use(dispatcher('adminRouter'));
  for (const [id, e] of entries) if (e.inst?.activated) mountRoutes(id, e.inst);
}

/**
 * standalone / TUI 启动:激活全部插件(按依赖拓扑序;无依赖时 = id 序,工具定义顺序与旧版逐字一致)——meta / defaultEnabled
 * 只有激活后才知道,所以照旧先全部激活一次,再收敛:未启用或前置没齐的立即 deactivate 休眠。
 * 返回把插件路由接到三组 router 的函数——**须在 `createTanguModule` 之后调用**（彼时 `configureTangu`/`deps()` 才就绪;
 * 路由挂载器内部可能读 `deps()`）。之后运行期激活的插件路由经分发器即时生效,不再需要重启。
 * tool provider 注册是无状态的静态写入，先于 createTanguModule 也安全。
 */
export async function activateAllPlugins(onActivate?: (id: string) => void): Promise<(r: PluginRouters) => void> {
  await serial(async () => {
    await seedBundleAgents().catch(() => {}); // bundle 内嵌 agent 播种(幂等,永不覆盖已有)
    for (const d of discoverPlugins()) if (!entries.has(d.manifest.id)) entries.set(d.manifest.id, newEntry(d));
    reorder();
    for (const id of order) {
      const e = entries.get(id)!;
      if (e.inst || e.failed || e.busy) continue;
      onActivate?.(id); // 启动阶段标记:某个插件的 import/activate 吊死时,standalone 能说出是谁
      await startEntry(e);
    }
    await reconcile();
  });
  return attachHostRouters;
}

/**
 * 运行期重扫 = 与磁盘同步(市场装 / 更新 / 删插件后无需重启):
 *   - 新 id → 激活一次 + 收敛(新插件即时出现在列表、按开关生效);
 *   - 目录消失 → 依赖者先休眠,再 deactivate + 彻底注销 meta;
 *   - 同 id 指纹变了(manifest 版本 / 包内代码文件 mtime·size)→ 原地升级:停旧实例(依赖者先停)、带 `?tangu-gen=` 重新
 *     import 入口(同包 ESM 文件经模块钩子带上同一代号)、激活新模块、依赖者随收敛重启。破不了缓存的(cannotHotSwap:
 *     CommonJS / 自带 node_modules / 运行时没有模块钩子)与本进程换代已满的不热升级:老实例照跑,标 pluginsNeedingRestart,
 *     needsRestart=true。
 * addedIds / reloadedIds = 新代码**激活成功**的 id(失败的看列表 lastError);removedIds = 已注销的 id。
 */
export function rescanPlugins(): Promise<{ addedIds: string[]; reloadedIds: string[]; removedIds: string[]; needsRestart: boolean }> {
  return serial(async () => {
    await seedBundleAgents().catch(() => {}); // 市场装 bundle 后重扫即播种其内嵌 agent,无需重启
    const found = new Map(discoverPlugins().map((d) => [d.manifest.id, d]));
    for (const [id, fp] of [...uninstalled]) {
      if (found.get(id)?.fingerprint === fp) found.delete(id); // 还是被卸载的那一份(目录待删):别复活
      else uninstalled.delete(id); // 目录已删 / 重装了新代码:墓碑作废
    }
    const removedIds: string[] = [];
    const reloading: Entry[] = [];
    let needsRestart = false;
    for (const [id, e] of entries) {
      const d = found.get(id);
      if (!d) {
        e.leaving = true;
        removedIds.push(id);
      } else if (d.fingerprint === e.d.fingerprint) {
        e.d = d; // 代码没变:顺手刷新图标 / 前置等元数据
      } else if (cannotHotSwap(d) || genSeq >= MAX_HOT_GENERATIONS) {
        pluginsNeedingRestart.add(id); // 老实例照跑,如实标需重启
        needsRestart = true;
      } else {
        e.leaving = true;
        reloading.push(e);
      }
    }
    await reconcile(); // 离场者的依赖者先停,再停离场者本身
    for (const id of removedIds) dropEntry(id);
    for (const e of reloading) {
      const d = found.get(e.d.manifest.id)!;
      Object.assign(e, { d, plugin: undefined, gen: ++genSeq, failed: false, lastError: undefined, leaving: false });
      pluginsNeedingRestart.delete(d.manifest.id);
    }
    const fresh = new Set<string>();
    for (const [id, d] of found) {
      if (entries.has(id)) continue;
      const e = newEntry(d);
      entries.set(id, e);
      if (importedUrls.has(d.entryUrl) && (cannotHotSwap(d) || genSeq >= MAX_HOT_GENERATIONS)) {
        // 同一路径本进程 import 过(删了又装回来),入口相对引入的旧模块还在缓存里 → 不拼凑新旧代码,重启后生效。
        e.failed = true;
        e.lastError = 'Plugin code changed on disk; restart the engine to load it';
        pluginsNeedingRestart.add(id);
        needsRestart = true;
        continue;
      }
      fresh.add(id);
    }
    reorder();
    // 新来的与换代的各激活一次(meta / defaultEnabled 只有激活后才知道),再统一收敛(未启用 / 前置没齐的随即休眠)。
    const addedIds: string[] = [];
    const reloadedIds: string[] = [];
    for (const id of order) {
      const e = entries.get(id)!;
      if (fresh.has(id)) {
        if (await startEntry(e)) addedIds.push(id);
      } else if (reloading.includes(e) && !e.busy) { // 旧版 deactivate 还没落定 → 等它落定那轮收敛再起新版
        if (await startEntry(e)) reloadedIds.push(id);
      }
    }
    await reconcile();
    return { addedIds, reloadedIds, removedIds, needsRestart };
  });
}

/** 旧名(只激活全新 id 的年代);现与 rescanPlugins 同义。 */
export const activateNewPlugins = rescanPlugins;

/** PUT /agent/plugins/:id/enabled:落盘开关(同旧),再现场收敛 —— 启用即激活(级联依赖者)、停用即 deactivate(依赖者先休眠)。
 *  显式拨开关 = 允许重试上次激活失败的插件。再启用复用已 import 的模块对象,不重 import。 */
export function setPluginEnabledLive(id: string, enabled: boolean): Promise<void> {
  return serial(async () => {
    await pluginStore.setPluginEnabled(id, enabled);
    const e = entries.get(id);
    if (e) {
      e.failed = false;
      e.lastError = undefined;
    }
    await reconcile();
  });
}

/** 卸载(DELETE /agent/plugins/:id、`tangu plugin uninstall`):依赖者先休眠,再 deactivate + 撤销 + 注销 meta。
 *  文件夹由调用方删;删之前的重扫不会把它复活(墓碑)。没进生命周期的 id(加载失败的孤儿 / builtin)照旧只注销 meta。 */
export function removePluginLive(id: string): Promise<void> {
  return serial(async () => {
    const e = entries.get(id);
    if (!e) {
      unregisterPlugin(id);
      return;
    }
    e.leaving = true;
    await reconcile();
    uninstalled.set(id, e.d.fingerprint);
    dropEntry(id);
    reorder();
  });
}

/** 列表用的运行态(同步读,不进串行队列)。没进生命周期的 meta(编进 app 的 builtin 等):active = 启用态,无 version。 */
export function pluginStatus(id: string): PluginStatus {
  const e = entries.get(id) ?? [...entries.values()].find((x) => x.metaIds.has(id));
  if (!e) return { active: pluginStore.isPluginEnabledSync(id) };
  const out: PluginStatus = { active: !!e.inst };
  if (e.d.manifest.version) out.version = String(e.d.manifest.version);
  if (e.d.requiresPlugins.length) out.requiresPlugins = e.d.requiresPlugins;
  if (!e.inst && enabledOf(e)) {
    const waiting = unmetOf(e, (x) => !!entries.get(x)?.inst);
    if (waiting.length) out.waitingFor = waiting;
  }
  if (e.lastError) out.lastError = e.lastError;
  if (e.busy && !e.inst) out.settling = true;
  return out;
}
