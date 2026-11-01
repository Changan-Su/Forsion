import { updateSection } from '../core/config.js';
import { loadRawMcpServers } from '../mcp/config.js';
import { deps } from '../seams/runtime.js';
import { McpInputError, checkMcpNames, mergeMcpImport, parseMcpInput, patchMcpEntry, validateMcpName, type McpServerMap } from '../contracts/mcpConfig.js';

export const MCP_READ_ACTIONS = new Set(['list', 'check']);
/** Approval text identifies the actual command/endpoint and changed fields, while hiding credential values. */
export function mcpSettingsPreview(args: Record<string, any>): string {
  const action = String(args.action ?? '');
  const name = typeof args.name === 'string' ? args.name : '';
  try {
    const existing = loadRawMcpServers();
    const incoming = action === 'add' ? parseMcpInput(args.config, name) : { [name]: args.config ?? {} };
    const rows = Object.entries(incoming).map(([n, patch]) => {
      const c = action === 'add' ? patch : { ...existing[n], ...patch };
      const secrets = [...Object.values(c.env ?? {}), ...Object.values(c.headers ?? {})].filter((s): s is string => typeof s === 'string' && !!s);
      const clean = (text: string) => {
        for (const secret of secrets) text = text.split(secret).join('<redacted>');
        return text.replace(/https?:\/\/[^\s"']+/g, raw => { try { const u = new URL(raw); return u.origin; } catch { return '(invalid URL)'; } });
      };
      const commandArgs = (c.args ?? []).map((a: string, i: number, all: string[]) => /(?:token|secret|password|api[-_]?key|authorization|credential)/i.test(all[i - 1] ?? '') ? '<redacted>' : clean(a).replace(/((?:token|secret|password|api[-_]?key|authorization|credential)[^=]*=).*/i, '$1<redacted>'));
      const endpoint = c.command ? `command: ${clean(c.command)}\nargs: ${JSON.stringify(commandArgs)}` : c.url ? `url: ${clean(c.url)}` : '(connection unchanged)';
      return `${n}${action === 'add' && Object.hasOwn(existing, n) ? ' (already exists; skipped)' : ''}\n${endpoint}${c.cwd ? `\ncwd: ${clean(c.cwd)}` : ''}\nfields: ${Object.keys(patch).join(', ') || '(none)'}${Object.keys(c.env ?? {}).length ? `\nenv keys: ${Object.keys(c.env ?? {}).join(', ')} (values hidden)` : ''}${Object.keys(c.headers ?? {}).length ? `\nheader keys: ${Object.keys(c.headers ?? {}).join(', ')} (values hidden)` : ''}`;
    });
    return `MCP ${action}\n${rows.join('\n\n')}${args.reason ? `\nreason: ${String(args.reason).slice(0, 200)}` : ''}`;
  } catch { return `MCP ${action}: ${name || '(invalid configuration; validation will reject it)'}`; }
}
export function readMcpSettings(name?: string): string {
  const configs = loadRawMcpServers();
  const manager = deps().mcp;
  const status = manager?.listStatus() ?? [];
  const names = [...new Set([...Object.keys(configs), ...status.map(s => s.name)])].filter(n => !name || n === name);
  const servers = names.map(n => {
    const c = configs[n], s = status.find(s => s.name === n);
    let endpoint: string | undefined;
    if (c?.url) { try { const u = new URL(c.url); endpoint = u.origin; } catch { endpoint = '(invalid URL)'; } }
    return {
      name: n, enabled: c ? c.enabled !== false : true,
      status: c?.enabled === false ? 'disabled' : s?.status ?? 'pending',
      transport: c?.transport || (c?.command ? 'stdio' : 'http'),
      ...(endpoint ? { url: endpoint } : {}), ...(c?.command ? { command: c.command, argumentCount: c.args?.length ?? 0 } : {}),
      ...(c?.timeoutMs ? { timeoutMs: c.timeoutMs } : {}),
      credentialKeys: { env: Object.keys(c?.env ?? {}), headers: Object.keys(c?.headers ?? {}) },
      toolCount: s?.toolCount ?? 0,
      ...(s?.error ? { error: 'Connection failed. Open MCP settings for details.' } : {}),
      ...(s?.origin ? { origin: s.origin } : {}),
    };
  });
  return JSON.stringify({ servers, note: 'Credential values and command arguments are hidden. Omitted fields are preserved by update. Saved changes connect after active runs finish; new tools are available to subsequent runs.' });
}

/** Synchronous transaction: the remote-origin check is repeated inside the cross-process write lock. */
export function writeMcpSettings(action: string, args: Record<string, any>, guard: () => void): string {
  const name = typeof args.name === 'string' ? args.name : '';
  if (!['add', 'update', 'enable', 'disable', 'delete'].includes(action)) throw new Error('Unknown MCP action');
  if (action !== 'add') validateMcpName(name);
  const incoming = action === 'add' ? parseMcpInput(args.config, name) : undefined;
  const pluginNames = new Set((deps().mcp?.listStatus() ?? []).filter(s => s.origin).map(s => s.name));
  const names = incoming ? Object.keys(incoming) : [name];
  if (names.some(n => pluginNames.has(n))) throw new Error('Plugin-owned MCP servers are managed by their plugin, not this tool.');
  let changed: string[] = [], skipped: string[] = [];
  updateSection('mcp', sec => {
    guard();
    const current: McpServerMap = sec === undefined ? loadRawMcpServers() : sec?.mcpServers ?? {};
    if (incoming) {
      const result = mergeMcpImport(current, incoming);
      changed = result.added; skipped = result.skipped;
      return changed.length ? { ...sec, mcpServers: result.servers } : undefined;
    }
    if (!Object.hasOwn(current, name)) throw new Error(`MCP server not found: ${name}`);
    const next = { ...current };
    if (action === 'delete') delete next[name];
    else if (action === 'enable' || action === 'disable') next[name] = { ...current[name], enabled: action === 'enable' };
    else next[name] = patchMcpEntry(current[name], args.config, name);
    checkMcpNames(next, current);
    if (JSON.stringify(next) === JSON.stringify(current)) return undefined;
    changed = [name];
    return { ...sec, mcpServers: next };
  });
  return JSON.stringify({ action, changed, skipped, status: changed.length ? 'saved' : 'unchanged', note: 'Connection changes apply after active runs finish. Use check in a later run to inspect actual connection status. Existing names are skipped by add; use update to change one.' });
}
