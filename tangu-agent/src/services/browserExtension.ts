/**
 * 「Tangu for Chrome」扩展的本机桥(09-24):引擎在 127.0.0.1 起一个 WebSocket,扩展凭连接码配对一次后常连。
 * 相比远程调试端口那条路:不弹「允许远程调试?」、Tangu 自己的标签进专属标签组、后台标签里操作不抢前台、
 * 知道用户正在看哪个标签(扩展侧实测见 tangu-agent/browser-extension/background.js 头注)。
 *
 * 安全:只监听回环;只收 Origin = 固定扩展 ID(manifest.key 钉死)的连接;握手是双向挑战-应答
 * (HMAC-SHA256,密钥 = 连接码里的令牌,令牌本身从不上线):扩展要先验明这边真是 Tangu 才执行命令,
 * 本机抢占端口的进程既拿不到令牌、也指挥不了扩展。
 * 信任边界:同一系统用户下的进程读得到令牌文件(0600 只挡别的用户)—— 与改写 Native Messaging 清单同级,
 * 视为可信;别的系统用户的进程连得上回环口,所以握手阶段按原始字节限流(不等 ws 收齐整帧)、限并发、
 * 不信任任何字段的类型(Codex 09-24)。
 * 连接码按引擎家目录各存一份 → dev / 正式版 / CLI 互不串(端口也各配各的,桌面经 env 注入)。
 */
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer, WebSocket } from 'ws';
import { getRawSection } from '../core/config.js';
import { tanguHome } from '../core/tanguHome.js';
import type { IncomingMessage } from 'node:http';

/** manifest.json 的 key 钉死的扩展 ID;上架应用商店后的 ID 经 config browserExtension.extensionIds 追加。 */
export const EXTENSION_ID = 'gpajikakdmhjebadgcbmhidkkajclfoi';
const DEFAULT_PORT = 47654;
const HELLO_TIMEOUT_MS = 5_000;
const CALL_TIMEOUT_MS = 45_000;
const MAX_PAYLOAD = 32 * 1024 * 1024; // 截图 / 大页正文;扩展侧另把截图卡在 24MB 以内
const MAX_PREAUTH_BYTES = 16 * 1024; // 未认证的连接只该发 hello / auth 两个小帧(实际约 300 字节)
const MAX_PENDING_HANDSHAKES = 8;

interface Pending { resolve: (v: any) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }
interface Client { id: number; ws: WebSocket; version: string; connectedAt: number; pending: Map<number, Pending> }

let server: WebSocketServer | null = null;
let listenError = '';
let clients: Client[] = [];
let seq = 0;
let nextClientId = 0;
let pendingHandshakes = 0;

function cfg(): any { return getRawSection('browserExtension') || {}; }

function enabled(): boolean {
  if (process.env.TANGU_BROWSER_EXTENSION !== undefined) return process.env.TANGU_BROWSER_EXTENSION !== '0';
  return cfg().enabled !== false;
}

export function extensionPort(): number {
  const v = Number(process.env.TANGU_BROWSER_EXTENSION_PORT || cfg().port || DEFAULT_PORT);
  return Number.isInteger(v) && v > 0 && v < 65536 ? v : DEFAULT_PORT;
}

function allowedOrigins(): Set<string> {
  const extra = Array.isArray(cfg().extensionIds) ? cfg().extensionIds.map(String) : [];
  return new Set([EXTENSION_ID, ...extra].map((id) => `chrome-extension://${id}`));
}

function tokenFile(): string { return path.join(tanguHome(), 'browser-extension.json'); }

/** 连接码里的令牌:首次用时生成并落盘(0600);reset=true 换一枚新的(旧配对随即失效)。 */
export function extensionToken(reset = false): string {
  if (!reset) {
    try {
      const t = JSON.parse(readFileSync(tokenFile(), 'utf8')).token;
      if (typeof t === 'string' && /^[0-9a-f]{32,}$/.test(t)) return t;
    } catch { /* 没有或坏了 → 重新生成 */ }
  }
  const token = randomBytes(24).toString('hex');
  mkdirSync(tanguHome(), { recursive: true });
  writeFileSync(tokenFile(), `${JSON.stringify({ token }, null, 2)}\n`, { mode: 0o600 });
  if (reset) for (const c of clients) c.ws.close(4001, 'code reset');
  return token;
}

