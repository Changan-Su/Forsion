import { describe, expect, it } from 'vitest';
import { createServer } from 'node:http';
import { LATEST_PROTOCOL_VERSION } from '@modelcontextprotocol/sdk/types.js';
import { createBridgeRelay, negotiate, OUT_OF_TURN_TEXT, RELAY_INSTRUCTIONS_MAX_BYTES } from './bridgeRelay.js';

const post = async (relay: { server: { url: string; headers: Array<{ name: string; value: string }> } }, body: unknown, auth = true) => {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (auth) for (const h of relay.server.headers) headers[h.name] = h.value;
  const r = await fetch(relay.server.url, { method: 'POST', headers, body: JSON.stringify(body) });
  return { status: r.status, body: r.status === 200 ? await r.json() : null };
};

describe('bridgeRelay', () => {
  it('答 initialize 时带上说明;令牌不对一律 403', async () => {
    const relay = await createBridgeRelay({ name: 'forsion', instructions: 'PERSONA-X' });
    try {
      const r = await post(relay, { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } });
      expect(r.body.result.instructions).toBe('PERSONA-X');
      expect(r.body.result.serverInfo.name).toBe('forsion');
      expect((await post(relay, { jsonrpc: '2.0', id: 2, method: 'ping' }, false)).status).toBe(403);
    } finally { await relay.close(); }
  });

  it('协议版本照 SDK 协商:认不得的(DSH 0.2.2 要 2026-07-28)回我们最新的', async () => {
    expect(negotiate('2025-06-18')).toBe('2025-06-18');
    expect(negotiate('2026-07-28')).toBe(LATEST_PROTOCOL_VERSION);
    expect(negotiate(undefined)).toBe(LATEST_PROTOCOL_VERSION);
    const relay = await createBridgeRelay({ name: 'forsion', instructions: '' });
    try { expect((await post(relay, { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2026-07-28' } })).body.result.protocolVersion).toBe(LATEST_PROTOCOL_VERSION); }
    finally { await relay.close(); }
  });

  it('身后的工具桥在协议层拒了(回的错误没有 id):换成这次请求的 id 回', async () => {
    const target = createServer((req, res) => { req.resume(); req.on('end', () => res.writeHead(400, { 'content-type': 'application/json' }).end(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32000, message: 'Bad Request: Unsupported protocol version' } }))); });
    await new Promise<void>((r) => target.listen(0, '127.0.0.1', r));
    const relay = await createBridgeRelay({ name: 'forsion', instructions: '' });
    try {
      relay.setTarget({ url: `http://127.0.0.1:${(target.address() as any).port}/mcp`, headers: [] });
      const r = await post(relay, { jsonrpc: '2.0', id: 7, method: 'tools/list' });
      expect(r.body).toMatchObject({ id: 7, error: { message: expect.stringContaining('Unsupported protocol version') } });
    } finally { await relay.close(); await new Promise((r) => target.close(r)); }
  });

  it('说明超过 DSH 收得下的上限就不建', async () => {
    await expect(createBridgeRelay({ name: 'forsion', instructions: 'x'.repeat(RELAY_INSTRUCTIONS_MAX_BYTES + 1) })).rejects.toThrow(/exceed/);
  });

  it('有这一轮的工具桥时转过去;没有时清单回上一次的、调用一律回绝', async () => {
    const seen: any[] = [];
    const target = createServer((req, res) => {
      let raw = ''; req.on('data', (d) => { raw += d; });
      req.on('end', () => {
        const msg = JSON.parse(raw); seen.push({ auth: req.headers.authorization, method: msg.method });
        const result = msg.method === 'tools/list' ? { tools: [{ name: 'remember', inputSchema: { type: 'object' } }] } : { content: [{ type: 'text', text: 'done' }] };
        res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result }));
      });
    });
    await new Promise<void>((r) => target.listen(0, '127.0.0.1', r));
    const url = `http://127.0.0.1:${(target.address() as any).port}/mcp`;
    const relay = await createBridgeRelay({ name: 'forsion', instructions: '' });
    try {
      relay.setTarget({ url, headers: [{ name: 'Authorization', value: 'Bearer run-token' }] });
      expect((await post(relay, { jsonrpc: '2.0', id: 1, method: 'tools/list' })).body.result.tools[0].name).toBe('remember');
      expect((await post(relay, { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'remember', arguments: {} } })).body.result.content[0].text).toBe('done');
      expect(seen.every((s) => s.auth === 'Bearer run-token')).toBe(true);
      relay.setTarget(null);
      expect((await post(relay, { jsonrpc: '2.0', id: 3, method: 'tools/list' })).body.result.tools[0].name).toBe('remember');
      const out = await post(relay, { jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'remember', arguments: {} } });
      expect(out.body.result).toMatchObject({ isError: true, content: [{ text: OUT_OF_TURN_TEXT }] });
      expect(seen.filter((s) => s.method === 'tools/call')).toHaveLength(1);
      expect((await post(relay, { jsonrpc: '2.0', method: 'notifications/initialized' })).status).toBe(202);
    } finally { await relay.close(); await new Promise((r) => target.close(r)); }
  });

  it('存下的工具清单在新接力上照样回', async () => {
    const relay = await createBridgeRelay({ name: 'forsion', instructions: 'P', tools: { tools: [{ name: 'log_event' }] } });
    try { expect((await post(relay, { jsonrpc: '2.0', id: 1, method: 'tools/list' })).body.result.tools[0].name).toBe('log_event'); }
    finally { await relay.close(); }
  });
});
