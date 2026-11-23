/**
 * Multi-account mode: two accounts share one engine process; alice writes, bob must read none of it.
 *
 * Real express app from createMultiAccountApp, real routes, real run loop, real tools — only the model is fake
 * (scripted per run, records every outbound request after masking). The test acts as the host in front of the engine:
 * `Authorization: Bearer <local token>` + `X-Forsion-User: alice|bob`.
 *
 * Order matters and is deliberate: alice does everything before bob's first-ever request (first-writer singletons),
 * then bob tries every route, every tool and every client-supplied knob with alice's ids, paths and slugs.
 *
 *   1  alice plants canaries in a conversation, memory (HTTP + tool), files (upload + tool), agents, skills, titles
 *   2  bob's own data + a sweep of every allowlisted GET route: no alice content, no alice ids
 *   3  bob with alice's ids (read / SSE / abort / steer / patch / delete / answer) answers like a nonexistent id,
 *      while alice's run is live; process-wide views (pending prompts, attention, live prompt stream) stay per account
 *   4  route traversal: every registered route is allowlisted-and-exercised or refused (403/404), both directions
 *   5  tools: offered ⊆ toolAllowlist, nothing forbidden; every allowlisted tool called with alice's targets;
 *      path tricks (absolute, /var vs /private/var, ../, symlinks); forbidden tools refused, no child process
 *   6  client-supplied folders and knobs (project_path, cwd, extraRoots, agentSlug, host / remote / admin headers)
 *   7  masking tables are per account (placeholder echo; values remembered from alice not applied to bob)
 *   8  colliding ids: bob reuses alice's session ids — no queueing behind her run, no notices / history crossing
 *   9  file system: every write during bob's windows lands under accounts/bob (no engine-level exceptions)
 *  10  final sweep: all of bob's responses, bob's outbound requests, and every byte on disk outside alice's folder
 *  11  alice finishes her parked run; her view of everything is unchanged; her outbound never saw bob
 *  12  no child process was started at all
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';

const env = await vi.hoisted(async () => {
  const fs = await import('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'tangu-ma-leak-')));
  const home = path.join(root, 'home');
  const userHome = path.join(root, 'user-home');
  const tmp = path.join(root, 'tmp');
  for (const d of [home, userHome, tmp]) fs.mkdirSync(d, { recursive: true });
  for (const k of ['TANGU_DATABASE_URL', 'DATABASE_URL', 'TANGU_EMBED', 'TANGU_DATA_DIR', 'TANGU_BUNDLE_DIRS']) delete process.env[k];
  process.env.TANGU_MULTI_ACCOUNT = '1';
  process.env.TANGU_HOME = home;
  process.env.TANGU_LOCAL_TOKEN = 'multi-account-local-host-token-qwertyuiop';
  // anything written outside TANGU_HOME (home directory, temp files) is inside the snapshot root too
  process.env.HOME = userHome;
  process.env.TMPDIR = tmp;
  return { root, home, userHome, tmp };
});

vi.mock('node:child_process', async (orig) => (await import('./helpers/multiAccountSpawnSpy.js')).wrapChildProcess(await orig()));
vi.mock('child_process', async (orig) => (await import('./helpers/multiAccountSpawnSpy.js')).wrapChildProcess(await orig()));

import { existsSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import {
  MODEL_ID, FORBIDDEN_PROBE_NAMES, FORBIDDEN_TOOL_RE, bootMultiAccount, canary, chunk, describeResp, diffSnaps, fakeApiKey,
  fakePassword, fillPath, findFile, grepTree, OWNER_REGISTRY_RE, ownerRegistryProblems, hostileArgs, leakHits, normalize, outboundAccount, paramNames,
  randLower, randUpper, randomUUID, respLeaks, routeKey, runToEnd, startRun, steps, waitQuiet,
  type Client, type MaEngine, type Resp, type ScriptCtx, type ToolCallSpec,
} from './helpers/multiAccountHarness.js';
import { spawnLog, spawnSpyState } from './helpers/multiAccountSpawnSpy.js';

const ALICE = 'alice';
const BOB = 'bob';
const accDir = (id: string) => join(env.home, 'accounts', id);
/**
 * Files outside any account folder that the engine may write while serving an account. Multi-account mode allows only
 * engine-level state that holds no user data; keep this list explicit and short (asserted below).
 */
const ENGINE_LEVEL_WRITES: RegExp[] = [OWNER_REGISTRY_RE];
/** what a refused tool call answers; calibrated in test 5 against a tool name that exists nowhere */
const REFUSAL_RE = /error|unknown|not (available|allowed|found|permitted|enabled)|denied|refus|disabled|unavailable|no such tool|does not exist/i;
const UNKNOWN_TOOL = 'zz_no_such_tool_probe';
const toolRefusals = new Map<string, string>();

let E: MaEngine;
let c: Client;
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

// alice's content canaries (bob never sends any of these)
const C = {
  title: canary(ALICE, 'title'), titleLive: canary(ALICE, 'titlelive'), titlePark: canary(ALICE, 'titlepark'), titleX: canary(ALICE, 'titlespare'),
  titlePark2: canary(ALICE, 'titleparktwo'),
  msg: canary(ALICE, 'message'), msgLive: canary(ALICE, 'messagelive'), msgPark: canary(ALICE, 'messagepark'), msgPark2: canary(ALICE, 'messageparktwo'),
  reply: canary(ALICE, 'reply'), replyLive: canary(ALICE, 'replylive'),
  memHttp: canary(ALICE, 'memoryhttp'), memTool: canary(ALICE, 'memorytool'), logHttp: canary(ALICE, 'loghttp'),
  persona: canary(ALICE, 'persona'), persona2: canary(ALICE, 'personatwo'), personaX: canary(ALICE, 'personaspare'),
  skill: canary(ALICE, 'skill'), skill2: canary(ALICE, 'skilltwo'), skillX: canary(ALICE, 'skillspare'),
  upload: canary(ALICE, 'upload'), upload2: canary(ALICE, 'uploadtwo'), fileTool: canary(ALICE, 'filetool'),
  question: canary(ALICE, 'question'), question2: canary(ALICE, 'questiontwo'),
};
const SECRET = fakeApiKey();
const PW = fakePassword();
/** a file the test drops straight into alice's folder: a directory listing that shows it has listed her folder */
const DIR_MARKER = `ALICE_CANARY_DIRMARKER_${randUpper(12)}.txt`;
const aliceContent = () => [...Object.values(C), SECRET, DIR_MARKER];

// bob's canaries (for his own positive controls and for "alice never saw bob")
const Bc = {
  title: canary(BOB, 'title'), msg: canary(BOB, 'message'), reply: canary(BOB, 'reply'), memHttp: canary(BOB, 'memoryhttp'),
  memTool: canary(BOB, 'memorytool'), persona: canary(BOB, 'persona'), skill: canary(BOB, 'skill'), upload: canary(BOB, 'upload'),
  fileTool: canary(BOB, 'filetool'), steer: canary(BOB, 'steer'), answer: canary(BOB, 'answer'), collide: canary(BOB, 'collide'),
};

const A = {
  sMain: '', sLive: '', sPark: '', sPark2: '', sX: '',
  runMain: '', runX: '', runLive: '', runPark: '', inquiryId: '', runPark2: '', inquiryId2: '',
  agentSlug: `alice-agent-${randLower(8)}`, agent2Slug: `alice-agent-two-${randLower(8)}`, sacAgentSlug: `alice-spare-${randLower(8)}`,
  skillSlug: `alice-skill-${randLower(8)}`, skill2Slug: `alice-skill-two-${randLower(8)}`, sacSkillSlug: `alice-skill-spare-${randLower(8)}`,
  skillKey: '', sacSkillKey: '',
  fileToolAbs: '', uploadAbs: '', personaFile: '', skillFile: '', aliceFile: '',
  ph: '', pwPh: '',
  planted: new Set<string>(),
  view: new Map<string, string>(),
};
const B = {
  sMain: '', runMain: '', agentSlug: `bob-agent-${randLower(8)}`, skillSlug: `bob-skill-${randLower(8)}`, skillKey: '',
  cwdDir: '', sessionDir: '',
};
const aliceIds = () => [A.sMain, A.sLive, A.sPark, A.sX, A.runMain, A.runX, A.runPark, A.inquiryId, A.agentSlug, A.agent2Slug, A.sacAgentSlug,
  A.skillSlug, A.skill2Slug, A.sacSkillSlug, A.skillKey, A.sacSkillKey, A.ph, A.pwPh].filter(Boolean);

const windowViolations: string[] = [];
const warnings: string[] = [];
let pwSentAtSeq = Number.POSITIVE_INFINITY;
let spyProven = false;

const quiet = () => waitQuiet(env.root, () => E.fake.outbound.length);
const underAccount = (rel: string, id: string) => rel.startsWith(`home/accounts/${id}/`);
/** Run bob-only actions and record any file change outside bob's folder. */
async function bobWindow<T>(label: string, fn: () => Promise<T>): Promise<T> {
  const before = await quiet();
  try {
    return await fn();
  } finally {
    const after = await quiet();
    const d = diffSnaps(before, after);
    for (const p of [...d.added, ...d.changed, ...d.removed]) {
      if (!underAccount(p, BOB) && !ENGINE_LEVEL_WRITES.some((re) => re.test(p))) windowViolations.push(`${label}: ${p}`);
    }
  }
}
function expectOk(r: Resp): void {
  expect(r.status, describeResp(r)).toBeGreaterThanOrEqual(200);
  expect(r.status, describeResp(r)).toBeLessThan(300);
}

