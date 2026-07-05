/**
 * ProfileStore —— 配置驱动 profile 的运行期单例(每进程一个,挂 TanguDeps.profileStore)。
 *
 * profile(appId) = baseline(ai-studio,部署opts) ⊕ fileOverride(appId) ⊕ dbOverride(appId)。
 * 快照 Map<appId, AppProfile> 不可变、同步可读(resolveProfile 是同步热路径);后台定时器轮询
 * 共享云库 app_profile_overrides 重建快照 → admin panel 改完,所有(含远程)worker ≤一个刷新窗口
 * 无需重启收敛。无 DB 行时回落文件/基线;standalone(SQLite)同此机制,通常空表。
 */
import type { AppProfile, AppProfileOverride } from '../seams/appProfile.js';
import { mergeProfile, getKnownToolNames } from './mergeProfile.js';
import { APP_PROFILE_OVERRIDES } from './appProfiles.config.js';
import { query } from '../core/db.js';

const DEFAULT_POLL_MS = 15_000; // 对齐 workerRegistry PROBE_INTERVAL_MS

/** 面板用的可序列化 profile 视图(promptSections 函数已按 execMode 求值为文本数组)。 */
export interface ProfileView {
  appId: string;
  enabled: boolean;
  displayName: string;
  defaultModelId: string | null;
  sandboxMode: 'docker' | 'none';
  capabilities: { hostExec: boolean; groupChat: boolean; memory: boolean; log: boolean };
  features: { sandbox: boolean; webSearch: boolean; historian: boolean; customTools: boolean };
  toolBuiltins: 'all' | string[];
  promptGuidance: string[];
  promptEnvironment: string[];
}

/** describe() 的每 app 条目:生效视图 + 原始文件/DB 覆盖 + 强制(只读)字段标记。 */
export interface ProfileEntry {
  appId: string;
  enabled: boolean;
  effective: ProfileView;
  fileOverride: AppProfileOverride | null;
  dbOverride: AppProfileOverride | null;
  /** 部署级强制、面板只读展示。 */
  forced: { hostExec: boolean; historian: boolean; sandboxMode: 'docker' | 'none' };
}

export interface ProfileStore {
  /** 同步解析(resolveProfile 用):缺省 appId → 基线 app;命中且 enabled → 返回;否则 null。 */
  resolve(appId?: string | null): AppProfile | null;
  /** 面板用:列全部已知 app(含 disabled)+ 生效视图 + 原始覆盖。 */
  describe(): ProfileEntry[];
  /** 已注册内置工具名(面板白名单清单)。 */
  knownTools(): string[];
  /** 启动轮询(立即先刷一次)。 */
  start(pollMs?: number): void;
  /** 立即重建快照(admin 写后本进程即时生效)。 */
  refreshNow(): Promise<void>;
  /** upsert 一个 app 的 DB 覆盖(写表 + 立即刷新)。 */
  upsert(appId: string, override: AppProfileOverride): Promise<void>;
  /** 删除一个 app 的 DB 覆盖行(回落文件/基线 + 立即刷新)。 */
  remove(appId: string): Promise<void>;
  dispose(): void;
}

/** JSONB(pg 已解析对象/数组/字符串) 或 TEXT(sqlite 原始 JSON 串) 统一成 JS 值。 */
function parseJson(v: any): any {
  if (v === null || v === undefined) return undefined;
  if (typeof v === 'string') {
    try {
      return JSON.parse(v);
    } catch {
      return v;
    }
  }
  return v;
}

function rowToOverride(r: any): AppProfileOverride {
  return {
    enabled: r.enabled === false || r.enabled === 0 ? false : true,
    displayName: r.display_name ?? undefined,
    defaultModelId: r.default_model_id ?? undefined,
    toolBuiltins: parseJson(r.tool_builtins),
    capabilities: parseJson(r.capabilities),
    features: parseJson(r.features),
    promptGuidance: parseJson(r.prompt_guidance),
    promptEnvironment: parseJson(r.prompt_environment),
  };
}

/** 文件 ⊕ DB 合并成单个覆盖(DB 逐字段优先;嵌套对象浅合并;数组整体替换)。 */
function combineOverrides(
  file?: AppProfileOverride | null,
  db?: AppProfileOverride | null,
): AppProfileOverride {
  const f = file || {};
  const d = db || {};
  return {
    enabled: d.enabled ?? f.enabled,
    displayName: d.displayName ?? f.displayName,
    defaultModelId: d.defaultModelId !== undefined ? d.defaultModelId : f.defaultModelId,
    toolBuiltins: d.toolBuiltins ?? f.toolBuiltins,
    capabilities: { ...f.capabilities, ...d.capabilities },
    features: { ...f.features, ...d.features },
    promptGuidance: d.promptGuidance ?? f.promptGuidance,
    promptEnvironment: { ...f.promptEnvironment, ...d.promptEnvironment },
  };
}

function viewOf(p: AppProfile, enabled: boolean): ProfileView {
  const ctx = { execMode: (p.capabilities.hostExec ? 'host' : 'sandbox') as 'host' | 'sandbox' };
  const sec = p.promptSections(ctx);
  return {
    appId: p.appId,
    enabled,
    displayName: p.displayName,
    defaultModelId: p.defaultModelId ?? null,
    sandboxMode: p.sandboxMode,
    capabilities: { ...p.capabilities },
    features: { ...p.features },
    toolBuiltins: Array.isArray(p.toolLoadout.builtins) ? [...p.toolLoadout.builtins] : 'all',
    promptGuidance: sec.guidance,
    promptEnvironment: sec.environment,
  };
}

