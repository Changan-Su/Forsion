import { afterEach, describe, expect, it, vi } from 'vitest';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { executeCustomTool, type LoadedCustomTool } from './customTools.js';
import { executeTool } from './registry.js';
import { createTanguProfile } from '../profiles/tangu.js';
import type { ToolContext } from './toolTypes.js';

// Only the address-policy boundary is replaced. Real sockets, executor and registry run unchanged.
vi.mock('../core/util/urlSafety.js', async (original) => ({
  ...await original<typeof import('../core/util/urlSafety.js')>(),
  assertPublicHttpUrl: async (raw: string) => new URL(raw),
  resolvePublicHttpUrl: async (raw: string) => ({ url: new URL(raw), addresses: ['127.0.0.1'] }),
}));
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of cleanups.splice(0)) await close(); });
async function serve(handler: (req: IncomingMessage, res: ServerResponse) => void) {
  const server = createServer(handler);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  cleanups.push(async () => { server.closeAllConnections(); await new Promise<void>((r) => server.close(() => r())); });
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}
function tool(url: string, method = 'POST'): LoadedCustomTool {
  return { name: 'audit_http', executor: 'http', source: 'test',
    definition: { type: 'function', function: { name: 'audit_http', description: 'Audit', parameters: { type: 'object', properties: {} } } },
    http: { url, method, headers: { Authorization: 'Bearer SYNTHETIC_SECRET', Cookie: 'audit=SYNTHETIC_COOKIE', 'X-API-Key': 'SYNTHETIC_KEY' }, bodyTemplate: 'SYNTHETIC_BODY' } };
}
const ctx = (signal?: AbortSignal) => ({ userId: 'u', sessionId: 's', appId: 'tangu', signal });
function registry(t: LoadedCustomTool, signal?: AbortSignal) {
  const profile = createTanguProfile({ sandboxMode: 'none' });
  profile.toolLoadout.providers = [];
  return executeTool({ id: 'audit', type: 'function', function: { name: t.name, arguments: '{}' } }, {
    ...ctx(signal), cwd: process.cwd(), execMode: 'host', preset: 'coding', profile,
    hostSandbox: { mode: 'off', network: 'deny' }, customTools: new Map([[t.name, t]]),
  } as ToolContext);
}

describe('custom HTTP public executor / registry contracts', () => {
  it('custom registry uses the shared pinned DNS transport for a real POST', async () => {
    let seen = '';
    const origin = await serve(async (req, res) => {
      for await (const chunk of req) seen += chunk;
      res.end('PINNED_POST');
    });
    const result = await registry(tool(origin.replace('127.0.0.1', 'unresolvable.audit.invalid')));
    expect(result.isError).toBe(false);
    expect(result.result).toBe('PINNED_POST');
    expect(seen).toBe('SYNTHETIC_BODY');
  });
  it.each([301, 302, 303, 307, 308])('cross-origin %i sends no credentials or body to the destination', async (status) => {
    const received: unknown[] = [];
    const destination = await serve((req, res) => { received.push(req.headers); res.end('leaked'); });
    const source = await serve((_req, res) => { res.writeHead(status, { location: destination }); res.end(); });
    const result = await registry(tool(source));
    expect(received).toEqual([]);
    expect(result.isError).toBe(true);
  });
  it('pre-cancelled executor sends no request', async () => {
    let count = 0;
    const origin = await serve((_req, res) => { count++; res.end('written'); });
    const ac = new AbortController(); ac.abort();
    await executeCustomTool(tool(origin), {}, ctx(ac.signal)).catch(() => {});
    expect(count).toBe(0);
  });
  it.each([401, 403, 404, 429, 503])('HTTP %i is an actual registry error', async (status) => {
    let count = 0;
    const origin = await serve((_req, res) => { count++; res.writeHead(status); res.end('SYNTHETIC_FAILURE'); });
    const result = await registry(tool(origin));
    expect(count).toBe(1);
    expect(result.isError).toBe(true);
    expect(result.result).toContain(`HTTP ${status}`);
  });
  it('204 and explicitly allowed business status are successful, including empty bodies', async () => {
    const origin = await serve((req, res) => { res.writeHead(req.url === '/business' ? 404 : 204); res.end(); });
    expect((await registry(tool(origin))).isError).toBe(false);
    const t = tool(`${origin}/business`); t.http!.allowedStatuses = [404];
    expect((await registry(t)).isError).toBe(false);
  });
  it('cancelled write reports unknown outcome, does not retry or follow a late redirect', async () => {
    const ac = new AbortController();
    let count = 0;
    let next = 0;
    const destination = await serve((_req, res) => { next++; res.end(); });
    const origin = await serve(async (req, res) => {
      for await (const _ of req) { /* consume the actual write */ }
      count++;
      ac.abort(); // service may have committed; cancellation cannot undo it
      setTimeout(() => { res.writeHead(307, { location: destination }); res.end(); }, 60);
    });
    const result = await registry(tool(origin), ac.signal);
    expect(count).toBe(1);
    expect(next).toBe(0);
    expect(result.isError).toBe(true);
    expect(result.result).toMatch(/Upstream outcome unknown.*may have completed/);
  });
});
