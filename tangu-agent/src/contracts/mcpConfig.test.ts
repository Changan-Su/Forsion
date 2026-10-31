import { describe, expect, it } from 'vitest';
import { applyMcpSnapshot, mergeMcpImport, parseMcpInput, patchMcpEntry } from './mcpConfig.js';

describe('MCP JSON input and atomic merges', () => {
  const entry = { command: 'npx', args: ['-y', 'test-mcp', '/a path/with spaces'], env: { KEY: 'secret' }, cwd: '/a path', timeoutMs: 1200, enabled: false };
  it('accepts the three advertised shapes without losing arrays, credentials, flags or working directory', () => {
    for (const input of [{ mcpServers: { test: entry } }, { test: entry }]) expect(parseMcpInput(JSON.stringify(input))).toEqual({ test: entry });
    expect(parseMcpInput(entry, 'test')).toEqual({ test: entry });
    expect(() => parseMcpInput(entry)).toThrow('nameRequired');
    expect(parseMcpInput({ name: { type: 'streamable-http', url: 'https://example.test/mcp', headers: { Authorization: 'Bearer key' } } })).toEqual({ name: { transport: 'http', url: 'https://example.test/mcp', headers: { Authorization: 'Bearer key' } } });
  });
  it.each([null, [], {}, { mcpServers: [] }, { test: { command: 'x', url: 'https://x' } }, { test: { command: 'x', args: [1] } }, { test: { url: 'file:///tmp/x' } }, { test: { url: 'https://x', headers: { A: 3 } } }, { test: { command: 'x', ignored: 'secret' } }, { test: { command: 'x', timeoutMs: -1 } }, { test: { command: 'x', enabled: 'false' } }])('rejects malformed/unsupported input without silently dropping fields: %j', input => {
    expect(() => parseMcpInput(input)).toThrow();
  });
  it('does not echo JSON source or secret values in syntax/field errors', () => {
    try { parseMcpInput('{\n"secret":"KEY-MUST-NOT-APPEAR",\n}'); } catch (e) { expect(String(e)).not.toContain('KEY-MUST-NOT-APPEAR'); }
    expect(() => parseMcpInput(JSON.parse('{"__proto__":{"command":"x"}}'))).toThrow('name');
  });
  it('merges additions, skips duplicates by default, and only replaces the explicitly selected current version', () => {
    const current = { old: entry, untouched: { url: 'https://keep.test' } };
    const incoming = { old: { url: 'https://new.test' }, extra: { command: 'new' } };
    expect(mergeMcpImport(current, incoming).servers).toEqual({ ...current, extra: incoming.extra });
    expect(mergeMcpImport(current, incoming, ['old'], current).servers).toEqual({ ...current, ...incoming });
    expect(() => mergeMcpImport(current, incoming, ['old'], { old: { command: 'changed' } })).toThrow('conflict');
    expect(() => mergeMcpImport({ keep: { command: 'x' } }, { 'dev.phone': { command: 'x' } })).toThrow('reserved');
    expect(() => mergeMcpImport({ 'my.server': { command: 'x' } }, { my_server: { command: 'x' } })).toThrow('collision');
  });
  it('snapshot edits preserve concurrent unrelated changes and reject concurrent edits to the touched server', () => {
    const base = { one: entry };
    const concurrent = { ...base, other: { url: 'https://keep.test' } };
    expect(applyMcpSnapshot(concurrent, { one: { ...entry, enabled: true } }, base)).toEqual({ ...concurrent, one: { ...entry, enabled: true } });
    expect(() => applyMcpSnapshot({ one: { command: 'changed' } }, {}, base)).toThrow('conflict');
  });
  it('partial updates preserve hidden credentials; null is explicit removal', () => {
    const original = { url: 'https://example.test', headers: { Authorization: 'secret', Other: 'keep' }, timeoutMs: 1500 };
    expect(patchMcpEntry(original, { timeoutMs: 2000 }, 'x')).toEqual({ ...original, timeoutMs: 2000 });
    expect(patchMcpEntry(original, { headers: { Other: null, New: 'value' } }, 'x').headers).toEqual({ Authorization: 'secret', New: 'value' });
    expect(() => patchMcpEntry(original, { headers: { Authorization: '<redacted>' } }, 'x')).toThrow('invalid');
  });
});
