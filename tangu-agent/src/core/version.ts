/**
 * 引擎自身版本(package.json;「引擎桌面同版发」)。供后台 run 的 client 标签(`muse/<ver>` / `automation/<ver>`)
 * 与 /health 共用;读失败回 '0'。dist/core/ 与 src/core/ 到 package.json 的相对深度相同。
 */
import { readFileSync } from 'node:fs';

let cached: string | null = null;
export function engineVersion(): string {
  if (cached !== null) return cached;
  try {
    cached = String(JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')).version || '0');
  } catch {
    cached = '0';
  }
  return cached;
}

/** 后台 run 的 client 标签(routes/runs.ts CLIENT_TAG_RE 白名单同款形状)。 */
export function backgroundClientTag(kind: 'muse' | 'automation'): string {
  return `${kind}/${engineVersion().replace(/[^A-Za-z0-9._-]/g, '').slice(0, 32) || '0'}`;
}
