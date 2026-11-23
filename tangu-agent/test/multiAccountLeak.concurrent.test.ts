/**
 * Multi-account mode: two accounts at the same time, with colliding ids.
 *
 * alice and bob create the same agent slug, skill slug, upload name and relative file path, each with their own
 * content, then run concurrently in their own sessions — interleaved step by step through barriers inside the fake
 * model. Session ids are one namespace across accounts: two accounts claiming the same new id at once get one 200
 * and one 404, and the engine-level registry of who owns which id holds nothing else.
 * Anything process-wide that is keyed without the account (run queues, session maps, caches, "current account"
 * leaking across awaits) shows up as cross-talk, or as one run waiting for the other (a barrier timeout).
 * Also: a new account's first requests arriving all at once are served and provision one folder.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';

const env = await vi.hoisted(async () => {
  const fs = await import('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'tangu-ma-conc-')));
  const home = path.join(root, 'home');
  const userHome = path.join(root, 'user-home');
  const tmp = path.join(root, 'tmp');
  for (const d of [home, userHome, tmp]) fs.mkdirSync(d, { recursive: true });
  for (const k of ['TANGU_DATABASE_URL', 'DATABASE_URL', 'TANGU_EMBED', 'TANGU_DATA_DIR', 'TANGU_BUNDLE_DIRS']) delete process.env[k];
  process.env.TANGU_MULTI_ACCOUNT = '1';
  process.env.TANGU_HOME = home;
  process.env.TANGU_LOCAL_TOKEN = 'multi-account-local-host-token-qwertyuiop';
  process.env.HOME = userHome;
  process.env.TMPDIR = tmp;
  return { root, home };
});

vi.mock('node:child_process', async (orig) => (await import('./helpers/multiAccountSpawnSpy.js')).wrapChildProcess(await orig()));
vi.mock('child_process', async (orig) => (await import('./helpers/multiAccountSpawnSpy.js')).wrapChildProcess(await orig()));

import Database from 'better-sqlite3';
import { existsSync, readdirSync, rmSync, statSync, utimesSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import {
  MODEL_ID, OWNER_REGISTRY_FILE, OWNER_REGISTRY_RE, bootMultiAccount, canary, ownerRegistryProblems, describeResp, diffSnaps, findFile, findFilesContaining, grepTree, leakHits, randomUUID, respLeaks,
  startRun, steps, waitQuiet, type MaEngine, type Script, type ScriptCtx, type ToolCallSpec,
} from './helpers/multiAccountHarness.js';
import { spawnLog } from './helpers/multiAccountSpawnSpy.js';

const ACCOUNTS = ['alice', 'bob'] as const;
type Acct = (typeof ACCOUNTS)[number];
const other = (a: Acct): Acct => (a === 'alice' ? 'bob' : 'alice');
const accDir = (id: string) => join(env.home, 'accounts', id);
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** each account's own session id (UUID): session ids are one namespace across accounts, so they cannot collide */
const SESS = { alice: randomUUID(), bob: randomUUID() } as Record<'alice' | 'bob', string>;
const SHARED_AGENT = 'shared-agent';
const TWIN_AGENT = 'twin-agent';
const SHARED_SKILL = 'shared-skill';
const SHARED_FILE = 'shared-run.txt';
const K = Object.fromEntries(ACCOUNTS.map((a) => [a, {
  persona: canary(a, 'persona'), skill: canary(a, 'skill'), mem: canary(a, 'memoryhttp'), memTool: canary(a, 'memorytool'),
  upload: canary(a, 'upload'), file: canary(a, 'file'), msg: canary(a, 'message'), reply: canary(a, 'reply'),
  msg2: canary(a, 'messagetwo'), reply2: canary(a, 'replytwo'),
}])) as unknown as Record<Acct, Record<string, string>>;

let E: MaEngine;
const warnings: string[] = [];

