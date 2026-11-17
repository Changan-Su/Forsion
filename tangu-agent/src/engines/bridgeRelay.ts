/**
 * 常驻引擎上一场会话的「桥接力」(融合插件第 1 档):DSH 的会话一直开着,交给它的那座 MCP 桥就得比一轮活得久;
 * 而 Forsion 的工具桥(toolServer.ts)是一轮一座的(审批、卡片、中止都挂在那一轮的 run 上)。接力站在中间:
 *
 *  - 地址和令牌跟着这场 DSH 会话走,会话开着它就在。
 *  - `initialize` 由它自己答,并带上这个 Agent 的人设 / 记忆 / 技能目录(`instructions`)。DSH 的 MCP 客户端把它挂成这场
 *    会话系统提示里的一节;**只在连上时读一次**,所以说明变了要关掉会话重新接(residentAcp 按 key 判)。
 *  - Forsion 在跑这一轮时(setTarget),工具清单和调用原样转给这一轮的工具桥;没在跑时,清单回上一次的,调用一律回绝 ——
 *    那是工作台(DSH 自己的网页界面)里发的一轮,Forsion 这边没有这一轮可以弹审批卡、画卡片。
 *
 * 只听 127.0.0.1,每个请求核对令牌。
 */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { LATEST_PROTOCOL_VERSION, SUPPORTED_PROTOCOL_VERSIONS } from '@modelcontextprotocol/sdk/types.js';

/** DSH(dsh-mcp-client)收一座 MCP 服务的说明最多 32768 字节,超了这场会话直接建不起来(实测);它自己还要加一行标题。 */
export const RELAY_INSTRUCTIONS_MAX_BYTES = 32_000;

/** 工作台里发的那一轮调到 Forsion 的工具时回给模型的话。 */
export const OUT_OF_TURN_TEXT = 'This Forsion tool only runs in turns sent from Forsion. This turn was sent from the DSH workbench, so Forsion cannot ask the user for approval or show the result here. Tell the user to continue this in Forsion if they need it.';

export interface RelayTarget { url: string; headers: Array<{ name: string; value: string }> }

export interface BridgeRelay {
  /** 交给 DSH 的 MCP 服务描述(session/new、session/resume 的 mcpServers 里的一项)。 */
  server: { type: 'http'; name: string; url: string; headers: Array<{ name: string; value: string }> };
  /** 这一轮的工具桥;null = 没有 Forsion 的轮在跑。 */
  setTarget(target: RelayTarget | null): void;
  /** 上一次从这一轮的工具桥拿到的工具清单(存下来,下次没有 Forsion 的轮时也照它回)。 */
  lastTools(): unknown;
  close(): Promise<void>;
}

type Rpc = { jsonrpc?: string; id?: string | number | null; method?: string; params?: any };

/** 这座接力和它身后的工具桥用的是同一个 MCP SDK,协商结果两边都认。 */
export const negotiate = (requested: unknown): string =>
  typeof requested === 'string' && SUPPORTED_PROTOCOL_VERSIONS.includes(requested) ? requested : LATEST_PROTOCOL_VERSION;

const json = (res: ServerResponse, status: number, body?: unknown): void => {
  if (body === undefined) { res.writeHead(status).end(); return; }
  const text = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(text) }).end(text);
};

async function readBody(req: IncomingMessage, limit = 8 << 20): Promise<string> {
  let size = 0; const chunks: Buffer[] = [];
  for await (const c of req) { size += (c as Buffer).length; if (size > limit) throw new Error('body too large'); chunks.push(c as Buffer); }
  return Buffer.concat(chunks).toString('utf8');
}

