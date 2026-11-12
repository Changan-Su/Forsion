import type { ToolProvider } from '../toolRegistry.js';
import { readToolOutput } from '../outputPersist.js';
export const readToolOutputProvider: ToolProvider = {
  id: 'builtin:read-tool-output',
  tools: () => [{
    name: 'read_tool_output',
    capabilities: { sideEffect: 'read', parallel: true, defaultTimeoutMs: 15_000 },
    definition: { type: 'function', function: {
      name: 'read_tool_output',
      description: 'Retrieve a range or literal-matching lines from a spilled tool result in this session. Offsets and limits count JavaScript string characters, not lines. Follow nextOffset until null when completeness matters. Missing artifacts must be read again from the original source.',
      parameters: { type: 'object', properties: {
        id: { type: 'string' }, offset: { type: 'integer', minimum: 0 }, limit: { type: 'integer', minimum: 1, maximum: 8000 },
        contains: { type: 'string', description: 'Optional literal substring to select matching lines (not a regex).' },
      }, required: ['id'], additionalProperties: false },
    } },
    execute: (args, ctx) => readToolOutput(ctx, args),
  }],
};
