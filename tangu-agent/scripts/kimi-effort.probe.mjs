#!/usr/bin/env node
/**
 * Kimi K3 系 × 思考档位 / reasoning_content 回传实测探针 —— 能力表的 dashscope-kimi-k3 / gateway-kimi-k3 / moonshot-k3
 * 三条规则是按官方文档写的,网关(百炼 / 硅基)实际收不收,用这个读出来。
 * 走编译产物的真函数:applyThinking 出每档 payload,compatWireMessages 出工具续轮的 messages。
 *
 * 用法(在 Forsion-Genesis/tangu-agent 下先 npm run build):
 *   KIMI_BASE=https://dashscope.aliyuncs.com/compatible-mode/v1 KIMI_KEY=sk-… \
 *     node scripts/kimi-effort.probe.mjs kimi/kimi-k3.1-pro kimi/kimi-k2.8-preview
 *
 * 每个模型打印:① off/medium/max 三档按能力表实际发出的 reasoning_effort 与上游回包(状态码 / 推理 token);
 * ② 工具续轮:按能力表回传(带 reasoning_content)与负对照(剥掉)各发一次 —— 负对照也 200 说明网关不强制,
 * 但官方要求回传,放行不改。key 只从环境变量读,不打印。
 */
import { pathToFileURL, fileURLToPath } from 'node:url';
import path from 'node:path';

const dist = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'dist');
const { resolveModelCapability, applyThinking } = await import(pathToFileURL(path.join(dist, 'llm/modelCapabilities.js')).href);
const { compatWireMessages } = await import(pathToFileURL(path.join(dist, 'llm/openaiCompat.js')).href);

const BASE = (process.env.KIMI_BASE || '').replace(/\/$/, '');
const KEY = process.env.KIMI_KEY || '';
const models = process.argv.slice(2);
if (!BASE || !KEY || !models.length) { console.error('用法: KIMI_BASE=… KIMI_KEY=… node scripts/kimi-effort.probe.mjs <model...>'); process.exit(2); }

async function post(body) {
  const r = await fetch(`${BASE}/chat/completions`, {
    method: 'POST', headers: { Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  const text = await r.text();
  try { return { status: r.status, json: JSON.parse(text) }; } catch { return { status: r.status, text: text.slice(0, 300) }; }
}
const brief = (res) => res.status === 200
  ? `200 reasoning_tokens=${res.json.usage?.completion_tokens_details?.reasoning_tokens ?? '?'} rc=${(res.json.choices?.[0]?.message?.reasoning_content || '').length}`
  : `${res.status} ${res.text ?? JSON.stringify(res.json).slice(0, 300)}`;

const TOOL = { type: 'function', function: { name: 'add', description: 'Add two integers.', parameters: { type: 'object', properties: { a: { type: 'integer' }, b: { type: 'integer' } }, required: ['a', 'b'] } } };

for (const model of models) {
  const cap = resolveModelCapability({ baseUrl: BASE, modelId: model });
  console.log(`\n== ${model}  rule=${cap.rule}`);
  for (const level of ['off', 'medium', 'max']) {
    const payload = { model, messages: [{ role: 'user', content: 'What is 17*23? Answer with just the number.' }], max_tokens: 4000, temperature: 0.7 };
    applyThinking(payload, level, cap, () => {});
    console.log(`  ${level.padEnd(6)} effort=${payload.reasoning_effort ?? '-'} temperature=${payload.temperature ?? '-'} → ${brief(await post(payload))}`);
  }
  const first = { model, messages: [{ role: 'user', content: 'Use the add tool to compute 1234+4321, then reply with the result.' }], tools: [TOOL], tool_choice: 'auto', max_tokens: 4000 };
  applyThinking(first, 'low', cap, () => {});
  const r1 = await post(first);
  const msg = r1.json?.choices?.[0]?.message;
  if (r1.status !== 200 || !msg?.tool_calls?.length) { console.log(`  工具首轮没调工具:${brief(r1)}`); continue; }
  const call = msg.tool_calls[0];
  const history = [...first.messages, { role: 'assistant', content: msg.content ?? '', reasoning_content: msg.reasoning_content, tool_calls: msg.tool_calls }, { role: 'tool', tool_call_id: call.id, content: '5555' }];
  for (const [label, msgs] of [['按能力表', compatWireMessages({ ...first, messages: history }, { baseUrl: BASE })], ['负对照(剥掉)', history.map(({ reasoning_content: _r, ...m }) => m)]]) {
    console.log(`  续轮 ${label} 回传 rc=${msgs[1].reasoning_content !== undefined} → ${brief(await post({ ...first, messages: msgs }))}`);
  }
}
