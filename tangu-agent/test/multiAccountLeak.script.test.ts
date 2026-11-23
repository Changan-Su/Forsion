/**
 * Multi-account mode: the plugin script entry (run_plugin_script) — the only way the engine starts a process for an account.
 *
 *   - only scripts inside a plugin package run: not files the account wrote, not links out of the package, not the account's
 *     own (writable) copy of a seeded skill — an absolute path to that copy runs the package original instead
 *   - no shell, an empty environment apart from PATH / locale (no host token, no engine home), HOME / TMPDIR in the turn's
 *     scratch folder inside the account, cwd in the account; path-like arguments must stay in the account folder
 *   - one script at a time across all accounts (two accounts' scripts never overlap)
 *   - a script past `scriptMinutes`, or over `scriptScratchMB` of temporary data, is ended with its whole process group
 *   - links a script leaves in the account folder are removed; the scratch folder is gone when the turn ends
 *   - every process started is a package script (spawn spy)
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

import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { bootMultiAccount, runToEnd, startRun, steps, type MaEngine } from './helpers/multiAccountHarness.js';
import { spawnLog } from './helpers/multiAccountSpawnSpy.js';
import { LIMITS_FILE_NAME, reloadMultiAccountLimits } from '../src/core/multiAccountLimits.js';
import { pluginScriptQueue } from '../src/services/pluginScripts.js';

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
  writeFileSync(join(sdir, 'notes.txt'), 'not a script');
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
}

let E: MaEngine;
beforeAll(async () => {
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
