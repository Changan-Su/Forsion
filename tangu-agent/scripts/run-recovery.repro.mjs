// 在飞 run 遇到「引擎重启」或「另一个引擎进程起来」会不会被原样重跑(PI-DSH 评审 R2 的复现台架)。
// 真 standalone 进程 × mock OpenAI 端点 × 同一个 state.db:
//   主循环第一轮请求回一个 run_bash(往 side-effect.log 追加一行 = 可观测副作用),工具结果回来后的第二轮请求挂住不回(= run 在飞)。
//   crash  :A 跑到挂住 → kill -9 A → 起 B → B 是否从头重跑(首轮请求再来一次、副作用再写一行)
//   sigterm:同上但发 SIGTERM(桌面退出 / 更新的正常路径)→ run 行是否已落终态、B 是否重跑
//   cross  :A 还活着、run 在飞 → 起 B(同库,自愈全开 = 桌面拉起的引擎)→ B 是否把 A 的在飞 run 再跑一遍
// 用法:npm run build && npm run e2e:runrecovery [-- crash|sigterm|cross ...]
// 退出码:有场景出现「重跑」或「副作用重复」= 1。
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const entry = join(root, 'dist', 'standalone', 'main.js');
if (!existsSync(entry)) {
  console.error('dist 缺失,先 npm run build');
  process.exit(1);
}
const Database = createRequire(import.meta.url)('better-sqlite3');
const TOKEN = 'repro-token';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const scenarios = process.argv.slice(2).length ? process.argv.slice(2) : ['crash', 'sigterm', 'cross'];

function startMock() {
  const stats = { firstTurn: 0, afterTool: 0, other: 0 };
  const hung = new Set();
  const srv = createServer((req, res) => {
    if (!(req.method === 'POST' && req.url.endsWith('/chat/completions'))) { res.writeHead(404).end(); return; }
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      let j = {};
      try { j = JSON.parse(body); } catch { /* 坏包按旁路请求答 */ }
      const send = (o) => res.write(`data: ${JSON.stringify(o)}\n\n`);
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      // 标题 / 记忆之类的旁路请求不带 run_bash:答一句就收,不计数
      if (!(j.tools || []).some((t) => t?.function?.name === 'run_bash')) {
        stats.other++;
        send({ choices: [{ delta: { content: 'ok' } }] });
        send({ choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1 } });
        res.end('data: [DONE]\n\n');
        return;
      }
      if ((j.messages || []).some((m) => m.role === 'tool')) { stats.afterTool++; hung.add(res); return; }
      stats.firstTurn++;
      send({ choices: [{ delta: { tool_calls: [{ index: 0, id: `call_${stats.firstTurn}`, type: 'function', function: { name: 'run_bash', arguments: JSON.stringify({ command: 'echo SIDE >> side-effect.log' }) } }] } }] });
      send({ choices: [{ delta: {}, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 10, completion_tokens: 5 } });
      res.end('data: [DONE]\n\n');
    });
  });
  return new Promise((r) => srv.listen(0, '127.0.0.1', () => r({
    port: srv.address().port, stats,
    close: () => { for (const res of hung) try { res.destroy(); } catch { /* noop */ } srv.close(); },
  })));
}

