import type { ToolCall } from '../core/types.js';

export const MAX_REPEATED_TOOL_FAILURES = 3;

interface ToolResult { tool_call_id: string; isError?: boolean; content?: unknown }

// 对象键序/空白不是新方案；数组顺序与参数值改变仍算纠正。只保留上一轮指纹，空间有界。
function sortedJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortedJson);
  if (value && typeof value === 'object') return Object.fromEntries(
    Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, sortedJson(item)]),
  );
  return value;
}

export class RepeatedToolFailureGuard {
  private previous = '';
  private repeats = 0;

  reset(): void { this.previous = ''; this.repeats = 0; }

  /** 只有整轮均失败、调用参数与错误均不变才计数；任一成功/纠正/不同故障都重新给恢复机会。 */
  record(calls: ToolCall[], results: ToolResult[]): boolean {
    const byId = new Map(results.map((result) => [result.tool_call_id, result]));
    if (!calls.length || calls.some((call) => byId.get(call.id)?.isError !== true)) {
      this.reset(); return false;
    }
    const fingerprint = JSON.stringify(calls.map((call) => {
      let args: unknown = call.function.arguments;
      try { args = sortedJson(JSON.parse(call.function.arguments)); } catch { /* 非 JSON 参数按原文比较 */ }
      return JSON.stringify([call.function.name, args, byId.get(call.id)?.content]);
    }).sort());
    this.repeats = fingerprint === this.previous ? this.repeats + 1 : 1;
    this.previous = fingerprint;
    return this.repeats >= MAX_REPEATED_TOOL_FAILURES;
  }
}
