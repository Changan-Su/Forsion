/** Account-scoped agent files. Network I/O never holds the synchronous local write lock. */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, statSync, unlinkSync } from 'node:fs';
import { dirname, extname, join } from 'node:path';
import { deps } from '../seams/runtime.js';
import { agentsDir, humanDir, tanguHome, userMdFile } from '../core/tanguHome.js';
import { HUMAN_SYNC_FILES, joinFirstContact, mirrorLegacyHuman } from '../agents/humanFolder.js';
import { getDeviceId } from '../core/deviceId.js';
import { getAgent, listAgents, parseAgentConfig, resolveMemorySlug, type NormalAgentDef } from '../agents/agentRegistry.js';
import { splitLogBlocks, mergeBlocks, mergeLogHeaders, mergeText3 } from './memorySync.js';
import { mergeDbFile } from './dbRowMerge.js';
import { keepLatestRuns, migrateScheduleFile } from './agentSchedule.js';
import { AgentFileConflictError, type AgentFilesBrain, type AgentFileMeta, type AgentFileContent } from '../seams/cloudBrain.js';
import { agentSyncDefault, agentSyncPermission, agentSyncScope, setAgentSyncPermission, captureAgentSyncPermission, agentSyncOperationSignal, agentSyncConsentSignal } from './cloudSyncAccount.js';
import { agentSyncDir, assertSyncPath, atomicSyncWrite, conflictCopyName, readSyncBytes, validSyncPath, validSyncSlug } from './agentSyncPaths.js';
import { createLocalMemoryStore } from '../adapters/standalone/localMemoryBrain.js';
import { createMemoryRepository, withMemoryDirectoryLock, type MemoryTombstone } from './memoryRepository.js';

const MAX_FILE_BYTES = 5 * 1024 * 1024;
const TOMBSTONES = '.memory-tombstones.json';
const TEXT_EXTS = new Set(['.md', '.toml', '.txt', '.json', '.yaml', '.yml', '.csv', '.html', '.xml', '.js', '.ts', '.py']);
const sha256 = (value: Buffer | string): string => createHash('sha256').update(value).digest('hex');
type Guard = () => void;
type Category = 'DEF' | 'MEM';
const categoryOf = (p: string): Category => p === 'MEMORY.md' || p === TOMBSTONES || p.startsWith('LOG/') ? 'MEM' : 'DEF';
/** base:可合并的文件(human/ 那几份、USER.md)记下上次两边一致时的原文,两边都改了就拿它三方合并,不再整份出副本。 */
/** pending:可合并的文件推送 / 落盘之前先标上,确认了才换成新影子(见 reconcileFile 的 unsure)。push = 从这条的 seq 带 CAS 推出去、还没确认的那几份内容的哈希。 */
interface PrevEntry { seq?: number; hash?: string; lastCloudMtimeMs?: number; base?: string; pending?: { push?: string[] } }
interface PrevState { files: Record<string, PrevEntry> }
const emptyResult = (): AgentFileSyncResult => ({ ok: true, agents: 0, pushed: 0, pulled: 0, deleted: 0, skipped: 0, conflicts: 0 });
function fail(result: AgentFileSyncResult, e: unknown): void {
  result.ok = false;
  const message = e instanceof Error ? e.message : String(e);
  result.error = result.error ? `${result.error}; ${message}` : message;
}
function readPrev(dir: string, scope: string, root = agentsDir()): PrevState {
  const bytes = readSyncBytes(root, join(dir, `.cloudsync-${scope}.json`));
  if (!bytes) return { files: {} };
  try { const value = JSON.parse(bytes.toString('utf8')); return { files: value.files ?? {} }; } catch { return { files: {} }; }
}
function localFiles(dir: string, cats: Set<Category>): string[] {
  const out: string[] = [];
  const walk = (p: string, rel: string): void => {
    assertSyncPath(agentsDir(), p);
    if (!existsSync(p)) return;
    for (const entry of readdirSync(p, { withFileTypes: true })) {
      const child = rel ? `${rel}/${entry.name}` : entry.name;
      // Symlinks never participate, even if their target is currently inside this agent.
      if (entry.isDirectory() && (child === 'Library' || child.startsWith('Library/') || child === 'LOG')) walk(join(p, entry.name), child);
      else if (entry.isFile() && validSyncPath(child) && child !== TOMBSTONES && cats.has(categoryOf(child))) out.push(child);
    }
  };
  walk(dir, '');
  return out;
}
function logText(header: string, blocks: string[]): string { return blocks.length ? `${header.trimEnd()}\n\n${blocks.map((b) => `${b}\n`).join('\n')}` : `${header.trimEnd()}\n`; }
interface ShadowVer { seq: number; hash: string }
interface RemoteVer { seq: number; hash: string | null }
type Decision =
  | { kind: 'none' } | { kind: 'adopt' } | { kind: 'pull' }
  | { kind: 'push'; baseSeq: number } | { kind: 'pushCreate' } | { kind: 'pushDelete' }
  | { kind: 'deleteLocal' } | { kind: 'dropShadow' } | { kind: 'conflict' };