function startEngine(home, provFile, name) {
  const port = 39000 + Math.floor(Math.random() * 1000);
  const logs = [];
  const child = spawn(process.execPath, [
    entry, '--port', String(port), '--host', '127.0.0.1', '--data-dir', join(home, 'state.db'),
    '--sandbox', 'none', '--cloud-url', 'http://127.0.0.1:9', '--token', TOKEN, '--providers-file', provFile,
  ], { env: { ...process.env, TANGU_HOME: home }, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.on('data', (d) => logs.push(String(d)));
  child.stderr.on('data', (d) => logs.push(String(d)));
  const exited = new Promise((r) => child.on('exit', r));
  return { name, port, child, logs, exited };
}

async function waitHealth(e) {
  for (let i = 0; i < 100; i++) {
    await sleep(200);
    if (await fetch(`http://127.0.0.1:${e.port}/health`).then((r) => r.ok).catch(() => false)) return;
    if (e.child.exitCode !== null) break;
  }
  throw new Error(`${e.name} 20s 未就绪\n${e.logs.join('').slice(-800)}`);
}

async function waitFor(pred, ms, what) {
  for (let t = 0; t < ms; t += 100) {
    if (pred()) return;
    await sleep(100);
  }
  throw new Error(`等待超时:${what}`);
}

function runRow(home, runId) {
  const db = new Database(join(home, 'state.db'), { readonly: true, fileMustExist: true });
  try { return db.prepare('SELECT status, error FROM agent_runs WHERE id = ?').get(runId) || null; } finally { db.close(); }
}

async function scenario(kind) {
  const home = mkdtempSync(join(tmpdir(), `tangu-r2-${kind}-`));
  const work = join(home, 'work');
  mkdirSync(work);
  const sideLines = () => (existsSync(join(work, 'side-effect.log')) ? readFileSync(join(work, 'side-effect.log'), 'utf8').split('\n').filter(Boolean).length : 0);
  const mock = await startMock();
  const provFile = join(home, 'providers.json');
  writeFileSync(provFile, JSON.stringify([{ providerId: 'mock', baseUrl: `http://127.0.0.1:${mock.port}/v1`, modelIds: ['test-model'] }]));
  const engines = [];
  try {
    const A = startEngine(home, provFile, 'A');
    engines.push(A);
    await waitHealth(A);
    const r = await fetch(`http://127.0.0.1:${A.port}/agent/runs`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ session_id: `r2-${kind}`, model_id: 'mock/test-model', message: 'go', agent_config: { execMode: 'host', approvalMode: 'full-auto', cwd: work } }),
    }).then((x) => x.json());
    const runId = r.runId;
    await waitFor(() => mock.stats.afterTool >= 1 && sideLines() >= 1, 30_000, 'A 执行完工具、第二轮请求挂住');
    const before = { firstTurn: mock.stats.firstTurn, side: sideLines(), row: runRow(home, runId) };

    if (kind === 'crash') { A.child.kill('SIGKILL'); await A.exited; }
    if (kind === 'sigterm') { A.child.kill('SIGTERM'); await A.exited; }
    const atRestart = runRow(home, runId);

    const B = startEngine(home, provFile, 'B');
    engines.push(B);
    await waitHealth(B);
    await sleep(6000); // B 的启动自愈是异步的:给它时间捡行、重跑、执行工具
    const after = { firstTurn: mock.stats.firstTurn, side: sideLines(), row: runRow(home, runId) };

    const rerun = after.firstTurn > before.firstTurn;
    const dup = after.side > before.side;
    console.log(`\n[${kind}] run=${runId}`);
    console.log(`  A 在飞时:首轮请求 ${before.firstTurn} 次,副作用 ${before.side} 行,行状态 ${JSON.stringify(before.row)}`);
    console.log(`  B 起来前:行状态 ${JSON.stringify(atRestart)}`);
    console.log(`  B 起来后:首轮请求 ${after.firstTurn} 次,副作用 ${after.side} 行,行状态 ${JSON.stringify(after.row)}`);
    const bLog = B.logs.join('').split('\n').filter((l) => /re-enqueued|stale|recover|interrupted/i.test(l));
    if (bLog.length) console.log(`  B 日志:${bLog.join(' | ')}`);
    console.log(`  ${rerun || dup ? 'REPRO' : 'CLEAN'}  从头重跑=${rerun} 副作用重复=${dup}`);
    return !(rerun || dup);
  } finally {
    for (const e of engines) try { e.child.kill('SIGKILL'); } catch { /* noop */ }
    await Promise.all(engines.map((e) => e.exited));
    mock.close();
    rmSync(home, { recursive: true, force: true });
  }
}

let bad = 0;
for (const kind of scenarios) {
  try {
    if (!(await scenario(kind))) bad++;
  } catch (e) {
    bad++;
    console.log(`\n[${kind}] 台架异常:${e?.message || e}`);
  }
}
process.exit(bad ? 1 : 0);
