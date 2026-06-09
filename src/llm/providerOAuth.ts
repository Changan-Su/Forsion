/**
 * 通用 provider OAuth 登录(loopback + PKCE S256)—— 让用户"用 AI 订阅账号登录"当 LLM provider。
 * 照 hermes 的 `_xai_oauth_loopback_login` 模板:OIDC discovery → PKCE → 本地 loopback 收 code →
 * 换 access_token(+refresh)→ 存 ~/.tangu/provider-auth.json → 接进 provider registry。
 *
 * 首发 xAI Grok:公开 client_id + 完全 OpenAI 兼容(api.x.ai/v1/chat/completions)→ 零适配,
 * 拿到的 token 直接当 DirectProvider.apiKey 用。其他 provider 加进 OAUTH_PROVIDERS 即可复用本流程。
 *
 * 注:Codex/OpenAI 不在此——它要自注册 OpenAI OAuth app 且后端非 OpenAI 兼容(responses API),
 * 需单独适配,见 docs/Log。
 */
import http from 'node:http';
import { createHash, randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import type { DirectProvider } from './providerRegistry.js';
import { loadProviderCreds, saveProviderCred, type OAuthTokens } from '../standalone/providerCreds.js';

export interface OAuthProvider {
  id: string; // 也作 modelId 前缀:xai/grok-2
  clientId: string;
  scope: string;
  discoveryUrl?: string; // OIDC discovery(优先)
  authorizationEndpoint?: string;
  tokenEndpoint?: string;
  redirectHost: string;
  redirectPort: number;
  redirectPath: string;
  baseUrl: string; // OpenAI 兼容推理根
}

export const OAUTH_PROVIDERS: Record<string, OAuthProvider> = {
  xai: {
    id: 'xai',
    clientId: 'b1a00492-073a-47ea-816f-4c329264a828', // xAI 官方公开 desktop client
    scope: 'openid profile email offline_access grok-cli:access api:access',
    discoveryUrl: 'https://auth.x.ai/.well-known/openid-configuration',
    redirectHost: '127.0.0.1',
    redirectPort: 56121,
    redirectPath: '/callback',
    baseUrl: 'https://api.x.ai/v1',
  },
};

function pkce(): { verifier: string; challenge: string } {
  const verifier = randomBytes(32).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  return { verifier, challenge };
}

function openBrowser(url: string): void {
  try {
    const cmd = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'cmd' : 'xdg-open';
    const args = process.platform === 'win32' ? ['/c', 'start', '', url] : [url];
    const p = spawn(cmd, args, { stdio: 'ignore', detached: true });
    p.on('error', () => {});
    p.unref();
  } catch { /* 用户手动复制链接 */ }
}

async function resolveEndpoints(p: OAuthProvider): Promise<{ authorize: string; token: string }> {
  if (p.authorizationEndpoint && p.tokenEndpoint) return { authorize: p.authorizationEndpoint, token: p.tokenEndpoint };
  if (!p.discoveryUrl) throw new Error(`provider ${p.id} 缺少 endpoints/discovery`);
  const d: any = await fetch(p.discoveryUrl).then((r) => r.json());
  if (!d.authorization_endpoint || !d.token_endpoint) throw new Error(`${p.id} discovery 缺 endpoint`);
  return { authorize: d.authorization_endpoint, token: d.token_endpoint };
}

/** 跑完整 loopback+PKCE 登录,返回并落盘 OAuthTokens。 */
export async function providerOAuthLogin(p: OAuthProvider): Promise<OAuthTokens> {
  const { authorize, token } = await resolveEndpoints(p);
  const { verifier, challenge } = pkce();
  const state = randomBytes(16).toString('hex');
  const nonce = randomBytes(16).toString('hex');
  const redirectUri = `http://${p.redirectHost}:${p.redirectPort}${p.redirectPath}`;

  const codePromise = new Promise<string>((resolve, reject) => {
    const server = http.createServer((req, res) => {
      const u = new URL(req.url || '', redirectUri);
      if (u.pathname !== p.redirectPath) { res.writeHead(404); res.end(); return; }
      const code = u.searchParams.get('code');
      const st = u.searchParams.get('state');
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end('<!doctype html><meta charset=utf-8><body style="font-family:system-ui;display:grid;place-items:center;height:100vh"><h2>✓ 已登录,回到终端即可</h2></body>');
      server.close();
      if (st !== state) return reject(new Error('state 不匹配(疑似 CSRF)'));
      if (!code) return reject(new Error('回调未带 code'));
      resolve(code);
    });
    server.on('error', reject);
    server.listen(p.redirectPort, p.redirectHost);
    // 5 分钟超时
    setTimeout(() => { try { server.close(); } catch { /* */ } reject(new Error('登录超时')); }, 5 * 60 * 1000).unref?.();
  });

  const authUrl = `${authorize}?` + new URLSearchParams({
    response_type: 'code',
    client_id: p.clientId,
    redirect_uri: redirectUri,
    scope: p.scope,
    state,
    nonce,
    code_challenge: challenge,
    code_challenge_method: 'S256',
  }).toString();

  console.log(`\n  \x1b[36m在浏览器打开此链接登录 ${p.id}\x1b[0m(已尝试自动打开):`);
  console.log(`  ${authUrl}\n`);
  console.log('\x1b[2m  等待浏览器回调…\x1b[0m');
  openBrowser(authUrl);

  const code = await codePromise;
  const tok: any = await fetch(token, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'authorization_code', code, code_verifier: verifier, client_id: p.clientId, redirect_uri: redirectUri }).toString(),
  }).then((r) => r.json());
  if (!tok.access_token) throw new Error('token 交换失败: ' + JSON.stringify(tok).slice(0, 200));

  const creds: OAuthTokens = {
    access_token: tok.access_token,
    refresh_token: tok.refresh_token,
    expires_at: tok.expires_in ? Date.now() + tok.expires_in * 1000 : undefined,
    baseUrl: p.baseUrl,
    tokenEndpoint: token,
    clientId: p.clientId,
  };
  saveProviderCred(p.id, creds);
  return creds;
}

async function refresh(t: OAuthTokens): Promise<OAuthTokens> {
  if (!t.refresh_token) return t;
  const r: any = await fetch(t.tokenEndpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: t.refresh_token, client_id: t.clientId }).toString(),
  }).then((r) => r.json()).catch(() => null);
  if (!r?.access_token) return t;
  return {
    ...t,
    access_token: r.access_token,
    refresh_token: r.refresh_token || t.refresh_token,
    expires_at: r.expires_in ? Date.now() + r.expires_in * 1000 : t.expires_at,
  };
}

/** 读出所有已登录的 OAuth provider,过期(120s skew)则刷新并回写,转成 DirectProvider 接进 registry。 */
export async function loadOAuthDirectProviders(): Promise<DirectProvider[]> {
  const store = loadProviderCreds();
  const out: DirectProvider[] = [];
  for (const [id, t] of Object.entries(store)) {
    let tok = t;
    if (tok.expires_at && tok.expires_at < Date.now() + 120_000) {
      tok = await refresh(tok);
      saveProviderCred(id, tok);
    }
    out.push({ providerId: id, baseUrl: tok.baseUrl, apiKey: tok.access_token });
  }
  return out;
}
