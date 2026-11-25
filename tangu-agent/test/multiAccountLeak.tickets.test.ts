/**
 * Multi-account mode: per-account model tickets (standalone/modelTickets.ts), through the real server brain.
 *
 * Unlike the other multiAccountLeak files this one does not inject a fake brain: the engine is assembled with
 * buildMultiAccountBaseBrain (what main.ts uses) and talks to a fake server that records every request it gets and the
 * Authorization it carried. TANGU_TOKEN is set as a negative control: the process token must never be sent.
 *
 *   - each account's model calls carry that account's ticket; another account never borrows it
 *   - a ticket issued for another account (userId ≠ X-Forsion-User) is dropped with one warning
 *   - no ticket / an expired ticket / no account in context → the call fails with "sign in again" and nothing is sent
 *   - the later-expiring ticket wins
 *   - the ticket header is taken off the request; the ticket is not in run events, messages, logs, files or script env
 *   - the model catalogue says "error" (not "no models") without a ticket, and catalogue caches are per account
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';

const env = await vi.hoisted(async () => {
  const fs = await import('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'tangu-ma-tickets-')));
  const home = path.join(root, 'home');
  const userHome = path.join(root, 'user-home');
  const tmp = path.join(root, 'tmp');
  const bundle = path.join(root, 'bundles', 'probe-plugin');
  for (const d of [home, userHome, tmp, bundle]) fs.mkdirSync(d, { recursive: true });
  for (const k of ['TANGU_DATABASE_URL', 'DATABASE_URL', 'TANGU_EMBED', 'TANGU_DATA_DIR', 'TANGU_BUNDLE_DIRS', 'TANGU_TOKEN_FILE', 'TANGU_CLOUD_URL']) delete process.env[k];
  process.env.TANGU_MULTI_ACCOUNT = '1';
  process.env.TANGU_HOME = home;
  process.env.TANGU_LOCAL_TOKEN = 'multi-account-local-host-token-qwertyuiop';
  process.env.TANGU_TOKEN = 'PROCESS-TOKEN-must-never-be-sent';
  process.env.HOME = userHome;
  process.env.TMPDIR = tmp;
  return { root, home, bundle };
});

import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { Client, grepTree, LOCAL_TOKEN, randomUUID } from './helpers/multiAccountHarness.js';

const ALICE = 'alice';
const BOB = 'bob';
const CAROL = 'carol';
const DAVE = 'dave';
const MODEL = 'cloud-model';
const SKILL = 'probe-skill';

// ── fake server ─────────────────────────────────────────────────────────────────────────────────────────────────
interface Seen { at: number; method: string; path: string; auth: string; body: string }
const seen: Seen[] = [];
let server: http.Server;
let cloudUrl = '';

function sse(res: http.ServerResponse, frames: unknown[]): void {
  res.writeHead(200, { 'Content-Type': 'text/event-stream' });
  for (const f of frames) res.write(`data: ${JSON.stringify(f)}\n\n`);
  res.end();
}

function startServer(): Promise<void> {
  server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      const url = new URL(req.url || '/', 'http://x');
      seen.push({ at: Date.now(), method: req.method || '', path: url.pathname, auth: String(req.headers.authorization || ''), body });
      const json = (status: number, v: unknown) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(v)); };
      if (url.pathname === '/api/brain/models') {
        return json(200, { models: [{ id: MODEL, name: 'Cloud model', provider: 'forsion', modelType: 'llm' }], defaultModelId: MODEL, backgroundModelId: MODEL });
      }
      if (url.pathname === '/api/brain/llm/resolve') {
        return json(200, { model: { id: MODEL, name: 'Cloud model', provider: 'forsion', context_window: 200_000, contextWindow: 200_000, max_tokens: 8192 }, apiModelId: MODEL });
      }
      if (url.pathname === '/api/brain/llm/build-and-stream') {
        let parsed: any = {};
        try { parsed = JSON.parse(body); } catch { /* keep {} */ }
        const messages: any[] = Array.isArray(parsed.messages) ? parsed.messages : [];
        const text = JSON.stringify(messages);
        const hasToolResult = messages.some((m) => m?.role === 'tool');
        if (text.includes('CALL-THE-SCRIPT') && !hasToolResult) {
          return sse(res, [{ t: 'done', content: '', toolCalls: [{ id: 'call_1', type: 'function', function: { name: 'run_plugin_script', arguments: JSON.stringify({ skill: SKILL, script: 'scripts/env.mjs' }) } }], usage: { prompt_tokens: 1, completion_tokens: 1 }, finishReason: 'tool_calls' }]);
        }
        return sse(res, [{ t: 'token', d: 'CLOUD-REPLY' }, { t: 'done', content: 'CLOUD-REPLY', toolCalls: [], usage: { prompt_tokens: 1, completion_tokens: 1 }, finishReason: 'stop' }]);
      }
      json(404, { detail: 'not found' });
    });
  });
  return new Promise((done) => server.listen(0, '127.0.0.1', () => { cloudUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; done(); }));
}

