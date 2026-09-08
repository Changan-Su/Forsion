/**
 * 进程内同步服务(standalone/desktop):持有云端 brain 引用(由 buildBrain 注入),对外暴露 syncNow / status。
 * 手动触发为主(默认);自动由桌面端按开关定时调 syncNow(后端不另起调度)。
 *
 * 跑两件事:
 *   1) **每-agent 文件镜像**(agentFileSync):开了 cloudSync 的 agent,定义/记忆/日志/Library 跨设备完全镜像。
 *      —— 这取代了旧「单 store 只同步 xyra」的 bug(syncNow 在 run-context 外 → 恒落 xyra)。
 *   2) **旧全局 xyra 记忆/日志**(runMemorySync):AI Studio 网页与 Tangu 共享的 ai_studio_memory;D7 过渡保留,
 *      让网页视图仍有内容,与新 tangu_agent_files 并行(待收敛后删)。
 *
 * 未注入(纯本地无云、或未登录)→ syncNow 返回 { ok:false, error:'no cloud' },不抛。
 */
import type { CloudBrainServices } from '../seams/cloudBrain.js';
import { runMemorySync, type SyncResult } from './memorySync.js';
import { runAgentFilesSync, type AgentFileSyncResult } from './agentFileSync.js';
import { createLocalMemoryStore } from '../adapters/standalone/localMemoryBrain.js';
import { agentsDir, DEFAULT_AGENT_SLUG } from '../core/tanguHome.js';
import { join } from 'node:path';
import { agentSyncPermission, agentSyncScope } from './cloudSyncAccount.js';

let brain: CloudBrainServices | null = null;
let running = false;
let runningScope: string | null = null;
let lastScope: string | null = null;
let lastAt: number | null = null;
let lastResult: SyncRunResult | null = null;

/** buildBrain 装配时注入云端 brain(httpBrain:有 agentFiles + memory 端点)。 */
export function setSyncSources(s: { brain: CloudBrainServices }): void {
  brain = s.brain;
  lastAt = null;
  lastResult = null;
  lastScope = null;
}

export interface SyncRunResult {
  ok: boolean;
  agents: number;   // 镜像的 agent 数(cloudSync 开的)
  pushed: number;
  pulled: number;
  deleted: number;
  skipped: number;
  memory: SyncResult['memory']; // 旧全局 xyra(AI Studio 网页)
  logs: SyncResult['logs'];
  error?: string;
}

export interface SyncStatus {
  available: boolean;
  running: boolean;
  lastAt: number | null;
  lastResult: SyncRunResult | null;
}

export function getSyncStatus(userId = 'local'): SyncStatus {
  const scope = agentSyncScope(brain?.agentFiles, userId);
  return { available: !!scope, running: running && runningScope === scope, lastAt: lastScope === scope ? lastAt : null, lastResult: lastScope === scope ? lastResult : null };
}

function noCloud(): SyncRunResult {
  return { ok: false, agents: 0, pushed: 0, pulled: 0, deleted: 0, skipped: 0, memory: 'skipped', logs: [], error: 'no cloud (未登录 Forsion 或未配置云端)' };
}

/** 跑一次同步。并发保护:已在跑则返回上次结果。无云端源 → ok:false。 */
export async function syncNow(userId: string): Promise<SyncRunResult> {
  if (!brain) return noCloud();
  const activeBrain = brain;
  const scope = agentSyncScope(activeBrain.agentFiles, userId);
  if (!scope) return noCloud();
  if (running) return (lastScope === scope ? lastResult : null) ?? noCloud();
  running = true;
  runningScope = scope;
  try {
    // 1) 每-agent 文件镜像(cloudSync 开的 agent)。
    let af: AgentFileSyncResult = { ok: true, agents: 0, pushed: 0, pulled: 0, deleted: 0, skipped: 0, conflicts: 0 };
    if (activeBrain.agentFiles) {
      try {
        af = await runAgentFilesSync(activeBrain.agentFiles, userId);
      } catch (e: any) {
        af = { ok: false, agents: 0, pushed: 0, pulled: 0, deleted: 0, skipped: 0, conflicts: 0, error: String(e?.message || e) };
      }
    }
    // 2) 旧全局 xyra 记忆/日志(AI Studio 网页共享;D7 过渡保留)。失败不阻断。
    let memory: SyncResult['memory'] = 'skipped';
    let logs: SyncResult['logs'] = [];
    try {
      // The historical global path is also an upload. It needs this account's explicit permission.
      const permission = agentSyncPermission(DEFAULT_AGENT_SLUG, scope);
      if (brain === activeBrain && permission.enabled && permission.shared) {
        const xyraStore = createLocalMemoryStore(join(agentsDir(), DEFAULT_AGENT_SLUG), scope);
        const r = await runMemorySync(xyraStore, activeBrain.memory, { userId });
        memory = r.memory;
        logs = r.logs;
      }
    } catch { /* 旧路径失败不阻断 */ }

    const res: SyncRunResult = {
      ok: af.ok, agents: af.agents, pushed: af.pushed, pulled: af.pulled, deleted: af.deleted, skipped: af.skipped,
      memory, logs, error: af.error,
    };
    if (brain === activeBrain) {
      lastResult = res;
      lastAt = Date.now();
      lastScope = scope;
    }
    return res;
  } finally {
    running = false;
    runningScope = null;
  }
}
