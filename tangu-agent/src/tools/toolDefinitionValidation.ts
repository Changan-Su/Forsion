import { LlmError, type Tool } from '../core/types.js';

const object = (v: unknown): v is Record<string, any> => !!v && typeof v === 'object' && !Array.isArray(v);

/** Check the OpenAI function envelope; provider-specific schema rules stay with the provider. */
export function toolDefinitionIssue(value: unknown, expectedName?: string): string | undefined {
  if (!object(value)) return 'definition must be an object';
  if (value.type !== 'function') return 'definition.type must be function';
  if (!object(value.function)) return 'definition.function must be an object';
  const f = value.function;
  if (typeof f.name !== 'string' || !f.name.trim()) return 'function.name must be a non-empty string';
  if (expectedName !== undefined && f.name !== expectedName) return 'function.name differs from the registered name';
  if (f.description !== undefined && typeof f.description !== 'string') return 'function.description must be a string';
  if (f.parameters !== undefined && !object(f.parameters)) return 'function.parameters must be an object';
  return undefined;
}

// Repeated resolve/approval/catalog reads should not flood feedback logs. Never log schemas or arguments.
const warned = new Set<string>();
const label = (s: unknown): string => typeof s === 'string' ? s.replace(/[\r\n\t]/g, ' ').slice(0, 160) : '(unnamed)';
export function warnInvalidTool(source: string, name: unknown, issue: string): void {
  const message = `[tangu-tools] Ignoring invalid tool: source=${label(source)} tool=${label(name)}; ${issue}`;
  if (warned.has(message)) return;
  if (warned.size >= 256) warned.delete(warned.values().next().value!);
  warned.add(message);
  console.warn(message);
}

export function usableToolDefinition(value: unknown, source: string, name: unknown): value is Tool {
  const issue = typeof name !== 'string' || !name.trim() ? 'registered name must be a non-empty string'
    : toolDefinitionIssue(value, name);
  if (!issue) return true;
  warnInvalidTool(source, name, issue);
  return false;
}

/** Last guard before payload construction: undefined array entries serialize to null. */
export function assertToolDefinitions(tools: unknown, source: string): void {
  if (tools === undefined) return;
  if (!Array.isArray(tools)) throw new LlmError(400, `Invalid tools in ${source}: expected an array.`);
  for (let i = 0; i < tools.length; i++) {
    const issue = toolDefinitionIssue(tools[i]);
    if (issue) throw new LlmError(400, `Invalid tools[${i}] in ${source}: ${issue}. No model request was sent.`);
  }
}
