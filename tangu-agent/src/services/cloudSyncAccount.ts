import { createHash } from 'node:crypto';
import { agentSyncDir, atomicSyncWrite, assertSyncPath, readSyncBytes } from './agentSyncPaths.js';
import { join } from 'node:path';
import { withMemoryDirectoryLock } from './memoryRepository.js';
import type { AgentFilesBrain } from '../seams/cloudBrain.js';
import { agentsDir } from '../core/tanguHome.js';

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

interface Permission { enabled: boolean; shared: boolean; revision?: number }
interface PermissionFile { accounts: Record<string, Permission> }
const permissionFile = (slug: string): string => assertSyncPath(agentsDir(), join(agentSyncDir(slug), '.cloudsync-accounts.json'));

function readPermissions(slug: string): PermissionFile {
  try {
    const data = JSON.parse(readSyncBytes(agentsDir(), permissionFile(slug))?.toString('utf8') ?? '{}');
    return { accounts: data.accounts && typeof data.accounts === 'object' ? data.accounts : {} };
  } catch { return { accounts: {} }; }
}

/** Legacy cloud_sync=true has no owner and cannot authorize a newly selected cloud account. */
export function agentSyncPermission(slug: string, scope: string | null): Permission {
  if (!scope) return { enabled: false, shared: false };
  const permission = readPermissions(slug).accounts[scope];
  return { enabled: permission?.enabled === true, shared: permission?.shared === true, revision: permission?.revision ?? 0 };
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
