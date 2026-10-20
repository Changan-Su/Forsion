import { createHash } from 'node:crypto';
import { agentSyncDir, atomicSyncWrite, assertSyncPath, readSyncBytes } from './agentSyncPaths.js';
import { join } from 'node:path';
import { readdirSync } from 'node:fs';
import { withMemoryDirectoryLock } from './memoryRepository.js';
import type { AgentFilesBrain } from '../seams/cloudBrain.js';
import { agentsDir, DEFAULT_AGENT_SLUG } from '../core/tanguHome.js';

const identities = new WeakMap<AgentFilesBrain, (userId: string) => string | null>();

export function cloudAccountScope(origin: string, userId: string): string {
  let normalized = origin.replace(/\/+$/, '');
  try {
    const url = new URL(origin);
    normalized = `${url.origin}${url.pathname.replace(/\/+$/, '')}`;
  } catch { /* custom adapter identifier */ }
  return createHash('sha256').update(JSON.stringify([normalized, userId])).digest('hex');
}

/** The standalone host user is usually "local". Its cloud identity must follow the actual JWT. */
export function registerAgentSyncIdentity(cloud: AgentFilesBrain, origin: string, token: string | (() => string)): void {
  identities.set(cloud, (requestUserId) => {
    try {
      const claims = JSON.parse(Buffer.from((typeof token === 'function' ? token() : token).split('.')[1], 'base64url').toString('utf8'));
      const userId = claims.userId ?? claims.sub;
      return (typeof userId === 'string' || typeof userId === 'number') && String(userId).trim()
        ? cloudAccountScope(origin, String(userId)) : null;
    } catch { return null; }
  });
}

export function agentSyncScope(cloud: AgentFilesBrain | undefined, userId: string): string | null {
  if (!cloud) return null;
  const resolve = identities.get(cloud);
  return resolve ? resolve(userId) : userId ? cloudAccountScope('local-adapter', userId) : null;
}

// follow = 「跟着账号总闸」:总闸关的时候,单独开过的 Agent 改记成这个(不抹 revision,只增)
interface Permission { enabled: boolean; shared: boolean; revision?: number; follow?: boolean }
interface PermissionFile { accounts: Record<string, Permission> }
const permissionFile = (slug: string): string => assertSyncPath(agentsDir(), join(agentSyncDir(slug), '.cloudsync-accounts.json'));

function readPermissions(slug: string): PermissionFile {
  try {
    const data = JSON.parse(readSyncBytes(agentsDir(), permissionFile(slug))?.toString('utf8') ?? '{}');
    return { accounts: data.accounts && typeof data.accounts === 'object' ? data.accounts : {} };
  } catch { return { accounts: {} }; }
}

/**
 * 账号级总闸(2026-10-20 云同步开启方案 A + B 卡片):用户在首登卡片 / 引导 / 蓬洲云「同步」页对「Agents 与记忆」点的那一下,
 * 按云账号记在 agents/.cloudsync-default.json。没点过 = null(旧行为:只认每个 Agent 自己的同意)。
 * 开 = 没单独设过的 Agent 都算同意,默认 Agent 的记忆也共享(Brain 记忆同步要 enabled && shared);
 * 关 = 全停:单独开过的改记成 follow(跟着总闸),单独关过的照旧关;之后在 Agent 设置里单独再开的照开(不会开了又弹回去),
 *      总闸再开时 follow 的跟着回来。
 * ponytail: 读改写不加锁(只有用户点开关会写,一个引擎进程);要多进程同写再上 withMemoryDirectoryLock。
 */