export function decide(local: string | null, shadow: ShadowVer | null, remote: RemoteVer | null): Decision {
  if (local === null && shadow === null && remote === null) return { kind: 'none' };
  if (remote === null) {
    if (local === null) return shadow ? { kind: 'dropShadow' } : { kind: 'none' };
    if (!shadow) return { kind: 'pushCreate' };
    return local === shadow.hash ? { kind: 'deleteLocal' } : { kind: 'pushCreate' }; // 本地未动=删除生效;改过=编辑胜删除
  }
  if (local === null) {
    if (!shadow) return { kind: 'pull' };
    return remote.seq === shadow.seq ? { kind: 'pushDelete' } : { kind: 'pull' }; // 服务端未动=本地删生效;动过=编辑胜删除
  }
  if (!shadow) return local === remote.hash ? { kind: 'adopt' } : { kind: 'conflict' };
  const localDirty = local !== shadow.hash;
  const remoteMoved = remote.seq !== shadow.seq;
  if (!localDirty && !remoteMoved) return { kind: 'none' };
  if (!localDirty) return { kind: 'pull' };
  if (!remoteMoved) return { kind: 'push', baseSeq: shadow.seq };
  return local === remote.hash ? { kind: 'adopt' } : { kind: 'conflict' };
}


export { conflictCopyName };

export interface AgentFileSyncResult { ok: boolean; agents: number; pushed: number; pulled: number; deleted: number; skipped: number; conflicts: number; error?: string }
export interface AgentFileSyncOptions { /** Display/owning agent slug, never its resolved memory bucket. */ onlySlug?: string; signal?: AbortSignal; assertActive?: () => void }
const tails = new Map<string, Promise<void>>();

/** One account's sync runs serialize; each file commit still checks current consent and local revision. */
export async function runAgentFilesSync(cloud: AgentFilesBrain, userId: string, opts: AgentFileSyncOptions = {}): Promise<AgentFileSyncResult> {
  const result = emptyResult();
  const scope = agentSyncScope(cloud, userId);
  if (!scope) return { ...result, ok: false, error: 'cloud account identity unavailable' };
  const controller = new AbortController();
  const cleanups: Array<() => void> = [];
  const signal = AbortSignal.any([agentSyncOperationSignal(opts.signal), controller.signal]);
  const watch = (slug: string): void => {
    const consent = agentSyncConsentSignal(slug, scope);
    const abort = (): void => controller.abort(consent.reason);
    consent.addEventListener('abort', abort, { once: true });
    cleanups.push(() => consent.removeEventListener('abort', abort));
    if (consent.aborted) abort();
  };
  const guard = (): void => { signal.throwIfAborted(); opts.assertActive?.(); if (agentSyncScope(cloud, userId) !== scope) throw new Error('cloud account changed'); };
  const previous = tails.get(scope) ?? Promise.resolve();
  let release!: () => void;
  const tail = new Promise<void>((resolve) => { release = resolve; });
  tails.set(scope, tail);
  try {
    await previous; guard();
    if (opts.onlySlug !== undefined && !validSyncSlug(opts.onlySlug)) throw new Error('invalid selected agent sync slug');
    await syncAccount(cloud, userId, scope, opts.onlySlug, signal, guard, result, watch);
  } catch (e) { fail(result, e); }
  finally { cleanups.forEach((fn) => fn()); release(); if (tails.get(scope) === tail) tails.delete(scope); }
  return result;
}

