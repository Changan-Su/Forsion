// Invoke with node (also imported by Vitest's module runner).
/**
 * 假 OAuth 授权服务器(src/mcp/oauth.test.ts 与 desktop/scripts/mcp-oauth.electron.cjs 共用):PKCE S256、DCR(可关)、
 * 授权码一次性、refresh_token 用一次就轮换;/authorize 不要人点,直接 302 回 redirect_uri(带 code + state)。
 * 状态都在返回的对象上:access(有效的 access_token)、refreshes(刷新次数)、failRefresh(置 true 让刷新回 invalid_grant)、
 * seen(收到的每个请求:路径 / 头 / 正文)、authorize(每次授权请求的参数)。
 */
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';

export async function startOAuthServer({ dcr = true } = {}) {
  const st = {
    url: '', access: new Set(), refresh: new Set(), n: 0, refreshes: 0, failRefresh: false,
    /** @type {Array<{ path: string, headers: import('node:http').IncomingHttpHeaders, body: string }>} */ seen: [],
    /** @type {URLSearchParams[]} */ authorize: [],
    codes: new Map(),
    stop: async () => {},
  };
  const issue = () => {
    const n = ++st.n;
    st.access.add(`at-${n}`);
    st.refresh.add(`rt-${n}`);
    return { access_token: `at-${n}`, refresh_token: `rt-${n}`, token_type: 'Bearer', expires_in: 3600 };
  };
  const srv = createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const body = Buffer.concat(chunks).toString();
    const u = new URL(req.url, st.url);
    st.seen.push({ path: u.pathname, headers: req.headers, body });
    const json = (code, obj) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(obj)); };
    if (u.pathname === '/.well-known/oauth-authorization-server') {
      return json(200, {
        issuer: st.url, authorization_endpoint: `${st.url}/authorize`, token_endpoint: `${st.url}/token`,
        ...(dcr ? { registration_endpoint: `${st.url}/register` } : {}),
        response_types_supported: ['code'], grant_types_supported: ['authorization_code', 'refresh_token'],
        code_challenge_methods_supported: ['S256'], token_endpoint_auth_methods_supported: ['none'],
      });
    }
    if (u.pathname === '/register' && dcr) return json(201, { ...JSON.parse(body), client_id: 'dyn-client' });
    if (u.pathname === '/authorize') {
      st.authorize.push(u.searchParams);
      const code = `code-${++st.n}`;
      st.codes.set(code, { challenge: u.searchParams.get('code_challenge'), redirect: u.searchParams.get('redirect_uri') });
      res.writeHead(302, { location: `${u.searchParams.get('redirect_uri')}?code=${code}&state=${encodeURIComponent(u.searchParams.get('state') ?? '')}` });
      return res.end();
    }
    if (u.pathname === '/token') {
      const f = new URLSearchParams(body);
      if (f.get('grant_type') === 'authorization_code') {
        const c = st.codes.get(f.get('code') ?? '');
        st.codes.delete(f.get('code') ?? '');
        const pkce = c && createHash('sha256').update(f.get('code_verifier') ?? '').digest('base64url') === c.challenge;
        return pkce && f.get('redirect_uri') === c.redirect ? json(200, issue()) : json(400, { error: 'invalid_grant' });
      }
      if (f.get('grant_type') === 'refresh_token') {
        st.refreshes++;
        if (st.failRefresh || !st.refresh.delete(f.get('refresh_token') ?? '')) return json(400, { error: 'invalid_grant' });
        return json(200, issue());
      }
    }
    json(404, {});
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', () => r()));
  st.url = `http://127.0.0.1:${srv.address().port}`;
  st.stop = async () => { srv.closeAllConnections(); await new Promise((r) => srv.close(() => r())); };
  return st;
}

/** 「浏览器」:打开授权页(上面的假服务器直接 302 回回环)→ 跟到回调,返回回调页的状态码。 */
export async function browse(url) {
  const r = await fetch(url, { redirect: 'manual' });
  return (await fetch(r.headers.get('location'))).status;
}
