# Network requests: CSP, CORS and ctx.net

SKILL.md, section 库内二进制资源 + 第三方库进包, has the short version: the desktop CSP blocks scripts from other sites, not requests; an https API that sends CORS headers works with plain `fetch`; one without fails because of CORS. This file is the `ctx.net` contract for the second case.

## ctx.net (2026-11-16+)

**`ctx.net` (`PluginNetApi`, 2026-11-16+, desktop only; absent on web, mobile and older hosts → `if (ctx.net)`)**: the main process makes the request for APIs without CORS headers. Manifest: `"network": ["api.example.com", "*.cdn.example.com"]` (host names only, no scheme / port / path; `*.example.com` covers subdomains at any depth but not `example.com` itself; re-read from the manifest on disk for every request; users see "Accesses: …" on the plugin's page, not yet before a store install).

```js
const res = await ctx.net.request('https://api.example.com/v1/items', { method: 'POST', headers: { Authorization: `Bearer ${key}` }, body: JSON.stringify(q), timeoutMs: 20_000 })
if (res.status !== 200) throw new Error(`HTTP ${res.status}`)   // 4xx / 5xx resolve; only transport problems reject
const data = res.json()                                          // also res.text(), res.bytes, res.headers (lower-case), res.url (after redirects)
```

Enforced per hop: https on the default port (443) only; IP literals and names resolving (at connect) to loopback / private / reserved addresses are refused; at most 5 redirects, each re-checked against the list (Authorization / Cookie dropped when the host changes); app cookies, proxy credentials and client certificates are never sent (send your own `Authorization`); response ≤ 10 MB after decompression; `timeoutMs` default 30 s, max 60 s; at most 8 requests in flight per plugin; in-flight requests reject when the plugin is disabled. Failures reject an `Error` with `err.code`: `net_domain_not_declared` / `net_blocked_address` / `net_timeout` / `net_too_large` / `net_bad_url` / `net_bad_request` (unsupported method, body on GET, a header the host sets itself) / `net_failed` (DNS, TLS, more than 5 redirects, too many in flight; see `err.message`).