async function syncAccount(cloud: AgentFilesBrain, userId: string, scope: string, onlySlug: string | undefined, signal: AbortSignal, guard: Guard, result: AgentFileSyncResult, watch: (slug: string) => void): Promise<void> {
  const selected = onlySlug ? await getAgent(onlySlug) : null;
  const locals = onlySlug ? (selected ? [selected] : []) : await listAgents(); guard();
  const agents = locals.filter((a) => (!onlySlug || a.slug === onlySlug) && agentSyncPermission(a.slug, scope).enabled);
  agents.forEach((a) => watch(a.slug));
  // Existing unconsented local agents incur no network request, including the run hot path.
  if (onlySlug && existsSync(agentSyncDir(onlySlug)) && !agentSyncPermission(onlySlug, scope).enabled) return;
  guard();
  const manifest = await cloud.getManifest(userId, { signal }); guard();
  const human = manifest.paths?.includes('human') === true;
  const humanFolder = manifest.paths?.includes('human-folder') === true;
  const agentCalendar = manifest.paths?.includes('agent-calendar') === true;
  const bySlug = new Map<string, AgentFileMeta[]>();
  for (const item of manifest) {
    if (item.slug !== '__user__' && item.slug !== HUMAN_SLOT && !validSyncSlug(item.slug)) { fail(result, new Error('invalid cloud manifest slug')); continue; }
    if (!Array.isArray(item.files)) { fail(result, new Error('invalid cloud manifest files')); continue; }
    bySlug.set(item.slug, item.files);
  }
  const known = new Set(agents.map((a) => a.slug));
  for (const [slug, files] of bySlug) {
    if (!validSyncSlug(slug) || (onlySlug && slug !== onlySlug) || known.has(slug)) continue;
    const dir = agentSyncDir(slug);
    const owned = agentSyncPermission(slug, scope).enabled;
    if (existsSync(dir) && !owned) continue;
    const consent = owned ? captureAgentSyncPermission(slug, scope) : guard;
    if (owned) watch(slug);
    if (!files.some((f) => f.relPath === 'config.toml' && !f.deleted)) continue;
    guard();
    try {
      consent(); const config = await cloud.getFile(userId, slug, 'config.toml', { signal }); guard(); consent();
      if (!config || config.deleted || config.isBinary || !config.content) continue;
      verifyBytes(config, Buffer.from(config.content));
      const def = parseAgentConfig(slug, config.content, '');
      // 账号总闸开着(登录后缺省开)也算:另一台开总闸时上传的 config.toml 里多半没有 cloud_sync
      if (!def.cloudSync && agentSyncDefault(scope) !== true) continue;
      // Cloud discovery authorizes only a new directory, never a pre-existing agent/account.
      assertSyncPath(agentsDir(), dir); mkdirSync(agentsDir(), { recursive: true });
      if (!owned) {
        try { mkdirSync(dir); } catch (e) { if ((e as NodeJS.ErrnoException).code === 'EEXIST') continue; throw e; }
        guard(); setAgentSyncPermission(slug, scope, true, false); watch(slug);
      }
      agents.push(def); known.add(slug);
    } catch (e) { fail(result, e); guard(); }
  }
  result.agents = agents.length;
  const buckets = new Map<string, { cats: Set<Category>; guards: Guard[] }>();
  const add = (slug: string, cat: Category, consent: Guard): void => {
    const b = buckets.get(slug) ?? { cats: new Set<Category>(), guards: [] };
    b.cats.add(cat); b.guards.push(consent); buckets.set(slug, b);
  };
  const shared: Guard[] = [];
  for (const agent of agents) {
    const consent = captureAgentSyncPermission(agent.slug, scope);
    add(agent.slug, 'DEF', consent);
    const memSlug = resolveMemorySlug(agent);
    if (memSlug === agent.slug) add(memSlug, 'MEM', consent);
    else if (agentSyncPermission(agent.slug, scope).shared) add(memSlug, 'MEM', captureAgentSyncPermission(agent.slug, scope, true));
    if (agentSyncPermission(agent.slug, scope).shared) shared.push(captureAgentSyncPermission(agent.slug, scope, true));
  }
  for (const [slug, bucket] of buckets) {
    const check = (): void => { guard(); for (const consent of bucket.guards) consent(); agentSyncDir(slug); };
    check();
    await syncBucket(cloud, userId, slug, scope, bucket.cats, bySlug.get(slug) ?? [], { human, agentCalendar }, signal, check, result);
  }
  // USER is an explicit shared-data opt-in, never an implicit private-agent pool.
  if (shared.length) {
    const check = (): void => { guard(); shared.forEach((g) => g()); };
    const dir = dirname(userMdFile());
    const prev = readPrev(dir, scope, dir);
    const persist = (): void => atomicSyncWrite(dir, join(dir, `.cloudsync-${scope}.json`), JSON.stringify(prev), check);
    try { await reconcileFile(cloud, userId, '__user__', dir, 'USER.md', bySlug.get('__user__')?.find((f) => f.relPath === 'USER.md'), prev, signal, check, result, dir, { merge: true, persist }); }
    catch (e) { fail(result, e); }
    check(); persist();
    // 旧位置(USER.md、默认笔记库的 Calendar.db)和 human/ 双向镜像:同步前一遍把旧设备的改动并进来再推,同步后一遍把拉下来的写回旧位置。
    // 服务端还不认 __human__ 时只镜像、不上云(方案页 ⑦:server 没部署时新版只做本地搬家)。
    // 服务端顺带回答「这个账号还有没有旧客户端在用 USER.md」:明确说没有才停 USER.md 那一对;没说(老服务端 / 查失败)照旧镜像
    const legacy = Array.isArray(manifest.legacy) ? { families: manifest.legacy, seenAt: manifest.legacySeenAt ?? null } : null;
    const mirror = async (): Promise<void> => { try { result.conflicts += (await mirrorLegacyHuman({ legacy })).conflicts; } catch (e) { fail(result, e); } };
    await mirror();
    if (humanFolder) {
      try { await syncHumanSlot(cloud, userId, scope, bySlug.get(HUMAN_SLOT) ?? [], signal, check, result); } catch (e) { fail(result, e); }
      await mirror();
    }
  }
}
function verifyBytes(file: { hash?: string | null }, bytes: Buffer): void {
  if (bytes.length > MAX_FILE_BYTES) throw new Error('cloud file exceeds sync limit');
  if (file.hash != null && sha256(bytes) !== file.hash) throw new Error('cloud file hash mismatch');
}
async function syncBucket(cloud: AgentFilesBrain, uid: string, slug: string, scope: string, cats: Set<Category>, manifest: AgentFileMeta[], families: { human: boolean; agentCalendar: boolean }, signal: AbortSignal, guard: Guard, result: AgentFileSyncResult): Promise<void> {
  const dir = agentSyncDir(slug);
  // 先把 SCHEDULE.db 改名成 CALENDAR.db(和引擎读写日程时同一处):清单里才看得到它,也不会拉下别的设备那份后把本机旧名那份晾在一边
  if (cats.has('DEF')) { try { migrateScheduleFile(slug); } catch (e) { fail(result, e); return; } }
  const prev = readPrev(dir, scope);
  const remote = new Map<string, AgentFileMeta>();
  for (const entry of manifest) {
    if (!validSyncPath(entry.relPath)) { fail(result, new Error(`invalid cloud path for ${slug}`)); continue; }
    if (cats.has(categoryOf(entry.relPath))) remote.set(entry.relPath, entry);
  }
  // Forgetting crosses devices before any old MEMORY projection can be imported.
  if (cats.has('MEM')) {
    try { await syncTombstones(cloud, uid, slug, dir, remote.get(TOMBSTONES), signal, guard, result); }
    catch (e) { fail(result, e); return; } // No memory import without a trustworthy tombstone pass.
  }
  const paths = new Set([...localFiles(dir, cats), ...remote.keys(), ...Object.keys(prev.files).filter((p) => validSyncPath(p) && cats.has(categoryOf(p)))]);
  paths.delete(TOMBSTONES);
  if (!families.human) paths.delete('HUMAN.md'); // 服务端还不认它:不推不拉不记影子,等它升级后照常首次同步
  if (!families.agentCalendar) paths.delete('CALENDAR.db'); // 同上(老服务端会 400)
  // 日历是可合并的文件:影子要能立刻落盘(推送前标 pending、处理完就落),和 human/ 槽位同一套,推上去却没记下基线就崩不会拿旧基线合并
  let saved = JSON.stringify(prev);
  const persist = (): void => {
    const next = JSON.stringify(prev);
    if (next !== saved) { withMemoryDirectoryLock(dir, () => atomicSyncWrite(agentsDir(), join(dir, `.cloudsync-${scope}.json`), next, guard)); saved = next; }
  };
  for (const p of paths) {
    guard();
    try {
      if (p.startsWith('LOG/')) await reconcileLog(cloud, uid, slug, dir, p, remote.get(p), signal, guard, result);
      // 日历按文本传、两台都改了按行 id 合并(和 human/CALENDAR.db 同一套),不整份出冲突副本
      else await reconcileFile(cloud, uid, slug, dir, p, remote.get(p), prev, signal, guard, result, agentsDir(), p === 'CALENDAR.db' ? { merge: true, text: true, persist } : {});
    } catch (e) { fail(result, e); guard(); }
    if (p === 'CALENDAR.db') { guard(); persist(); }
  }
  guard(); withMemoryDirectoryLock(dir, () => atomicSyncWrite(agentsDir(), join(dir, `.cloudsync-${scope}.json`), JSON.stringify(prev), guard));
}

