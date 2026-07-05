import { describe, it, expect } from 'vitest';
import { openaiToAnthropicBody } from './anthropicMessages.js';

describe('openaiToAnthropicBody', () => {
  it('forces the Claude Code system block first, real system after', () => {
    const body = openaiToAnthropicBody({
      model: 'claude-x',
      messages: [
        { role: 'system', content: 'BE NICE' },
        { role: 'user', content: 'hi' },
      ],
    });
    expect(body.system[0]).toEqual({ type: 'text', text: "You are Claude Code, Anthropic's official CLI for Claude." });
    expect(body.system[1]).toEqual({ type: 'text', text: 'BE NICE' });
    expect(body.messages).toEqual([{ role: 'user', content: [{ type: 'text', text: 'hi' }] }]);
  });

  it('converts assistant tool_calls → tool_use and coalesces tool results into one user turn', () => {
    const body = openaiToAnthropicBody({
      model: 'claude-x',
      messages: [
        { role: 'user', content: 'read a' },
        { role: 'assistant', content: 'ok', tool_calls: [{ id: 't1', type: 'function', function: { name: 'read', arguments: '{"p":"a"}' } }] },
        { role: 'tool', tool_call_id: 't1', content: 'FILE BODY' },
        { role: 'tool', tool_call_id: 't1b', content: 'SECOND' },
      ],
    });
    const asst = body.messages.find((m: any) => m.role === 'assistant');
    expect(asst.content).toEqual([
      { type: 'text', text: 'ok' },
      { type: 'tool_use', id: 't1', name: 'read', input: { p: 'a' } },
    ]);
    const toolUser = body.messages[body.messages.length - 1];
    expect(toolUser.role).toBe('user');
    expect(toolUser.content).toEqual([
      { type: 'tool_result', tool_use_id: 't1', content: 'FILE BODY' },
      { type: 'tool_result', tool_use_id: 't1b', content: 'SECOND' },
    ]);
  });

  it('maps OpenAI tools → input_schema and tool_choice vocab', () => {
    const body = openaiToAnthropicBody({
      model: 'claude-x',
      messages: [],
      tools: [{ type: 'function', function: { name: 'f', description: 'd', parameters: { type: 'object', properties: { x: { type: 'string' } } } } }],
      tool_choice: 'auto',
    });
    expect(body.tools).toEqual([{ name: 'f', description: 'd', input_schema: { type: 'object', properties: { x: { type: 'string' } } } }]);
    expect(body.tool_choice).toEqual({ type: 'auto' });
  });
});
