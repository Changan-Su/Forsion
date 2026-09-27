/**
 * Historian（空闲会话复盘）运行期配置：开关 / 空闲触发时长 / 摘要模型。
 * 默认值来自环境变量；admin 可在后台覆盖（落 global_settings）。同步 getter，启动 + set 后刷新内存。
 * 仿 sandbox/sandboxConfig.ts，但值有 bool/num/str 三类（global_settings.value 是 TEXT）。
 */
import { query } from '../core/db.js';
import { SPECIAL_AGENTS_DEFAULTS } from './specialAgentsConfig.js';

const K_ENABLED = 'agent_historian.enabled';
const K_IDLE_MINUTES = 'agent_historian.idle_minutes';
const K_MODEL_ID = 'agent_historian.model_id';

export interface HistorianConfig {
  enabled: boolean;
  idleMinutes: number; // 空闲多久触发复盘（分钟，1-1440）
  modelId: string;     // 摘要用的轻量模型 id（空 = 未配置，则不跑）
}

function clampInt(n: number, min: number, max: number): number {
  if (!Number.isFinite(n)) return min;
  return Math.max(min, Math.min(max, Math.round(n)));
}

/** 环境变量默认值（admin 未覆盖时生效）。默认关闭。 */
export const HISTORIAN_DEFAULTS: HistorianConfig = {
  enabled: (process.env.AGENT_HISTORIAN_ENABLED ?? 'false') === 'true',
  idleMinutes: clampInt(Number(process.env.AGENT_HISTORIAN_IDLE_MIN) || 10, 1, 1440),
  modelId: process.env.AGENT_HISTORIAN_MODEL || '',
};

let current: HistorianConfig = { ...HISTORIAN_DEFAULTS };

/** 同步取当前生效配置（内存缓存）。 */
export function historianConfig(): HistorianConfig {
  return current;
}

async function readStr(key: string, fallback: string): Promise<string> {
  try {
    const rows = await query<any[]>(`SELECT value FROM global_settings WHERE "key" = ? LIMIT 1`, [key]);
    return rows.length ? String(rows[0].value) : fallback;
  } catch {
    return fallback;
  }
}
async function writeStr(key: string, value: string): Promise<void> {
  await query(
    `INSERT INTO global_settings ("key", value) VALUES (?, ?)
     ON CONFLICT ("key") DO UPDATE SET value = EXCLUDED.value`,
    [key, value],
  );
}
async function readBool(key: string, fallback: boolean): Promise<boolean> {
  const v = await readStr(key, fallback ? '1' : '0');
  return v === '1' || v === 'true';
}
async function readNum(key: string, fallback: number): Promise<number> {
  const v = await readStr(key, String(fallback));
  const n = parseFloat(v);
  return Number.isNaN(n) ? fallback : n;
}

/** 从 DB 读覆盖值刷新到内存（启动时 + set 后调用）。失败则维持现值。 */
export async function loadHistorianConfig(): Promise<HistorianConfig> {
  const [enabled, idle, modelId] = await Promise.all([
    readBool(K_ENABLED, HISTORIAN_DEFAULTS.enabled),
    readNum(K_IDLE_MINUTES, HISTORIAN_DEFAULTS.idleMinutes),
    readStr(K_MODEL_ID, HISTORIAN_DEFAULTS.modelId),
  ]);
  current = { enabled, idleMinutes: clampInt(idle, 1, 1440), modelId: modelId || '' };
  return current;
}

/** admin 设置：只更新传入字段，校验持久化，刷新内存。返回最新配置。 */
export async function setHistorianConfig(p: Partial<HistorianConfig>): Promise<HistorianConfig> {
  if (p.enabled != null) await writeStr(K_ENABLED, p.enabled ? '1' : '0');
  if (p.idleMinutes != null) await writeStr(K_IDLE_MINUTES, String(clampInt(p.idleMinutes, 1, 1440)));
  if (p.modelId != null) await writeStr(K_MODEL_ID, String(p.modelId || ''));
  return loadHistorianConfig();
}

// ── 云端(web/安卓)每用户的按轮 Historian 设置 ────────────────────────────────────────
// 桌面的同名设置落本机 config.json;云端没有本机文件,每用户一份存库。缺省与桌面一致:
// 开、每 3 轮、首轮也触发、模型跟随云端。admin 的 agent_historian.enabled 仍是平台总开关。
export interface UserHistorianConfig {
  enabled: boolean;
  modelId: string;        // '' = 跟随(admin 配的模型 → tangu 辅助模型槽 → 对话默认)
  everyRounds: number;
  firstRoundTrigger: boolean;
}

export const USER_HISTORIAN_DEFAULTS: UserHistorianConfig = {
  enabled: true, // 桌面落盘缺省是 false,但升级迁移会一次性打开(applySpecialAgentEnableMigration)= 实际缺省开
  modelId: SPECIAL_AGENTS_DEFAULTS.historian.modelId,
  everyRounds: SPECIAL_AGENTS_DEFAULTS.historian.everyRounds,
  firstRoundTrigger: SPECIAL_AGENTS_DEFAULTS.historian.firstRoundTrigger,
};

// ponytail: 每用户一行 global_settings(键带 userId),零迁移;每用户旋钮再多就该建 per-user 表。
const userKey = (userId: string) => `agent_historian.user.${userId}`;

function normalizeUser(raw: any): UserHistorianConfig {
  const d = USER_HISTORIAN_DEFAULTS;
  return {
    enabled: typeof raw?.enabled === 'boolean' ? raw.enabled : d.enabled,
    modelId: typeof raw?.modelId === 'string' ? raw.modelId.trim().slice(0, 200) : d.modelId,
    everyRounds: raw?.everyRounds == null ? d.everyRounds : clampInt(Number(raw.everyRounds), 1, 100),
    firstRoundTrigger: typeof raw?.firstRoundTrigger === 'boolean' ? raw.firstRoundTrigger : d.firstRoundTrigger,
  };
}

/** 读失败 / 未设置 → 缺省。 */
export async function loadUserHistorianConfig(userId: string): Promise<UserHistorianConfig> {
  const v = await readStr(userKey(userId), '');
  try { return normalizeUser(v ? JSON.parse(v) : {}); } catch { return { ...USER_HISTORIAN_DEFAULTS }; }
}

/** 只认四个键,其余字段(旧版前端整包 POST 的 muse / mode / prompt 等)忽略。 */
export async function saveUserHistorianConfig(userId: string, patch: Partial<UserHistorianConfig>): Promise<UserHistorianConfig> {
  const cur = await loadUserHistorianConfig(userId);
  const p = patch && typeof patch === 'object' ? patch : {};
  const next = normalizeUser({
    ...cur,
    ...('enabled' in p ? { enabled: p.enabled } : {}),
    ...('modelId' in p ? { modelId: p.modelId } : {}),
    ...('everyRounds' in p ? { everyRounds: p.everyRounds } : {}),
    ...('firstRoundTrigger' in p ? { firstRoundTrigger: p.firstRoundTrigger } : {}),
  });
  await writeStr(userKey(userId), JSON.stringify(next));
  return next;
}
