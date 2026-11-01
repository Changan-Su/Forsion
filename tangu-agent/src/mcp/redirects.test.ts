import { afterEach, describe, expect, it, vi } from 'vitest';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import { ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { createMcpManager } from './manager.js';
import { sameOriginFetch } from './sameOriginFetch.js';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of cleanups.splice(0).reverse()) await close(); vi.restoreAllMocks(); });
async function serve(handler: (req: IncomingMessage, res: ServerResponse) => void) {
  const server = createServer(handler);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  cleanups.push(async () => { server.closeAllConnections(); await new Promise<void>((r) => server.close(() => r())); });
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}
const credentials = { 'X-API-Key': 'SYNTHETIC_KEY', 'Mcp-Session-Id': 'SYNTHETIC_SESSION' };

describe('remote MCP trust boundary with the real SDK', () => {
  it.each(['http', 'sse'] as const)('%s manager never dispatches cross-origin redirects', async (transport) => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    let received = 0;
    const destination = await serve((_req, res) => { received++; res.end('must not arrive'); });
    for (const status of [301, 302, 303, 307, 308]) {
      const source = await serve((_req, res) => { res.writeHead(status, { location: destination }); res.end(); });
      const dir = mkdtempSync(join(tmpdir(), 'mcp-redirect-'));
      const file = join(dir, 'mcp.json');
      writeFileSync(file, JSON.stringify({ mcpServers: { audit: { transport, url: source, headers: credentials } } }));
      const manager = createMcpManager(file, { connectTimeoutMs: 2000, retryBaseMs: 600_000, reconnectCooldownMs: 600_000 });
      try { await manager.start(); expect(manager.toolsForRun().size).toBe(0); }
      finally { await manager.dispose(); rmSync(dir, { recursive: true, force: true }); }
    }
    expect(received).toBe(0);
  });
  it('SSE endpoint events cannot move POST credentials to another origin', async () => {
    let received = 0;
    const destination = await serve((_req, res) => { received++; res.end(); });
    const source = await serve((_req, res) => { res.writeHead(200, { 'content-type': 'text/event-stream' }); res.write(`event: endpoint\ndata: ${destination}/messages\n\n`); });
    const transport = new SSEClientTransport(new URL(source), { fetch: sameOriginFetch(new URL(source)), requestInit: { headers: credentials } });
    const client = new Client({ name: 'audit', version: '1' });
    try { await expect(client.connect(transport)).rejects.toThrow(); expect(received).toBe(0); }
    finally { await client.close(); }
  });
  it('same-origin SSE redirect, endpoint and tool discovery work with configured headers', async () => {
    const server = new Server({ name: 'audit', version: '1' }, { capabilities: { tools: {} } });
    server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [{ name: 'echo', inputSchema: { type: 'object' } }] }));
    let sse: SSEServerTransport;
    const headers: Array<IncomingMessage['headers']> = [];
    const origin = await serve(async (req, res) => {
      headers.push(req.headers);
      if (req.url === '/redirect') { res.writeHead(307, { location: '/sse' }); res.end(); }
      else if (req.method === 'GET') { sse = new SSEServerTransport('/messages', res); await server.connect(sse); }
      else await sse.handlePostMessage(req, res);
    });
    const url = new URL(`${origin}/redirect`);
    const client = new Client({ name: 'audit', version: '1' });
    try {
      await client.connect(new SSEClientTransport(url, { fetch: sameOriginFetch(url), requestInit: { headers: credentials } }));
      expect((await client.listTools()).tools.map((t) => t.name)).toEqual(['echo']);
      expect(headers.length).toBeGreaterThan(2);
      expect(headers.every((h) => h['x-api-key'] === 'SYNTHETIC_KEY')).toBe(true);
    } finally { await client.close(); await server.close(); }
  });
  it.each([307, 308])('same-origin %i replays the actual POST body only within the configured origin', async (status) => {
    const seen: Array<{ body: string; session?: string | string[] }> = [];
    const origin = await serve(async (req, res) => {
      let body = ''; for await (const chunk of req) body += chunk;
      seen.push({ body, session: req.headers['mcp-session-id'] });
      if (req.url === '/a') res.writeHead(status, { location: '/b' });
      res.end('ok');
    });
    const response = await sameOriginFetch(new URL(origin))(`${origin}/a`, { method: 'POST', headers: credentials, body: 'SYNTHETIC_BODY' });
    expect(await response.text()).toBe('ok');
    expect(seen).toEqual([{ body: 'SYNTHETIC_BODY', session: 'SYNTHETIC_SESSION' }, { body: 'SYNTHETIC_BODY', session: 'SYNTHETIC_SESSION' }]);
  });
});
