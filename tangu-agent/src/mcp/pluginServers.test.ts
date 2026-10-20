/**
 * 插件自带的 MCP server:manifest 消毒、随插件加入 / 移出 manager、和用户 server 撞名时用户的赢。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createMcpManager, type McpManager } from './manager.js';
import { attachPluginMcp, bindPluginMcp, sanitizePluginMcpServers } from './pluginServers.js';

const FIXTURE = fileURLToPath(new URL('../../test/fixtures/fake-mcp-server.mjs', import.meta.url));
const FAST = { reconnectCooldownMs: 0, retryBaseMs: 50, retryMaxMs: 200, connectTimeoutMs: 20_000 };
const stdio = (tag: string) => ({ command: process.execPath, args: [FIXTURE], env: { FAKE_MCP_TAG: tag } });

let dir: string;
let prevHome: string | undefined;
const managers: McpManager[] = [];

beforeEach(() => {
  prevHome = process.env.TANGU_HOME;
  dir = mkdtempSync(join(tmpdir(), 'tangu-pmcp-'));
  process.env.TANGU_HOME = dir;
});
afterEach(async () => {
  bindPluginMcp(null);
  for (const m of managers.splice(0)) await m.dispose();
  if (prevHome === undefined) delete process.env.TANGU_HOME;
  else process.env.TANGU_HOME = prevHome;
  rmSync(dir, { recursive: true, force: true });
});

function manager(servers: Record<string, unknown>): McpManager {
  const file = join(dir, `mcp-${managers.length}.json`);
  writeFileSync(file, JSON.stringify({ mcpServers: servers }));
  const m = createMcpManager(file, FAST);
  managers.push(m);
  return m;
}
async function waitFor(fn: () => boolean, ms = 8000): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (fn()) return true;
    await new Promise((r) => setTimeout(r, 25));
  }
  return fn();
}
const toolNames = (m: McpManager) => [...m.toolsForRun().keys()].sort();

describe('sanitizePluginMcpServers', () => {
  it('只收 stdio;坏项逐条丢弃;${pluginDir} 展开;工作目录是插件目录;关着的不起', () => {
    const out = sanitizePluginMcpServers({
      ok: { command: 'node', args: ['${pluginDir}/server.js', 7], env: { ROOT: '${pluginDir}', 'bad key': 'x' } },
      web: { url: 'https://example.com/mcp', headers: { Authorization: 'x' } },
      sse: { command: 'node', transport: 'sse' },
      'bad name!': { command: 'node' },
      empty: {},
      off: { command: 'node', enabled: false },
    }, 'p', '/plug/dir');
    expect(Object.keys(out)).toEqual(['ok']);
    expect(out.ok).toEqual({ command: 'node', transport: 'stdio', args: ['/plug/dir/server.js'], env: { ROOT: '/plug/dir' }, cwd: '/plug/dir' });
    expect(sanitizePluginMcpServers(['x'], 'p', '/d')).toEqual({});
  });
});

describe('插件 server 随插件进出 manager', () => {
  it('加入后工具进下一个 run 的快照;和用户 server 撞名的不起;移出后消失,再加回来照常认领', async () => {
    const m = manager({ user: stdio('user') });
    await m.start();
    m.addServers({ id: 'p1', name: 'Plugin One' }, { plug: stdio('plug'), user: stdio('squat') });
    expect(await waitFor(() => m.listStatus().find((s) => s.name === 'plug')?.status === 'connected')).toBe(true);
    const plugRow = m.listStatus().find((s) => s.name === 'plug')!;
    expect(plugRow.origin).toEqual({ pluginId: 'p1', pluginName: 'Plugin One' });
    const squat = m.listStatus().filter((s) => s.name === 'user').find((s) => s.origin);
    expect(squat?.status).toBe('error'); // 用户那份照旧在跑,插件那份被拒
    expect(toolNames(m).some((n) => n.startsWith('mcp__plug__'))).toBe(true);
    const echo = m.toolsForRun().get('mcp__user__echo')!;
    expect((await m.callTool(echo, { text: 'hi' })).text).toContain('user:hi'); // 撞名没把调用串到插件那份

    await m.removeServers('p1');
    expect(m.listStatus().some((s) => s.origin)).toBe(false);
    expect(toolNames(m).some((n) => n.startsWith('mcp__plug__'))).toBe(false);
    expect(toolNames(m).some((n) => n.startsWith('mcp__user__'))).toBe(true);

    m.addServers({ id: 'p1', name: 'Plugin One' }, { plug: stdio('plug2') });
    expect(await waitFor(() => toolNames(m).includes('mcp__plug__echo'))).toBe(true);
    expect((await m.callTool(m.toolsForRun().get('mcp__plug__echo')!, { text: 'x' })).text).toContain('plug2:x');
  }, 30_000);

  it('start 之前到的插件 server 排队:用户 server 先占名', async () => {
    const m = manager({ shared: stdio('user') });
    m.addServers({ id: 'p2', name: 'P2' }, { shared: stdio('plugin') });
    await m.start();
    const rows = m.listStatus().filter((s) => s.name === 'shared');
    expect(rows.find((s) => !s.origin)?.status).toBe('connected');
    expect(rows.find((s) => s.origin)?.status).toBe('error');
  }, 30_000);

  it('名字归属:插件停用后同名不让给别的插件;用户配置里关着的也占名;原插件再加回来照认', async () => {
    const m = manager({ off: { ...stdio('u'), enabled: false } });
    await m.start();
    m.addServers({ id: 'pa', name: 'A' }, { shared: stdio('a') });
    expect(await waitFor(() => m.listStatus().find((s) => s.name === 'shared')?.status === 'connected')).toBe(true);
    await m.removeServers('pa');
    m.addServers({ id: 'pb', name: 'B' }, { shared: stdio('b'), off: stdio('b2') });
    expect(m.listStatus().filter((s) => s.origin?.pluginId === 'pb').map((s) => s.status)).toEqual(['error', 'error']);
    await m.removeServers('pb');
    m.addServers({ id: 'pa', name: 'A' }, { shared: stdio('a2') });
    expect(await waitFor(() => toolNames(m).includes('mcp__shared__echo'))).toBe(true);
  }, 30_000);

  it('dispose 等 removeServers 关完再返回(停用后马上退出不留子进程)', async () => {
    const m = manager({});
    await m.start();
    m.addServers({ id: 'pc', name: 'C' }, { c: stdio('c') });
    expect(await waitFor(() => m.listStatus().find((s) => s.name === 'c')?.status === 'connected')).toBe(true);
    let closed = false;
    void m.removeServers('pc').then(() => { closed = true; });
    await m.dispose();
    expect(closed).toBe(true);
  }, 30_000);

  it('attachPluginMcp:没绑 manager / 没声明 → 不做事;绑了 → 撤销函数移出', async () => {
    expect(attachPluginMcp('p3', 'P3', dir, { a: stdio('a') })).toBeUndefined();
    const m = manager({});
    await m.start();
    bindPluginMcp(m);
    expect(attachPluginMcp('p3', 'P3', dir, undefined)).toBeUndefined();
    const off = attachPluginMcp('p3', 'P3', dir, { a: stdio('a') })!;
    expect(await waitFor(() => m.listStatus().find((s) => s.name === 'a')?.status === 'connected')).toBe(true);
    off();
    expect(await waitFor(() => m.listStatus().length === 0)).toBe(true);
  }, 30_000);
});