// ── tickets ─────────────────────────────────────────────────────────────────────────────────────────────────────
const b64 = (v: unknown) => Buffer.from(JSON.stringify(v)).toString('base64url');
let jti = 0;
const ticket = (userId: string, ttlSec = 3600, extra: Record<string, unknown> = {}) =>
  `${b64({ alg: 'HS256', typ: 'JWT' })}.${b64({ scope: 'model-ticket', aud: 'forsion:model-ticket', userId, unit: 'unit-1', jti: `j${++jti}`, exp: Math.floor(Date.now() / 1000) + ttlSec, ...extra })}.c2lnbmF0dXJl${jti}`;
const withTicket = (t: string) => ({ 'X-Forsion-Model-Ticket': t });

// ── console capture (the ticket must not reach a log line) ─────────────────────────────────────────────────────
const logged: string[] = [];
const warnings: string[] = [];
for (const level of ['log', 'info', 'warn', 'error', 'debug'] as const) {
  const orig = console[level].bind(console);
  (console as any)[level] = (...args: unknown[]) => {
    const line = args.map((a) => { try { return typeof a === 'string' ? a : JSON.stringify(a); } catch { return String(a); } }).join(' ');
    logged.push(line);
    if (level === 'warn') warnings.push(line);
    orig(...args);
  };
}

let app: any;
let listener: http.Server;
let c: Client;
let dispose: () => Promise<void>;
let deps: () => any;
let scope: any;
let tickets: any;

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
/** Waits until the server has seen nothing new for a while (background title / memory calls of the last run). */
async function quiet(ms = 1200): Promise<void> {
  let n = -1;
  for (let i = 0; i < 40 && n !== seen.length; i++) { n = seen.length; await sleep(ms / 4); if (n === seen.length) await sleep(ms); }
}

async function run(user: string, message: string, headers: Record<string, string> = {}) {
  const sessionId = randomUUID();
  const resp = await c.call(user, 'POST', '/agent/runs', { body: { session_id: sessionId, model_id: MODEL, message }, headers });
  expect(resp.status, resp.text).toBe(200);
  const follow = await c.follow(user, resp.json.runId, { timeoutMs: 45_000 });
  return { sessionId, runId: resp.json.runId as string, follow };
}

beforeAll(async () => {
  writeFileSync(join(env.bundle, 'manifest.json'), JSON.stringify({ id: 'probe-plugin', name: 'Probe plugin', version: '1.0.0' }));
  mkdirSync(join(env.bundle, 'skills', SKILL, 'scripts'), { recursive: true });
  writeFileSync(join(env.bundle, 'skills', SKILL, 'SKILL.md'), '---\nname: probe-skill\ndescription: prints its environment\n---\nRun scripts/env.mjs.\n');
  writeFileSync(join(env.bundle, 'skills', SKILL, 'scripts', 'env.mjs'), 'console.log("SCRIPT-ENV " + JSON.stringify(process.env)); console.log("SCRIPT-ENV-KEYS " + Object.keys(process.env).join(","));');
  await startServer();
  const { parseConfig } = await import('../src/standalone/config.js');
  const { buildMultiAccountBaseBrain } = await import('../src/standalone/assemble.js');
  const { createMultiAccountApp } = await import('../src/standalone/multiAccount.js');
  deps = (await import('../src/seams/runtime.js')).deps;
  scope = await import('../src/core/accountScope.js');
  tickets = await import('../src/standalone/modelTickets.js');
  const cfg = parseConfig(['--cloud-url', cloudUrl], { configFile: false });
  expect(cfg.token).toBe('PROCESS-TOKEN-must-never-be-sent'); // the negative control is really configured
  const created = await createMultiAccountApp({ localToken: LOCAL_TOKEN, brain: buildMultiAccountBaseBrain(cfg), defaultModelId: MODEL, bundleDirs: [env.bundle] });
  app = created.app;
  dispose = created.dispose;
  listener = app.listen(0, '127.0.0.1');
  await new Promise<void>((r) => listener.once('listening', () => r()));
  c = new Client(`http://127.0.0.1:${(listener.address() as AddressInfo).port}`);
}, 60_000);

afterAll(async () => {
  try { (listener as any)?.closeAllConnections?.(); } catch { /* ignore */ }
  await new Promise<void>((r) => (listener ? listener.close(() => r()) : r()));
  await dispose?.();
  await new Promise<void>((r) => server.close(() => r()));
  rmSync(env.root, { recursive: true, force: true });
});