export function createProfileStore(opts: {
  baseline: AppProfile;
  /** 部署明确服务的 appId(worker 的 TANGU_APP_IDS);确保无覆盖的 app 也在快照里。 */
  seedAppIds?: string[];
  /** 文件覆盖层;缺省取 checked-in APP_PROFILE_OVERRIDES。 */
  fileOverrides?: Record<string, AppProfileOverride>;
}): ProfileStore {
  const baseline = opts.baseline;
  const fileOverrides = opts.fileOverrides ?? APP_PROFILE_OVERRIDES;
  const seedAppIds = opts.seedAppIds ?? [baseline.appId];

  let dbOverrides: Record<string, AppProfileOverride> = {};
  let snapshot = new Map<string, AppProfile>();
  let timer: ReturnType<typeof setInterval> | null = null;
  let disposed = false;

  /** 全部已知 appId(基线 ∪ seed ∪ 文件 ∪ DB)。 */
  function allAppIds(): string[] {
    const s = new Set<string>([baseline.appId, ...seedAppIds, ...Object.keys(fileOverrides), ...Object.keys(dbOverrides)]);
    return [...s];
  }

  /** 用当前 dbOverrides 重建快照(只收 enabled !== false)。 */
  function rebuild(): void {
    const next = new Map<string, AppProfile>();
    for (const appId of allAppIds()) {
      const combined = combineOverrides(fileOverrides[appId], dbOverrides[appId]);
      if (combined.enabled === false) continue; // 显式禁用 → 不入快照(路由 400)
      next.set(appId, mergeProfile(appId, baseline, combined));
    }
    snapshot = next;
  }

  async function refresh(): Promise<void> {
    try {
      const rows = await query<any[]>(`SELECT * FROM app_profile_overrides`);
      const map: Record<string, AppProfileOverride> = {};
      for (const r of rows || []) map[r.app_id] = rowToOverride(r);
      dbOverrides = map;
      rebuild();
    } catch (e: any) {
      // 表缺失/连接异常:保留现有快照(基线⊕文件仍可用),仅告警。
      console.warn('[tangu] app_profile_overrides 刷新失败(保留现快照):', e?.message || e);
    }
  }

  // 构造期同步建快照(基线⊕文件),保证 start() 前 resolve 即可用。
  rebuild();

  return {
    resolve(appId?: string | null): AppProfile | null {
      if (!appId) return snapshot.get(baseline.appId) ?? null;
      return snapshot.get(appId) ?? null;
    },

    describe(): ProfileEntry[] {
      return allAppIds().map((appId) => {
        const file = fileOverrides[appId] ?? null;
        const db = dbOverrides[appId] ?? null;
        const combined = combineOverrides(file, db);
        const enabled = combined.enabled !== false;
        const profile = mergeProfile(appId, baseline, combined);
        return {
          appId,
          enabled,
          effective: viewOf(profile, enabled),
          fileOverride: file,
          dbOverride: db,
          forced: {
            hostExec: baseline.capabilities.hostExec,
            historian: baseline.features.historian,
            sandboxMode: baseline.sandboxMode,
          },
        };
      });
    },

    knownTools: () => getKnownToolNames(),

    start(pollMs = DEFAULT_POLL_MS): void {
      if (timer || disposed) return;
      void refresh(); // 立即首刷(加载 DB 覆盖)
      timer = setInterval(() => { void refresh(); }, pollMs);
      if (typeof (timer as any)?.unref === 'function') (timer as any).unref();
    },

    refreshNow: () => refresh(),

    async upsert(appId: string, ov: AppProfileOverride): Promise<void> {
      const j = (v: any) => (v === undefined ? null : JSON.stringify(v));
      await query(
        `INSERT INTO app_profile_overrides
           (app_id, enabled, display_name, default_model_id, tool_builtins, capabilities, features, prompt_guidance, prompt_environment, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
         ON CONFLICT (app_id) DO UPDATE SET
           enabled = EXCLUDED.enabled,
           display_name = EXCLUDED.display_name,
           default_model_id = EXCLUDED.default_model_id,
           tool_builtins = EXCLUDED.tool_builtins,
           capabilities = EXCLUDED.capabilities,
           features = EXCLUDED.features,
           prompt_guidance = EXCLUDED.prompt_guidance,
           prompt_environment = EXCLUDED.prompt_environment,
           updated_at = CURRENT_TIMESTAMP`,
        [
          appId,
          ov.enabled === false ? false : true,
          ov.displayName ?? null,
          ov.defaultModelId ?? null,
          j(ov.toolBuiltins),
          j(ov.capabilities),
          j(ov.features),
          j(ov.promptGuidance),
          j(ov.promptEnvironment),
        ],
      );
      await refresh();
    },

    async remove(appId: string): Promise<void> {
      await query(`DELETE FROM app_profile_overrides WHERE app_id = ?`, [appId]);
      await refresh();
    },

    dispose(): void {
      disposed = true;
      if (timer) { clearInterval(timer); timer = null; }
    },
  };
}