export function connectCode(): string { return `tangu:${extensionPort()}:${extensionToken()}`; }

const hmacHex = (message: string): string => createHmac('sha256', extensionToken()).update(message).digest('hex');

function proofOk(got: unknown, message: string): boolean {
  const want = Buffer.from(hmacHex(message));
  const have = Buffer.from(typeof got === 'string' ? got : '');
  return have.length === want.length && timingSafeEqual(have, want);
}

/** 随包的扩展目录(用户「加载已解压的扩展程序」时选它):dist/services → ../../browser-extension。 */
export function extensionDir(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'browser-extension');
}

function engineLabel(): string {
  const who = process.env.TANGU_HOST_CLIENT || 'tangu';
  return tanguHome().includes('.forsion-dev') ? `${who} (dev)` : who;
}

export function startBrowserExtensionBridge(): void {
  if (server || !enabled()) return;
  const origins = allowedOrigins();
  const wss = new WebSocketServer({
    host: '127.0.0.1',
    port: extensionPort(),
    path: '/tangu-browser',
    maxPayload: MAX_PAYLOAD,
    verifyClient: ({ origin }: { origin?: string }) => origins.has(String(origin || '')),
  });
  wss.on('listening', () => { listenError = ''; });
  wss.on('error', (e: any) => {
    // 典型:EADDRINUSE —— 同端口已有别的引擎(比如正式版和 CLI 同时开着)。引擎照常运行,只是这一路不可用。
    listenError = String(e?.code || e?.message || e);
    console.warn(`[tangu] Chrome 扩展桥监听 ${extensionPort()} 失败:${listenError}`);
    try { wss.close(); } catch { /* ignore */ }
    if (server === wss) server = null;
  });
  wss.on('connection', (ws, req) => onConnection(ws, req));
  server = wss;
}

function onConnection(ws: WebSocket, req: IncomingMessage): void {
  if (pendingHandshakes >= MAX_PENDING_HANDSHAKES) { ws.close(1013, 'busy'); return; }
  pendingHandshakes++;
  let handshaking = true;
  const endHandshake = (): void => { if (handshaking) { handshaking = false; pendingHandshakes--; } };
  let client: Client | null = null;
  let serverNonce = '';
  let version = '';
  const helloTimer = setTimeout(() => { if (!client) ws.close(4001, 'hello timeout'); }, HELLO_TIMEOUT_MS);
  // 未认证阶段按套接字原始字节计数:ws 的 message 事件要等整帧(最多 maxPayload)收齐才触发,在那里判长度为时已晚。
  // prependListener = 排在 ws 自己的 data 监听前面,超限的那一块 ws 还没解析就已判死(下面 message 里再按 readyState 丢弃)
  let preAuthBytes = 0;
  const countRaw = (chunk: Buffer): void => {
    if (client) { req.socket.off('data', countRaw); return; }
    preAuthBytes += chunk.length;
    if (preAuthBytes > MAX_PREAUTH_BYTES) ws.terminate();
  };
  req.socket.prependListener('data', countRaw);
  ws.on('message', (data: Buffer | ArrayBuffer | Buffer[]) => {
    if (ws.readyState !== WebSocket.OPEN) return; // 已判死 / 已发 close 之后到的帧一律不处理
    try { onFrame(data); } catch { ws.close(1011, 'bad message'); } // 字段类型全不可信(比如 toString 被置空的对象),绝不让异常冒到进程
  });
  function onFrame(data: Buffer | ArrayBuffer | Buffer[]): void {
    let m: any;
    try { m = JSON.parse(String(data)); } catch { return; }
    if (!client) {
      // ① hello{nonce} → 回 challenge{proof=HMAC(server:扩展nonce), nonce};② auth{proof=HMAC(client:我方nonce)} → welcome
      if (m?.type === 'hello' && !serverNonce && typeof m.nonce === 'string' && /^[0-9a-f]{16,128}$/.test(m.nonce)) {
        serverNonce = randomBytes(16).toString('hex');
        version = typeof m.version === 'string' ? m.version.slice(0, 64) : '';
        ws.send(JSON.stringify({ type: 'challenge', proof: hmacHex(`server:${m.nonce}`), nonce: serverNonce }));
        return;
      }
      if (m?.type === 'auth' && serverNonce && proofOk(m.proof, `client:${serverNonce}`)) {
        clearTimeout(helloTimer);
        endHandshake();
        client = { id: ++nextClientId, ws, version, connectedAt: Date.now(), pending: new Map() };
        clients.push(client);
        ws.send(JSON.stringify({ type: 'welcome', engine: engineLabel() }));
        return;
      }
      ws.close(4001, 'bad code');
      return;
    }
    if (typeof m?.id !== 'number') return; // ping 等
    const p = client.pending.get(m.id);
    if (!p) return;
    client.pending.delete(m.id);
    clearTimeout(p.timer);
    if (m.error) p.reject(new Error(String(m.error))); else p.resolve(m.result);
  }
  ws.on('close', () => {
    clearTimeout(helloTimer);
    endHandshake();
    if (!client) return;
    clients = clients.filter((c) => c !== client);
    for (const p of client.pending.values()) { clearTimeout(p.timer); p.reject(new Error('The Chrome extension disconnected')); }
  });
  ws.on('error', () => { /* close 随后会来 */ });
}