async function syncTombstones(cloud: AgentFilesBrain, uid: string, slug: string, dir: string, meta: AgentFileMeta | undefined, signal: AbortSignal, guard: Guard, result: AgentFileSyncResult): Promise<void> {
  const repo = createMemoryRepository(dir);
  // Missing manifest means no remote tombstones. Every newly forgotten local fact is still uploaded.
  for (let attempt = 0; attempt < 4; attempt++) {
    guard();
    const file = await cloud.getFile(uid, slug, TOMBSTONES, { signal });
    guard();
    let remote: MemoryTombstone[] = [];
    if (file && !file.deleted) {
      if (file.isBinary) throw new Error('invalid tombstone data');
      verifyBytes(file, Buffer.from(file.content ?? ''));
      const parsed = JSON.parse(file.content ?? '');
      if (parsed.schemaVersion !== 1 || !Array.isArray(parsed.tombstones)) throw new Error('invalid tombstone schema');
      remote = parsed.tombstones;
      repo.mergeTombstones(remote, signal);
    }
    guard(); const tombstones = repo.snapshot().tombstones;
    if (!tombstones.length) return;
    const content = JSON.stringify({ schemaVersion: 1, tombstones: tombstones.map((t) => ({ ...t, evidenceIds: [...t.evidenceIds].sort() })).sort((a, b) => a.fingerprint.localeCompare(b.fingerprint)) });
    if (file?.content === content) return;
    if (file && !file.deleted && typeof file.seq !== 'number') throw new Error('cloud upgrade required for safe tombstone CAS');
    guard();
    try {
      await cloud.putFile(uid, slug, TOMBSTONES, { content, isBinary: false, size: Buffer.byteLength(content), mtimeMs: Date.now(), deviceId: getDeviceId(), baseSeq: file && !file.deleted ? file.seq : 0 }, { signal });
      guard(); result.pushed++; return;
    } catch (e) { if (!(e instanceof AgentFileConflictError)) throw e; }
  }
  throw new Error('tombstone sync still conflicting; retry required');
}

