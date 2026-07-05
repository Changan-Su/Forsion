/**
 * standalone 形态的共享装配:host(嵌入式 PGlite / 外部 PG)、brain(httpBrain / multiBrain)、
 * 沙箱探测。被 standalone/main.ts(server 前端)与 cli/main.ts(终端前端)共用,杜绝漂移。
 */
import { execFile } from 'node:child_process';
import { readFileSync, mkdirSync } from 'node:fs';
import { query } from '../core/db.js';
import { providersFile as homeProvidersFile, pgdataDir, stateDbPath } from '../core/tanguHome.js';
import { toSqliteDDL } from '../core/dialectDDL.js';
import type { HostServices } from '../seams/hostServices.js';
import type { CloudBrainServices } from '../seams/cloudBrain.js';
import { createLocalHost } from '../adapters/standalone/localHost.js';
import { createSqliteHost } from '../adapters/standalone/sqliteHost.js';
import { createEmbeddedHost } from '../adapters/standalone/embeddedHost.js';
import { createHttpBrain } from '../adapters/standalone/httpBrain.js';
import { createMultiBrain } from '../adapters/standalone/multiBrain.js';
import { createLocalAssets } from '../adapters/standalone/localAssetsBrain.js';
import { createLocalMemoryBrain } from '../adapters/standalone/localMemoryBrain.js';
import { setSyncSources } from '../services/memorySyncService.js';
import { createProviderRegistry, type DirectProvider } from '../llm/providerRegistry.js';
import { STANDALONE_SCHEMA } from '../db/schemaStandalone.js';
import { getRawSection } from '../core/config.js';
import type { StandaloneConfig } from './config.js';

/** 读一个 providers JSON(裸数组或 { providers: [...] } 包装);失败/缺失返回 []。 */
function readProvidersJson(path: string, label: string, warnMissing: boolean): DirectProvider[] {
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8'));
    const arr = Array.isArray(parsed) ? parsed : Array.isArray(parsed?.providers) ? parsed.providers : null;
    if (!arr) {
      console.warn(`[tangu] ${label} 既不是数组也不是 { providers: [...] },已忽略: ${path}`);
      return [];
    }
    return arr;
  } catch (e: any) {
    if (warnMissing) console.warn(`[tangu] 读取 ${label} 失败,已忽略: ${e?.message || e}`);
    return []; // home providers.json 不存在是常态,静默
  }
}

/** config.json 的 providers 段优先;缺失回落 legacy ~/.tangu/providers.json(过渡/单测)。 */
function configProviders(): DirectProvider[] {
  const sec = getRawSection('providers');
  if (sec !== undefined) return Array.isArray(sec) ? sec : [];
  return readProvidersJson(homeProvidersFile(), '~/.tangu/providers.json', false);
}

/**
 * 合并直连 provider 各来源,优先级(同 providerId 先到先得):
 *   CLI/env inline > --providers-file > config.json providers 段(desktop Providers 页写入)> OAuth 登录派生。
 * 显式配置永远压过订阅登录;文件读失败仅告警,不阻断启动。
 */
export function loadProviders(cfg: StandaloneConfig): DirectProvider[] {
  const merged: DirectProvider[] = [
    ...cfg.providers,
    ...(cfg.providersFile ? readProvidersJson(cfg.providersFile, 'providers-file', true) : []),
    ...configProviders(),
    ...(cfg.oauthProviders ?? []),
  ];
  const seen = new Set<string>();
  return merged.filter((p) => {
    if (!p?.providerId || !p?.baseUrl) return false;
    if (seen.has(p.providerId)) return false;
    seen.add(p.providerId);
    return true;
  });
}

function dockerAvailable(): Promise<boolean> {
  return new Promise((resolve) => {
    const p = execFile('docker', ['version', '--format', '{{.Server.Version}}'], (err) => resolve(!err));
    p.on('error', () => resolve(false));
  });
}

export async function resolveSandboxMode(cfg: StandaloneConfig): Promise<'docker' | 'none'> {
  if (cfg.sandbox === 'docker') return 'docker';
  if (cfg.sandbox === 'none') return 'none';
  const ok = await dockerAvailable(); // auto
  if (!ok) console.warn('[tangu] 未检测到 docker → 沙箱禁用(run_python/pip_install 不可用)。');
  return ok ? 'docker' : 'none';
}

