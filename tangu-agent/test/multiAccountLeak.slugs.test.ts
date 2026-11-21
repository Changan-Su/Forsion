/**
 * Multi-account mode: slugs as paths.
 *
 * Agent and skill slugs become folder names, so every route and tool that takes one is a path into the account's
 * folder. alice owns an agent (persona, agent memory, memory and log lines filed under it) and a skill; bob aims
 * every slug-taking route and tool at them, with `..`, `%2e%2e`, `%2F`, `..%2F`, backslashes, absolute paths and
 * alice's real slug in various spellings.
 * Every attempt must be refused or treated as nonexistent (answered like a slug that exists nowhere), nothing of
 * alice's may appear in a response or tool output, alice's files stay byte-identical and nothing changes outside
 * accounts/bob (except the engine's session registry).
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';

const env = await vi.hoisted(async () => {
  const fs = await import('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'tangu-ma-slugs-')));
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

import { rmSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import {
  LOCAL_TOKEN, OWNER_REGISTRY_RE, bootMultiAccount, canary, chunk, describeResp, diffSnaps, findFile, leakHits, loadToolsStep,
  randLower, respLeaks, snapshotTree, startRun, steps, waitQuiet, type MaEngine, type Script, type ScriptCtx, type Snap, type ToolCallSpec,
} from './helpers/multiAccountHarness.js';
import { spawnLog } from './helpers/multiAccountSpawnSpy.js';

const ALICE = 'alice';
const BOB = 'bob';
const accDir = (id: string) => join(env.home, 'accounts', id);
const A_AGENT = 'alice-secret-agent';
const A_SKILL = 'alice-secret-skill';
const B_AGENT = 'bob-agent';
const B_SKILL = 'bob-skill';
const C = {
  agentName: canary(ALICE, 'agentname'), persona: canary(ALICE, 'persona'), agentMem: canary(ALICE, 'agentmemory'),
  mem: canary(ALICE, 'memory'), memAgent: canary(ALICE, 'memoryforagent'), log: canary(ALICE, 'log'), logAgent: canary(ALICE, 'logforagent'),
  skill: canary(ALICE, 'skill'),
};
const Bc = { persona: canary(BOB, 'persona'), agentMem: canary(BOB, 'agentmemory'), skill: canary(BOB, 'skill'), write: canary(BOB, 'write') };
const aliceContent = () => Object.values(C);

let E: MaEngine;
const warnings: string[] = [];
const T = { aliceAgentDir: '', aliceSkillDir: '', bobAgentsDir: '', bobSkillsDir: '', memField: 'content' };
let aliceBefore: Snap;
let rootBefore: Snap;
const bobHeaders = { Authorization: `Bearer ${LOCAL_TOKEN}`, 'X-Forsion-User': BOB };
const quiet = () => waitQuiet(env.root, () => E.fake.outbound.length);

async function runAs(who: string, label: string, list: Parameters<typeof steps>[0]): Promise<Script> {
  const s = E.fake.script(who, label, steps(list, `${label} done`));
  const st = await startRun(E.client, who, s, { text: label });
  expect(st.runId, `${who}/${label}: ${describeResp(st.resp)}`).toBeTruthy();
  const f = await E.client.follow(who, st.runId!, { timeoutMs: 120_000 });
  expect(f.status, `${who}/${label}: ${f.text.slice(-400)}`).toBe('done');
  return s;
}

/** alice's views that bob's attempts must not change */
async function aliceView(): Promise<string> {
  const parts: string[] = [];
  for (const p of ['/agent/agents', `/agent/agents/${A_AGENT}/memory`, '/agent/memory', '/agent/log', '/agent/skills']) {
    const r = await E.client.call(ALICE, 'GET', p);
    parts.push(`${p} ${r.status} ${r.text}`);
  }
  return parts.join('\n');
}

/**
 * Spellings of a slug-or-path target: the slug itself and look-alikes, relative paths from bob's folder to alice's,
 * absolute paths, backslashes and parent-folder walks. Each spelling is made twice, from alice's real target and from
 * a twin that exists nowhere (same folder, unknown slug), so an answer can be compared with the nonexistent case.
 */
