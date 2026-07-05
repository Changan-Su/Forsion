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

let brain: CloudBrainServices | null = null;
let running = false;
let lastAt: number | null = null;
let lastResult: SyncRunResult | null = null;

/** buildBrain 装配时注入云端 brain(httpBrain:有 agentFiles + memory 端点)。 */
export function setSyncSources(s: { brain: CloudBrainServices }): void {
  brain = s.brain;
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

export function getSyncStatus(): SyncStatus {
  return { available: !!brain, running, lastAt, lastResult };
}

function noCloud(): SyncRunResult {
  return { ok: false, agents: 0, pushed: 0, pulled: 0, deleted: 0, skipped: 0, memory: 'skipped', logs: [], error: 'no cloud (未登录 Forsion 或未配置云端)' };
}

/** 跑一次同步。并发保护:已在跑则返回上次结果。无云端源 → ok:false。 */
export async function syncNow(userId: string): Promise<SyncRunResult> {
  if (!brain) return noCloud();
  if (running) return lastResult ?? noCloud();
  running = true;
  try {
    // 1) 每-agent 文件镜像(cloudSync 开的 agent)。
    let af: AgentFileSyncResult = { ok: true, agents: 0, pushed: 0, pulled: 0, deleted: 0, skipped: 0 };
    if (brain.agentFiles) {
      try {
        af = await runAgentFilesSync(brain.agentFiles, userId);
      } catch (e: any) {
        af = { ok: false, agents: 0, pushed: 0, pulled: 0, deleted: 0, skipped: 0, error: String(e?.message || e) };
      }
    }
    // 2) 旧全局 xyra 记忆/日志(AI Studio 网页共享;D7 过渡保留)。失败不阻断。
    let memory: SyncResult['memory'] = 'skipped';
    let logs: SyncResult['logs'] = [];
    try {
      const xyraStore = createLocalMemoryStore(join(agentsDir(), DEFAULT_AGENT_SLUG));
      const r = await runMemorySync(xyraStore, brain.memory, { userId });
      memory = r.memory;
      logs = r.logs;
    } catch { /* 旧路径失败不阻断 */ }

    const res: SyncRunResult = {
      ok: af.ok, agents: af.agents, pushed: af.pushed, pulled: af.pulled, deleted: af.deleted, skipped: af.skipped,
      memory, logs, error: af.error,
    };
    lastResult = res;
    lastAt = Date.now();
    return res;
  } finally {
    running = false;
  }
}