interface AccountDefault { enabled: boolean; revision: number }
const defaultFile = (): string => assertSyncPath(agentsDir(), join(agentsDir(), '.cloudsync-default.json'));
function readDefaults(): Record<string, AccountDefault> {
  try {
    const data = JSON.parse(readSyncBytes(agentsDir(), defaultFile())?.toString('utf8') ?? '{}');
    return data.accounts && typeof data.accounts === 'object' ? data.accounts : {};
  } catch { return {}; }
}
export function agentSyncDefault(scope: string | null): boolean | null {
  if (!scope) return null;
  const d = readDefaults()[scope];
  return typeof d?.enabled === 'boolean' ? d.enabled : null;
}
export function setAgentSyncDefault(scope: string, enabled: boolean): void {
  if (!/^[a-f0-9]{64}$/.test(scope)) throw new Error('invalid cloud account scope');
  if (!enabled) {
    // 先把单独开着的改成跟着总闸,再落总闸:中途崩了,重点一次「关」就补齐
    let dirs: import('node:fs').Dirent[] = [];
    try { dirs = readdirSync(agentsDir(), { withFileTypes: true }); } catch { /* 还没有 agents 目录 */ }
    for (const e of dirs) {
      if (!e.isDirectory() || e.name.startsWith('.')) continue;
      const slug = e.name;
      let dir: string;
      try { dir = agentSyncDir(slug); } catch { continue; } // 名字不是合法 Agent 目录就跳过
      let changed = false;
      // 锁 / 写失败照样抛:关不干净就不能报「关好了」(总闸也不落),让用户再点一次
      withMemoryDirectoryLock(dir, () => {
        const data = readPermissions(slug);
        const cur = data.accounts[scope];
        if (!cur?.enabled || cur.follow) return;
        // 只把 enabled 交给总闸;shared 原样留着,总闸再开时不改变它共不共享记忆
        data.accounts[scope] = { enabled: false, shared: cur.shared === true, follow: true, revision: (cur.revision ?? 0) + 1 };
        atomicSyncWrite(agentsDir(), permissionFile(slug), JSON.stringify(data, null, 2));
        changed = true;
      });
      if (changed) { const key = consentKey(slug, scope); consentControllers.get(key)?.abort(new Error('agent sync consent changed')); consentControllers.delete(key); }
    }
  }
  const accounts = readDefaults();
  accounts[scope] = { enabled, revision: (accounts[scope]?.revision ?? 0) + 1 };
  atomicSyncWrite(agentsDir(), defaultFile(), JSON.stringify({ accounts }, null, 2));
  // 总闸一动,这个账号下所有在途的同意都作废(capture 比的是 revision,两份都只增,和也只增)
  for (const [key, c] of consentControllers) if (key.endsWith(`:${scope}`)) { c.abort(new Error('agent sync consent changed')); consentControllers.delete(key); }
}

/** Legacy cloud_sync=true has no owner and cannot authorize a newly selected cloud account. */
export function agentSyncPermission(slug: string, scope: string | null): Permission {
  if (!scope) return { enabled: false, shared: false };
  const permission = readPermissions(slug).accounts[scope];
  const master = readDefaults()[scope];
  const revision = (permission?.revision ?? 0) + (master?.revision ?? 0);
  if (permission?.follow) return master?.enabled === true ? { enabled: true, shared: permission.shared === true, revision } : { enabled: false, shared: false, revision };
  if (permission) return { enabled: permission.enabled === true, shared: permission.shared === true, revision };
  if (master?.enabled === true) return { enabled: true, shared: slug === DEFAULT_AGENT_SLUG, revision };
  return { enabled: false, shared: false, revision };
}

const consentControllers = new Map<string, AbortController>();
const consentKey = (slug: string, scope: string): string => `${agentSyncDir(slug)}:${scope}`;
export function agentSyncConsentSignal(slug: string, scope: string): AbortSignal {
  const key = consentKey(slug, scope);
  let controller = consentControllers.get(key);
  if (!controller) { controller = new AbortController(); consentControllers.set(key, controller); }
  return controller.signal;
}
export function setAgentSyncPermission(slug: string, scope: string, enabled: boolean, shared = false): void {
  withMemoryDirectoryLock(agentSyncDir(slug), () => {
    const data = readPermissions(slug);
    if (!/^[a-f0-9]{64}$/.test(scope)) throw new Error('invalid cloud account scope');
    data.accounts[scope] = { enabled, shared: enabled && shared, revision: (data.accounts[scope]?.revision ?? 0) + 1 };
    atomicSyncWrite(agentsDir(), permissionFile(slug), JSON.stringify(data, null, 2));
  });
  const key = consentKey(slug, scope);
  consentControllers.get(key)?.abort(new Error('agent sync consent changed'));
  consentControllers.delete(key);
}

let sourceController = new AbortController();
/** Source replacement revokes every in-flight operation, including fire-and-forget post-run sync. */
export function invalidateAgentSyncOperations(): void {
  sourceController.abort(new Error('cloud account/source changed'));
  sourceController = new AbortController();
}
export function agentSyncOperationSignal(signal?: AbortSignal): AbortSignal {
  return signal ? AbortSignal.any([signal, sourceController.signal]) : sourceController.signal;
}
/** A captured consent revision cannot become valid again after revoke + re-enable. */
export function captureAgentSyncPermission(slug: string, scope: string, shared = false): () => void {
  const initial = agentSyncPermission(slug, scope);
  if (!initial.enabled || (shared && !initial.shared)) throw new Error('agent sync consent required');
  return () => {
    const current = agentSyncPermission(slug, scope);
    if (!current.enabled || (shared && !current.shared) || current.revision !== initial.revision) throw new Error('agent sync consent changed');
    agentSyncDir(slug);
  };
}
