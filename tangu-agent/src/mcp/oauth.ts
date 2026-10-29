/**
 * 远端 MCP 的 OAuth 登录(连接器方案 2026-10-23 第一步):server 回 401 → 「待登录」;用户在设置里点登录 → 浏览器授权 →
 * 本机回环收 code → 换令牌 → 重连。
 *   - 令牌存 ~/.forsion/connector-auth.json(与 provider-auth.json 同档:锁内读改写、0600、.bak 恢复;C4 读拒绝),只在本机。
 *   - 按「服务器规范 URL」存;SDK 给令牌 / client 记录盖 issuer 戳,换了授权服务器读回来就当没有 → 绑定 = URL + 授权服务器。
 *     条目改名不影响,URL 改了旧令牌不带过去。
 *   - **不把 authProvider 交给 transport**:transport 内部调 auth() 用的是 sameOriginFetch + 用户配置的 headers ——
 *     授权服务器跨源时走不通,同源时 headers 会跟着发到 token 端点。MCP 流量照旧走 sameOriginFetch,这里只往里加 Bearer;
 *     登录 / 刷新由我们用 authFetch(不带任何配置头)自己调 auth()。
 *   - 客户端登记:mcp.json 的 oauth.clientId(预注册)→ DCR。CIMD 要等 forsion.net 挂上 client 文档(P2)再开:
 *     现在设了 clientMetadataUrl,声明支持 CIMD 的授权服务器会去取一个 404。
 *   - 刷新只在 401 时做(SDK 的 auth() 有 refresh_token 就刷);同一 server 的并发 401 共用一次刷新 ——
 *     refresh_token 会轮换,两次并发刷新的后一次拿旧值撞 invalid_grant,SDK 随即删掉前一次刚存的令牌。
 */
import { createServer, type Server } from 'node:http';
import { randomBytes } from 'node:crypto';
import { auth, extractWWWAuthenticateParams, type OAuthClientProvider, type OAuthDiscoveryState } from '@modelcontextprotocol/sdk/client/auth.js';
import type { OAuthClientInformationMixed, OAuthClientMetadata, OAuthTokens } from '@modelcontextprotocol/sdk/shared/auth.js';
import { connectorAuthFile } from '../core/tanguHome.js';
import { withConfigLock, loadJsonRecovering, readLockedJson, commitLockedJson } from '../core/config.js';

/** mcp.json 条目里的 `oauth` 块:只在要预注册 client 时写。 */
export interface McpOAuthConfig {
  clientId?: string;
  scopes?: string[];
}
/** 401 响应里 WWW-Authenticate 带回的线索,登录时交给 auth()。 */
export interface AuthHint {
  resourceMetadataUrl?: string;
  scope?: string;
}
interface AuthRecord {
  client?: OAuthClientInformationMixed;
  tokens?: OAuthTokens;
  discovery?: OAuthDiscoveryState;
}

export const CALLBACK_PATH = '/mcp/callback';
const LOGIN_TIMEOUT_MS = 5 * 60_000;
// ponytail: 固定端口(不少授权服务器要求回调地址逐字一致,DCR 登记的也是这一个);dev 与安装版同时登录会撞 → 提示稍后再试,不做端口池。
export function callbackPort(): number {
  const n = Number(process.env.TANGU_MCP_OAUTH_PORT);
  return Number.isInteger(n) && n > 0 && n < 65536 ? n : 53683;
}

export function serverKey(url: string): string {
  const u = new URL(url);
  u.hash = '';
  return u.href;
}

function updateAll(f: string, mutate: (all: Record<string, AuthRecord>) => Record<string, AuthRecord> | undefined): void {
  withConfigLock(f, (stillMine) => {
    const read = readLockedJson(f, stillMine, 'connector-auth.json', 'empty');
    const next = mutate((read.cur ?? {}) as Record<string, AuthRecord>);
    if (next !== undefined) commitLockedJson(f, next, read, stillMine);
  });
}
// ponytail: 每个 MCP 请求读一次文件(几 KB);真成了瓶颈再按 mtime 缓存。
function loadRecord(key: string): AuthRecord | undefined {
  const f = connectorAuthFile();
  return ((loadJsonRecovering(f, (m) => updateAll(f, m)) ?? {}) as Record<string, AuthRecord>)[key];
}
/** fn 返回 null = 删掉这条,undefined = 不写。 */
function updateRecord(key: string, fn: (cur: AuthRecord | undefined) => AuthRecord | null | undefined): void {
  updateAll(connectorAuthFile(), (all) => {
    const next = fn(all[key]);
    if (next === undefined) return undefined;
    const out = { ...all };
    if (next === null) delete out[key];
    else out[key] = next;
    return out;
  });
}

export function hasTokens(serverUrl: string): boolean {
  try { return !!loadRecord(serverKey(serverUrl))?.tokens; } catch { return false; }
}
/** 断开 = 删掉本机这条记录。ponytail: 不调授权服务器的撤销端点(方案「顺手」那条),要做在这里补 revocation_endpoint。 */
export function forgetServer(serverUrl: string): void {
  updateRecord(serverKey(serverUrl), (cur) => (cur ? null : undefined));
}