export async function createBridgeRelay(opts: { name: string; instructions: string; tools?: unknown }): Promise<BridgeRelay> {
  if (Buffer.byteLength(opts.instructions) > RELAY_INSTRUCTIONS_MAX_BYTES) throw new Error(`bridge instructions exceed ${RELAY_INSTRUCTIONS_MAX_BYTES} bytes`);
  const token = randomBytes(32).toString('hex');
  const expected = Buffer.from(`Bearer ${token}`);
  let target: RelayTarget | null = null;
  // 上一次从工具桥拿到的清单:没有 Forsion 的轮在跑时 DSH 再来问(重连、清单变了的通知)照这个回,工具不会从会话里消失
  let lastTools: unknown = opts.tools && Array.isArray((opts.tools as any).tools) ? opts.tools : { tools: [] };
  const authorized = (h: unknown): boolean => {
    const got = Buffer.from(String(h || ''));
    return got.length === expected.length && timingSafeEqual(got, expected);
  };
  const forward = async (msg: Rpc, req: IncomingMessage): Promise<any> => {
    const t = target!;
    const headers: Record<string, string> = { 'content-type': 'application/json', accept: 'application/json, text/event-stream' };
    for (const h of t.headers) headers[h.name.toLowerCase()] = h.value;
    const pv = req.headers['mcp-protocol-version'];
    if (typeof pv === 'string') headers['mcp-protocol-version'] = pv;
    const r = await fetch(t.url, { method: 'POST', headers, body: JSON.stringify(msg) });
    if (msg.id === undefined || msg.id === null) return undefined; // 通知
    const text = await r.text();
    let reply: any;
    try { reply = JSON.parse(text); } catch { reply = null; }
    if (!reply || typeof reply !== 'object' || reply.id !== msg.id) {
      // 工具桥在协议层就拒了(版本头不对、令牌过期……),回的错误没有 id:换成这次请求的 id,不然对面一直等
      const why = typeof reply?.error?.message === 'string' ? reply.error.message : `HTTP ${r.status}`;
      return { jsonrpc: '2.0', id: msg.id, error: { code: -32603, message: `Forsion tool bridge refused the request: ${why}` } };
    }
    return reply;
  };
  const answer = async (msg: Rpc, req: IncomingMessage): Promise<any> => {
    const id = msg.id;
    const ok = (result: unknown) => ({ jsonrpc: '2.0', id, result });
    switch (msg.method) {
      case 'initialize':
        return ok({
          // 照 SDK 服务端的协商:认得的版本原样回,认不得的回我们最新的。不能照抄对方要的 —— DSH 0.2.2 要 2026-07-28,
          // 照抄了它之后每个请求都带这个版本头,转给这一轮的工具桥(同一个 SDK)就被拒,会话直接建不起来(实测)
          protocolVersion: negotiate(msg.params?.protocolVersion),
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: opts.name, version: '1.0.0' },
          ...(opts.instructions ? { instructions: opts.instructions } : {}),
        });
      case 'ping':
        return ok({});
      case 'tools/list': {
        if (!target) return ok(lastTools);
        const r = await forward(msg, req);
        if (r?.result && Array.isArray(r.result.tools)) lastTools = r.result;
        return r;
      }
      case 'tools/call':
        if (!target) return ok({ content: [{ type: 'text', text: OUT_OF_TURN_TEXT }], isError: true });
        return forward(msg, req);
      default:
        if (id === undefined || id === null) { if (target && msg.method !== 'notifications/initialized') await forward(msg, req).catch(() => {}); return undefined; }
        if (!target) return { jsonrpc: '2.0', id, error: { code: -32601, message: `${msg.method} is not available outside a Forsion turn` } };
        return forward(msg, req);
    }
  };
  const http = createServer((req, res) => {
    void (async () => {
      if (!authorized(req.headers.authorization)) return json(res, 403);
      if (req.url !== '/mcp') return json(res, 404);
      if (req.method !== 'POST') return json(res, 405, { jsonrpc: '2.0', id: null, error: { code: -32000, message: 'Method not allowed.' } });
      let body: Rpc | Rpc[];
      try { body = JSON.parse(await readBody(req)); } catch { return json(res, 400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }); }
      const list = Array.isArray(body) ? body : [body];
      const out: any[] = [];
      for (const m of list) {
        try { const r = await answer(m, req); if (r !== undefined) out.push(r); }
        catch (e: any) { if (m.id !== undefined && m.id !== null) out.push({ jsonrpc: '2.0', id: m.id, error: { code: -32603, message: String(e?.message || e) } }); }
      }
      if (!out.length) return json(res, 202);
      return json(res, 200, Array.isArray(body) ? out : out[0]);
    })().catch(() => { if (!res.headersSent) json(res, 500); });
  });
  await new Promise<void>((resolve, reject) => { http.once('error', reject); http.listen(0, '127.0.0.1', resolve); });
  const port = (http.address() as { port: number }).port;
  return {
    server: { type: 'http', name: opts.name, url: `http://127.0.0.1:${port}/mcp`, headers: [{ name: 'Authorization', value: `Bearer ${token}` }] },
    setTarget: (t) => { target = t; },
    lastTools: () => lastTools,
    close: () => new Promise<void>((resolve) => { target = null; http.closeAllConnections?.(); http.close(() => resolve()); }),
  };
}
