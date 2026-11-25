/**
 * Multi-account mode: the plugin script entry (run_plugin_script) — the only way the engine starts a process for an account.
 *
 *   - only scripts inside a plugin package run: not files the account wrote, not links out of the package, not the account's
 *     own (writable) copy of a seeded skill — an absolute path to that copy runs the package original instead
 *   - no shell, an empty environment apart from PATH / locale (no host token, no engine home), HOME / TMPDIR in the turn's
 *     scratch folder inside the account, cwd in the account; path-like arguments must stay in the account folder
 *   - one script at a time across all accounts (two accounts' scripts never overlap)
 *   - a script past `scriptMinutes`, or over `scriptScratchMB` of temporary data, is ended with its whole process group
 *   - links a script leaves in the account folder are removed (two names inside the account are kept; an existing file given a
 *     name outside keeps its name and content but no longer shares it); the scratch folder is gone when the turn ends and the
 *     account's own tools cannot write into it
 *   - package code outside skill folders (engine plugins) never runs; an agent's seeded copy maps to that agent's original
 *   - a detached grandchild holding the output pipe does not hold the engine-wide queue
 *   - every process started is a package script (spawn spy)
 *   - run as a separate user (TANGU_SCRIPT_ISOLATION=required): the process carries the script uid / gid; an engine that cannot
 *     switch users refuses and never runs the script as itself; the account folder is opened to the script group only while the
 *     script runs (not state.db*, not .scratch, not through links, not hard-linked files, setuid bits dropped) and is back to 0700
 *     afterwards and whenever the account is opened; on a real root Linux engine (container) the script user cannot read a 0600
 *     root file, another account's folder or the account database
 */
import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';