// ── route helpers ───────────────────────────────────────────────────────────────────────────────────────────────
const allowSet = () => new Set(E.routeAllowlist.map((e) => routeKey(e.method, e.path)));
const isAllowed = (method: string, pattern: string) => allowSet().has(routeKey(method, pattern));
function patternOf(method: string, concrete: string): string | undefined {
  const bare = concrete.split('?')[0];
  for (const r of E.routes) {
    if (r.kind !== 'route' || (r.method !== method && r.method !== 'ALL')) continue;
    const re = new RegExp(`^${r.path.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/:[A-Za-z_][A-Za-z0-9_]*/g, '[^/]+')}/?$`, 'i');
    if (re.test(bare)) return r.path;
  }
  return undefined;
}
interface Ids { session: string; run: string; slug: string; key: string; approval: string; inquiry: string; message: string; other: string }
function paramFor(k: string, path: string, ids: Ids): string {
  if (k === 'id') return path.startsWith('/agent/runs/') ? ids.run : path.startsWith('/agent/sessions/') ? ids.session : ids.other;
  if (k === 'runId') return ids.run;
  if (k === 'sessionId' || k === 'sid') return ids.session;
  if (k === 'slug') return ids.slug;
  if (k === 'key') return ids.key;
  if (k === 'approvalId') return ids.approval;
  if (k === 'inquiryId') return ids.inquiry;
  if (k === 'messageId') return ids.message;
  return ids.other;
}
/** Same shape, different value (uuid stays a uuid, hex stays hex, prefix kept). */
function twinLike(s: string): string {
  if (!s) return s;
  // a UUID's twin is a fresh v4 UUID (version / variant nibbles intact): client session ids must be UUIDs
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s)) return randomUUID();
  const hex = /^[0-9a-f-]+$/i.test(s);
  return s.replace(/[0-9a-zA-Z]/g, (ch) => {
    if (/[0-9]/.test(ch)) return String(Math.floor(Math.random() * 10));
    if (hex) return 'abcdef'[Math.floor(Math.random() * 6)];
    return /[a-z]/.test(ch) ? randLower(1) : randUpper(1);
  }).replace(/^alice/, 'zelda');
}

/** alice's skills through whichever skills listing route is open */
async function aliceSkillsView(): Promise<string> {
  const parts: string[] = [];
  for (const p of ['/agent/skills/catalog', '/agent/skills']) if (isAllowed('GET', p)) parts.push((await c.call(ALICE, 'GET', p)).text);
  return parts.join('\n');
}

// ── B's view ────────────────────────────────────────────────────────────────────────────────────────────────────
function canonical(r: Resp): string {
  return `${r.status} ${normalize(r.text, [])}`;
}
async function viewOf(user: string, ids: Ids): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  for (const e of E.routeAllowlist.filter((x) => x.method.toUpperCase() === 'GET')) {
    const path = fillPath(e.path, (k, p) => paramFor(k, p, ids));
    const r = await c.call(user, 'GET', path, { query: { session_id: ids.session, sessionId: ids.session }, streamMs: 500, label: `view:${user}` });
    out.set(routeKey('GET', e.path), canonical(r));
  }
  return out;
}

beforeAll(async () => {
  // prove the child_process spy is live before trusting "no child process"
  const cp = await import('node:child_process');
  spawnSpyState().tag = 'spy-liveness';
  cp.execFileSync(process.execPath, ['-e', '0']);
  spawnSpyState().tag = undefined;
  spyProven = spawnLog().some((x) => x.tag === 'spy-liveness');
  E = await bootMultiAccount(); // fails loudly when the multi-account entry or the account scope module is missing
  c = E.client;
}, 120_000);

afterAll(async () => {
  try { await E?.dispose(); } catch { /* ignore */ }
  if (warnings.length) console.warn(`[multi-account leak] coverage notes:\n  - ${warnings.join('\n  - ')}`);
  if (toolRefusals.size) console.warn(`[multi-account leak] answers to hard-called tools outside the allowlist:\n  - ${[...toolRefusals].map(([n, o]) => `${n}: ${o.replace(/\s+/g, ' ')}`).join('\n  - ')}`);
  try { rmSync(env.root, { recursive: true, force: true }); } catch { /* ignore */ }
});

