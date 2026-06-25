/**
 * 进程内记忆同步服务(standalone/desktop):持有「本地 store + 云端 memory brain」引用(由 buildBrain 注入),
 * 对外暴露 syncNow / status。手动触发为主(默认);自动由桌面端按开关定时调 syncNow(后端不另起调度)。
 *
 * 未注入(纯本地无云、或未登录)→ syncNow 返回 { ok:false, error:'no cloud' },不抛。
 */
import type { MemoryBrain } from '../seams/cloudBrain.js';
import type { LocalMemoryStore } from '../adapters/standalone/localMemoryBrain.js';
import { runMemorySync, type SyncResult } from './memorySync.js';

let store: LocalMemoryStore | null = null;
let cloud: MemoryBrain | null = null;
let running = false;
let lastAt: number | null = null;
let lastResult: SyncResult | null = null;

/** buildBrain 装配时注入本地 store + 云端 memory(httpBrain.memory)。 */
export function setSyncSources(s: { store: LocalMemoryStore; cloud: MemoryBrain }): void {
  store = s.store;
  cloud = s.cloud;
}

export interface SyncStatus {
  available: boolean; // 是否已注入云端源(粗判「能否同步」)
  running: boolean;
  lastAt: number | null;
  lastResult: SyncResult | null;
}

export function getSyncStatus(): SyncStatus {
  return { available: !!(store && cloud), running, lastAt, lastResult };
}

/** 跑一次同步。并发保护:已在跑则返回上次结果。无云端源 → ok:false。 */
export async function syncNow(userId: string): Promise<SyncResult> {
  if (!store || !cloud) return { ok: false, memory: 'skipped', logs: [], error: 'no cloud (未登录 Forsion 或未配置云端)' };
  if (running) return lastResult ?? { ok: false, memory: 'skipped', logs: [], error: 'sync already running' };
  running = true;
  try {
    const r = await runMemorySync(store, cloud, { userId });
    lastResult = r;
    lastAt = Date.now();
    return r;
  } finally {
    running = false;
  }
}
