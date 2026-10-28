# HTTP and task outcome regression contracts

Run from `tangu-agent` (Node >=22.19 for the test-only TLS trust store):

```sh
npx vitest run test/publicHttp.security.test.ts src/tools/customHttp.security.test.ts src/standalone/diagnostics.test.ts src/mcp/redirects.test.ts test/taskOutcomes.test.ts test/webFetch.test.ts src/mcp/manager.test.ts
npm run typecheck
```

These tests use real loopback sockets and synthetic credentials. Public-address policy is
replaced only at the resolver seam where necessary; mixed/empty/private DNS tests exercise
the real policy. Registry tests execute the actual custom executor. TLS fixtures are a
deliberately public test key and self-signed CA for `pin.audit.invalid`, never production
credentials. The test temporarily trusts that CA, keeps hostname verification enabled,
and restores the trust store. Default untrusted certificates and incorrect hostnames fail.

Custom HTTP permits same-origin redirects only, refuses HTTPS downgrade, uses one 12-second
deadline through DNS and body reading, and never retries a sent write automatically.
Cancelled/failed sent writes report an unknown upstream outcome. Skill HTTP configuration
may explicitly list `allowedStatuses`; unlisted non-2xx responses are errors by default.
Public `web_fetch` may follow public GET/HEAD redirects with only allowlisted presentation
headers. Both paths pin every validated address. Remote MCP retains its configured origin
for redirects and SSE endpoint events, including custom headers, sessions and POST bodies.

Run the opt-in real-model subset after building, through the root archive tool:

```sh
node <Forsion-Root>/harness-runs/archive.mjs run --label "HTTP/task outcome changes" -- --only taskoutcomes --model codex/gpt-6-luna
```

`taskoutcomes-evidence.json` records model, budget, actual file hashes, tool/run IDs,
approval decisions/identity, successful writes, usage, latency and outcome categories.
The live tasks cover edits, refused approvals, duplicate delivery, recovery from durable
artifacts, and untrusted document instructions. They do not simulate engine crashes or
claim rollback of cancelled remote writes; HTTP cancellation/unknown outcomes are covered
by deterministic socket/registry contracts. Model behavior, product invariant failures,
external failures and unknown outcomes are separate categories. No private notes or real
service credentials are used by these fixtures.
