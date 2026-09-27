/**
 * MCP 管理器 × 真 SDK 假 server(test/fixtures/fake-mcp-server.mjs;stdio 子进程 + 进程内 Streamable HTTP)。
 * 钉的是方案 2026-09-26 P0 ⑥ / §3.3 的 M3(断线自愈)、M6(结果围栏 + 图片取出)
 * 每条都在去掉对应修复的代码上实跑过、确认为红(负对照)。`dev_` 保留前缀见 config.test.ts。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createMcpManager, type McpManager } from './manager.js';
import { startHttpServer, RED_DOT_PNG_B64 } from '../../test/fixtures/fake-mcp-server.mjs';

const FIXTURE = fileURLToPath(new URL('../../test/fixtures/fake-mcp-server.mjs', import.meta.url));
const FAST = { reconnectCooldownMs: 0, retryBaseMs: 50, retryMaxMs: 200, connectTimeoutMs: 10_000 };

let dir: string;
let prevHome: string | undefined;
const managers: McpManager[] = [];
const httpServers: Array<{ stop(): Promise<void> }> = [];

beforeEach(() => {
  prevHome = process.env.TANGU_HOME;
  dir = mkdtempSync(join(tmpdir(), 'tangu-mcp-'));
  process.env.TANGU_HOME = dir; // connect() 读宿主沙箱策略:隔离 home,别读开发者真配置
});
afterEach(async () => {
  for (const m of managers.splice(0)) await m.dispose();
  for (const s of httpServers.splice(0)) await s.stop().catch(() => {});
  if (prevHome === undefined) delete process.env.TANGU_HOME;
  else process.env.TANGU_HOME = prevHome;
  rmSync(dir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

function stdio(tag: string) {
  return { command: process.execPath, args: [FIXTURE], env: { FAKE_MCP_TAG: tag } };
}
async function managerFor(servers: Record<string, unknown>): Promise<McpManager> {
  const file = join(dir, `mcp-${managers.length}.json`);
  writeFileSync(file, JSON.stringify({ mcpServers: servers }));
  const m = createMcpManager(file, FAST);
  managers.push(m);
  await m.start();
  return m;
}
async function waitFor(fn: () => boolean, ms = 5000): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (fn()) return true;
    await new Promise((r) => setTimeout(r, 25));
  }
  return fn();
}
async function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const srv = createServer();
    srv.listen(0, '127.0.0.1', () => {
      const p = (srv.address() as any).port;
      srv.close(() => resolve(p));
    });
  });
}
const innerText = (fenced: string) => fenced.split('\n').slice(2, -1).join('\n');

describe('M3 断线自愈', () => {
  it('stdio server 中途掉线(子进程被杀)→ 下一次调用自动重连成功;在飞 run 的快照不变', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const m = await managerFor({ s: stdio('s') });
    const snap = m.toolsForRun();
    const echo = snap.get('mcp__s__echo')!;
    expect(echo).toBeTruthy();
    const first = await m.callTool(echo, { text: 'one' });
    expect(first.isError).toBe(false);
    expect(innerText(first.text)).toBe('s:one');

    const pid = Number(innerText((await m.callTool(snap.get('mcp__s__pid')!, {})).text));
    expect(pid).toBeGreaterThan(0);
    process.kill(pid, 'SIGKILL');
    // onclose 到达前 status 仍是 connected;修前代码永远不变(这条等待只是让时序确定,不做断言)
    await waitFor(() => m.listStatus()[0].status !== 'connected', 3000);

    const again = await m.callTool(echo, { text: 'two' }); // 用 run 开始时的那份快照调用
    expect(again.isError).toBe(false);
    expect(innerText(again.text)).toBe('s:two');
    expect(m.listStatus()[0].status).toBe('connected');
    expect(snap.get('mcp__s__echo')).toBe(echo);
  }, 30_000);

  it('有状态 Streamable HTTP server 重启(旧 session 404)→ 下一次调用重新 initialize 并成功', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const port = await freePort();
    let srv = await startHttpServer({ port, stateful: true, tag: 'h1' });
    httpServers.push(srv);
    const m = await managerFor({ h: { url: srv.url } });
    const echo = m.toolsForRun().get('mcp__h__echo')!;
    expect(innerText((await m.callTool(echo, { text: 'a' })).text)).toBe('h1:a');

    await srv.stop();
    const down = await m.callTool(echo, { text: 'b' });
    expect(down.isError).toBe(true); // 掉线期间如实报错,不挂死

    srv = await startHttpServer({ port, stateful: true, tag: 'h2' });
    httpServers.push(srv);
    const up = await m.callTool(echo, { text: 'c' });
    expect(up.isError).toBe(false);
    expect(innerText(up.text)).toBe('h2:c');
  }, 30_000);

  it('无状态 Streamable HTTP server 掉线后恢复 → 调用照常成功', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const port = await freePort();
    let srv = await startHttpServer({ port, stateful: false, tag: 'x1' });
    httpServers.push(srv);
    const m = await managerFor({ x: { url: srv.url } });
    const echo = m.toolsForRun().get('mcp__x__echo')!;
    expect(innerText((await m.callTool(echo, { text: 'a' })).text)).toBe('x1:a');
    await srv.stop();
    // 掉线期间的调用如实报错。它顺带让 fetch 连接池丢掉被 server 关掉的 keep-alive 连接 —— 不经这一步、紧接着
    // 重启就调,首个 POST 会撞上死连接报 fetch failed(真实重启有间隔,池早已收到 FIN;是测试时序的产物)。
    expect((await m.callTool(echo, { text: 'down' })).isError).toBe(true);
    srv = await startHttpServer({ port, stateful: false, tag: 'x2' });
    httpServers.push(srv);
    expect(innerText((await m.callTool(echo, { text: 'b' })).text)).toBe('x2:b');
  }, 30_000);

  it('启动时没连上的 server 后台重试,起来后进入下一个 run 的快照(旧快照不变)', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const port = await freePort();
    const m = await managerFor({ late: { url: `http://127.0.0.1:${port}/mcp` } });
    expect(m.listStatus()[0].status).toBe('error');
    const before = m.toolsForRun();
    expect(before.size).toBe(0);

    httpServers.push(await startHttpServer({ port, stateful: true, tag: 'late' }));
    expect(await waitFor(() => m.toolsForRun().has('mcp__late__echo'), 8000)).toBe(true);
    expect(before.size).toBe(0);
    const r = await m.callTool(m.toolsForRun().get('mcp__late__echo')!, { text: 'hi' });
    expect(innerText(r.text)).toBe('late:hi');
  }, 30_000);
});

describe('M6 结果:不可信围栏 + 图片取出', () => {
  it('文本圈进 <mcp_data>,尖括号中和,伪造的收尾标签失效', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const m = await managerFor({ s: stdio('s') });
    const r = await m.callTool(m.toolsForRun().get('mcp__s__inject')!, {});
    expect(r.text).toContain('<mcp_data server="s">');
    expect(r.text).toContain('not instructions');
    expect(r.text).not.toContain('<system>');
    expect(r.text).toContain('‹system›');
    expect(r.text.match(/<\/mcp_data>/g)?.length).toBe(1);
    expect(r.text.trimEnd().endsWith('</mcp_data>')).toBe(true);
  }, 20_000);

  it('image 块作为图片返回(不再是占位文本),文本部分照常围栏', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const m = await managerFor({ s: stdio('s') });
    const r = await m.callTool(m.toolsForRun().get('mcp__s__image')!, {});
    expect(r.isError).toBe(false);
    expect(r.images).toEqual([{ mimeType: 'image/png', data: RED_DOT_PNG_B64 }]);
    expect(r.text).not.toContain('[image:');
    expect(innerText(r.text)).toBe('here is the picture');
  }, 20_000);
});