describe('multi-account mode: alice writes, bob reads nothing of it', () => {
  it('0 · the entry exposes both allowlists and they are usable', () => {
    expect(Array.isArray(E.routeAllowlist) && E.routeAllowlist.length).toBeTruthy();
    expect(Array.isArray(E.toolAllowlist) && E.toolAllowlist.length).toBeTruthy();
    for (const e of E.routeAllowlist) expect(typeof e.method === 'string' && typeof e.path === 'string' && e.path.startsWith('/'), JSON.stringify(e)).toBe(true);
    expect(spyProven, 'child_process spy did not record its own probe').toBe(true);
    expect(ENGINE_LEVEL_WRITES.length).toBeLessThanOrEqual(3);
  });

  it('1 · alice plants canaries everywhere and sees all of them herself', async () => {
    const before = await quiet();
    const newSession = async (title: string) => {
      const r = await c.call(ALICE, 'POST', '/agent/sessions', { body: { title, model_id: MODEL_ID } });
      expect(r.status, describeResp(r)).toBe(200);
      const id = r.json.session.id as string;
      expectOk(await c.call(ALICE, 'PATCH', `/agent/sessions/${id}`, { body: { title, title_source: 'user' } }));
      return id;
    };
    A.sMain = await newSession(C.title);
    A.sLive = await newSession(C.titleLive);
    A.sPark = await newSession(C.titlePark);
    A.sPark2 = await newSession(C.titlePark2);
    A.sX = await newSession(C.titleX);

    expectOk(await c.call(ALICE, 'POST', '/agent/memory', { body: { text: `Alice prefers ${C.memHttp}` } }));
    A.planted.add('memHttp');
    const log = await c.call(ALICE, 'POST', '/agent/log', { body: { text: `Alice log line ${C.logHttp}` } });
    if (log.status < 300) A.planted.add('logHttp'); else warnings.push(`POST /agent/log → ${log.status}; log canary not planted`);

    // every kind of account data is planted through each channel this mode opens (HTTP route and / or tool);
    // at least one channel per kind is required (asserted at the end of this test)
    const httpAgents = isAllowed('POST', '/agent/agents');
    const httpSkills = isAllowed('POST', '/agent/skills/catalog');
    const httpUpload = isAllowed('POST', '/agent/workspace/upload');
    const agentDefs: Array<[string, string, string]> = [[A.agentSlug, 'Alice Helper', C.persona], [A.sacAgentSlug, 'Alice Spare', C.personaX]];
    const skillDefs: Array<[string, string, 'skillKey' | 'sacSkillKey']> = [[A.skillSlug, C.skill, 'skillKey'], [A.sacSkillSlug, C.skillX, 'sacSkillKey']];
    if (httpAgents) {
      for (const [slug, name, persona] of agentDefs) expectOk(await c.call(ALICE, 'POST', '/agent/agents', { body: { slug, name, nameEn: name, systemPrompt: `You help Alice. ${persona}` } }));
      A.planted.add('agentsHttp');
    } else warnings.push('POST /agent/agents is closed; agents are planted with manage_agent only');
    if (httpSkills) {
      for (const [slug, body, keyOf] of skillDefs) {
        const r = await c.call(ALICE, 'POST', '/agent/skills/catalog', { body: { scope: 'user', slug, name: `Alice ${slug}`, description: 'Alice routine', content: `Steps: ${body}` } });
        expectOk(r);
        A[keyOf] = String(r.json?.skill?.key ?? '');
      }
      A.planted.add('skillsHttp');
    } else warnings.push('POST /agent/skills/catalog is closed; skills are planted with manage_skill only');
    if (httpUpload) {
      const up = await c.call(ALICE, 'POST', '/agent/workspace/upload', { body: { sessionId: A.sMain, files: [{ path: 'alice-upload.txt', content: `Upload ${C.upload}` }] } });
      expect(up.json?.saved, describeResp(up)).toBe(1);
      A.planted.add('upload');
    } else warnings.push('POST /agent/workspace/upload is closed; files are planted with write_file only');

    // a conversation that also calls the account-data tools (whichever this mode offers)
    const want = ['remember', 'write_file', 'manage_agent', 'manage_skill'];
    const agentCalls = (httpAgents ? [] : agentDefs).map(([slug, name, persona]) => ({ name: 'manage_agent', args: { action: 'create', slug, name, system_prompt: `You help Alice. ${persona}` } }));
    const skillCalls = (httpSkills ? [] : skillDefs).map(([slug, body]) => ({ name: 'manage_skill', args: { action: 'create', slug, name: `Alice ${slug}`, description: 'Alice routine', instructions: `Steps: ${body}` } }));
    const plant = E.fake.script(ALICE, 'plant', steps([
      (ctx) => {
        const missing = want.filter((n) => !ctx.offered.has(n) && E.toolAllowlist.includes(n));
        return { calls: ctx.offered.has('load_tools') && missing.length ? [{ name: 'load_tools', args: { names: missing } }] : [] };
      },
      (ctx) => ({
        calls: [
          ...(ctx.offered.has('remember') ? [{ name: 'remember', args: { action: 'add', fact: `Alice's favourite word is ${C.memTool}.` } }] : []),
          ...(ctx.offered.has('write_file') ? [{ name: 'write_file', args: { path: 'alice-notes.txt', content: `Notes ${C.fileTool}` } }] : []),
          ...(ctx.offered.has('manage_agent') ? [{ name: 'manage_agent', args: { action: 'create', slug: A.agent2Slug, name: 'Alice Second', system_prompt: `Second persona ${C.persona2}` } }, ...agentCalls] : []),
          ...(ctx.offered.has('manage_skill') ? [{ name: 'manage_skill', args: { action: 'create', slug: A.skill2Slug, name: 'Alice second skill', description: 'Alice second skill', instructions: `Second skill ${C.skill2}` } }, ...skillCalls] : []),
        ],
      }),
    ], `All set. ${C.reply}`));
    const run = await runToEnd(c, ALICE, plant, { sessionId: A.sMain, text: `My note: ${C.msg}. Deploy credential ${SECRET}. 密码：${PW}` });
    expect(run.follow?.status, run.follow?.text.slice(-800) ?? describeResp(run.resp)).toBe('done');
    A.runMain = run.runId!;
    for (const res of plant.results) {
      const ok = !/^\s*error/i.test(res.output);
      if (!ok) warnings.push(`alice's ${res.name} failed: ${res.output.slice(0, 200)}`);
      if (ok && res.name === 'remember') A.planted.add('memTool');
      if (ok && res.name === 'write_file') A.planted.add('fileTool');
      if (ok && res.name === 'manage_agent') A.planted.add(res.args.slug === A.agent2Slug ? 'persona2' : 'agentsTool');
      if (ok && res.name === 'manage_skill') A.planted.add(res.args.slug === A.skill2Slug ? 'skill2' : 'skillsTool');
    }
    for (const n of want) if (!plant.called.has(n)) warnings.push(`tool ${n} is not offered in multi-account mode; its canary was planted over HTTP only`);

    // masking: alice's request left without the raw values; remember the placeholders bob will echo later
    const outA = plant.requests.map((x) => x.text).join('\n');
    expect(outA).toContain(C.msg);
    expect(outA.includes(SECRET), 'raw key in alice outbound: masking is not wrapped around the injected brain').toBe(false);
    expect(outA.includes(PW), 'raw password in alice outbound').toBe(false);
    A.ph = outA.match(/\{\{API_KEY_[A-Za-z0-9]{8}\}\}/)?.[0] ?? '';
    A.pwPh = outA.match(/\{\{PASSWORD_[A-Za-z0-9]{8}\}\}/)?.[0] ?? '';
    expect(A.ph, 'placeholder for the key').toBeTruthy();
    expect(A.pwPh, 'placeholder for the password').toBeTruthy();
    for (const r of plant.requests) if (r.ctxAccount !== undefined) expect(r.ctxAccount, 'account context during alice model call').toBe(ALICE);

    const xRun = await runToEnd(c, ALICE, E.fake.script(ALICE, 'spare', steps([], 'spare done')), { sessionId: A.sX, text: 'spare session' });
    expect(xRun.follow?.status).toBe('done');
    A.runX = xRun.runId!;

    // a run parked on a question (stays live until test 11)
    const park = E.fake.script(ALICE, 'park', steps([(ctx) => ({ calls: ctx.offered.has('ask_user') ? [{ name: 'ask_user', args: { question: `Alice asks about ${C.question}?` } }] : [] })], 'thanks'));
    const ps = await startRun(c, ALICE, park, { sessionId: A.sPark, text: `Parked ${C.msgPark} credential ${SECRET}` });
    expect(ps.runId, describeResp(ps.resp)).toBeTruthy();
    const pf = await c.follow(ALICE, ps.runId!, { until: (ev) => ev.type === 'inquiry_request', autoAnswer: false, timeoutMs: 30_000 });
    if (pf.status === 'until') {
      A.runPark = ps.runId!;
      A.inquiryId = String(pf.events.find((e) => e.type === 'inquiry_request')?.payload?.inquiryId ?? '');
    } else warnings.push(`ask_user did not park alice's run (${pf.status}); parked-run checks are reduced`);

    // a second upload after her last run in sMain: its "new upload" notice is still pending (used in test 8)
    if (httpUpload) expect((await c.call(ALICE, 'POST', '/agent/workspace/upload', { body: { sessionId: A.sMain, files: [{ path: 'alice-upload-2.txt', content: `Second ${C.upload2}` }] } })).json?.saved).toBe(1);

    // positive controls: alice sees every canary through the same surfaces bob will try
    const mem = await c.call(ALICE, 'GET', '/agent/memory');
    expect(respLeaks(mem, [C.memHttp]), describeResp(mem)).toEqual([C.memHttp]);
    if (A.planted.has('memTool')) expect(respLeaks(mem, [C.memTool])).toEqual([C.memTool]);
    if (A.planted.has('logHttp')) expect(respLeaks(await c.call(ALICE, 'GET', '/agent/log'), [C.logHttp])).toEqual([C.logHttp]);
    const agentsPlanted = A.planted.has('agentsHttp') || A.planted.has('agentsTool');
    const skillsPlanted = A.planted.has('skillsHttp') || A.planted.has('skillsTool');
    expect(agentsPlanted, 'no channel planted an agent for alice').toBe(true);
    expect(skillsPlanted, 'no channel planted a skill for alice').toBe(true);
    const agents = await c.call(ALICE, 'GET', '/agent/agents');
    for (const s of [A.agentSlug, A.sacAgentSlug, ...(A.planted.has('persona2') ? [A.agent2Slug] : [])]) expect(agents.text, s).toContain(s);
    const skillsList = await aliceSkillsView();
    for (const s of [A.skillSlug, A.sacSkillSlug, ...(A.planted.has('skill2') ? [A.skill2Slug] : [])]) expect(skillsList, s).toContain(s);
    expect(respLeaks(await c.call(ALICE, 'GET', '/agent/sessions'), [C.title])).toEqual([C.title]);
    const msgs = await c.call(ALICE, 'GET', `/agent/sessions/${A.sMain}/messages`);
    expect(respLeaks(msgs, [C.msg, C.reply]).sort()).toEqual([C.msg, C.reply].sort());
    if (httpUpload) expect((await c.call(ALICE, 'GET', '/agent/workspace/list', { query: { sessionId: A.sMain } })).text).toContain('alice-upload.txt');

    // where alice's things live on disk (bob's tools will aim at these paths)
    A.uploadAbs = findFile(accDir(ALICE), C.upload, 'alice-upload.txt');
    A.fileToolAbs = A.planted.has('fileTool') ? findFile(accDir(ALICE), C.fileTool, 'alice-notes.txt') : '';
    A.personaFile = findFile(accDir(ALICE), C.persona);
    A.skillFile = findFile(accDir(ALICE), C.skill, 'SKILL.md');
    A.aliceFile = A.fileToolAbs || A.uploadAbs;
    expect(A.aliceFile, 'no channel planted a file for alice (upload route and write_file both unavailable)').toBeTruthy();
    for (const [what, p] of Object.entries({ persona: A.personaFile, skill: A.skillFile, ...(A.uploadAbs ? { upload: A.uploadAbs } : {}), ...(A.fileToolAbs ? { fileTool: A.fileToolAbs } : {}) })) {
      expect(p, `${what} not found under accounts/alice`).toBeTruthy();
      expect(p.startsWith(accDir(ALICE) + '/'), `${what} at ${p}`).toBe(true);
    }

    // every file alice's activity touched is inside her folder
    const after = await quiet();
    const d = diffSnaps(before, after);
    const outside = [...d.added, ...d.changed, ...d.removed].filter((p) => !underAccount(p, ALICE) && !ENGINE_LEVEL_WRITES.some((re) => re.test(p)));
    expect.soft(outside, 'alice wrote outside accounts/alice').toEqual([]);
    // the one engine-level file: session id → account, nothing else (only alice exists so far)
    expect(ownerRegistryProblems(env.home, [...aliceContent(), PW], [ALICE]), 'session registry').toEqual([]);
  }, 180_000);

  it("2 · bob's own data works, and a sweep of every allowlisted GET route finds nothing of alice", async () => {
    expect(A.sMain).toBeTruthy();
    await bobWindow('bob-plant-and-sweep', async () => {
      const s = await c.call(BOB, 'POST', '/agent/sessions', { body: { title: Bc.title, model_id: MODEL_ID } });
      expect(s.status, describeResp(s)).toBe(200);
      B.sMain = s.json.session.id;
      expectOk(await c.call(BOB, 'POST', '/agent/memory', { body: { text: `Bob prefers ${Bc.memHttp}` } }));
      if (isAllowed('POST', '/agent/agents')) expectOk(await c.call(BOB, 'POST', '/agent/agents', { body: { slug: B.agentSlug, name: 'Bob Helper', nameEn: 'Bob Helper', systemPrompt: `You help Bob. ${Bc.persona}` } }));
      if (isAllowed('POST', '/agent/skills/catalog')) {
        const sk = await c.call(BOB, 'POST', '/agent/skills/catalog', { body: { scope: 'user', slug: B.skillSlug, name: 'Bob routine', description: 'Bob routine', content: `Bob steps ${Bc.skill}` } });
        expectOk(sk);
        B.skillKey = String(sk.json?.skill?.key ?? '');
      }
      if (isAllowed('POST', '/agent/workspace/upload')) expect((await c.call(BOB, 'POST', '/agent/workspace/upload', { body: { sessionId: B.sMain, files: [{ path: 'bob-upload.txt', content: `Bob upload ${Bc.upload}` }] } })).json?.saved).toBe(1);
      const hello = E.fake.script(BOB, 'hello', steps([
        (ctx) => ({ calls: [
          ...(ctx.offered.has('write_file') ? [{ name: 'write_file', args: { path: 'bob-own.txt', content: `Bob file ${Bc.fileTool}` } }] : []),
          ...(ctx.offered.has('remember') ? [{ name: 'remember', args: { action: 'add', fact: `Bob's favourite word is ${Bc.memTool}.` } }] : []),
          ...(ctx.offered.has('manage_skill') && !B.skillKey ? [{ name: 'manage_skill', args: { action: 'create', slug: B.skillSlug, name: 'Bob routine', description: 'Bob routine', instructions: `Bob steps ${Bc.skill}` } }] : []),
        ] }),
      ], `Hi ${Bc.reply}`));
      const run = await runToEnd(c, BOB, hello, { sessionId: B.sMain, text: `Bob says ${Bc.msg}` });
      expect(run.follow?.status, run.follow?.text.slice(-600)).toBe('done');
      B.runMain = run.runId!;
      const bobOwn = findFile(accDir(BOB), Bc.fileTool, 'bob-own.txt');
      // bob's tool working folder anchors the relative / symlink probes in test 5; a wrong guess would aim them at nothing
      if (hello.called.has('write_file')) {
        expect(bobOwn, "bob's write_file('bob-own.txt') not found under accounts/bob").toBeTruthy();
        expect(bobOwn.startsWith(accDir(BOB) + '/'), bobOwn).toBe(true);
      }
      B.cwdDir = dirname(bobOwn || join(accDir(BOB), 'workspace', 'x'));
      B.sessionDir = dirname(findFile(accDir(BOB), Bc.upload, 'bob-upload.txt') || join(B.cwdDir, 'x'));
      B.skillKey ||= 'probe';
      // bob sees his own things (the sweep below would otherwise prove nothing)
      expect(respLeaks(await c.call(BOB, 'GET', '/agent/memory'), [Bc.memHttp])).toEqual([Bc.memHttp]);
      expect(respLeaks(await c.call(BOB, 'GET', `/agent/sessions/${B.sMain}/messages`), [Bc.msg])).toEqual([Bc.msg]);

      const bobIds: Ids = { session: B.sMain, run: B.runMain, slug: B.agentSlug, key: B.skillKey, approval: randomUUID(), inquiry: randomUUID(), message: randomUUID(), other: 'probe' };
      const hostileHeaders = { 'x-forsion-role': 'ADMIN', 'x-forsion-username': ALICE, 'x-forsion-remote': 'tunnel', 'x-forsion-remote-role': 'delegated-admin' };
      for (const headers of [{}, hostileHeaders]) {
        for (const e of E.routeAllowlist.filter((x) => x.method.toUpperCase() === 'GET')) {
          const path = fillPath(e.path, (k, p) => paramFor(k, p, bobIds));
          await c.call(BOB, 'GET', path, { query: { session_id: B.sMain, sessionId: B.sMain, agentSlug: B.agentSlug }, headers, streamMs: 700, label: 'sweep' });
        }
      }
    });
    const bad: string[] = [];
    for (const r of c.log.filter((x) => x.user === BOB)) {
      const hits = respLeaks(r, [...aliceContent(), PW, ...aliceIds()]);
      if (hits.length) bad.push(`${hits.join(', ')}\n${describeResp(r)}`);
    }
    expect(bad, 'alice content or ids in bob responses').toEqual([]);
  }, 180_000);

  it("3 · bob with alice's ids gets exactly what a nonexistent id gets, while her run is live", async () => {
    expect(A.sMain && A.runMain).toBeTruthy();
    // alice's run, held inside its first model call
    const live = E.fake.script(ALICE, 'live', steps([{ calls: [{ name: 'noop_probe_tool', args: {} }] }], `Live done ${C.replyLive}`));
    const gate = E.fake.gate(live.token, 0);
    const st = await startRun(c, ALICE, live, { sessionId: A.sLive, text: `Live ${C.msgLive}` });
    expect(st.runId, describeResp(st.resp)).toBeTruthy();
    A.runLive = st.runId!;
    await Promise.race([gate.reached, sleep(20_000)]);

    const ops = (x: { sMain: string; sLive: string; sX: string; runLive: string; runPark: string; inquiry: string; msg: string }): Array<[string, string, unknown?]> => [
      ...['messages', 'detail', 'config', 'status', 'timeline', 'usage', 'checkpoints', 'changes', 'background', 'asides'].map((s) => ['GET', `/agent/sessions/${x.sMain}/${s}`] as [string, string]),
      ['GET', `/agent/sessions/${x.sLive}/messages`],
      ['PATCH', `/agent/sessions/${x.sX}`, { title: 'renamed by bob', title_source: 'user', archived: true }],
      ['PUT', `/agent/sessions/${x.sX}/config`, { systemPrompt: 'bob was here' }],
      ['POST', `/agent/sessions/${x.sX}/read`, {}],
      ['POST', `/agent/sessions/${x.sX}/messages/delete`, { ids: [x.msg] }],
      ['DELETE', `/agent/sessions/${x.sX}`],
      ['GET', `/agent/runs/${x.runLive}/events`],
      ['POST', `/agent/runs/${x.runLive}/steer`, { message: `Bob steers ${Bc.steer}` }],
      ['POST', `/agent/runs/${x.runLive}/steer`, { flush: true }],
      ['DELETE', `/agent/runs/${x.runLive}/steer/${x.msg}`],
      ['POST', `/agent/runs/${x.runLive}/compaction/skip`, { operationId: 'probe' }],
      ['POST', `/agent/runs/${x.runLive}/abort`, {}],
      ['POST', `/agent/runs/${x.runLive}/approvals/${x.msg}`, { action: 'approve' }],
      ...(A.runPark ? [
        ['POST', `/agent/runs/${x.runPark}/inquiries/${x.inquiry}`, { answer: `Bob answers ${Bc.answer}` }],
        ['POST', `/agent/runs/${x.runPark}/approvals/${x.inquiry}`, { action: 'approve_always' }],
        ['POST', `/agent/runs/${x.runPark}/abort`, {}],
      ] as Array<[string, string, unknown]> : []),
    ];
    const real = { sMain: A.sMain, sLive: A.sLive, sX: A.sX, runLive: A.runLive, runPark: A.runPark, inquiry: A.inquiryId || randomUUID(), msg: randomUUID() };
    const twin = Object.fromEntries(Object.entries(real).map(([k, v]) => [k, twinLike(v)])) as typeof real;
    const pairs = Object.keys(real).map((k) => [(real as any)[k], (twin as any)[k]] as [string, string]);
    const problems: string[] = [];
    const realOps = ops(real), twinOps = ops(twin);
    for (let i = 0; i < realOps.length; i++) {
      const [m, p, body] = realOps[i];
      const tw = await c.call(BOB, m, twinOps[i][1], { body: twinOps[i][2], streamMs: 600, label: 'by-id twin' });
      const hr = await c.call(BOB, m, p, { body, streamMs: 600, label: 'by-id' });
      const pattern = patternOf(m, p);
      const allowed = pattern ? isAllowed(m, pattern) : false;
      if (allowed ? hr.status !== 404 : ![403, 404].includes(hr.status)) problems.push(`${m} ${pattern ?? p}: expected ${allowed ? '404' : '403/404'}, got ${hr.status}\n${describeResp(hr)}`);
      const norm = (r: Resp) => `${r.status} ${normalize(r.text, pairs.map(([a, b], j) => [[a, `<ID${j}>`], [b, `<ID${j}>`]] as Array<[string, string]>).flat())}`;
      if (norm(hr) !== norm(tw)) problems.push(`${m} ${pattern ?? p}: alice's id is distinguishable from a nonexistent one\n  real: ${norm(hr).slice(0, 300)}\n  twin: ${norm(tw).slice(0, 300)}`);
    }
    // list of runs by session: nothing of alice's
    const runs = await c.call(BOB, 'GET', '/agent/runs', { query: { session_id: A.sMain } });
    if (runs.status === 200 && (runs.json?.runs ?? []).length) problems.push(`GET /agent/runs?session_id=<alice> listed runs: ${runs.text.slice(0, 300)}`);
    expect(problems).toEqual([]);

    // alice's run was neither aborted nor steered; it finishes with her own reply
    expect(gate.signal()?.aborted ?? false, "alice's model call was aborted by bob").toBe(false);
    const aRuns = await c.call(ALICE, 'GET', '/agent/runs', { query: { session_id: A.sLive } });
    expect(aRuns.text, 'alice still sees her live run').toContain(A.runLive);
    gate.release();
    const done = await c.follow(ALICE, A.runLive, { timeoutMs: 30_000 });
    expect(done.status, done.text.slice(-600)).toBe('done');
    expect(done.final).toContain(C.replyLive);
    expect(live.requests.map((r) => r.text).join('\n').includes(Bc.steer), "bob's steer reached alice's run").toBe(false);
    // the spare session is untouched
    const det = await c.call(ALICE, 'GET', `/agent/sessions/${A.sX}/detail`);
    expect(det.status, describeResp(det)).toBe(200);
    expect(det.text).toContain(C.titleX);
    expect(det.text.includes('renamed by bob')).toBe(false);
    if (A.runPark) expect((await c.call(ALICE, 'GET', '/agent/runs', { query: { session_id: A.sPark } })).text, 'alice parked run still waiting').toContain(A.runPark);

    // process-wide prompt views: bob listens while alice's run asks a new question
    const streamP = c.call(BOB, 'GET', '/agent/approvals/stream', { streamMs: 4000, label: 'bob live prompt stream' });
    await sleep(300);
    const park2 = E.fake.script(ALICE, 'park2', steps([(ctx) => ({ calls: ctx.offered.has('ask_user') ? [{ name: 'ask_user', args: { question: `Alice wonders about ${C.question2}?` } }] : [] })], 'noted'));
    const p2 = await startRun(c, ALICE, park2, { sessionId: A.sPark2, text: `Second park ${C.msgPark2}` });
    A.runPark2 = p2.runId ?? '';
    const f2 = A.runPark2 ? await c.follow(ALICE, A.runPark2, { until: (ev) => ev.type === 'inquiry_request', autoAnswer: false, timeoutMs: 20_000 }) : null;
    A.inquiryId2 = String(f2?.events.find((e) => e.type === 'inquiry_request')?.payload?.inquiryId ?? '');
    const views = [
      await c.call(BOB, 'GET', '/agent/approvals/pending'),
      await c.call(BOB, 'GET', '/agent/sessions/attention'),
      await c.call(BOB, 'GET', '/agent/sessions'),
      await streamP,
    ];
    const needles = [A.sPark, A.sPark2, A.runPark, A.runPark2, A.inquiryId, A.inquiryId2, C.question, C.question2, C.titlePark, C.titlePark2].filter(Boolean);
    for (const v of views) expect(respLeaks(v, needles), describeResp(v)).toEqual([]);
    // bob's own session list: nothing marked busy by alice's runs
    const mine = (views[2].json?.sessions ?? []) as any[];
    expect(mine.filter((s) => s.busy).map((s) => s.id), 'bob sessions busy because of alice').toEqual([]);
    if (A.runPark2 && A.inquiryId2) {
      expectOk(await c.call(ALICE, 'POST', `/agent/runs/${A.runPark2}/inquiries/${A.inquiryId2}`, { body: { answer: 'fine' } }));
      expect((await c.follow(ALICE, A.runPark2, { timeoutMs: 30_000 })).status).toBe('done');
    }

    // alice's baseline view for test 11 (she is idle from here on, her parked run stays parked)
    await quiet();
    const aIds: Ids = { session: A.sMain, run: A.runMain, slug: A.agentSlug, key: A.skillKey, approval: 'probe', inquiry: 'probe', message: 'probe', other: 'probe' };
    A.view = await viewOf(ALICE, aIds);
  }, 240_000);

  it('4 · every registered route is allowlisted and exercised by bob, or refused for him (both directions)', async () => {
    expect(A.sX && A.sacAgentSlug && A.runMain).toBeTruthy();
    const allow = allowSet();
    const registered = new Set(E.routes.filter((r) => r.kind === 'route').map((r) => routeKey(r.method, r.path)));
    const orphans = [...allow].filter((k) => !registered.has(k));
    expect(orphans, 'allowlist entries with no registered route (renamed route, or a pattern spelled differently)').toEqual([]);

    const problems: string[] = [];
    const exercised = new Set<string>();
    const twinFile = join(dirname(A.aliceFile), `nope-${randLower(8)}.txt`);
    const freshB = randomUUID();
    const readIds: Ids = { session: A.sMain, run: A.runMain, slug: A.agentSlug, key: A.skillKey || 'probe', approval: randomUUID(), inquiry: A.inquiryId || randomUUID(), message: randomUUID(), other: 'probe' };
    const writeIds: Ids = { session: A.sX, run: A.runX, slug: A.sacAgentSlug, key: A.sacSkillKey || 'probe', approval: randomUUID(), inquiry: A.inquiryId || randomUUID(), message: randomUUID(), other: 'probe' };
    const twinIds = (ids: Ids): Ids => Object.fromEntries(Object.entries(ids).map(([k, v]) => [k, v === 'probe' ? v : twinLike(v)])) as unknown as Ids;
    const query = (ids: Ids, file: string) => ({
      session_id: ids.session, sessionId: ids.session, runId: ids.run, agentSlug: ids.slug, slug: ids.slug, key: ids.key,
      path: 'alice-upload.txt', file, dir: accDir(ALICE), cwd: accDir(ALICE), q: 'ALICE_CANARY', query: 'ALICE_CANARY',
    });
    const body = (ids: Ids, file: string) => ({
      ...query(ids, file), session_id: freshB, path: file, sourcePath: A.skillFile ? dirname(A.skillFile) : accDir(ALICE), project_path: accDir(ALICE),
      projectPath: accDir(ALICE), target: file, sourceAgentSlug: ids.slug, ids: [ids.message], files: [{ path: '../../alice/traversal-probe.txt', content: 'bob traversal probe' }],
      name: 'bob-probe', title: 'bob probe', text: 'bob probe note', message: 'probe', model_id: MODEL_ID, operationId: 'probe', action: 'reject', answer: 'probe', disabled: true,
    });
    const allPairs = (a: Ids, b: Ids): Array<[string, string]> => (Object.keys(a) as Array<keyof Ids>).flatMap((k, j) => [[a[k], `<ID${j}>`], [b[k], `<ID${j}>`]] as Array<[string, string]>)
      .concat([[A.aliceFile, '<FILE>'], [twinFile, '<FILE>']]);

    await bobWindow('route-traversal', async () => {
      for (const r of E.routes) {
        if (r.kind === 'regex') { problems.push(`regex route ${r.path} cannot be traversed by this test`); continue; }
        if (r.kind === 'mount') {
          const res = await c.call(BOB, 'GET', `${r.path}/probe`, { label: 'mount' });
          if (![403, 404].includes(res.status)) problems.push(`mounted handler ${r.path} answered bob with ${res.status}`);
          continue;
        }
        const methods = r.method === 'ALL' ? ['GET', 'POST'] : [r.method];
        for (const m of methods) {
          const key = routeKey(r.method, r.path);
          if (allow.has(key)) {
            exercised.add(key);
            const real = m === 'GET' ? readIds : writeIds;
            const tw = twinIds(real);
            const opts = (ids: Ids, file: string) => (m === 'GET' ? { query: query(ids, file) } : { body: body(ids, file) });
            const rt = await c.call(BOB, m, fillPath(r.path, (k, p) => paramFor(k, p, tw)), { ...opts(tw, twinFile), streamMs: 600, label: 'traverse twin' });
            const rr = await c.call(BOB, m, fillPath(r.path, (k, p) => paramFor(k, p, real)), { ...opts(real, A.aliceFile), streamMs: 600, label: 'traverse' });
            const idRoute = paramNames(r.path).length > 0 && /^\/agent\/(runs|sessions)\/:/.test(r.path);
            if (idRoute && rr.status !== 404) problems.push(`${key}: bob with alice's id got ${rr.status}, expected 404\n${describeResp(rr)}`);
            if (m === 'GET') {
              const pairs = allPairs(real, tw);
              if (`${rr.status} ${normalize(rr.text, pairs)}` !== `${rt.status} ${normalize(rt.text, pairs)}`) {
                problems.push(`${key}: alice's ids / paths distinguishable from nonexistent ones\n  real: ${rr.status} ${normalize(rr.text, pairs).slice(0, 300)}\n  twin: ${rt.status} ${normalize(rt.text, pairs).slice(0, 300)}`);
              }
            } else if (paramNames(r.path).length && rr.status !== rt.status) {
              problems.push(`${key}: alice's ids distinguishable from nonexistent ones (${rr.status} vs ${rt.status})`);
            }
          } else if (key === 'GET /health') {
            continue; // open to everyone in this mode (no credentials, no account data; checked in the gate suite)
          } else {
            const path = fillPath(r.path, (k, p) => paramFor(k, p, writeIds));
            const variants = [path, `${path}/`, path.replace(/^\/agent\//, '/agent//'), path.toUpperCase(), path.replace(/^\/agent\/(.)/, (_x, ch) => `/agent/%${ch.charCodeAt(0).toString(16)}`)];
            for (const v of variants) {
              const res = await c.call(BOB, m, v, { body: m === 'GET' ? undefined : body(writeIds, A.aliceFile), streamMs: 400, label: 'refused?' });
              if (![403, 404].includes(res.status)) problems.push(`${m} ${v} (not allowlisted) answered bob with ${res.status}\n${describeResp(res)}`);
            }
            const adm = await c.call(BOB, m, path, { body: m === 'GET' ? undefined : body(writeIds, A.aliceFile), headers: { 'x-forsion-role': 'ADMIN' }, streamMs: 400, label: 'refused? admin header' });
            if (![403, 404].includes(adm.status)) problems.push(`${m} ${path} with x-forsion-role: ADMIN answered bob with ${adm.status}`);
          }
        }
      }
    });
    const missed = [...allow].filter((k) => registered.has(k) && !exercised.has(k));
    expect(missed, 'allowlisted routes bob never exercised').toEqual([]);
    expect(problems).toEqual([]);
    for (const r of c.log.filter((x) => x.user === BOB)) expect(respLeaks(r, aliceContent()), describeResp(r)).toEqual([]);
  }, 600_000);

  it("5 · bob's tools: only allowlisted, nothing forbidden; every one aimed at alice's things returns nothing of hers", async () => {
    expect(A.aliceFile && B.cwdDir).toBeTruthy();
    // symlinks inside bob's folders pointing at alice's file and folder
    for (const dir of new Set([B.cwdDir, B.sessionDir])) {
      if (!existsSync(dir)) continue;
      for (const [name, target] of [['link-to-alice.txt', A.aliceFile], ['link-to-alice-dir', accDir(ALICE)]]) {
        try { symlinkSync(target, join(dir, name)); } catch { /* exists */ }
      }
    }
    writeFileSync(join(accDir(ALICE), DIR_MARKER), 'marker');
    // a spare file of alice's for the destructive calls (her real file stays the read target)
    const sacrifice = join(dirname(A.aliceFile), `alice-spare-${randLower(6)}.txt`);
    writeFileSync(sacrifice, `Spare ${C.fileTool || C.upload}`);
    const shellMarkers = [join(env.tmp, 'bob-shell-marker-a'), join(env.tmp, 'bob-shell-marker-b'), join(accDir(BOB), 'bob-shell-marker-c')];
    const twinFile = join(dirname(A.aliceFile), `nope-${randLower(8)}.txt`);
    const varSpelling = (p: string) => p.replace(/^\/private\/var\//, '/var/');
    const targets = { fileAbs: A.aliceFile, dirAbs: accDir(ALICE), sessionId: A.sMain, runId: A.runMain, agentSlug: A.agentSlug, skillSlug: A.skillSlug, shellMarker: shellMarkers[0] };
    const relToAlice = relative(B.cwdDir, A.aliceFile);
    const fileProbes: ToolCallSpec[] = [
      ...[A.aliceFile, varSpelling(A.aliceFile), A.uploadAbs, A.personaFile, A.skillFile, join(accDir(ALICE), 'state.db'), relToAlice, '../alice/workspace/alice-notes.txt',
        'link-to-alice.txt', `link-to-alice-dir/${relative(accDir(ALICE), A.aliceFile)}`, twinFile, 'bob-own.txt'].map((path) => ({ name: 'read_file', args: { path } })),
      ...[join(env.home, 'accounts'), env.home, accDir(ALICE), varSpelling(accDir(ALICE)), '..', '../..', 'link-to-alice-dir', join(accDir('zelda-nobody'))].map((path) => ({ name: 'list_dir', args: { path } })),
      { name: 'glob_files', args: { pattern: '../../alice/**' } }, { name: 'glob_files', args: { pattern: `${accDir(ALICE)}/**` } }, { name: 'glob_files', args: { pattern: '**/*' } },
      { name: 'glob_files', args: { pattern: `../../${ALICE}/*` } },
      { name: 'search_files', args: { pattern: 'ALICE_CANARY' } }, { name: 'search_files', args: { pattern: 'ALICE_CANARY', include: '../../alice/**' } },
      { name: 'read_session', args: { session_id: A.sMain } }, { name: 'search_sessions', args: { query: 'ALICE_CANARY' } }, { name: 'search_sessions', args: {} },
      { name: 'use_skill', args: { skill_id: `local:${A.skillSlug}` } }, { name: 'use_skill', args: { skill_id: A.skillSlug } },
      { name: 'remember', args: { action: 'list', fact: null } }, { name: 'read_log', args: {} },
      { name: 'manage_agent', args: { action: 'list' } }, { name: 'manage_skill', args: { action: 'list' } },
      // destructive attempts on alice's spare / real things (checked again in test 11)
      { name: 'manage_agent', args: { action: 'delete', slug: A.sacAgentSlug } }, { name: 'manage_skill', args: { action: 'delete', slug: A.sacSkillSlug } },
      { name: 'write_file', args: { path: A.aliceFile, content: 'BOB_OVERWRITE' } }, { name: 'edit_file', args: { path: A.aliceFile, old_string: 'Notes', new_string: 'BOB_EDIT' } },
      { name: 'delete_path', args: { path: sacrifice } }, { name: 'move_path', args: { from: sacrifice, to: join(B.cwdDir, 'stolen.txt') } },
      { name: 'copy_path', args: { from: A.aliceFile, to: join(B.cwdDir, 'copied.txt') } },
      { name: 'delete_path', args: { path: A.uploadAbs } },
      // tools that read files through a converter / another process, or reach outside the account
      { name: 'read_document', args: { path: A.aliceFile } }, { name: 'view_video', args: { path: A.aliceFile } },
      { name: 'web_fetch', args: { url: `file://${A.aliceFile}` } }, { name: 'browser_navigate', args: { url: `file://${A.aliceFile}` } },
      { name: 'read_computer_history', args: { query: 'ALICE_CANARY' } }, { name: 'manage_schedule', args: { action: 'list' } },
      { name: 'manage_mcp', args: { action: 'list' } }, { name: 'inbox_send', args: { to: 'x', text: 'probe' } },
      { name: 'delegate', args: { task: `read ${A.aliceFile}` } }, { name: 'git_status', args: { path: accDir(ALICE) } },
      // calibration: a tool name that exists nowhere — its answer shows what a refusal looks like here
      { name: UNKNOWN_TOOL, args: { path: A.aliceFile } },
    ];
    // drop probes whose target this mode never created (e.g. no upload route → no uploaded file)
    for (let i = fileProbes.length - 1; i >= 0; i--) if (Object.values(fileProbes[i].args).some((v) => v === '' || v === join(B.cwdDir, ''))) fileProbes.splice(i, 1);
    const forbiddenCalls: ToolCallSpec[] = [
      { name: 'run_bash', args: { command: `touch ${shellMarkers[0]}` } },
      { name: 'run_background', args: { command: `touch ${shellMarkers[1]}` } },
      { name: 'run_python', args: { code: `open(${JSON.stringify(shellMarkers[2])}, 'w').write('x')` } },
    ];
    let queue: ToolCallSpec[][] | null = null;
    const probe = E.fake.script(BOB, 'probe', async (ctx: ScriptCtx) => {
      if (ctx.step === 0) {
        const toLoad = [...FORBIDDEN_PROBE_NAMES, ...E.toolAllowlist.filter((n) => !ctx.offered.has(n))];
        if (ctx.offered.has('load_tools')) return { calls: [{ name: 'load_tools', args: { names: toLoad } }] };
      }
      if (!queue) {
        // every probe is called, offered or not: a tool outside the allowlist must be refused where it would execute
        const explicit = fileProbes;
        const covered = new Set(explicit.map((p) => p.name));
        const generic = [...new Set([...E.toolAllowlist, ...ctx.offered])].filter((n) => !covered.has(n) && n !== 'load_tools')
          .map((name) => ({ name, args: hostileArgs(ctx.schemas.get(name), targets) }));
        // one call per turn that succeeds, so a turn of refusals never looks like a tool-failure loop
        const filler = ['get_datetime', 'todo_read', 'list_dir'].find((n) => ctx.offered.has(n));
        const withFiller = (g: ToolCallSpec[]) => (filler ? [...g, { name: filler, args: filler === 'list_dir' ? { path: '.' } : {} }] : g);
        queue = [...chunk(explicit, 6), ...chunk(generic, 6), forbiddenCalls].map(withFiller);
      }
      const g = queue.shift();
      return g ? { calls: g } : { text: 'probe finished' };
    });
    const t0 = Date.now();
    const run = await bobWindow('tool-probe', () => runToEnd(c, BOB, probe, { sessionId: B.sMain, text: 'Please look around.', timeoutMs: 180_000 }));
    const t1 = Date.now();
    expect(run.follow?.status, run.follow?.text.slice(-800) ?? describeResp(run.resp)).toBe('done');

    // tool lists: a subset of the allowlist, nothing forbidden — in every request bob's runs made, before and after load_tools
    const bobOut = E.fake.outbound.filter((r) => outboundAccount(r) === BOB);
    expect(bobOut.length).toBeGreaterThan(0);
    const offeredAll = new Set(bobOut.flatMap((r) => r.tools));
    expect([...offeredAll].filter((n) => !E.toolAllowlist.includes(n)), 'offered to bob but not in toolAllowlist').toEqual([]);
    expect([...offeredAll].filter((n) => FORBIDDEN_TOOL_RE.test(n)), 'forbidden tools offered').toEqual([]);
    expect(E.toolAllowlist.filter((n) => FORBIDDEN_TOOL_RE.test(n)), 'forbidden tools in the allowlist itself').toEqual([]);
    for (const n of E.toolAllowlist) if (!offeredAll.has(n)) warnings.push(`allowlisted tool ${n} was never offered to bob's run`);
    // outputs: nothing of alice; file tricks refused; existence is not observable
    const results = probe.results;
    expect(results.filter((r) => Object.values(r.args).includes(A.aliceFile)).length, "no probe was aimed at alice's real file").toBeGreaterThan(0);
    const executed = new Set(results.map((r) => r.name));
    expect(E.toolAllowlist.filter((n) => !executed.has(n) && n !== 'load_tools'), 'allowlisted tools the probe never got a result from').toEqual([]);
    const leaks = results.filter((r) => leakHits(r.output, aliceContent()).length).map((r) => `${r.name}(${JSON.stringify(r.args).slice(0, 160)}) → ${r.output.slice(0, 300)}`);
    expect(leaks, 'tool output carried alice content').toEqual([]);
    const out = (name: string, path: string) => results.find((r) => r.name === name && r.args.path === path)?.output;
    if (E.toolAllowlist.includes('read_file')) {
      const own = out('read_file', 'bob-own.txt');
      expect(own ?? '', 'bob reads his own file (positive control)').toContain(Bc.fileTool);
      const real = out('read_file', A.aliceFile), twin = out('read_file', twinFile);
      expect(real, 'read_file on alice file produced no output').toBeDefined();
      const pairs: Array<[string, string]> = [[A.aliceFile, '<P>'], [twinFile, '<P>']];
      expect(normalize(real ?? '', pairs), "read_file tells alice's existing file from a missing one").toBe(normalize(twin ?? '', pairs));
    }
    for (const r of results.filter((x) => x.name === 'list_dir' || x.name === 'glob_files')) {
      const asked = String(r.args.path ?? r.args.pattern ?? '');
      const inBob = !asked.includes('*') && resolve(B.cwdDir, asked).startsWith(accDir(BOB) + '/') && !asked.includes('link-to-alice');
      if (inBob) continue;
      expect(r.output.includes(DIR_MARKER), `${r.name}(${asked}) listed alice's folder → ${r.output.slice(0, 300)}`).toBe(false);
      // a listing of accounts/ (or above) that names alice
      if ([join(env.home, 'accounts'), env.home].includes(resolve(B.cwdDir, asked))) {
        expect(r.output.split(asked).join('').includes(ALICE), `${r.name}(${asked}) → ${r.output.slice(0, 300)}`).toBe(false);
      }
    }
    for (const r of results.filter((x) => forbiddenCalls.some((f) => f.name === x.name))) {
      expect(r.output, `${r.name} must be refused`).toMatch(REFUSAL_RE);
    }
    // hard-called tools outside the allowlist: each got an answer, and the answer is a refusal (calibrated on a name
    // that exists nowhere), never a result
    const unknown = results.find((r) => r.name === UNKNOWN_TOOL);
    expect(unknown, 'the made-up tool got no answer').toBeDefined();
    expect(unknown!.output, `made-up tool answer does not look like a refusal (fix REFUSAL_RE): ${unknown!.output.slice(0, 200)}`).toMatch(REFUSAL_RE);
    const hardCalled = [...new Set(fileProbes.map((p) => p.name))].filter((n) => !E.toolAllowlist.includes(n) && n !== UNKNOWN_TOOL);
    const notRefused: string[] = [];
    for (const n of hardCalled) {
      const rs = results.filter((r) => r.name === n);
      if (!rs.length) { notRefused.push(`${n}: no answer at all`); continue; }
      for (const r of rs) if (!REFUSAL_RE.test(r.output) || r.output.includes(DIR_MARKER)) notRefused.push(`${n}(${JSON.stringify(r.args).slice(0, 120)}) → ${r.output.slice(0, 240)}`);
      for (const r of rs) toolRefusals.set(n, r.output.slice(0, 160));
    }
    expect(notRefused, 'tools outside the allowlist ran instead of being refused').toEqual([]);
    expect(existsSync(sacrifice), "alice's spare file was moved or deleted").toBe(true);
    for (const f of ['stolen.txt', 'copied.txt']) expect(existsSync(join(B.cwdDir, f)), `${f} appeared in bob's folder`).toBe(false);
    for (const m of shellMarkers) expect(existsSync(m), `marker ${m} written: a command ran`).toBe(false);
    const spawned = spawnLog().filter((x) => !x.tag && x.at >= t0 && x.at <= t1);
    expect(spawned.map((x) => `${x.fn} ${x.command} [${x.account}]`), 'child process during bob run').toEqual([]);
    // alice's file is untouched by the destructive attempts
    expect(readFileSync(A.aliceFile, 'utf8')).not.toMatch(/BOB_/);
    if (A.uploadAbs) expect(existsSync(A.uploadAbs), "alice's upload was moved or deleted").toBe(true);
  }, 300_000);

  it('6 · bob cannot point sessions or runs at folders outside his own, nor borrow alice agents through run knobs', async () => {
    expect(B.sMain && B.cwdDir).toBeTruthy();
    const outsidePaths = [accDir(ALICE), join(accDir(ALICE), 'workspace'), join(env.home, 'accounts'), env.home, '/', join(accDir(BOB), '..', ALICE), env.userHome];
    const problems: string[] = [];
    const markers = [join(env.tmp, 'bob-verify-marker'), join(env.tmp, 'bob-knob-marker')];
    await bobWindow('knobs', async () => {
      // in-bounds folder accepted (positive control)
      const okS = await c.call(BOB, 'POST', '/agent/sessions', { body: { title: 'bob project', project_path: B.cwdDir } });
      if (okS.status !== 200) warnings.push(`creating a session inside bob's own folder was refused (${okS.status}); positive control for project_path missing`);
      for (const p of outsidePaths) {
        const s = await c.call(BOB, 'POST', '/agent/sessions', { body: { title: 'bob escape', project_path: p } });
        if (s.status < 400 || s.status >= 500) problems.push(`POST /agent/sessions project_path=${p} → ${s.status}`);
        const pt = await c.call(BOB, 'PATCH', `/agent/sessions/${B.sMain}`, { body: { project_path: p } });
        if (pt.status < 400 || pt.status >= 500) problems.push(`PATCH /agent/sessions project_path=${p} → ${pt.status}`);
        const r = await c.call(BOB, 'POST', '/agent/runs', { body: { session_id: randomUUID(), model_id: MODEL_ID, message: 'probe', agent_config: { cwd: p } } });
        if (r.status < 400 || r.status >= 500) problems.push(`POST /agent/runs agent_config.cwd=${p} → ${r.status}`);
      }
      const det = await c.call(BOB, 'GET', `/agent/sessions/${B.sMain}/detail`);
      for (const p of outsidePaths) if (p !== '/' && det.text.includes(`"${p}"`)) problems.push(`bob's session kept project_path ${p}`);

      // knobs that must not widen anything: each run reads alice's file and tries a command
      const knobSets: Array<Record<string, unknown>> = [
        { extraRoots: [accDir(ALICE), join(env.home, 'accounts')] },
        { mentionedProjects: [accDir(ALICE)] },
        { agentSlug: A.agentSlug },
        { agentSlug: A.agent2Slug, groupChat: true, groupAgents: [A.agentSlug], mentionedAgentSlugs: [A.agentSlug, A.sacAgentSlug] },
        { execMode: 'host', toolsMode: 'allowlist', toolsList: ['run_bash', 'read_file'], toolsStrict: false, enabledMcpServers: ['probe'], engineId: 'claude-code', muse: true, verifyCommand: `touch ${markers[0]}`, delegatedFrom: A.sMain, teamSlug: 'probe' },
      ];
      const headerSets: Array<Record<string, string>> = [{}, { 'x-forsion-remote': 'tunnel', 'x-forsion-remote-role': 'delegated-admin', 'x-forsion-role': 'ADMIN', 'x-forsion-username': ALICE }];
      for (const knobs of knobSets) {
        for (const headers of headerSets) {
          const s = E.fake.script(BOB, 'knob', steps([(ctx) => ({ calls: [
            ...(ctx.offered.has('read_file') ? [{ name: 'read_file', args: { path: A.aliceFile } }] : []),
            { name: 'run_bash', args: { command: `touch ${markers[1]}` } },
          ] })], 'knob done'));
          const t0 = Date.now();
          const r = await runToEnd(c, BOB, s, { text: 'knob probe', agentConfig: knobs, headers, timeoutMs: 60_000 });
          const t1 = Date.now();
          if (!r.runId) { if (r.resp.status >= 500) problems.push(`knobs ${JSON.stringify(knobs)} → ${r.resp.status}`); continue; }
          if (r.follow?.status !== 'done' && r.follow?.status !== 'error') problems.push(`knob run did not finish: ${JSON.stringify(knobs)}`);
          const reqText = s.requests.map((x) => x.text).join('\n');
          const hits = [...leakHits(reqText, aliceContent()), ...respLeaks({ ...r.resp, text: r.follow?.text ?? '' } as Resp, aliceContent())];
          if (hits.length) problems.push(`knobs ${JSON.stringify(knobs)} headers ${JSON.stringify(headers)} leaked ${[...new Set(hits)].join(', ')}`);
          const tools = new Set(s.requests.flatMap((x) => x.tools));
          const extra = [...tools].filter((n) => !E.toolAllowlist.includes(n));
          if (extra.length) problems.push(`knobs ${JSON.stringify(knobs)} widened tools: ${extra.join(', ')}`);
          const spawned = spawnLog().filter((x) => !x.tag && x.at >= t0 && x.at <= t1);
          if (spawned.length) problems.push(`knobs ${JSON.stringify(knobs)} started ${spawned.map((x) => x.command).join(' | ')}`);
        }
      }
    });
    for (const m of markers) expect(existsSync(m), `marker ${m}`).toBe(false);
    expect(problems).toEqual([]);
  }, 300_000);

  it("7 · masking tables are per account: alice's placeholder never turns back into her secret for bob", async () => {
    expect(A.ph && A.pwPh).toBeTruthy();
    await bobWindow('masking', async () => {
      const echo = E.fake.script(BOB, 'echo', steps([(ctx) => ({ calls: [
        ...(ctx.offered.has('write_file') ? [{ name: 'write_file', args: { path: 'bob-echo.txt', content: `echo ${A.ph} ${A.pwPh}` } }] : []),
        ...(ctx.offered.has('remember') ? [{ name: 'remember', args: { action: 'add', fact: `Bob once saw ${A.ph}.` } }] : []),
      ] })], `Echo: ${A.ph} ${A.pwPh}`));
      const r = await runToEnd(c, BOB, echo, { text: `I found ${A.ph} and ${A.pwPh} in an old log.` });
      expect(r.follow?.status, r.follow?.text.slice(-600)).toBe('done');
      expect(echo.requests.map((x) => x.text).join('\n'), "bob's own request carries the placeholder he typed").toContain(A.ph);
      const surfaces = [
        r.follow!.text,
        (await c.call(BOB, 'GET', `/agent/sessions/${r.sessionId}/messages`)).text,
        (await c.call(BOB, 'GET', '/agent/memory')).text,
        ...echo.results.map((x) => x.output),
      ];
      for (const s of surfaces) expect(leakHits(s, [SECRET, PW]), s.slice(0, 400)).toEqual([]);
      expect(grepTree(accDir(BOB), [SECRET, PW]), "alice's secret restored into bob's files").toEqual([]);

      // a value alice's message taught the masker is not masked for bob: he typed it in plain prose, it leaves as typed
      pwSentAtSeq = c.log.length;
      const plain = E.fake.script(BOB, 'plain', steps([], 'ok'));
      const r2 = await runToEnd(c, BOB, plain, { text: `The code ${PW} appears in my notes.` });
      expect(r2.follow?.status).toBe('done');
      const sent = plain.requests.map((x) => x.text).join('\n');
      expect(sent, "bob's plain text was rewritten using what the masker learned from alice").toContain(PW);

      // bob switches his masking off and leaves it off: test 11 checks alice's next request is still masked
      const off = await c.call(BOB, 'PUT', '/agent/masking', { body: { secrets: false, personal: false, action: 'warn' } });
      if (off.status >= 300) warnings.push(`PUT /agent/masking → ${off.status}; per-account masking settings not exercised`);
    });
  }, 180_000);

  it("8 · session ids are one namespace: alice's ids are 404 for bob and leave her untouched; non-UUID ids are 400", async () => {
    expect(A.sMain).toBeTruthy();
    const problems: string[] = [];
    const taken = [[A.sMain, 'main'], [A.sX, 'spare'], ...(A.runPark ? [[A.sPark, 'parked (run waiting)']] : [])].filter(([sid]) => sid) as Array<[string, string]>;
    const aliceBefore = new Map<string, string>();
    for (const [sid] of taken) aliceBefore.set(sid, (await c.call(ALICE, 'GET', `/agent/sessions/${sid}/messages`)).text);
    const bodies = new Map<string, string>();
    await bobWindow('collisions', async () => {
      // (a) alice's session ids: 404, nothing of hers in the answer, no model call for bob, the same answer whether or
      //     not her run in that session is live
      for (const [sid, label] of taken) {
        const s = E.fake.script(BOB, `collide-${label.split(' ')[0]}`, steps([], `ok ${Bc.collide}`));
        const r = await startRun(c, BOB, s, { sessionId: sid, text: `Bob reuses an id ${Bc.collide}` });
        if (r.resp.status !== 404) problems.push(`${label}: bob starting a run on alice's session id → ${r.resp.status}, expected 404\n${describeResp(r.resp)}`);
        const hits = respLeaks(r.resp, [...aliceContent(), `accounts/${ALICE}`]);
        if (hits.length || /alice/i.test(r.resp.text)) problems.push(`${label}: bob's 404 carries ${hits.join(', ') || 'the name alice'}: ${r.resp.text.slice(0, 200)}`);
        if (r.runId) { problems.push(`${label}: bob got a run (${r.runId}) on alice's session`); await c.follow(BOB, r.runId, { timeoutMs: 20_000 }); }
        await new Promise((res) => setTimeout(res, 300));
        if (s.requests.length) problems.push(`${label}: bob's message reached the model (${s.requests.length} calls)`);
        bodies.set(label, `${r.resp.status} ${r.resp.text.split(sid).join('<SID>')}`);
      }
      if (new Set(bodies.values()).size > 1) problems.push(`the 404 differs between alice's sessions (live run or not):\n  ${[...bodies].map(([k, v]) => `${k}: ${v.slice(0, 200)}`).join('\n  ')}`);

      // (b) a client-chosen session id that is not a UUID: 400, and nothing is created under it
      const badIds = ['bob-custom-session', 'not-a-uuid', randomUUID().slice(0, 35), `${randomUUID()}x`, `${randomUUID()}/`, `../${A.sMain}`, `${A.sMain}/../x`];
      for (const id of badIds) {
        const s = E.fake.script(BOB, 'badid', steps([], 'should not run'));
        const r = await startRun(c, BOB, s, { sessionId: id, text: 'custom id' });
        if (r.resp.status !== 400) problems.push(`session_id ${JSON.stringify(id)} → ${r.resp.status}, expected 400\n${describeResp(r.resp)}`);
        if (r.runId) await c.follow(BOB, r.runId, { timeoutMs: 20_000 });
      }
      const bobList = await c.call(BOB, 'GET', '/agent/sessions');
      const listed = ((bobList.json?.sessions ?? []) as any[]).map((x) => String(x.id));
      for (const id of [...badIds, ...taken.map(([sid]) => sid)]) if (listed.includes(id)) problems.push(`bob's session list contains ${id}`);

      // positive control: a fresh UUID starts at once (not queued behind alice's live run) and is bob's
      const fresh = randomUUID();
      const ok = E.fake.script(BOB, 'collide-fresh', steps([], `ok ${Bc.collide}`));
      const t0 = Date.now();
      const r = await runToEnd(c, BOB, ok, { sessionId: fresh, text: `Bob fresh id ${Bc.collide}`, timeoutMs: 20_000 });
      if (r.follow?.status !== 'done') problems.push(`fresh UUID: bob's run ${r.follow?.status ?? r.resp.status} — ${describeResp(r.resp)}`);
      if (Date.now() - t0 > 15_000) problems.push(`fresh UUID: took ${Date.now() - t0}ms (queued behind alice?)`);
      const hits = leakHits(ok.requests.map((x) => x.text).join('\n'), [...aliceContent(), 'alice-upload-2', `accounts/${ALICE}`]);
      if (hits.length) problems.push(`fresh UUID: bob's request carried ${hits.join(', ')}`);
      if (!(await c.call(BOB, 'GET', `/agent/sessions/${fresh}/messages`)).text.includes(Bc.collide)) problems.push("fresh UUID: bob's own message is not in his new session");
    });
    // alice: her sessions are byte-for-byte what they were, her parked run is still waiting
    for (const [sid, label] of taken) {
      const now = (await c.call(ALICE, 'GET', `/agent/sessions/${sid}/messages`)).text;
      if (now !== aliceBefore.get(sid)) problems.push(`alice's ${label} session changed while bob tried her id`);
      if (now.includes(Bc.collide)) problems.push(`bob's message landed in alice's ${label} session`);
    }
    if (A.runPark && !(await c.call(ALICE, 'GET', '/agent/runs', { query: { session_id: A.sPark } })).text.includes(A.runPark)) problems.push("alice's parked run is gone");
    expect(problems).toEqual([]);
  }, 180_000);

  it('9 · every file change during bob windows is under accounts/bob', () => {
    expect(windowViolations).toEqual([]);
  });

  it("10 · final sweep: bob's responses, bob's outbound requests and every byte outside alice's folder", async () => {
    const respBad: string[] = [];
    for (const r of c.log.filter((x) => x.user !== ALICE)) {
      const needles = r.seq <= pwSentAtSeq ? [...aliceContent(), PW] : aliceContent();
      const hits = respLeaks(r, needles);
      if (hits.length) respBad.push(`${hits.join(', ')}\n${describeResp(r)}`);
    }
    expect(respBad, 'alice content in responses to bob / unauthenticated callers').toEqual([]);

    const outBad: string[] = [];
    for (const r of E.fake.outbound) {
      const acct = outboundAccount(r);
      if (r.markerAccounts.length > 1) outBad.push(`#${r.seq} carries markers of ${r.markerAccounts.join(' + ')}`);
      if (acct === BOB) {
        const hits = leakHits(r.text, aliceContent());
        if (hits.length) outBad.push(`#${r.seq} (bob${r.main ? '' : ', background'}) carries ${hits.join(', ')}`);
      }
      if (r.ctxAccount === null) outBad.push(`#${r.seq} model call outside any account context (${r.main ? 'run' : 'background'})`);
      if (r.runAccount && r.ctxAccount !== undefined && r.ctxAccount !== r.runAccount) outBad.push(`#${r.seq} run of ${r.runAccount} called the model as ${r.ctxAccount}`);
    }
    expect(outBad).toEqual([]);

    await quiet();
    const disk = grepTree(env.root, aliceContent(), (rel) => underAccount(rel, ALICE));
    expect.soft(disk.map((d) => `${d.needle} in ${d.file}`), "alice's content outside her folder").toEqual([]);
    // the engine-level session registry holds nobody's content, only ids, accounts and timestamps
    const users = [...new Set(c.log.map((x) => x.user))].filter((u): u is string => typeof u === 'string' && /^[a-z0-9][a-z0-9_-]{0,63}$/.test(u));
    expect(ownerRegistryProblems(env.home, [...aliceContent(), ...Object.values(Bc), PW], users), 'session registry').toEqual([]);
  }, 120_000);

  it('11 · alice finishes; her view is exactly as before bob started; her requests never saw bob', async () => {
    expect(A.view.size).toBeGreaterThan(0);
    const aIds: Ids = { session: A.sMain, run: A.runMain, slug: A.agentSlug, key: A.skillKey, approval: 'probe', inquiry: 'probe', message: 'probe', other: 'probe' };
    const now = await viewOf(ALICE, aIds);
    const changed = [...A.view.keys()].filter((k) => A.view.get(k) !== now.get(k)).map((k) => `${k}\n  before: ${A.view.get(k)!.slice(0, 300)}\n  after:  ${String(now.get(k)).slice(0, 300)}`);
    expect(changed, "bob's activity changed what alice sees").toEqual([]);

    if (A.runPark && A.inquiryId) {
      const parkScript = [...E.fake.scripts.values()].find((s) => s.label === 'park')!;
      expectOk(await c.call(ALICE, 'POST', `/agent/runs/${A.runPark}/inquiries/${A.inquiryId}`, { body: { answer: 'Yes please' } }));
      const f = await c.follow(ALICE, A.runPark, { timeoutMs: 30_000 });
      expect(f.status, f.text.slice(-600)).toBe('done');
      const cont = parkScript.requests.slice(1).map((x) => x.text).join('\n');
      expect(cont.length, "alice's run continued with a model call").toBeGreaterThan(0);
      expect(cont.includes(SECRET), "alice's masking was switched off by bob").toBe(false);
    }
    const bobNeedles = Object.values(Bc);
    const seen = E.fake.outbound.filter((r) => outboundAccount(r) === ALICE).flatMap((r) => leakHits(r.text, bobNeedles).map((h) => `#${r.seq}: ${h}`));
    expect(seen, "bob's content in alice's requests").toEqual([]);

    const agents = (await c.call(ALICE, 'GET', '/agent/agents')).text;
    for (const s of [A.agentSlug, A.sacAgentSlug, ...(A.planted.has('persona2') ? [A.agent2Slug] : [])]) expect(agents, `alice agent ${s}`).toContain(s);
    const cat = await aliceSkillsView();
    for (const s of [A.skillSlug, A.sacSkillSlug, ...(A.planted.has('skill2') ? [A.skill2Slug] : [])]) expect(cat, `alice skill ${s}`).toContain(s);
    const mem = await c.call(ALICE, 'GET', '/agent/memory');
    expect(respLeaks(mem, [C.memHttp])).toEqual([C.memHttp]);
    expect(respLeaks(mem, Object.values(Bc))).toEqual([]);
    expect(readFileSync(A.aliceFile, 'utf8')).toContain(A.fileToolAbs ? C.fileTool : C.upload);
  }, 120_000);

  it('12 · no child process was started during the whole run', () => {
    const untagged = spawnLog().filter((x) => !x.tag);
    expect(untagged.map((x) => `${x.fn} ${x.command} [account=${x.account}]\n${x.stack}`)).toEqual([]);
  });
});
