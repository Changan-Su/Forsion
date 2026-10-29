/** Pure MCP input/merge contract shared by the desktop and engine. No IO or credentials in errors. */
export interface McpConfigEntry {
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  transport?: 'stdio' | 'http' | 'sse';
  headers?: Record<string, string>;
  timeoutMs?: number;
  enabled?: boolean;
  cwd?: string;
}
export type McpServerMap = Record<string, McpConfigEntry>;
export class McpInputError extends Error {
  constructor(public code: 'json' | 'object' | 'empty' | 'nameRequired' | 'name' | 'field' | 'invalid' | 'reserved' | 'collision' | 'conflict', public path = '', public line?: number) {
    super(`MCP configuration: ${code}${path ? ` (${path})` : ''}${line ? `, line ${line}` : ''}`);
  }
}
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const FIELDS = new Set(['command', 'args', 'env', 'url', 'transport', 'type', 'headers', 'timeoutMs', 'enabled', 'cwd']);
export const mcpNameKey = (name: string): string => name.replace(/[^a-zA-Z0-9_-]/g, '_');
export const reservedMcpName = (name: string): boolean => `mcp__${mcpNameKey(name)}__`.toLowerCase().startsWith('mcp__dev_');
export function validateMcpName(name: string): void {
  if (!name || name !== name.trim() || name.length > 128 || /[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2060-\u2069\ufeff]/.test(name) || ['__proto__', 'constructor', 'prototype'].includes(name)) throw new McpInputError('name');
}
export function validateMcpEntry(value: unknown, name: string): McpConfigEntry {
  if (!object(value)) throw new McpInputError('object', name);
  for (const k of Object.keys(value)) if (!FIELDS.has(k)) throw new McpInputError('field', `${name}.${k}`);
  const v = { ...value };
  if (Object.hasOwn(v, 'type')) {
    const type = v.type === 'streamable-http' ? 'http' : v.type;
    if (!['stdio', 'http', 'sse'].includes(String(type)) || (v.transport !== undefined && v.transport !== type)) throw new McpInputError('invalid', `${name}.type`);
    v.transport = type;
    delete v.type;
  }
  for (const k of ['command', 'url', 'cwd']) if (Object.hasOwn(v, k) && (typeof v[k] !== 'string' || !(v[k] as string).trim())) throw new McpInputError('invalid', `${name}.${k}`);
  if (!!v.command === !!v.url) throw new McpInputError('invalid', `${name}.command/url`);
  if (v.url) {
    try { if (!['http:', 'https:'].includes(new URL(String(v.url)).protocol)) throw 0; } catch { throw new McpInputError('invalid', `${name}.url`); }
  }
  if (Object.hasOwn(v, 'args') && (!Array.isArray(v.args) || [...v.args].some(a => typeof a !== 'string'))) throw new McpInputError('invalid', `${name}.args`);
  for (const k of ['env', 'headers']) if (Object.hasOwn(v, k) && (!object(v[k]) || Object.values(v[k] as object).some(x => typeof x !== 'string'))) throw new McpInputError('invalid', `${name}.${k}`);
  if (v.transport !== undefined && (!['stdio', 'http', 'sse'].includes(String(v.transport)) || (v.transport === 'stdio' ? !v.command : !v.url))) throw new McpInputError('invalid', `${name}.transport`);
  if (Object.hasOwn(v, 'enabled') && typeof v.enabled !== 'boolean') throw new McpInputError('invalid', `${name}.enabled`);
  if (Object.hasOwn(v, 'timeoutMs') && (typeof v.timeoutMs !== 'number' || !Number.isInteger(v.timeoutMs) || v.timeoutMs < 1 || v.timeoutMs > 2_147_483_647)) throw new McpInputError('invalid', `${name}.timeoutMs`);
  return v as McpConfigEntry;
}
export function parseMcpInput(input: unknown, singleName?: string): McpServerMap {
  let data = input;
  if (typeof data === 'string') {
    if (data.length > 1_048_576) throw new McpInputError('invalid', 'JSON (max 1 MiB)');
    try { data = JSON.parse(data); } catch (e) {
      const pos = Number(/position (\d+)/.exec(String(e))?.[1]);
      throw new McpInputError('json', '', Number.isFinite(pos) ? (input as string).slice(0, pos).split('\n').length : undefined);
    }
  }
  if (!object(data)) throw new McpInputError('object');
  let servers: unknown = data;
  if (Object.hasOwn(data, 'mcpServers')) {
    if (Object.keys(data).some(k => k !== 'mcpServers')) throw new McpInputError('field', 'mcpServers');
    servers = data.mcpServers;
  } else if (typeof data.command === 'string' || typeof data.url === 'string') {
    if (!singleName?.trim()) throw new McpInputError('nameRequired');
    servers = { [singleName.trim()]: data };
  }
  if (!object(servers)) throw new McpInputError('object', 'mcpServers');
  if (!Object.keys(servers).length) throw new McpInputError('empty');
  const entries = Object.entries(servers).map(([name, value]) => { validateMcpName(name); return [name, validateMcpEntry(value, name)] as const; });
  return Object.fromEntries(entries);
}
export const sameMcpValue = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);
/** Apply only the delta from a read snapshot, with compare-and-swap for each touched server. */
export function applyMcpSnapshot(current: McpServerMap, next: McpServerMap, base: McpServerMap): McpServerMap {
  if (!object(next) || !object(base)) throw new McpInputError('object');
  const result = { ...current };
  for (const name of new Set([...Object.keys(base), ...Object.keys(next)])) {
    if (sameMcpValue(base[name], next[name])) continue;
    if (!sameMcpValue(current[name], base[name])) throw new McpInputError('conflict', name);
    if (Object.hasOwn(next, name)) { validateMcpName(name); result[name] = validateMcpEntry(next[name], name); }
    else delete result[name];
  }
  checkMcpNames(result, current);
  return result;
}
/** New names may not take device/plugin namespaces or collide after tool-name sanitization. */
export function checkMcpNames(next: McpServerMap, current: McpServerMap): void {
  const names = new Map<string, string>();
  for (const name of Object.keys(current)) names.set(mcpNameKey(name), name);
  for (const name of Object.keys(next)) {
    if (reservedMcpName(name) && !Object.hasOwn(current, name)) throw new McpInputError('reserved', name);
    const prior = names.get(mcpNameKey(name));
    if (prior && prior !== name && !Object.hasOwn(current, name)) throw new McpInputError('collision', name);
    names.set(mcpNameKey(name), name);
  }
}
/** Read/modify/write callers run this inside their cross-process config lock. */
export function mergeMcpImport(current: McpServerMap, incoming: McpServerMap, replaceNames: string[] = [], expected: McpServerMap = {}): { servers: McpServerMap; added: string[]; replaced: string[]; skipped: string[] } {
  checkMcpNames(incoming, current);
  const servers = { ...current }, added: string[] = [], replaced: string[] = [], skipped: string[] = [];
  for (const [name, config] of Object.entries(incoming)) {
    if (Object.hasOwn(current, name)) {
      if (!replaceNames.includes(name)) { skipped.push(name); continue; }
      if (!Object.hasOwn(expected, name) || !sameMcpValue(current[name], expected[name])) throw new McpInputError('conflict', name);
      replaced.push(name);
    } else {
      if (Object.hasOwn(expected, name)) throw new McpInputError('conflict', name);
      added.push(name);
    }
    servers[name] = config;
  }
  return { servers, added, replaced, skipped };
}
/** Partial updates preserve omitted fields and credentials; null explicitly removes a field/map key. */
export function patchMcpEntry(previous: McpConfigEntry, patch: unknown, name: string): McpConfigEntry {
  if (!object(patch)) throw new McpInputError('object', name);
  const next: Record<string, unknown> = { ...previous };
  for (const [key, value] of Object.entries(patch)) {
    if (!FIELDS.has(key)) throw new McpInputError('field', `${name}.${key}`);
    if (value === null) { delete next[key]; continue; }
    if ((key === 'env' || key === 'headers') && object(value)) {
      const map: Record<string, string> = Object.assign(Object.create(null), previous[key]);
      for (const [k, v] of Object.entries(value)) {
        if (v === '<redacted>') throw new McpInputError('invalid', `${name}.${key}`);
        if (v === null) delete map[k]; else map[k] = v as string;
      }
      next[key] = map;
    } else next[key] = value;
  }
  return validateMcpEntry(next, name);
}

/** URLs can carry credentials in their userinfo, query, or even path. Public summaries expose the origin only. */
export function publicMcpUrl(value: string | undefined): string {
  try { return new URL(value || '').origin; } catch { return ''; }
}
