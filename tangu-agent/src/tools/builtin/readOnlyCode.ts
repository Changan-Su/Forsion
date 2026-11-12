import type { ToolProvider } from '../toolRegistry.js';
import { READ_ONLY_PROGRAM_TOOLS, runReadOnlyProgram } from '../readOnlyProgram.js';

export const readOnlyCodeProvider: ToolProvider = {
  id: 'builtin:read-only-code',
  tools: () => [{
    name: 'read_only_code',
    deferred: true,
    deferHint: 'Read/filter/aggregate several files in one program; only printed evidence enters context. No writes or shell.',
    isEnabledFor: (_profile, ctx) => ctx.supportsReadOnlyCode === true,
    capabilities: { sideEffect: 'read', parallel: false, defaultTimeoutMs: 65_000 },
    definition: { type: 'function', function: {
      name: 'read_only_code',
      description: `Run isolated JavaScript to read, filter and aggregate data without spending a model turn on each read. tool(name, args) synchronously returns the tool's TEXT result; parse JSON yourself if needed. print(value) is the ONLY output returned to the model. No await, imports, Node, filesystem or network globals. Available names (subject to current permissions): ${[...READ_ONLY_PROGRAM_TOOLS].join(', ')}. Maximum 32 calls, 2 MB input, 24000 printed characters, 60 seconds. Example: const text = tool("read_file", {path:"data.csv"}); print(text.split("\\n").filter(x => x.includes("ERROR"))); Keep source paths/identifiers in printed evidence. Tool errors throw; do not treat an incomplete read as complete.`,
      parameters: { type: 'object', properties: { code: { type: 'string', description: 'Synchronous JavaScript using tool(name, args) and print(value).' } }, required: ['code'], additionalProperties: false },
    } },
    execute: async (args, ctx) => {
      if (!ctx.runReadOnlyTool) throw new Error('Read-only programs are unavailable in this context');
      return runReadOnlyProgram(String(args.code || ''), {
        signal: ctx.signal,
        call: (name, input, signal) => ctx.runReadOnlyTool!(name, input, signal, ctx.toolCallId || ''),
      });
    },
  }],
};
