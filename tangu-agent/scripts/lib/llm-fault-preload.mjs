/**
 * live 台架的上游故障注入(10-28,借鉴 magpie 第三轮 15 / 19):以 `node --import` 载进台架起的引擎,包住 globalThis.fetch。
 * 只碰发往 …/responses 的请求(Codex / Responses 那条真路径),其余原样放行;产品代码里没有任何测试开关。
 *
 * 场景往 TANGU_LIVE_FAULT_FILE 写一条规则(JSON),本文件按规则把**某些**请求换成厂商原文的报错,其余照常打真上游:
 *   { mode: 'stream_overflow', match }   —— 第一次命中(body 含 match 且带 tools)记下它的体积;之后同样命中、体积不小于它 95% 的
 *        都回 200 + 流里 error / response.failed(context_length_exceeded)。等于一个真实窗口:压缩变小了才放行,原样重发照旧超长。
 *   { mode: 'invalid_encrypted_content', match } —— 第一次命中(body 含 match 且带回灌的加密推理)记下这批 encrypted_content,
 *        之后任何请求只要还带着其中一份就回 400 invalid_encrypted_content。等于换了账号:旧推理一律被拒,新产出的照常可用。
 *   { mode: 'cut_after', match, chars }  —— 第一次命中(body 含 match)照常打真上游、原样转发它的流,正文(output_text.delta)累计到 chars 字后
 *        在流里补一条额度用完(insufficient_quota)+ response.failed 掐断。只掐这一次:之后的请求(含「继续生成」那一轮,历史里也有 match)全放行。
 *        等于「回答写到一半额度用完」(11-10 continuegen 场景)。
 * 每个 /responses 请求往 `<规则文件>.log` 记一行 { t, fired, bytes, encrypted, match },场景据此断言「拒了几次、重发长什么样」。
 * 报文取自 magpie 的厂商原文夹具(overflow_stream_test.go、foreign_seal_test.go,MIT)。
 */
import { appendFileSync, readFileSync } from 'node:fs';

const FILE = process.env.TANGU_LIVE_FAULT_FILE;
const realFetch = globalThis.fetch;
const OVERFLOW = { type: 'invalid_request_error', code: 'context_length_exceeded', message: 'Your input exceeds the context window of this model. Please adjust your input and try again.', param: 'input' };
const UNVERIFIABLE = { message: 'The encrypted content for item rs_ could not be verified. Reason: Encrypted content could not be decrypted or parsed.', type: 'invalid_request_error', param: null, code: 'invalid_encrypted_content' };
const QUOTA = { type: 'insufficient_quota', code: 'insufficient_quota', message: 'You exceeded your current quota, please check your plan and billing details.', param: null };
const state = { rule: '', limit: 0, foreign: new Set(), cut: false };

/** 原样转发真上游的 SSE,正文攒够 chars 字后在事件边界补额度报错并收尾(上游那条连接随之取消)。 */
function cutStream(res, chars) {
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  const enc = new TextEncoder();
  let buf = '';
  let seen = 0;
  const failed = [
    { type: 'error', error: QUOTA, sequence_number: 9000 },
    { type: 'response.failed', sequence_number: 9001, response: { id: 'resp_fault', object: 'response', status: 'failed', error: { code: QUOTA.code, message: QUOTA.message } } },
  ].map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join('');
  const body = new ReadableStream({
    async pull(ctrl) {
      // 一块上游数据可能凑不出一个完整事件:读到至少转出一个事件(或流结束)才返回,否则下游那次 read 永远等不到(Codex 评审)
      for (let sent = false; !sent;) {
        const { done, value } = await reader.read();
        if (done) { if (buf) ctrl.enqueue(enc.encode(buf)); ctrl.close(); return; }
        buf += dec.decode(value, { stream: true });
        let i;
        while ((i = buf.indexOf('\n\n')) >= 0) {
          const block = buf.slice(0, i + 2); buf = buf.slice(i + 2);
          ctrl.enqueue(enc.encode(block));
          sent = true;
          const data = block.split('\n').find((l) => l.startsWith('data:'));
          try { const e = JSON.parse(data.slice(5)); if (e.type === 'response.output_text.delta') seen += String(e.delta || '').length; } catch { /* 不是 JSON 的行原样过 */ }
          if (seen >= chars) { ctrl.enqueue(enc.encode(failed)); ctrl.close(); reader.cancel().catch(() => {}); return; }
        }
      }
    },
    cancel() { reader.cancel().catch(() => {}); },
  });
  return new Response(body, { status: res.status, headers: res.headers });
}

const sse = (events) => new Response(events.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join(''), { status: 200, headers: { 'content-type': 'text/event-stream' } });

if (FILE) {
  globalThis.fetch = async (input, init) => {
    const url = typeof input === 'string' ? input : input?.url || String(input);
    if (!/\/responses$/.test(url)) return realFetch(input, init);
    const body = typeof init?.body === 'string' ? init.body : '';
    let rule = null;
    try { rule = JSON.parse(readFileSync(FILE, 'utf8')); } catch { /* 没有规则 = 不注入 */ }
    const key = rule ? JSON.stringify(rule) : '';
    if (key !== state.rule) Object.assign(state, { rule: key, limit: 0, foreign: new Set(), cut: false }); // 换了规则从头记
    const blobs = [...body.matchAll(/"encrypted_content":"([^"]+)"/g)].map((m) => m[1]);
    const match = !!rule?.match && body.includes(rule.match);
    let fired = null;
    if (rule?.mode === 'stream_overflow' && match && body.includes('"tools":[')) {
      if (!state.limit) state.limit = body.length;
      if (body.length >= state.limit * 0.95) fired = 'stream_overflow';
    } else if (rule?.mode === 'cut_after' && match && !state.cut && body.includes('"tools":[')) { // 带工具头 = 主对话那发;标题 / 后台判官的请求也带 match,不许被它们抢走这一次
      state.cut = true;
      fired = 'cut_after';
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
    if (fired === 'cut_after') {
      const res = await realFetch(input, init);
      return res.ok && res.body ? cutStream(res, Number(rule.chars) || 200) : res;
    }
    if (fired === 'invalid_encrypted_content') {
      return new Response(JSON.stringify({ error: UNVERIFIABLE }), { status: 400, headers: { 'content-type': 'application/json' } });
    }
    return realFetch(input, init);
  };
}
