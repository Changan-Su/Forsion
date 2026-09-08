#!/usr/bin/env node
/**
 * 孤儿 tool_use / tool_call 实测探针 —— 直接调 Forsion 三条真适配器(dist 产物),
 * 验证「历史里的 tool_call 引用了本次 tools 数组里没有的工具」在各端点上的行为。
 *
 * 用法(在 Forsion-Genesis/tangu-agent 下先 npm run build):
 *   ANTHROPIC_API_KEY=... \
 *   OPENAI_API_KEY=... \
 *   COMPAT_API_KEY=... COMPAT_BASE_URL=https://api.siliconflow.cn/v1 COMPAT_MODEL=deepseek-ai/DeepSeek-V3 \
 *   node scripts/orphan-toolcall-probe.mjs
 *
 * 只打印 HTTP 状态 + 错误正文,绝不打印 key。缺哪条 key 就跳过哪条路径。
 */
import { pathToFileURL, fileURLToPath } from 'node:url';
import path from 'node:path';

const DIST = process.env.TANGU_DIST
  || path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../dist');
const imp = (p) => import(pathToFileURL(path.join(DIST, p)).href);

const { streamAnthropicMessages } = await imp('llm/anthropicMessages.js');
const { streamOpenAiResponses } = await imp('llm/openaiResponses.js');
const { streamOpenAiCompat } = await imp('llm/openaiCompat.js');

const TOOL_A = {
  type: 'function',
  function: { name: 'tool_a', description: 'echo', parameters: { type: 'object', properties: { s: { type: 'string' } } } },
};

/** OpenAI 形态历史:一轮 tool_call + 可选 tool 结果。 */
function history({ callName, withResult }) {
  const msgs = [
    { role: 'system', content: 'You are a test harness. Answer with one short sentence.' },
    { role: 'user', content: 'Please call a tool.' },
    {
      role: 'assistant',
      content: '',
      tool_calls: [{ id: 'call_probe_1', type: 'function', function: { name: callName, arguments: '{"s":"hi"}' } }],
    },
  ];
  if (withResult) msgs.push({ role: 'tool', tool_call_id: 'call_probe_1', content: 'ok' });
  msgs.push({ role: 'user', content: 'Now just say DONE.' });
  return msgs;
}

// S1 对照组 / S2 工具名不在 tools / S3 缺 tool_result / S4 整个 tools 缺席(=Forsion lastIter 现网路径)
const SCENARIOS = [
  { id: 'S1 baseline(名字在 tools + 有结果)', callName: 'tool_a', withResult: true, tools: [TOOL_A] },
  { id: 'S2 orphan-name(工具已被移出 tools)', callName: 'tool_x_removed', withResult: true, tools: [TOOL_A] },
  { id: 'S3 missing-result(有 tool_call 无 tool_result)', callName: 'tool_a', withResult: false, tools: [TOOL_A] },
  { id: 'S4 no-tools(整个 tools 缺席)', callName: 'tool_a', withResult: true, tools: undefined },
];

const ADAPTERS = [
  {
    name: 'anthropicMessages (/v1/messages)',
    key: process.env.ANTHROPIC_API_KEY,
    baseUrl: process.env.ANTHROPIC_BASE_URL || 'https://api.anthropic.com',
    model: process.env.ANTHROPIC_MODEL || 'claude-haiku-4-5',
    fn: streamAnthropicMessages,
    extra: { max_tokens: 64 },
  },
  {
    name: 'openaiResponses (/v1/responses, BYOK)',
    key: process.env.OPENAI_API_KEY,
    baseUrl: process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1',
    model: process.env.OPENAI_RESPONSES_MODEL || 'gpt-5.6-sol',
    fn: streamOpenAiResponses,
    extra: { max_completion_tokens: 64 },
  },
  {
    name: `openaiCompat (/chat/completions @ ${process.env.COMPAT_BASE_URL || '未配置'})`,
    key: process.env.COMPAT_API_KEY,
    baseUrl: process.env.COMPAT_BASE_URL,
    model: process.env.COMPAT_MODEL,
    fn: streamOpenAiCompat,
    extra: { max_tokens: 64 },
  },
];

const rows = [];
for (const a of ADAPTERS) {
  if (!a.key || !a.baseUrl || !a.model) {
    for (const s of SCENARIOS) rows.push({ adapter: a.name, scenario: s.id, result: 'SKIP(缺 key/baseUrl/model)' });
    continue;
  }
  for (const s of SCENARIOS) {
    const payload = {
      model: a.model,
      messages: history(s),
      temperature: 0.2,
      stream: true,
      ...(s.tools ? { tools: s.tools, tool_choice: 'auto' } : {}),
      ...a.extra,
    };
    let result;
    try {
      const r = await a.fn({ apiKey: a.key, baseUrl: a.baseUrl, payload, signal: AbortSignal.timeout(60_000) });
      result = `OK 200 · content=${JSON.stringify(String(r?.content ?? '').slice(0, 40))}`;
    } catch (e) {
      const status = e?.status ?? '(no status)';
      result = `ERR ${status} · ${String(e?.message || e).replace(/\s+/g, ' ').slice(0, 220)}`;
    }
    rows.push({ adapter: a.name, scenario: s.id, result });
    console.log(`[${a.name}] ${s.id}\n    → ${result}\n`);
  }
}

console.log('\n===== 汇总 =====');
for (const r of rows) console.log(`| ${r.adapter} | ${r.scenario} | ${r.result} |`);