/**
 * 装配 host:配了 --db → 外部 Postgres(localHost);否则 → 嵌入式 **SQLite/WAL**(零安装,落 state.db)。
 * TUI/standalone/desktop 三端默认同指 ~/.tangu/state.db,WAL 一写多读 → 本地会话/run 跨前端共享。
 * 返回 host + 跑「base schema」的函数 + 存储描述。(回退:env TANGU_EMBED=pglite 走旧 PGlite,不共享。)
 */
export async function setupHost(
  cfg: StandaloneConfig,
): Promise<{ host: HostServices; runBaseSchema: () => Promise<void>; storage: string }> {
  if (cfg.databaseUrl) {
    const { host, pool } = createLocalHost({ databaseUrl: cfg.databaseUrl, localToken: cfg.token, userId: cfg.userId });
    return { host, runBaseSchema: async () => { await pool.query(STANDALONE_SCHEMA); }, storage: '外部 Postgres' };
  }
  const inMemory = cfg.dataDir === 'memory';
  // 回退闸:TANGU_EMBED=pglite 仍走旧 PGlite(单进程,不与他端共享),用于排障/回滚。
  if (process.env.TANGU_EMBED === 'pglite') {
    const dataDir = inMemory ? undefined : (cfg.dataDir || pgdataDir());
    if (dataDir) mkdirSync(dataDir, { recursive: true });
    const { host, db } = await createEmbeddedHost({ dataDir, localToken: cfg.token, userId: cfg.userId });
    return { host, runBaseSchema: async () => { await db.exec(STANDALONE_SCHEMA); }, storage: inMemory ? 'PGlite(内存)' : `PGlite(${dataDir})` };
  }
  // 默认:原生 SQLite(WAL)。dataDir 是文件路径('memory'=内存库);三端默认同指 ~/.tangu/state.db。
  const dbPath = inMemory ? 'memory' : (cfg.dataDir || stateDbPath());
  const { host, db } = createSqliteHost({ dataDir: dbPath, localToken: cfg.token, userId: cfg.userId });
  return {
    host,
    runBaseSchema: async () => { db.exec(toSqliteDDL(STANDALONE_SCHEMA)); },
    storage: inMemory ? 'SQLite(内存)' : `SQLite(${dbPath})`,
  };
}

/**
 * brain:有直连 provider 则 multiBrain(本地命中走直连,其余委托 Forsion);否则纯 httpBrain。
 * 再叠两层本地 overlay:
 *   - assets:包内置 skills/ + ~/.tangu/skills/ 磁盘技能(`local:` 前缀,面板/use_skill 自动可见)。
 *   - memory:**本地优先**记忆/日志(~/.tangu/memory/),运行时不打网络;与 Forsion Brain 的同步由
 *     out-of-band 的 memorySync 服务负责(见 services/memorySync.ts),不在热路径。
 * httpBrain 仍构造(供同步服务调用云端 memory/log 端点),但不再是运行时 memory 来源。
 */
export function buildBrain(cfg: StandaloneConfig): { brain: CloudBrainServices; providers: DirectProvider[] } {
  const httpBrain = createHttpBrain({ cloudUrl: cfg.cloudUrl, token: cfg.token });
  const providers = loadProviders(cfg);
  const base = providers.length ? createMultiBrain(httpBrain, createProviderRegistry(providers)) : httpBrain;
  const localMemory = createLocalMemoryBrain();
  const brain = { ...base, assets: createLocalAssets(base.assets), memory: localMemory };
  // 同步源:云端 httpBrain(有 agentFiles 每-agent 镜像 + memory 旧全局端点)。每-agent 桶在 syncNow 内
  // 按 cloudSync + 固定 baseDir 解析,不再依赖单 store/ALS(根治「只同步 xyra」bug)。
  setSyncSources({ brain: httpBrain });
  return { brain, providers };
}

/**
 * 修复历史 mis-tag:runs.ts 曾硬编码 app_id='ai-studio',standalone 本地库经它自动建的会话/run
 * 被错误标记,TUI 的 /sessions(按 app_id='tangu' 过滤)看不见。幂等,一次跑完即静默。
 * ⚠️ 仅 standalone 本地库(PGlite / 用户自带 PG)调用——绝不可在共享云库(microserver/worker)上跑。
 * 须在 configureTangu + runMigration 之后调用(query 经 deps().host)。
 */
export async function fixLegacyAppIds(): Promise<void> {
  try {
    await query(`UPDATE chat_sessions SET app_id = 'tangu' WHERE app_id = 'ai-studio'`);
    await query(`UPDATE agent_runs SET app_id = 'tangu' WHERE app_id = 'ai-studio'`);
  } catch (e: any) {
    console.warn('[tangu] legacy app_id 修正失败(忽略):', e?.message || e);
  }
}