/** human 槽位:人的文件夹 human/ 整个上云(2026-10-20)。服务端声明认识 'human-folder' 才同步;老桌面端根本看不到这个槽位。 */
const HUMAN_SLOT = '__human__';
/** 云端搬家标记:第一台新版设备建好槽位时写一次(只建不改),值 = 布局版本。云端 / 网页据此知道该读 __human__ 还是 __user__。 */
const HUMAN_LAYOUT = '.layout';
/** plain:不走 agent 记忆仓库(human/MEMORY.md 是人的本子,不是 Agent 的记忆);merge:两边都改了先合并;text:.db 也按文本传。 */
interface ReconcileOptions { plain?: boolean; merge?: boolean; text?: boolean; /** 把影子立刻落盘:merge 文件在推送 / 落合并结果之前要用 */ persist?: () => void }
/** 两边都改了:.db 按行(id)合并,.md 按行三方合并;还没有基线(第一次见面)时取并集,不整份二选一。
 *  合不了返回 null(退回整份冲突副本)。 */
function mergeFile(p: string, ours: string, base: string | null, theirs: string, agentCalendar = false): { content: string; conflict: boolean } | null {
  if (p.endsWith('.db')) {
    const merged = mergeDbFile(ours, base, theirs);
    // Agent 的日历:同一行冲突时整行取了一边,lastRun 不能跟着回滚(否则排它的那台会把同一次再跑一遍)
    return merged && agentCalendar ? { ...merged, content: keepLatestRuns(merged.content, ours, theirs) } : merged;
  }
  const text = base === null ? joinFirstContact(ours, theirs) : mergeText3(ours, base, theirs);
  return text === null ? null : { content: text, conflict: false };
}

async function syncHumanSlot(cloud: AgentFilesBrain, uid: string, scope: string, manifest: AgentFileMeta[], signal: AbortSignal, guard: Guard, result: AgentFileSyncResult): Promise<void> {
  const home = tanguHome(); const dir = humanDir();
  assertSyncPath(home, dir); mkdirSync(dir, { recursive: true }); assertSyncPath(home, dir);
  const prev = readPrev(dir, scope, home);
  const remote = new Map(manifest.map((f) => [f.relPath, f]));
  // 每份处理完就落影子(不攒到最后):推上去了却没记下基线就崩,重启后拿旧基线合并,会把别的设备刚恢复的行当成「这边删了」
  let saved = JSON.stringify(prev);
  const persist = (): void => {
    const next = JSON.stringify(prev);
    if (next !== saved) { withMemoryDirectoryLock(dir, () => atomicSyncWrite(home, join(dir, `.cloudsync-${scope}.json`), next, guard)); saved = next; }
  };
  for (const p of HUMAN_SYNC_FILES) {
    guard();
    try { await reconcileFile(cloud, uid, HUMAN_SLOT, dir, p, remote.get(p), prev, signal, guard, result, home, { plain: true, merge: true, text: true, persist }); }
    catch (e) { fail(result, e); }
    guard(); persist();
  }
  if (remote.get(HUMAN_LAYOUT)?.deleted === false) return;
  guard();
  try { await cloud.putFile(uid, HUMAN_SLOT, HUMAN_LAYOUT, { content: '2\n', isBinary: false, size: 2, mtimeMs: Date.now(), deviceId: getDeviceId(), baseSeq: 0 }, { signal }); result.pushed++; }
  catch (e) { if (!(e instanceof AgentFileConflictError)) throw e; } // 别的设备先写了:标记只建不改
}

