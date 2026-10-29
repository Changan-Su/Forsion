import { createHash } from 'node:crypto';
import { agentSyncDir, atomicSyncWrite, assertSyncPath, readSyncBytes } from './agentSyncPaths.js';
import { join } from 'node:path';
import { readdirSync, rmdirSync, rmSync } from 'node:fs';
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
interface AccountDefault { enabled: boolean; revision: number; owner?: 'content' }
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
  if(d?.owner==='content')return false;
  return typeof d?.enabled === 'boolean' ? d.enabled : null;
}
/** Exclusive ownership prevents legacy per-agent discovery from bypassing folder rules. */
export function setContentSyncOwner(scope:string,enabled:boolean):void {
  if(!/^[a-f0-9]{64}$/.test(scope))throw new Error('invalid cloud account scope');
  const accounts=readDefaults(),cur=accounts[scope];
  accounts[scope]={enabled:cur?.enabled??false,revision:(cur?.revision??0)+1,...(enabled?{owner:'content' as const}:{})};
  atomicSyncWrite(agentsDir(),defaultFile(),JSON.stringify({accounts},null,2));invalidateAgentSyncOperations();
}
export function setAgentSyncDefault(scope: string, enabled: boolean): void {
  if (!/^[a-f0-9]{64}$/.test(scope)) throw new Error('invalid cloud account scope');
  if(readDefaults()[scope]?.owner==='content')throw new Error('Folder rules own content sync; manage it in Penzor Cloud.');
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

/** 总闸开着这一刻的同意(human/ 上云用):总闸再被点一下(关或重开)就作废,和 captureAgentSyncPermission 同一个口径。 */
export function captureAgentSyncDefault(scope: string): () => void {
  const initial = readDefaults()[scope];
  if (initial?.enabled !== true) throw new Error('agent sync consent required');
  return () => {
    const current = readDefaults()[scope];
    if (current?.enabled !== true || current.revision !== initial.revision) throw new Error('agent sync consent changed');
  };
}

/** Legacy cloud_sync=true has no owner and cannot authorize a newly selected cloud account. */
export function agentSyncPermission(slug: string, scope: string | null): Permission {
  if (!scope) return { enabled: false, shared: false };
  const permission = readPermissions(slug).accounts[scope];
  const master = readDefaults()[scope];
  if(master?.owner==='content')return {enabled:false,shared:false,revision:master.revision};
  const revision = (permission?.revision ?? 0) + (master?.revision ?? 0);
  if (permission?.follow) return master?.enabled === true ? { enabled: true, shared: permission.shared === true, revision } : { enabled: false, shared: false, revision };
  if (permission) return { enabled: permission.enabled === true, shared: permission.shared === true, revision };
  if (master?.enabled === true) return { enabled: true, shared: slug === DEFAULT_AGENT_SLUG, revision };
  return { enabled: false, shared: false, revision };
}

const consentControllers = new Map<string, AbortController>();
const consentKey = (slug: string, scope: string): string => `${agentSyncDir(slug)}:${scope}`;
/** 只凭总闸同意的在途同步(human/)用:总闸一动(setAgentSyncDefault 中止所有 `…:<scope>` 键)就取消请求,不只是回包后判失败。 */
export function agentSyncDefaultSignal(scope: string): AbortSignal {
  const key = `default:${scope}`;
  let controller = consentControllers.get(key);
  if (!controller) { controller = new AbortController(); consentControllers.set(key, controller); }
  return controller.signal;
}
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

/**
 * 界面 / 工具删掉的 Agent(10-28):目录连同影子、授权一起没了,下次同步会把云端那份当成「别的设备新建的」整份拉回来。
 * 删之前按账号记一笔 `agents/.cloudsync-deleted/<slug>/<账号>`,同步先把这个账号云端那份删掉(删除胜,和网页删 Agent 一样)再做别的。
 * 只记这时还开着同步的账号(有影子的,加上授权 / 总闸里出现过的 —— 第一次上传还没落影子时就删,也得记上):关了同步的 Agent,云端那份不归本机管。
 * 直接在访达里删文件夹不记,照旧拉回(没有 ≠ 删了)。返回「撤销」:本地没删成时调用,只撤这一次新记的。
 */
const REMOVED_DIR = '.cloudsync-deleted';
const removedDir = (slug: string): string => { agentSyncDir(slug); return assertSyncPath(agentsDir(), join(agentsDir(), REMOVED_DIR, slug)); };
const SHADOW_RE = /^\.cloudsync-([a-f0-9]{64})\.json$/;
/** 这个 Agent 现在同步到哪些账号(授权、主开关缺省、已有影子三处取并集,再按授权判)。卸载确认框的「云端副本」那行也看它。 */
export function agentSyncedScopes(slug: string): string[] {
  const scopes = new Set([...Object.keys(readPermissions(slug).accounts), ...Object.keys(readDefaults())]);
  try { for (const name of readdirSync(agentSyncDir(slug))) { const m = SHADOW_RE.exec(name); if (m) scopes.add(m[1]); } } catch { /* 目录已经没了 */ }
  return [...scopes].filter((scope) => /^[a-f0-9]{64}$/.test(scope) && agentSyncPermission(slug, scope).enabled);
}
export function recordAgentRemoval(slug: string): () => void {
  const added: string[] = [];
  for (const scope of agentSyncedScopes(slug)) {
    const file = join(removedDir(slug), scope);
    if (readSyncBytes(agentsDir(), file) === null) added.push(scope);
    atomicSyncWrite(agentsDir(), file, String(Date.now()));
  }
  return () => { for (const scope of added) clearAgentRemoval(slug, scope); };
}
export function pendingAgentRemovals(scope: string): string[] {
  let slugs: string[];
  try { slugs = readdirSync(assertSyncPath(agentsDir(), join(agentsDir(), REMOVED_DIR))); } catch { return []; }
  return slugs.filter((slug) => { try { return readSyncBytes(agentsDir(), join(removedDir(slug), scope)) !== null; } catch { return false; } });
}
export function clearAgentRemoval(slug: string, scope: string): void {
  const dir = removedDir(slug);
  rmSync(join(dir, scope), { force: true });
  try { rmdirSync(dir); } catch { /* 还有别的账号没删完 */ }
}
/** 从回收站恢复后:撤掉删除记录(不然下轮同步把云端再删一遍),丢掉影子(影子记着「这些文件同步过」,云端却是删除标记,
 *  会被判成别处删了)。授权 .cloudsync-accounts.json 留着:恢复 = 照原样接着同步,下轮整份重新上传。 */
export function forgetAgentRemoval(slug: string): void {
  rmSync(removedDir(slug), { recursive: true, force: true });
  try { for (const name of readdirSync(agentSyncDir(slug))) if (SHADOW_RE.test(name)) rmSync(join(agentSyncDir(slug), name), { force: true }); } catch { /* 没有影子 */ }
}
