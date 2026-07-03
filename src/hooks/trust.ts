/**
 * Hook 身份与信任 hash。
 *
 * contentHash = 规范化(event + matcher + command + timeout) 的 sha256：改任一执行要害即变，
 * 使等价定义收敛到同一 trust 记录、任何编辑翻回 needs-review（重新审阅）。
 * hook_key = `{source}:{event}:{contentHash前12}` —— durable，不抄 Codex 的 `event:group:handler`
 * 位置后缀（它自挂 TODO 说要换持久 id）。
 */
import { createHash } from 'node:crypto';
import type { HookHandlerConfig, HookSource } from './types.js';

export function hookContentHash(event: string, matcher: string | undefined, h: HookHandlerConfig): string {
  const norm = JSON.stringify({
    event,
    matcher: (matcher ?? '').trim(),
    command: h.command ?? '',
    commandWindows: h.commandWindows ?? '',
    timeout: h.timeout ?? 0,
  });
  return createHash('sha256').update(norm).digest('hex');
}

export function hookKey(source: HookSource, event: string, contentHash: string): string {
  return `${source}:${event}:${contentHash.slice(0, 12)}`;
}