async function reconcileFile(cloud: AgentFilesBrain, uid: string, slug: string, dir: string, p: string, meta: AgentFileMeta | undefined, prev: PrevState, signal: AbortSignal, guard: Guard, result: AgentFileSyncResult, root = agentsDir(), opts: ReconcileOptions = {}): Promise<void> {
  const abs = assertSyncPath(root, join(dir, p));
  const memory = !opts.plain && p === 'MEMORY.md' ? createMemoryRepository(dir) : null;
  const initialMemory = memory?.snapshot();
  const initial = initialMemory ? Buffer.from(initialMemory.content) : readSyncBytes(root, abs);
  const hash = initial === null ? null : sha256(initial);
  const live = meta && !meta.deleted ? meta : undefined;
  const stored = prev.files[p];
  const pushes = stored?.pending?.push ?? [];
  // 上次推送 / 落盘没等到确认(pending):
  // - 云端 seq 没动 → 旧影子照用,但标记留着:断掉的请求可能还在服务端排着,晚些才落下(10-20 Codex 复核第三轮)
  // - seq 正好 +1、却不是这边推的任何一份 → 那一位被别的设备占了,这边从旧 seq 带 CAS 的推送再也落不下:撤标记照用
  // - 其余拿不准落没落成,当没有影子(第一次见面,取并集)
  if (pushes.length && stored!.seq !== undefined && live?.seq === stored!.seq + 1 && live.hash != null && !pushes.includes(live.hash)) delete stored!.pending;
  const pe = !stored?.pending || live?.seq === stored.seq ? stored : undefined;
  const modern = !live || (typeof live.seq === 'number' && live.hash != null);
  let decision: Decision;
  if (modern) decision = decide(hash, pe?.seq != null && pe.hash ? { seq: pe.seq, hash: pe.hash } : null, live ? { seq: live.seq!, hash: live.hash ?? null } : null);
  else if (initial === null) decision = { kind: 'pull' };
  else if (Math.floor(statSync(abs).mtimeMs) > live!.mtimeMs) decision = { kind: 'push', baseSeq: -1 };
  else if (Math.floor(statSync(abs).mtimeMs) < live!.mtimeMs) decision = { kind: 'conflict' };
  else decision = { kind: 'none' };
  const record = (seq: number | undefined, cloudHash: string | undefined, mtime?: number, base?: Buffer): void => {
    prev.files[p] = { seq, hash: cloudHash, lastCloudMtimeMs: mtime, ...(opts.merge && base ? { base: base.toString('utf8') } : {}) };
  };
  // 推送 / 落盘之前先给这一份的影子标上 pending 并落盘(10-20 Codex 复核两轮):云端收下了却没等到回执(断网、崩溃),
  // 或者本地落了盘、影子没来得及记就崩,旧影子都会出错 —— 旧原文当基线,会把别的设备随后恢复的行当成「这边删了」;
  // 旧哈希还会让本机撤销回旧样子时被当成「没动」、被云端盖掉。下次见到 pending:云端 seq 没动就照用,动了按第一次见面取并集(只会多出行)。
  // 返回「撤掉标记」:云端明确拒了(CAS 冲突)/ 本地没落成,旧影子照样作数。
  const unsure = (pushing?: Buffer): (() => void) => {
    const entry = prev.files[p];
    if (!opts.merge || !opts.persist || !entry) return () => {};
    const fresh = !entry.pending, h = pushing ? sha256(pushing) : undefined;
    entry.pending = { push: [...(entry.pending?.push ?? []), ...(h ? [h] : [])] }; opts.persist();
    return () => {
      if (prev.files[p] !== entry || !entry.pending) return;
      const rest = [...(entry.pending.push ?? [])];
      if (h) rest.splice(rest.indexOf(h), 1); // 只撤这一次的;更早那次可能还在路上
      if (fresh && !rest.length) delete entry.pending; else entry.pending = { push: rest };
      opts.persist!();
    };
  };
  // 记下的原文只在和影子哈希对得上时才当合并基线(老版本写的影子没有原文;对不上就当第一次见面,按并集合)
  const base = opts.merge && pe?.base !== undefined && pe.hash === sha256(Buffer.from(pe.base)) ? pe.base : null;
  const assertUnchanged = (): void => {
    guard();
    const current = memory ? Buffer.from(memory.snapshot().content) : readSyncBytes(root, abs);
    if ((current === null ? null : sha256(current)) !== hash) throw new Error(`local file changed during sync: ${p}`);
  };
  let archivedAs = '';
  const archive = (): void => {
    if (!initial) return;
    let name = conflictCopyName(p, new Date());
    for (let n = 2; existsSync(join(dir, name)); n++) name = `${conflictCopyName(p, new Date())}.${n}`;
    atomicSyncWrite(root, join(dir, name), initial, guard); result.conflicts++; archivedAs = name;
  };
  const fetchRemote = async (): Promise<{ file: AgentFileContent; bytes: Buffer }> => {
    guard(); const file = await cloud.getFile(uid, slug, p, { signal }); guard();
    if (!file || file.deleted) throw new Error(`cloud file changed during sync: ${p}`);
    const bytes = file.isBinary ? Buffer.from(file.contentBase64 ?? '', 'base64') : Buffer.from(file.content ?? '');
    verifyBytes(file, bytes);
    return { file, bytes };
  };
  const pull = async (conflict: boolean, fetched?: { file: AgentFileContent; bytes: Buffer }): Promise<void> => {
    const { file, bytes } = fetched ?? await fetchRemote();
    const keepOld = unsure();
    try {
      withMemoryDirectoryLock(dir, () => {
        assertUnchanged();
        if (conflict) archive();
        if (memory) memory.commit({ expectedVersion: initialMemory!.version, content: bytes.toString('utf8'), source: { kind: 'sync' }, signal });
        else atomicSyncWrite(root, abs, bytes, guard);
        record(file.seq, sha256(bytes), file.mtimeMs, bytes);
      });
    } catch (e) { keepOld(); throw e; }
    result.pulled++;
    // 定义文件被云端覆盖必须留痕:别的设备/网页端存过 config.toml,本机就静默换了参数,09-13 排查时无从判断是谁写的。
    // Library 文件量大不记;config.toml 额外对比 max_iterations —— 最容易悄悄咬人的一个字段。
    if (p === 'config.toml' || p === 'SOUL.md' || p === 'HARNESS.md' || p === 'HUMAN.md') { // 明确白名单:Library 量大、USER.md(__user__)不在本条留痕范围
      let delta = '';
      if (p === 'config.toml') {
        const before = initial ? parseAgentConfig(slug, initial.toString('utf8'), '').maxIterations : null;
        const after = parseAgentConfig(slug, bytes.toString('utf8'), '').maxIterations;
        if (before !== after) delta = `;max_iterations ${before ?? '(未设)'} → ${after ?? '(未设)'}`;
      }
      console.log(`[agent sync] ${initial ? '已从云端拉取覆盖' : '已从云端拉取新文件'} ${slug}/${p}(seq ${file.seq ?? '-'}${archivedAs ? `,本地版本已存为 ${archivedAs}` : ''}${delta})`);
    }
  };
  if (decision.kind === 'conflict' && opts.merge && modern && initial) {
    const fetched = await fetchRemote();
    const merged = fetched.file.isBinary ? null : mergeFile(p, initial.toString('utf8'), base, fetched.bytes.toString('utf8'), slug !== HUMAN_SLOT && p === 'CALENDAR.db');
    if (!merged) { await pull(true, fetched); return; }
    const out = Buffer.from(merged.content);
    verifyBytes({}, out);
    const keepOld = unsure(); // 落了合并结果、影子还没落盘就崩:下次不拿旧原文合
    try {
      withMemoryDirectoryLock(dir, () => {
        assertUnchanged();
        if (merged.conflict) archive(); // 同一行两边改得不一样:合并结果取云端那行,本机整份另存一份
        atomicSyncWrite(root, abs, out, guard);
        record(fetched.file.seq, sha256(fetched.bytes), fetched.file.mtimeMs, fetched.bytes); // 影子先记成云端那份:下面推失败,下次照常推合并结果
      });
    } catch (e) { keepOld(); throw e; }
    result.pulled++;
    if (out.equals(fetched.bytes)) return;
    guard();
    const current = readSyncBytes(root, abs);
    if (!current || !current.equals(out)) return; // 又被改了:下次同步再推
    const keepFetched = unsure(out);
    try {
      const res = await cloud.putFile(uid, slug, p, { content: merged.content, isBinary: false, size: out.length, mtimeMs: Date.now(), deviceId: getDeviceId(), baseSeq: fetched.file.seq! }, { signal });
      guard(); record(res.seq, sha256(out), res.mtimeMs, out); result.pushed++;
    } catch (e) {
      if (e instanceof AgentFileConflictError) { keepFetched(); throw new Error(`cloud file changed during sync: ${p}`); }
      throw e;
    }
    return;
  }
  if (decision.kind === 'pull' || decision.kind === 'conflict') { await pull(decision.kind === 'conflict'); return; }
  if (decision.kind === 'deleteLocal') {
    // Memory deletion is a revisioned commit; existing tombstones continue to suppress old facts.
    withMemoryDirectoryLock(dir, () => { assertUnchanged(); if (memory) memory.commit({ expectedVersion: initialMemory!.version, content: '', source: { kind: 'sync' }, signal }); else if (existsSync(abs)) unlinkSync(abs); });
    delete prev.files[p]; result.deleted++; return;
  }
  if (decision.kind === 'dropShadow') { delete prev.files[p]; return; }
  if (decision.kind === 'pushDelete') {
    guard(); await cloud.deleteFile(uid, slug, p, Date.now(), getDeviceId(), pe?.seq, { signal }); guard();
    delete prev.files[p]; result.deleted++; return;
  }
  if (decision.kind === 'adopt') { record(live?.seq, live?.hash ?? undefined, live?.mtimeMs, initial ?? undefined); result.skipped++; return; }
  if (decision.kind === 'none') {
    // 两边都没动 = 本地这份就是基线;老版本留下的影子没记原文,这里补上
    if (opts.merge && modern && pe && initial && base === null) pe.base = initial.toString('utf8');
    result.skipped++; return;
  }
  if (!initial) return;
  verifyBytes({}, initial); guard(); assertUnchanged();
  const isBinary = !opts.text && !TEXT_EXTS.has(extname(p).toLowerCase());
  const keep = unsure(initial);
  try {
    const res = await cloud.putFile(uid, slug, p, { ...(isBinary ? { contentBase64: initial.toString('base64') } : { content: initial.toString('utf8') }), isBinary, size: initial.length, mtimeMs: Date.now(), deviceId: getDeviceId(), ...(decision.kind === 'pushCreate' ? { baseSeq: 0 } : decision.baseSeq >= 0 ? { baseSeq: decision.baseSeq } : {}) }, { signal });
    guard(); record(res.seq, sha256(initial), res.mtimeMs, initial); result.pushed++;
  } catch (e) {
    // A CAS collision never overwrites either side. Next sync reconciles the fresh cloud revision.
    if (e instanceof AgentFileConflictError) { keep(); throw new Error(`cloud file changed during sync: ${p}`); }
    throw e;
  }
}

