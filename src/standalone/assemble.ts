/**
 * standalone 形态的共享装配:host(嵌入式 PGlite / 外部 PG)、brain(httpBrain / multiBrain)、
 * 沙箱探测。被 standalone/main.ts(server 前端)与 cli/main.ts(终端前端)共用,杜绝漂移。
 */
import { execFile } from 'node:child_process';
import { readFileSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { HostServices } from '../seams/hostServices.js';
import type { CloudBrainServices } from '../seams/cloudBrain.js';
import { createLocalHost } from '../adapters/standalone/localHost.js';
import { createEmbeddedHost } from '../adapters/standalone/embeddedHost.js';
import { createHttpBrain } from '../adapters/standalone/httpBrain.js';
import { createMultiBrain } from '../adapters/standalone/multiBrain.js';
import { createProviderRegistry, type DirectProvider } from '../llm/providerRegistry.js';
import { STANDALONE_SCHEMA } from '../db/schemaStandalone.js';
import type { StandaloneConfig } from './config.js';

/** 合并 inline provider 与 --providers-file 的 DirectProvider[](文件读失败仅告警,不阻断启动)。 */
export function loadProviders(cfg: StandaloneConfig): DirectProvider[] {
  const list = [...cfg.providers];
  if (cfg.providersFile) {
    try {
      const parsed = JSON.parse(readFileSync(cfg.providersFile, 'utf8'));
      if (Array.isArray(parsed)) list.push(...parsed);
      else console.warn(`[tangu] providers-file 不是数组,已忽略: ${cfg.providersFile}`);
    } catch (e: any) {
      console.warn(`[tangu] 读取 providers-file 失败,已忽略: ${e?.message || e}`);
    }
  }
  return list;
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
 * 装配 host:配了 --db → 外部 Postgres(localHost);否则 → 嵌入式 PGlite(零安装,落 dataDir)。
 * 返回 host + 跑「base schema」的函数(PGlite 多语句走 exec)+ 存储描述。
 */
export async function setupHost(
  cfg: StandaloneConfig,
): Promise<{ host: HostServices; runBaseSchema: () => Promise<void>; storage: string }> {
  if (cfg.databaseUrl) {
    const { host, pool } = createLocalHost({ databaseUrl: cfg.databaseUrl, localToken: cfg.token, userId: cfg.userId });
    return { host, runBaseSchema: async () => { await pool.query(STANDALONE_SCHEMA); }, storage: '外部 Postgres' };
  }
  const inMemory = cfg.dataDir === 'memory';
  const dataDir = inMemory ? undefined : (cfg.dataDir || join(homedir(), '.tangu', 'pgdata'));
  if (dataDir) mkdirSync(dataDir, { recursive: true });
  const { host, db } = await createEmbeddedHost({ dataDir, localToken: cfg.token, userId: cfg.userId });
  return { host, runBaseSchema: async () => { await db.exec(STANDALONE_SCHEMA); }, storage: inMemory ? 'PGlite(内存)' : `PGlite(${dataDir})` };
}

/** brain:有直连 provider 则 multiBrain(本地命中走直连,其余委托 Forsion);否则纯 httpBrain。 */
export function buildBrain(cfg: StandaloneConfig): { brain: CloudBrainServices; providers: DirectProvider[] } {
  const httpBrain = createHttpBrain({ cloudUrl: cfg.cloudUrl, token: cfg.token });
  const providers = loadProviders(cfg);
  const brain = providers.length ? createMultiBrain(httpBrain, createProviderRegistry(providers)) : httpBrain;
  return { brain, providers };
}
