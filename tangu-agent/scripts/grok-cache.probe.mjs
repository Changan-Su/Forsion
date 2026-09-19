#!/usr/bin/env node
/**
 * grok(xai OAuth → cli-chat-proxy.grok.com)前缀缓存探针。两件事,各自 A/B:
 *   ① 路由粘性:同前缀背靠背两发,看第二发 cached。四组:无键 / x-grok-conv-id 头 / chat body prompt_cache_key /
 *      /v1/responses + prompt_cache_key(官方 CLI 走的那条)。
 *   ② 末轮归因:同一 conv-id 预热后,对照(带 tools)/ 剥 tools(agentLoop 末轮现状)/ 保留 tools + tool_choice:none。
 * 09-19 实测(每组 7 对):第二发命中 无键 4/7、conv-id 头 4/7、chat body key 5/7、responses+key 5/7,
 * 组间无差异,没有一组接近 xAI 文档「带亲和 ~99%」—— api.x.ai 的 x-grok-conv-id 在 cli-chat-proxy 上看不出效果,
 * 续发约 1/3 整次 miss,客户端无解。对照命中的可判轮次里:剥 tools 3/3 整段 miss(含 muse 台架末轮),
 * tools + none 2/2 全命中。cached ≤128 一律算 miss(128 是恒在的公共块)。
 * ⚠️ 不带 stream_options.include_usage 时 proxy 不回 usage —— 引擎计量会退回估算且 cacheReported=false。
 *
 *   npm run build && node scripts/grok-cache.probe.mjs [--pairs 5] [--model grok-4.6] [--auth <provider-auth.json>]
 * 凭证只读(缺省 ~/.forsion-dev/provider-auth.json):不刷新、不回写、不打印 token。每发 ~5.5k prompt token。
 */
import { readFileSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { buildGrokBuildHeaders } from '../dist/llm/grokBuildCompat.js';

const argv = process.argv.slice(2);
const opt = (name, def) => { const i = argv.indexOf(`--${name}`); return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : def; };
const AUTH = opt('auth', join(homedir(), '.forsion-dev', 'provider-auth.json'));
if (realpathSync(AUTH).startsWith(join(homedir(), '.forsion') + '/') && !argv.includes('--allow-production-auth')) { console.error(`--auth 指向生产共享域 ${AUTH};要用它请显式加 --allow-production-auth`); process.exit(2); }
const xai = (() => { const c = JSON.parse(readFileSync(AUTH, 'utf8')); return (c.providers || c).xai; })();
if (!xai?.access_token) { console.error(`${AUTH} 里没有 xai 登录`); process.exit(2); }
if (xai.expires_at && xai.expires_at < Date.now() + 60_000) { console.error('xai token 已过期:起一次 dev 引擎让它刷新,本探针不回写凭证'); process.exit(2); }
const TOKEN = xai.access_token;
const BASE = String(xai.baseUrl).replace(/\/+$/, '');
const MODEL = opt('model', 'grok-4.6');
const PAIRS = Number(opt('pairs', 5));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ~2.4k token 稳定系统提示 + ~3k token 工具面:远大于 128 块粒度。
const sysBody = Array.from({ length: 60 }, (_, i) =>
  `Rule ${i + 1}: When handling task category ${i + 1}, prefer deterministic, well-documented steps; record the outcome, verify assumptions against primary sources, and keep the user informed briefly.`).join('\n');
const fn = (i) => ({
  name: `probe_tool_${i + 1}`,
  description: `Probe tool number ${i + 1}. ` + 'It reads structured records from the local store, filters them by the given criteria, and returns a compact JSON summary. '.repeat(6),
  parameters: { type: 'object', properties: { query: { type: 'string', description: 'Free-text filter applied to record titles and bodies.' }, limit: { type: 'number', description: 'Maximum number of records to return.' } }, required: ['query'] },
});
const chatTools = Array.from({ length: 12 }, (_, i) => ({ type: 'function', function: fn(i) }));
const respTools = Array.from({ length: 12 }, (_, i) => ({ type: 'function', ...fn(i) }));
const convo = (nonce, turn2) => [
  { role: 'system', content: `Session ${nonce}.\n${sysBody}` },
  { role: 'user', content: 'Do not call any tool. Reply with exactly: OK' },
  ...(turn2 ? [{ role: 'assistant', content: 'OK' }, { role: 'user', content: 'Do not call any tool. Reply with exactly: OK again' }] : []),
];

async function events(res) {
  if (!res.ok) throw new Error(`HTTP ${res.status} ${(await res.text()).slice(0, 200)}`);
  return (await res.text()).split('\n').map((l) => l.trim()).filter((l) => l.startsWith('data:') && l.slice(5).trim() !== '[DONE]')
    .map((l) => { try { return JSON.parse(l.slice(5)); } catch { return null; } }).filter(Boolean);
}

/** 一发请求 → { prompt, cached }。o: { endpoint: 'chat'|'responses', convId, key, tools: true|false, toolChoice } */
async function call(nonce, turn2, o = {}) {
  const headers = { 'Content-Type': 'application/json', Authorization: `Bearer ${TOKEN}`, ...buildGrokBuildHeaders(TOKEN, MODEL) };
  if (o.convId) headers['x-grok-conv-id'] = o.convId;
  const withTools = o.tools !== false;
  const toolChoice = o.toolChoice === undefined ? 'auto' : o.toolChoice;
  if (o.endpoint === 'responses') {
    const body = { model: MODEL, input: convo(nonce, turn2), stream: true, store: false, reasoning: { effort: 'low' }, ...(withTools ? { tools: respTools, tool_choice: toolChoice } : {}), ...(o.key ? { prompt_cache_key: o.key } : {}) };
    const evs = await events(await fetch(`${BASE}/responses`, { method: 'POST', headers, body: JSON.stringify(body), signal: AbortSignal.timeout(180_000) }));
    const u = evs.find((e) => e.type === 'response.completed')?.response?.usage;
    return { prompt: u?.input_tokens, cached: u?.input_tokens_details?.cached_tokens };
  }
  // 与引擎真实 wire 一致:include_usage 必带(buildOpenAiCompatPayload 放的 stream_options 经 `...clean` 上 wire)。
  const body = { model: MODEL, messages: convo(nonce, turn2), temperature: 0.7, stream: true, stream_options: { include_usage: true }, reasoning_effort: 'low', ...(withTools ? { tools: chatTools, ...(toolChoice ? { tool_choice: toolChoice } : {}) } : {}), ...(o.key ? { prompt_cache_key: o.key } : {}) };
  const u = (await events(await fetch(`${BASE}/chat/completions`, { method: 'POST', headers, body: JSON.stringify(body), signal: AbortSignal.timeout(180_000) }))).map((e) => e.usage).filter(Boolean).pop();
  return { prompt: u?.prompt_tokens, cached: u?.prompt_tokens_details?.cached_tokens };
}

const hit = (r) => (r.cached || 0) > 128 && (r.cached || 0) >= 0.5 * (r.prompt || 1);
const fmt = (r) => `prompt ${r.prompt ?? '?'} cached ${r.cached ?? '(没报)'}${hit(r) ? ' HIT' : ''}`;

console.log(`# grok 前缀缓存探针  model ${MODEL}  ${new URL(BASE).host}  每组 ${PAIRS} 对`);
const GROUPS = {
  'no key': () => ({}),
  'x-grok-conv-id': () => ({ convId: randomUUID() }),
  'chat body prompt_cache_key': () => ({ key: randomUUID() }),
  'responses + prompt_cache_key': () => ({ endpoint: 'responses', key: randomUUID() }),
};
const tally = Object.fromEntries(Object.keys(GROUPS).map((g) => [g, 0]));
for (let i = 1; i <= PAIRS; i++) {
  for (const [g, mk] of Object.entries(GROUPS)) { // 各组交错跑,摊掉时段性的负载差
    const o = mk(), nonce = randomUUID();
    const r1 = await call(nonce, false, o);
    await sleep(1500); // 模拟两发之间的工具执行间隙
    const r2 = await call(nonce, true, o);
    if (hit(r2)) tally[g]++;
    console.log(`${g} #${i}: first ${fmt(r1)} | second ${fmt(r2)}`);
  }
}
console.log('\n## ① 第二发命中(粘性生效应接近 100%)');
for (const [g, n] of Object.entries(tally)) console.log(`${g.padEnd(30)} ${n}/${PAIRS}`);

console.log('\n## ② 末轮归因(同一 x-grok-conv-id;对照 miss 时本轮其余几行不可判)');
const nonce = randomUUID(), convId = randomUUID();
for (const [label, o, turn2] of [['warm', {}, false], ['ctrl tools+auto', {}, true], ['tools stripped', { tools: false }, true], ['tools + tool_choice:none', { toolChoice: 'none' }, true]]) {
  console.log(`${label.padEnd(26)} ${fmt(await call(nonce, turn2, { convId, ...o }))}`);
  await sleep(1500);
}
