/**
 * 远端 MCP 的 OAuth 登录(连接器方案 2026-10-23 第一步)× 真 SDK:假 MCP server(要 Bearer)+ 另一个源上的假授权服务器。
 * 钉的是:401 → 待登录且不重试、登录走 DCR / 预注册 + PKCE + resource、令牌 0600 只存本机、配置头不发到授权服务器、
 * 过期只刷一次(并发共用,跨条目)、刷不成回到待登录、断开删令牌(在途刷新写不回来)、按 URL 绑定、C4 读拒绝;
 * 以及 Codex 评审的六条:明文远端不带令牌、刷新不在后台登记 client、列工具才 401 也进待登录、卡住的登录能被中止。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, statSync } from 'node:fs';
import { createServer as createNet } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createMcpManager, type McpManager } from './manager.js';
import type { LoadedMcpTool } from './toolBridge.js';
import { hasTokens, withBearer, loginServer } from './oauth.js';
import { connectorAuthFile } from '../core/tanguHome.js';
import { checkReadPath } from '../tools/fsPolicy.js';
import { startHttpServer } from '../../test/fixtures/fake-mcp-server.mjs';
import { startOAuthServer, browse } from '../../test/fixtures/fake-oauth-server.mjs';

const FAST = { reconnectCooldownMs: 0, retryBaseMs: 50, retryMaxMs: 200, connectTimeoutMs: 10_000 };
let dir: string;
let port: number;
const prev = { home: process.env.TANGU_HOME, port: process.env.TANGU_MCP_OAUTH_PORT };
const managers: McpManager[] = [];
const stops: Array<() => Promise<void>> = [];

async function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const s = createNet();
    s.listen(0, '127.0.0.1', () => { const p = (s.address() as any).port; s.close(() => resolve(p)); });
  });
}
beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'tangu-mcp-oauth-'));
  process.env.TANGU_HOME = dir;
  port = await freePort();
  process.env.TANGU_MCP_OAUTH_PORT = String(port);
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'log').mockImplementation(() => {});
});
afterEach(async () => {
  for (const m of managers.splice(0)) await m.dispose();
  for (const s of stops.splice(0)) await s().catch(() => {});
  for (const [k, v] of [['TANGU_HOME', prev.home], ['TANGU_MCP_OAUTH_PORT', prev.port]] as const) {
    if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }
  rmSync(dir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

async function setup(entries: (mcpUrl: string) => Record<string, unknown>, asOpts = {}, opts: { open?: (body: any) => boolean } = {}) {
  const as = await startOAuthServer(asOpts);
  stops.push(() => as.stop());
  const hits = { unauthorized: 0 };
  const mcp = await startHttpServer({ tag: 'h', auth: { isValid: (t: string | null, body?: any) => (t !== null && as.access.has(t)) || !!opts.open?.(body), authServer: as.url, onUnauthorized: () => { hits.unauthorized++; } } });
  stops.push(() => mcp.stop());
  const file = join(dir, 'mcp.json');
  writeFileSync(file, JSON.stringify({ mcpServers: entries(mcp.url) }));
  const m = createMcpManager(file, FAST);
  managers.push(m);
  await m.start();
  return { as, mcp, m, hits };
}
const statusOf = (m: McpManager, name = 'h') => m.listStatus().find((s) => s.name === name)!;
async function waitFor(fn: () => boolean, ms = 5000): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (fn()) return true; await new Promise((r) => setTimeout(r, 25)); }
  return fn();
}
async function signIn(m: McpManager, name = 'h') {
  const { url } = await m.login(name);
  expect(await browse(url!)).toBe(200);
  expect(await waitFor(() => statusOf(m, name).status === 'connected')).toBe(true);
}
const stub = (name = 'h'): LoadedMcpTool => ({ name: `mcp__${name}__echo`, serverName: name, remoteName: 'echo' } as LoadedMcpTool);
const inner = (fenced: string) => fenced.split('\n').slice(2, -1).join('\n');

describe('MCP OAuth', () => {
  it('401 → 待登录:不后台重试、不碰授权服务器,调用回一句去设置里登录', async () => {
    const { as, m, hits } = await setup((url) => ({ h: { url } }));
    expect(statusOf(m).status).toBe('needs-login');
    const seen = hits.unauthorized;
    await new Promise((r) => setTimeout(r, 400)); // FAST 退避 50ms:真排了重试这会儿早连过好几回
    expect(statusOf(m).status).toBe('needs-login');
    expect(hits.unauthorized).toBe(seen);
    expect(as.seen).toEqual([]); // 连接时不做发现 / 登记
    const r = await m.callTool(stub(), { text: 'x' });
    expect(r.isError).toBe(true);
    expect(r.text).toContain('needs the user to sign in');
    expect(hits.unauthorized).toBe(seen); // 调用也不懒重连
    expect(m.toolsForRun().size).toBe(0);
  }, 20_000);

  it('登录:DCR + PKCE S256 + resource + state;令牌 0600 只在本机;配置头不发到授权服务器;连上后工具可用', async () => {
    const { as, mcp, m } = await setup((url) => ({ h: { url, headers: { 'x-secret': 'stay-on-mcp-origin' } } }));
    const { url } = await m.login('h');
    expect(url).toContain(`${as.url}/authorize`);
    expect(statusOf(m).status).toBe('logging-in');
    expect((await m.login('h')).url).toBe(url); // 再点一次 = 重开同一个授权页
    expect(await browse(url!)).toBe(200);
    expect(await waitFor(() => statusOf(m).status === 'connected')).toBe(true);
    const q = as.authorize[0];
    expect(q.get('client_id')).toBe('dyn-client');
    expect(q.get('code_challenge_method')).toBe('S256');
    expect(q.get('resource')).toBe(mcp.url);
    expect(q.get('redirect_uri')).toBe(`http://127.0.0.1:${port}/mcp/callback`);
    const tokenReq = as.seen.find((s) => s.path === '/token')!;
    expect(new URLSearchParams(tokenReq.body).get('resource')).toBe(mcp.url);
    expect(as.seen.some((s) => 'x-secret' in s.headers)).toBe(false);
    if (process.platform !== 'win32') expect(statSync(connectorAuthFile()).mode & 0o777).toBe(0o600);
    expect(readFileSync(connectorAuthFile(), 'utf8')).toContain('at-');
    expect(statusOf(m).signedIn).toBe(true);
    const echo = m.toolsForRun().get('mcp__h__echo')!;
    expect(inner((await m.callTool(echo, { text: 'a' })).text)).toBe('h:a');
  }, 20_000);

  it('令牌过期:并发两次调用只刷新一次,刷完重发成功', async () => {
    const { as, m } = await setup((url) => ({ h: { url } }));
    await signIn(m);
    const echo = m.toolsForRun().get('mcp__h__echo')!;
    as.access.clear();
    const [a, b] = await Promise.all([m.callTool(echo, { text: '1' }), m.callTool(echo, { text: '2' })]);
    expect([inner(a.text), inner(b.text)]).toEqual(['h:1', 'h:2']);
    expect(as.refreshes).toBe(1);
    expect(statusOf(m).status).toBe('connected');
  }, 20_000);

  it('刷新被拒:回到待登录、令牌删掉、不重试', async () => {
    const { as, m } = await setup((url) => ({ h: { url } }));
    await signIn(m);
    const echo = m.toolsForRun().get('mcp__h__echo')!;
    as.access.clear();
    as.failRefresh = true;
    const r = await m.callTool(echo, { text: 'x' });
    expect(r.text).toContain('needs the user to sign in');
    expect(statusOf(m).status).toBe('needs-login');
    expect(statusOf(m).signedIn).toBeUndefined();
    const refreshes = as.refreshes;
    await new Promise((res) => setTimeout(res, 400));
    expect(statusOf(m).status).toBe('needs-login');
    expect(as.refreshes).toBe(refreshes);
  }, 20_000);

  it('断开:删掉本机令牌,置待登录;按 URL 绑定 —— 同一 server 换个地址不带旧令牌', async () => {
    const { m } = await setup((url) => ({ h: { url }, h2: { url: `${url}?v=2` } }));
    await signIn(m);
    expect(statusOf(m, 'h2').status).toBe('needs-login');
    await m.logout('h');
    expect(statusOf(m).status).toBe('needs-login');
    expect(statusOf(m).signedIn).toBeUndefined();
    expect((await m.callTool(stub(), { text: 'x' })).text).toContain('needs the user to sign in');
  }, 20_000);

  it('等回调期间改了这条配置:登录完成后,同一地址的新条目照样连上', async () => {
    const { mcp, m } = await setup((url) => ({ h: { url } }));
    const { url } = await m.login('h');
    writeFileSync(join(dir, 'mcp.json'), JSON.stringify({ mcpServers: { h: { url: mcp.url, timeoutMs: 5000 } } }));
    await m.reloadConfig();
    expect(await waitFor(() => statusOf(m).status === 'needs-login')).toBe(true);
    expect(await browse(url!)).toBe(200);
    expect(await waitFor(() => statusOf(m).status === 'connected')).toBe(true);
  }, 20_000);

  it('预注册 client:不走 DCR;授权服务器不开 DCR 又没写 clientId → 说清楚要填什么', async () => {
    const { as, m } = await setup((url) => ({ h: { url, oauth: { clientId: 'pre-1', scopes: ['read'] } }, n: { url: `${url}?n` } }), { dcr: false });
    await signIn(m);
    expect(as.authorize[0].get('client_id')).toBe('pre-1');
    expect(as.authorize[0].get('scope')).toBe('read');
    expect(as.seen.some((s) => s.path === '/register')).toBe(false);
    await expect(m.login('n')).rejects.toThrow(/oauth.*clientId/);
    expect(statusOf(m, 'n').status).toBe('needs-login');
  }, 20_000);

  it('C4:connector-auth.json 对读工具硬拒;stdio server 不能登录', async () => {
    writeFileSync(connectorAuthFile(), '{}');
    expect(checkReadPath(connectorAuthFile()).ok).toBe(false);
    expect(hasTokens('http://127.0.0.1:1/mcp')).toBe(false);
    const { m } = await setup(() => ({ s: { command: process.execPath, args: ['-e', ''] } }));
    await expect(m.login('s')).rejects.toThrow(/not a remote MCP server/);
  }, 20_000);
});

describe('MCP OAuth · 评审回归', () => {
  it('明文 http 的远端(非本机):不带令牌、不触发待登录;登录直接拒', async () => {
    const url = 'http://10.1.2.3/mcp';
    writeFileSync(connectorAuthFile(), JSON.stringify({ [url]: { tokens: { access_token: 'must-not-leak', token_type: 'Bearer', refresh_token: 'r' } } }));
    const sent: Array<string | null> = [];
    let asked = 0;
    const f = withBearer(async (input, init) => { sent.push(new Request(input, init).headers.get('authorization')); return new Response('', { status: 401 }); }, url, undefined, () => { asked++; });
    expect((await f(url, { method: 'POST', body: '{}' })).status).toBe(401);
    expect(sent).toEqual([null]);
    expect(asked).toBe(0);
    await expect(loginServer(url, undefined, undefined, () => {})).rejects.toThrow(/HTTPS/);
  });

  it('刷新在路上时断开:刷新回来写不回令牌', async () => {
    const { as, mcp, m } = await setup((url) => ({ h: { url } }));
    await signIn(m);
    const echo = m.toolsForRun().get('mcp__h__echo')!;
    as.access.clear();
    as.refreshDelayMs = 400;
    const call = m.callTool(echo, { text: 'x' });
    expect(await waitFor(() => as.refreshes === 1)).toBe(true);
    await m.logout('h');
    await call;
    expect(await waitFor(() => as.access.size === 1)).toBe(true); // 授权服务器已经发出新令牌(刷新回来了)
    await new Promise((r) => setTimeout(r, 150));
    expect(hasTokens(mcp.url)).toBe(false);
    expect(statusOf(m).status).toBe('needs-login');
  }, 20_000);

  it('两个条目同一地址:登录一次两个都连上;并发过期只刷新一次', async () => {
    const { as, m } = await setup((url) => ({ h: { url }, h2: { url } }));
    await signIn(m);
    expect(await waitFor(() => statusOf(m, 'h2').status === 'connected')).toBe(true);
    const tools = m.toolsForRun();
    as.access.clear();
    const [a, b] = await Promise.all([m.callTool(tools.get('mcp__h__echo')!, { text: '1' }), m.callTool(tools.get('mcp__h2__echo')!, { text: '2' })]);
    expect([inner(a.text), inner(b.text)]).toEqual(['h:1', 'h:2']);
    expect(as.refreshes).toBe(1);
  }, 20_000);

  it('刷新回 invalid_client:不在后台重新发现 / 登记 client,回到待登录', async () => {
    const { as, m } = await setup((url) => ({ h: { url } }));
    await signIn(m);
    const echo = m.toolsForRun().get('mcp__h__echo')!;
    as.access.clear();
    as.failRefresh = true;
    as.refreshError = 'invalid_client';
    const before = as.seen.length;
    expect((await m.callTool(echo, { text: 'x' })).text).toContain('needs the user to sign in');
    expect(as.seen.slice(before).map((r) => r.path)).toEqual(['/token']);
    expect(statusOf(m).status).toBe('needs-login');
  }, 20_000);

  it('初始化放行、列工具才 401:不显示已连接,进待登录', async () => {
    const open = (body: any) => ['initialize', 'notifications/initialized'].includes(body?.method);
    const { m } = await setup((url) => ({ h: { url } }), {}, { open });
    expect(await waitFor(() => statusOf(m).status === 'needs-login')).toBe(true);
    await new Promise((r) => setTimeout(r, 200));
    expect(statusOf(m).status).toBe('needs-login');
    expect(m.toolsForRun().size).toBe(0);
  }, 20_000);

  it('登录卡在授权服务器:引擎退出时中止,回环端口与「登录中」都放掉', async () => {
    const { as, m } = await setup((url) => ({ h: { url } }), {});
    as.stall = true;
    const pending = m.login('h');
    expect(await waitFor(() => as.seen.some((r) => r.path === '/.well-known/oauth-authorization-server'))).toBe(true);
    const t0 = Date.now();
    await m.dispose();
    await expect(pending).rejects.toThrow(/cancelled/);
    expect(Date.now() - t0).toBeLessThan(3000);
    const ac = new AbortController();
    const again = loginServer(`${as.url}/x`, undefined, undefined, () => {}, ac.signal); // 不报「另一个登录进行中」
    ac.abort();
    await expect(again).rejects.toThrow(/cancelled/);
  }, 20_000);
});
