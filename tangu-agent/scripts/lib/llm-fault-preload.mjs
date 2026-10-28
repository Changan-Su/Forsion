/**
 * live 台架的上游故障注入(10-28,借鉴 magpie 第三轮 15 / 19):以 `node --import` 载进台架起的引擎,包住 globalThis.fetch。
 * 只碰发往 …/responses 的请求(Codex / Responses 那条真路径),其余原样放行;产品代码里没有任何测试开关。
 *
 * 场景往 TANGU_LIVE_FAULT_FILE 写一条规则(JSON),本文件按规则把**某些**请求换成厂商原文的报错,其余照常打真上游:
 *   { mode: 'stream_overflow', match }   —— 第一次命中(body 含 match 且带 tools)记下它的体积;之后同样命中、体积不小于它 95% 的
 *        都回 200 + 流里 error / response.failed(context_length_exceeded)。等于一个真实窗口:压缩变小了才放行,原样重发照旧超长。
 *   { mode: 'invalid_encrypted_content', match } —— 第一次命中(body 含 match 且带回灌的加密推理)记下这批 encrypted_content,
 *        之后任何请求只要还带着其中一份就回 400 invalid_encrypted_content。等于换了账号:旧推理一律被拒,新产出的照常可用。
 * 每个 /responses 请求往 `<规则文件>.log` 记一行 { t, fired, bytes, encrypted, match },场景据此断言「拒了几次、重发长什么样」。
 * 报文取自 magpie 的厂商原文夹具(overflow_stream_test.go、foreign_seal_test.go,MIT)。
 */
import { appendFileSync, readFileSync } from 'node:fs';

const FILE = process.env.TANGU_LIVE_FAULT_FILE;
const realFetch = globalThis.fetch;
const OVERFLOW = { type: 'invalid_request_error', code: 'context_length_exceeded', message: 'Your input exceeds the context window of this model. Please adjust your input and try again.', param: 'input' };
const UNVERIFIABLE = { message: 'The encrypted content for item rs_ could not be verified. Reason: Encrypted content could not be decrypted or parsed.', type: 'invalid_request_error', param: null, code: 'invalid_encrypted_content' };
const state = { rule: '', limit: 0, foreign: new Set() };

const sse = (events) => new Response(events.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join(''), { status: 200, headers: { 'content-type': 'text/event-stream' } });

if (FILE) {
  globalThis.fetch = async (input, init) => {
    const url = typeof input === 'string' ? input : input?.url || String(input);
    if (!/\/responses$/.test(url)) return realFetch(input, init);
    const body = typeof init?.body === 'string' ? init.body : '';
    let rule = null;
    try { rule = JSON.parse(readFileSync(FILE, 'utf8')); } catch { /* 没有规则 = 不注入 */ }
    const key = rule ? JSON.stringify(rule) : '';
    if (key !== state.rule) Object.assign(state, { rule: key, limit: 0, foreign: new Set() }); // 换了规则从头记
    const blobs = [...body.matchAll(/"encrypted_content":"([^"]+)"/g)].map((m) => m[1]);
    const match = !!rule?.match && body.includes(rule.match);
    let fired = null;
    if (rule?.mode === 'stream_overflow' && match && body.includes('"tools":[')) {
      if (!state.limit) state.limit = body.length;
      if (body.length >= state.limit * 0.95) fired = 'stream_overflow';
    } else if (rule?.mode === 'invalid_encrypted_content') {
      if (!state.foreign.size && match && blobs.length) blobs.forEach((b) => state.foreign.add(b));
      if (blobs.some((b) => state.foreign.has(b))) fired = 'invalid_encrypted_content';
    }
    appendFileSync(`${FILE}.log`, `${JSON.stringify({ t: Date.now(), fired, bytes: body.length, encrypted: blobs.length, match })}\n`);
    if (fired === 'stream_overflow') {
      return sse([
        { type: 'response.created', sequence_number: 0, response: { id: 'resp_fault', object: 'response', status: 'in_progress', error: null } },
        { type: 'error', error: OVERFLOW, sequence_number: 1 },
        { type: 'response.failed', sequence_number: 2, response: { id: 'resp_fault', object: 'response', status: 'failed', error: { code: OVERFLOW.code, message: OVERFLOW.message } } },
      ]);
    }
    if (fired === 'invalid_encrypted_content') {
      return new Response(JSON.stringify({ error: UNVERIFIABLE }), { status: 400, headers: { 'content-type': 'application/json' } });
    }
    return realFetch(input, init);
  };
}
