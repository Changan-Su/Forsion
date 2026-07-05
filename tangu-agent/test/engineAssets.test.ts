import { describe, it, expect } from 'vitest';
import { parseEngineMcp, normalizeMcpServer } from '../src/engines/assets.js';

// 导入的「钱路」是 mcp 解析 + 归一化(json/toml 两路、丢引擎私有键、默认 enabled:false)。
describe('engine mcp import', () => {
  it('parses claude .claude.json mcpServers', () => {
    const raw = JSON.stringify({ mcpServers: { pencil: { command: '/bin/x', args: ['a'], type: 'stdio' } } });
    const s = parseEngineMcp('json', raw);
    expect(Object.keys(s)).toEqual(['pencil']);
    expect(s.pencil.command).toBe('/bin/x');
  });

  it('parses codex config.toml [mcp_servers.*] incl nested env', () => {
    const raw = '[mcp_servers.node_repl]\ncommand = "/n"\nargs = []\nstartup_timeout_sec = 120\n[mcp_servers.node_repl.env]\nX = "1"\n';
    const s = parseEngineMcp('toml', raw);
    expect(Object.keys(s)).toEqual(['node_repl']);
    expect(s.node_repl.command).toBe('/n');
    expect(s.node_repl.env.X).toBe('1');
  });

  it('normalizes: keeps generic fields, drops engine-private keys, defaults enabled:false', () => {
    const n = normalizeMcpServer({ command: '/n', args: ['x'], env: { X: '1' }, startup_timeout_sec: 120 });
    expect(n).toEqual({ enabled: false, command: '/n', args: ['x'], env: { X: '1' } });
  });

  it('bad input → empty (no throw)', () => {
    expect(parseEngineMcp('json', 'not json')).toEqual({});
    expect(parseEngineMcp('toml', '= = =')).toEqual({});
  });
});