type Target = { slug: string; rel: string; abs: string };
const FORMS: Array<(t: Target) => string> = [
  (t) => t.slug, (t) => t.slug.toUpperCase(), (t) => `${t.slug}/`, (t) => `./${t.slug}`, (t) => `${t.slug}/.`,
  (t) => `${t.slug}/../${t.slug}`, (t) => ` ${t.slug}`, (t) => `${t.slug}\u0000`,
  (t) => t.rel, (t) => t.rel.replace(/\//g, '\\'), (t) => `${t.rel.split('/').slice(0, -1).join('/')}/./${t.slug}`, (t) => `${B_AGENT}/../${t.rel}`,
  (t) => t.abs, (t) => `${t.abs}/`, (t) => t.abs.replace(/^\/private\/var\//, '/var/'), (t) => `file://${t.abs}`,
  () => '..', () => '.', () => '../..', () => `../${ALICE}`, () => `../../${ALICE}`, () => `../../../accounts/${ALICE}`,
];
function targetPairs(real: Target, twin: Target): Array<[string, string]> {
  const seen = new Set<string>();
  const out: Array<[string, string]> = [];
  for (const f of FORMS) { const r = f(real); if (!seen.has(r)) { seen.add(r); out.push([r, f(twin)]); } }
  return out;
}
const twinOf = (t: Target, nobody: string): Target => ({ slug: nobody, rel: t.rel.split('/').slice(0, -1).concat(nobody).join('/'), abs: join(dirname(t.abs), nobody) });
/** how a target is written into a URL path segment: raw, fully encoded, dots encoded, separators encoded only */
function urlForms(t: string): string[] {
  const enc = encodeURIComponent(t);
  return [...new Set([
    t.replace(/ /g, '%20').replace(/\u0000/g, '%00'),
    enc,
    enc.replace(/\./g, '%2e'),
    enc.replace(/\./g, '%2E'),
    t.replace(/\//g, '%2F').replace(/\\/g, '%5C').replace(/ /g, '%20').replace(/\u0000/g, '%00'),
    t.replace(/\./g, '%2e').replace(/ /g, '%20').replace(/\u0000/g, '%00'),
  ])].filter((x) => x.length > 0);
}
/** text with every echoed input removed (longest first) */
const withTrimmed = (echo: string[]) => [...new Set(echo.flatMap((x) => [x, x.trim(), x.replace(/\u0000/g, '').trim()]))];
const strip = (text: string, echo: string[]) => {
  let t = text;
  for (const e of withTrimmed(echo).filter((x) => x && x.length > 1).sort((a, b) => b.length - a.length)) t = t.split(e).join('');
  return t;
};
const safeDecode = (x: string) => { try { return decodeURIComponent(x); } catch { return x; } };
const serverErrors: string[] = [];
/** a response, normalized for comparison with the same request about a slug that exists nowhere */
const norm = (status: number, text: string, subst: string[]) => {
  let t = text;
  for (const s of withTrimmed(subst).filter((x) => x.length > 1).sort((a, b) => b.length - a.length)) t = t.split(s).join('<SLUG>');
  return `${status} ${t.replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, '<UUID>').replace(/\d{10,}/g, '<N>')}`;
};

beforeAll(async () => {
  E = await bootMultiAccount();
  const c = E.client;
  // alice: an agent with persona, agent memory, memory and log lines filed under it, and a skill
  expect((await c.call(ALICE, 'POST', '/agent/agents', { body: { slug: A_AGENT, name: `Alice secret ${C.agentName}`, nameEn: `Alice secret ${C.agentName}`, systemPrompt: `Persona ${C.persona}` } })).status).toBeLessThan(300);
  // the agent memory route may want the current version back (compare-and-set): send what GET reports
  const tried: string[] = [];
  for (const field of ['content', 'memory', 'text']) {
    const cur = await c.call(ALICE, 'GET', `/agent/agents/${A_AGENT}/memory`);
    const version = cur.json?.version;
    const put = await c.call(ALICE, 'PUT', `/agent/agents/${A_AGENT}/memory`, { body: { [field]: `Agent memory ${C.agentMem}`, ...(version ? { version, baseVersion: version, expectedVersion: version } : {}) } });
    tried.push(`${field}: ${put.status} ${put.text.slice(0, 160)}`);
    if (put.status < 300 && (await c.call(ALICE, 'GET', `/agent/agents/${A_AGENT}/memory`)).text.includes(C.agentMem)) { T.memField = field; break; }
  }
  const got = await c.call(ALICE, 'GET', `/agent/agents/${A_AGENT}/memory`);
  expect(got.text, `alice's agent memory did not land\n  GET: ${got.text.slice(0, 300)}\n  PUT: ${tried.join('\n  PUT: ')}`).toContain(C.agentMem);
  expect((await c.call(ALICE, 'POST', '/agent/memory', { body: { text: `Fact ${C.mem}` } })).status).toBeLessThan(300);
  const memAgent = await c.call(ALICE, 'POST', '/agent/memory', { body: { text: `Agent fact ${C.memAgent}`, agentSlug: A_AGENT, slug: A_AGENT, agent: A_AGENT } });
  if (memAgent.status >= 300) warnings.push(`POST /agent/memory with an agent slug → ${memAgent.status}`);
  const log = await c.call(ALICE, 'POST', '/agent/log', { body: { text: `Log ${C.log}` } });
  if (log.status >= 300) warnings.push(`POST /agent/log → ${log.status}`);
  const logAgent = await c.call(ALICE, 'POST', '/agent/log', { body: { text: `Agent log ${C.logAgent}`, agentSlug: A_AGENT, slug: A_AGENT, agent: A_AGENT } });
  if (logAgent.status >= 300) warnings.push(`POST /agent/log with an agent slug → ${logAgent.status}`);
  await runAs(ALICE, 'mkskill', [
    loadToolsStep(['manage_skill']),
    { calls: [{ name: 'manage_skill', args: { action: 'create', slug: A_SKILL, name: A_SKILL, description: 'Alice routine', instructions: `Alice steps ${C.skill}` } }] },
  ]);
  // bob: an agent, agent memory and a skill of his own (positive controls, and a base for relative paths)
  expect((await c.call(BOB, 'POST', '/agent/agents', { body: { slug: B_AGENT, name: 'Bob agent', nameEn: 'Bob agent', systemPrompt: `Persona ${Bc.persona}` } })).status).toBeLessThan(300);
  const bv = (await c.call(BOB, 'GET', `/agent/agents/${B_AGENT}/memory`)).json?.version;
  expect((await c.call(BOB, 'PUT', `/agent/agents/${B_AGENT}/memory`, { body: { [T.memField]: `Bob agent memory ${Bc.agentMem}`, ...(bv ? { version: bv, baseVersion: bv, expectedVersion: bv } : {}) } })).status).toBeLessThan(300);
  await runAs(BOB, 'mkskill', [
    loadToolsStep(['manage_skill']),
    { calls: [{ name: 'manage_skill', args: { action: 'create', slug: B_SKILL, name: B_SKILL, description: 'Bob routine', instructions: `Bob steps ${Bc.skill}` } }] },
  ]);

  const aPersona = findFile(accDir(ALICE), C.persona);
  const aSkill = findFile(accDir(ALICE), C.skill, 'SKILL.md');
  const bPersona = findFile(accDir(BOB), Bc.persona);
  const bSkill = findFile(accDir(BOB), Bc.skill, 'SKILL.md');
  for (const [k, p] of Object.entries({ aPersona, aSkill, bPersona, bSkill })) expect(p, `${k} not found on disk`).toBeTruthy();
  T.aliceAgentDir = dirname(aPersona);
  T.aliceSkillDir = dirname(aSkill);
  T.bobAgentsDir = dirname(dirname(bPersona));
  T.bobSkillsDir = dirname(dirname(bSkill));
  expect(T.aliceAgentDir.endsWith(`/${A_AGENT}`) && T.aliceAgentDir.startsWith(accDir(ALICE) + '/'), T.aliceAgentDir).toBe(true);
  expect(T.aliceSkillDir.endsWith(`/${A_SKILL}`) && T.aliceSkillDir.startsWith(accDir(ALICE) + '/'), T.aliceSkillDir).toBe(true);
}, 180_000);

afterAll(async () => {
  try { await E?.dispose(); } catch { /* ignore */ }
  if (warnings.length) console.warn(`[multi-account slugs] coverage notes:\n  - ${warnings.join('\n  - ')}`);
  // not an isolation failure (a nonexistent slug of the same spelling gets the same answer), but a status worth fixing
  if (serverErrors.length) console.warn(`[multi-account slugs] ${serverErrors.length} malformed or foreign slugs answered with a server error, e.g.\n  - ${serverErrors.slice(0, 6).join('\n  - ')}`);
  try { rmSync(env.root, { recursive: true, force: true }); } catch { /* ignore */ }
});

describe('multi-account mode: slugs aimed at another account', () => {
  it('positive controls: alice sees her own things; bob reaches his own agent and memory through the same routes', async () => {
    const view = await aliceView();
    for (const k of [C.persona, C.agentMem, C.mem, C.skill.slice(0, 0) || A_SKILL]) expect(view, k).toContain(k);
    const own = await E.client.raw('GET', `/agent/agents/${B_AGENT}/memory`, bobHeaders);
    expect(own.status, own.text).toBe(200);
    expect(own.text).toContain(Bc.agentMem);
    await quiet();
    aliceBefore = snapshotTree(accDir(ALICE));
    rootBefore = snapshotTree(env.root);
    (globalThis as any).__aliceView = view;
  }, 60_000);

  it("HTTP: every slug spelling aimed at alice's agent is refused or answered exactly like a slug that exists nowhere", async () => {
    const nobody = `zz-nobody-${randLower(8)}`;
    const real: Target = { slug: A_AGENT, rel: relative(join(T.bobAgentsDir, B_AGENT), T.aliceAgentDir), abs: T.aliceAgentDir };
    const pairs = targetPairs(real, twinOf(real, nobody));
    const writeBody = { systemPrompt: `Bob overwrote ${Bc.write}`, name: `Bob ${Bc.write}`, [T.memField]: `Bob wrote ${Bc.write}`, content: `Bob wrote ${Bc.write}` };
    type Req = { method: string; path: (seg: string) => string; body?: (t: string) => unknown };
    const pathRoutes: Req[] = [
      { method: 'GET', path: (x) => `/agent/agents/${x}` },
      { method: 'PATCH', path: (x) => `/agent/agents/${x}`, body: () => writeBody },
      { method: 'GET', path: (x) => `/agent/agents/${x}/memory` },
      { method: 'PUT', path: (x) => `/agent/agents/${x}/memory`, body: () => writeBody },
    ];
    const q = (t: string) => ['agentSlug', 'slug', 'agent', 'agent_slug'].map((k) => `${k}=${encodeURIComponent(t)}`).join('&');
    const queryRoutes: Req[] = [
      { method: 'GET', path: (x) => `/agent/memory?${x}` },
      { method: 'GET', path: (x) => `/agent/log?${x}` },
      { method: 'POST', path: () => '/agent/memory', body: (t) => ({ text: `Bob fact ${Bc.write}`, agentSlug: t, slug: t, agent: t, agent_slug: t }) },
      { method: 'POST', path: () => '/agent/log', body: (t) => ({ text: `Bob log ${Bc.write}`, agentSlug: t, slug: t, agent: t, agent_slug: t }) },
    ];
    // positive control: the same write body is accepted for bob's own agent, so the writes below are judged on the slug
    const ownPatch = await E.client.raw('PATCH', `/agent/agents/${B_AGENT}`, bobHeaders, writeBody);
    expect(ownPatch.status, `PATCH on bob's own agent: ${ownPatch.text.slice(0, 200)}`).toBeLessThan(300);
    const problems: string[] = [];
    let sent = 0;
    const judge = async (label: string, method: string, path: string, body: unknown, echo: string[], twinPath: string, twinBody: unknown, twinEcho: string[]) => {
      const r = await E.client.raw(method, path, bobHeaders, body);
      const tw = await E.client.raw(method, twinPath, bobHeaders, twinBody);
      sent += 2;
      // what bob typed may come back (an echo); anything else of alice's may not
      const hits = leakHits(r.text, aliceContent());
      const unEchoed = strip(r.text, echo);
      if (hits.length || unEchoed.includes(`accounts/${ALICE}`) || unEchoed.includes(A_AGENT)) problems.push(`${label}: ${method} ${path} → ${r.status} shows ${hits.join(', ') || 'alice\'s path or slug beyond the echo'}\n  ${r.text.slice(0, 300)}`);
      if (r.status >= 500) serverErrors.push(`${method} ${path} → ${r.status} ${r.text.slice(0, 120)}`);
      if (norm(r.status, r.text, echo) !== norm(tw.status, tw.text, twinEcho)) {
        problems.push(`${label}: ${method} ${path} tells alice's agent from a nonexistent one\n  real: ${norm(r.status, r.text, echo).slice(0, 240)}\n  twin: ${norm(tw.status, tw.text, twinEcho).slice(0, 240)}`);
      }
    };
    const echoes = (t: string, seg?: string) => [t, encodeURIComponent(t), ...(seg ? [seg, safeDecode(seg)] : [])];
    for (const [t, tw] of pairs) {
      const forms = urlForms(t), twinForms = urlForms(tw);
      for (let i = 0; i < forms.length; i++) {
        const seg = forms[i], tseg = twinForms[i] ?? twinForms[0];
        for (const rt of pathRoutes) {
          await judge(`path ${JSON.stringify(t)}`, rt.method, rt.path(seg), rt.body?.(t), echoes(t, seg), rt.path(tseg), rt.body?.(tw), echoes(tw, tseg));
        }
      }
      for (const rt of queryRoutes) {
        await judge(`query ${JSON.stringify(t)}`, rt.method, rt.path(q(t)), rt.body?.(t), echoes(t), rt.path(q(tw)), rt.body?.(tw), echoes(tw));
      }
    }
    expect(sent).toBeGreaterThan(300);
    expect(problems).toEqual([]);
  }, 300_000);

  it("tools: manage_agent, manage_skill and use_skill with every slug spelling aimed at alice's agent and skills", async () => {
    const nobodyA = `zz-nobody-${randLower(8)}`, nobodyS = `zz-nobody-${randLower(8)}`;
    const realA: Target = { slug: A_AGENT, rel: relative(join(T.bobAgentsDir, B_AGENT), T.aliceAgentDir), abs: T.aliceAgentDir };
    const realS: Target = { slug: A_SKILL, rel: relative(join(T.bobSkillsDir, B_SKILL), T.aliceSkillDir), abs: T.aliceSkillDir };
    const withEncoded = (ps: Array<[string, string]>) => {
      const out = new Map<string, string>();
      for (const [r, t] of ps) for (const f of [(x: string) => x, encodeURIComponent, (x: string) => encodeURIComponent(x).replace(/\./g, '%2e')]) if (!out.has(f(r))) out.set(f(r), f(t));
      return [...out];
    };
    const agentPairs = withEncoded(targetPairs(realA, twinOf(realA, nobodyA)));
    const skillPairs = withEncoded([...targetPairs(realS, twinOf(realS, nobodyS)), [dirname(T.aliceSkillDir), join(dirname(dirname(T.aliceSkillDir)), nobodyS)]]);
    const problems: string[] = [];
    const agentActionsSeen: string[] = [];
    const runBattery = async (label: string, build: (ctx: ScriptCtx) => Array<[ToolCallSpec, ToolCallSpec | null]>) => {
      let queue: ToolCallSpec[][] | null = null;
      let pairsBuilt: Array<[ToolCallSpec, ToolCallSpec | null]> = [];
      const s = E.fake.script(BOB, label, async (ctx: ScriptCtx) => {
        if (ctx.step === 0) {
          const step = loadToolsStep(['manage_agent', 'manage_skill', 'use_skill'])(ctx);
          if ('calls' in step && step.calls.length) return step;
        }
        if (!queue) {
          pairsBuilt = build(ctx);
          const calls = pairsBuilt.flatMap(([a, b]) => (b ? [a, b] : [a]));
          const filler = ctx.offered.has('get_datetime') ? [{ name: 'get_datetime', args: {} }] : [];
          queue = chunk(calls, 20).map((g) => [...g, ...filler]);
        }
        const g = queue.shift();
        return g ? { calls: g } : { text: `${label} finished` };
      });
      const st = await startRun(E.client, BOB, s, { text: label });
      expect(st.runId, describeResp(st.resp)).toBeTruthy();
      const f = await E.client.follow(BOB, st.runId!, { timeoutMs: 240_000 });
      expect(f.status, f.text.slice(-600)).toBe('done');
      const outOf = (c: ToolCallSpec) => s.results.find((r) => r.name === c.name && JSON.stringify(r.args) === JSON.stringify(c.args))?.output;
      let answered = 0;
      for (const [real, twin] of pairsBuilt) {
        const out = outOf(real);
        if (out === undefined) { problems.push(`${label}: no answer to ${real.name}(${JSON.stringify(real.args).slice(0, 120)})`); continue; }
        answered++;
        const typed = Object.values(real.args).map(String);
        const hits = leakHits(out, aliceContent());
        const unEchoed = strip(out, typed);
        if (hits.length || unEchoed.includes(`accounts/${ALICE}`) || unEchoed.includes(A_AGENT) || unEchoed.includes(A_SKILL)) problems.push(`${label}: ${real.name}(${JSON.stringify(real.args).slice(0, 160)}) → ${out.slice(0, 300)}`);
        if (twin) {
          const tout = outOf(twin) ?? '<no answer>';
          if (norm(0, out, typed) !== norm(0, tout, Object.values(twin.args).map(String))) {
            problems.push(`${label}: ${real.name} tells alice's ${real.name === 'manage_agent' ? 'agent' : 'skill'} from a nonexistent one\n  real ${JSON.stringify(real.args).slice(0, 120)} → ${out.slice(0, 200)}\n  twin ${JSON.stringify(twin.args).slice(0, 120)} → ${tout.slice(0, 200)}`);
          }
        }
      }
      return { s, answered };
    };
    const actions = (ctx: ScriptCtx, n: string, re: RegExp) => ((ctx.schemas.get(n)?.properties?.action?.enum ?? []) as string[]).filter((a) => re.test(a));
    const fill = (ctx: ScriptCtx, n: string) => {
      const out: Record<string, unknown> = {};
      // every text field a create / update needs (name, prompt, instructions, …) so writes are judged on the slug alone
      for (const k of Object.keys(ctx.schemas.get(n)?.properties ?? {})) if (/name|prompt|soul|instruction|content|description|persona/i.test(k)) out[k] = `Bob overwrote ${Bc.write}`;
      return out;
    };
    const call = (name: string, args: Record<string, unknown>): ToolCallSpec => ({ name, args });

    // manage_agent: reads first, then writes / deletes; bob's own agent is the positive control
    const ag = await runBattery('slug-agent', (ctx) => {
      const acts = actions(ctx, 'manage_agent', /get|read|show|view|info|memory|update|edit|patch|delete|remove/);
      const all = (ctx.schemas.get('manage_agent')?.properties?.action?.enum ?? []) as string[];
      agentActionsSeen.push(...all);
      // positive controls on bob's own agent: reading / listing it works, and so does a write (it must not be refused
      // for argument reasons, or the writes aimed at alice below would prove nothing)
      const own = [
        ...acts.filter((a) => /get|read|show|view|info/.test(a)).map((action) => call('manage_agent', { action, slug: B_AGENT })),
        ...all.filter((a) => a === 'list').map((action) => call('manage_agent', { action })),
        ...acts.filter((a) => /update|edit|patch/.test(a)).slice(0, 1).map((action) => call('manage_agent', { ...fill(ctx, 'manage_agent'), action, slug: B_AGENT })),
      ].map((c) => [c, null] as [ToolCallSpec, null]);
      return [...own, ...agentPairs.flatMap(([r, t]) => acts.map((action) => {
        const extra = /update|edit|patch/.test(action) ? fill(ctx, 'manage_agent') : {};
        return [call('manage_agent', { ...extra, action, slug: r }), call('manage_agent', { ...extra, action, slug: t })] as [ToolCallSpec, ToolCallSpec];
      }))];
    });
    expect(ag.answered, 'manage_agent battery barely ran').toBeGreaterThan(20);
    const ownAgent = ag.s.results.filter((r) => r.name === 'manage_agent' && (r.args.slug === B_AGENT || r.args.action === 'list'));
    expect(ownAgent.length, `no positive control for manage_agent (actions: ${agentActionsSeen.join(', ')})`).toBeGreaterThan(0);
    for (const r of ownAgent) {
      expect(r.output, `bob's manage_agent ${r.args.action} on his own agent was refused`).not.toMatch(/^error|not found|invalid/i);
      if (r.args.action === 'list') {
        expect(r.output, "bob's manage_agent list").toContain(B_AGENT);
        expect(r.output.includes(A_AGENT) || leakHits(r.output, aliceContent()).length > 0, "bob's manage_agent list shows alice's agent").toBe(false);
      }
    }
    if (!ownAgent.some((r) => r.args.slug === B_AGENT && /get|read|show|view|info/.test(String(r.args.action)))) warnings.push(`manage_agent has no read action (${agentActionsSeen.join(', ')}); writes / deletes were aimed at alice`);

    // manage_skill
    const sk = await runBattery('slug-skill', (ctx) => {
      const acts = actions(ctx, 'manage_skill', /get|read|show|view|info|update|edit|patch|delete|remove/);
      const own = acts.filter((x) => /update|edit|patch/.test(x)).slice(0, 1).map((action) => [call('manage_skill', { ...fill(ctx, 'manage_skill'), action, slug: B_SKILL }), null] as [ToolCallSpec, null]);
      return [...own, ...skillPairs.flatMap(([r, t]) => acts.map((action) => {
        const extra = /update|edit|patch/.test(action) ? fill(ctx, 'manage_skill') : {};
        return [call('manage_skill', { ...extra, action, slug: r }), call('manage_skill', { ...extra, action, slug: t })] as [ToolCallSpec, ToolCallSpec];
      }))];
    });
    expect(sk.answered, 'manage_skill battery barely ran').toBeGreaterThan(20);
    const ownSkillWrite = sk.s.results.filter((r) => r.name === 'manage_skill' && r.args.slug === B_SKILL);
    expect(ownSkillWrite.length, 'no manage_skill write control on bob\'s own skill').toBeGreaterThan(0);
    for (const r of ownSkillWrite) expect(r.output, "bob's manage_skill write on his own skill was refused").not.toMatch(/^error|not found|invalid/i);

    // use_skill, with bob's own skill as the positive control
    const us = await runBattery('slug-use', () => [
      [call('use_skill', { skill_id: `local:${B_SKILL}` }), null],
      ...skillPairs.flatMap(([r, t]) => ['', 'local:', 'user:'].map((pre) => [call('use_skill', { skill_id: `${pre}${r}` }), call('use_skill', { skill_id: `${pre}${t}` })] as [ToolCallSpec, ToolCallSpec])),
    ]);
    expect(us.answered, 'use_skill battery barely ran').toBeGreaterThan(20);
    // bob's own skill now carries the text his write control put there
    expect(us.s.results.find((r) => r.name === 'use_skill' && r.args.skill_id === `local:${B_SKILL}`)?.output ?? '', "bob's use_skill on his own skill").toContain(Bc.write);

    for (const x of [ag, sk, us]) expect(leakHits(x.s.requests.map((r) => r.text).join('\n'), aliceContent()), "alice's content in bob's model requests").toEqual([]);
    expect(problems).toEqual([]);
  }, 400_000);

  it("afterwards: alice's files are byte-identical, her views unchanged, and nothing changed outside accounts/bob", async () => {
    const after = await quiet();
    const aliceNow = snapshotTree(accDir(ALICE));
    const da = diffSnaps(aliceBefore, aliceNow);
    expect([...da.added, ...da.changed, ...da.removed], "alice's folder changed").toEqual([]);
    const d = diffSnaps(rootBefore, after);
    const outside = [...d.added, ...d.changed, ...d.removed].filter((p) => !p.startsWith('home/accounts/bob/') && !OWNER_REGISTRY_RE.test(p));
    expect(outside, 'files changed outside accounts/bob').toEqual([]);
    expect(await aliceView(), "alice's views changed").toBe((globalThis as any).__aliceView);
    expect(respLeaks(await E.client.call(BOB, 'GET', '/agent/agents'), aliceContent())).toEqual([]);
    expect(spawnLog().filter((x) => !x.tag).map((x) => `${x.fn} ${x.command}`), 'child process').toEqual([]);
  }, 60_000);
});