describe('multi-account: model tickets', () => {
  const aliceTicket = { value: '' };

  it('alice: her run, her catalogue and her background calls all carry her ticket, never the process token', async () => {
    aliceTicket.value = ticket(ALICE);
    const from = seen.length;
    const models = await c.call(ALICE, 'GET', '/agent/models', { headers: withTicket(aliceTicket.value) });
    expect(models.status).toBe(200);
    expect(models.json.forsion.status).toBe('ok');
    expect(models.json.models.map((m: any) => m.id)).toContain(MODEL);
    const r = await run(ALICE, 'Say hello.');
    expect(r.follow.status, JSON.stringify(r.follow.events.filter((e) => e.type === 'error'))).toBe('done');
    expect(r.follow.text).toContain('CLOUD-REPLY');
    await quiet();
    const mine = seen.slice(from);
    expect(mine.length).toBeGreaterThan(0);
    expect(mine.filter((s) => s.auth !== `Bearer ${aliceTicket.value}`).map((s) => `${s.path} ${s.auth.slice(0, 20)}`)).toEqual([]);
    expect(seen.some((s) => s.auth.includes('PROCESS-TOKEN'))).toBe(false);
  }, 60_000);

  it('bob without a ticket: the run fails with "sign in again" and nothing is sent; the catalogue reports an error, not "no models"', async () => {
    const from = seen.length;
    const r = await run(BOB, 'Say hello.');
    expect(r.follow.status).toBe('error');
    expect(JSON.stringify(r.follow.events.filter((e) => e.type === 'error'))).toContain(tickets.NO_MODEL_TICKET);
    const models = await c.call(BOB, 'GET', '/agent/models');
    expect(models.json.forsion.status).toBe('error');
    expect(models.json.forsion.detail).toContain('sign in again');
    await quiet();
    expect(seen.slice(from)).toEqual([]);
  }, 60_000);

  it('bob holding alice\'s ticket: dropped with one warning, his run fails, her ticket is never sent for him', async () => {
    const from = seen.length;
    const warned = warnings.length;
    await c.call(BOB, 'GET', '/agent/sessions', { headers: withTicket(aliceTicket.value) });
    await c.call(BOB, 'GET', '/agent/sessions', { headers: withTicket(aliceTicket.value) });
    const r = await run(BOB, 'Say hello.', withTicket(aliceTicket.value));
    expect(r.follow.status).toBe('error');
    expect(JSON.stringify(r.follow.events)).toContain(tickets.NO_MODEL_TICKET);
    await quiet();
    expect(seen.slice(from)).toEqual([]);
    const mine = warnings.slice(warned).filter((w) => w.includes('model ticket'));
    expect(mine).toHaveLength(1);
    expect(mine[0]).toContain(BOB);
  }, 60_000);

  it('bob with his own ticket works; alice\'s stored ticket is still hers and never used for bob', async () => {
    const bobTicket = ticket(BOB);
    const from = seen.length;
    const r = await run(BOB, 'Say hello.', withTicket(bobTicket));
    expect(r.follow.status, JSON.stringify(r.follow.events.filter((e) => e.type === 'error'))).toBe('done');
    await quiet();
    const sent = seen.slice(from);
    expect(sent.length).toBeGreaterThan(0);
    expect(sent.every((s) => s.auth === `Bearer ${bobTicket}`)).toBe(true);
    // alice, no header this time: her stored ticket
    const from2 = seen.length;
    const a = await run(ALICE, 'Again.');
    expect(a.follow.status).toBe('done');
    await quiet();
    expect(seen.slice(from2).every((s) => s.auth === `Bearer ${aliceTicket.value}`)).toBe(true);
  }, 90_000);

  it('the later-expiring ticket wins; an expired one or one about to expire is not used', async () => {
    const late = ticket(CAROL, 7200);
    const early = ticket(CAROL, 1800);
    await c.call(CAROL, 'GET', '/agent/sessions', { headers: withTicket(late) });
    await c.call(CAROL, 'GET', '/agent/sessions', { headers: withTicket(early) });
    const from = seen.length;
    expect((await run(CAROL, 'Hi.')).follow.status).toBe('done');
    await quiet();
    expect(seen.slice(from).every((s) => s.auth === `Bearer ${late}`)).toBe(true);

    // dave: an expired ticket is refused; one with seconds left is kept but not sent
    const from2 = seen.length;
    await c.call(DAVE, 'GET', '/agent/sessions', { headers: withTicket(ticket(DAVE, -60)) });
    expect((await run(DAVE, 'Hi.')).follow.status).toBe('error');
    await c.call(DAVE, 'GET', '/agent/sessions', { headers: withTicket(ticket(DAVE, 3)) });
    expect((await run(DAVE, 'Hi.')).follow.status).toBe('error');
    // not a model ticket at all (no scope): dropped
    await c.call(DAVE, 'GET', '/agent/sessions', { headers: withTicket(ticket(DAVE, 3600, { scope: 'user' })) });
    expect((await run(DAVE, 'Hi.')).follow.status).toBe('error');
    await quiet();
    expect(seen.slice(from2)).toEqual([]);
  }, 90_000);

  it('a model call outside any account context, or in an account without a ticket, fails before anything is sent', async () => {
    const from = seen.length;
    const brain = deps().brain;
    await expect(brain.llm.resolveModelAndKey(MODEL)).rejects.toMatchObject({ status: 401, message: tickets.NO_ACCOUNT_FOR_MODEL_CALL });
    await expect(brain.models.listGlobalModels()).rejects.toMatchObject({ status: 401 });
    await expect(scope.runWithAccount('erin', () => brain.llm.resolveModelAndKey(MODEL))).rejects.toMatchObject({ status: 401, message: tickets.NO_MODEL_TICKET });
    await expect(scope.runWithAccount('erin', () => brain.llm.streamProviderCompletion({ apiKey: '', baseUrl: '', payload: { __forsion_lazy_build: true, modelId: MODEL, messages: [] } }))).rejects.toMatchObject({ status: 401 });
    // the raw ticket credential itself, outside the account guard
    expect(() => tickets.currentModelTicket()).toThrow(tickets.NO_ACCOUNT_FOR_MODEL_CALL);
    expect(seen.slice(from)).toEqual([]);
  });

  it('the ticket is taken off the request and appears in no event, message, log line, file or script environment', async () => {
    const t = ticket(ALICE, 7000); // expires later than her first one, so it replaces it
    const r = await run(ALICE, 'CALL-THE-SCRIPT now.', withTicket(t));
    expect(r.follow.status, JSON.stringify(r.follow.events.filter((e) => e.type === 'error'))).toBe('done');
    await quiet();
    const messages = await c.call(ALICE, 'GET', `/agent/sessions/${r.sessionId}/messages`);
    const transcript = messages.text;
    expect(transcript).toContain('SCRIPT-ENV'); // the script really ran and printed its environment
    const scriptEnv = transcript.slice(transcript.indexOf('SCRIPT-ENV'));
    for (const value of [t, aliceTicket.value]) {
      expect(r.follow.text).not.toContain(value);
      expect(transcript).not.toContain(value);
      expect(scriptEnv).not.toContain(value);
      expect(logged.join('\n')).not.toContain(value);
      expect(grepTree(env.root, [value])).toEqual([]);
    }
    const keys = /SCRIPT-ENV-KEYS ([A-Za-z0-9_,]+)/.exec(transcript)?.[1] ?? '';
    expect(keys).toContain('PATH');
    expect(keys.split(',').filter((k) => /TICKET|TOKEN|TANGU_/i.test(k))).toEqual([]);
    expect(seen.at(-1)!.auth).toBe(`Bearer ${t}`);
  }, 60_000);

  it('the background model catalogue cache is per account: another account\'s fetch is never served, a failed fetch is not kept', async () => {
    const { resolveBackgroundModelId, __resetBackgroundSlotCacheForTests } = await import('../src/services/specialAgentsConfig.js');
    __resetBackgroundSlotCacheForTests();
    await c.call('frank', 'GET', '/agent/sessions'); // opens frank's account, no ticket yet
    await scope.runWithAccount(ALICE, () => resolveBackgroundModelId(''));
    const from = seen.length;
    expect(await scope.runWithAccount('frank', () => resolveBackgroundModelId(''))).toBe(MODEL);
    expect(seen.slice(from)).toEqual([]);
    const frankTicket = ticket('frank');
    await c.call('frank', 'GET', '/agent/sessions', { headers: withTicket(frankTicket) });
    await scope.runWithAccount('frank', () => resolveBackgroundModelId(''));
    const fetched = seen.slice(from).filter((s) => s.path === '/api/brain/models');
    expect(fetched.length).toBeGreaterThan(0);
    expect(fetched.every((s) => s.auth === `Bearer ${frankTicket}`)).toBe(true);
  });

  it('takeModelTicket strips the header and the raw header pair', () => {
    const t = ticket(ALICE);
    const req = { headers: { 'x-forsion-model-ticket': t, 'x-forsion-user': ALICE } as Record<string, unknown>, rawHeaders: ['X-Forsion-User', ALICE, 'X-Forsion-Model-Ticket', t, 'Accept', '*/*'] };
    tickets.takeModelTicket(req, ALICE);
    expect(req.headers).toEqual({ 'x-forsion-user': ALICE });
    expect(req.rawHeaders).toEqual(['X-Forsion-User', ALICE, 'Accept', '*/*']);
  });
});
