/**
 * 「Tangu for Chrome」扩展的本机桥(09-24):引擎在 127.0.0.1 起一个 WebSocket,扩展凭连接码配对一次后常连。
 * 相比远程调试端口那条路:不弹「允许远程调试?」、Tangu 自己的标签进专属标签组、后台标签里操作不抢前台、
 * 知道用户正在看哪个标签(扩展侧实测见 tangu-agent/browser-extension/background.js 头注)。
 *
 * 安全:只监听回环;只收 Origin = 固定扩展 ID(manifest.key 钉死)的连接;握手是双向挑战-应答
 * (HMAC-SHA256,密钥 = 连接码里的令牌,令牌本身从不上线):扩展要先验明这边真是 Tangu 才执行命令,
 * 本机抢占端口的进程既拿不到令牌、也指挥不了扩展。
 * 连接码按引擎家目录各存一份 → dev / 正式版 / CLI 互不串(端口也各配各的,桌面经 env 注入)。
 */
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer, WebSocket } from 'ws';
import { getRawSection } from '../core/config.js';
import { tanguHome } from '../core/tanguHome.js';

/** manifest.json 的 key 钉死的扩展 ID;上架应用商店后的 ID 经 config browserExtension.extensionIds 追加。 */
export const EXTENSION_ID = 'gpajikakdmhjebadgcbmhidkkajclfoi';
const DEFAULT_PORT = 47654;
const HELLO_TIMEOUT_MS = 5_000;
const CALL_TIMEOUT_MS = 45_000;

interface Pending { resolve: (v: any) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }
interface Client { ws: WebSocket; version: string; connectedAt: number; pending: Map<number, Pending> }

let server: WebSocketServer | null = null;
let listenError = '';
let clients: Client[] = [];
let seq = 0;

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
  const have = Buffer.from(String(got ?? ''));
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
    maxPayload: 64 * 1024 * 1024, // 截图 / 大页正文
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
  wss.on('connection', (ws) => onConnection(ws));
  server = wss;
}

function onConnection(ws: WebSocket): void {
  let client: Client | null = null;
  let serverNonce = '';
  let version = '';
  const helloTimer = setTimeout(() => { if (!client) ws.close(4001, 'hello timeout'); }, HELLO_TIMEOUT_MS);
  ws.on('message', (data) => {
    let m: any;
    try { m = JSON.parse(String(data)); } catch { return; }
    if (!client) {
      // ① hello{nonce} → 回 challenge{proof=HMAC(server:扩展nonce), nonce};② auth{proof=HMAC(client:我方nonce)} → welcome
      if (m?.type === 'hello' && !serverNonce && typeof m.nonce === 'string' && /^[0-9a-f]{16,128}$/.test(m.nonce)) {
        serverNonce = randomBytes(16).toString('hex');
        version = String(m.version || '');
        ws.send(JSON.stringify({ type: 'challenge', proof: hmacHex(`server:${m.nonce}`), nonce: serverNonce }));
        return;
      }
      if (m?.type === 'auth' && serverNonce && proofOk(m.proof, `client:${serverNonce}`)) {
        clearTimeout(helloTimer);
        client = { ws, version, connectedAt: Date.now(), pending: new Map() };
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
  });
  ws.on('close', () => {
    clearTimeout(helloTimer);
    if (!client) return;
    clients = clients.filter((c) => c !== client);
    for (const p of client.pending.values()) { clearTimeout(p.timer); p.reject(new Error('The Chrome extension disconnected')); }
  });
  ws.on('error', () => { /* close 随后会来 */ });
}

export function extensionConnected(): boolean { return clients.length > 0; }

/** 发一条命令给扩展(多个 Chrome 配置都装了扩展时,用最近连上的那个)。 */
export function extensionCall<T = any>(method: string, params: Record<string, unknown> = {}, timeoutMs = CALL_TIMEOUT_MS): Promise<T> {
  const client = clients[clients.length - 1];
  if (!client) return Promise.reject(new Error('The Tangu Chrome extension is not connected'));
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
