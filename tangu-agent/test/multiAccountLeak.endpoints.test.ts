/**
 * Multi-account mode: the endpoints and tools opened after the first round, each checked per account.
 *
 *   - session files / uploads (/agent/workspace/*): land in <accountHome>/uploads/<sessionId>; alice's run gets her upload's
 *     path and reads it; bob with alice's session id gets exactly what an unused id gets; bob cannot upload into it
 *   - /agent/models: the same process catalogue for everyone, without direct provider base URLs
 *   - /agent/approvals/pending: per account (bob neither sees alice's waiting prompt nor sees his revision move,
 *     and bob's clean-up pass does not drop alice's entry)
 *   - search_files / glob_files / search_sessions / read_session: only this account's folder and database;
 *     no ripgrep (no child process at all)
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';

const env = await vi.hoisted(async () => {
  const fs = await import('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'tangu-ma-endp-')));
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
  return { root, home, tmp };
});

vi.mock('node:child_process', async (orig) => (await import('./helpers/multiAccountSpawnSpy.js')).wrapChildProcess(await orig()));
vi.mock('child_process', async (orig) => (await import('./helpers/multiAccountSpawnSpy.js')).wrapChildProcess(await orig()));

import { existsSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { bootMultiAccount, canary, leakHits, randomUUID, respLeaks, runToEnd, startRun, steps, type MaEngine } from './helpers/multiAccountHarness.js';
import { spawnLog } from './helpers/multiAccountSpawnSpy.js';

const accDir = (id: string) => join(env.home, 'accounts', id);
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const b64 = (s: string) => Buffer.from(s).toString('base64');

let E: MaEngine;
beforeAll(async () => { E = await bootMultiAccount(); }, 60_000);
afterAll(async () => { await E?.dispose(); rmSync(env.root, { recursive: true, force: true }); });

const A = { upload: canary('alice', 'upload'), file: canary('alice', 'searchfile'), title: canary('alice', 'title'), said: canary('alice', 'said') };
const S_A = randomUUID();
const S_A_RUN = randomUUID();
const ALL_A = () => Object.values(A);
/** Same response apart from ids that differ by design */
const shape = (r: { status: number; text: string }) => `${r.status} ${r.text}`;

