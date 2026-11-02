// Real standalone entry/assemble smoke. No configured runtime or model/network mocks.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const root = mkdtempSync(path.join(tmpdir(), 'tangu-model-boot-'));
const home = path.join(root, 'home'), plugins = path.join(root, 'plugins'), plugin = path.join(plugins, 'boot-model');
mkdirSync(home, { recursive: true }); mkdirSync(path.join(plugin, 'dist'), { recursive: true });
writeFileSync(path.join(home, 'config.json'), JSON.stringify({
  specialAgents: { muse: { enabled: false }, historian: { enabled: false } },
  specialAgentMigrations: { enableByDefaultVersion: 1, harnessCandidatesVersion: 1, museBudgetVersion: 1 },
}));
writeFileSync(path.join(plugin, 'package.json'), '{"type":"module"}');
writeFileSync(path.join(plugin, 'tangu-plugin.json'), JSON.stringify({ id: 'boot-model', name: 'Boot model', version: '1.0.0', apiVersion: 1, entry: 'dist/index.js' }));
writeFileSync(path.join(plugin, 'dist/index.js'), `export default { activate(ctx) {
  ctx.registerPlugin({ id: 'boot-model', name: 'Boot model', description: 'Boot fixture', defaultEnabled: true });
  ctx.registerModelProvider({ id: 'source',
    listModels: async () => [{ id: 'model', name: 'Boot model' }],
    resolveModel: async id => id === 'model' ? { id, name: 'Boot model' } : null,
    stream: async () => ({ content: 'ready', reasoning: '', toolCalls: [], usage: { prompt_tokens: 1, completion_tokens: 1 } }),
  });
} };`);
const env = { ...process.env };
for (const key of Object.keys(env)) if (key.startsWith('TANGU_') || key === 'DATABASE_URL') delete env[key];
Object.assign(env, { TANGU_HOME: home, TANGU_PLUGINS: 'on', TANGU_PLUGINS_DIR: plugins, TANGU_BROWSER_CDP: 'off', TANGU_BROWSER_EXTENSION: '0' });
const token = randomUUID();
let log = '', timer;
const child = spawn(process.execPath, [path.join(repo, 'dist/standalone/main.js'), '--host', '127.0.0.1', '--port', '0',
  '--data-dir', path.join(root, 'state.db'), '--sandbox', 'off', '--cloud-url', 'http://127.0.0.1:9', '--token', token],
  { cwd: repo, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
for (const stream of [child.stdout, child.stderr]) stream.on('data', data => { log = (log + data.toString().replaceAll(token, '[local-auth]')).slice(-64000); });
try {
  const ready = await new Promise((resolve, reject) => {
    timer = setTimeout(() => reject(new Error('Standalone boot timed out')), 45000);
    child.on('message', message => { if (message?.type === 'tangu:ready') resolve(message); });
    child.once('error', reject);
    child.once('exit', code => reject(new Error(`Standalone exited during boot (${code})`)));
  });
  clearTimeout(timer);
  const api = async (url, method = 'GET', body) => {
    const response = await fetch(`http://127.0.0.1:${ready.port}${url}`, { method,
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(10000) });
    assert.equal(response.ok, true, `${method} ${url}: ${response.status}`);
    return response.json();
  };
  const list = await api('/agent/plugins');
  assert.equal(list.plugins.find(p => p.id === 'boot-model')?.active, true, 'Model provider must activate during a real cold boot');
  const hasModel = async () => (await api('/agent/models')).models.some(m => m.id === 'plugin:boot-model/source/model');
  assert.equal(await hasModel(), true, 'Registered source must appear in the native catalog');
  await api('/agent/plugins/boot-model/enabled', 'PUT', { enabled: false });
  assert.equal(await hasModel(), false, 'Disable must remove the source');
  await api('/agent/plugins/boot-model/enabled', 'PUT', { enabled: true });
  assert.equal(await hasModel(), true, 'Re-enable must register a fresh source');
  assert.doesNotMatch(log, /runtime not configured/);
  console.log('PASS: real standalone cold boot, native model catalog, disable and re-enable');
} catch (error) {
  process.stderr.write(log);
  throw error;
} finally {
  clearTimeout(timer);
  if (child.exitCode === null) {
    const exited = new Promise(resolve => child.once('exit', resolve));
    child.kill('SIGTERM');
    const force = setTimeout(() => child.kill('SIGKILL'), 3000);
    await exited; clearTimeout(force);
  }
  const target = path.resolve(root);
  assert.ok(target.startsWith(path.join(path.resolve(tmpdir()), 'tangu-model-boot-')));
  rmSync(target, { recursive: true, force: true });
}