export function extensionConnected(): boolean { return clients.length > 0; }

/** 当前默认连接(多个 Chrome 配置都装了扩展时 = 最近连上的那个);没有 → null。 */
export function currentExtensionClient(): number | null { return clients.length ? clients[clients.length - 1].id : null; }
export function extensionClientAlive(id: number): boolean { return clients.some((c) => c.id === id); }

/**
 * 发一条命令给扩展。clientId 给了就只发给那一条连接(标签 id 只在它所属的浏览器里有意义 ——
 * 换了浏览器还用旧 id,可能正好落到另一个浏览器里同号的用户标签上,Codex 09-24);没给 = 当前默认连接。
 */
export function extensionCall<T = any>(method: string, params: Record<string, unknown> = {}, timeoutMs = CALL_TIMEOUT_MS, clientId?: number): Promise<T> {
  const client = clientId == null ? clients[clients.length - 1] : clients.find((c) => c.id === clientId);
  if (!client) return Promise.reject(new Error(clientId == null ? 'The Tangu Chrome extension is not connected' : 'The Chrome window this conversation was using is no longer connected'));
  const id = ++seq;
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      client.pending.delete(id);
      reject(new Error(`The Chrome extension did not answer ${method} within ${Math.round(timeoutMs / 1000)}s`));
    }, timeoutMs);
    client.pending.set(id, { resolve, reject, timer });
    client.ws.send(JSON.stringify({ id, method, params }));
  });
}

export function extensionStatus(): {
  enabled: boolean; port: number; listening: boolean; error: string; connected: boolean;
  clients: Array<{ version: string; connectedAt: number }>; extensionId: string; extensionDir: string;
} {
  return {
    enabled: enabled(),
    port: extensionPort(),
    listening: !!server && !listenError,
    error: listenError,
    connected: clients.length > 0,
    clients: clients.map((c) => ({ version: c.version, connectedAt: c.connectedAt })),
    extensionId: EXTENSION_ID,
    extensionDir: extensionDir(),
  };
}

export function stopBrowserExtensionBridge(): void {
  for (const c of clients) { try { c.ws.terminate(); } catch { /* ignore */ } }
  clients = [];
  try { server?.close(); } catch { /* ignore */ }
  server = null;
}
