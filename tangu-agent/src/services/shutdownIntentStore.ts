/**
 * `<TANGU_HOME>/shutdown-intent.json` 的读 / 删(契约见 contracts/shutdownIntent.ts;中断任务续跑方案 B)。
 * 桌面停引擎前写;引擎收到 SIGTERM 时读一次定「为什么停」,下次启动的恢复流程按持有者 pid 对上它、处理完删掉。
 * 读不出 / 解析失败 = 没有意图。
 */
import { readFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { tanguHome } from '../core/tanguHome.js';
import { INTENT_MAX_AGE_MS, SHUTDOWN_INTENT_FILE, parseShutdownIntent, type ShutdownIntent } from '../contracts/shutdownIntent.js';
import type { InterruptReason } from '../contracts/turnResume.js';

export function shutdownIntentPath(): string { return join(tanguHome(), SHUTDOWN_INTENT_FILE); }

export function readShutdownIntent(): ShutdownIntent | null {
  try { return parseShutdownIntent(readFileSync(shutdownIntentPath(), 'utf8')); } catch { return null; }
}

/** 本进程收到停止信号时的原因:意图文件写的是自己的 pid、且写入不超过 INTENT_MAX_AGE_MS 才认;否则 engine_stop。同步读(信号处理里用)。 */
export function shutdownReasonForSelf(now = Date.now()): InterruptReason {
  const intent = readShutdownIntent();
  if (!intent || intent.pid !== process.pid) return 'engine_stop';
  const age = now - intent.at;
  return age <= INTENT_MAX_AGE_MS && age >= -60_000 ? intent.reason : 'engine_stop';
}

/** 启动恢复处理完后删掉。写的是自己 pid 的那份不删(那是桌面要停**这个**引擎时写的,轮不到恢复流程)。 */
export function clearShutdownIntent(): void {
  const intent = readShutdownIntent();
  if (intent && intent.pid === process.pid) return;
  try { unlinkSync(shutdownIntentPath()); } catch { /* 没有就算了 */ }
}
