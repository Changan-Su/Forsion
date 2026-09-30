// Self-check, host-isomorphic: node check.mjs (non-zero exit = contract broken).
// Evaluates main.js the way the desktop host does (new Function('ctx', src)), checks the bundle's
// engine-side files, runs the unit tests, and runs the CLI on the bundled example.
// The browser end-to-end test is separate: NODE_PATH=$(npm root -g) node test/studio.e2e.mjs
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(fileURLToPath(import.meta.url));
const at = p => join(ROOT, p);
const fail = msg => { console.error(`✗ ${msg}`); process.exit(1); };
const ok = msg => console.log(`✓ ${msg}`);
const manifest = JSON.parse(readFileSync(at('manifest.json'), 'utf8'));
const src = readFileSync(at('main.js'), 'utf8');

// 1. manifest, changelog, build outputs
if (!/^[a-z0-9-]+$/.test(manifest.id)) fail('manifest id must be kebab-case');
const top = readFileSync(at('CHANGELOG.md'), 'utf8').match(/^## (\d+\.\d+\.\d+)/m)?.[1];
if (top !== manifest.version) fail(`CHANGELOG top ${top} ≠ manifest.version ${manifest.version}`);
for (const f of ['main.js', 'runtime/fvs-runtime.js', 'tools/fvs.mjs']) {
  const head = readFileSync(at(f), 'utf8').split('\n').slice(0, 2).join('\n');
  if (!head.includes(`Forsion Video Studio ${manifest.version}`)) fail(`${f} was built for another version; run npm run build`);
}
if (/^\s*(import|export)\s/m.test(src)) fail('main.js must be a bare setup body (no top-level import/export)');
const runtime = readFileSync(at('runtime/fvs-runtime.js'), 'utf8');
// the runtime is embedded as a string; compare a stretch of it that needs no escaping
const probe = runtime.slice(runtime.indexOf('\n') + 1).split(/["'\\\n]/).sort((a, b) => b.length - a.length)[0];
if (!probe || probe.length < 60 || !src.includes(probe)) fail('main.js embeds a different runtime; run npm run build');
const ob = manifest.onboarding;
if (!ob?.en?.intro || (ob.en.steps || []).length !== (ob.steps || []).length) fail('onboarding.en must mirror onboarding.steps');
if (ob.requires) fail('onboarding.requires would gate the plugin; nothing here is required to open a project');
ok(`manifest ${manifest.version}, changelog, build outputs`);

// 2. the host's view of main.js
const reg = { fileTypes: [], creators: [], commands: [], slash: [], embeds: [] };
const ctxFor = (fileTypeResult, locale = 'zh') => ({
  getLocale: () => locale,
  app: { workFolder: () => 'Forsion Video Studio', readFile: async () => null, writeFile: async () => {}, openFile: () => {} },
  registerFileType: d => { reg.fileTypes.push(d); return fileTypeResult; },
  registerFileCreator: d => reg.creators.push(d),
  registerCommand: d => reg.commands.push(d),
  registerSlashItem: d => reg.slash.push(d),
  registerEmbedRenderer: d => reg.embeds.push(d),
  loadData: async () => ({}), saveData: async () => {},
});
new Function('ctx', src)(ctxFor(true));
const [ft] = reg.fileTypes;
if (!ft || JSON.stringify(ft.extensions) !== JSON.stringify(manifest.fileExtensions)) fail('file type extensions must match manifest.fileExtensions');
if (reg.creators.length !== 1 || reg.slash.length !== 1 || reg.embeds.length !== 1) fail('expected one file creator, one slash item and one embed renderer');
for (const c of reg.commands) if (!c.id.startsWith('fvs-')) fail(`command id "${c.id}" lacks the fvs- prefix`);
for (const c of reg.commands.filter(c => c.invoke)) {
  if (/[^\x20-\x7e]/.test(c.invoke.description)) fail(`invoke description of ${c.id} must be English`);
  if (!c.invoke.params) fail(`invoke of ${c.id} must declare params`);
}
if (!reg.embeds[0].match('Videos/a.fvs.md') || reg.embeds[0].match('a.md')) fail('embed renderer must match .fvs.md only');
ok(`main.js registers ${reg.fileTypes.length} file type, ${reg.commands.length} commands, creator, slash item, embed`);
// a built-in owner of the suffix wins: nothing else may register
for (const k of Object.keys(reg)) reg[k] = [];
new Function('ctx', src)(ctxFor(false));
if (reg.creators.length || reg.commands.length || reg.slash.length || reg.embeds.length) fail('registerFileType === false must stop every other registration');
ok('yields entirely when the host owns .fvs.md');
// an old host without optional APIs must not throw during setup
new Function('ctx', src)({ registerFileType: () => undefined, registerFileCreator() {}, registerCommand() {}, registerSlashItem() {}, registerEmbedRenderer() {}, app: {} });
ok('setup survives a minimal host');

// 3. engine side: skill, agent
const skill = readFileSync(at('skills/forsion-video-studio/SKILL.md'), 'utf8');
if (!/^---\nname: forsion-video-studio\ndescription: .+/m.test(skill)) fail('SKILL.md frontmatter needs name and description');
const agentToml = readFileSync(at('agents/fvs-director/config.toml'), 'utf8');
if (!/^name = ".+"$/m.test(agentToml) || !/^version = "\d+\.\d+\.\d+"$/m.test(agentToml) || !/developer_instructions = '''/.test(agentToml)) fail('agent config.toml needs quoted name, version and developer_instructions');
if (!src.includes("'fvs-director'") && !src.includes('"fvs-director"')) fail('the UI must hand off to the bundled fvs-director agent');
if (!existsSync(at('agents/fvs-director/SOUL.md'))) fail('agent SOUL.md missing');
ok('skill and agent');

// 4. unit tests
const tests = readdirSync(at('test')).filter(f => f.endsWith('.test.mjs')).map(f => at(`test/${f}`));
const t = spawnSync(process.execPath, ['--test', ...tests], { encoding: 'utf8' });
if (t.status !== 0) { console.error(t.stdout, t.stderr); fail('unit tests failed'); }
ok(`unit tests (${(t.stdout.match(/^# pass (\d+)/m) || [])[1]} passed)`);

// 5. the CLI on the bundled example
const ex = at('examples/episode-2.12/episode-2.12.fvs.md');
const info = spawnSync(process.execPath, [at('tools/fvs.mjs'), 'check', ex], { encoding: 'utf8' });
if (info.status !== 0) { console.error(info.stdout, info.stderr); fail('fvs check failed on the example'); }
const cues = JSON.parse(spawnSync(process.execPath, [at('tools/fvs.mjs'), 'cues', ex], { encoding: 'utf8' }).stdout);
if (cues.length !== 94.4 || cues.scenes.length !== 20 || cues.bpm !== 150) fail(`example cue sheet changed: ${cues.length} s, ${cues.scenes.length} scenes`);
ok(`CLI: ${info.stdout.trim()}`);
console.log('all checks passed');
