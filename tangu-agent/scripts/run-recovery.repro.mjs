// 在飞 run 遇到「引擎重启」或「另一个引擎进程起来」会怎样(PI-DSH 评审 R2 的复现台架;2026-11-20 起兼验中断任务续跑方案 B)。
// 真 standalone 进程 × mock OpenAI 端点 × 同一个 state.db:
//   主循环第一轮请求回一个 run_bash(往 side-effect.log 追加一行 = 可观测副作用),工具结果回来后的第二轮请求挂住不回(= run 在飞)。
//   消息里出现 `[auto-resume:` 的请求 = 引擎自动续的那一轮:mock 直接答一句收尾,并记下回放给它的工具结果。
//   crash  :A 跑到挂住 → kill -9 A → 起 B → 原 run 记 interrupted:crash,B 自动续一轮(trigger=recovery)跑完;不从头重跑、副作用不重复
//   sigterm:同上但发 SIGTERM、没有意图文件 → A 退出前把 run 落成 interrupted:engine_stop;不可自动续 → B 只补中断说明行
//   intent :SIGTERM 前写 shutdown-intent.json(app_update,pid = A)→ A 落成 interrupted:app_update → B 自动续跑完,意图文件被删
//   midtool:工具执行到一半(副作用已写、命令还在 sleep)kill -9 → B 自动续;回放给模型的那条结果是「Outcome unknown」,副作用不重复
//   tui    :同 crash,但把 run 的 hostRecovery 戳抹掉(= TUI 建的 run,TUI 不开恢复宿主)→ B 只补中断说明行,不自动续
//   cross  :A 还活着、run 在飞 → 起 B(同库,自愈全开 = 桌面拉起的引擎)→ B 不碰 A 的在飞 run
// 用法:npm run build && npm run e2e:runrecovery [-- crash|sigterm|intent|midtool|tui|cross ...]
// 退出码:任一场景不符合预期(重跑 / 副作用重复 / 该续没续 / 不该续却续了)= 1。
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
const scenarios = process.argv.slice(2).length ? process.argv.slice(2) : ['crash', 'sigterm', 'intent', 'midtool', 'tui', 'cross'];