describe('multi-account: session files and uploads', () => {
  it('alice uploads into her own folder and can list, read and download it', async () => {
    const c = E.client;
    const up = await c.call('alice', 'POST', '/agent/workspace/upload', { body: { sessionId: S_A, files: [{ path: 'notes/note.txt', content: b64(A.upload), encoding: 'base64' }] } });
    expect(up.status, up.text).toBe(200);
    expect(up.json).toMatchObject({ saved: 1, errors: [] });
    expect(readFileSync(join(accDir('alice'), 'uploads', S_A, 'notes', 'note.txt'), 'utf8')).toBe(A.upload);
    const list = await c.call('alice', 'GET', '/agent/workspace/list', { query: { sessionId: S_A } });
    expect(list.json?.files?.map((f: any) => f.path)).toEqual(['/notes/note.txt']);
    const read = await c.call('alice', 'GET', '/agent/workspace/read', { query: { sessionId: S_A, path: 'notes/note.txt' } });
    expect(Buffer.from(read.json?.content ?? '', 'base64').toString('utf8')).toBe(A.upload);
    const dl = await c.call('alice', 'GET', '/agent/workspace/download', { query: { sessionId: S_A, path: 'notes/note.txt' } });
    expect(dl.text).toBe(A.upload);
  });

  it('alice\'s next run is told where the upload is and reads it with read_file', async () => {
    const c = E.client;
    const up = await c.call('alice', 'POST', '/agent/workspace/upload', { body: { sessionId: S_A_RUN, files: [{ path: 'brief.txt', content: A.upload }] } });
    expect(up.status).toBe(200);
    let seenPath = '';
    const s = E.fake.script('alice', 'reads-upload', steps([
      (ctx) => {
        const m = ctx.record.text.match(/\/[^\s"'\\]*uploads\/[0-9a-f-]{36}\/brief\.txt/);
        seenPath = m?.[0] ?? '';
        return { calls: [{ name: 'read_file', args: { path: seenPath } }] };
      },
    ], 'read it'));
    const r = await runToEnd(c, 'alice', s, { sessionId: S_A_RUN });
    expect(r.follow?.status).toBe('done');
    expect(seenPath).toContain(join('accounts', 'alice', 'uploads', S_A_RUN));
    expect(s.results.find((x) => x.name === 'read_file')?.output).toContain(A.upload);
  });

  it('bob with alice\'s session id gets exactly what an unused session id gets, and cannot upload into it', async () => {
    const c = E.client;
    const unused = randomUUID();
    for (const [method, path, q] of [
      ['GET', '/agent/workspace/list', (sid: string) => ({ query: { sessionId: sid } })],
      ['GET', '/agent/workspace/read', (sid: string) => ({ query: { sessionId: sid, path: 'notes/note.txt' } })],
      ['GET', '/agent/workspace/download', (sid: string) => ({ query: { sessionId: sid, path: 'notes/note.txt' } })],
      ['POST', '/agent/workspace/delete', (sid: string) => ({ body: { sessionId: sid, path: 'notes/note.txt' } })],
    ] as const) {
      const theirs = await c.call('bob', method, path, q(S_A) as any);
      const none = await c.call('bob', method, path, q(unused) as any);
      expect(shape(theirs), path).toBe(shape(none));
      expect(respLeaks(theirs, ALL_A())).toEqual([]);
    }
    const up = await c.call('bob', 'POST', '/agent/workspace/upload', { body: { sessionId: S_A, files: [{ path: 'notes/note.txt', content: 'bob was here' }] } });
    expect(up.status).toBe(404);
    expect(readFileSync(join(accDir('alice'), 'uploads', S_A, 'notes', 'note.txt'), 'utf8')).toBe(A.upload);
    // alice's file survived bob's delete attempt
    expect((await c.call('alice', 'GET', '/agent/workspace/list', { query: { sessionId: S_A } })).json?.files).toHaveLength(1);
  });

  it('paths cannot leave the session folder; non-UUID session ids and client project / app ids change nothing', async () => {
    const c = E.client;
    const mine = randomUUID();
    const tricks = ['../../bob/evil.txt', '../../../../escape.txt', '/etc/evil.txt', 'a/../../evil.txt', '..\\evil.txt'];
    const up = await c.call('bob', 'POST', '/agent/workspace/upload', { body: { sessionId: mine, project: 'Tangu', appId: 'ai-studio', files: tricks.map((p) => ({ path: p, content: 'x' })) } });
    expect(up.status).toBe(200);
    const landed = (dir: string): string[] => { try { return readdirSync(dir, { recursive: true }) as string[]; } catch { return []; } };
    // whatever was saved stays inside bob's folder for that session (an absolute path is taken as relative to it)
    const inside = join('accounts', 'bob', 'uploads', mine);
    for (const f of landed(env.root)) if (/evil|escape/.test(String(f))) expect(String(f)).toContain(inside);
    expect(existsSync('/etc/evil.txt')).toBe(false);
    expect((await c.call('bob', 'GET', '/agent/workspace/list', { query: { sessionId: '__project__', project: 'Tangu' } })).status).toBe(400);
    expect((await c.call('bob', 'GET', '/agent/workspace/list', { query: { sessionId: '../alice' } })).status).toBe(400);
  });
});

describe('multi-account: uploads folder that is a link', () => {
  it('a link in place of the uploads folder is refused and nothing lands where it points', async () => {
    const c = E.client;
    expect((await c.call('frank', 'GET', '/agent/sessions')).status).toBe(200);
    expect((await c.call('grace', 'GET', '/agent/sessions')).status).toBe(200);
    const target = join(accDir('grace'), 'workspace');
    mkdirSync(target, { recursive: true });
    rmSync(join(accDir('frank'), 'uploads'), { recursive: true, force: true });
    symlinkSync(target, join(accDir('frank'), 'uploads'));
    try {
      const sid = randomUUID();
      const up = await c.call('frank', 'POST', '/agent/workspace/upload', { body: { sessionId: sid, files: [{ path: 'x.txt', content: 'frank' }] } });
      expect(up.status).toBe(409);
      expect(readdirSync(target)).not.toContain(sid);
      expect((await c.call('frank', 'GET', `/agent/workspace/list?sessionId=${sid}`)).status).toBe(409);
    } finally { rmSync(join(accDir('frank'), 'uploads'), { force: true }); }
  }, 30_000);
});

describe('multi-account: model catalogue', () => {
  it('is the same for every account and carries no direct provider base URL', async () => {
    const a = await E.client.call('alice', 'GET', '/agent/models');
    const b = await E.client.call('bob', 'GET', '/agent/models');
    expect(a.status).toBe(200);
    expect(a.text).toBe(b.text);
    expect(a.json?.directProviders?.length).toBeGreaterThan(0);
    for (const p of a.json?.directProviders ?? []) expect(p).not.toHaveProperty('baseUrl');
    expect(a.text).not.toContain('RELAY-SECRET-IN-URL');
    expect(a.json?.modelOverridesWritable).toBe(false);
    expect((await E.client.call('alice', 'PUT', '/agent/models/overrides', { body: { modelId: 'x', contextWindow: 100000 } })).status).toBe(403);
  });
});

describe('multi-account: pending prompts are per account', () => {
  it('bob sees neither alice\'s waiting question nor his revision move, and his clean-up pass leaves her entry alone', async () => {
    const c = E.client;
    const revBob0 = (await c.call('bob', 'GET', '/agent/approvals/pending')).json?.rev;
    const s = E.fake.script('alice', 'asks', steps([{ calls: [{ name: 'ask_user', args: { question: `${A.said} which one?` } }] }], 'thanks'));
    const started = await startRun(c, 'alice', s);
    const f = await c.follow('alice', started.runId!, { timeoutMs: 10_000, autoAnswer: false, until: (ev) => ev.type === 'inquiry_request' });
    expect(f.status).toBe('until');
    let mine: any;
    for (let i = 0; i < 50 && !mine?.sessions?.length; i++) { mine = (await c.call('alice', 'GET', '/agent/approvals/pending')).json; await sleep(100); }
    expect(mine.sessions).toEqual([expect.objectContaining({ sessionId: started.sessionId, inquiries: 1 })]);
    const bob1 = await c.call('bob', 'GET', '/agent/approvals/pending');
    expect(bob1.json?.sessions).toEqual([]);
    expect(bob1.json?.rev).toBe(revBob0);
    expect(respLeaks(bob1, [...ALL_A(), started.sessionId, started.runId!])).toEqual([]);
    // the clean-up pass only considers entries older than 30 s: let alice's age, then let bob trigger one
    await sleep(31_000);
    expect((await c.call('bob', 'GET', '/agent/approvals/pending')).json?.sessions).toEqual([]);
    await sleep(200);
    const still = (await c.call('alice', 'GET', '/agent/approvals/pending')).json;
    expect(still.sessions).toEqual([expect.objectContaining({ sessionId: started.sessionId, inquiries: 1 })]);
    const inq = f.events.find((e) => e.type === 'inquiry_request')?.payload?.inquiryId;
    expect((await c.call('alice', 'POST', `/agent/runs/${started.runId}/inquiries/${inq}`, { body: { answer: 'the first' } })).status).toBe(200);
    expect((await c.follow('alice', started.runId!, { timeoutMs: 15_000 })).status).toBe('done');
  }, 60_000);
});

describe('multi-account: search tools', () => {
  it('file and session search see only the account\'s own folder and conversations, without any child process', async () => {
    const c = E.client;
    // alice: a file with a canary in her workspace and a titled conversation mentioning another canary
    mkdirSync(join(accDir('alice'), 'workspace', 'docs'), { recursive: true });
    writeFileSync(join(accDir('alice'), 'workspace', 'docs', 'plan.md'), `# plan\n${A.file}\n`);
    const sa = E.fake.script('alice', 'talks', steps([], `noted ${A.said}`));
    const ra = await runToEnd(c, 'alice', sa, { text: A.said });
    expect(ra.follow?.status).toBe('done');
    const aliceWs = join(accDir('alice'), 'workspace');

    // bob searches for alice's things every way the tools allow
    const sb = E.fake.script('bob', 'searches', steps([
      { calls: [
        { name: 'search_files', args: { pattern: A.file } },
        { name: 'search_files', args: { pattern: 'CANARY' } },
        { name: 'glob_files', args: { pattern: '**/*' } },
        { name: 'search_sessions', args: { query: A.said } },
        { name: 'search_sessions', args: {} },
        { name: 'read_session', args: { session_id: ra.sessionId } },
      ] },
    ], 'nothing'));
    const rb = await runToEnd(c, 'bob', sb, { agentConfig: { cwd: aliceWs } });
    // a cwd in alice's folder is refused before anything runs
    expect(rb.resp.status === 400 || rb.follow?.status === 'error').toBe(true);
    const rb2 = await runToEnd(c, 'bob', sb);
    expect(rb2.follow?.status).toBe('done');
    const outs = sb.results.map((r) => r.output).join('\n');
    expect(sb.results.length).toBe(6);
    // a call may echo what it was given (a query, an id it could not find); anything else of alice's is a leak
    for (const r of sb.results) {
      const sent = JSON.stringify(r.args);
      expect(leakHits(r.output, [...ALL_A(), ra.sessionId, A.title].filter((n) => !sent.includes(n))), `${r.name} ${sent}`).toEqual([]);
    }
    expect(outs).not.toContain('plan.md');

    // alice finds her own
    const sa2 = E.fake.script('alice', 'finds', steps([
      { calls: [{ name: 'search_files', args: { pattern: A.file } }, { name: 'glob_files', args: { pattern: '**/*.md' } }, { name: 'search_sessions', args: { query: A.said } }] },
    ], 'found'));
    const ra2 = await runToEnd(c, 'alice', sa2);
    expect(ra2.follow?.status).toBe('done');
    const [grep, glob, sess] = sa2.results.map((r) => r.output);
    expect(grep).toContain(A.file);
    expect(glob).toContain('plan.md');
    expect(sess).toContain(ra.sessionId);
    expect(spawnLog().map((x: any) => JSON.stringify(x).slice(0, 300))).toEqual([]);
  }, 60_000);
});
