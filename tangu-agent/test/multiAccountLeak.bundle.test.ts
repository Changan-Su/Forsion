/**
 * Multi-account mode: a read-only plugin package mounted through `bundleDirs`.
 *
 * The package is laid out like the sample bundle: an engine plugin under `tangu-plugins/<pid>/` (whose code, if it
 * were ever loaded, writes a marker file and registers a tool and a route), a persona under `agents/<slug>/` and a
 * skill under `skills/<slug>/SKILL.md`, each carrying its own canary.
 * In multi-account mode the engine plugin is never loaded. The persona is seeded into each account's own agents
 * folder, so one account editing its copy leaves every other copy as shipped. The skill is usable by every account
 * and stays read-only: the package's files never change, whatever any account does.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';

const env = await vi.hoisted(async () => {
  const fs = await import('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'tangu-ma-bundle-')));
  const home = path.join(root, 'home');
  const userHome = path.join(root, 'user-home');
  const tmp = path.join(root, 'tmp');
  const pkg = path.join(root, 'packages', 'ma-probe-bundle');
  const markers = path.join(root, 'markers');
  for (const d of [home, userHome, tmp, pkg, markers]) fs.mkdirSync(d, { recursive: true });
  for (const k of ['TANGU_DATABASE_URL', 'DATABASE_URL', 'TANGU_EMBED', 'TANGU_DATA_DIR', 'TANGU_BUNDLE_DIRS', 'TANGU_PLUGINS', 'TANGU_PLUGINS_DIR']) delete process.env[k];
  process.env.TANGU_MULTI_ACCOUNT = '1';
  process.env.TANGU_HOME = home;
  process.env.TANGU_LOCAL_TOKEN = 'multi-account-local-host-token-qwertyuiop';
  process.env.HOME = userHome;
  process.env.TMPDIR = tmp;
  return { root, home, pkg, markers, marker: path.join(markers, 'engine-plugin-loaded.txt') };
});

vi.mock('node:child_process', async (orig) => (await import('./helpers/multiAccountSpawnSpy.js')).wrapChildProcess(await orig()));
vi.mock('child_process', async (orig) => (await import('./helpers/multiAccountSpawnSpy.js')).wrapChildProcess(await orig()));

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import {
  LOCAL_TOKEN, MODEL_ID, OWNER_REGISTRY_RE, REFUSAL_RE, bootMultiAccount, canary, describeResp, diffSnaps, findFile, grepTree,
  leakHits, loadToolsStep, respLeaks, snapshotTree, startRun, steps, waitQuiet, type MaEngine, type Script, type ScriptCtx, type Snap,
  type ToolCallSpec,
} from './helpers/multiAccountHarness.js';
import { spawnLog } from './helpers/multiAccountSpawnSpy.js';

const ALICE = 'alice';
const BOB = 'bob';
const accDir = (id: string) => join(env.home, 'accounts', id);
const AGENT = 'ma-bundle-agent';
const SKILL = 'ma-bundle-skill';
const TOOL = 'ma_probe_echo';
const P = {
  agentName: canary('bundle', 'agentname'),
  persona: canary('bundle', 'persona'),
  soul: canary('bundle', 'soul'),
  skillDesc: canary('bundle', 'skilldesc'),
  skill: canary('bundle', 'skillbody'),
};
const EDIT = { alicePersona: canary('alice', 'personaedit'), aliceSkill: canary('alice', 'skilledit'), bobSkill: canary('bob', 'skilledit') };

let E: MaEngine;
let pkgBefore: Snap;
let rootBefore: Snap;
const warnings: string[] = [];
const notes: string[] = [];
const skillIds = new Map<string, string>();

function writePackage(): void {
  const w = (rel: string, text: string) => { const p = join(env.pkg, rel); mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, text); };
  w('manifest.json', JSON.stringify({ id: 'ma-probe-bundle', name: 'Probe bundle', nameEn: 'Probe bundle', version: '1.0.0', apiVersion: 1, description: 'Multi-account probe package', descriptionEn: 'Multi-account probe package' }, null, 2));
  // engine plugin: any load (import) or activation leaves a line in the marker file
  w('tangu-plugins/ma-probe-tool/tangu-plugin.json', JSON.stringify({ id: 'ma-probe-tool', name: 'Probe tool', version: '1.0.0', apiVersion: 1, entry: 'dist/index.js', description: 'probe' }, null, 2));
  w('tangu-plugins/ma-probe-tool/package.json', JSON.stringify({ name: 'ma-probe-tool', version: '1.0.0', type: 'module', main: 'dist/index.js', private: true }, null, 2));
  w('tangu-plugins/ma-probe-tool/dist/index.js', `import { appendFileSync } from 'node:fs';
const MARK = ${JSON.stringify(env.marker)};
appendFileSync(MARK, 'imported\\n');
const plugin = {
  activate(ctx) {
    appendFileSync(MARK, 'activated\\n');
    try { ctx.registerRoute?.('get', '/agent/ma-probe', (_q, r) => r.json({ probe: true })); } catch { /* optional */ }
    try { ctx.app?.get?.('/agent/ma-probe', (_q, r) => r.json({ probe: true })); } catch { /* optional */ }
    ctx.registerPlugin({
      id: 'ma-probe-tool', name: 'Probe tool', nameEn: 'Probe tool', description: 'probe', descriptionEn: 'probe',
      scopes: ['global'], defaultEnabled: true, settings: { fields: [] },
      toolProvider: {
        id: 'plugin:ma-probe-tool',
        tools: () => [{
          name: ${JSON.stringify(TOOL)}, mode: 'both', isEnabledFor: () => true,
          capabilities: { sideEffect: 'none', parallel: true },
          definition: { type: 'function', function: { name: ${JSON.stringify(TOOL)}, description: 'Probe echo', parameters: { type: 'object', properties: { message: { type: 'string' } } } } },
          execute: (a) => { appendFileSync(MARK, 'executed\\n'); return 'probe: ' + String(a?.message ?? ''); },
        }],
      },
    });
  },
  deactivate() {},
};
export default plugin;
`);
  w(`agents/${AGENT}/config.toml`, `name = "Probe agent ${P.agentName}"