/** 日志是只增不减的并集合并(块 + 页眉行),不是整份文件的后写者胜:
 *  - 本地没有云端缺的东西 → 原样采用云端那份、不推(各设备收敛到同一份文本,不因排版 / 同分钟顺序来回推)
 *  - 本地有云端缺的 → 合并后落本地(云端也有新东西时)并 CAS 推上去
 *  清单里的内容哈希与本地一致 = 两边逐字节相同,不取文件;老服务端的行没有 hash,照旧每次取。 */
async function reconcileLog(cloud: AgentFilesBrain, uid: string, slug: string, dir: string, p: string, meta: AgentFileMeta | undefined, signal: AbortSignal, guard: Guard, result: AgentFileSyncResult): Promise<void> {
  const store = createLocalMemoryStore(dir);
  const date = p.slice(4, -3);
  guard(); assertSyncPath(agentsDir(), join(dir, p));
  if (meta && !meta.deleted && meta.hash && meta.hash === sha256(store.readLogSnapshot!(date).content)) return;
  for (let attempt = 0; attempt < 4; attempt++) {
    guard(); const file = await cloud.getFile(uid, slug, p, { signal }); guard();
    if (file?.isBinary) throw new Error('invalid binary log');
    const remoteContent = file && !file.deleted ? file.content ?? '' : '';
    if (file && !file.deleted) verifyBytes(file, Buffer.from(remoteContent));
    const remote = splitLogBlocks(remoteContent);
    let content = '';
    withMemoryDirectoryLock(dir, () => {
      guard(); assertSyncPath(agentsDir(), join(dir, p));
      const snapshot = store.readLogSnapshot!(date);
      const local = splitLogBlocks(snapshot.content);
      const merged = mergeBlocks(local.blocks, remote.blocks);
      const head = mergeLogHeaders(local.header, remote.header);
      const remoteAdds = merged.onlyInB.length > 0 || head.remoteAdds;
      if (!merged.onlyInA.length && !head.localAdds) {
        if (remoteContent && remoteContent !== snapshot.content) { store.writeLog(date, remoteContent, snapshot.version); if (remoteAdds) result.pulled++; }
      } else if (remoteAdds) {
        content = logText(head.header || `# ${date}`, merged.merged);
        // 并集可能比两边任何一份都大:超限就既不落盘也不上传(传上去之后别的设备每次同步都会在这个文件上失败)
        if (Buffer.byteLength(content) > MAX_FILE_BYTES) throw new Error(`merged log exceeds sync limit: ${p}`);
        store.writeLog(date, content, snapshot.version); result.pulled++;
      } else content = snapshot.content;
    });
    if (!content || content === remoteContent) return;
    if (file && !file.deleted && typeof file.seq !== 'number') throw new Error('cloud upgrade required for safe log CAS');
    guard();
    try {
      await cloud.putFile(uid, slug, p, { content, isBinary: false, size: Buffer.byteLength(content), mtimeMs: Date.now(), deviceId: getDeviceId(), baseSeq: file && !file.deleted ? file.seq : 0 }, { signal });
      guard(); result.pushed++; return;
    } catch (e) { if (!(e instanceof AgentFileConflictError)) throw e; }
  }
  throw new Error('log sync still conflicting; retry required');
}

