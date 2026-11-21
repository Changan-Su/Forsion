/**
 * resume(2026-11-20,中断任务续跑方案 B):引擎在工具执行到一半被强杀,同一个 home 重启后自动接着做,真模型。
 *
 *  A 腿:自己起一台引擎(独立隔离 home,不和主台架那台共库),让真模型按顺序跑三条命令:
 *        ① `echo step-1 >> progress.log && sleep 45`  ② `echo step-2 >> progress.log`  ③ `echo step-3 >> progress.log`
 *        ① 写下 step-1、还在 sleep 时 kill -9 引擎(连同它的子进程)= 崩溃在工具中途。
 *  B 腿:同一个 home、TANGU_AUTO_RESUME=1 重启。启动恢复把原 run 记成 interrupted:crash,自动续一轮(trigger=recovery);
 *        回放给模型的 ① 结果是「Outcome unknown」,模型该先看现状、只补 ② ③,不重跑 ①。
 *
 * 判据(只看磁盘和库,不信模型自述):
 *   - 被杀时那一行助手段里 ① 落着在飞记录 started(边跑边落库);
 *   - 原 run = interrupted:crash,resumed_by 指向续跑;续跑 input.trigger = recovery、resumeOf = 原 run,跑到 done;
 *   - progress.log 最后恰好是 step-1 / step-2 / step-3 各一行、按顺序(重跑 ① 会多一行 step-1)。
 * 负对照:`--resume-off` 让 B 以 TANGU_AUTO_RESUME=0 起 → 没有续跑、只有中断说明行,本场景须红。
 * 凭证:每次起引擎前把 provider-auth.json 软链进隔离共享域,模型目录里出现目标模型就拆掉(同主台架)。
 */
import { execFileSync, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { appendFileSync, copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { join } from 'node:path';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const freePort = () => new Promise((r) => { const s = createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)); }); });
const TERMINAL = new Set(['done', 'failed', 'aborted', 'interrupted']);

/** 引擎和它所有子孙进程(run_bash 起的 bash / sleep):强杀要连根拔,否则孤儿进程之后还可能写文件,判据失真。 */
function descendants(pid) {
  const out = [];
  const walk = (p) => {
    let kids = [];
    try { kids = execFileSync('pgrep', ['-P', String(p)], { encoding: 'utf8' }).split('\n').map(Number).filter(Boolean); } catch { /* 没有子进程 / 没有 pgrep(Windows) */ }
    for (const k of kids) { out.push(k); walk(k); }
  };
  walk(pid);
  return out;
}