version = "1.0.0"
description = "Probe agent shipped in a package"
created_by = "user"
developer_instructions = '''
Package persona ${P.persona}
'''
`);
  w(`agents/${AGENT}/SOUL.md`, `# Probe agent\n\nPackage soul ${P.soul}\n`);
  w(`skills/${SKILL}/SKILL.md`, `---
name: ${SKILL}
description: Probe skill shipped in a package ${P.skillDesc}
---

# Probe skill

Package skill body ${P.skill}
`);
}

const pkgChanges = () => { const d = diffSnaps(pkgBefore, snapshotTree(env.pkg)); return [...d.added, ...d.changed, ...d.removed]; };
const quiet = () => waitQuiet(env.root, () => E.fake.outbound.length);
const markerLines = () => (existsSync(env.marker) ? readFileSync(env.marker, 'utf8').trim().split('\n') : []);

async function runAs(who: string, label: string, list: Parameters<typeof steps>[0], o: { agentSlug?: string; text?: string } = {}): Promise<Script> {
  const s = E.fake.script(who, label, steps(list, `${label} done`));
  const st = await startRun(E.client, who, s, { text: o.text ?? label, ...(o.agentSlug ? { agentConfig: { agentSlug: o.agentSlug } } : {}) });
  expect(st.runId, `${who}/${label}: ${describeResp(st.resp)}`).toBeTruthy();
  const f = await E.client.follow(who, st.runId!, { timeoutMs: 60_000 });
  expect(f.status, `${who}/${label}: ${f.text.slice(-400)}`).toBe('done');
  return s;
}

/** the id an account's skills listing gives the package skill */
async function packageSkillId(who: string): Promise<string> {
  const r = await E.client.call(who, 'GET', '/agent/skills');
  expect(r.status, describeResp(r)).toBe(200);
  const list: any[] = r.json?.skills ?? [];
  const hit = list.find((x) => JSON.stringify(x).includes(SKILL));
  expect(hit, `${who}: ${SKILL} missing from GET /agent/skills: ${r.text.slice(0, 400)}`).toBeTruthy();
  return String(hit.id ?? hit.key ?? hit.slug ?? SKILL);
}

