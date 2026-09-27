/**
 * 设备 MCP 保留命名空间(方案 2026-09-26 §4.6-3):`mcp__dev_<alias>__<tool>` 留给引擎注入的设备 MCP,
 * mcp.json / 导入进来的第三方 server 不得占用(`dev_*`,以及恰好叫 `dev` 的 —— 桥成 `mcp__dev__…`,同样命中
 * `mcp__dev_*` 规则)。加载时跳过并告警(不改名:改名让导入判重失效、序号让身份漂移);磁盘原样。
 * 每条都在修复前的代码上实跑为红(负对照)。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createMcpManager } from './manager.js';
import { loadMcpConfig, mcpConfigFrom, rawMcpServersFrom, isReservedServerName } from './config.js';

const FIXTURE = fileURLToPath(new URL('../../test/fixtures/fake-mcp-server.mjs', import.meta.url));

let dir: string;
let prevHome: string | undefined;
beforeEach(() => {
  prevHome = process.env.TANGU_HOME;
  dir = mkdtempSync(join(tmpdir(), 'tangu-mcpcfg-'));
  process.env.TANGU_HOME = dir; // connect() 读宿主沙箱策略:隔离 home,别读开发者真配置
});
afterEach(() => {
  if (prevHome === undefined) delete process.env.TANGU_HOME;
  else process.env.TANGU_HOME = prevHome;
  rmSync(dir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe('dev_ 保留前缀(设备 MCP 命名空间)', () => {
  it('按桥接后的形态判,不分大小写;恰好叫 dev 的也保留', () => {
    for (const n of ['dev_phone', 'dev.x', 'DEV x', 'Dev_y', 'dev_', 'dev', 'DEV', 'Dev', 'dev.']) expect(isReservedServerName(n)).toBe(true);
    for (const n of ['devx', 'dev-x', 'my_dev_x', 'device', 'd_ev', 'de', 'user_dev_phone', ' dev']) expect(isReservedServerName(n)).toBe(false);
    // 不变式:没被保留的名字,桥接后绝不落进 `mcp__dev_*`
    for (const n of ['devx', 'dev-x', 'de', ' dev']) expect(`mcp__${n.replace(/[^a-zA-Z0-9_-]/g, '_')}__t`.toLowerCase().startsWith('mcp__dev_')).toBe(false);
  });

  it('加载时跳过保留名并告警,不改名、不生成 user_* 副本;磁盘视图原样', () => {
    const servers = { dev_phone: { url: 'http://a' }, 'dev.x': { url: 'http://b' }, dev: { url: 'http://e' }, user_dev_phone: { url: 'http://c' }, ok: { url: 'http://d' } };
    const file = join(dir, 'mcp.json');
    writeFileSync(file, JSON.stringify({ mcpServers: servers }));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(Object.keys(loadMcpConfig(file).mcpServers).sort()).toEqual(['ok', 'user_dev_phone']);
    expect(loadMcpConfig(file).mcpServers.user_dev_phone).toEqual({ url: 'http://c' });
    expect(Object.keys(mcpConfigFrom({ mcpServers: servers }).mcpServers).sort()).toEqual(['ok', 'user_dev_phone']);
    expect(rawMcpServersFrom({ mcpServers: servers })).toEqual(servers); // 读改写用这份:不能把用户的 server 从磁盘抹掉
    expect(warn.mock.calls.some((c) => String(c[0]).includes('"dev_phone" skipped') && String(c[0]).includes('reserved'))).toBe(true);
  });

  it('manager:保留名的 server 不连接,如实列成 error;别的 server 照常,工具名不落进 mcp__dev_*', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const evil = { command: process.execPath, args: [FIXTURE], env: { FAKE_MCP_TAG: 'evil' } };
    const file = join(dir, 'mcp-evil.json');
    writeFileSync(file, JSON.stringify({ mcpServers: { dev_phone: evil, dev: evil, ok: { ...evil, env: { FAKE_MCP_TAG: 'ok' } } } }));
    const m = createMcpManager(file);
    await m.start();
    try {
      const st = Object.fromEntries(m.listStatus().map((s) => [s.name, s]));
      expect(Object.keys(st).sort()).toEqual(['dev', 'dev_phone', 'ok']);
      for (const n of ['dev', 'dev_phone']) {
        expect(st[n].status).toBe('error');
        expect(st[n].error).toContain('reserved');
        expect(st[n].toolCount).toBe(0);
      }
      expect(st.ok.status).toBe('connected');
      const names = [...m.toolsForRun().keys()];
      expect(names.length).toBeGreaterThan(0);
      expect(names.every((n) => n.startsWith('mcp__ok__'))).toBe(true);
      expect(m.toolsForRun(['dev', 'dev_phone']).size).toBe(0);
    } finally {
      await m.dispose();
    }
  }, 20_000);
});
