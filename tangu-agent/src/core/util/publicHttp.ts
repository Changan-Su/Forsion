import { request as httpRequest, Agent as HttpAgent, type IncomingMessage } from 'node:http';
import { request as httpsRequest, Agent as HttpsAgent } from 'node:https';
import { createUnzip, createBrotliDecompress } from 'node:zlib';
import net from 'node:net';
import { resolvePublicHttpUrl } from './urlSafety.js';
const MAX_REDIRECTS = 5;
export interface FetchPublicInit {
  method?: string;
  headers?: Record<string, string>;
  signal?: AbortSignal;
  body?: string | Uint8Array;
  /** Default is same-origin. Public page readers may opt into credential-free GET redirects. */
  crossOrigin?: 'public-read';
  maxRedirects?: number;
  onDispatch?: () => void;
}
export interface FetchedPage {
  status: number;
  statusText: string;
  headers: IncomingMessage['headers'];
  /** 已按 content-encoding 解压的正文流。 */
  body: NodeJS.ReadableStream;
  /** 底层响应。不读正文(错误路径/读够了)必须调 destroy()。 */
  raw: IncomingMessage;
  /** 一把掐断解压器 + 底层 socket(只 destroy raw 拦不住解压器里已缓冲的膨胀)。 */
  destroy: () => void;
  finalUrl: URL;
}

type Resolver = typeof resolvePublicHttpUrl;

// 专用 Agent,不复用连接:① Node 22.21+ 的 NODE_USE_ENV_PROXY 让**全局** Agent 走
// HTTP_PROXY —— 代理连接不经 lookup 钩子,钉 IP 会被整个绕开,自建 Agent 不受该开关影响;
// ② keepAlive:false 保证不同 pin 之间不共享 socket 池。
const pinAgentHttp = new HttpAgent({ keepAlive: false });
const pinAgentHttps = new HttpsAgent({ keepAlive: false });

/** 单跳请求:连接一律用**校验时解析到的地址**(lookup 钩子),不做第二次 DNS —— 关死 rebinding;
 *  SNI/证书仍按主机名走,TLS 校验不受影响。lookup 回调必须异步调(同步回调撞上连接失败会把
 *  socket error 抛成未处理异常而不是 reject)。 */
function requestPinned(url: URL, addresses: string[], method: string, headers: Record<string, string>, init: FetchPublicInit): Promise<IncomingMessage> {
  return new Promise((resolve, reject) => {
    init.signal?.throwIfAborted();
    if (!addresses.length) throw new Error('URL hostname could not be resolved');
    const isHttps = url.protocol === 'https:';
    const req = (isHttps ? httpsRequest : httpRequest)(url, {
      method,
      headers,
      signal: init.signal,
      agent: isHttps ? pinAgentHttps : pinAgentHttp,
      lookup: (_host, options, cb) => {
        process.nextTick(() => {
          const list = addresses.map((a) => ({ address: a, family: net.isIP(a) }));
          if (options && (options as { all?: boolean }).all) (cb as (e: null, r: typeof list) => void)(null, list);
          else cb(null, list[0]!.address, list[0]!.family);
        });
      },
    }, resolve);
    req.on('error', reject);
    init.onDispatch?.();
    req.end(init.body);
  });
}

/** 手动跟随重定向,**每一跳重新解析+校验并钉住地址**;303(非 GET/HEAD)与 POST+301/302 按
 *  Fetch 语义改写 GET 并剥 body 头;重定向响应体立即 destroy 不占 socket。
 *  resolver 参数是测试接缝(本地起真 http server + 假解析器即可离线验证钉 IP/重定向链)。 */