beforeAll(async () => {
  writePackage();
  pkgBefore = snapshotTree(env.pkg);
  E = await bootMultiAccount({ bundleDirs: [env.pkg] });
  rootBefore = snapshotTree(env.root);
}, 120_000);
afterAll(async () => {
  try { await E?.dispose(); } catch { /* ignore */ }
  if (warnings.length) console.warn(`[multi-account package] coverage notes:\n  - ${warnings.join('\n  - ')}`);
  if (notes.length) console.warn(`[multi-account package] answers to manage_skill on the package skill:\n  - ${notes.join('\n  - ')}`);
  try { rmSync(env.root, { recursive: true, force: true }); } catch { /* ignore */ }
});

describe('multi-account mode: a plugin package mounted read-only', () => {
  it("the package's persona is seeded into each account's own agents folder", async () => {
    for (const who of [ALICE, BOB]) {
      const r = await E.client.call(who, 'GET', '/agent/agents');
      expect(r.status, describeResp(r)).toBe(200);
      expect(r.text, `${who}: package agent not listed`).toContain(AGENT);
      const soul = findFile(accDir(who), P.soul, 'SOUL.md');
      expect(soul, `${who}: no seeded SOUL.md under accounts/${who}`).toBeTruthy();
      expect(soul.startsWith(join(accDir(who), '') ) && soul.includes(`/agents/${AGENT}/`), soul).toBe(true);
      expect(readFileSync(soul, 'utf8'), `${who}: seeded SOUL.md differs from the package's`).toBe(readFileSync(join(env.pkg, 'agents', AGENT, 'SOUL.md'), 'utf8'));
      const cfg = findFile(accDir(who), P.persona, 'config.toml');
      expect(cfg.startsWith(join(accDir(who), '')) && cfg.includes(`/agents/${AGENT}/`), `${who} config.toml at ${cfg}`).toBe(true);
    }
    expect(pkgChanges(), 'package files changed').toEqual([]);
  }, 60_000);

  it("the package's engine plugin is never loaded: no import, no tool, no route", async () => {
    expect(markerLines(), 'engine plugin code ran').toEqual([]);
    expect(E.toolAllowlist.includes(TOOL), 'package tool in the allowlist').toBe(false);
    expect(E.routes.filter((r) => r.path.includes('ma-probe')).map((r) => `${r.method} ${r.path}`), 'package route registered').toEqual([]);
    for (const who of [ALICE, BOB]) {
      const r = await E.client.call(who, 'GET', '/agent/ma-probe');
      expect([403, 404], `${who} GET /agent/ma-probe: ${describeResp(r)}`).toContain(r.status);
      const s = await runAs(who, 'pkgtool', [
        loadToolsStep([TOOL]),
        { calls: [{ name: TOOL, args: { message: 'hello' } }, { name: 'get_datetime', args: {} }] },
      ]);
      const offered = new Set(s.requests.flatMap((x) => x.tools));
      expect(offered.has(TOOL), `${who}: ${TOOL} offered to the model`).toBe(false);
      const res = s.results.find((x) => x.name === TOOL);
      expect(res, `${who}: no answer to the hard-called ${TOOL}`).toBeDefined();
      expect(res!.output, `${who}: ${TOOL} was not refused`).toMatch(REFUSAL_RE);
      expect(res!.output).not.toContain('probe: hello');
    }
    expect(markerLines(), 'engine plugin code ran').toEqual([]);
  }, 120_000);

  it("alice editing her copy of the persona leaves bob's copy, a new account's copy and the package as shipped", async () => {
    const patch = await E.client.call(ALICE, 'PATCH', `/agent/agents/${AGENT}`, { body: { systemPrompt: `Alice rewrote this ${EDIT.alicePersona}` } });
    let edited = patch.status < 300;
    if (!edited) {
      // the route is closed or refuses the field: edit through alice's own run instead
      warnings.push(`PATCH /agent/agents/${AGENT} → ${patch.status}; alice edits through manage_agent`);
      const s = await runAs(ALICE, 'editagent', [
        loadToolsStep(['manage_agent']),
        (ctx: ScriptCtx) => {
          const props = Object.keys(ctx.schemas.get('manage_agent')?.properties ?? {});
          const field = props.find((k) => /prompt|soul|instruction|persona/i.test(k)) ?? 'system_prompt';
          return { calls: [{ name: 'manage_agent', args: { action: 'update', slug: AGENT, [field]: `Alice rewrote this ${EDIT.alicePersona}` } }] };
        },
      ]);
      edited = s.results.some((x) => x.name === 'manage_agent' && !/error/i.test(x.output));
    }
    const aliceList = await E.client.call(ALICE, 'GET', '/agent/agents');
    const aliceDisk = grepTree(accDir(ALICE), [EDIT.alicePersona]).filter((h) => h.file.includes(`agents/${AGENT}/`));
    expect(edited && (aliceList.text.includes(EDIT.alicePersona) || aliceDisk.length > 0), `alice's edit did not land in her copy: ${describeResp(patch)}`).toBe(true);
    await quiet();

    // bob: listing, files, and what his run sends to the model
    const bobList = await E.client.call(BOB, 'GET', '/agent/agents');
    expect(respLeaks(bobList, [EDIT.alicePersona]), "bob's agents listing shows alice's edit").toEqual([]);
    expect(bobList.text, "bob's listing lost the package agent").toContain(AGENT);
    const bobSoul = findFile(accDir(BOB), P.soul, 'SOUL.md');
    expect(readFileSync(bobSoul, 'utf8')).toBe(readFileSync(join(env.pkg, 'agents', AGENT, 'SOUL.md'), 'utf8'));
    expect(grepTree(accDir(BOB), [EDIT.alicePersona]).map((h) => h.file), "alice's edit inside bob's folder").toEqual([]);
    const bobRun = await runAs(BOB, 'usepkgagent', [], { agentSlug: AGENT, text: 'Who are you?' });
    const sent = bobRun.requests.map((x) => x.text).join('\n');
    expect(leakHits(sent, [EDIT.alicePersona]), "alice's edit reached bob's model request").toEqual([]);
    if (!leakHits(sent, [P.persona, P.soul]).length) warnings.push("the package persona did not reach bob's model request through agentSlug");

    // a new account opened after the edit gets the package's original, not alice's copy
    const carolList = await E.client.call('carol', 'GET', '/agent/agents');
    expect(respLeaks(carolList, [EDIT.alicePersona]), "carol's agents listing shows alice's edit").toEqual([]);
    const carolSoul = findFile(accDir('carol'), P.soul, 'SOUL.md');
    expect(carolSoul && readFileSync(carolSoul, 'utf8'), "carol's seeded SOUL.md").toBe(readFileSync(join(env.pkg, 'agents', AGENT, 'SOUL.md'), 'utf8'));
    expect(grepTree(env.root, [EDIT.alicePersona], (rel) => rel.startsWith('home/accounts/alice/')).map((h) => h.file), "alice's edit outside her folder").toEqual([]);
    expect(pkgChanges(), 'package files changed').toEqual([]);
  }, 120_000);

  it("the package's skill is listed and usable by both accounts, and no account can change it", async () => {
    for (const who of [ALICE, BOB]) skillIds.set(who, await packageSkillId(who));
    const use = async (who: string, label: string) => {
      const id = skillIds.get(who)!;
      const s = await runAs(who, label, [
        loadToolsStep(['use_skill']),
        { calls: [{ name: 'use_skill', args: { skill_id: id } }] },
      ]);
      const out = s.results.filter((x) => x.name === 'use_skill').map((x) => x.output).join('\n');
      return out;
    };
    for (const who of [ALICE, BOB]) expect(await use(who, 'usepkgskill'), `${who}: use_skill on the package skill`).toContain(P.skill);

    // both accounts try to change and delete the package skill through manage_skill
    // an account changes the package skill through manage_skill (any create / update action, by slug and by id), the
    // other account is checked while that change is live, then the first account deletes it
    const tamper = async (who: string, edit: string, phase: 'change' | 'delete') => runAs(who, `tamper-${phase}`, [
      loadToolsStep(['manage_skill']),
      (ctx: ScriptCtx) => {
        const en: string[] = ctx.schemas.get('manage_skill')?.properties?.action?.enum ?? (phase === 'change' ? ['update'] : ['delete']);
        const re = phase === 'change' ? /update|edit|patch|write|replace|create/ : /delete|remove/;
        const calls: ToolCallSpec[] = [];
        for (const action of en.filter((a) => re.test(a))) {
          for (const slug of [SKILL, skillIds.get(who)!]) {
            calls.push({ name: 'manage_skill', args: phase === 'change'
              ? { action, slug, name: SKILL, description: `changed ${edit}`, instructions: `Changed body ${edit}`, content: `Changed body ${edit}` }
              : { action, slug } });
          }
        }
        return { calls };
      },
    ]);
    const answers = (t: Script) => t.results.filter((x) => x.name === 'manage_skill').map((x) => `${x.args.action} ${x.args.slug} → ${x.output.replace(/\s+/g, ' ').slice(0, 140)}`);
    const otherSees = async (viewer: string, edit: string, label: string) => {
      const list = await E.client.call(viewer, 'GET', '/agent/skills');
      expect(respLeaks(list, [edit]), `${viewer}'s skills listing shows the other account's change (${label})`).toEqual([]);
      expect(list.text, `the package skill vanished from ${viewer}'s listing (${label})`).toContain(SKILL);
      const out = await use(viewer, `use-${label}`);
      expect(out, `${viewer} lost the package skill (${label})`).toContain(P.skill);
      expect(leakHits(out, [edit]), `${viewer}'s use_skill shows the other account's change (${label})`).toEqual([]);
    };
    for (const [who, viewer, edit] of [[ALICE, BOB, EDIT.aliceSkill], [BOB, ALICE, EDIT.bobSkill]] as const) {
      const changed = answers(await tamper(who, edit, 'change'));
      expect(changed.length, `${who} made no manage_skill change call`).toBeGreaterThan(0);
      notes.push(...changed.map((x) => `${who} manage_skill ${x}`));
      await quiet();
      expect(pkgChanges(), `package files changed by ${who}`).toEqual([]);
      expect(grepTree(env.root, [edit], (rel) => rel.startsWith(`home/accounts/${who}/`)).map((h) => h.file), `${who}'s skill change outside their folder`).toEqual([]);
      await otherSees(viewer, edit, `${who}'s change live`);
      const deleted = answers(await tamper(who, edit, 'delete'));
      notes.push(...deleted.map((x) => `${who} manage_skill ${x}`));
      await quiet();
      expect(pkgChanges(), `package files changed by ${who}'s delete`).toEqual([]);
      await otherSees(viewer, edit, `after ${who}'s delete`);
      expect(await use(who, `use-own-after-${who}`), `${who} gets the package skill back after deleting the change`).toContain(P.skill);
    }
    const carolId = await packageSkillId('carol');
    skillIds.set('carol', carolId);
    expect(await use('carol', 'usepkgskill3'), 'a new account gets the package skill as shipped').toContain(P.skill);
  }, 180_000);

  it('nothing outside the accounts folders changed but the session registry; the package is byte-identical; no child process', async () => {
    const after = await quiet();
    const d = diffSnaps(rootBefore, after);
    const outside = [...d.added, ...d.changed, ...d.removed].filter((p) => !p.startsWith('home/accounts/') && !OWNER_REGISTRY_RE.test(p));
    expect(outside, 'files changed outside home/accounts').toEqual([]);
    expect(pkgChanges(), 'package files changed').toEqual([]);
    expect(markerLines(), 'engine plugin code ran').toEqual([]);
    expect(spawnLog().filter((x) => !x.tag).map((x) => `${x.fn} ${x.command}`), 'child process').toEqual([]);
    expect(LOCAL_TOKEN && MODEL_ID).toBeTruthy();
  });
});
