/** Explicit account consent controls both agent file sync and the optional historical shared store. */
import type { CloudBrainServices } from '../seams/cloudBrain.js';
import { runMemorySync, type SyncResult } from './memorySync.js';
import { runAgentFilesSync } from './agentFileSync.js';
import { createLocalMemoryStore } from '../adapters/standalone/localMemoryBrain.js';
import { agentsDir, DEFAULT_AGENT_SLUG } from '../core/tanguHome.js';
import { join } from 'node:path';
import { agentSyncPermission, agentSyncScope, captureAgentSyncPermission, invalidateAgentSyncOperations, agentSyncOperationSignal, agentSyncConsentSignal } from './cloudSyncAccount.js';
let brain: CloudBrainServices | null = null;
let generation = 0;
const running = new Map<string, Promise<SyncRunResult>>();
let lastScope: string | null = null;
let lastAt: number | null = null;
let lastResult: SyncRunResult | null = null;
export function setSyncSources(s: { brain: CloudBrainServices }): void {
  invalidateAgentSyncOperations(); generation++;
  brain = s.brain; lastAt = null; lastResult = null; lastScope = null;
}
export interface SyncRunResult {
  ok: boolean; agents: number; pushed: number; pulled: number; deleted: number; skipped: number;
  memory: SyncResult['memory']; logs: SyncResult['logs']; error?: string;
}
export interface SyncStatus { available: boolean; running: boolean; lastAt: number | null; lastResult: SyncRunResult | null }
export function getSyncStatus(userId = 'local'): SyncStatus {
  const scope = agentSyncScope(brain?.agentFiles, userId);
  return { available: !!scope, running: !!scope && running.has(`${generation}:${scope}`), lastAt: lastScope === scope ? lastAt : null, lastResult: lastScope === scope ? lastResult : null };
}
const failed = (error: string): SyncRunResult => ({ ok: false, agents: 0, pushed: 0, pulled: 0, deleted: 0, skipped: 0, memory: 'skipped', logs: [], error });
/** Duplicate callers await the same actual operation instead of receiving a stale "success". */
export function syncNow(userId: string, opts: { signal?: AbortSignal } = {}): Promise<SyncRunResult> {
  const active = brain;
  const scope = agentSyncScope(active?.agentFiles, userId);
  if (!active || !scope) return Promise.resolve(failed('no cloud (未登录 Forsion 或未配置云端)'));
  const key = `${generation}:${scope}`;
  const pending = running.get(key);
  if (pending) return pending;
  const signal = agentSyncOperationSignal(opts.signal);
  const guard = (): void => { signal.throwIfAborted(); if (brain !== active || agentSyncScope(active.agentFiles, userId) !== scope) throw new Error('cloud account/source changed'); };
  const task = (async (): Promise<SyncRunResult> => {
    let result = failed('sync did not complete');
    try {
      guard();
      const af = active.agentFiles ? await runAgentFilesSync(active.agentFiles, userId, { signal, assertActive: guard }) : { ok: true, agents: 0, pushed: 0, pulled: 0, deleted: 0, skipped: 0, error: undefined };
      result = { ok: af.ok, agents: af.agents, pushed: af.pushed, pulled: af.pulled, deleted: af.deleted, skipped: af.skipped, memory: 'skipped', logs: [], error: af.error };
      guard();
      const permission = agentSyncPermission(DEFAULT_AGENT_SLUG, scope);
      if (permission.enabled && permission.shared) {
        const consent = captureAgentSyncPermission(DEFAULT_AGENT_SLUG, scope, true);
        const consentSignal = AbortSignal.any([signal, agentSyncConsentSignal(DEFAULT_AGENT_SLUG, scope)]);
        const r = await runMemorySync(createLocalMemoryStore(join(agentsDir(), DEFAULT_AGENT_SLUG), scope), active.memory, { userId, signal: consentSignal, assertActive: () => { guard(); consent(); } });
        result.memory = r.memory; result.logs = r.logs;
        if (r.ok === false) { result.ok = false; result.error = [result.error, r.error].filter(Boolean).join('; '); }
      }
      guard();
    } catch (e) { result.ok = false; result.error = [result.error, e instanceof Error ? e.message : String(e)].filter(Boolean).join('; '); }
    if (brain === active && !signal.aborted) { lastResult = result; lastAt = Date.now(); lastScope = scope; }
    return result;
  })();
  running.set(key, task);
  void task.finally(() => { if (running.get(key) === task) running.delete(key); });
  return task;
}
