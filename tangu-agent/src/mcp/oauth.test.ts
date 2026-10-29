/**
 * 远端 MCP 的 OAuth 登录(连接器方案 2026-10-23 第一步)× 真 SDK:假 MCP server(要 Bearer)+ 另一个源上的假授权服务器。
 * 钉的是:401 → 待登录且不重试、登录走 DCR / 预注册 + PKCE + resource、令牌 0600 只存本机、配置头不发到授权服务器、
 * 过期只刷一次(并发共用)、刷不成回到待登录、断开删令牌、按 URL 绑定、C4 读拒绝。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, statSync } from 'node:fs';
import { createServer as createNet } from 'node:net';
import { createServer as createHttp, type IncomingHttpHeaders } from 'node:http';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createMcpManager, type McpManager } from './manager.js';
import type { LoadedMcpTool } from './toolBridge.js';
import { hasTokens } from './oauth.js';
import { connectorAuthFile } from '../core/tanguHome.js';
import { checkReadPath } from '../tools/fsPolicy.js';
import { startHttpServer } from '../../test/fixtures/fake-mcp-server.mjs';

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

/** 假授权服务器:PKCE S256、DCR(可关)、授权码一次性、refresh_token 用一次就轮换。 */
async function startAs({ dcr = true } = {}) {
  const st = {
    url: '', access: new Set<string>(), refresh: new Set<string>(), n: 0, refreshes: 0, failRefresh: false,
    seen: [] as Array<{ path: string; headers: IncomingHttpHeaders; body: string }>,
    authorize: [] as URLSearchParams[],
    codes: new Map<string, { challenge: string | null; redirect: string | null }>(),
  };
  const issue = () => {
    const n = ++st.n;
    st.access.add(`at-${n}`);
    st.refresh.add(`rt-${n}`);
    return { access_token: `at-${n}`, refresh_token: `rt-${n}`, token_type: 'Bearer', expires_in: 3600 };
  };
  const srv = createHttp(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const body = Buffer.concat(chunks).toString();
    const u = new URL(req.url!, st.url);
    st.seen.push({ path: u.pathname, headers: req.headers, body });
    const json = (code: number, obj: unknown) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(obj)); };
    if (u.pathname === '/.well-known/oauth-authorization-server') {
      return json(200, {
        issuer: st.url, authorization_endpoint: `${st.url}/authorize`, token_endpoint: `${st.url}/token`,
        ...(dcr ? { registration_endpoint: `${st.url}/register` } : {}),
        response_types_supported: ['code'], grant_types_supported: ['authorization_code', 'refresh_token'],
        code_challenge_methods_supported: ['S256'], token_endpoint_auth_methods_supported: ['none'],
      });
    }
    if (u.pathname === '/register' && dcr) return json(201, { ...JSON.parse(body), client_id: 'dyn-client' });
    if (u.pathname === '/authorize') {
      st.authorize.push(u.searchParams);
      const code = `code-${++st.n}`;
      st.codes.set(code, { challenge: u.searchParams.get('code_challenge'), redirect: u.searchParams.get('redirect_uri') });
      res.writeHead(302, { location: `${u.searchParams.get('redirect_uri')}?code=${code}&state=${encodeURIComponent(u.searchParams.get('state') ?? '')}` });
      return res.end();
    }
    if (u.pathname === '/token') {
      const f = new URLSearchParams(body);
      if (f.get('grant_type') === 'authorization_code') {
        const c = st.codes.get(f.get('code') ?? '');
        st.codes.delete(f.get('code') ?? '');
        const pkce = c && createHash('sha256').update(f.get('code_verifier') ?? '').digest('base64url') === c.challenge;
        return pkce && f.get('redirect_uri') === c!.redirect ? json(200, issue()) : json(400, { error: 'invalid_grant' });
      }
      if (f.get('grant_type') === 'refresh_token') {
        st.refreshes++;
        const rt = f.get('refresh_token') ?? '';
        if (st.failRefresh || !st.refresh.delete(rt)) return json(400, { error: 'invalid_grant' });
        return json(200, issue());
      }
    }
    json(404, {});
  });
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', () => r()));
  st.url = `http://127.0.0.1:${(srv.address() as any).port}`;
  stops.push(async () => { srv.closeAllConnections(); await new Promise<void>((r) => srv.close(() => r())); });
  return st;
}
async function setup(entries: (mcpUrl: string) => Record<string, unknown>, asOpts = {}) {
  const as = await startAs(asOpts);
  const hits = { unauthorized: 0 };
  const mcp = await startHttpServer({ tag: 'h', auth: { isValid: (t: string) => as.access.has(t), authServer: as.url, onUnauthorized: () => { hits.unauthorized++; } } });
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
/** 「浏览器」:打开授权页(假授权服务器直接 302 回回环)→ 跟到回调。 */
async function browse(url: string): Promise<number> {
  const r = await fetch(url, { redirect: 'manual' });
  return (await fetch(r.headers.get('location')!)).status;
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