class NeedsLoginError extends Error {
  constructor() { super('Sign-in required'); }
}

class Provider implements OAuthClientProvider {
  readonly nonce = randomBytes(16).toString('base64url');
  private verifier = '';
  constructor(private key: string, private cfg: McpOAuthConfig | undefined, private onRedirect?: (url: URL) => void) {}
  // 非交互(刷新)也必须给 redirectUrl:SDK 见没有 redirectUrl 就走 client_credentials,刷新失败会变成一次无码的 token 请求。
  get redirectUrl(): string { return `http://127.0.0.1:${callbackPort()}${CALLBACK_PATH}`; }
  get clientMetadata(): OAuthClientMetadata {
    const scopes = this.cfg?.scopes; // mcp.json 是手写的:形状不对就当没写
    const scope = Array.isArray(scopes) ? scopes.filter((x) => typeof x === 'string').join(' ') : '';
    return {
      client_name: 'Forsion', redirect_uris: [this.redirectUrl], grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'], token_endpoint_auth_method: 'none', ...(scope ? { scope } : {}),
    };
  }
  state(): string { return this.nonce; }
  clientInformation(): OAuthClientInformationMixed | undefined {
    const stored = loadRecord(this.key)?.client;
    const pre = typeof this.cfg?.clientId === 'string' ? this.cfg.clientId.trim() : '';
    if (!pre) return stored;
    return stored?.client_id === pre ? stored : { client_id: pre }; // 用户换了预注册 id:旧登记(含 DCR 的)不再用
  }
  saveClientInformation(client: OAuthClientInformationMixed): void { updateRecord(this.key, (cur) => ({ ...cur, client })); }
  tokens(): OAuthTokens | undefined { return loadRecord(this.key)?.tokens; }
  saveTokens(tokens: OAuthTokens): void { updateRecord(this.key, (cur) => ({ ...cur, tokens })); }
  redirectToAuthorization(url: URL): void {
    if (!this.onRedirect) throw new NeedsLoginError();
    this.onRedirect(url);
  }
  saveCodeVerifier(v: string): void { this.verifier = v; }
  codeVerifier(): string { return this.verifier; }
  discoveryState(): OAuthDiscoveryState | undefined { return loadRecord(this.key)?.discovery; }
  saveDiscoveryState(discovery: OAuthDiscoveryState): void { updateRecord(this.key, (cur) => ({ ...cur, discovery })); }
  invalidateCredentials(scope: 'all' | 'client' | 'tokens' | 'verifier' | 'discovery'): void {
    if (scope === 'verifier') { this.verifier = ''; return; }
    updateRecord(this.key, (cur) => {
      if (!cur) return undefined;
      const next = { ...cur };
      if (scope === 'all' || scope === 'client') delete next.client;
      if (scope === 'all' || scope === 'tokens') delete next.tokens;
      if (scope === 'all' || scope === 'discovery') delete next.discovery;
      return next;
    });
  }
}

const LOOPBACK = new Set(['127.0.0.1', 'localhost', '[::1]']);
/** 授权服务器的请求:只走 HTTPS(本机回环可 http),不带 MCP 条目里配置的任何头;POST 不跟跳转(code / verifier 不随跳转发去别处)。 */
export const authFetch: typeof fetch = async (input, init) => {
  const req = new Request(input, init);
  const u = new URL(req.url);
  if (u.protocol !== 'https:' && !(u.protocol === 'http:' && LOOPBACK.has(u.hostname))) throw new Error('OAuth endpoints must use HTTPS');
  return fetch(req, { redirect: req.method === 'GET' || req.method === 'HEAD' ? 'follow' : 'error' });
};

/**
 * 包住 MCP 流量的 fetch(已是 sameOriginFetch):有令牌就加 Bearer;401 → 有 refresh_token 先刷一次再重发,
 * 刷不成 / 没令牌 → onAuthRequired(此后由 manager 置「待登录」、不重试)。条目自己配了 Authorization 头 = 用户自管鉴权,原样放行。
 */