export function scheduleAgentFilesSync(userId: string, displayAgentSlug?: string): void {
  try {
    const d = deps();
    if (!d.profile.capabilities.hostExec || !d.brain.agentFiles || !displayAgentSlug) return;
    void runAgentFilesSync(d.brain.agentFiles, userId, { onlySlug: displayAgentSlug }).then((r) => { if (!r.ok) console.warn('[agent sync]', r.error); });
  } catch { /* runtime not assembled */ }
}
export interface PrepareAgentFilesResult { status: 'local' | 'hydrated' | 'skipped' | 'failed'; sync?: AgentFileSyncResult }
/** Existing local definition starts immediately. A first hydration waits for real cancellation/completion. */
export async function prepareAgentFilesForRun(cloud: AgentFilesBrain | undefined, userId: string, displayAgentSlug: string, opts: { signal?: AbortSignal; timeoutMs?: number } = {}): Promise<PrepareAgentFilesResult> {
  if (!validSyncSlug(displayAgentSlug)) return { status: 'failed', sync: { ...emptyResult(), ok: false, error: 'invalid selected agent' } };
  opts.signal?.throwIfAborted();
  const local = await getAgent(displayAgentSlug);
  opts.signal?.throwIfAborted();
  if (local) {
    if (cloud && agentSyncPermission(displayAgentSlug, agentSyncScope(cloud, userId)).enabled) {
      void runAgentFilesSync(cloud, userId, { onlySlug: displayAgentSlug, signal: opts.signal }).then((r) => { if (!r.ok) console.warn('[agent sync]', r.error); });
    }
    return { status: 'local' };
  }
  if (!cloud) return { status: 'failed', sync: { ...emptyResult(), ok: false, error: 'selected agent has no local snapshot or cloud source' } };
  const timeout = AbortSignal.timeout(Math.max(1, opts.timeoutMs ?? 15_000));
  const signal = opts.signal ? AbortSignal.any([opts.signal, timeout]) : timeout;
  const sync = await runAgentFilesSync(cloud, userId, { onlySlug: displayAgentSlug, signal });
  opts.signal?.throwIfAborted();
  return { status: sync.ok && await getAgent(displayAgentSlug) ? 'hydrated' : 'failed', sync };
}
