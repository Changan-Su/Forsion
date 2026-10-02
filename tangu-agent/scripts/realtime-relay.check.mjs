#!/usr/bin/env node
/**
 * 实时语音中转(services/realtimeVoice.ts)的确定性台架:真 standalone 引擎 × 本地假百炼(TANGU_REALTIME_UPSTREAM)。
 * 真上游复现不了「旁路语音识别听错、实时模型听对」(say 合成的语音太干净),这里按剧本把两边的话分开喂:
 *   A 语音那行听错(「看知识」)、ask_tangu 交来 heard(「贪吃蛇」)→ 库里那行被改正、客户端收到 transcript.corrected、
 *     委派 run 复用这行且带 ephemeralHint(实时模型的理解);
 *   B 通话中打字 → 落库 + 上游收到 user input_text + response.create;
 *   C 模型正说着时打字 → 上游先收到 response.cancel,收线后补 response.create;
 *   D 打字那行不被 heard 改写、委派不带语音提示;通话中 {type:'run'} 换档后委派 run 按新档跑。
 *   E 只差标点 / 空白不算听错,不改那行。
 * 不花额度、不需要模型。用法:npm run build && npm run check:realtime
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, appendFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { WebSocketServer, WebSocket } = require('ws');
const Database = require('better-sqlite3');
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const results = [];
const check = (name, ok, detail = '') => { results.push(!!ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  | ' + detail : ''}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (fn, ms, every = 50) => { const end = Date.now() + ms; for (;;) { const v = await fn(); if (v) return v; if (Date.now() > end) return null; await sleep(every); } };
const freePort = () => new Promise((r) => { const s = createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)); }); });

// ── 假百炼:记下引擎发来的每条事件;response.create 默认立刻 created + done(空)
const fake = { sock: null, got: [], holdNext: false };
const wss = new WebSocketServer({ port: 0, host: '127.0.0.1' });
await new Promise((r) => wss.once('listening', r));
wss.on('connection', (ws) => {
  fake.sock = ws;
  ws.on('message', (d) => {
    const m = JSON.parse(d.toString());
    fake.got.push(m);
    if (m.type === 'session.update') ws.send(JSON.stringify({ type: 'session.updated', session: m.session }));
    if (m.type === 'response.create') {
      ws.send(JSON.stringify({ type: 'response.created', response: { status: 'in_progress', output: [] } }));
      if (fake.holdNext) { fake.holdNext = false; return; } // C:扮「正说着」,等引擎来掐
      ws.send(JSON.stringify({ type: 'response.done', response: { status: 'completed', output: [] } }));
    }
    if (m.type === 'response.cancel') ws.send(JSON.stringify({ type: 'response.done', response: { status: 'cancelled', output: [] } }));
  });
});
const up = (o) => fake.sock.send(JSON.stringify(o));
const fakeUrl = `ws://127.0.0.1:${wss.address().port}/api-ws/v1/realtime`;

// ── 隔离引擎(布局同 live-harness:<out>/forsion/{config.json, tangu/})
const OUT = mkdtempSync(join(tmpdir(), 'tangu-realtime-relay-'));
const shared = join(OUT, 'forsion'), home = join(shared, 'tangu'), workspace = join(OUT, 'workspace');
mkdirSync(home, { recursive: true }); mkdirSync(workspace, { recursive: true });
writeFileSync(join(shared, 'config.json'), JSON.stringify({ providers: [{ providerId: 'bailian', baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1', apiKey: 'sk-fake', modelIds: [] }] }));
const TOKEN = randomUUID(), port = await freePort(), engineLog = join(OUT, 'engine.log');
const child = spawn(process.execPath, [join(root, 'dist', 'standalone', 'main.js'), '--port', String(port), '--host', '127.0.0.1',
  '--data-dir', join(home, 'state.db'), '--sandbox', 'none', '--cloud-url', 'http://127.0.0.1:9', '--token', TOKEN], {
  env: { ...process.env, TANGU_HOME: home, TANGU_DEFAULT_WORKSPACE: workspace, TANGU_REALTIME_UPSTREAM: fakeUrl, TANGU_BROWSER_CDP: 'off', TANGU_BROWSER_EXTENSION: '0',
    FORSION_DESKTOP_CONFIG: join(OUT, 'desktop-config.json') },
  stdio: ['ignore', 'pipe', 'pipe'],
});
child.stdout.on('data', (d) => appendFileSync(engineLog, d));
child.stderr.on('data', (d) => appendFileSync(engineLog, d));
const db = () => new Database(join(home, 'state.db'), { readonly: true, fileMustExist: true });
const rows = (sql, ...a) => { const d = db(); try { return d.prepare(sql).all(...a); } finally { d.close(); } };

let client;
try {
  const ok = await until(() => fetch(`http://127.0.0.1:${port}/health`).then((r) => r.ok).catch(() => false), 30_000, 300);
  if (!ok) throw new Error(`引擎 30s 没起来,见 ${engineLog}`);
  const sid = `relay-${Date.now()}`;
  const fromEngine = [];
  client = new WebSocket(`ws://127.0.0.1:${port}/agent/realtime?token=${TOKEN}`);
  client.on('message', (d, bin) => { if (!bin) fromEngine.push(JSON.parse(d.toString())); });
  await new Promise((r, j) => { client.once('open', r); client.once('error', j); });
  const run0 = { model_id: 'none/none', agent_config: { thinkingLevel: 'medium' } };
  client.send(JSON.stringify({ type: 'start', session_id: sid, model: 'bailian/qwen3.8-omni-flash-realtime', title: 'Voice call', run: run0 }));
  const ready = await until(() => fromEngine.some((m) => m.type === 'ready'), 10_000);
  check('R0 接通(引擎经假上游 session.update → ready)', !!ready && fake.got[0]?.type === 'session.update',
    `tools=${JSON.stringify(fake.got[0]?.session?.tools?.[0]?.parameters?.required)}`);
  const sessionUpdate = fake.got[0]?.session;
  check('R0b ask_tangu 要求交 heard(实时模型听到的原话)', sessionUpdate?.tools?.[0]?.parameters?.required?.includes('heard'));

  // ── A:旁路识别听错,实时模型听对
  up({ type: 'input_audio_buffer.committed', item_id: 'it-1' });
  up({ type: 'conversation.item.input_audio_transcription.completed', item_id: 'it-1', transcript: '帮我做一个看知识的小游戏。' });
  await until(() => rows(`SELECT id FROM chat_messages WHERE session_id = ? AND role = 'user'`, sid).length >= 1, 3000);
  up({ type: 'response.created', response: { status: 'in_progress', output: [] } });
  up({ type: 'response.function_call_arguments.done', name: 'ask_tangu', call_id: 'c-1', arguments: JSON.stringify({ task: '写一个贪吃蛇小游戏', heard: '帮我做一个贪吃蛇的小游戏。' }) });
  up({ type: 'response.done', response: { status: 'completed', output: [{ type: 'function_call' }] } });
  const fixed = await until(() => fromEngine.find((m) => m.type === 'transcript.corrected'), 5000);
  const userRowsA = rows(`SELECT id, content FROM chat_messages WHERE session_id = ? AND role = 'user' ORDER BY timestamp`, sid);
  check('A1 库里那行改成实时模型听到的原话,客户端收到 transcript.corrected(同一行 id)',
    !!fixed && fixed.text === '帮我做一个贪吃蛇的小游戏。' && userRowsA.length === 1 && userRowsA[0].content === fixed.text && userRowsA[0].id === fixed.message_id,
    JSON.stringify({ fixed, userRowsA }));
  const runA = await until(() => rows(`SELECT input FROM agent_runs WHERE session_id = ? ORDER BY created_at`, sid)[0], 5000);
  const inA = runA ? JSON.parse(runA.input) : {};
  check('A2 委派 run 复用这行,且带实时模型的理解(ephemeralHint,不落库)',
    inA.userMessageId === userRowsA[0]?.id && /贪吃蛇小游戏/.test(inA.ephemeralHint || '') && inA.message === '写一个贪吃蛇小游戏',
    JSON.stringify({ userMessageId: inA.userMessageId, hint: (inA.ephemeralHint || '').slice(0, 80) }));
  check('A3 不另写一条「转述任务」用户消息', rows(`SELECT count(*) n FROM chat_messages WHERE session_id = ? AND role = 'user'`, sid)[0].n === 1);
  await until(() => fromEngine.some((m) => m.type === 'tangu.run' && m.status !== 'started'), 15_000); // 假模型的 run 会失败,等它收尾再往下
  await sleep(300);

  // ── B:通话中打字(上游空闲)
  let mark = fake.got.length;
  client.send(JSON.stringify({ type: 'text', text: '一加一等于几？' }));
  const sentB = await until(() => {
    const after = fake.got.slice(mark);
    const item = after.findIndex((m) => m.type === 'conversation.item.create' && m.item?.role === 'user' && m.item?.content?.[0]?.text === '一加一等于几？');
    return item >= 0 && after.slice(item).some((m) => m.type === 'response.create') ? after.map((m) => m.type) : null;
  }, 3000);
  const typedRow = await until(() => rows(`SELECT id FROM chat_messages WHERE session_id = ? AND role = 'user' AND content = ?`, sid, '一加一等于几？')[0], 3000);
  check('B 打的字送进上游(user input_text → response.create)且落库', !!sentB && !!typedRow, JSON.stringify(sentB));

  // ── C:模型正说着时打字 → 先 cancel
  fake.holdNext = true;
  client.send(JSON.stringify({ type: 'text', text: '先停一下' })); // 这句的 response 被扣住 = 「正说着」
  await until(() => fake.got.slice(mark).filter((m) => m.type === 'response.create').length >= 2, 3000);
  mark = fake.got.length;
  client.send(JSON.stringify({ type: 'text', text: '换个话题' }));
  const sentC = await until(() => {
    const t = fake.got.slice(mark).map((m) => m.type);
    const c = t.indexOf('response.cancel'), r = t.indexOf('response.create');
    return c >= 0 && r > c ? t : null;
  }, 3000);
  check('C 模型正说着时打字:先 response.cancel,收线后再 response.create', !!sentC, JSON.stringify(sentC || fake.got.slice(mark).map((m) => m.type)));

  // ── D:打字那行不被 heard 改写;换档后的委派按新档
  client.send(JSON.stringify({ type: 'run', run: { model_id: 'none/none', agent_config: { thinkingLevel: 'low' } } }));
  await sleep(200);
  const nFixBefore = fromEngine.filter((m) => m.type === 'transcript.corrected').length;
  up({ type: 'response.created', response: { status: 'in_progress', output: [] } });
  up({ type: 'response.function_call_arguments.done', name: 'ask_tangu', call_id: 'c-2', arguments: JSON.stringify({ task: '换一个话题聊', heard: '完全不同的一句话' }) });
  up({ type: 'response.done', response: { status: 'completed', output: [{ type: 'function_call' }] } });
  const runD = await until(() => rows(`SELECT input FROM agent_runs WHERE session_id = ? ORDER BY created_at`, sid)[1], 5000);
  const inD = runD ? JSON.parse(runD.input) : {};
  const typedKept = rows(`SELECT content FROM chat_messages WHERE session_id = ? AND role = 'user' AND content = ?`, sid, '换个话题').length === 1;
  check('D1 打字那行原样保留、不发 transcript.corrected、委派不带语音提示',
    typedKept && fromEngine.filter((m) => m.type === 'transcript.corrected').length === nFixBefore && !inD.ephemeralHint,
    JSON.stringify({ typedKept, hint: inD.ephemeralHint || null }));
  check('D2 通话中 {type:run} 换档后,委派 run 按新档(low)', inD.agentConfig?.thinkingLevel === 'low', `thinkingLevel=${inD.agentConfig?.thinkingLevel}`);

  // ── E:只差标点不算听错(实测实时模型常省掉句末句号),不改那行
  await until(() => fromEngine.filter((m) => m.type === 'tangu.run' && m.status !== 'started').length >= 2, 15_000);
  up({ type: 'input_audio_buffer.committed', item_id: 'it-2' });
  up({ type: 'conversation.item.input_audio_transcription.completed', item_id: 'it-2', transcript: '帮我看一下工作目录。' });
  await until(() => rows(`SELECT id FROM chat_messages WHERE session_id = ? AND content = ?`, sid, '帮我看一下工作目录。')[0], 3000);
  const nFixE = fromEngine.filter((m) => m.type === 'transcript.corrected').length;
  up({ type: 'response.created', response: { status: 'in_progress', output: [] } });
  up({ type: 'response.function_call_arguments.done', name: 'ask_tangu', call_id: 'c-3', arguments: JSON.stringify({ task: '列出工作目录', heard: '帮我看一下 工作目录' }) });
  up({ type: 'response.done', response: { status: 'completed', output: [{ type: 'function_call' }] } });
  await until(() => rows(`SELECT input FROM agent_runs WHERE session_id = ? ORDER BY created_at`, sid)[2], 5000);
  check('E 只差标点/空白:那行原样保留、不发 transcript.corrected',
    rows(`SELECT id FROM chat_messages WHERE session_id = ? AND content = ?`, sid, '帮我看一下工作目录。').length === 1 && fromEngine.filter((m) => m.type === 'transcript.corrected').length === nFixE);
} catch (e) {
  check('台架异常', false, String(e?.stack || e));
} finally {
  try { client?.close(); } catch { /* ignore */ }
  child.kill('SIGTERM');
  wss.close();
}
console.log(`\n${results.filter(Boolean).length}/${results.length} 通过;产物 ${OUT}`);
process.exit(results.length && results.every(Boolean) ? 0 : 1);
