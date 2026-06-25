/**
 * 稳定的 per-install 设备标识。首次生成存 ~/.tangu/device.json,之后复用。
 * 用途:本地日志条目打标 `@<deviceId>`,使多端追加合并时同分钟同文本的不同来源条目不被误判重复。
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { dirname } from 'node:path';
import { deviceIdFile, tanguHome } from './tanguHome.js';

let cached: string | null = null;

export function getDeviceId(): string {
  if (cached) return cached;
  try {
    const raw = JSON.parse(readFileSync(deviceIdFile(), 'utf8'));
    if (raw?.deviceId && typeof raw.deviceId === 'string') {
      const id: string = raw.deviceId;
      cached = id;
      return id;
    }
  } catch {
    /* 不存在/损坏 → 重新生成 */
  }
  const id = randomUUID().slice(0, 8); // 8 字符够区分本地多端,日志里也短
  try {
    mkdirSync(dirname(deviceIdFile()), { recursive: true });
    writeFileSync(deviceIdFile(), JSON.stringify({ deviceId: id }), 'utf8');
  } catch {
    /* 写不进(只读 home 等)→ 仍返回本次生成的 id,本进程内稳定即可 */
    void tanguHome();
  }
  cached = id;
  return id;
}