function barrier(parties: number, timeoutMs = 8000) {
  const waits = new Map<string, { n: number; p: Promise<void>; release: () => void }>();
  const timeouts: string[] = [];
  return {
    timeouts,
    async wait(name: string, who: string): Promise<void> {
      let w = waits.get(name);
      if (!w) {
        let release!: () => void;
        const p = new Promise<void>((r) => { release = r; });
        w = { n: 0, p, release };
        waits.set(name, w);
      }
      w.n++;
      if (w.n >= parties) w.release();
      const ok = await Promise.race([w.p.then(() => true), sleep(timeoutMs).then(() => false)]);
      if (!ok) timeouts.push(`${name} (${who})`);
    },
  };
}

beforeAll(async () => {
  E = await bootMultiAccount();
}, 120_000);
afterAll(async () => {
  try { await E?.dispose(); } catch { /* ignore */ }
  if (warnings.length) console.warn(`[multi-account concurrency] coverage notes:\n  - ${warnings.join('\n  - ')}`);
  try { rmSync(env.root, { recursive: true, force: true }); } catch { /* ignore */ }
});

describe('multi-account mode: concurrent accounts with colliding names', () => {
  it('both accounts create the same agent / skill / file names with their own content, at the same time', async () => {
    const c = E.client;
    const allowed = (m: string, p: string) => E.routeAllowlist.some((e) => e.method.toUpperCase() === m && e.path === p);
    const httpSkills = allowed('POST', '/agent/skills/catalog');
    const httpUpload = allowed('POST', '/agent/workspace/upload');
    const mk = new Map<Acct, Script>();
    const results = await Promise.all(ACCOUNTS.map(async (a) => {
      const rs = await Promise.all([
        c.call(a, 'POST', '/agent/agents', { body: { slug: SHARED_AGENT, name: 'Shared agent', nameEn: 'Shared agent', systemPrompt: `Persona ${K[a].persona}` } }),
        ...(httpSkills ? [c.call(a, 'POST', '/agent/skills/catalog', { body: { scope: 'user', slug: SHARED_SKILL, name: 'Shared skill', description: 'shared', content: `Body ${K[a].skill}` } })] : []),
        c.call(a, 'POST', '/agent/memory', { body: { text: `Fact ${K[a].mem}` } }),
        ...(httpUpload ? [c.call(a, 'POST', '/agent/workspace/upload', { body: { sessionId: SESS[a], files: [{ path: 'shared-upload.txt', content: `Upload ${K[a].upload}` }] } })] : []),
      ]);
      // without the catalog route the same skill slug is created by each account's own run
      if (!httpSkills) {
        const s = E.fake.script(a, 'mkskill', steps([
          (ctx) => ({ calls: !ctx.offered.has('manage_skill') && ctx.offered.has('load_tools') ? [{ name: 'load_tools', args: { names: ['manage_skill'] } }] : [] }),
          { calls: [{ name: 'manage_skill', args: { action: 'create', slug: SHARED_SKILL, name: 'Shared skill', description: 'shared', instructions: `Body ${K[a].skill}` } }] },
        ], 'skill made'));
        const st = await startRun(c, a, s, { text: 'make the skill' });
        if (st.runId) await c.follow(a, st.runId, { timeoutMs: 30_000 });
        mk.set(a, s);
      }
      return rs.map((r) => [a, r] as const);
    }));
    for (const [a, r] of results.flat()) expect(r.status, `${a}: ${describeResp(r)}`).toBeLessThan(300);
    for (const a of ACCOUNTS) {
      expect(findFilesContaining(accDir(a), K[a].persona).length, `${a} persona on disk`).toBeGreaterThan(0);
      expect(findFilesContaining(accDir(a), K[a].skill).length, `${a} skill on disk ${JSON.stringify(mk.get(a)?.results ?? [])}`).toBeGreaterThan(0);
      const mem = await c.call(a, 'GET', '/agent/memory');
      expect(respLeaks(mem, [K[a].mem]), `${a} sees own memory`).toEqual([K[a].mem]);
      expect(respLeaks(mem, Object.values(K[other(a)])), `${a} memory shows the other account`).toEqual([]);
      if (httpUpload) {
        expect(findFilesContaining(accDir(a), K[a].upload).length, `${a} upload on disk`).toBeGreaterThan(0);
        const ws = await c.call(a, 'GET', '/agent/workspace/read', { query: { sessionId: SESS[a], path: 'shared-upload.txt' } });
        expect(respLeaks(ws, [K[a].upload]), `${a} reads own upload`).toEqual([K[a].upload]);
        expect(respLeaks(ws, Object.values(K[other(a)])), `${a} upload shows the other account`).toEqual([]);
      }
    }
  }, 120_000);

  it('runs of both accounts interleave step by step, each in its own session, and stay apart', async () => {
    const c = E.client;
    const bar = { own: barrier(2), fresh: barrier(2) };
    const plan = (a: Acct, pair: 'own' | 'fresh', reply: string) => async (ctx: ScriptCtx) => {
      const b = bar[pair];
      if (ctx.step === 0) {
        await b.wait('step0', a);
        return { calls: [
          ...(ctx.offered.has('write_file') ? [{ name: 'write_file', args: { path: SHARED_FILE, content: `File ${K[a].file}` } }] : []),
          ...(ctx.offered.has('remember') ? [{ name: 'remember', args: { action: 'add', fact: `Likes ${K[a].memTool}.` } }] : []),
        ] as ToolCallSpec[] };
      }
      if (ctx.step === 1) {
        await b.wait('step1', a);
        const mine = findFile(accDir(a), K[a].file, SHARED_FILE);
        const theirs = mine ? mine.replace(`/accounts/${a}/`, `/accounts/${other(a)}/`) : join(accDir(other(a)), 'workspace', SHARED_FILE);
        return { calls: [
          ...(ctx.offered.has('read_file') ? [
            { name: 'read_file', args: { path: SHARED_FILE } },
            { name: 'read_file', args: { path: theirs } },
            { name: 'read_file', args: { path: mine ? relative(join(mine, '..'), theirs) : `../../${other(a)}/workspace/${SHARED_FILE}` } },
          ] : []),
          ...(ctx.offered.has('use_skill') ? [{ name: 'use_skill', args: { skill_id: `local:${SHARED_SKILL}` } }] : []),
        ] as ToolCallSpec[] };
      }
      if (ctx.step === 2) await b.wait('step2', a);
      return { text: `Reply ${reply}` };
    };
    // "own": each account's own UUID session, created in the first test (upload) or here; "fresh": a new UUID each
    const starts = await Promise.all(ACCOUNTS.flatMap((a) => [
      (async () => {
        const s = E.fake.script(a, 'own', plan(a, 'own', K[a].reply));
        return [a, 'own', s, await startRun(c, a, s, { sessionId: SESS[a], text: `Hello ${K[a].msg}`, agentConfig: { agentSlug: SHARED_AGENT } })] as const;
      })(),
      (async () => {
        const s = E.fake.script(a, 'fresh', plan(a, 'fresh', K[a].reply2));
        return [a, 'fresh', s, await startRun(c, a, s, { text: `Again ${K[a].msg2}` })] as const;
      })(),
    ]));
    // all four must start: the interleave below is the point of this test
    for (const [a, label, , st] of starts) expect(st.runId, `${a}/${label}: could not start: ${describeResp(st.resp)}`).toBeTruthy();
    const follows = await Promise.all(starts.map(async ([a, label, s, st]) => [a, label, s, st, await c.follow(a, st.runId!, { timeoutMs: 90_000 })] as const));
    for (const p of ['own', 'fresh'] as const) expect(bar[p].timeouts, `${p}: a run waited for the other account (serialized across accounts)`).toEqual([]);
    const problems: string[] = [];
    for (const [a, label, s, , f] of follows) {
      const mineK = K[a], theirsK = Object.values(K[other(a)]);
      if (f.status !== 'done') problems.push(`${a}/${label}: ${f.status} ${f.text.slice(-300)}`);
      if (s.requests.length < 3) problems.push(`${a}/${label}: only ${s.requests.length} model calls — the step-by-step interleave did not happen`);
      if (!f.final.includes(label === 'own' ? mineK.reply : mineK.reply2)) problems.push(`${a}/${label}: final reply is not its own: ${f.final.slice(0, 200)}`);
      if (respLeaks({ seq: 0, user: a, method: 'GET', url: '', status: 200, contentType: 'text/event-stream', text: f.text, json: f.events, sent: '', events: f.events }, theirsK).length) problems.push(`${a}/${label}: event stream shows the other account`);
      const sent = s.requests.map((r) => r.text).join('\n');
      const leaked = leakHits(sent, theirsK);
      if (leaked.length) problems.push(`${a}/${label}: model saw ${leaked.join(', ')}`);
      if (label === 'own' && !sent.includes(mineK.persona)) warnings.push(`${a}: the shared-agent persona did not reach the model (agentSlug knob unsupported?)`);
      for (const r of s.requests) {
        if (r.ctxAccount !== undefined && r.ctxAccount !== a) problems.push(`${a}/${label}: model called in account context ${r.ctxAccount}`);
        if (r.markerAccounts.some((m) => m !== a)) problems.push(`${a}/${label}: request carries markers of ${r.markerAccounts.join(', ')}`);
      }
      for (const res of s.results) {
        if (leakHits(res.output, theirsK).length) problems.push(`${a}/${label}: ${res.name}(${JSON.stringify(res.args)}) → ${res.output.slice(0, 200)}`);
        if (res.name === 'read_file' && res.args.path === SHARED_FILE && !res.output.includes(mineK.file)) problems.push(`${a}/${label}: read its own ${SHARED_FILE} → ${res.output.slice(0, 200)}`);
        if (res.name === 'use_skill' && !res.output.includes(mineK.skill)) problems.push(`${a}/${label}: use_skill gave ${res.output.slice(0, 200)}`);
      }
    }
    expect.soft(problems).toEqual([]);

    // each account's stored view: its own session, history, memory and files — and nothing of the other's
    for (const a of ACCOUNTS) {
      const theirsK = Object.values(K[other(a)]);
      for (const r of [
        await c.call(a, 'GET', `/agent/sessions/${SESS[a]}/messages`),
        await c.call(a, 'GET', '/agent/memory'),
        await c.call(a, 'GET', '/agent/sessions'),
        await c.call(a, 'GET', '/agent/agents'),
        await c.call(a, 'GET', '/agent/skills'),
      ]) expect.soft(respLeaks(r, theirsK), describeResp(r)).toEqual([]);
      const msgs = await c.call(a, 'GET', `/agent/sessions/${SESS[a]}/messages`);
      expect.soft(respLeaks(msgs, [K[a].msg, K[a].reply]).sort(), `${a} keeps its own history`).toEqual([K[a].msg, K[a].reply].sort());
      const mem = await c.call(a, 'GET', '/agent/memory');
      if (starts.find(([x, l]) => x === a && l === 'own')![2].called.has('remember')) expect.soft(respLeaks(mem, [K[a].memTool]), `${a} keeps its own remembered fact`).toEqual([K[a].memTool]);
      const theirSession = await c.call(a, 'GET', `/agent/sessions/${SESS[other(a)]}/messages`);
      expect.soft(theirSession.status, `${a} reading ${other(a)}'s session: ${describeResp(theirSession)}`).toBe(404);
    }
    await waitQuiet(env.root, () => E.fake.outbound.length);
    for (const a of ACCOUNTS) {
      const stray = grepTree(env.root, Object.values(K[a]), (rel) => rel.startsWith(`home/accounts/${a}/`));
      expect.soft(stray.map((s) => `${s.needle} in ${s.file}`), `${a}'s content outside accounts/${a}`).toEqual([]);
    }
  }, 240_000);

  it('both accounts claim the same new session id at the same moment: exactly one gets it (200), the other 404, never 500', async () => {
    const c = E.client;
    const problems: string[] = [];
    const won = new Map<string, Acct>();
    for (let round = 0; round < 6; round++) {
      const sid = randomUUID();
      const msg = Object.fromEntries(ACCOUNTS.map((a) => [a, canary(a, `race${round}`)])) as Record<Acct, string>;
      const scripts = Object.fromEntries(ACCOUNTS.map((a) => [a, E.fake.script(a, `race${round}`, steps([], `Race reply ${msg[a]}`))])) as Record<Acct, Script>;
      // alternate who fires first, so the result does not just follow request order
      const order = round % 2 ? [...ACCOUNTS].reverse() : [...ACCOUNTS];
      const res = await Promise.all(order.map((a) => startRun(c, a, scripts[a], { sessionId: sid, text: `Race ${msg[a]}` }).then((st) => [a, st] as const)));
      const statuses = res.map(([a, st]) => `${a}:${st.resp.status}`);
      const winners = res.filter(([, st]) => st.resp.status === 200);
      const losers = res.filter(([, st]) => st.resp.status === 404);
      if (winners.length !== 1 || losers.length !== 1) { problems.push(`round ${round}: ${statuses.join(' ')} (expected one 200 and one 404)\n${res.map(([, st]) => describeResp(st.resp)).join('\n')}`); continue; }
      const [w, wst] = winners[0], [l, lst] = losers[0];
      won.set(sid, w);
      const f = await c.follow(w, wst.runId!, { timeoutMs: 30_000 });
      if (f.status !== 'done') problems.push(`round ${round}: winner ${w} run ${f.status}`);
      if (lst.runId || scripts[l].requests.length) problems.push(`round ${round}: loser ${l} still got a run / model call`);
      if (leakHits(lst.resp.text, [msg[w], ...Object.values(K[w])]).length || lst.resp.text.includes(w)) problems.push(`round ${round}: ${l}'s 404 mentions ${w}: ${lst.resp.text.slice(0, 200)}`);
      const wm = await c.call(w, 'GET', `/agent/sessions/${sid}/messages`);
      if (!wm.text.includes(msg[w])) problems.push(`round ${round}: ${w}'s own message is missing from the session it won`);
      if (leakHits(wm.text, [msg[l]]).length) problems.push(`round ${round}: ${l}'s message landed in ${w}'s session`);
      const lm = await c.call(l, 'GET', `/agent/sessions/${sid}/messages`);
      if (lm.status !== 404) problems.push(`round ${round}: ${l} reading the session ${w} won → ${lm.status}`);
    }
    expect(problems).toEqual([]);
    // the registry agrees with who got each id
    const db = new Database(join(env.home, OWNER_REGISTRY_FILE), { readonly: true, fileMustExist: true });
    try {
      for (const [sid, w] of won) {
        const rows = db.prepare('SELECT account_id FROM session_owners WHERE session_id = ?').all(sid) as Array<{ account_id: string }>;
        expect(rows.map((r) => r.account_id), `registry rows for ${sid}`).toEqual([w]);
      }
    } finally { db.close(); }
  }, 180_000);

  it('same agent slug with identical file times in both accounts: each account reads its own roster, whoever fills a cache first', async () => {
    const c = E.client;
    // same slug, same file set, same mtimes in both accounts: anything that caches the roster by a fingerprint of
    // names and times (and not by account) would hand one account's roster to the other
    const T = Object.fromEntries(ACCOUNTS.map((a) => [a, { name: canary(a, 'twinname'), persona: canary(a, 'twinpersona'), desc: canary(a, 'twindesc') }])) as unknown as Record<Acct, Record<string, string>>;
    for (const a of ACCOUNTS) {
      const r = await c.call(a, 'POST', '/agent/agents', { body: { slug: TWIN_AGENT, name: `Twin ${T[a].name}`, nameEn: `Twin ${T[a].name}`, description: `About ${T[a].desc}`, systemPrompt: `Persona ${T[a].persona}` } });
      expect(r.status, `${a}: ${describeResp(r)}`).toBeLessThan(300);
    }
    const roots = Object.fromEntries(ACCOUNTS.map((a) => {
      const f = findFile(accDir(a), T[a].persona);
      expect(f, `${a}: twin agent persona not on disk`).toBeTruthy();
      return [a, dirname(dirname(f))];
    })) as unknown as Record<Acct, string>;
    for (const a of ACCOUNTS) expect(roots[a].startsWith(accDir(a) + '/'), roots[a]).toBe(true);
    const tree = (root: string) => {
      const out: string[] = [];
      const walk = (d: string) => { for (const e of readdirSync(d, { withFileTypes: true })) { const p = join(d, e.name); out.push(relative(root, p)); if (e.isDirectory()) walk(p); } };
      walk(root);
      return out.sort();
    };
    // what a names-and-times fingerprint would see: the agent folders and their definition files (per-agent state files
    // such as memory usage differ between the accounts and are not part of an agent's definition)
    const defs = (root: string) => tree(root).filter((rel) => !rel.includes('/') || /^[^/]+\/(config\.toml|SOUL\.md|\.meta\.json)$/.test(rel));
    expect(defs(roots.alice), 'agents folders differ in agents / definition files').toEqual(defs(roots.bob));
    const stamp = (root: string) => defs(root).map((rel) => `${rel}:${statSync(join(root, rel)).mtimeMs}`).join('|');
    const equalize = (sec: number) => {
      for (const a of ACCOUNTS) {
        const paths = tree(roots[a]).map((rel) => join(roots[a], rel)).reverse();
        for (const p of [...paths, roots[a]]) utimesSync(p, sec, sec);
      }
      expect(stamp(roots.alice), 'file times did not come out identical').toBe(stamp(roots.bob));
    };
    const actions = (ctx: ScriptCtx): string[] => {
      const en: string[] = ctx.schemas.get('manage_agent')?.properties?.action?.enum ?? ['list', 'get'];
      return ['list', ...['get', 'read', 'show', 'view', 'info'].filter((x) => en.includes(x)).slice(0, 1)].filter((x) => en.includes(x));
    };
    const problems: string[] = [];
    const check = (who: Acct, what: string, text: string, needOwn: boolean) => {
      const theirs = Object.values(T[other(who)]);
      const hits = leakHits(text, theirs);
      if (hits.length) problems.push(`${who} ${what}: shows ${other(who)}'s ${hits.join(', ')}`);
      if (needOwn && !leakHits(text, Object.values(T[who])).length) problems.push(`${who} ${what}: shows none of its own twin agent (${text.slice(0, 200)})`);
    };
    for (const [round, [first, second]] of ([['alice', 'bob'], ['bob', 'alice']] as Array<[Acct, Acct]>).entries()) {
      equalize(1_767_323_045 + round * 1000);
      // the first account fills whatever cache there is; the second reads right after, with identical fingerprints
      const r1 = await c.call(first, 'GET', '/agent/agents');
      expect(stamp(roots.alice), `round ${round}: ${first}'s read changed file times; the fingerprints no longer match`).toBe(stamp(roots.bob));
      const r2 = await c.call(second, 'GET', '/agent/agents');
      check(first, `GET /agent/agents (round ${round}, first)`, r1.text, true);
      check(second, `GET /agent/agents (round ${round}, second)`, r2.text, true);
      // the second account's run: the roster through manage_agent, and the persona through the agent knob
      const s = E.fake.script(second, `twin${round}`, steps([
        (ctx) => ({ calls: !ctx.offered.has('manage_agent') && ctx.offered.has('load_tools') ? [{ name: 'load_tools', args: { names: ['manage_agent'] } }] : [] }),
        (ctx) => ({ calls: actions(ctx).map((action) => ({ name: 'manage_agent', args: action === 'list' ? { action } : { action, slug: TWIN_AGENT } })) }),
      ], `twin done ${round}`));
      equalize(1_767_323_045 + round * 1000 + 500);
      await c.call(first, 'GET', '/agent/agents');
      const run = await startRun(c, second, s, { text: 'Which agents do I have?', agentConfig: { agentSlug: TWIN_AGENT } });
      expect(run.runId, describeResp(run.resp)).toBeTruthy();
      const f = await c.follow(second, run.runId!, { timeoutMs: 60_000 });
      expect(f.status, f.text.slice(-400)).toBe('done');
      const outs = s.results.filter((x) => x.name === 'manage_agent');
      expect(outs.length, `round ${round}: manage_agent never ran in ${second}'s run`).toBeGreaterThan(0);
      for (const o of outs) check(second, `manage_agent ${o.args.action} (round ${round})`, o.output, o.args.action !== 'list');
      if (!outs.some((o) => leakHits(o.output, Object.values(T[second])).length)) problems.push(`${second} manage_agent (round ${round}): no output shows its own twin agent`);
      const sent = s.requests.map((x) => x.text).join('\n');
      check(second, `model request (round ${round})`, sent, false);
      if (!sent.includes(T[second].persona)) warnings.push(`round ${round}: ${second}'s twin persona did not reach the model through agentSlug`);
    }
    expect(problems).toEqual([]);
  }, 180_000);

  it("a new account's first requests all at once: every one served, one folder provisioned", async () => {
    const c = E.client;
    const before = await waitQuiet(env.root, () => E.fake.outbound.length);
    const who = 'carol';
    const fact = canary(who, 'memory');
    const reqs = await Promise.all([
      c.call(who, 'GET', '/agent/sessions'), c.call(who, 'GET', '/agent/sessions'), c.call(who, 'GET', '/agent/memory'),
      c.call(who, 'GET', '/agent/agents'), c.call(who, 'GET', '/agent/skills/catalog'), c.call(who, 'GET', '/agent/skills'),
      c.call(who, 'POST', '/agent/memory', { body: { text: `Carol ${fact}` } }),
      c.call(who, 'POST', '/agent/sessions', { body: { title: 'carol first', model_id: MODEL_ID } }),
      c.call(who, 'GET', '/agent/sessions/attention'), c.call(who, 'GET', '/agent/sessions'),
    ]);
    for (const r of reqs) {
      expect(r.status, describeResp(r)).toBeGreaterThan(0);
      expect(r.status, describeResp(r)).toBeLessThan(500);
    }
    expect(respLeaks(await c.call(who, 'GET', '/agent/memory'), [fact])).toEqual([fact]);
    const list = await c.call(who, 'GET', '/agent/sessions');
    expect(list.text).toContain('carol first');
    const cat = (await c.call(who, 'GET', '/agent/skills')).json?.skills ?? [];
    const keys = cat.map((s: any) => s.id);
    expect(keys.length, 'duplicate skill entries after a provisioning race').toBe(new Set(keys).size);
    const after = await waitQuiet(env.root, () => E.fake.outbound.length);
    const d = diffSnaps(before, after);
    expect.soft([...d.added, ...d.changed, ...d.removed].filter((p) => !p.startsWith(`home/accounts/${who}/`) && !OWNER_REGISTRY_RE.test(p)), `files written outside accounts/${who}`).toEqual([]);
    expect(existsSync(join(accDir(who), 'state.db'))).toBe(true);
    expect(readdirSync(join(env.home, 'accounts')).sort()).toEqual(['alice', 'bob', 'carol']);
  }, 120_000);

  it('the engine-level session registry holds only session id → account (+ timestamps), nobody\'s content', () => {
    const needles = ACCOUNTS.flatMap((a) => Object.values(K[a]));
    expect(ownerRegistryProblems(env.home, needles, [...ACCOUNTS, 'carol'])).toEqual([]);
  });

  it('no child process was started', () => {
    expect(spawnLog().filter((x) => !x.tag).map((x) => `${x.fn} ${x.command}`)).toEqual([]);
  });
});