const env = await vi.hoisted(async () => {
  const fs = await import('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'tangu-ma-script-')));
  const home = path.join(root, 'home');
  const userHome = path.join(root, 'user-home');
  const tmp = path.join(root, 'tmp');
  const bundle = path.join(root, 'bundles', 'probe-plugin');
  for (const d of [home, userHome, tmp, bundle]) fs.mkdirSync(d, { recursive: true });
  for (const k of ['TANGU_DATABASE_URL', 'DATABASE_URL', 'TANGU_EMBED', 'TANGU_DATA_DIR', 'TANGU_BUNDLE_DIRS']) delete process.env[k];
  process.env.TANGU_MULTI_ACCOUNT = '1';
  process.env.TANGU_HOME = home;
  process.env.TANGU_LOCAL_TOKEN = 'multi-account-local-host-token-qwertyuiop';
  process.env.HOME = userHome;
  process.env.TMPDIR = tmp;
  process.env.SCRIPT_TEST_ENGINE_SECRET = 'engine-env-secret-should-not-reach-scripts';
  return { root, home, bundle };
});

vi.mock('node:child_process', async (orig) => (await import('./helpers/multiAccountSpawnSpy.js')).wrapChildProcess(await orig()));
vi.mock('child_process', async (orig) => (await import('./helpers/multiAccountSpawnSpy.js')).wrapChildProcess(await orig()));

import { chmodSync, existsSync, linkSync, lstatSync, mkdirSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { bootMultiAccount, runToEnd, startRun, steps, type MaEngine } from './helpers/multiAccountHarness.js';
import { spawnLog } from './helpers/multiAccountSpawnSpy.js';
import { LIMITS_FILE_NAME, reloadMultiAccountLimits } from '../src/core/multiAccountLimits.js';
import { pluginScriptQueue, snapshotAccountFiles, sweepAccountLinks } from '../src/services/pluginScripts.js';
import { closeAccountToScripts, lockAllAccountHomes, openAccountToScripts, parseProcStatus, setScriptIsolationHostForTest } from '../src/core/scriptIsolation.js';

const accDir = (id: string) => join(env.home, 'accounts', id);
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const SKILL = 'probe-skill';
const AGENT_SKILL = 'agent-skill';
const OUTSIDE = join(env.root, 'outside.txt');
const sdir = join(env.bundle, 'skills', SKILL, 'scripts');

function writeBundle(): void {
  writeFileSync(join(env.bundle, 'manifest.json'), JSON.stringify({ id: 'probe-plugin', name: 'Probe plugin', version: '1.0.0' }));
  mkdirSync(sdir, { recursive: true });
  writeFileSync(join(env.bundle, 'skills', SKILL, 'SKILL.md'), '---\nname: probe-skill\ndescription: test skill with scripts\n---\nRun scripts/env.mjs.\n');
  writeFileSync(join(sdir, 'target.txt'), OUTSIDE);
  // prints what the script can see
  writeFileSync(join(sdir, 'env.mjs'), `
    import fs from 'node:fs';
    const out = { env: process.env, cwd: process.cwd(), argv: process.argv.slice(2) };
    const o = process.argv.find((a) => a.startsWith('--out='));
    if (o) fs.writeFileSync(o.slice(6), 'written by script');
    console.log(JSON.stringify(out));
  `);
  // records when it ran (to prove scripts never overlap)
  writeFileSync(join(sdir, 'slow.mjs'), `
    const t0 = Date.now();
    await new Promise((r) => setTimeout(r, Number(process.argv[2] || 800)));
    console.log(JSON.stringify({ t0, t1: Date.now(), who: process.argv[3] }));
  `);
  // starts a grandchild, records both pids, then never ends
  writeFileSync(join(sdir, 'forever.mjs'), `
    import { spawn } from 'node:child_process';
    import fs from 'node:fs';
    const kid = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
    fs.writeFileSync('pids.json', JSON.stringify([process.pid, kid.pid]));
    console.log('started');
    setInterval(() => {}, 1000);
  `);
  // fills its temporary folder
  writeFileSync(join(sdir, 'bigtmp.mjs'), `
    import fs from 'node:fs';
    import path from 'node:path';
    for (let i = 0; i < 40; i++) { fs.writeFileSync(path.join(process.env.TMPDIR, 'chunk' + i), Buffer.alloc(256 * 1024)); await new Promise((r) => setTimeout(r, 100)); }
    console.log('wrote it all');
  `);
  // leaves links in the account folder pointing out of it
  writeFileSync(join(sdir, 'links.mjs'), `
    import fs from 'node:fs';
    const target = fs.readFileSync(new URL('./target.txt', import.meta.url), 'utf8');
    fs.symlinkSync(target, 'soft-link-out');
    fs.linkSync(target, 'hard-link-out');
    console.log('linked');
  `);
  // two names for one file, both inside the account (write-then-rename style): left alone
  writeFileSync(join(sdir, 'pair.mjs'), `
    import fs from 'node:fs';
    fs.writeFileSync('pair-a.txt', 'pair content');
    fs.linkSync('pair-a.txt', 'pair-b.txt');
    console.log('paired');
  `);
  // gives an existing account file a second name outside the account
  writeFileSync(join(sdir, 'linkback.mjs'), `
    import fs from 'node:fs';
    import path from 'node:path';
    const target = fs.readFileSync(new URL('./target.txt', import.meta.url), 'utf8');
    fs.linkSync(process.argv[2], path.join(path.dirname(target), 'linked-from-account.csv'));
    console.log('linked back');
  `);
  // exits while a detached grandchild keeps its output pipe open
  writeFileSync(join(sdir, 'escape.mjs'), `
    import { spawn } from 'node:child_process';
    import fs from 'node:fs';
    const kid = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30000)'], { detached: true, stdio: ['ignore', 'inherit', 'inherit'] });
    fs.writeFileSync('escaped.json', JSON.stringify([kid.pid]));
    kid.unref();
    console.log('bye');
    process.exit(0);
  `);
  // engine-plugin code in the package (not loaded in this mode) and a skill link pointing at it
  mkdirSync(join(env.bundle, 'tangu-plugins', 'probe'), { recursive: true });
  writeFileSync(join(env.bundle, 'tangu-plugins', 'probe', 'index.mjs'), 'console.log("ENGINE PLUGIN RAN")');
  symlinkSync(join(env.bundle, 'tangu-plugins', 'probe', 'index.mjs'), join(sdir, 'plug.mjs'));
  writeFileSync(join(sdir, 'notes.txt'), 'not a script');
  // reports which user it runs as and what the account folder looks like while it runs
  writeFileSync(join(sdir, 'whoami.mjs'), `
    import fs from 'node:fs';
    import path from 'node:path';
    const home = path.dirname(path.dirname(process.env.FORSION_SCRIPT_SCRATCH));
    const st = (p) => { try { const s = fs.lstatSync(p); return { mode: s.mode & 0o7777, uid: s.uid, gid: s.gid }; } catch (e) { return { err: e.code }; } };
    console.log(JSON.stringify({ uid: process.getuid(), gid: process.getgid(), top: st(home), db: st(path.join(home, 'state.db')),
      scratchParent: st(path.join(home, '.scratch')), scratch: st(process.env.FORSION_SCRIPT_SCRATCH), home: st(process.env.HOME), tmp: st(process.env.TMPDIR) }));
  `);
  // leaves a marker file in its working directory (to prove it never ran)
  writeFileSync(join(sdir, 'marker.mjs'), `
    import fs from 'node:fs';
    fs.writeFileSync('marker-' + process.argv[2] + '.txt', 'ran');
    console.log('MARKER RAN');
  `);
  // what the script user can reach (root-only test): another account, the account database, a 0600 root file
  writeFileSync(join(sdir, 'isolate.mjs'), `
    import fs from 'node:fs';
    import path from 'node:path';
    import { spawn } from 'node:child_process';
    const home = path.dirname(path.dirname(process.env.FORSION_SCRIPT_SCRATCH));
    const t = (f) => { try { const v = f(); return { ok: true, v }; } catch (e) { return { ok: false, code: e.code }; } };
    const kid = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { detached: true, stdio: 'ignore' });
    kid.unref();
    const walExists = fs.existsSync(path.join(home, 'state.db-wal'));
    const ro = process.argv[2] === 'read-only'; // the negative control runs as root: no moving / deleting there
    const skip = { ok: false, code: 'SKIPPED' };
    console.log(JSON.stringify({
      uid: process.getuid(), gid: process.getgid(), groups: process.getgroups(),
      capEff: /CapEff:\\s*(\\w+)/.exec(fs.readFileSync('/proc/self/status', 'utf8'))?.[1],
      cred: t(() => fs.readFileSync(${JSON.stringify(join(env.root, 'cloud', 'device.json'))}, 'utf8')),
      bobFile: t(() => fs.readFileSync(${JSON.stringify(join(env.home, 'accounts', 'bob', 'workspace', 'bob-secret.txt'))}, 'utf8')),
      bobDir: t(() => fs.readdirSync(${JSON.stringify(join(env.home, 'accounts', 'bob'))})),
      db: t(() => fs.readFileSync(path.join(home, 'state.db')).length),
      dbRename: ro ? skip : t(() => fs.renameSync(path.join(home, 'state.db'), path.join(home, 'moved.db'))),
      walUnlink: ro ? skip : walExists ? t(() => fs.unlinkSync(path.join(home, 'state.db-wal'))) : { ok: false, code: 'NO_WAL' },
      scratchRename: ro ? skip : t(() => fs.renameSync(path.join(home, '.scratch'), path.join(home, '.scratch-moved'))),
      input: t(() => fs.readFileSync('input-0600.txt', 'utf8')),
      write: t(() => { fs.mkdirSync('made-by-script', { recursive: true }); fs.writeFileSync('made-by-script/out.txt', 'from the script'); return 'ok'; }),
      homeWrite: t(() => { fs.writeFileSync(path.join(process.env.HOME, 'h.txt'), 'h'); return 'ok'; }),
      plantJournal: ro ? skip : t(() => { fs.writeFileSync(path.join(home, 'state.db-journal'), 'planted'); return 'ok'; }),
      kid: kid.pid,
    }));
  `);
  // a link inside the package pointing out of it
  writeFileSync(join(env.root, 'outside-script.mjs'), 'console.log("OUTSIDE SCRIPT RAN")');
  symlinkSync(join(env.root, 'outside-script.mjs'), join(sdir, 'outlink.mjs'));
  // an agent shipped by the package, with its own skill and script (seeded into each account)
  const ag = join(env.bundle, 'agents', 'probe-agent');
  mkdirSync(join(ag, 'skills', AGENT_SKILL, 'scripts'), { recursive: true });
  writeFileSync(join(ag, 'config.toml'), 'name = "Probe agent"\ndescription = "test"\n');
  writeFileSync(join(ag, 'SOUL.md'), 'You are a probe.');
  writeFileSync(join(ag, 'skills', AGENT_SKILL, 'SKILL.md'), '---\nname: agent-skill\ndescription: agent skill\n---\nRun scripts/hello.mjs.\n');
  writeFileSync(join(ag, 'skills', AGENT_SKILL, 'scripts', 'hello.mjs'), 'console.log("ORIGINAL HELLO")');
  // a second agent whose skill has the same name and script path
  const ag2 = join(env.bundle, 'agents', 'probe-agent-2');
  mkdirSync(join(ag2, 'skills', AGENT_SKILL, 'scripts'), { recursive: true });
  writeFileSync(join(ag2, 'config.toml'), 'name = "Probe agent two"\ndescription = "test"\n');
  writeFileSync(join(ag2, 'SOUL.md'), 'You are another probe.');
  writeFileSync(join(ag2, 'skills', AGENT_SKILL, 'SKILL.md'), '---\nname: agent-skill\ndescription: agent skill\n---\nRun scripts/hello.mjs.\n');
  writeFileSync(join(ag2, 'skills', AGENT_SKILL, 'scripts', 'hello.mjs'), 'console.log("SECOND HELLO")');
}

let E: MaEngine;
const REAL_ROOT = process.getuid?.() === 0;
beforeAll(async () => {
  // as root (the Linux container run) the script user must be able to reach the package and the engine folder: mkdtemp made it 0700
  if (REAL_ROOT) chmodSync(env.root, 0o755);
  writeFileSync(OUTSIDE, 'outside content');
  writeBundle();
  E = await bootMultiAccount({ bundleDirs: [env.bundle] });
}, 60_000);
afterAll(async () => { await E?.dispose(); rmSync(env.root, { recursive: true, force: true }); });
afterEach(() => { rmSync(join(env.home, LIMITS_FILE_NAME), { force: true }); reloadMultiAccountLimits(); });

/** one run that makes the given run_plugin_script calls (one per step) and returns their outputs */
async function scriptRun(account: string, calls: Array<Record<string, unknown>>, o: { parallel?: boolean } = {}) {
  const s = E.fake.script(account, `script-${Math.random().toString(36).slice(2, 7)}`, steps(
    o.parallel ? [{ calls: calls.map((args) => ({ name: 'run_plugin_script', args })) }] : calls.map((args) => ({ calls: [{ name: 'run_plugin_script', args }] })),
    'done'));
  const r = await runToEnd(E.client, account, s, { timeoutMs: 60_000 });
  expect(r.follow?.status, JSON.stringify(r.follow?.events.filter((e) => e.type === 'error'))).toBe('done');
  return { outputs: s.results.filter((x) => x.name === 'run_plugin_script').map((x) => x.output), runId: r.runId!, sessionId: r.sessionId };
}
const stdoutOf = (out: string) => out.split('--- stdout ---\n')[1]?.split('\n--- stderr ---')[0] ?? '';

describe('multi-account: plugin scripts — what may run', () => {
  it('a package script runs with an empty environment, its HOME / TMPDIR in the turn scratch inside the account, cwd in the account', async () => {
    const { outputs, runId } = await scriptRun('alice', [{ skill: SKILL, script: 'scripts/env.mjs', args: ['hello world', '--out=made-by-script.txt'] }]);
    const out = outputs[0];
    expect(out).toMatch(/exit code: 0/);
    const seen = JSON.parse(stdoutOf(out));
    expect(seen.argv).toEqual(['hello world', '--out=made-by-script.txt']);
    expect(seen.cwd.startsWith(accDir('alice'))).toBe(true);
    expect(seen.env.HOME.startsWith(join(accDir('alice'), '.scratch'))).toBe(true);
    expect(seen.env.TMPDIR.startsWith(join(accDir('alice'), '.scratch'))).toBe(true);
    for (const k of Object.keys(seen.env)) expect(k, 'engine environment reached the script').not.toMatch(/^TANGU_|SCRIPT_TEST_ENGINE_SECRET|_KEY$|TOKEN/);
    expect(JSON.stringify(seen.env)).not.toContain('engine-env-secret');
    expect(JSON.stringify(seen.env)).not.toContain('multi-account-local-host-token');
    expect(readFileSync(join(accDir('alice'), 'workspace', 'made-by-script.txt'), 'utf8')).toBe('written by script');
    // the scratch folder is gone once the turn is over
    await sleep(200);
    expect(readdirSync(join(accDir('alice'), '.scratch')).filter((n) => n.includes(runId))).toEqual([]);
  }, 60_000);

  it('files the account wrote, paths out of the skill folder and links out of the package never run', async () => {
    mkdirSync(join(accDir('alice'), 'workspace'), { recursive: true });
    writeFileSync(join(accDir('alice'), 'workspace', 'mine.mjs'), 'console.log("ACCOUNT SCRIPT RAN")');
    const { outputs } = await scriptRun('alice', [
      { script: join(accDir('alice'), 'workspace', 'mine.mjs') },
      { skill: SKILL, script: '../../../../home/accounts/alice/workspace/mine.mjs' },
      { skill: SKILL, script: 'scripts/outlink.mjs' },
      { skill: SKILL, script: join(env.root, 'outside-script.mjs') },
      { skill: SKILL, script: 'scripts/notes.txt' },
      { skill: SKILL, script: 'scripts/nope.mjs' },
      { skill: '../probe-skill', script: 'scripts/env.mjs' },
    ]);
    expect(outputs).toHaveLength(7);
    for (const o of outputs) {
      expect(o).toMatch(/^Error:/);
      expect(o).not.toMatch(/ACCOUNT SCRIPT RAN|OUTSIDE SCRIPT RAN/);
    }
  }, 60_000);

  it('a skill id with its source prefix works; a wrong script name lists only the skill\'s own runnable scripts', async () => {
    const { outputs } = await scriptRun('alice', [
      { skill: `local:${SKILL}`, script: 'scripts/env.mjs' },
      { skill: SKILL, script: 'scripts/word_stats.py' },
    ]);
    expect(outputs[0]).toMatch(/exit code: 0/);
    expect(outputs[1]).toMatch(/^Error: The skill "probe-skill" has no script "scripts\/word_stats\.py"\. Its scripts: /);
    const listed = outputs[1].split('Its scripts: ')[1].split(', ');
    expect(listed).toContain('scripts/env.mjs');
    expect(listed, 'a link out of the package is not offered').not.toContain('scripts/outlink.mjs');
    expect(listed, 'non-script files are not offered').not.toContain('scripts/notes.txt');
  }, 60_000);

  it("the account's own copy of a seeded skill never runs: its path runs the package original", async () => {
    const copy = join(accDir('alice'), 'agents', 'probe-agent', 'skills', AGENT_SKILL, 'scripts', 'hello.mjs');
    expect(existsSync(copy), 'the package agent was seeded into the account').toBe(true);
    writeFileSync(copy, 'console.log("EDITED COPY RAN")');
    const { outputs } = await scriptRun('alice', [{ script: copy }, { skill: AGENT_SKILL, script: 'scripts/hello.mjs' }]);
    for (const o of outputs) {
      expect(o).toContain('ORIGINAL HELLO');
      expect(o).not.toContain('EDITED COPY RAN');
    }
  }, 60_000);

  it('package code outside skill folders never runs, by absolute path or through a link in a skill', async () => {
    const { outputs } = await scriptRun('alice', [
      { script: join(env.bundle, 'tangu-plugins', 'probe', 'index.mjs') },
      { skill: SKILL, script: 'scripts/plug.mjs' },
      { script: join(sdir, 'plug.mjs') },
    ]);
    for (const o of outputs) {
      expect(o).toMatch(/^Error:/);
      expect(o).not.toContain('ENGINE PLUGIN RAN');
    }
  }, 60_000);

  it("an agent's seeded copy runs that same agent's original, not another agent's script of the same name", async () => {
    const copy2 = join(accDir('alice'), 'agents', 'probe-agent-2', 'skills', AGENT_SKILL, 'scripts', 'hello.mjs');
    expect(existsSync(copy2), 'the second package agent was seeded into the account').toBe(true);
    const { outputs } = await scriptRun('alice', [{ script: copy2 }]);
    expect(outputs[0]).toContain('SECOND HELLO');
    expect(outputs[0]).not.toContain('ORIGINAL HELLO');
  }, 60_000);

  it("the scripts' temporary folder and the account database files cannot be written by the account's own tools", async () => {
    const target = join(accDir('alice'), '.scratch', 'mine.txt');
    const wal = join(accDir('alice'), 'state.db-journal');
    // the database runs in WAL mode, so there is no journal file: plant a link under that name pointing back into the account
    // (after the account's database is open, so opening it never sees the planted file)
    expect((await E.client.call('alice', 'GET', '/agent/sessions')).status).toBe(200);
    const linkTarget = join(accDir('alice'), 'notes-for-link.txt');
    writeFileSync(linkTarget, 'kept');
    rmSync(wal, { force: true });
    symlinkSync(linkTarget, wal);
    // other spellings of the same names (on a case-insensitive volume they are the same file)
    const folded = join(accDir('alice'), '\u017Ftate.DB-journal');
    const scratchFolded = join(accDir('alice'), '.SCRATCH', 'mine2.txt');
    const s = E.fake.script('alice', 'scratch-write', steps([
      { calls: [{ name: 'write_file', args: { path: target, content: 'x'.repeat(100) } }] },
      { calls: [{ name: 'write_file', args: { path: wal, content: 'x'.repeat(100) } }] },
      { calls: [{ name: 'write_file', args: { path: folded, content: 'x'.repeat(100) } }] },
      { calls: [{ name: 'write_file', args: { path: scratchFolded, content: 'x'.repeat(100) } }] },
    ], 'done'));
    const r = await runToEnd(E.client, 'alice', s, { timeoutMs: 30_000 });
    expect(r.follow?.status).toBe('done');
    const outs = s.results.filter((x) => x.name === 'write_file').map((x) => x.output);
    expect(outs[0]).toMatch(/temporary files of plugin scripts/);
    expect(outs[1]).toMatch(/account database/);
    expect(outs[2]).toMatch(/account database/);
    expect(outs[3]).toMatch(/temporary files of plugin scripts/);
    expect(readFileSync(linkTarget, 'utf8')).toBe('kept');
    rmSync(wal, { force: true });
    expect(existsSync(target)).toBe(false);
    expect(existsSync(wal)).toBe(false);
  }, 60_000);

  it('path-like arguments must stay inside the account folder', async () => {
    mkdirSync(accDir('bob'), { recursive: true });
    const { outputs } = await scriptRun('alice', [
      { skill: SKILL, script: 'scripts/env.mjs', args: [`--out=${join(accDir('bob'), 'from-alice.txt')}`] },
      { skill: SKILL, script: 'scripts/env.mjs', args: ['--out=../../bob/from-alice.txt'] },
      { skill: SKILL, script: 'scripts/env.mjs', args: [join(env.bundle, 'skills')] },
      { skill: SKILL, script: 'scripts/env.mjs', args: ['~/.ssh/id_rsa'] },
      { skill: SKILL, script: 'scripts/env.mjs', args: ['/etc/passwd'] },
      { skill: SKILL, script: 'scripts/env.mjs', args: ['https://example.com/a/../b', 'plain', `--out=${join(accDir('alice'), 'workspace', 'ok.txt')}`] },
    ]);
    for (const o of outputs.slice(0, 5)) expect(o).toMatch(/^Error: .*(outside|not allowed)/s);
    expect(outputs[5]).toMatch(/exit code: 0/);
    expect(existsSync(join(accDir('bob'), 'from-alice.txt'))).toBe(false);
    expect(existsSync(join(accDir('alice'), 'workspace', 'ok.txt'))).toBe(true);
  }, 60_000);
});

describe('multi-account: plugin scripts — one at a time, bounded', () => {
  it("two accounts' scripts never overlap", async () => {
    const [a, b] = await Promise.all([
      scriptRun('alice', [{ skill: SKILL, script: 'scripts/slow.mjs', args: ['900', 'alice'] }]),
      scriptRun('bob', [{ skill: SKILL, script: 'scripts/slow.mjs', args: ['900', 'bob'] }]),
    ]);
    const ra = JSON.parse(stdoutOf(a.outputs[0]));
    const rb = JSON.parse(stdoutOf(b.outputs[0]));
    const [first, second] = ra.t0 < rb.t0 ? [ra, rb] : [rb, ra];
    expect(second.t0).toBeGreaterThanOrEqual(first.t1);
    expect(pluginScriptQueue()).toEqual({ running: 0, waiting: 0 });
  }, 60_000);

  it('a script past its time is ended together with the processes it started', async () => {
    writeFileSync(join(env.home, LIMITS_FILE_NAME), JSON.stringify({ scriptMinutes: 0.02 }));
    reloadMultiAccountLimits();
    const { outputs } = await scriptRun('alice', [{ skill: SKILL, script: 'scripts/forever.mjs' }]);
    expect(outputs[0]).toMatch(/stopped: the script ran longer/);
    const pids = JSON.parse(readFileSync(join(accDir('alice'), 'workspace', 'pids.json'), 'utf8')) as number[];
    await sleep(500);
    for (const pid of pids) expect(() => process.kill(pid, 0), `process ${pid} still alive`).toThrow();
    expect(pluginScriptQueue()).toEqual({ running: 0, waiting: 0 });
  }, 60_000);

  it('a script writing more temporary data than allowed is ended', async () => {
    writeFileSync(join(env.home, LIMITS_FILE_NAME), JSON.stringify({ scriptScratchMB: 1 }));
    reloadMultiAccountLimits();
    const { outputs } = await scriptRun('alice', [{ skill: SKILL, script: 'scripts/bigtmp.mjs' }]);
    expect(outputs[0]).toMatch(/stopped: the script wrote more temporary data/);
    expect(outputs[0]).not.toContain('wrote it all');
  }, 60_000);

  it('links a script leaves in the account folder are removed; their target is untouched', async () => {
    const { outputs } = await scriptRun('alice', [{ skill: SKILL, script: 'scripts/links.mjs' }]);
    expect(outputs[0]).toMatch(/removed 2 link/);
    for (const n of ['soft-link-out', 'hard-link-out']) expect(() => lstatSync(join(accDir('alice'), 'workspace', n))).toThrow();
    expect(readFileSync(OUTSIDE, 'utf8')).toBe('outside content');
  }, 60_000);

  it('two names a script gives one file inside the account are kept', async () => {
    const { outputs } = await scriptRun('alice', [{ skill: SKILL, script: 'scripts/pair.mjs' }]);
    expect(outputs[0]).toMatch(/exit code: 0/);
    expect(outputs[0]).not.toMatch(/removed \d+ link/);
    for (const n of ['pair-a.txt', 'pair-b.txt']) expect(readFileSync(join(accDir('alice'), 'workspace', n), 'utf8')).toBe('pair content');
  }, 60_000);

  it('an existing account file given a name outside the account keeps its name and content, and no longer shares the outside copy', async () => {
    const keep = join(accDir('alice'), 'workspace', 'keep.csv');
    writeFileSync(keep, 'a,b\n1,2\n');
    const { outputs } = await scriptRun('alice', [{ skill: SKILL, script: 'scripts/linkback.mjs', args: ['keep.csv'] }]);
    expect(outputs[0]).toMatch(/exit code: 0/);
    expect(readFileSync(keep, 'utf8')).toBe('a,b\n1,2\n');
    expect(lstatSync(keep).nlink).toBe(1);
    const outside = join(env.root, 'linked-from-account.csv');
    expect(lstatSync(outside).ino).not.toBe(lstatSync(keep).ino);
  }, 60_000);

  it('a script that exits while a detached child holds its output does not hold the queue', async () => {
    const t0 = Date.now();
    const { outputs } = await scriptRun('alice', [{ skill: SKILL, script: 'scripts/escape.mjs' }]);
    expect(outputs[0]).toMatch(/exit code: 0/);
    expect(Date.now() - t0).toBeLessThan(15_000);
    expect(pluginScriptQueue()).toEqual({ running: 0, waiting: 0 });
    for (const pid of JSON.parse(readFileSync(join(accDir('alice'), 'workspace', 'escaped.json'), 'utf8')) as number[]) {
      try { process.kill(pid, 'SIGKILL'); } catch { /* gone */ }
    }
  }, 60_000);

  it('a stopped turn stops its waiting or running script', async () => {
    const s = E.fake.script('carol', 'stop-script', steps([{ calls: [{ name: 'run_plugin_script', args: { skill: SKILL, script: 'scripts/slow.mjs', args: ['20000', 'carol'] } }] }], 'done'));
    const st = await startRun(E.client, 'carol', s);
    await sleep(1_500);
    expect((await E.client.call('carol', 'POST', `/agent/runs/${st.runId}/abort`)).status).toBe(200);
    const f = await E.client.follow('carol', st.runId!, { timeoutMs: 15_000 });
    expect(['error', 'done']).toContain(f.status);
    const until = Date.now() + 10_000;
    while (Date.now() < until && pluginScriptQueue().running) await sleep(100);
    expect(pluginScriptQueue()).toEqual({ running: 0, waiting: 0 });
  }, 60_000);

  it('every process the engine started was a package script', () => {
    const log = spawnLog();
    expect(log.length).toBeGreaterThan(0);
    const pkgScript = new RegExp(`${env.bundle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/(agents/[^/ ]+/)?skills/[^/ ]+/scripts/[^/ ]+\\.(mjs|js|cjs|py|sh)(\\s|$)`);
    for (const rec of log) expect(rec.command, `${rec.fn} ${rec.command}\n${rec.stack}`).toMatch(pkgScript);
  });
});

// ── run as a separate user ───────────────────────────────────────────────────────────────────────
const ISO_ENV = ['TANGU_SCRIPT_ISOLATION', 'TANGU_SCRIPT_UID', 'TANGU_SCRIPT_GID'];
const ENGINE = { uid: process.getuid?.() ?? -1, gid: process.getgid?.() ?? -1 }; // -1 on Windows (these tests do not run there)
/** the user scripts switch to in the tests that fake a root engine: ourselves (a real switch needs root), 65534 when really root */
const TEST_USER = REAL_ROOT ? { uid: 65534, gid: 65534 } : ENGINE;
const modeOf = (p: string) => lstatSync(p).mode & 0o7777;
const reaped: number[] = [];
function fakeRootEngine(o: { cannot?: string } = {}): void {
  setScriptIsolationHostForTest({ root: () => true, cannotSwitch: () => o.cannot ?? null, reap: (uid) => { reaped.push(uid); } });
}
function requireScriptUser(user = TEST_USER): void {
  process.env.TANGU_SCRIPT_ISOLATION = 'required';
  process.env.TANGU_SCRIPT_UID = String(user.uid);
  process.env.TANGU_SCRIPT_GID = String(user.gid);
}
const scriptSpawns = (name: string) => spawnLog().filter((r) => r.command.includes(`/scripts/${name}`));
/** a group we may hand files to that differs from the group new files get here (null = none on this machine) */
function otherGroup(fileGid: number): number | null {
  if (REAL_ROOT) return 65534;
  return process.getgroups?.().find((g) => g !== fileGid) ?? null;
}

describe('multi-account: plugin scripts — run as a separate user', () => {
  afterEach(() => {
    for (const k of ISO_ENV) delete process.env[k];
    setScriptIsolationHostForTest(null);
    reaped.length = 0;
  });

  it('without the switch nothing changes: no uid / gid on the process, the account folder is not opened to a group', async () => {
    const n = scriptSpawns('whoami.mjs').length;
    const { outputs } = await scriptRun('alice', [{ skill: SKILL, script: 'scripts/whoami.mjs' }]);
    expect(outputs[0]).toMatch(/exit code: 0/);
    const rec = scriptSpawns('whoami.mjs').slice(n);
    expect(rec).toHaveLength(1);
    expect(rec[0].uid).toBeUndefined();
    expect(rec[0].gid).toBeUndefined();
    const seen = JSON.parse(stdoutOf(outputs[0]));
    expect(seen.top.mode & 0o1000, 'no sticky / group opening without the switch').toBe(0);
  }, 60_000);

  it('required, but the engine cannot switch users (or the setting is wrong): refused, the script never starts', async () => {
    fakeRootEngine({ cannot: 'the engine is not running as root' });
    requireScriptUser();
    const n = scriptSpawns('marker.mjs').length;
    const r1 = await scriptRun('alice', [{ skill: SKILL, script: 'scripts/marker.mjs', args: ['cannot'] }]);
    expect(r1.outputs[0]).toMatch(/^Error: Plugin scripts are disabled on this engine: they must run as a separate system user, but the engine is not running as root\./);
    // a wrong switch value or a root / non-numeric id is refused too (never read as "off")
    setScriptIsolationHostForTest(null);
    fakeRootEngine();
    const bad: Array<[string, string, RegExp]> = [
      ['TANGU_SCRIPT_ISOLATION', 'yes', /TANGU_SCRIPT_ISOLATION must be "required" or unset/],
      ['TANGU_SCRIPT_UID', '0', /TANGU_SCRIPT_UID must be a whole number from 1/],
      ['TANGU_SCRIPT_GID', 'nobody', /TANGU_SCRIPT_GID must be a whole number from 1/],
    ];
    for (const [k, v, re] of bad) {
      requireScriptUser();
      process.env[k] = v;
      const r = await scriptRun('alice', [{ skill: SKILL, script: 'scripts/marker.mjs', args: ['bad'] }]);
      expect(r.outputs[0]).toMatch(re);
    }
    expect(scriptSpawns('marker.mjs').length, 'no script process was started').toBe(n);
    for (const m of ['cannot', 'bad']) expect(existsSync(join(accDir('alice'), 'workspace', `marker-${m}.txt`))).toBe(false);
    expect(pluginScriptQueue()).toEqual({ running: 0, waiting: 0 });
  }, 60_000);

  it.skipIf(REAL_ROOT)('required on a root engine: the process carries the script uid / gid, the scratch is the script user\'s, the folder is open to the script group only while it runs', async () => {
    fakeRootEngine();
    requireScriptUser();
    const n = scriptSpawns('whoami.mjs').length;
    const { outputs } = await scriptRun('alice', [{ skill: SKILL, script: 'scripts/whoami.mjs' }, { skill: SKILL, script: 'scripts/whoami.mjs' }]);
    for (const o of outputs) expect(o).toMatch(/exit code: 0/);
    const rec = scriptSpawns('whoami.mjs').slice(n);
    expect(rec).toHaveLength(2);
    for (const r of rec) expect([r.uid, r.gid]).toEqual([TEST_USER.uid, TEST_USER.gid]);
    for (const o of outputs) {
      const seen = JSON.parse(stdoutOf(o));
      expect(seen.top, 'account folder while the script runs').toEqual({ mode: 0o1770, uid: ENGINE.uid, gid: TEST_USER.gid });
      expect(seen.db.mode & 0o077, 'state.db is not readable by group / others').toBe(0);
      expect(seen.scratchParent.mode).toBe(0o711);
      for (const d of [seen.scratch, seen.home, seen.tmp]) expect(d).toEqual({ mode: 0o700, uid: TEST_USER.uid, gid: TEST_USER.gid });
    }
    // back to 0700, owned by the engine, once it is over
    expect(modeOf(accDir('alice'))).toBe(0o700);
    expect([lstatSync(accDir('alice')).uid, lstatSync(accDir('alice')).gid]).toEqual([ENGINE.uid, ENGINE.gid]);
    // leftover processes of the script user are ended before the folder opens and after it closes
    expect(reaped.length).toBeGreaterThanOrEqual(4);
    expect(new Set(reaped)).toEqual(new Set([TEST_USER.uid]));
  }, 60_000);

  it('opening a folder changes groups / modes of account files only: not state.db*, not .scratch, not through links, not hard-linked files; setuid bits go', (ctx) => {
    const base = join(env.root, 'grant-fixture');
    rmSync(base, { recursive: true, force: true });
    const home = join(base, 'acct');
    const outside = join(base, 'outside.txt');
    const outsideHard = join(base, 'outside-hard.txt');
    mkdirSync(join(home, 'work', 'sub'), { recursive: true });
    mkdirSync(join(home, '.scratch', 'run'), { recursive: true });
    const files: Record<string, number> = {
      'state.db': 0o644, 'state.db-wal': 0o644, '.scratch/run/x.txt': 0o644, 'work/a.txt': 0o640, 'work/sub/b.txt': 0o600, 'work/su.bin': 0o4755,
    };
    for (const [rel, mode] of Object.entries(files)) { writeFileSync(join(home, rel), rel); chmodSync(join(home, rel), mode); }
    writeFileSync(outside, 'outside'); chmodSync(outside, 0o640);
    writeFileSync(outsideHard, 'outside hard'); chmodSync(outsideHard, 0o640);
    symlinkSync(outside, join(home, 'work', 'link'));
    linkSync(outsideHard, join(home, 'work', 'hard'));
    // names next to the database a script could claim while the top folder is group-writable: removed, the database stays
    mkdirSync(join(home, 'state.db-journal'));
    symlinkSync(outside, join(home, 'state.db-x'));
    chmodSync(join(home, 'work', 'sub'), 0o750);
    chmodSync(home, 0o700);
    const fileGid = lstatSync(join(home, 'work', 'a.txt')).gid;
    const G = otherGroup(fileGid);
    if (G === null) return ctx.skip(); // no second group on this machine to hand files to
    const before = (rel: string) => ({ mode: modeOf(join(home, rel)), gid: lstatSync(join(home, rel)).gid });
    const keep = { db: before('state.db'), scratch: before('.scratch'), scratchFile: before('.scratch/run/x.txt') };
    const keepOut = { outside: { mode: modeOf(outside), gid: lstatSync(outside).gid }, hard: { mode: modeOf(outsideHard), gid: lstatSync(outsideHard).gid } };

    openAccountToScripts(home, { uid: 65534, gid: G }, '.scratch');
    const now = (p: string) => ({ mode: modeOf(p), gid: lstatSync(p).gid });
    expect(now(join(home, 'work', 'a.txt'))).toEqual({ mode: 0o660, gid: G });
    expect(now(join(home, 'work', 'sub', 'b.txt'))).toEqual({ mode: 0o660, gid: G });
    expect(now(join(home, 'work', 'sub'))).toEqual({ mode: 0o770, gid: G });
    expect(now(join(home, 'work'))).toEqual({ mode: (0o755 | 0o070), gid: G });
    expect(now(join(home, 'work', 'su.bin')), 'setuid bit dropped').toEqual({ mode: 0o775, gid: G });
    for (const db of ['state.db', 'state.db-wal']) expect(now(join(home, db))).toEqual({ mode: 0o600, gid: keep.db.gid });
    for (const planted of ['state.db-journal', 'state.db-x']) expect(existsSync(join(home, planted)) || !!lstatSync(join(home, planted), { throwIfNoEntry: false }), planted).toBe(false);
    expect(now(join(home, '.scratch'))).toEqual(keep.scratch);
    expect(now(join(home, '.scratch', 'run', 'x.txt'))).toEqual(keep.scratchFile);
    expect(now(outside), 'the target of a link is untouched').toEqual(keepOut.outside);
    expect(now(outsideHard), 'a hard-linked file is untouched').toEqual(keepOut.hard);
    expect(now(join(home, 'work', 'hard'))).toEqual(keepOut.hard);
    expect(now(home)).toEqual({ mode: 0o1770, gid: G });

    closeAccountToScripts(home);
    expect(now(home)).toEqual({ mode: 0o700, gid: ENGINE.gid });
    expect(lstatSync(home).uid).toBe(ENGINE.uid);

    // a setuid file with another hard link cannot be made safe: the folder is not opened
    const su = join(base, 'outside-su.bin');
    writeFileSync(su, 'su'); chmodSync(su, 0o4755);
    linkSync(su, join(home, 'work', 'su-hard.bin'));
    expect(() => openAccountToScripts(home, { uid: 65534, gid: G }, '.scratch')).toThrow(/setuid/);
    expect(modeOf(home), 'still closed').toBe(0o700);
    expect(modeOf(su)).toBe(0o4755);
  });

  it('opening an account closes its folder (0700): on first open and on reopen after idle eviction; not when the engine is not root', async () => {
    fakeRootEngine();
    expect((await E.client.call('erin', 'GET', '/agent/sessions')).status).toBe(200);
    expect(modeOf(accDir('erin'))).toBe(0o700);
    chmodSync(accDir('erin'), 0o755);
    expect(E.accounts.evictIdleNow(0)).toContain('erin');
    expect((await E.client.call('erin', 'GET', '/agent/sessions')).status).toBe(200);
    expect(modeOf(accDir('erin')), 'reopen after eviction').toBe(0o700);
    if (REAL_ROOT) return; // the real engine is root here: the negative control below does not apply
    setScriptIsolationHostForTest(null);
    chmodSync(accDir('erin'), 0o755);
    expect(E.accounts.evictIdleNow(0)).toContain('erin');
    expect((await E.client.call('erin', 'GET', '/agent/sessions')).status).toBe(200);
    expect(modeOf(accDir('erin')), 'not root: left alone').toBe(0o755);
  }, 60_000);

  it('folders left open by an earlier engine are closed before the first script', async () => {
    for (const id of ['frank', 'gina']) expect((await E.client.call(id, 'GET', '/agent/sessions')).status).toBe(200);
    for (const id of ['frank', 'gina']) chmodSync(accDir(id), 0o1770);
    lockAllAccountHomes();
    for (const id of ['frank', 'gina']) expect(modeOf(accDir(id))).toBe(0o700);
  }, 60_000);

  it('the copy that unshares a hard link leaving the account drops setuid / setgid bits', () => {
    const f = join(accDir('alice'), 'workspace', 'su-shared.bin');
    writeFileSync(f, 'binary'); chmodSync(f, 0o6755);
    const before = snapshotAccountFiles('alice');
    const out = join(env.root, 'su-shared-outside.bin');
    rmSync(out, { force: true });
    linkSync(f, out);
    expect(sweepAccountLinks('alice', before)).toContain(join('workspace', 'su-shared.bin'));
    expect(lstatSync(f).nlink).toBe(1);
    expect(modeOf(f)).toBe(0o755);
    expect(readFileSync(f, 'utf8')).toBe('binary');
  });

  it('a process status without an owner is "unknown", never "not the script user"', () => {
    expect(parseProcStatus('Name:\tnode\nState:\tS (sleeping)\nUid:\t65534\t65534\t65534\t65534\n')).toEqual({ state: 'S', uids: [65534, 65534, 65534] });
    expect(parseProcStatus('Name:\tnode\nState:\tZ (zombie)\nUid:\t0\t65534\t0\t0\n')).toEqual({ state: 'Z', uids: [0, 65534, 0] });
    expect(parseProcStatus('Name:\tnode\nState:\tS (sleeping)\n')).toBeNull();
    expect(parseProcStatus('')).toBeNull();
  });
});

// ── the real thing: root on Linux (run inside a container) ────────────────────────────────────────
const capEff = (): bigint => {
  try { return BigInt(`0x${/^CapEff:\s*([0-9a-f]+)/im.exec(readFileSync('/proc/self/status', 'utf8'))?.[1] ?? '0'}`); } catch { return 0n; }
};
const NEEDED_CAPS = [0, 1, 5, 6, 7]; // CHOWN, DAC_OVERRIDE, KILL, SETGID, SETUID
const LINUX_ROOT = REAL_ROOT && process.platform === 'linux';
const CAN_SWITCH = LINUX_ROOT && NEEDED_CAPS.every((b) => (capEff() & (1n << BigInt(b))) !== 0n);
const procState = (pid: number): string | undefined => {
  try { return /^State:\s*(\S)/m.exec(readFileSync(`/proc/${pid}/status`, 'utf8'))?.[1]; } catch { return undefined; }
};

describe.runIf(LINUX_ROOT)('multi-account: plugin scripts — separate user on a real root Linux engine', () => {
  const cred = join(env.root, 'cloud', 'device.json');
  beforeAll(async () => {
    mkdirSync(dirname(cred), { recursive: true });
    writeFileSync(cred, 'DEVICE-CREDENTIAL-CANARY', { mode: 0o600 });
    chmodSync(cred, 0o600);
    // another account with a file that is even world-readable: its folder is what keeps it private
    expect((await E.client.call('bob', 'GET', '/agent/sessions')).status).toBe(200);
    mkdirSync(join(accDir('bob'), 'workspace'), { recursive: true });
    writeFileSync(join(accDir('bob'), 'workspace', 'bob-secret.txt'), 'BOB-CANARY', { mode: 0o644 });
    expect((await E.client.call('alice', 'GET', '/agent/sessions')).status).toBe(200);
    mkdirSync(join(accDir('alice'), 'workspace'), { recursive: true });
  });
  afterEach(() => { for (const k of ISO_ENV) delete process.env[k]; });

  it.runIf(CAN_SWITCH)('the script user reaches its own account folder only: not a 0600 root file, not another account, not state.db', async () => {
    writeFileSync(join(accDir('alice'), 'workspace', 'input-0600.txt'), 'ALICE-INPUT', { mode: 0o600 });
    process.env.TANGU_SCRIPT_ISOLATION = 'required';
    const n = scriptSpawns('isolate.mjs').length;
    const { outputs } = await scriptRun('alice', [{ skill: SKILL, script: 'scripts/isolate.mjs' }, { skill: SKILL, script: 'scripts/whoami.mjs' }]);
    expect(outputs[0]).toMatch(/exit code: 0/);
    const seen = JSON.parse(stdoutOf(outputs[0]));
    expect(scriptSpawns('isolate.mjs').slice(n).map((r) => [r.uid, r.gid])).toEqual([[65534, 65534]]);
    expect([seen.uid, seen.gid, seen.groups]).toEqual([65534, 65534, [65534]]);
    expect(BigInt(`0x${seen.capEff}`), 'no capabilities left in the script').toBe(0n);
    expect(seen.cred).toEqual({ ok: false, code: 'EACCES' });
    expect(seen.bobFile).toEqual({ ok: false, code: 'EACCES' });
    expect(seen.bobDir).toEqual({ ok: false, code: 'EACCES' });
    expect(seen.db).toEqual({ ok: false, code: 'EACCES' });
    expect(seen.dbRename.ok, 'cannot move the account database').toBe(false);
    expect(seen.scratchRename.ok, 'cannot move the scratch folder').toBe(false);
    if (seen.walUnlink.code !== 'NO_WAL') expect(seen.walUnlink.ok, 'cannot delete the database log').toBe(false);
    expect(seen.input).toEqual({ ok: true, v: 'ALICE-INPUT' });
    expect(seen.write).toEqual({ ok: true, v: 'ok' });
    expect(seen.homeWrite).toEqual({ ok: true, v: 'ok' });
    // a second script in the same turn still works
    expect(outputs[1]).toMatch(/exit code: 0/);
    expect(JSON.parse(stdoutOf(outputs[1])).uid).toBe(65534);
    // afterwards: closed again, the database where it was, the escaped grandchild ended, the output usable by the engine
    expect(modeOf(accDir('alice'))).toBe(0o700);
    expect([lstatSync(accDir('alice')).uid, lstatSync(accDir('alice')).gid]).toEqual([0, 0]);
    expect(existsSync(join(accDir('alice'), 'state.db'))).toBe(true);
    expect(seen.plantJournal.ok, 'a new name next to the database can be created while open…').toBe(true);
    expect(existsSync(join(accDir('alice'), 'state.db-journal')), '…and is gone once the folder is closed').toBe(false);
    expect(modeOf(join(accDir('alice'), 'state.db')) & 0o077).toBe(0);
    expect(['Z', undefined]).toContain(procState(seen.kid));
    expect(readFileSync(join(accDir('alice'), 'workspace', 'made-by-script', 'out.txt'), 'utf8')).toBe('from the script');
    writeFileSync(join(accDir('alice'), 'workspace', 'made-by-script', 'engine.txt'), 'the engine can write here');
  }, 60_000);

  it.runIf(CAN_SWITCH)('limits still hold for the script user: past its time it is ended with its children, over its scratch size it is stopped, its scratch is removed', async () => {
    process.env.TANGU_SCRIPT_ISOLATION = 'required';
    writeFileSync(join(env.home, LIMITS_FILE_NAME), JSON.stringify({ scriptMinutes: 0.02 }));
    reloadMultiAccountLimits();
    const a = await scriptRun('alice', [{ skill: SKILL, script: 'scripts/forever.mjs' }]);
    expect(a.outputs[0]).toMatch(/stopped: the script ran longer/);
    const pids = JSON.parse(readFileSync(join(accDir('alice'), 'workspace', 'pids.json'), 'utf8')) as number[];
    for (const pid of pids) expect(['Z', undefined]).toContain(procState(pid));
    // the temporary folder belongs to the script user (0700): the engine still measures it
    writeFileSync(join(env.home, LIMITS_FILE_NAME), JSON.stringify({ scriptScratchMB: 1 }));
    reloadMultiAccountLimits();
    const { outputs, runId } = await scriptRun('alice', [{ skill: SKILL, script: 'scripts/bigtmp.mjs' }]);
    expect(outputs[0]).toMatch(/stopped: the script wrote more temporary data/);
    await sleep(200);
    expect(readdirSync(join(accDir('alice'), '.scratch')).filter((n) => n.includes(runId))).toEqual([]);
    expect(pluginScriptQueue()).toEqual({ running: 0, waiting: 0 });
  }, 60_000);

  it.runIf(CAN_SWITCH)('negative control: without the switch the same probe does read them (as root)', async () => {
    const { outputs } = await scriptRun('alice', [{ skill: SKILL, script: 'scripts/isolate.mjs', args: ['read-only'] }]);
    const seen = JSON.parse(stdoutOf(outputs[0]));
    expect(seen.uid).toBe(0);
    expect(seen.cred).toEqual({ ok: true, v: 'DEVICE-CREDENTIAL-CANARY' });
    expect(seen.bobFile).toEqual({ ok: true, v: 'BOB-CANARY' });
    try { process.kill(seen.kid, 'SIGKILL'); } catch { /* gone */ }
  }, 60_000);

  it.runIf(!CAN_SWITCH)('without the capabilities to switch users the engine refuses and never runs the script as root', async () => {
    process.env.TANGU_SCRIPT_ISOLATION = 'required';
    const n = scriptSpawns('marker.mjs').length;
    const { outputs } = await scriptRun('alice', [{ skill: SKILL, script: 'scripts/marker.mjs', args: ['nocaps'] }]);
    const missing = ([['CAP_CHOWN', 0], ['CAP_DAC_OVERRIDE', 1], ['CAP_KILL', 5], ['CAP_SETGID', 6], ['CAP_SETUID', 7]] as const)
      .filter(([, b]) => (capEff() & (1n << BigInt(b))) === 0n).map(([n]) => n);
    expect(outputs[0]).toContain(`Error: Plugin scripts are disabled on this engine: they must run as a separate system user, but the engine lacks ${missing.join(', ')}.`);
    expect(scriptSpawns('marker.mjs').length).toBe(n);
    expect(existsSync(join(accDir('alice'), 'workspace', 'marker-nocaps.txt'))).toBe(false);
  }, 60_000);
});