export async function resumeLive({ entry, AUTH, MODEL, OUT, SANDBOX = 'auto', argv = [] }) {
  const off = argv.includes('--resume-off');
  const Database = createRequire(import.meta.url)('better-sqlite3');
  const root = join(OUT, 'resume-home');
  const shared = join(root, 'forsion');
  const home = join(shared, 'tangu'); // basename 必须是 tangu:共享域才会落到 forsion/,provider-auth.json 从那里读
  const work = join(root, 'workspace');
  const ev = join(OUT, 'resume-evidence');
  mkdirSync(home, { recursive: true }); mkdirSync(work, { recursive: true }); mkdirSync(ev, { recursive: true });
  const authLink = join(shared, 'provider-auth.json');
  const TOKEN = randomUUID();
  const sessionId = `live-resume-${Date.now()}`;
  const progress = join(work, 'progress.log');
  const lines = () => (existsSync(progress) ? readFileSync(progress, 'utf8').split('\n').map((s) => s.trim()).filter(Boolean) : []);
  const db = (fn) => { const d = new Database(join(home, 'state.db'), { readonly: true, fileMustExist: true }); try { d.pragma('busy_timeout = 5000'); return fn(d); } finally { d.close(); } };
  const parse = (s) => { try { return JSON.parse(s || 'null'); } catch { return null; } };

  const engines = [];
  async function start(name, env) {
    rmSync(authLink, { force: true });
    symlinkSync(AUTH, authLink);
    const port = await freePort();
    const log = join(ev, `engine-${name}.log`);
    const child = spawn(process.execPath, [
      entry, '--port', String(port), '--host', '127.0.0.1', '--data-dir', join(home, 'state.db'),
      '--sandbox', SANDBOX, '--cloud-url', 'http://127.0.0.1:9', '--token', TOKEN,
    ], { env: {
      ...process.env, TANGU_HOME: home, TANGU_DEFAULT_WORKSPACE: work, TANGU_BROWSER_CDP: 'off', TANGU_BROWSER_EXTENSION: '0',
      FORSION_DESKTOP_CONFIG: join(root, 'userData', 'tangu-desktop-config.json'), ...env,
    }, stdio: ['ignore', 'pipe', 'pipe'] });
    child.stdout.on('data', (d) => appendFileSync(log, d));
    child.stderr.on('data', (d) => appendFileSync(log, d));
    const e = { name, port, child, exited: new Promise((r) => child.once('exit', r)), base: `http://127.0.0.1:${port}` };
    engines.push(e);
    try {
      for (let i = 0; ; i++) {
        if (child.exitCode !== null) throw new Error(`引擎 ${name} 起不来(code ${child.exitCode}):${readFileSync(log, 'utf8').slice(-600)}`);
        const models = await fetch(`${e.base}/agent/models`, { headers: { Authorization: `Bearer ${TOKEN}` } }).then((r) => (r.ok ? r.json() : null)).catch(() => null);
        const list = Array.isArray(models) ? models : models?.models || [];
        if (list.some((m) => m.id === MODEL)) break;
        if (i > 120) throw new Error(`引擎 ${name} 60s 内模型目录里没有 ${MODEL}(凭证没装上?)`);
        await sleep(500);
      }
    } finally { rmSync(authLink, { force: true }); } // 凭证只在启动时装载一次
    return e;
  }

  try {
    // ── A 腿:跑到 ① 的 sleep 里 ──
    const A = await start('A', {});
    const message = '请在当前工作目录里按顺序执行下面三条 shell 命令。每条单独用一次 run_bash,上一条结束后再执行下一条,命令原样照抄,不要改写、不要合并:\n'
      + '1. `echo step-1 >> progress.log && sleep 45`\n2. `echo step-2 >> progress.log`\n3. `echo step-3 >> progress.log`\n'
      + '三条都执行完后,用 `cat progress.log` 看一下文件内容,回复「完成」并附上文件内容。';
    const r = await fetch(`${A.base}/agent/runs`, {
      method: 'POST', headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ session_id: sessionId, model_id: MODEL, message, agent_config: { execMode: 'host', approvalMode: 'full-auto', cwd: work } }),
    }).then((x) => x.json());
    const runId = r.runId;
    if (!runId) throw new Error(`建 run 失败:${JSON.stringify(r).slice(0, 200)}`);
    for (let t = 0; !lines().includes('step-1'); t += 500) {
      const st = db((d) => d.prepare('SELECT status, error FROM agent_runs WHERE id = ?').get(runId));
      if (TERMINAL.has(st?.status)) throw new Error(`① 还没写下 step-1,run 已经结束(${st.status} ${st.error || ''})—— 模型没照做`);
      if (t > 240_000) throw new Error('240s 内 progress.log 里没出现 step-1');
      await sleep(500);
    }
    await sleep(1500); // 落在 ① 的 sleep 里
    const victims = [A.child.pid, ...descendants(A.child.pid)];
    for (const p of victims) try { process.kill(p, 'SIGKILL'); } catch { /* 已退出 */ }
    await A.exited;
    const atKill = {
      lines: lines(),
      row: db((d) => d.prepare('SELECT status, error FROM agent_runs WHERE id = ?').get(runId)),
      inflight: db((d) => d.prepare(`SELECT tool_results FROM chat_messages WHERE session_id = ? AND role <> 'user' ORDER BY timestamp DESC LIMIT 1`).get(sessionId))?.tool_results,
    };
    const inflightEntries = (parse(atKill.inflight) || []).filter((x) => x && x.inflight);
    const startedAtKill = inflightEntries.some((x) => x.inflight.state === 'started');

    // ── B 腿:同一个 home 重启 ──
    const B = await start('B', { TANGU_AUTO_RESUME: off ? '0' : '1' });
    const settle = () => db((d) => {
      const orig = d.prepare('SELECT status, error, resumed_by FROM agent_runs WHERE id = ?').get(runId);
      const others = d.prepare('SELECT id, status, error, input, assistant_message_id FROM agent_runs WHERE session_id = ? AND id <> ? ORDER BY created_at').all(sessionId, runId)
        .map((x) => ({ ...x, input: parse(x.input) || {} }));
      return { orig, others };
    });
    let s = settle();
    for (let t = 0; t < 360_000; t += 1000) {
      s = settle();
      if (s.orig?.resumed_by === '-') break; // 没续(负对照 / 门控没过)
      const c = s.others.find((x) => x.input.trigger === 'recovery');
      if (c && TERMINAL.has(c.status)) break;
      await sleep(1000);
    }
    const cont = s.others.find((x) => x.input.trigger === 'recovery') || null;
    const contCalls = cont ? db((d) => d.prepare(`SELECT payload FROM agent_run_events WHERE run_id = ? AND type = 'tool_call' ORDER BY created_at, rowid`).all(cont.id))
      .map((x) => parse(x.payload)).filter(Boolean).map((p) => `${p.name}: ${String(typeof p.arguments === 'string' ? p.arguments : JSON.stringify(p.arguments ?? '')).slice(0, 160)}`) : [];
    const finalText = db((d) => d.prepare(`SELECT content FROM chat_messages WHERE session_id = ? AND role <> 'user' ORDER BY timestamp DESC LIMIT 1`).get(sessionId))?.content || '';
    const notices = db((d) => d.prepare(`SELECT content FROM chat_messages WHERE session_id = ? AND role = 'user' AND content LIKE '<turn_interrupted>%'`).all(sessionId)).map((x) => x.content);
    const endLines = lines();
    if (existsSync(progress)) copyFileSync(progress, join(ev, 'progress.log'));

    const linesOk = JSON.stringify(endLines) === JSON.stringify(['step-1', 'step-2', 'step-3']);
    const checks = {
      startedAtKill,
      interruptedCrash: s.orig?.status === 'interrupted' && s.orig?.error === 'interrupted:crash',
      resumed: !!cont && s.orig?.resumed_by === cont.id && cont.input.resumeOf === runId,
      contDone: cont?.status === 'done',
      linesOk,
    };
    const ok = Object.values(checks).every(Boolean);
    writeFileSync(join(OUT, 'resume-evidence.json'), JSON.stringify({ off, runId, atKill: { ...atKill, inflightEntries }, orig: s.orig, cont, contCalls, notices, endLines, finalText, checks }, null, 2));
    const detail = `${off ? '负对照(B 以 TANGU_AUTO_RESUME=0 起)' : '正式'}:被杀时 ① ${startedAtKill ? 'started 已落库' : '没有 started 记录'};原 run ${s.orig?.status}/${s.orig?.error || '-'} resumed_by=${s.orig?.resumed_by || '-'};`
      + `续跑 ${cont ? `${cont.status}(trigger=${cont.input.trigger},attempt ${cont.input.resumeAttempt})` : '无'};续跑里的调用 ${contCalls.length} 次;`
      + `progress.log = ${JSON.stringify(endLines)}${linesOk ? '' : '(应恰好 step-1/2/3 各一行)'};说明行 ${notices.length} 条`;
    return { ok, detail, output: `【续跑里的调用】\n${contCalls.join('\n') || '(无)'}\n【最后一条回答】\n${finalText}`, checks };
  } finally {
    rmSync(authLink, { force: true });
    for (const e of engines) {
      if (e.child.exitCode !== null || e.child.signalCode) continue;
      e.child.kill('SIGTERM');
      await Promise.race([e.exited, sleep(6000)]);
      if (e.child.exitCode === null && !e.child.signalCode) { e.child.kill('SIGKILL'); await e.exited; }
    }
  }
}
