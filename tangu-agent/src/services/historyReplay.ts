/** Replay evidence, never operations. Rebuild valid call/result pairs, including tool-only
 * assistant rows. An absent outcome is unknown, not proof of success or non-execution. */
import type { ChatMessage, ToolCall } from '../core/types.js';
import { capToolResult, capHistoryContent } from './contextBudget.js';

function array(value: unknown): any[] {
  if (Array.isArray(value)) return value;
  if (typeof value === 'string') { try { const parsed = JSON.parse(value); return Array.isArray(parsed) ? parsed : []; } catch { /* legacy malformed data */ } }
  return [];
}
export function replayAssistantHistory(row: { content?: string | null; tool_calls?: unknown; tool_results?: unknown }): ChatMessage[] {
  const calls: ToolCall[] = [];
  const ids = new Set<string>();
  for (const c of array(row.tool_calls)) {
    if (!c || typeof c.id !== 'string' || !c.id || ids.has(c.id) || !c.function
      || typeof c.function.name !== 'string' || !c.function.name || typeof c.function.arguments !== 'string') continue;
    ids.add(c.id);
    calls.push({ id: c.id, type: 'function', function: { name: c.function.name, arguments: c.function.arguments } });
  }
  const content = capHistoryContent(row.content || '');
  if (!calls.length) return content.trim() ? [{ role: 'assistant', content }] : [];
  const results = new Map(array(row.tool_results).filter((r) => r && typeof r.tool_call_id === 'string').map((r) => [r.tool_call_id, r]));
  return [
    { role: 'assistant', content, tool_calls: calls },
    ...calls.map((c): ChatMessage => {
      const r = results.get(c.id);
      const text = typeof r?.content === 'string' ? r.content : null;
      return { role: 'tool', tool_call_id: c.id, content: text !== null
        ? capToolResult(`${r.isError ? '[Tool failed]\n' : ''}${text}`)
        : 'Tool outcome unknown: no result was saved. The call may have partially executed. Verify current state before retrying; do not assume success or repeat side effects blindly.' };
    }),
  ];
}
