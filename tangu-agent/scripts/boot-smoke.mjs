#!/usr/bin/env node
/**
 * 引擎启动冒烟:照桌面 backendManager 的姿势起一次 standalone,等 /health 200,打印带时间戳的全部输出。
 * 干净的临时家目录;可把捆绑包播种进共享域 plugins/(模拟桌面 builtinPlugins 播种的 CU)。
 *
 *   node scripts/boot-smoke.mjs --entry dist/standalone/main.js
 *   node scripts/boot-smoke.mjs --exe <Forsion.exe> --electron --entry <resources>/tangu-server/dist/standalone/main.js \
 *     --seed <resources>/bundled-plugins/tangu-computer-use --sandbox auto --hide-docker
 *
 * 退出码:0 = 就绪;1 = 早退 / 超时。起因:2.11.2 Windows 用户「后端退出(code=0)」反复,CI 从没真起过打包版引擎。
 */
import { spawn } from 'node:child_process';
import { cpSync, mkdtempSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';

const argv = process.argv.slice(2);
const opt = (name, def) => { const i = argv.indexOf(`--${name}`); return i >= 0 ? argv[i + 1] : def; };
const flag = (name) => argv.includes(`--${name}`);
const all = (name) => argv.flatMap((a, i) => (a === `--${name}` ? [argv[i + 1]] : []));

const entry = path.resolve(opt('entry', 'dist/standalone/main.js'));
const exe = opt('exe', process.execPath);
const timeoutMs = Number(opt('timeout', '45000'));
const root = opt('home') ? path.resolve(opt('home')) : mkdtempSync(path.join(tmpdir(), 'tangu-boot-'));
const forsionHome = path.join(root, '.forsion');
const tanguHome = path.join(forsionHome, 'tangu');

for (const src of all('seed')) {
  const dest = path.join(forsionHome, 'plugins', path.basename(src));
  cpSync(src, dest, { recursive: true, dereference: true });
  console.log(`[smoke] seeded ${src} -> ${dest}`);
}

const port = await new Promise((resolve, reject) => {
  const srv = createServer().listen(0, '127.0.0.1', () => { const p = srv.address().port; srv.close(() => resolve(p)); });
  srv.on('error', reject);
});

const env = { ...process.env, TANGU_HOME: tanguHome, TANGU_TOKEN: 'boot-smoke' };
if (flag('electron')) env.ELECTRON_RUN_AS_NODE = '1';
else delete env.ELECTRON_RUN_AS_NODE;
if (flag('hide-docker')) { // 模拟没装 Docker 的机器(CI runner 自带 docker)
  for (const k of Object.keys(env).filter((k) => k.toUpperCase() === 'PATH')) {
    env[k] = env[k].split(path.delimiter).filter((d) => !/docker/i.test(d)).join(path.delimiter);
  }
}
const args = [entry, '--port', String(port), '--host', '127.0.0.1', '--data-dir', path.join(tanguHome, 'state.db'),
  '--sandbox', opt('sandbox', 'auto'), '--cloud-url', opt('cloud-url', 'https://api.forsion.net')];

const t0 = Date.now();
const stamp = () => `+${String(Date.now() - t0).padStart(6)}ms`;
console.log(`[smoke] ${exe} ${args.join(' ')}\n[smoke] TANGU_HOME=${tanguHome}`);
const child = spawn(exe, args, { env, stdio: ['ignore', 'pipe', 'pipe'] });
for (const [name, stream] of [['out', child.stdout], ['err', child.stderr]]) {
  let buf = '';
  stream.on('data', (d) => {
    buf += d;
    const lines = buf.split('\n');
    buf = lines.pop();
    for (const l of lines) console.log(`${stamp()} ${name}| ${l.trimEnd()}`);
  });
  stream.on('end', () => { if (buf) console.log(`${stamp()} ${name}| ${buf.trimEnd()}`); });
}

const exited = new Promise((resolve) => child.on('exit', (code, signal) => resolve({ code, signal })));
const drained = Promise.all([child.stdout, child.stderr].map((s) => new Promise((r) => s.on('close', r))));
let result = null;
exited.then((r) => { result ??= { ok: false, why: `EXITED code=${r.code} signal=${r.signal}` }; });
while (!result && Date.now() - t0 < timeoutMs) {
  try {
    const r = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(1000) });
    if (r.ok) result = { ok: true, why: `READY ${JSON.stringify(await r.json())}` };
  } catch { /* 还没起来 */ }
  if (!result) await new Promise((r) => setTimeout(r, 300));
}
result ??= { ok: false, why: `TIMEOUT ${timeoutMs}ms` };
if (child.exitCode === null) { child.kill(); await exited; }
await Promise.race([drained, new Promise((r) => setTimeout(r, 2000))]); // 输出收齐再下结论(孙进程可能占着管道)
console.log(`[smoke] ${stamp()} ${result.why}`);
process.exit(result.ok ? 0 : 1);
