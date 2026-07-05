import { describe, it, expect } from 'vitest';
import { schemaUsable, bridgeName, bridgeTool, contentToText } from './toolBridge.js';

describe('schemaUsable', () => {
  it('rejects null / non-object / $ref / non-object type', () => {
    expect(schemaUsable(null)).toBe(false);
    expect(schemaUsable('str' as any)).toBe(false);
    expect(schemaUsable({ $ref: '#/defs/X' })).toBe(false);
    expect(schemaUsable({ type: 'array' })).toBe(false);
  });
  it('accepts object schemas (explicit or default)', () => {
    expect(schemaUsable({ type: 'object' })).toBe(true);
    expect(schemaUsable({})).toBe(true); // type ?? 'object'
  });
});

describe('bridgeName', () => {
  it('produces mcp__server__tool and sanitizes illegal chars', () => {
    const used = new Set<string>();
    expect(bridgeName('s v', 't.o', used)).toBe('mcp__s_v__t_o');
  });
  it('dedupes collisions with numeric suffix', () => {
    const used = new Set<string>();
    expect(bridgeName('srv', 'tool', used)).toBe('mcp__srv__tool');
    expect(bridgeName('srv', 'tool', used)).toBe('mcp__srv__tool_2');
  });
  it('caps name length at 64', () => {
    const used = new Set<string>();
    const name = bridgeName('s'.repeat(60), 't'.repeat(60), used);
    expect(name.length).toBeLessThanOrEqual(64);
  });
});

describe('bridgeTool', () => {
  it('builds a LoadedMcpTool for a usable schema', () => {
    const used = new Set<string>();
    const t = bridgeTool('srv', { name: 'do', description: 'does', inputSchema: { type: 'object', properties: { a: {} }, required: ['a'] } }, used);
    expect(t).not.toBeNull();
    expect(t!.serverName).toBe('srv');
    expect(t!.remoteName).toBe('do');
    expect(t!.definition.function.name).toBe(t!.name);
    expect((t!.definition.function.parameters as any).required).toEqual(['a']);
    expect(t!.definition.function.description).toContain('[MCP·srv]');
  });
  it('returns null for $ref-bearing schema', () => {
    const used = new Set<string>();
    expect(bridgeTool('srv', { name: 'bad', inputSchema: { $ref: '#/x' } }, used)).toBeNull();
  });
  it('defaults a missing inputSchema to an empty object schema', () => {
    const used = new Set<string>();
    const t = bridgeTool('srv', { name: 'noschema' }, used);
    expect(t).not.toBeNull();
    expect((t!.definition.function.parameters as any).type).toBe('object');
  });
});

describe('contentToText', () => {
  it('joins text blocks', () => {
    expect(contentToText({ content: [{ type: 'text', text: 'hi' }] })).toEqual({ text: 'hi', isError: false });
  });
  it('reports isError and empty placeholder', () => {
    expect(contentToText({ isError: true, content: [] })).toEqual({ text: '(empty result)', isError: true });
  });
  it('summarizes image blocks', () => {
    const r = contentToText({ content: [{ type: 'image', mimeType: 'image/png', data: 'AAAA' }] });
    expect(r.text).toContain('[image: image/png');
  });
});
