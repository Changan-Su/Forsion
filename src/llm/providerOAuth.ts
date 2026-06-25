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
import type { DirectProvider, DirectProviderProtocol } from './providerRegistry.js';
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
  baseUrl: string; // 推理根(protocol='openai' 时为 OpenAI 兼容根;订阅原生端点见 protocol)
  protocol?: DirectProviderProtocol; // 缺省 'openai';订阅登录据此切原生端点
  modelIds?: string[]; // 模型选择器提示(实际可填任意 <id>/<model>)
  extraAuthParams?: Record<string, string>; // 追加到 authorize URL(如 Codex 的 id_token_add_organizations)
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
  // Claude 订阅(Claude Pro/Max → Claude Code 额度)。原生 Messages API,非 OpenAI 兼容。
  // ⚠️ 私有契约,可能随官方变动——登录失败先核对:clientId、redirect 是否准回环、token 端点是否要 JSON。
  claude: {
    id: 'claude',
    clientId: '9d1c250a-e61b-44d9-88ed-5944d1962f5e', // Claude Code 公开 desktop client
    scope: 'org:create_api_key user:profile user:inference',
    authorizationEndpoint: 'https://claude.ai/oauth/authorize',
    tokenEndpoint: 'https://console.anthropic.com/v1/oauth/token',
    redirectHost: '127.0.0.1',
    redirectPort: 56122, // 避开 xAI 的 56121
    redirectPath: '/callback',
    baseUrl: 'https://api.anthropic.com',
    protocol: 'anthropic-messages',
    modelIds: ['claude-sonnet-4-6', 'claude-opus-4-8', 'claude-haiku-4-5-20251001'], // 提示;首次真实登录再核对订阅支持的 slug
  },
  // Codex 订阅(ChatGPT Plus/Pro → Codex 额度)。原生 Responses API(chatgpt.com 后端),非 OpenAI 兼容。
  // ⚠️ 私有契约:固定回环 1455/auth/callback、需 id_token_add_organizations 才拿到 account_id。失效先核对此处。
  codex: {
    id: 'codex',
    clientId: 'app_EMoamEEZ73f0CkXaXp7hrann', // Codex CLI 公开 client
    scope: 'openid profile email offline_access',
    authorizationEndpoint: 'https://auth.openai.com/oauth/authorize',
    tokenEndpoint: 'https://auth.openai.com/oauth/token',
    redirectHost: 'localhost', // redirect_uri 须精确匹配注册值 http://localhost:1455/auth/callback
    redirectPort: 1455,
    redirectPath: '/auth/callback',
    baseUrl: 'https://chatgpt.com/backend-api/codex',
    protocol: 'openai-responses',
    // ChatGPT 账号支持的 slug(取自 Codex 源 models-manager/models.json;gpt-5-codex/gpt-5 不被支持)。
    // gpt-5.3-codex = 主力编码模型(gpt-5.2 是其降级 fallback)。
    modelIds: ['gpt-5.3-codex', 'gpt-5.5', 'gpt-5.4', 'gpt-5.4-mini', 'gpt-5.2'],
    extraAuthParams: { id_token_add_organizations: 'true', codex_cli_simplified_flow: 'true' },
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

/** 解 JWT payload(不验签,只读 claim)。 */
function decodeJwtPayload(jwt?: string): any {
  if (!jwt || typeof jwt !== 'string') return null;
  const seg = jwt.split('.')[1];
  if (!seg) return null;
  try {
    return JSON.parse(Buffer.from(seg.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'));
  } catch {
    return null;
  }
}

/** 从 id_token / access_token 解出 Codex 的 chatgpt_account_id(responses 端点必需的 header)。 */
function extractChatgptAccountId(tok: any): string | undefined {
  for (const jwt of [tok?.id_token, tok?.access_token]) {
    const p = decodeJwtPayload(jwt);
    if (!p) continue;
    const auth = p['https://api.openai.com/auth'] || {};
    const id = auth.chatgpt_account_id || p.chatgpt_account_id || auth.organization_id;
    if (id) return String(id);
  }
  return undefined;
}

/**
 * 登录后问 provider 的 `/models` 端点拿真实可用模型列表,免得硬编 slug 过时。
 * Claude=`/v1/models`(Bearer+beta);Codex/OpenAI 兼容=`{base}/models`(Codex MODELS_ENDPOINT 即 /models)。
 * 失败/离线返回 null,调用方回退到 OAUTH_PROVIDERS 里的硬编提示。
 */
export async function fetchProviderModels(p: OAuthProvider, accessToken: string, accountId?: string): Promise<string[] | null> {
  try {
    const base = p.baseUrl.replace(/\/+$/, '');
    const headers: Record<string, string> = { Authorization: `Bearer ${accessToken}` };
    let url: string;
    if (p.protocol === 'anthropic-messages') {
      url = base.endsWith('/v1') ? `${base}/models` : `${base}/v1/models`;
      headers['anthropic-version'] = '2023-06-01';
      headers['anthropic-beta'] = 'oauth-2025-04-20';
    } else {
      url = `${base}/models`; // OpenAI 兼容 + Codex 同形
      if (accountId) headers['chatgpt-account-id'] = accountId;
    }
    const res = await fetch(url, { headers, signal: AbortSignal.timeout(5000) });
    if (!res.ok) return null;
    const j: any = await res.json();
    const arr: any[] = Array.isArray(j) ? j : Array.isArray(j?.data) ? j.data : [];
    const ids = arr
      .filter((m) => {
        const v = m?.visibility;
        return v == null || (v !== 'hide' && v !== 'hidden');
      })
      .map((m) => m?.slug || m?.id)
      .filter((s: any): s is string => typeof s === 'string' && s.length > 0);
    return ids.length ? Array.from(new Set(ids)) : null;
  } catch {
    return null;
  }
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

  const authParams = new URLSearchParams({
    response_type: 'code',
    client_id: p.clientId,
    redirect_uri: redirectUri,
    scope: p.scope,
    state,
    nonce,
    code_challenge: challenge,
    code_challenge_method: 'S256',
  });
  for (const [k, v] of Object.entries(p.extraAuthParams || {})) authParams.set(k, v);
  const authUrl = `${authorize}?${authParams.toString()}`;

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
  // Codex 订阅:responses 端点必需 chatgpt-account-id,从 id_token JWT 解出存盘。
  if (p.protocol === 'openai-responses') {
    const acct = extractChatgptAccountId(tok);
    if (acct) creds.account_id = acct;
  }
  // 登录即问 /models 拿真实模型列表(失败则后续 load 时再懒补;再不行回退硬编提示)。
  const models = await fetchProviderModels(p, creds.access_token, creds.account_id);
  if (models) creds.modelIds = models;
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
    const cfg = OAUTH_PROVIDERS[id];
    // 模型列表懒补:已登录但还没缓存过(如本次升级前登录的)→ 拉一次回写;失败保持空,下次再试。
    if ((!tok.modelIds || !tok.modelIds.length) && cfg) {
      const models = await fetchProviderModels(cfg, tok.access_token, tok.account_id);
      if (models) {
        tok = { ...tok, modelIds: models };
        saveProviderCred(id, tok);
      }
    }
    out.push({
      providerId: id,
      baseUrl: tok.baseUrl,
      apiKey: tok.access_token,
      protocol: cfg?.protocol,
      accountId: tok.account_id,
      modelIds: tok.modelIds && tok.modelIds.length ? tok.modelIds : cfg?.modelIds, // 实拉优先,回退提示
    });
  }
  return out;
}
