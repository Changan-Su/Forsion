// Muse 会不会在「机器刚睡醒的那几秒」起周期(11-20 生产遥测:macOS 合盖 DarkWake 里起的周期到下一次醒才报网络错 / 超时)。
// 真 standalone 进程 × mock OpenAI 端点 × 隔离 home:开 Muse(心跳 1 分钟、巡检 1 分钟),等第一个周期跑完,
// SIGSTOP 冻住引擎 150s(= 睡过一觉:墙钟往前走、定时器全过期),SIGCONT 后量「下一个周期离恢复多久起跑」。
//   修前:恢复后 1–2 秒内就起(到期的巡检定时器一醒就触发)= REPRO
//   修后:等满睡醒稳定期(60s)才起,日志里有「没有存活心跳」那行 = CLEAN
// 用法:npm run build && node scripts/muse-darkwake.repro.mjs [--entry <dist/standalone/main.js>] [--stop-seconds 150]
// 退出码:REPRO = 1。负对照:把 muse.ts 里 inWakeSettle 那道闸临时关掉再 build,用 --entry 指向那份 dist 跑一遍,应当 REPRO。
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtempSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const arg = (name, dflt) => { const i = process.argv.indexOf(`--${name}`); return i > 0 ? process.argv[i + 1] : dflt; };
const entry = resolve(arg('entry', join(root, 'dist', 'standalone', 'main.js')));
const STOP_MS = Number(arg('stop-seconds', 150)) * 1000;
if (!existsSync(entry)) { console.error(`没有 ${entry}:先 npm run build`); process.exit(2); }
const TOKEN = 'darkwake-token';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 假模型:什么都答一句就收(Muse 周期一步就 done),只记请求时刻。 */
function startMock() {
  const hits = [];
  const srv = createServer((req, res) => {
    if (!(req.method === 'POST' && req.url.endsWith('/chat/completions'))) { res.writeHead(404).end(); return; }
    req.resume();
    req.on('end', () => {
      hits.push(Date.now());
      const send = (o) => res.write(`data: ${JSON.stringify(o)}\n\n`);
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      send({ choices: [{ delta: { content: 'Nothing to do this cycle.' } }] });
      send({ choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 5 } });
      res.end('data: [DONE]\n\n');
    });
  });
  return new Promise((r) => srv.listen(0, '127.0.0.1', () => r({ port: srv.address().port, hits, close: () => srv.close() })));
}

const home = mkdtempSync(join(tmpdir(), 'tangu-darkwake-'));
const mock = await startMock();
const provFile = join(home, 'providers.json');
(await import('node:fs')).writeFileSync(provFile, JSON.stringify([{ providerId: 'mock', baseUrl: `http://127.0.0.1:${mock.port}/v1`, modelIds: ['test-model'] }]));
const port = 39000 + Math.floor(Math.random() * 1000);
const lines = []; // [时刻, 一行]
const child = spawn(process.execPath, [
  entry, '--port', String(port), '--host', '127.0.0.1', '--data-dir', join(home, 'state.db'),
  '--sandbox', 'none', '--cloud-url', 'http://127.0.0.1:9', '--token', TOKEN, '--providers-file', provFile,
], { env: { ...process.env, TANGU_HOME: home }, stdio: ['ignore', 'pipe', 'pipe'] });
let buf = '';
const onData = (d) => { buf += String(d); let i; while ((i = buf.indexOf('\n')) >= 0) { lines.push([Date.now(), buf.slice(0, i)]); buf = buf.slice(i + 1); } };
child.stdout.on('data', onData);
child.stderr.on('data', onData);
const cycles = (since = 0) => lines.filter(([t, l]) => t >= since && /\[muse\].*启动第 \d+\/\d+ 个思考周期/.test(l));

let ok = false;
const t0 = Date.now();
let contAt = 0;
try {
  for (let i = 0; ; i++) {
    if (await fetch(`http://127.0.0.1:${port}/health`).then((r) => r.ok).catch(() => false)) break;
    if (i > 100 || child.exitCode !== null) throw new Error(`引擎 20s 未就绪\n${lines.map((x) => x[1]).join('\n').slice(-800)}`);
    await sleep(200);
  }
  const r = await fetch(`http://127.0.0.1:${port}/agent/special/config`, {
    method: 'POST', headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ muse: { enabled: true, modelId: 'mock/test-model', mode: 'ask', heartbeatMinutes: 1, supervisorPollMinutes: 1, maxIterationsPerCycle: 4, maxRestartsPerWindow: 10, activeHours: null } }),
  });
  if (!r.ok) throw new Error(`开 Muse 失败:HTTP ${r.status}`);
  // 第一个周期(开 Muse 会催一次巡检)跑完再冻:否则冻住的是一个在飞的周期,量的就不是「醒来起不起新周期」
  for (let t = 0; !cycles().length; t += 500) { if (t > 60_000) throw new Error('60s 内没起第一个周期'); await sleep(500); }
  await sleep(8000);
  const before = cycles().length;
  console.log(`第一个周期已起(${before} 个);SIGSTOP ${STOP_MS / 1000}s`);
  child.kill('SIGSTOP');
  await sleep(STOP_MS);
  contAt = Date.now();
  child.kill('SIGCONT');
  // 最多等 150s:修后应在 ~60s 起;修前 1–2s 就起
  let next = null;
  for (let t = 0; t < 150_000 && !next; t += 250) { next = cycles(contAt)[0] || null; if (!next) await sleep(250); }
  const gapLine = lines.find(([t, l]) => t >= contAt && /没有存活心跳/.test(l));
  if (!next) throw new Error('SIGCONT 后 150s 内没起周期(心跳 1 分钟,应当起)');
  const delay = (next[0] - contAt) / 1000;
  ok = delay >= 50;
  console.log(`SIGCONT 后 ${delay.toFixed(1)}s 起下一个周期;「没有存活心跳」日志:${gapLine ? '有' : '无'}`);
  console.log(`${ok ? 'CLEAN' : 'REPRO'}  ${ok ? '睡醒后等稳定期才起' : '一醒就起(DarkWake 里起周期)'}`);
} catch (e) {
  console.error(String(e?.stack || e));
  ok = false;
} finally {
  if (process.argv.includes('--verbose')) for (const [t, l] of lines) if (/\[muse\]|run=|SIG/.test(l)) console.log(`  ${((t - (contAt || t0)) / 1000).toFixed(1).padStart(7)}s  ${l.slice(0, 170)}`);
  try { child.kill('SIGCONT'); child.kill('SIGKILL'); } catch { /* noop */ }
  mock.close();
  rmSync(home, { recursive: true, force: true });
}
process.exit(ok ? 0 : 1);
