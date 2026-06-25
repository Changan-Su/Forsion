/**
 * 接缝装配点。一次性 configureTangu(deps),core 各处用 deps() 取注入的依赖
 * (避免给每个函数都加 ctx 参数的大改)。单进程单例;每个部署进程装配一次。
 */
import type { HostServices } from './hostServices.js';
import type { CloudBrainServices } from './cloudBrain.js';
import type { BillingServices } from './billing.js';
import type { AppProfile } from './appProfile.js';
import type { McpManager } from '../mcp/manager.js';
import type { EngineManager } from '../engines/manager.js';
import type { StateStore } from './stateStore.js';
import { createProfileStore, type ProfileStore } from '../profiles/profileStore.js';
import { createSqlStateStore } from '../services/stateStore/sqlStateStore.js';

export interface TanguDeps {
  host: HostServices;
  brain: CloudBrainServices;
  billing: BillingServices;
  /** 基线 profile(配置驱动多 profile 的底座);ProfileStore 以它为基线 ⊕ 文件 ⊕ DB 覆盖。 */
  profile: AppProfile;
  /** 本部署明确服务的 app(worker 的 TANGU_APP_IDS);缺省 [profile.appId]。 */
  appIds?: string[];
  /** 可选:外部已建好的 ProfileStore;不传则 configureTangu 用 profile/appIds 自动建一个。 */
  profileStore?: ProfileStore;
  /** MCP 管理器(可选):仅 standalone/TUI 装配(~/.tangu/mcp.json);microserver/worker 不传 → 云端零影响。 */
  mcp?: McpManager;
  /** 外部 agent 引擎管理器(可选):仅 standalone/desktop 装配(host-only);microserver/worker 不传 → 云端零影响。 */
  engines?: EngineManager;
  /**
   * 状态存储接缝。不传 → 默认 SqlStateStore(直连 host.query,行为零变化:microserver/standalone/TUI/网关)。
   * thin worker 传 HttpStateStore(状态走 server,无本地 DB)。
   */
  state?: StateStore;
}

/** 装配后的内部形态:profileStore / state 必定存在(configureTangu 保证)。 */
interface ResolvedDeps extends TanguDeps {
  profileStore: ProfileStore;
  state: StateStore;
}

let _deps: ResolvedDeps | null = null;

/** 装配依赖(microserver 适配器 / standalone bootstrap 各调一次)。 */
export function configureTangu(d: TanguDeps): void {
  const profileStore =
    d.profileStore ?? createProfileStore({ baseline: d.profile, seedAppIds: d.appIds });
  const state = d.state ?? createSqlStateStore();
  _deps = { ...d, profileStore, state };
}

/** 取已装配的依赖;未装配即抛(防止漏调 configureTangu)。 */
export function deps(): ResolvedDeps {
  if (!_deps) throw new Error('[tangu] runtime not configured — call configureTangu() first');
  return _deps;
}

export function isConfigured(): boolean {
  return _deps !== null;
}