export async function fetchPublic(rawUrl: string, init: FetchPublicInit, resolver: Resolver = resolvePublicHttpUrl): Promise<FetchedPage> {
  init.signal?.throwIfAborted();
  let { url: current, addresses } = await abortableResolve(rawUrl, resolver, init.signal);
  let method = (init.method ?? 'GET').toUpperCase();
  let requestBody = init.body;
  const headers: Record<string, string> = { 'accept-encoding': 'gzip, deflate, br', ...init.headers };
  const maxRedirects = init.maxRedirects ?? MAX_REDIRECTS;
  for (let i = 0; i <= maxRedirects; i++) {
    init.signal?.throwIfAborted();
    if (current.username || current.password) throw new Error('URL credentials are not allowed');
    const res = await requestPinned(current, addresses, method, headers, { ...init, body: requestBody });
    const status = res.statusCode ?? 0;
    if ([301, 302, 303, 307, 308].includes(status)) {
      const loc = res.headers.location;
      res.destroy(); // 不读重定向响应体 —— 恶意慢流不许占着 socket
      if (!loc) throw new Error(`HTTP ${status} without Location header`);
      if (i === maxRedirects) break;
      const target = new URL(loc, current);
      if (current.protocol === 'https:' && target.protocol !== 'https:') throw new Error('HTTPS downgrade redirect is not allowed');
      const next = await abortableResolve(target.href, resolver, init.signal);
      if (next.url.origin !== current.origin) {
        if (init.crossOrigin !== 'public-read' || !['GET', 'HEAD'].includes(method) || requestBody !== undefined) {
          throw new Error('Cross-origin redirect is not allowed');
        }
        // Allowlist, not a credential-name denylist: X-API-Key and arbitrary custom headers must not escape.
        for (const k of Object.keys(headers)) if (!/^(accept|accept-language|accept-encoding|user-agent)$/i.test(k)) delete headers[k];
      }
      ({ url: current, addresses } = next);
      if ((status === 303 && method !== 'GET' && method !== 'HEAD') || ((status === 301 || status === 302) && method === 'POST')) {
        method = 'GET';
        requestBody = undefined;
        for (const k of Object.keys(headers)) if (/^(content-|transfer-encoding$)/i.test(k)) delete headers[k];
      }
      continue;
    }
    // 服务器压缩了就解(node http 不像 fetch 会自动解压)
    const enc = String(res.headers['content-encoding'] ?? '').toLowerCase();
    let body: NodeJS.ReadableStream = res;
    if (enc === 'gzip' || enc === 'x-gzip' || enc === 'deflate') body = res.pipe(createUnzip());
    else if (enc === 'br') body = res.pipe(createBrotliDecompress());
    const destroy = (): void => {
      if (body !== res) (body as unknown as { destroy: () => void }).destroy();
      res.destroy();
    };
    if (body !== res) {
      // pipe() 不传播两端错误:源错 → 带 error 掐解压器(消费方才会 reject 而不是挂死);
      // 解压器错(坏 gzip/被 destroy)→ 掐 socket。error 监听同时兜住「无消费方」的错误路径
      // (非 2xx 早退),坏压缩流不能变成进程级崩溃。
      res.on('error', (e) => (body as unknown as { destroy: (err?: Error) => void }).destroy(e));
      body.on('error', () => res.destroy());
    }
    return { status, statusText: res.statusMessage ?? '', headers: res.headers, body, raw: res, destroy, finalUrl: current };
  }
  throw new Error(`Too many redirects (>${maxRedirects})`);
}

/** DNS itself is not cancellable on all hosts. Stop waiting, and never dispatch its late answer. */
async function abortableResolve(raw: string, resolver: Resolver, signal?: AbortSignal): Promise<Awaited<ReturnType<Resolver>>> {
  signal?.throwIfAborted();
  if (!signal) return resolver(raw);
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason ?? new Error('HTTP request aborted'));
    signal.addEventListener('abort', abort, { once: true });
    resolver(raw).then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
  });
}

/** One deadline through DNS, redirects and body reads. The caller disposes it after consuming the body. */
export function httpDeadline(outer: AbortSignal | undefined, ms: number): { signal: AbortSignal; dispose: () => void; timedOut: () => boolean } {
  const ac = new AbortController();
  let timeout = false;
  const abort = () => ac.abort(new Error('HTTP request cancelled'));
  if (outer?.aborted) abort();
  else outer?.addEventListener('abort', abort, { once: true });
  const timer = setTimeout(() => { timeout = true; ac.abort(new Error('HTTP request timed out')); }, ms);
  return { signal: ac.signal, timedOut: () => timeout, dispose: () => { clearTimeout(timer); outer?.removeEventListener('abort', abort); } };
}

/** Cap decompressed bytes and reject cancellation even when it happens between headers and consumption. */
export function readBodyCapped(page: FetchedPage, maxBytes: number, signal?: AbortSignal): Promise<{ buf: Buffer; truncated: boolean }> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    let truncated = false;
    let settled = false;
    const done = (err?: Error): void => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener('abort', abort);
      if (err) reject(err);
      else resolve({ buf: Buffer.concat(chunks), truncated });
    };
    const abort = () => { done(new Error('HTTP request cancelled or timed out')); page.destroy(); };
    if (signal?.aborted) { abort(); return; }
    signal?.addEventListener('abort', abort, { once: true });
    page.body.on('data', (chunk: Buffer) => {
      if (settled) return;
      const remaining = maxBytes - total;
      chunks.push(chunk.subarray(0, remaining));
      total += Math.min(chunk.length, remaining);
      if (chunk.length > remaining) { truncated = true; done(); page.destroy(); }
    });
    page.body.on('end', () => done());
    page.body.on('close', () => done(page.raw.complete || truncated ? undefined : new Error('HTTP response closed before completion')));
    page.body.on('error', (err: Error) => done(err));
    if (page.raw.destroyed && !page.raw.complete) done(new Error('HTTP response closed before completion'));
  });
}
