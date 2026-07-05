import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { configExists, loadRawConfig, getRawSection, saveSection, migrateLegacyConfig } from './config.js';
import { loadMcpConfig } from '../mcp/config.js';

let dir: string;
let prevHome: string | undefined;

beforeEach(() => {
  prevHome = process.env.TANGU_HOME;
  dir = mkdtempSync(join(tmpdir(), 'tangu-cfg-'));
  process.env.TANGU_HOME = dir;
});
afterEach(() => {
  if (prevHome === undefined) delete process.env.TANGU_HOME;
  else process.env.TANGU_HOME = prevHome;
  rmSync(dir, { recursive: true, force: true });
});

describe('config.json 唯一真源', () => {
  it('无文件:configExists=false / loadRawConfig=null / getRawSection=undefined', () => {
    expect(configExists()).toBe(false);
    expect(loadRawConfig()).toBeNull();
    expect(getRawSection('mcp')).toBeUndefined();
  });

  it('saveSection 往返且保留其他段', () => {
    saveSection('mcp', { mcpServers: { a: { command: 'x' } } });
    saveSection('cloud', { url: 'u', token: 't', defaultModel: 'm' });
    expect(getRawSection('mcp')).toEqual({ mcpServers: { a: { command: 'x' } } });
    expect(getRawSection('cloud')).toEqual({ url: 'u', token: 't', defaultModel: 'm' });
    expect(configExists()).toBe(true);
  });

  it('migrate:遗留 JSON → config.json 各段,旧文件 → .bak', () => {
    writeFileSync(join(dir, 'auth.json'), JSON.stringify({ cloudUrl: 'C', token: 'T', model: 'M' }));
    writeFileSync(join(dir, 'providers.json'), JSON.stringify([{ providerId: 'ollama', baseUrl: 'http://x/v1' }]));
    writeFileSync(join(dir, 'mcp.json'), JSON.stringify({ mcpServers: { s1: { url: 'http://m' } } }));
    writeFileSync(join(dir, 'special-agents.json'), JSON.stringify({ historian: { enabled: true, modelId: 'gm' } }));
    migrateLegacyConfig();
    expect(getRawSection('cloud')).toEqual({ url: 'C', token: 'T', defaultModel: 'M' });
    expect(getRawSection('providers')).toEqual([{ providerId: 'ollama', baseUrl: 'http://x/v1' }]);
    expect(getRawSection('mcp')).toEqual({ mcpServers: { s1: { url: 'http://m' } } });
    expect((getRawSection('specialAgents') as any).historian.modelId).toBe('gm');
    // 旧文件改名为 .bak(可恢复,不删)
    expect(existsSync(join(dir, 'auth.json'))).toBe(false);
    expect(existsSync(join(dir, 'auth.json.bak'))).toBe(true);
    expect(existsSync(join(dir, 'mcp.json.bak'))).toBe(true);
  });

  it('migrate 幂等:config.json 已存在则跳过,不动遗留文件', () => {
    saveSection('cloud', { url: 'pre' });
    writeFileSync(join(dir, 'mcp.json'), JSON.stringify({ mcpServers: { z: {} } }));
    migrateLegacyConfig();
    expect((getRawSection('cloud') as any).url).toBe('pre');
    expect(getRawSection('mcp')).toBeUndefined(); // 未迁移
    expect(existsSync(join(dir, 'mcp.json'))).toBe(true); // 未 .bak
  });

  it('全新安装(无任何遗留)→ 不落空 config.json', () => {
    migrateLegacyConfig();
    expect(configExists()).toBe(false);
  });

  it('A4 接线:loadMcpConfig 优先读 config.json 的 mcp 段', () => {
    saveSection('mcp', { mcpServers: { x: { command: 'c' } } });
    expect(loadMcpConfig().mcpServers).toEqual({ x: { command: 'c' } });
  });
});
