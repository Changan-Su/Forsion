import type { ToolProvider } from '../toolRegistry.js';
import type { ToolContext } from '../toolTypes.js';
import { effectiveRemote, remoteManagementDenied } from '../../services/remoteOrigin.js';
import { MCP_READ_ACTIONS, readMcpSettings, writeMcpSettings } from '../../services/mcpSettings.js';
import { publish } from '../../services/eventBus.js';

function foreground(ctx: ToolContext): boolean {
  return !((ctx.subAgentDepth ?? 0) >= 1 || ctx.inDiscussion || ctx.muse || ctx.automationOrigin || ctx.ephemeral || ctx.approvalDeferral);
}
export const manageMcpProvider: ToolProvider = {
  id: 'builtin:manage_mcp',
  tools: () => [{
    name: 'manage_mcp', mode: 'host', deferred: true, deferGroup: 'mcp_settings',
    deferHint: 'Configure MCP servers in Forsion: install/add from MCP JSON, update settings or credentials, enable, disable, delete, and check connection/tool status.',
    isEnabledFor: (_p, ctx) => foreground(ctx),
    definition: { type: 'function', function: {
      name: 'manage_mcp',
      description: 'Manage MCP servers on this computer. list/check are read-only and hide credentials. add accepts {mcpServers:{name:{...}}}, a named server map, or one server config with name; existing names are skipped. update requires name and a partial config; omitted fields and credential keys are preserved, null removes a field/key. Supported fields: command, args (string array), env, url, transport (stdio/http/sse), headers, timeoutMs, cwd, enabled. Use enable/disable/delete with name. Writes follow the user’s current control-plane approval policy; include a short reason. Saved changes reconnect after all active runs finish, never interrupt this reply or change its tool list; use check in a subsequent run. Plugin/device servers and approval policy cannot be changed here. Never invent credentials or claim connected from a saved receipt.',
      parameters: { type: 'object', properties: {
        action: { type: 'string', enum: ['list', 'check', 'add', 'update', 'enable', 'disable', 'delete'] },
        name: { type: 'string', description: 'Server name; required except for list and batch add' },
        config: { type: 'object', description: 'MCP JSON object for add; partial server fields for update. Omit unchanged credentials, do not write redaction placeholders.' },
        reason: { type: 'string', description: 'Brief reason for a write, shown on the approval prompt' },
      }, required: ['action'] },
    } },
    execute: async (args, ctx) => {
      try {
        if (!foreground(ctx) || ctx.execMode !== 'host') throw new Error('MCP settings are available only in a local foreground host conversation.');
        const action = String(args.action ?? '');
        if (MCP_READ_ACTIONS.has(action)) return readMcpSettings(typeof args.name === 'string' ? args.name : undefined);
        const guard = () => {
          if (effectiveRemote(ctx)) throw new Error(remoteManagementDenied('manage_mcp', action)!);
          if (ctx.runOrigin === 'channel') throw new Error('MCP settings cannot be changed from a chat channel.');
        };
        guard();
        if (typeof args.reason !== 'string' || !args.reason.trim()) throw new Error('A reason is required for MCP changes.');
        const result = writeMcpSettings(action, args, guard);
        if (ctx.runId && JSON.parse(result).changed.length) void publish(ctx.runId, 'app_settings_changed', { section: 'mcp', source: 'agent' });
        return result;
      } catch (e) { return `Error: ${(e as Error).message}`; }
    },
  }],
};
