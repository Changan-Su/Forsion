/**
 * `dev_` server 名保留前缀(方案 2026-09-26 §4.6-3):`mcp__dev_<alias>__<tool>` 留给引擎注入的设备 MCP,
 * mcp.json / 导入进来的第三方 server 不得占用 —— 加载时告警并改名。去掉改名的代码上实跑为红(负对照)。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createMcpManager } from './manager.js';
import { loadMcpConfig, isReservedServerName } from './config.js';

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
  it('按桥接后的形态判,不分大小写', () => {
    for (const n of ['dev_phone', 'dev.x', 'DEV x', 'Dev_y', 'dev_']) expect(isReservedServerName(n)).toBe(true);
    for (const n of ['devx', 'dev-x', 'my_dev_x', 'device', 'd_ev']) expect(isReservedServerName(n)).toBe(false);
  });

  it('加载时改名为 user_<原名>、撞名加序号,非保留名原样保留', () => {
    const file = join(dir, 'mcp.json');
    writeFileSync(file, JSON.stringify({ mcpServers: {
      dev_phone: { url: 'http://a' }, 'dev.x': { url: 'http://b' }, user_dev_phone: { url: 'http://c' }, ok: { url: 'http://d' },
    } }));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { mcpServers } = loadMcpConfig(file);
    expect(Object.keys(mcpServers).sort()).toEqual(['ok', 'user_dev.x', 'user_dev_phone', 'user_dev_phone_2']);
    expect(mcpServers.user_dev_phone_2).toEqual({ url: 'http://a' }); // 已有的 user_dev_phone 原样不动
    expect(mcpServers['user_dev.x']).toEqual({ url: 'http://b' });
    expect(warn.mock.calls.some((c) => String(c[0]).includes('reserved'))).toBe(true);
  });

  it('manager 里不会出现占用保留前缀的 server / 工具名', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const file = join(dir, 'mcp-evil.json');
    writeFileSync(file, JSON.stringify({ mcpServers: { dev_phone: { command: process.execPath, args: [FIXTURE], env: { FAKE_MCP_TAG: 'evil' } } } }));
    const m = createMcpManager(file);
    await m.start();
    try {
      expect(m.listStatus().map((s) => s.name)).toEqual(['user_dev_phone']);
      const names = [...m.toolsForRun().keys()];
      expect(names.length).toBeGreaterThan(0);
      expect(names.every((n) => !n.toLowerCase().startsWith('mcp__dev_'))).toBe(true);
    } finally {
      await m.dispose();
    }
  }, 20_000);
});
