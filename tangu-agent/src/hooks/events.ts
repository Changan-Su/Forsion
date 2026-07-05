/**
 * 每事件的判定折叠（按 codex-rs/hooks/events/*.rs 语义，精简为一处）。
 *
 * 折叠原则（跨所有事件的统一实现，各派发点只取自己关心的字段）：
 *   - decision:block 或 permissionDecision:deny → block（PermissionRequest 的 deny 即 block）
 *   - permissionDecision:allow → PermissionRequest 显式放行；PreToolUse 取其 updatedInput
 *   - updatedInput：多 handler 时「最后完成者赢」（runs 已按完成序排列）
 *   - additionalContext：全收集，保序
 *   - continue:false → stop（PreToolUse 不支持 continue，忽略）
 *   - systemMessage：全收集（transcript 警告）
 */
import type { HookEventName, HookRunResult, HookVerdict } from './types.js';

export function foldVerdict(event: HookEventName, runs: HookRunResult[]): HookVerdict {
  const v: HookVerdict = { additionalContext: [], systemMessages: [], runs };
  let allowSeen = false;
  for (const r of runs) {
    const o = r.output;
    if (!o) continue;
    if (o.systemMessage) v.systemMessages.push(o.systemMessage);
    const hs = o.hookSpecificOutput || {};
    if (hs.additionalContext) v.additionalContext.push(hs.additionalContext);

    if (o.decision === 'block' || hs.permissionDecision === 'deny') {
      v.block = true;
      if (!v.blockReason) v.blockReason = o.reason || 'blocked by hook';
    }
    if (hs.permissionDecision === 'allow') {
      allowSeen = true;
      if (event === 'PreToolUse' && hs.updatedInput) v.updatedInput = hs.updatedInput; // last-completing wins
    }
    if (o.continue === false && event !== 'PreToolUse') {
      v.stop = true;
      if (!v.stopReason) v.stopReason = o.stopReason;
    }
  }
  // PermissionRequest：deny 恒胜（无论出现顺序）；无 deny 且有 allow → 显式放行。
  if (event === 'PermissionRequest' && allowSeen && !v.block) v.allow = true;
  return v;
}