export function withBearer(base: typeof fetch, serverUrl: string, cfg: McpOAuthConfig | undefined, onAuthRequired: (hint: AuthHint) => void): typeof fetch {
  const key = serverKey(serverUrl);
  let refreshing: Promise<boolean> | null = null;
  const refresh = (): Promise<boolean> => {
    refreshing ??= auth(new Provider(key, cfg), { serverUrl, fetchFn: authFetch })
      .then((r) => r === 'AUTHORIZED', () => false)
      .finally(() => { refreshing = null; });
    return refreshing;
  };
  return async (input, init) => {
    const req = new Request(input, init);
    if (req.headers.has('authorization')) return base(req);
    const send = (t: OAuthTokens | undefined): Promise<Response> => {
      const headers = new Headers(req.headers);
      if (t) headers.set('authorization', `Bearer ${t.access_token}`);
      return base(new Request(req.clone(), { headers })); // clone:401 后重发要一份完整的请求体
    };
    const used = loadRecord(key)?.tokens;
    const res = await send(used);
    if (res.status !== 401) return res;
    const p = extractWWWAuthenticateParams(res);
    const hint: AuthHint = { resourceMetadataUrl: p.resourceMetadataUrl?.href, scope: p.scope };
    if (used?.refresh_token) {
      // 并发的另一次调用刚刷过:直接用新令牌重发,不再刷
      const fresh = loadRecord(key)?.tokens?.access_token !== used.access_token || await refresh();
      const now = fresh ? loadRecord(key)?.tokens : undefined;
      if (now) {
        await res.body?.cancel();
        const again = await send(now);
        if (again.status !== 401) return again;
        onAuthRequired(hint);
        return again;
      }
    }
    onAuthRequired(hint);
    return res;
  };
}

const PAGE = (ok: boolean) => `<!doctype html><meta charset="utf-8"><title>Forsion</title>
<body style="font:15px system-ui;margin:48px;color:#333">${ok
  ? '<p>登录完成，可以关掉这个页面，回到 Forsion。</p><p>Signed in. You can close this tab and return to Forsion.</p>'
  : '<p>登录没有完成，请回到 Forsion 重试。</p><p>Sign-in was not completed. Return to Forsion and try again.</p>'}</body>`;

let loginBusy = false;
/**
 * 走一遍交互登录:起回环 → auth()(发现、登记、PKCE、resource)→ onUrl(授权页地址,交给宿主开浏览器)→ 等回调 → 换令牌。
 * 有 refresh_token 且刷新成功的,auth() 直接返回、不开浏览器(onUrl 不会被调)。signal = 引擎退出时放掉回环端口。
 */
export async function loginServer(serverUrl: string, cfg: McpOAuthConfig | undefined, hint: AuthHint | undefined, onUrl: (url: string) => void, signal?: AbortSignal): Promise<void> {
  if (loginBusy) throw new Error('Another MCP sign-in is in progress. Finish it in the browser or wait a few minutes.');
  loginBusy = true;
  let srv: Server | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const provider = new Provider(serverKey(serverUrl), cfg, (u) => onUrl(u.href));
    let settle!: (q: URLSearchParams) => void;
    const callback = new Promise<URLSearchParams>((resolve, reject) => {
      settle = resolve;
      timer = setTimeout(() => reject(new Error('Sign-in timed out. Try again.')), LOGIN_TIMEOUT_MS);
      timer.unref?.();
      signal?.addEventListener('abort', () => reject(new Error('Sign-in was cancelled.')), { once: true });
    });
    callback.catch(() => {}); // auth() 就失败 / 刷新就成了时没人等它:超时别成未处理的拒绝
    srv = createServer((req, res) => {
      const q = new URL(req.url ?? '/', 'http://127.0.0.1').searchParams;
      // 只认这一次登录的 state:别的请求(扫描、旧标签页)不打断等待
      if (!req.url?.startsWith(CALLBACK_PATH) || q.get('state') !== provider.nonce) { res.writeHead(404).end(); return; }
      const ok = !!q.get('code') && !q.get('error');
      res.writeHead(ok ? 200 : 400, { 'content-type': 'text/html; charset=utf-8' }).end(PAGE(ok));
      settle(q);
    });
    await new Promise<void>((resolve, reject) => {
      srv!.once('error', (e: NodeJS.ErrnoException) => reject(e.code === 'EADDRINUSE'
        ? new Error(`Port ${callbackPort()} is in use (another Forsion may be signing in). Try again later.`) : e));
      srv!.listen(callbackPort(), '127.0.0.1', () => resolve());
    });
    srv.unref(); // 等回调不该撑住进程
    const opts = {
      serverUrl,
      ...(hint?.resourceMetadataUrl ? { resourceMetadataUrl: new URL(hint.resourceMetadataUrl) } : {}),
      ...(hint?.scope ? { scope: hint.scope } : {}),
      fetchFn: authFetch,
    };
    let first: string;
    try {
      first = await auth(provider, opts);
    } catch (e: any) {
      if (/dynamic client registration/i.test(String(e?.message))) {
        throw new Error('This server does not allow automatic client registration. Add "oauth": { "clientId": "…" } to its entry in mcp.json.');
      }
      throw e;
    }
    if (first === 'AUTHORIZED') return;
    const q = await callback;
    const code = q.get('code');
    if (!code) throw new Error(`Sign-in was not completed${q.get('error') ? ` (${String(q.get('error')).replace(/[^\w.-]/g, '').slice(0, 60)})` : ''}.`);
    await auth(provider, { ...opts, authorizationCode: code });
  } finally {
    loginBusy = false;
    if (timer) clearTimeout(timer);
    if (srv) { srv.closeAllConnections?.(); srv.close(); }
  }
}