function startMock(toolCommand) {
  const stats = { firstTurn: 0, afterTool: 0, resume: 0, resumeToolTexts: [], other: 0 };
  const hung = new Set();
  const text = (c) => (typeof c === 'string' ? c : Array.isArray(c) ? c.map((p) => p?.text || '').join('') : '');
  const srv = createServer((req, res) => {
    if (!(req.method === 'POST' && req.url.endsWith('/chat/completions'))) { res.writeHead(404).end(); return; }
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      let j = {};
      try { j = JSON.parse(body); } catch { /* 坏包按旁路请求答 */ }
      const send = (o) => res.write(`data: ${JSON.stringify(o)}\n\n`);
      const reply = (content) => {
        send({ choices: [{ delta: { content } }] });
        send({ choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1 } });
        res.end('data: [DONE]\n\n');
      };
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      // 标题 / 记忆之类的旁路请求不带 run_bash:答一句就收,不计数
      if (!(j.tools || []).some((t) => t?.function?.name === 'run_bash')) { stats.other++; reply('ok'); return; }
      const msgs = j.messages || [];
      // 自动续跑的那一轮:记下回放的工具结果,答一句收尾(不再调工具 = 续跑不应重复副作用)
      if (msgs.some((m) => m.role === 'user' && text(m.content).includes('[auto-resume:'))) {
        stats.resume++;
        stats.resumeToolTexts.push(...msgs.filter((m) => m.role === 'tool').map((m) => text(m.content)));
        reply('RESUMED-DONE');
        return;
      }
      if (msgs.some((m) => m.role === 'tool')) { stats.afterTool++; hung.add(res); return; }
      stats.firstTurn++;
      send({ choices: [{ delta: { tool_calls: [{ index: 0, id: `call_${stats.firstTurn}`, type: 'function', function: { name: 'run_bash', arguments: JSON.stringify({ command: toolCommand }) } }] } }] });
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

function withDb(home, fn, { write = false } = {}) {
  const db = new Database(join(home, 'state.db'), { readonly: !write, fileMustExist: true });
  try { db.pragma('busy_timeout = 5000'); return fn(db); } finally { db.close(); }
}
const runRow = (home, runId) => withDb(home, (db) => db.prepare('SELECT status, error, resumed_by FROM agent_runs WHERE id = ?').get(runId) || null);
// 同一会话里除原 run 之外的 run(自动续跑建的那条)
const otherRuns = (home, runId) => withDb(home, (db) => db.prepare(
  'SELECT id, status, error, input FROM agent_runs WHERE session_id = (SELECT session_id FROM agent_runs WHERE id = ?) AND id != ? ORDER BY created_at',
).all(runId, runId).map((r) => { let input = {}; try { input = JSON.parse(r.input || '{}'); } catch { /* 坏 input 当空 */ } return { ...r, input }; }));
const noticeRows = (home, runId) => withDb(home, (db) => db.prepare(
  "SELECT content FROM chat_messages WHERE session_id = (SELECT session_id FROM agent_runs WHERE id = ?) AND role = 'user' AND content LIKE '<turn_interrupted>%'",
).all(runId).map((r) => r.content));
// TUI 建的 run 不带 hostRecovery 戳(TUI 不开恢复宿主):直接抹掉戳来模拟
const stripHostRecovery = (home, runId) => withDb(home, (db) => {
  const row = db.prepare('SELECT input FROM agent_runs WHERE id = ?').get(runId);
  const input = JSON.parse(row.input);
  if (input.hostRecovery !== true) throw new Error('A 建的 run 没带 hostRecovery 戳,桌面形态的盖戳失效了');
  delete input.hostRecovery;
  db.prepare('UPDATE agent_runs SET input = ? WHERE id = ?').run(JSON.stringify(input), runId);
}, { write: true });

// 每个场景:工具命令、怎么停 A、停之前做什么、期望的结局
const SPECS = {
  crash: { cmd: 'echo SIDE >> side-effect.log', stop: 'SIGKILL', reason: 'crash', resume: true },
  sigterm: { cmd: 'echo SIDE >> side-effect.log', stop: 'SIGTERM', reason: 'engine_stop', resume: false, drained: true },
  intent: { cmd: 'echo SIDE >> side-effect.log', stop: 'SIGTERM', reason: 'app_update', resume: true, drained: true, intent: 'app_update' },
  // 命令写完副作用就 sleep:kill 时工具还在跑(在飞记录 = started);孤儿 sleep 自己会退
  midtool: { cmd: 'echo SIDE >> side-effect.log; sleep 8', stop: 'SIGKILL', reason: 'crash', resume: true, midTool: true },
  tui: { cmd: 'echo SIDE >> side-effect.log', stop: 'SIGKILL', reason: 'crash', resume: false, tui: true },
  cross: { cmd: 'echo SIDE >> side-effect.log', stop: null },
};

async function scenario(kind) {
  const spec = SPECS[kind];
  if (!spec) throw new Error(`未知场景 ${kind}`);
  const home = mkdtempSync(join(tmpdir(), `tangu-r2-${kind}-`));
  const work = join(home, 'work');
  mkdirSync(work);
  const sideLines = () => (existsSync(join(work, 'side-effect.log')) ? readFileSync(join(work, 'side-effect.log'), 'utf8').split('\n').filter(Boolean).length : 0);
  const intentFile = join(home, 'shutdown-intent.json');
  const mock = await startMock(spec.cmd);
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
    if (spec.midTool) await waitFor(() => sideLines() >= 1, 30_000, 'A 开始执行工具(副作用已写)');
    else await waitFor(() => mock.stats.afterTool >= 1 && sideLines() >= 1, 30_000, 'A 执行完工具、第二轮请求挂住');
    if (spec.tui) stripHostRecovery(home, runId);
    const before = { firstTurn: mock.stats.firstTurn, side: sideLines(), row: runRow(home, runId) };

    if (spec.intent) writeFileSync(intentFile, JSON.stringify({ reason: spec.intent, pid: A.child.pid, at: Date.now() }));
    if (spec.stop) { A.child.kill(spec.stop); await A.exited; }
    const atRestart = runRow(home, runId);

    const B = startEngine(home, provFile, 'B');
    engines.push(B);
    await waitHealth(B);
    // B 的启动自愈是异步的:等到结局落定(该续的续完、不该续的盖上认领),最多 20s;cross 没有结局可等,固定等 6s
    const settled = () => {
      const row = runRow(home, runId);
      if (!row?.resumed_by) return false;
      return !spec.resume || otherRuns(home, runId).some((x) => x.status === 'done');
    };
    if (kind === 'cross') await sleep(6000);
    else await waitFor(settled, 20_000, 'B 的启动恢复落定').catch(() => {});
    await sleep(500); // 让续跑收尾后的旁路请求 / 副作用(若有)有机会冒出来
    const after = { firstTurn: mock.stats.firstTurn, side: sideLines(), row: runRow(home, runId) };
    const cont = otherRuns(home, runId);
    const notices = noticeRows(home, runId);

    const fails = [];
    if (after.firstTurn > before.firstTurn) fails.push('从头重跑');
    if (after.side > before.side) fails.push('副作用重复');
    if (kind === 'cross') {
      if (after.row?.status !== 'running') fails.push(`A 的在飞 run 被 B 动了(${after.row?.status})`);
    } else {
      const want = `interrupted:${spec.reason}`;
      if (spec.drained && !(atRestart?.status === 'interrupted' && atRestart?.error === want)) fails.push(`A 退出前没落成 ${want}`);
      if (!(after.row?.status === 'interrupted' && after.row?.error === want)) fails.push(`原 run 不是 ${want}`);
      if (spec.resume) {
        const c = cont.find((x) => x.input?.trigger === 'recovery');
        if (!c) fails.push('没有自动续跑');
        else {
          if (c.status !== 'done') fails.push(`续跑没跑完(${c.status} ${c.error || ''})`);
          if (c.input.resumeOf !== runId) fails.push('续跑的 resumeOf 不指原 run');
          if (after.row?.resumed_by !== c.id) fails.push('原 run 的 resumed_by 不是续跑 id');
        }
        if (cont.length !== 1) fails.push(`会话里多出 ${cont.length} 条 run(应只有 1 条续跑)`);
        if (mock.stats.resume !== 1) fails.push(`续跑请求 ${mock.stats.resume} 次(应 1 次)`);
        if (spec.midTool && !mock.stats.resumeToolTexts.some((t) => t.startsWith('[Outcome unknown'))) fails.push('回放给续跑的结果不是 Outcome unknown');
      } else {
        if (cont.length) fails.push(`不该续却建了 ${cont.length} 条 run`);
        if (after.row?.resumed_by !== '-') fails.push(`resumed_by 应为 '-'(${after.row?.resumed_by})`);
        if (!notices.some((n) => n.includes(`[reason: ${spec.reason}]`))) fails.push('没有中断说明行');
      }
      if (spec.intent && existsSync(intentFile)) fails.push('意图文件没被删');
    }

    console.log(`\n[${kind}] run=${runId}`);
    console.log(`  A 在飞时:首轮请求 ${before.firstTurn} 次,副作用 ${before.side} 行,行状态 ${JSON.stringify(before.row)}`);
    console.log(`  B 起来前:行状态 ${JSON.stringify(atRestart)}`);
    console.log(`  B 起来后:首轮请求 ${after.firstTurn} 次,副作用 ${after.side} 行,行状态 ${JSON.stringify(after.row)}`);
    console.log(`  续跑:${JSON.stringify(cont.map((x) => ({ id: x.id, status: x.status, trigger: x.input?.trigger, resumeOf: x.input?.resumeOf, resumeAttempt: x.input?.resumeAttempt })))};续跑请求 ${mock.stats.resume} 次;说明行 ${notices.length} 条`);
    if (mock.stats.resumeToolTexts.length) console.log(`  回放给续跑的工具结果:${mock.stats.resumeToolTexts.map((t) => JSON.stringify(t.slice(0, 80))).join(' | ')}`);
    const bLog = B.logs.join('').split('\n').filter((l) => /re-enqueued|stale|recover|interrupted|resum/i.test(l));
    if (bLog.length) console.log(`  B 日志:${bLog.slice(0, 6).join(' | ')}`);
    console.log(`  ${fails.length ? `FAIL  ${fails.join(';')}` : 'OK'}`);
    return !fails.length;
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
