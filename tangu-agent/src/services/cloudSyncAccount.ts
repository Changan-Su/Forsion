import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
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
    if (typeof token === 'function') return requestUserId ? cloudAccountScope(origin, requestUserId) : null;
    try {
      const claims = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8'));
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

interface Permission { enabled: boolean; shared: boolean }
interface PermissionFile { accounts: Record<string, Permission> }
const permissionFile = (slug: string): string => join(agentsDir(), slug, '.cloudsync-accounts.json');

function readPermissions(slug: string): PermissionFile {
  try {
    const data = JSON.parse(readFileSync(permissionFile(slug), 'utf8'));
    return { accounts: data.accounts && typeof data.accounts === 'object' ? data.accounts : {} };
  } catch { return { accounts: {} }; }
}

/** Legacy cloud_sync=true has no owner and cannot authorize a newly selected cloud account. */
export function agentSyncPermission(slug: string, scope: string | null): Permission {
  if (!scope) return { enabled: false, shared: false };
  const permission = readPermissions(slug).accounts[scope];
  return { enabled: permission?.enabled === true, shared: permission?.shared === true };
}

export function setAgentSyncPermission(slug: string, scope: string, enabled: boolean, shared = true): void {
  const data = readPermissions(slug);
  data.accounts[scope] = { enabled, shared: enabled && shared };
  mkdirSync(join(agentsDir(), slug), { recursive: true });
  writeFileSync(permissionFile(slug), JSON.stringify(data, null, 2), 'utf8');
}
