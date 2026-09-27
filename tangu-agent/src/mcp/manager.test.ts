/**
 * MCP 管理器 × 真 SDK 假 server(test/fixtures/fake-mcp-server.mjs;stdio 子进程 + 进程内 Streamable HTTP)。
 * 钉的是方案 2026-09-26 P0 ⑥ / §3.3 的 M3(断线自愈)、M4(跨 server 撞名拒绝)、M6(结果围栏 + 图片取出)
 * 每条都在去掉对应修复的代码上实跑过、确认为红(负对照)。`dev_` 保留前缀见 config.test.ts。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createMcpManager, sessionGone, type McpManager } from './manager.js';
import { StreamableHTTPError } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { startHttpServer, RED_DOT_PNG_B64 } from '../../test/fixtures/fake-mcp-server.mjs';

const FIXTURE = fileURLToPath(new URL('../../test/fixtures/fake-mcp-server.mjs', import.meta.url));
const FAST = { reconnectCooldownMs: 0, retryBaseMs: 50, retryMaxMs: 200, connectTimeoutMs: 20_000 };
/** 进程内 server 关停后让客户端连接池先处理完 FIN(真实重启有间隔;同进程紧接着调会撞上还没回收的 keep-alive 连接)。 */
const settle = () => new Promise((r) => setTimeout(r, 200));

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
    await settle();
    const down = await m.callTool(echo, { text: 'b' });
    expect(down.isError).toBe(true); // 掉线期间如实报错,不挂死

    srv = await startHttpServer({ port, stateful: true, tag: 'h2' });
    httpServers.push(srv);
    await settle();
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
    await settle();
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

describe('M3 边界', () => {
  it('session 失效判定只认分发前的拒绝:404 与 SDK 两句固定 400 文案,其余 400 不重发', () => {
    const e = (code: number, body: string) => new StreamableHTTPError(code, `Error POSTing to endpoint: ${body}`);
    const sdk = (message: string, id: unknown = null) => JSON.stringify({ jsonrpc: '2.0', error: { code: -32000, message }, id });
    expect(sessionGone(e(404, 'Session not found'), true)).toBe(true);
    expect(sessionGone(e(400, sdk('Bad Request: Server not initialized')), true)).toBe(true);
    expect(sessionGone(e(400, sdk('Bad Request: No valid session ID provided')), true)).toBe(true);
    expect(sessionGone(e(400, 'invalid session_name: already exists'), true)).toBe(false); // 可能是执行后才报的错
    expect(sessionGone(e(400, 'tool failed after write: Bad Request: Server not initialized'), true)).toBe(false); // 只是「含这句话」
    expect(sessionGone(e(400, sdk('Bad Request: Server not initialized', 7)), true)).toBe(false); // 针对某条请求的错误
    expect(sessionGone(e(400, sdk('Bad Request: Server not initialized, retrying')), true)).toBe(false);
    expect(sessionGone(e(500, 'Session not found'), true)).toBe(false);
    expect(sessionGone(e(404, 'Session not found'), false)).toBe(false); // 本来就没有 session
    expect(sessionGone(new Error('fetch failed'), true)).toBe(false);
  });

  it('dispose 时正在 initialize 的 stdio server 也被关掉:返回后不留子进程、不再重连', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const pidFile = join(dir, 'slow.pid');
    const file = join(dir, 'mcp-slow.json');
    writeFileSync(file, JSON.stringify({ mcpServers: { slow: {
      command: process.execPath, args: [FIXTURE], env: { FAKE_MCP_TAG: 'slow', FAKE_MCP_PIDFILE: pidFile, FAKE_MCP_INIT_DELAY_MS: '8000' },
    } } }));
    const m = createMcpManager(file, FAST);
    const started = m.start();
    expect(await waitFor(() => existsSync(pidFile), 8000)).toBe(true);
    const pid = Number(readFileSync(pidFile, 'utf8'));
    rmSync(pidFile);
    const t0 = Date.now();
    await m.dispose();
    // 关掉在飞的 initialize,而不是干等它 8s 后自己完成(SDK 的 stdio close 先给 2s 优雅退出再 SIGTERM,所以下限约 2s)
    expect(Date.now() - t0).toBeLessThan(5000);
    const alive = () => { try { process.kill(pid, 0); return true; } catch { return false; } };
    expect(await waitFor(() => !alive(), 1500)).toBe(true); // 先核子进程,再等 start 收尾
    await started;
    await new Promise((r) => setTimeout(r, 300));
    expect(existsSync(pidFile)).toBe(false); // 没有被后台重试重新拉起
  }, 30_000);
});

describe('M3 边界 · SSE', () => {
  it('SSE 流开了却不发 endpoint:dispose 不陪着干等连接超时', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { createServer: createHttp } = await import('node:http');
    let opened = false;
    const hang = createHttp((_req, res) => { opened = true; res.writeHead(200, { 'content-type': 'text/event-stream' }); res.write(': hi\n\n'); });
    await new Promise<void>((r) => hang.listen(0, '127.0.0.1', () => r()));
    httpServers.push({ stop: async () => { hang.closeAllConnections(); await new Promise<void>((r) => hang.close(() => r())); } });
    const file = join(dir, 'mcp-sse.json');
    writeFileSync(file, JSON.stringify({ mcpServers: { sse: { transport: 'sse', url: `http://127.0.0.1:${(hang.address() as any).port}/sse` } } }));
    const m = createMcpManager(file, { ...FAST, connectTimeoutMs: 20_000 });
    const started = m.start();
    expect(await waitFor(() => opened, 5000)).toBe(true);
    const t0 = Date.now();
    await m.dispose();
    expect(Date.now() - t0).toBeLessThan(8000); // 上限 5s,而不是等满 20s 的连接超时
    void started.catch(() => {});
  }, 30_000);
});

describe('M4 跨 server 撞名', () => {
  it('消毒后同名的两个 server:按名字典序先到先得,后到者拒绝并只告警一次', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const m = await managerFor({ a_b: stdio('B'), 'a.b': stdio('A') }); // 'a.b' < 'a_b'
    const tools = m.toolsForRun();
    const echo = tools.get('mcp__a_b__echo')!;
    expect(echo.serverName).toBe('a.b');
    expect(innerText((await m.callTool(echo, { text: 'x' })).text)).toBe('A:x');
    const collisions = () => warn.mock.calls.filter((c) => String(c[0]).includes('mcp__a_b__echo')).length;
    expect(collisions()).toBe(1);
    m.toolsForRun();
    expect(collisions()).toBe(1);
    // 只要后者的 run(前者被 enabledServerNames 滤掉)→ 后者照常可用
    expect(m.toolsForRun(['a_b']).get('mcp__a_b__echo')!.serverName).toBe('a_b');
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
