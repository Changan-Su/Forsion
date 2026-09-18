/**
 * 改名即生效 · 离线接线证据(不烧额度):真 standalone 引擎 × 本地假 OpenAI 兼容端点,截获发给模型的系统提示词。
 * 同一会话:建 Nova → 跑一轮 → PATCH 改名 Orion + 改简介 → 再跑一轮,断言第二轮系统提示词带新名字 / 简介的身份段。
 * 只证「提示词接线」;模型配不配合(真会自称新名)看 live:`npm run live:harness -- --only rename`。
 *
 *   cd tangu-agent && npm run build && node scripts/rename-identity.smoke.mjs
 */
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { createServer as netServer } from 'node:net';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import assert from 'node:assert/strict';

const entry = join(dirname(fileURLToPath(import.meta.url)), '..', 'dist', 'standalone', 'main.js');
const TOKEN = randomUUID();
const freePort = () => new Promise((r) => { const s = netServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)); }); });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const textOf = (c) => (typeof c === 'string' ? c : Array.isArray(c) ? c.map((x) => x?.text || '').join('') : '');

// 假模型:记下每个请求,流式 / 非流式都答一句 ok。
const seen = [];
const fake = createServer(async (req, res) => {
  let raw = ''; for await (const c of req) raw += c;
  let body = {}; try { body = JSON.parse(raw); } catch { /* ignore */ }
  seen.push(body);
  if (!req.url.endsWith('/chat/completions')) { res.writeHead(404); res.end(); return; }
  const usage = { prompt_tokens: 10, completion_tokens: 1, total_tokens: 11 };
  if (!body.stream) { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ id: 'c', object: 'chat.completion', choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }], usage })); return; }
  res.writeHead(200, { 'Content-Type': 'text/event-stream' });
  res.write(`data: ${JSON.stringify({ id: 'c', object: 'chat.completion.chunk', choices: [{ index: 0, delta: { role: 'assistant', content: 'ok' }, finish_reason: null }] })}\n\n`);
  res.write(`data: ${JSON.stringify({ id: 'c', object: 'chat.completion.chunk', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage })}\n\n`);
  res.end('data: [DONE]\n\n');
});
const fakePort = await freePort();
await new Promise((r) => fake.listen(fakePort, '127.0.0.1', r));

const home = mkdtempSync(join(tmpdir(), 'tangu-rename-smoke-'));
const port = await freePort();
let log = '';
const child = spawn(process.execPath, [entry, '--port', String(port), '--host', '127.0.0.1', '--data-dir', join(home, 'state.db'), '--sandbox', 'auto',
  '--cloud-url', 'http://127.0.0.1:9', '--token', TOKEN,
  '--provider', 'fake', '--provider-base-url', `http://127.0.0.1:${fakePort}/v1`, '--provider-api-key', 'x', '--provider-models', 'm1'],
{ env: { ...process.env, TANGU_HOME: home }, stdio: ['ignore', 'pipe', 'pipe'] });
child.stdout.on('data', (d) => { log += d; }); child.stderr.on('data', (d) => { log += d; });
const base = `http://127.0.0.1:${port}`;
const api = async (p, init = {}) => {
  const r = await fetch(base + p, { ...init, headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' } });
  const body = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`${init.method || 'GET'} ${p} → ${r.status} ${JSON.stringify(body).slice(0, 200)}`);
  return body;
};
/** 发一轮并等到 done / error(只要跑完,正文由假模型给)。 */
async function run(sessionId, message, agentSlug) {
  const { runId } = await api('/agent/runs', { method: 'POST', body: JSON.stringify({ session_id: sessionId, model_id: 'fake/m1', message, agent_config: { agentSlug } }) });
  const res = await fetch(`${base}/agent/runs/${runId}/events`, { headers: { Authorization: `Bearer ${TOKEN}` }, signal: AbortSignal.timeout(60_000) });
  let buf = '';
  for await (const chunk of res.body) {
    buf += Buffer.from(chunk).toString('utf8');
    for (const line of buf.split('\n')) {
      if (!line.startsWith('data:')) continue;
      let e; try { e = JSON.parse(line.slice(5).trim()); } catch { continue; }
      if (e.type === 'error') throw new Error(`run error: ${JSON.stringify(e.payload).slice(0, 200)}`);
      if (e.type === 'done') return;
    }
  }
}
/** 该轮(按消息里的标记认)发给模型的系统提示词;Historian 等后台请求不带标记,自然排除。 */
const systemFor = (mark) => {
  const req = seen.find((b) => (b.messages || []).some((m) => m.role === 'user' && textOf(m.content).includes(mark)));
  assert.ok(req, `没截到带 ${mark} 的模型请求`);
  return req.messages.filter((m) => m.role === 'system').map((m) => textOf(m.content)).join('\n');
};

try {
  for (let i = 0; i < 150 && !(await fetch(`${base}/health`).then((r) => r.ok).catch(() => false)); i++) await sleep(200);
  const { agent } = await api('/agent/agents', { method: 'POST', body: JSON.stringify({ name: 'Nova', description: 'General helper', systemPrompt: 'You are Nova, a helpful assistant.' }) });
  const sess = `rename-smoke-${Date.now()}`;
  await run(sess, 'MARK-BEFORE who are you?', agent.slug);
  await api(`/agent/agents/${agent.slug}`, { method: 'PATCH', body: JSON.stringify({ name: 'Orion', description: 'Plans night-sky observation trips' }) });
  await run(sess, 'MARK-AFTER who are you?', agent.slug);
  const before = systemFor('MARK-BEFORE'); const after = systemFor('MARK-AFTER');
  assert.ok(before.includes('- Name: Nova'), '改名前:身份段应点名 Nova');
  assert.ok(after.includes('- Name: Orion'), '改名后:同会话下一轮的系统提示词必须带新名字 Orion');
  assert.ok(after.includes('- Description (shown to the user): Plans night-sky observation trips'), '改名后:身份段必须带新简介');
  assert.ok(after.includes('You are Nova'), '人格正文原样保留(身份段只声明以新名为准,不改用户写的提示词)');
  console.log('PASS 同会话改名 / 改简介后,下一轮发给模型的系统提示词带新身份段(人格正文不动)');
} catch (e) {
  console.error('FAIL', e.message, '\n', log.slice(-1200));
  process.exitCode = 1;
} finally {
  child.kill('SIGTERM'); fake.close();
  await sleep(300); if (child.exitCode === null) child.kill('SIGKILL');
  rmSync(home, { recursive: true, force: true });
}
